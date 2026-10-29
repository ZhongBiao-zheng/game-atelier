"""canvas_* 工具：独立授权、typed change set、本机文件导入、生成按能力分级（ADR-0017 决定 4）。"""
from __future__ import annotations

from types import SimpleNamespace

from pathlib import Path

import pytest

from character_workflow.lib import data_root
from PIL import Image
from pydantic import ValidationError

from character_workflow.lib import canvas_agent_tools as tools, keys
from character_workflow.lib.canvas_agent_schema import (
    ApplyChangesInput, CanvasListProjectsInput, CanvasProjectInput, ImportMediaInput, RunInput,
)
from character_workflow.lib.canvas_projects import (
    canvas_project_dir, create_canvas_project, read_canvas_document, save_canvas_document,
)
from character_workflow.lib.schemas import CanvasMaterialConnection
from character_workflow.lib.private_json import read_private_json
from character_workflow.lib.canvas_tool_common import CanvasToolError
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
                            capabilities=frozenset(["canvas_read", "canvas_edit"]))
    return SimpleNamespace(project=project, other=other, local=local, agent=agent)


def test_agent_lists_and_reads_every_canvas(canvas):
    listed = tools.list_projects(canvas.agent, CanvasListProjectsInput())
    assert {row["project_id"] for row in listed["projects"]} == {
        canvas.project.project_id, canvas.other.project_id,
    }
    assert tools.get_document(canvas.agent, CanvasProjectInput(project_id=canvas.other.project_id))
    with pytest.raises(CanvasToolError):
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
    assert image["draft"]["prompt"] == ""  # 普通生成使用全部实线，不自动改提示词。
    assert image["draft"]["input_policy"] == "all_connected"
    assert image["draft"]["params"] == {"n": 2, "size": "1024x1024", "size_mode": "custom"}  # 路径类字段被丢弃
    assert view["connections"][0]["source_node_id"] == "prompt-1"

    with pytest.raises(CanvasToolError) as error:
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


def test_agent_reads_material_edges_but_reference_updates_only_consider_inputs(canvas):
    pid = canvas.project.project_id
    tools.apply_changes(canvas.agent, ApplyChangesInput(
        project_id=pid, expected_revision=0, changes=[
            {"op": "add_surface", "node_id": node_id, "kind": "image", "title": node_id,
             "position": {"x": index * 400, "y": 0}}
            for index, node_id in enumerate(["source", "target"])
        ] + [
            {"op": "set_draft", "node_id": "target", "mode": "image",
             "prompt": "参考 @[node:source]", "model": "gpt-image-1", "alias": "fake"},
            {"op": "connect", "source_node_id": "source", "target_node_id": "target"},
        ],
    ))
    document = read_canvas_document(pid)
    material = CanvasMaterialConnection(
        id="material-edge", role="material", source_node_id="source", target_node_id="target",
    )
    document = save_canvas_document(pid, document.model_copy(update={
        "connections": [*document.connections, material],
    }), document.revision)
    view = tools.get_document(canvas.agent, CanvasProjectInput(project_id=pid))
    assert [edge["role"] for edge in view["connections"]] == ["input", "material"]
    tools.apply_changes(canvas.agent, ApplyChangesInput(
        project_id=pid, expected_revision=document.revision, changes=[
            {"op": "disconnect", "connection_id": document.connections[0].id},
        ],
    ))
    disconnected = read_canvas_document(pid)
    assert disconnected.connections == [material]
    assert disconnected.nodes[1].data.generation_draft.prompt == "参考 "
    tools.apply_changes(canvas.agent, ApplyChangesInput(
        project_id=pid, expected_revision=disconnected.revision, changes=[
            {"op": "remove_node", "node_id": "source"},
        ],
    ))
    removed = read_canvas_document(pid)
    assert removed.connections == []
    assert removed.nodes[0].data.generation_draft == disconnected.nodes[1].data.generation_draft


