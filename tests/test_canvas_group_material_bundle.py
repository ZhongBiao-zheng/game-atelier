"""分组作为「素材包」连给生成节点：连线规则、展开顺序、超上限截断。

2026-09-17 规则演化：分组从「不成为连线端点」改为「可以作为 input 源整包供参考」。
CONTEXT.md 的分组节点定义与这里的断言必须同步，别只改一边。
"""
import pytest
from pydantic import ValidationError

from character_workflow.lib.canvas_runs import _trim_group_images_to_limit, canvas_input_sources
from character_workflow.lib.jobs import JobKind, JobParams
from character_workflow.lib.keys import ModelSpec
from character_workflow.lib.schemas import CanvasDocument, CanvasSnapshotInput

_DRAFT = {
    "mode": "image", "prompt": "", "input_policy": "all_connected",
    "model": "gpt-image-2", "params": {}, "updated_at": "2026-09-17T00:00:00Z",
}


def _document(member_ids, connections):
    nodes = [
        {"id": node_id, "type": "image", "title": node_id,
         "position": {"x": 0, "y": 0}, "data": {"current_version_id": None}}
        for node_id in ("image-a", "image-b", "image-c")
    ]
    nodes.append({"id": "config", "type": "config", "title": "config",
                  "position": {"x": 0, "y": 0}, "data": {"draft": _DRAFT}})
    nodes.append({"id": "group", "type": "group", "title": "分组",
                  "position": {"x": 0, "y": 0}, "data": {"member_node_ids": list(member_ids)}})
    return CanvasDocument.model_validate({
        "project_id": "canvas-group", "updated_at": "2026-09-17T00:00:00Z",
        "nodes": nodes, "connections": connections,
    })


def _edge(edge_id, source, target, **extra):
    return {"id": edge_id, "role": "input",
            "source_node_id": source, "target_node_id": target, **extra}


def test_group_is_a_legal_input_source():
    document = _document(["image-a"], [_edge("e", "group", "config")])
    assert [edge.source_node_id for edge in document.connections] == ["group"]


def test_group_never_receives_a_connection():
    with pytest.raises(ValidationError, match="group nodes cannot receive connections"):
        _document(["image-a"], [_edge("e", "image-b", "group")])


@pytest.mark.parametrize("extra", [
    {"slot": "first_frame"},          # 槽位要的是一张确定的图，一个包给不出这个承诺
    {"role": "material"},             # material 是图层栈的反向引用，与素材包无关
])
def test_group_source_is_rejected_outside_plain_input(extra):
    with pytest.raises(ValidationError):
        _document(["image-a"], [_edge("e", "group", "config", **extra)])


def test_group_expands_to_content_members_in_member_order():
    document = _document(["image-c", "image-a", "config"], [_edge("e", "group", "config")])
    surface = next(node for node in document.nodes if node.id == "config")
    sources = canvas_input_sources(document, surface, surface.data.draft)
    # config 不提供内容，展开时丢掉；顺序照 member_node_ids，不按节点在文档里的次序重排。
    assert sources == [("group_member", "image-c"), ("group_member", "image-a")]


def test_direct_edge_wins_over_the_same_node_inside_a_group():
    document = _document(
        ["image-a", "image-b"],
        [_edge("direct", "image-b", "config"), _edge("bundle", "group", "config")],
    )
    surface = next(node for node in document.nodes if node.id == "config")
    sources = canvas_input_sources(document, surface, surface.data.draft)
    # 同一个节点既直连又在包里时只算一次，并且记成直连——截断时优先保留画师手连的那张。
    assert sources == [("input_connection", "image-b"), ("group_member", "image-a")]


def _image_input(order, source, node_id):
    return CanvasSnapshotInput(
        order=order, source=source, node_id=node_id, version_id=f"v-{node_id}", kind="image",
    )


def test_over_limit_group_images_are_trimmed_from_the_tail_with_a_warning():
    model = ModelSpec(name="Nano Banana", id="nano-banana")  # 该族参考图上限 3
    params = JobParams()
    inputs = [_image_input(0, "input_connection", "direct")] + [
        _image_input(index, "group_member", f"member-{index}") for index in range(1, 5)
    ]

    trimmed = _trim_group_images_to_limit(model, JobKind.IMAGE, inputs, params)

    assert [item.node_id for item in trimmed] == ["direct", "member-1", "member-2"]
    assert [item.order for item in trimmed] == [0, 1, 2]
    assert params.warnings == ["分组里的参考图超过该模型上限 3 张，本次只用了前 3 张。"]


def test_hand_wired_inputs_are_never_trimmed():
    model = ModelSpec(name="Nano Banana", id="nano-banana")
    params = JobParams()
    inputs = [_image_input(index, "input_connection", f"direct-{index}") for index in range(4)]

    # 逐条直连超限仍然当场报错（_validate_input_capabilities 负责），这里原样返回不做手脚。
    assert _trim_group_images_to_limit(model, JobKind.IMAGE, inputs, params) == inputs
    assert not params.warnings
