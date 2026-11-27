from character_workflow.lib import canvas_group_plan as plans
from character_workflow.lib.schemas import CanvasDocument


def group_document(project_id="test", edges=(), drafts=None):
    drafts = drafts if drafts is not None else ["a", "b", "c", "d"]
    nodes = []
    for i, node_id in enumerate(["a", "b", "c", "d", "input"]):
        draft = {"mode": "image", "updated_at": "now", "model": "test-model", "prompt": node_id}
        nodes.append({"id": node_id, "title": node_id, "type": "image",
                      "position": {"x": i // 2, "y": -i},
                      "data": {"generation_draft": draft} if node_id in drafts else {}})
    nodes.append({"type": "group", "id": "group", "title": "Group", "position": {"x": 0, "y": 0},
                  "data": {"member_node_ids": [n["id"] for n in nodes]}})
    return CanvasDocument.model_validate({
        "project_id": project_id, "updated_at": "now", "nodes": nodes,
        "connections": [{"id": f"edge-{i}", "role": "input",
                         "source_node_id": src, "target_node_id": dst}
                        for i, (src, dst) in enumerate(edges)]})


def test_plan_dependencies_position_input_and_estimate(monkeypatch):
    doc = group_document(edges=[("c", "a"), ("input", "b")])
    monkeypatch.setattr(plans.cost, "_estimate", lambda *args: 0.23)
    result = plans.group_plan("test", "group", doc)
    assert result["order"] == ["b", "d", "c", "a"]
    assert result["total_cny"] == 0.92
    assert result["unpriced"] == 0


def test_cycle_excludes_dependent_tail():
    doc = group_document(edges=[("a", "b"), ("b", "a"), ("b", "c")])
    result = plans.group_plan("test", "group", doc)
    assert result["cycle"] and result["cycle_nodes"] == ["a", "b"]


def test_blocked_and_unpriced():
    doc = group_document(drafts=["a", "b", "c"])
    doc.nodes[0].data.generation_draft.model = ""
    doc.nodes[1].data.generation_draft.prompt = " "
    result = plans.group_plan("test", "group", doc)
    assert result["order"] == ["c"] and result["unpriced"] == 1
    assert [row["reason"] for row in result["blocked"]] == ["未选择模型", "提示词和输入都为空"]



def test_cycle_still_reported_when_member_is_blocked():
    doc = group_document(edges=[("a", "b"), ("b", "a")])
    doc.nodes[0].data.generation_draft.model = ""
    plan = plans.group_plan("test", "group", doc)
    assert plan["cycle_nodes"] == ["a", "b"] and plan["blocked"][0]["node_id"] == "a"


def test_empty_material_is_not_an_input_for_an_empty_prompt():
    doc = group_document(edges=[("input", "a")], drafts=["a"])
    doc.nodes[0].data.generation_draft.prompt = ""
    assert plans.group_plan("test", "group", doc)["blocked"][0]["node_id"] == "a"