def test_import_media_copies_local_file_and_rejects_unknown_types(canvas, tmp_path, isolated_data_root, monkeypatch):
    # Windows 的 tmp_path 本身在家目录下（AppData\Local\Temp），把「家」钉到 tmp 里的一个子目录，边界断言才成立。
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
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
    with pytest.raises(CanvasToolError) as error:
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=1,
                                                         path=str(inbox / "notes.txt")))
    assert error.value.code == "REFERENCE_NOT_ALLOWED"
    with pytest.raises(CanvasToolError):
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=1, path="ref.png"))

    # 边界：家目录 / 工作区之外、别的画布目录、指向外面的符号链接，都不能导。
    outside = tmp_path / "outside.png"
    Image.new("RGB", (4, 4), "blue").save(outside)
    with pytest.raises(CanvasToolError) as denied:
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=1, path=str(outside)))
    assert (denied.value.code, denied.value.status) == ("REFERENCE_NOT_ALLOWED", 403)
    link = inbox / "link.png"
    link.symlink_to(outside)
    with pytest.raises(CanvasToolError) as via_link:
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=1, path=str(link)))
    assert via_link.value.code == "REFERENCE_NOT_ALLOWED"
    foreign = canvas_project_dir(canvas.other.project_id) / "media"
    foreign.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (4, 4), "green").save(foreign / "secret.png")
    with pytest.raises(CanvasToolError) as other_canvas:
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=1,
                                                         path=str(foreign / "secret.png")))
    assert other_canvas.value.message == "不能读取其他画布的文件"
    # 冲突时不留孤儿版本
    before = len(read_canvas_document(pid).content_versions)
    with pytest.raises(CanvasToolError) as conflict:
        tools.import_media(canvas.agent, ImportMediaInput(project_id=pid, expected_revision=0, path=str(source)))
    assert conflict.value.code == "DOCUMENT_CONFLICT"
    assert len(read_canvas_document(pid).content_versions) == before


def test_run_requires_generate_capability_and_a_prepared_draft(canvas):
    pid = canvas.project.project_id
    tools.apply_changes(canvas.local, ApplyChangesInput(project_id=pid, expected_revision=0, changes=[
        {"op": "add_text", "node_id": "surface", "title": "图", "text": "", "position": {"x": 0, "y": 0}}]))
    with pytest.raises(CanvasToolError) as error:
        tools.run(canvas.agent, RunInput(project_id=pid, surface_node_id="surface", expected_revision=1))
    assert error.value.code == "TARGET_NOT_AUTHORIZED"
    generator = SimpleNamespace(**{**vars(canvas.agent), "capabilities": frozenset(["canvas_read", "canvas_generate"])})
    with pytest.raises(CanvasToolError) as error:
        tools.run(generator, RunInput(project_id=pid, surface_node_id="surface", expected_revision=1))
    assert error.value.code in {"INVALID_PARAMETERS", "INVALID_TARGET"}


def test_http_agent_session_reaches_every_canvas(canvas, tmp_path):
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=tmp_path / "dist"))
    store = client.app.state.connection_store
    store.enable_agent("http://127.0.0.1")
    credential = read_private_json(data_root.agent_credential_file())
    anonymous = LocalTestClient.__mro__[1](client.app, base_url="http://127.0.0.1")
    session = anonymous.post("/api/connection/agent-sessions", json={
        "grant_id": credential["grant_id"], "grant_token": credential["grant_token"],
        "instance_id": store.instance_id})
    assert session.status_code == 200, session.text
    headers = {"Authorization": f"Bearer {session.json()['session_token']}", "Content-Type": "application/json"}
    for project_id in (canvas.project.project_id, canvas.other.project_id):
        ok = anonymous.post("/api/canvas-agent/get-document", json={"project_id": project_id}, headers=headers)
        assert ok.status_code == 200 and ok.json()["revision"] == 0
    assert anonymous.post("/api/workshop/list-projects", json={}, headers=headers).status_code == 403


def test_draft_mode_must_match_surface_type_and_mentions_follow_connections(canvas):
    pid = canvas.project.project_id
    with pytest.raises(CanvasToolError) as error:
        tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=0, changes=[
            {"op": "add_text", "node_id": "note", "title": "文本", "text": "x", "position": {"x": 0, "y": 0}},
            {"op": "set_draft", "node_id": "note", "mode": "image", "prompt": "p", "model": "gpt-image-1", "alias": "fake"},
        ]))
    assert error.value.code == "INVALID_TARGET" and "add_surface" in error.value.message
    # @ 仅引用已有输入，不暗中筛选或重排实线。
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
    assert img["draft"]["prompt"] == "@[node:p2] 蓝色调"
    assert img["draft"]["input_policy"] == "all_connected"
    assert [edge["source_node_id"] for edge in view["connections"]] == ["p1", "p2"]
    assert result["revision"] == 1


def test_draft_rejects_hidden_mentions_only_policy():
    with pytest.raises(ValidationError):
        ApplyChangesInput(project_id="canvas-test", expected_revision=0, changes=[{
            "op": "set_draft", "node_id": "img", "mode": "image", "prompt": "p",
            "model": "gpt-image-1", "input_policy": "mentions_only",
        }])


