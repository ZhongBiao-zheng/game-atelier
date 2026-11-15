"""分镜节点（ADR-0038）：插件节点外壳里的镜头载荷。"""
from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from character_workflow.lib import canvas_agent_tools as tools
from character_workflow.lib.canvas_agent_schema import CanvasProjectInput
from character_workflow.lib.canvas_projects import (
    create_canvas_project, list_canvas_projects, read_canvas_document, save_canvas_document,
)
from character_workflow.lib.canvas_storyboard import (
    MAX_ENTITIES, MAX_SCRIPT_NODES, MAX_SHOT_ENTITIES, MAX_SHOTS, STORYBOARD_NODE_TYPE,
    STORYBOARD_PLUGIN_ID, agent_view, is_storyboard_node, normalize_payload,
)
from character_workflow.lib.plugin_manifest import PluginManifest
from character_workflow.lib.schemas import CanvasDocument
from tests.plugin_fixtures import manifest

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "storyboard_payload_cases.json").read_text(encoding="utf-8"))
LOCAL = SimpleNamespace(kind="local", session_id="human", grant_id=None)


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
    """只用 v5.137.0 已有的节点类型与字段：旧版本回滚后读得出，项目不会从列表里消失。"""
    node = storyboard_node({"shots": [{"id": "s1"}]})
    assert node["type"] == "plugin"
    assert set(node["data"]) == {
        "plugin_id", "node_type", "plugin_version", "data_schema_version", "payload", "generation_draft"}
    document = saved(node["data"]["payload"])
    assert not document.connections
    assert is_storyboard_node(document.nodes[0])
    assert [project.project_id for project in list_canvas_projects()] == [document.project_id]


def test_reserved_plugin_id_cannot_be_claimed_by_a_plugin_package():
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(manifest(id=STORYBOARD_PLUGIN_ID))
    with pytest.raises(ValidationError):
        PluginManifest.model_validate(manifest(id="atelier.other"))


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


def test_agent_reads_shot_summary():
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


def test_other_plugin_nodes_have_no_storyboard_view():
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
