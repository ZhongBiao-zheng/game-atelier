"""分镜插件（宿主插件，ADR-0038 / ADR-0039）：插件节点外壳里的镜头载荷、Agent 摘要、宿主白名单。"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from character_workflow.lib import canvas_agent_tools as tools
from character_workflow.lib import plugin_registry, plugin_server
from character_workflow.lib.canvas_agent_schema import CanvasProjectInput
from character_workflow.lib.canvas_projects import (
    create_canvas_project, list_canvas_projects, read_canvas_document, save_canvas_document,
)
from character_workflow.lib.schemas import CanvasDocument
from tests.plugin_fixtures import use_plugins_root, write_plugin

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "plugins" / "storyboard"
FIXTURE = json.loads((PLUGIN_DIR / "tests" / "payload_cases.json").read_text(encoding="utf-8"))
LOCAL = SimpleNamespace(kind="local", session_id="human", grant_id=None)


def load_server_package():
    """不经注册表直接加载插件的服务端包，给纯函数测试用（不启用插件、不碰数据目录）。"""
    name = "storyboard_plugin_under_test"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            name, PLUGIN_DIR / "server" / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR / "server")])
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


_SB = load_server_package().storyboard
MAX_ENTITIES, MAX_SCRIPT_NODES = _SB.MAX_ENTITIES, _SB.MAX_SCRIPT_NODES
MAX_SHOT_ENTITIES, MAX_SHOTS = _SB.MAX_SHOT_ENTITIES, _SB.MAX_SHOTS
STORYBOARD_NODE_TYPE, STORYBOARD_PLUGIN_ID = _SB.STORYBOARD_NODE_TYPE, _SB.STORYBOARD_PLUGIN_ID
agent_view, is_storyboard_node, normalize_payload = _SB.agent_view, _SB.is_storyboard_node, _SB.normalize_payload


@pytest.fixture
def enabled():
    plugin_registry.set_enabled(STORYBOARD_PLUGIN_ID, True)
    yield
    plugin_server.unload(STORYBOARD_PLUGIN_ID)


def expand(value):
    """夹具里的 {"repeat": 文本, "count": n} 展开成重复 n 次的字符串。"""
    if isinstance(value, dict):
        if set(value) == {"repeat", "count"}:
            return value["repeat"] * value["count"]
        return {key: expand(item) for key, item in value.items()}
    if isinstance(value, list):
        return [expand(item) for item in value]
    return value


def storyboard_node(payload, node_id: str = "storyboard-1") -> dict:
    return {
        "id": node_id, "title": "分镜", "type": "plugin", "position": {"x": 400, "y": 0}, "z_index": 0,
        "size": {"width": 420, "height": 480},
        "data": {"plugin_id": STORYBOARD_PLUGIN_ID, "node_type": STORYBOARD_NODE_TYPE, "plugin_version": "1",
                 "data_schema_version": 1, "payload": payload, "generation_draft": None},
    }


def media_node(node_id: str, kind: str) -> dict:
    return {"id": node_id, "title": node_id, "type": kind, "position": {"x": 0, "y": 0}, "z_index": 0,
            "data": {"current_version_id": None, "generation_draft": None, "active_run_id": None}}


def saved(payload, *extra_nodes) -> CanvasDocument:
    project = create_canvas_project("分镜")
    current = read_canvas_document(project.project_id)
    document = CanvasDocument.model_validate({
        **current.model_dump(mode="json"), "nodes": [storyboard_node(payload), *extra_nodes]})
    return save_canvas_document(project.project_id, document, expected_revision=current.revision)


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["name"])
def test_payload_is_read_leniently(case):
    assert normalize_payload(expand(case["input"])) == expand(case["expected"])


def test_normalized_payload_is_stable():
    for case in FIXTURE["cases"]:
        once = normalize_payload(expand(case["input"]))
        assert normalize_payload(once) == once


def test_counts_are_capped():
    limits = FIXTURE["limits"]
    assert limits == {"shots": MAX_SHOTS, "entities": MAX_ENTITIES,
                      "shot_entities": MAX_SHOT_ENTITIES, "script_nodes": MAX_SCRIPT_NODES}
    entities = [{"id": f"e{index}"} for index in range(MAX_ENTITIES + 5)]
    payload = normalize_payload({
        "entities": entities,
        "shots": [{"id": f"s{index}", "entity_ids": [item["id"] for item in entities]}
                  for index in range(MAX_SHOTS + 5)],
        "script_node_ids": [f"text-{index}" for index in range(MAX_SCRIPT_NODES + 5)],
    })
    assert len(payload["entities"]) == MAX_ENTITIES
    assert len(payload["shots"]) == MAX_SHOTS
    assert len(payload["shots"][0]["entity_ids"]) == MAX_SHOT_ENTITIES
    assert len(payload["script_node_ids"]) == MAX_SCRIPT_NODES


def test_document_shape_is_readable_by_released_versions():
    """只用 v5.137.0 已有的节点类型与字段：旧版本读得出，项目不会从列表里消失。"""
    node = storyboard_node({"shots": [{"id": "s1"}]})
    assert node["type"] == "plugin"
    assert set(node["data"]) == {
        "plugin_id", "node_type", "plugin_version", "data_schema_version", "payload", "generation_draft"}
    document = saved(node["data"]["payload"])
    assert not document.connections
    assert is_storyboard_node(document.nodes[0])
    assert [project.project_id for project in list_canvas_projects()] == [document.project_id]


def test_host_runtime_comes_from_the_host_allowlist_not_the_manifest(tmp_path, monkeypatch):
    """清单自报 runtime: host 不算数：白名单外的包声明 host 拒绝加载；白名单里的 id 不声明 host 也拒绝。"""
    use_plugins_root(monkeypatch, tmp_path / "plugins")
    host_shape = {"ui": None, "capabilities": [], "runtime": "host"}
    write_plugin(tmp_path / "plugins", "intruder", files={}, **host_shape)
    write_plugin(tmp_path / "plugins", STORYBOARD_PLUGIN_ID, files={"ui/index.html": b"<!doctype html>"})
    write_plugin(tmp_path / "plugins", "demo")
    records = {record.plugin_id: record for record in plugin_registry.scan()}
    assert records["intruder"].availability == "invalid"
    assert records[STORYBOARD_PLUGIN_ID].availability == "invalid"
    assert records["demo"].availability == "ok" and not plugin_registry.is_host(records["demo"])
    with pytest.raises(plugin_registry.PluginError):
        plugin_registry.set_enabled("intruder", True)


def test_real_storyboard_package_is_a_host_plugin():
    record = plugin_registry.find(STORYBOARD_PLUGIN_ID)
    assert record is not None and record.availability == "ok" and plugin_registry.is_host(record)
    assert record.lock.ui is None and record.lock.capabilities == []


def test_sandbox_plugin_cannot_use_the_host_entry(tmp_path, monkeypatch):
    use_plugins_root(monkeypatch, tmp_path / "plugins")
    write_plugin(tmp_path / "plugins", "demo", server_source="def register(api):\n    pass\n",
                 contributes={"server": {"module": "server", "routes": [
                     {"method": "POST", "path": "/echo", "access": "read"}]}})
    plugin_registry.set_enabled("demo", True)
    project = create_canvas_project("入口")
    with pytest.raises(plugin_registry.PluginError) as error:
        plugin_server.call("demo", "POST", "/echo", project_id=project.project_id, origin="host")
    assert error.value.code == "CAPABILITY_DENIED"


def test_bindings_resolve_only_inside_the_current_document():
    payload = {
        "entities": [{"id": "e1", "name": "阿青", "reference_node_id": "video-1"},
                     {"id": "e2", "name": "茶馆", "reference_node_id": "image-1"}],
        "shots": [
            {"id": "s1", "image_node_id": "image-1", "video_node_id": "video-1", "entity_ids": ["e2"]},
            {"id": "s2", "image_node_id": "video-1", "video_node_id": "image-1"},
            {"id": "s3", "image_node_id": "gone", "video_node_id": "storyboard-1"},
        ],
    }
    document = saved(payload, media_node("image-1", "image"), media_node("video-1", "video"))
    view = agent_view(document, document.nodes[0])["storyboard"]
    assert [entity["reference_node_id"] for entity in view["entities"]] == [None, "image-1"]
    assert [(shot["image_node_id"], shot["video_node_id"]) for shot in view["shots"]] == [
        ("image-1", "video-1"), (None, None), (None, None)]
    assert view["shots"][0]["entities"] == ["茶馆"]


def test_agent_reads_shot_summary(enabled):
    document = saved({
        "ratio": "9:16",
        "shots": [{"id": "s1", "shot_size": "中景", "duration_s": 4, "visual": "画" * 500},
                  {"id": "s2", "duration_s": 6}],
    })
    view = tools.get_document(LOCAL, CanvasProjectInput(project_id=document.project_id))
    row = view["nodes"][0]
    assert row["type"] == "plugin"
    assert row["storyboard"]["ratio"] == "9:16"
    assert row["storyboard"]["total_duration_s"] == 10
    assert [shot["index"] for shot in row["storyboard"]["shots"]] == [1, 2]
    assert len(row["storyboard"]["shots"][0]["visual"]) == 300


def test_agent_summary_needs_the_plugin_enabled():
    document = saved({"shots": [{"id": "s1"}]})
    module = plugin_server._module_name(STORYBOARD_PLUGIN_ID)
    view = tools.get_document(LOCAL, CanvasProjectInput(project_id=document.project_id))
    assert "storyboard" not in view["nodes"][0]
    assert module not in sys.modules, "插件关闭时 get_canvas 不加载插件代码"


def test_other_plugin_nodes_have_no_storyboard_view(enabled):
    node = storyboard_node({})
    node["data"]["plugin_id"] = "demo"
    project = create_canvas_project("别的插件")
    current = read_canvas_document(project.project_id)
    save_canvas_document(project.project_id, CanvasDocument.model_validate({
        **current.model_dump(mode="json"), "nodes": [node]}), expected_revision=current.revision)
    view = tools.get_document(LOCAL, CanvasProjectInput(project_id=project.project_id))
    assert "storyboard" not in view["nodes"][0]


def test_storyboard_follows_project_package():
    from character_workflow.lib.canvas_packages import (
        commit_canvas_package, export_canvas_projects, inspect_canvas_package,
    )
    payload = normalize_payload({"shots": [{"id": "s1", "visual": "倒茶", "image_node_id": "image-1"}]})
    document = saved(payload, media_node("image-1", "image"))
    archive, _ = export_canvas_projects([document.project_id])
    imported = commit_canvas_package(inspect_canvas_package(archive).token)[0]
    restored = read_canvas_document(imported.project_id)
    assert restored.nodes[0].data.payload == payload
    assert agent_view(restored, restored.nodes[0])["storyboard"]["shots"][0]["image_node_id"] == "image-1"


def test_timeline_lists_selected_video_per_shot_in_order():
    """时间线导出的读取入口：顺序即镜头顺序，每镜的视频只认当前文档里类型相符且有内容的节点。"""
    timeline = _SB.timeline
    case = json.loads((PLUGIN_DIR / "tests" / "timeline_case.json").read_text(encoding="utf-8"))
    project = create_canvas_project("时间线")
    current = read_canvas_document(project.project_id)
    document = CanvasDocument.model_validate({
        **current.model_dump(mode="json"),
        "nodes": [storyboard_node(case["payload"]), *case["nodes"]],
        "content_versions": case["content_versions"],
    })
    assert timeline(document, document.nodes[0]) == case["expected"]
