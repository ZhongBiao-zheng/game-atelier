"""真实项目文件上的节点级合并、权限、幂等与撤回。"""
from concurrent.futures import ThreadPoolExecutor

import pytest

from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, save_canvas_document,
)
from character_workflow.lib.collab_ops import CollabOpError, apply_op


def submit(project_id, kind, op_id, base_revision, *, actor="a", **fields):
    return apply_op(
        project_id, {"kind": kind, "base_revision": base_revision, "op_id": op_id, **fields},
        client_id=actor, actor_name="同名", authorize=lambda: None,
    )


def node(node_id):
    return {
        "id": node_id, "type": "image", "title": node_id, "created_by_client": "forged",
        "position": {"x": 0, "y": 0}, "data": {},
    }


def test_overlapping_edits_conflict_and_protect_undo():
    project_id = create_canvas_project("冲突").project_id
    added = submit(project_id, "node_add", "add", 0, node=node("n"), client_id="forged")
    assert added.touched_node_ids == {"n"}
    current = read_canvas_document(project_id)
    assert current.nodes[0].created_by_client == "a" and current.nodes[0].created_by == "同名"
    assert submit(project_id, "node_add", "add", 0, node=node("n")).duplicate
    submit(project_id, "node_update", "title1", 1, node_id="n", patch={"title": "甲"})
    changed = submit(project_id, "node_update", "title2", 1, actor="b", node_id="n", patch={"title": "乙"})
    assert changed.revision == 3 and changed.conflict_clients == {"a"}
    with pytest.raises(CollabOpError, match="他人修改"):
        submit(project_id, "node_update", "undo-1", 3, node_id="n", patch={"title": "n"}, undo_of="title1")
    with pytest.raises(CollabOpError, match="仅房主"):
        submit(project_id, "node_delete", "delete", 3, actor="b", node_ids=["n"])
    assert read_canvas_document(project_id).nodes[0].title == "乙"


def test_parallel_independent_moves_merge_and_undo():
    pid = create_canvas_project("并行").project_id
    submit(pid, "node_add", "add1", 0, node=node("n1"))
    submit(pid, "node_add", "add2", 1, actor="b", node=node("n2"))
    with ThreadPoolExecutor(2) as pool:
        futures = [pool.submit(submit, pid, "node_move_batch", f"move{i}", 2, actor=actor,
                               positions={f"n{i}": {"x": i, "y": i}}) for i, actor in [(1, "a"), (2, "b")]]
    applied = [f.result() for f in futures]
    assert {row.revision for row in applied} == {3, 4}
    assert all(not row.conflict_clients for row in applied)
    assert [n.position.x for n in read_canvas_document(pid).nodes] == [1, 2]
    submit(pid, "node_move_batch", "undo", 4, positions={"n1": {"x": 0, "y": 0}}, undo_of="move1")
    assert [n.position.x for n in read_canvas_document(pid).nodes] == [0, 2]


def test_local_host_edit_and_permission_change_during_operation():
    pid = create_canvas_project("房主").project_id
    submit(pid, "node_add", "add", 0, node=node("n"))
    local = read_canvas_document(pid)
    local.nodes[0].title = "房主已改"
    save_canvas_document(pid, local, local.revision)
    with pytest.raises(CollabOpError, match="他人修改"):
        submit(pid, "node_delete", "undo-1", 2, node_ids=["n"], undo_of="add")
    calls = []

    def authorize():
        calls.append(True)
        if len(calls) == 2:
            raise CollabOpError(403, "画布仅可查看")

    with pytest.raises(CollabOpError, match="仅可查看"):
        apply_op(pid, {"kind": "node_delete", "op_id": "delete", "base_revision": 2, "node_ids": ["n"]},
                 client_id="a", actor_name="同名", authorize=authorize)
    assert read_canvas_document(pid).revision == 2
    row = submit(pid, "node_update", "title", 1, node_id="n", patch={"title": "同节点"})
    assert row.conflict_clients == {"host"}


def test_text_version_and_restricted_fields():
    pid = create_canvas_project("文本").project_id
    body = {"node": {**node("t"), "type": "text", "data": {"current_version_id": "v1"}},
            "text_versions": [{"kind": "text", "text": "文字", "version_id": "v1", "created_at": "",
                               "origin": {"kind": "user_edit"}, "sha256": "0" * 64}]}
    submit(pid, "node_add", "add", 0, **body)
    assert read_canvas_document(pid).content_versions["v1"].sha256 != "0" * 64
    with pytest.raises(CollabOpError):
        submit(pid, "node_update", "forge", 1, node_id="t", patch={"created_by": "伪造"})
    with pytest.raises(CollabOpError):
        submit(pid, "node_update", "forge-run", 1, node_id="t", patch={"data": {"active_run_id": "bad"}})
    assert read_canvas_document(pid).revision == 1


def test_restore_deleted_selection_with_edges_and_author_then_redo():
    pid = create_canvas_project("复原").project_id
    submit(pid, "node_add", "add1", 0, node=node("one"))
    submit(pid, "node_add", "add2", 1, node=node("two"))
    submit(pid, "connection_add", "edge", 2, connection={
        "id": "edge", "role": "input", "source_node_id": "one", "target_node_id": "two",
    })
    submit(pid, "node_delete", "delete", 3, node_ids=["one", "two"])
    submit(pid, "restore", "undo", 4, undo_of="delete")
    saved = read_canvas_document(pid)
    assert {row.id: row.created_by_client for row in saved.nodes} == {"one": "a", "two": "a"}
    assert len(saved.connections) == 1 and saved.connections[0].id == "edge"
    submit(pid, "restore", "redo", 5, undo_of="undo")
    assert not read_canvas_document(pid).nodes


def test_upload_undo_preserves_immutable_bytes_and_recreates_author_on_redo():
    from character_workflow.lib.canvas_library import _content_node
    from character_workflow.lib.canvas_projects import (
        canvas_project_lock_path, resolve_canvas_media, save_canvas_upload,
    )
    from character_workflow.lib.collab_ops import record_committed_change
    from character_workflow.lib.file_lock import file_lock
    from character_workflow.lib.schemas import CanvasPoint
    from tests.test_canvas_paste_routes import _png

    pid = create_canvas_project("上传").project_id
    before = read_canvas_document(pid)
    def upload_node(version):
        row = _content_node(version.version_id, "上传", CanvasPoint(x=0, y=0), "image")
        return row.model_copy(update={"created_by_client": "a", "created_by": "同名"})
    version, after, _ = save_canvas_upload(pid, "a.png", ".png", _png(), "image", 0, node_factory=upload_node)
    with file_lock(canvas_project_lock_path(pid)):
        result = record_committed_change(pid, before, after, op_id="upload", client_id="a")
    assert result.touched_node_ids == {after.nodes[0].id}
    submit(pid, "restore", "undo-upload", 1, undo_of="upload")
    assert not read_canvas_document(pid).nodes and resolve_canvas_media(pid, version.version_id)[0].is_file()
    submit(pid, "restore", "redo-upload", 2, undo_of="undo-upload")
    assert read_canvas_document(pid).nodes[0].created_by_client == "a"