@pytest.mark.parametrize("mode, frame_mode, expected", [
    ("image", None, ""), ("text", None, ""), ("video", "firstlast", ""),
    ("video", "auto", "@[node:p1] @[node:p2]"),
])
def test_only_auto_video_adds_text_mentions_in_connection_order(canvas, mode, frame_mode, expected):
    pid = canvas.project.project_id
    surface = {"op": "add_surface", "node_id": "surface", "kind": mode, "title": "结果",
               "position": {"x": 400, "y": 0}}
    if mode == "text":
        surface = {**surface, "op": "add_text", "text": ""}
        del surface["kind"]
    tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=0, changes=[
        {"op": "add_text", "node_id": "p1", "title": "甲", "text": "A", "position": {"x": 0, "y": 0}},
        {"op": "add_text", "node_id": "p2", "title": "乙", "text": "B", "position": {"x": 0, "y": 200}},
        surface,
        {"op": "connect", "source_node_id": "p1", "target_node_id": "surface"},
        {"op": "connect", "source_node_id": "p2", "target_node_id": "surface"},
        {"op": "set_draft", "node_id": "surface", "mode": mode, "prompt": "", "model": "test-model",
         "params": {"frame_mode": frame_mode} if frame_mode else {}},
    ]))
    document = read_canvas_document(pid)
    assert document.nodes[-1].data.generation_draft.prompt == expected
    assert [edge.source_node_id for edge in document.connections] == ["p1", "p2"]


@pytest.mark.parametrize("remove_op", ["disconnect", "remove_node"])
def test_removing_source_cleans_mentions_and_keeps_remaining_input_and_history(canvas, remove_op):
    pid = canvas.project.project_id
    tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=0, changes=[
        {"op": "add_text", "node_id": "p1", "title": "甲", "text": "A", "position": {"x": 0, "y": 0}},
        {"op": "add_text", "node_id": "p2", "title": "乙", "text": "B", "position": {"x": 0, "y": 200}},
        {"op": "add_surface", "node_id": "surface", "kind": "image", "title": "结果", "position": {"x": 400, "y": 0}},
        {"op": "connect", "source_node_id": "p1", "target_node_id": "surface"},
        {"op": "connect", "source_node_id": "p2", "target_node_id": "surface"},
        {"op": "set_draft", "node_id": "surface", "mode": "image", "prompt": "@[node:p1] @[node:p2] @[node:p1]",
         "model": "test-model"},
    ]))
    before = read_canvas_document(pid)
    change = ({"op": "disconnect", "connection_id": before.connections[0].id}
              if remove_op == "disconnect" else {"op": "remove_node", "node_id": "p1"})
    tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=1, changes=[change]))
    after = read_canvas_document(pid)
    assert after.nodes[-1].data.generation_draft.prompt == " @[node:p2] "
    assert [edge.source_node_id for edge in after.connections] == ["p2"]
    assert after.content_versions == before.content_versions
    tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=2, changes=[
        {"op": "disconnect", "connection_id": after.connections[0].id},
    ]))
    assert read_canvas_document(pid).nodes[-1].data.generation_draft.prompt == ""


def test_disconnect_reconnect_same_transaction_keeps_reference(canvas):
    pid = canvas.project.project_id
    tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=0, changes=[
        {"op": "add_text", "node_id": "p1", "title": "甲", "text": "A", "position": {"x": 0, "y": 0}},
        {"op": "add_surface", "node_id": "surface", "kind": "image", "title": "结果", "position": {"x": 400, "y": 0}},
        {"op": "connect", "source_node_id": "p1", "target_node_id": "surface"},
        {"op": "set_draft", "node_id": "surface", "mode": "image", "prompt": "@[node:p1] 保留",
         "model": "test-model"},
    ]))
    before = read_canvas_document(pid)
    tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=1, changes=[
        {"op": "disconnect", "connection_id": before.connections[0].id},
        {"op": "connect", "source_node_id": "p1", "target_node_id": "surface"},
    ]))
    assert read_canvas_document(pid).nodes[-1].data.generation_draft.prompt == "@[node:p1] 保留"


# ── 团队库：Agent 只看本画布挂载的库，放上画布即采用（ADR-0031）────────────────────

_TEAM_ID = "ta_01ARZ3NDEKTSV4RRFFQ69G5FAV"


def _png(path: Path, color=(200, 60, 60)) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (8, 8), color).save(path, format="PNG")
    return path.read_bytes()


@pytest.fixture
def team(canvas, tmp_path):
    import hashlib
    import json

    from character_workflow.lib.team_library import mount_library
    from tests.team_library_helpers import scan_and_cache

    folder = tmp_path / "team"
    asset_dir = folder / "shared" / "老王" / _TEAM_ID
    body = _png(asset_dir / "hero.png")
    (asset_dir / "asset.json").write_text(json.dumps({
        "asset_id": _TEAM_ID, "kind": "media", "title": "主角立绘", "tags": ["定稿"], "category": "角色",
        "author": {"display_name": "老王"}, "shared_at": "2026-10-01T00:00:00Z",
        "updated_at": "2026-10-01T00:00:00Z",
        "media": {"filename": "hero.png", "mime_type": "image/png", "bytes": len(body),
                  "sha256": hashlib.sha256(body).hexdigest()},
    }, ensure_ascii=False), "utf-8")
    _png(folder / "按钮" / "ok.png", (60, 200, 60))
    mount = mount_library(project_id=canvas.project.project_id, path=str(folder), name="美术共享盘",
                          created_by="老王")
    scan_and_cache(mount)
    return SimpleNamespace(mount=mount, ref=f"team:{mount.library_id}/{_TEAM_ID}")


