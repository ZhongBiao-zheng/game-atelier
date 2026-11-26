from types import SimpleNamespace
from copy import deepcopy

import pytest

from character_workflow.lib import plugin_registry
from character_workflow.lib.collab_sanitize import _node_view, _public_values
from character_workflow.lib.plugin_manifest import PluginNodeContribution
from character_workflow.lib.schemas import CanvasPluginNode


def test_copy_uses_installed_manifest_scalar_fields_without_replacing_original_payload(monkeypatch):
    contribution = PluginNodeContribution(type="panel", title="镜头", icon="image",
        default_size={"width": 200, "height": 100}, payload_schema_version=1, surfaces=["node"],
        shared_fields=["title", "shots.caption", "shots.api_key", "metadata"])
    lock = SimpleNamespace(version="1.0.0", digest="sha256:" + "0" * 64,
                           contributes=SimpleNamespace(nodes=[contribution]))
    monkeypatch.setattr(plugin_registry, "find", lambda _: SimpleNamespace(availability="ok", lock=lock))
    payload = {"title": "镜头一", "shots": [{"caption": "开场", "api_key": "private", "internal": "hidden"}],
               "metadata": {"private": True}, "unknown": True}
    node = CanvasPluginNode(type="plugin", id="plugin-1", title="本地插件", position={"x": 0, "y": 0}, z_index=0,
        data={"plugin_id": "third-party", "node_type": "panel", "plugin_version": "1.0.0",
              "data_schema_version": 1, "payload": payload})
    assert _public_values(_node_view(node))["data"]["payload"] == {
        "title": "镜头一", "shots": [{"caption": "开场"}], "metadata": {},
    }
    assert node.data.payload == payload
    contribution.shared_fields = []
    data = _node_view(node)["data"]
    assert data["shared_placeholder"] and data["payload"] == {}


def test_storyboard_guest_edits_and_reorder_preserve_original_fields():
    from character_workflow.lib.collab_ops import CollabOpError, _update_node
    raw = {"entities": [{"id": "a", "name": "原名", "description": "设定 /Users/artist/reference.png",
                          "local_notes": "手记"}, {"id": "b", "name": "第二人"}],
           "shots": [{"id": "s1", "visual": "开场"}], "extra": "房主原文"}
    node = CanvasPluginNode(id="storyboard", type="plugin", title="分镜", position={"x": 0, "y": 0},
        data={"plugin_id": "storyboard", "node_type": "board", "plugin_version": "1.0.0",
              "data_schema_version": 1, "payload": raw})
    base = _public_values(_node_view(node))["data"]["payload"]
    assert base["entities"][0]["description"] == "设定 <local-path>"
    edited = deepcopy(base)
    edited["entities"][0]["name"] = "访客改名"
    edited["entities"].reverse()
    node.data.payload["shots"][0]["visual"] = "房主同时修改的开场"
    updated = _update_node(node, {"data": {"payload": edited}}, base).data.payload
    assert updated == {**raw, "shots": [{"id": "s1", "visual": "房主同时修改的开场"}],
                       "entities": [raw["entities"][1], {**raw["entities"][0], "name": "访客改名"}]}
    edited["entities"][1]["description"] += "!"
    with pytest.raises(CollabOpError, match="私有内容"):
        _update_node(node, {"data": {"payload": edited}}, base)
