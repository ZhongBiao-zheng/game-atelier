"""canvas_* 工具：独立授权、typed change set、本机文件导入、生成按能力分级（ADR-0017 决定 4）。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from PIL import Image

from character_workflow.lib import canvas_agent_tools as tools, keys
from character_workflow.lib.canvas_agent_schema import (
    ApplyChangesInput, CanvasListProjectsInput, CanvasProjectInput, ImportMediaInput, RunInput,
)
from character_workflow.lib.canvas_projects import canvas_project_dir, create_canvas_project, read_canvas_document
from character_workflow.lib.private_json import read_private_json
from character_workflow.lib.workshop import WorkshopError
from viewer_server.server_app import build_app

from tests.local_client import LocalTestClient


@pytest.fixture
def canvas(isolated_data_root):
    project = create_canvas_project("画布回归")
    other = create_canvas_project("别人的画布")
    keys.write_keys_db(keys.KeysDB(keys=[keys.KeySpec(
        alias="fake", provider="openai", access_key="test-only-not-a-real-key",
        modalities=["image"], models=[
            keys.ModelSpec(id="gpt-image-1", name="Fake Image", modality="image", protocol="openai"),
        ], created_at="2026-09-03T00:00:00Z",
    )]))
    local = SimpleNamespace(kind="local", session_id="human", grant_id=None)
    agent = SimpleNamespace(kind="agent", session_id="agent", grant_id="grant-one",
                            project_ids=frozenset(), canvas_project_ids=frozenset([project.project_id]),
                            capabilities=frozenset(["canvas_read", "canvas_edit"]))
    return SimpleNamespace(project=project, other=other, local=local, agent=agent)


def test_list_and_read_are_scoped_to_granted_canvases(canvas):
    listed = tools.list_projects(canvas.agent, CanvasListProjectsInput())
    assert [row["project_id"] for row in listed["projects"]] == [canvas.project.project_id]
    assert len(tools.list_projects(canvas.local, CanvasListProjectsInput())["projects"]) == 2
    with pytest.raises(WorkshopError) as error:
        tools.get_document(canvas.agent, CanvasProjectInput(project_id=canvas.other.project_id))
    assert error.value.code == "TARGET_NOT_AUTHORIZED"
    with pytest.raises(WorkshopError):
        tools.get_document(canvas.agent, CanvasProjectInput(project_id="canvas-missing-000000"))


def test_change_set_edits_document_at_expected_revision(canvas):
    pid = canvas.project.project_id
    result = tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=0, changes=[
        {"op": "add_text", "node_id": "prompt-1", "title": "提示词", "text": "雨夜列车",
         "position": {"x": 0, "y": 0}},
        {"op": "add_surface", "node_id": "image-1", "kind": "image", "title": "结果", "position": {"x": 400, "y": 0}},
        {"op": "set_draft", "node_id": "image-1", "mode": "image", "prompt": "", "model": "gpt-image-1",
         "alias": "fake", "params": {"n": 2, "size": "1024x1024", "mask_image": "/etc/passwd"}},
        {"op": "connect", "source_node_id": "prompt-1", "target_node_id": "image-1"},
    ]))
    assert result["revision"] == 1 and result["node_ids"] == ["prompt-1", "image-1"]
    view = tools.get_document(canvas.agent, CanvasProjectInput(project_id=pid))
    prompt = next(node for node in view["nodes"] if node["id"] == "prompt-1")
    image = next(node for node in view["nodes"] if node["id"] == "image-1")
    assert prompt["text"] == "雨夜列车"
    assert image["type"] == "image" and image["version_id"] is None
    assert image["draft"]["prompt"] == "@[node:prompt-1]"  # connect 自动补上文本引用
    assert image["draft"]["params"] == {"n": 2, "size": "1024x1024"}  # 路径类字段被丢弃
    assert view["connections"][0]["source_node_id"] == "prompt-1"

    with pytest.raises(WorkshopError) as error:
        tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=0, changes=[
            {"op": "move", "node_id": "prompt-1", "position": {"x": 1, "y": 1}}]))
    assert error.value.code == "DOCUMENT_CONFLICT"

    result = tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=1, changes=[
        {"op": "set_text", "node_id": "prompt-1", "text": "黎明列车"},
        {"op": "remove_node", "node_id": "image-1"},
    ]))
    document = read_canvas_document(pid)
    assert result["revision"] == 2 and [node.id for node in document.nodes] == ["prompt-1"]
    assert document.connections == []
    assert document.content_versions[document.nodes[0].data.current_version_id].text == "黎明列车"


def test_import_media_copies_local_file_and_rejects_unknown_types(canvas, tmp_path, isolated_data_root):
    pid = canvas.project.project_id
    inbox = isolated_data_root / "inbox"
    inbox.mkdir()
    source = inbox / "ref.png"
    Image.new("RGB", (8, 6), "red").save(source)
    result = tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=0,
                                                              path=str(source), title="参考"))
    document = read_canvas_document(pid)
    # 版本与节点一次提交：revision 只 +1
    assert result["kind"] == "image" and document.revision == result["revision"] == 1
    version = document.content_versions[result["version_id"]]
    assert version.kind == "image" and version.origin.kind == "upload" and version.width == 8
    assert document.nodes[0].id == result["node_id"] and document.nodes[0].type == "image"
    preview = tools.read_media(canvas.agent, tools.CanvasReadMediaInput(project_id=pid, version_id=version.version_id))
    assert preview["preview"]["mime_type"] == "image/jpeg"

    (inbox / "notes.txt").write_text("x")
    with pytest.raises(WorkshopError) as error:
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=1,
                                                         path=str(inbox / "notes.txt")))
    assert error.value.code == "REFERENCE_NOT_ALLOWED"
    with pytest.raises(WorkshopError):
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=1, path="ref.png"))

    # 边界：家目录 / 工作区之外、别的画布目录、指向外面的符号链接，都不能导。
    outside = tmp_path / "outside.png"
    Image.new("RGB", (4, 4), "blue").save(outside)
    with pytest.raises(WorkshopError) as denied:
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=1, path=str(outside)))
    assert (denied.value.code, denied.value.status) == ("REFERENCE_NOT_ALLOWED", 403)
    link = inbox / "link.png"
    link.symlink_to(outside)
    with pytest.raises(WorkshopError) as via_link:
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=1, path=str(link)))
    assert via_link.value.code == "REFERENCE_NOT_ALLOWED"
    foreign = canvas_project_dir(canvas.other.project_id) / "media"
    foreign.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (4, 4), "green").save(foreign / "secret.png")
    with pytest.raises(WorkshopError) as other_canvas:
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=1,
                                                         path=str(foreign / "secret.png")))
    assert other_canvas.value.message == "不能读取其他画布的文件"
    # 冲突时不留孤儿版本
    before = len(read_canvas_document(pid).content_versions)
    with pytest.raises(WorkshopError) as conflict:
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=0, path=str(source)))
    assert conflict.value.code == "DOCUMENT_CONFLICT"
    assert len(read_canvas_document(pid).content_versions) == before


def test_run_requires_generate_capability_and_a_prepared_draft(canvas):
    pid = canvas.project.project_id
    tools.apply_changes(canvas.local, ApplyChangesInput(project_id=pid, expected_revision=0, changes=[
        {"op": "add_text", "node_id": "surface", "title": "图", "text": "", "position": {"x": 0, "y": 0}}]))
    with pytest.raises(WorkshopError) as error:
        tools.run(canvas.agent, RunInput(project_id=pid, surface_node_id="surface", expected_revision=1))
    assert error.value.code == "TARGET_NOT_AUTHORIZED"
    generator = SimpleNamespace(**{**vars(canvas.agent), "capabilities": frozenset(["canvas_read", "canvas_generate"])})
    with pytest.raises(WorkshopError) as error:
        tools.run(generator, RunInput(project_id=pid, surface_node_id="surface", expected_revision=1))
    assert error.value.code in {"INVALID_PARAMETERS", "INVALID_TARGET"}


def test_http_agent_session_reaches_canvas_tools_only_within_grant(canvas, tmp_path):
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))
    store = client.app.state.connection_store
    grant = store.create_grant(name="画布助手", project_ids=[], capabilities=["canvas_read", "canvas_edit"],
                               days=1, base_url="http://127.0.0.1", canvas_project_ids=[canvas.project.project_id])
    token = read_private_json(grant["credential_path"])["grant_token"]
    anonymous = LocalTestClient.__mro__[1](client.app, base_url="http://127.0.0.1")
    session = anonymous.post("/api/connection/agent-sessions", json={
        "grant_id": grant["grant_id"], "grant_token": token, "instance_id": store.instance_id})
    assert session.status_code == 200, session.text
    assert session.json()["canvas_project_ids"] == [canvas.project.project_id]
    headers = {"Authorization": f"Bearer {session.json()['session_token']}", "Content-Type": "application/json"}
    ok = anonymous.post("/api/canvas-agent/get-document", json={"project_id": canvas.project.project_id}, headers=headers)
    assert ok.status_code == 200 and ok.json()["revision"] == 0
    denied = anonymous.post("/api/canvas-agent/get-document", json={"project_id": canvas.other.project_id}, headers=headers)
    assert denied.status_code == 403 and denied.json()["error"]["code"] == "TARGET_NOT_AUTHORIZED"
    no_generate = anonymous.post("/api/canvas-agent/run", json={
        "project_id": canvas.project.project_id, "surface_node_id": "x", "expected_revision": 0}, headers=headers)
    assert no_generate.status_code == 403
    # 画布授权不继承工坊读取能力。
    workshop = anonymous.post("/api/workshop/list-projects", json={}, headers=headers)
    assert workshop.status_code == 403


def test_draft_mode_must_match_surface_type_and_mentions_follow_connections(canvas):
    pid = canvas.project.project_id
    with pytest.raises(WorkshopError) as error:
        tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=0, changes=[
            {"op": "add_text", "node_id": "note", "title": "文本", "text": "x", "position": {"x": 0, "y": 0}},
            {"op": "set_draft", "node_id": "note", "mode": "image", "prompt": "p", "model": "gpt-image-1", "alias": "fake"},
        ]))
    assert error.value.code == "INVALID_TARGET" and "add_surface" in error.value.message
    # 先连线再填配置，引用同样补齐；已有引用不重复。
    result = tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=0, changes=[
        {"op": "add_text", "node_id": "p1", "title": "提示词", "text": "雨夜", "position": {"x": 0, "y": 0}},
        {"op": "add_text", "node_id": "p2", "title": "补充", "text": "列车", "position": {"x": 0, "y": 200}},
        {"op": "add_surface", "node_id": "img", "kind": "image", "title": "图", "position": {"x": 400, "y": 0}},
        {"op": "connect", "source_node_id": "p1", "target_node_id": "img"},
        {"op": "connect", "source_node_id": "p2", "target_node_id": "img"},
        {"op": "set_draft", "node_id": "img", "mode": "image", "prompt": "@[node:p2] 蓝色调", "model": "gpt-image-1", "alias": "fake"},
    ]))
    view = tools.get_document(canvas.agent, CanvasProjectInput(project_id=pid))
    img = next(node for node in view["nodes"] if node["id"] == "img")
    assert img["draft"]["prompt"] == "@[node:p1] @[node:p2] 蓝色调"
    assert result["revision"] == 1