def test_search_team_sees_only_libraries_mounted_on_this_canvas(canvas, team):
    from character_workflow.lib.canvas_agent_library import search_team

    pid = canvas.project.project_id
    heroes = search_team(pid, None, "角色", 12)
    assert [row["asset_id"] for row in heroes["assets"]] == [team.ref]
    assert {key: heroes["assets"][0][key] for key in ("title", "category", "library")} == {
        "title": "主角立绘", "category": "角色", "library": "美术共享盘"}
    assert heroes["attach_images"] == [team.ref]
    # 原始文件没有类别：按所在目录名命中。
    buttons = search_team(pid, None, "按钮", 12)
    assert [row["title"] for row in buttons["assets"]] == ["ok.png"]
    assert search_team(canvas.other.project_id, None, None, 12)["assets"] == []


def test_add_asset_node_with_team_ref_adopts_with_category(canvas, team):
    from character_workflow.lib.creation_assets import list_creation_assets

    pid = canvas.project.project_id
    result = tools.apply_changes(canvas.agent, ApplyChangesInput(project_id=pid, expected_revision=0, changes=[
        {"op": "add_asset_node", "asset_id": team.ref, "node_id": "ref-1"},
    ]))
    adopted_id = result["team_assets"][team.ref]
    [asset] = list_creation_assets().assets
    assert asset.asset_id == adopted_id and asset.category == "角色" and pid in asset.project_ids
    assert asset.adopted_from.asset_id == _TEAM_ID
    assert result["asset_nodes"] == {adopted_id: "ref-1"}
    assert any(node.id == "ref-1" for node in read_canvas_document(pid).nodes)

    with pytest.raises(ValueError, match="不在本画布挂载的团队库里"):
        tools.apply_changes(canvas.agent, ApplyChangesInput(
            project_id=canvas.other.project_id, expected_revision=0,
            changes=[{"op": "add_asset_node", "asset_id": team.ref, "node_id": "ref-1"}]))


def test_team_specs_roundtrip_and_agent_gets_project_first(canvas, team):
    from character_workflow.lib import canvas_specs
    from character_workflow.lib.team_library_specs import (
        PRIORITY_NOTE, agent_category_spec, agent_instructions, read_team_specs, write_team_spec,
    )

    pid = canvas.project.project_id
    write_team_spec(team.mount, "全队统一描边 2px")
    write_team_spec(team.mount, "角色三视图要有正侧背", "角色")
    specs_dir = Path(team.mount.mount_path) / "specs"
    assert (specs_dir / "team.md").read_text("utf-8") == "全队统一描边 2px"
    filename = __import__("json").loads((specs_dir / "index.json").read_text("utf-8"))["categories"]["角色"]
    assert filename.endswith(".md") and filename != "team.md"
    assert read_team_specs(team.mount) == {"team": "全队统一描边 2px",
                                           "categories": {"角色": "角色三视图要有正侧背"}}

    canvas_specs.write_spec(pid, "本项目描边 3px")
    canvas_specs.write_spec(pid, "主角只穿红色", "角色")
    prompt = agent_instructions(pid)
    assert prompt.index("本项目描边 3px") < prompt.index("全队统一描边 2px") and PRIORITY_NOTE in prompt
    spec = agent_category_spec(pid, "角色")
    assert spec.index("主角只穿红色") < spec.index("角色三视图要有正侧背") and "美术共享盘" in spec
    # 没挂这个库的画布读不到团队规范。
    assert "全队统一描边" not in agent_instructions(canvas.other.project_id)


def test_team_spec_index_tolerates_bad_rows_and_rejects_symlinked_specs(canvas, team, tmp_path):
    from character_workflow.lib.team_library_specs import read_team_specs, write_team_spec

    specs_dir = Path(team.mount.mount_path) / "specs"
    specs_dir.mkdir()
    (specs_dir / "index.json").write_text(
        '{"categories": {"按钮": "anniu.md", "坏的": "../x.md", "重复": "anniu.md"}}', "utf-8")
    (specs_dir / "anniu.md").write_text("按钮圆角 8", "utf-8")
    assert read_team_specs(team.mount)["categories"] == {"按钮": "按钮圆角 8"}

    specs_dir.rename(tmp_path / "elsewhere")
    specs_dir.symlink_to(tmp_path / "elsewhere", target_is_directory=True)
    with pytest.raises(ValueError, match="团队规范路径不可用"):
        write_team_spec(team.mount, "x")
