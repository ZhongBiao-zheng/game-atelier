"""Read-only execution plan for generation drafts in a canvas group."""
import hashlib
import json

from character_workflow.lib import canvas_agent_cost as cost
from character_workflow.lib.callers.openai_image import image_family
from character_workflow.lib.canvas_projects import read_canvas_document
from character_workflow.lib.canvas_runs import canvas_input_sources
from character_workflow.lib.schemas import canvas_allowed_draft_params


def _has_content(document, node):
    version = document.content_versions.get(getattr(node.data, "current_version_id", None))
    return version is not None and (version.kind != "text" or bool(version.text.strip()))


def _cycle_members(deps):
    # Kahn's remainder also contains downstream nodes. Report only members on a cycle.
    def reaches_self(start):
        frontier = list(deps[start])
        visited = set()
        while frontier:
            node = frontier.pop()
            if node == start:
                return True
            if node not in visited:
                visited.add(node)
                frontier.extend(deps[node])
        return False

    return sorted(node for node in deps if reaches_self(node))


def quote_id(project_id, group_id, plan):
    payload = [project_id, group_id, plan["steps"], plan["blocked"], plan["cycle_nodes"]]
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def group_plan(project_id, group_id, document=None):
    document = document or read_canvas_document(project_id)
    nodes = {node.id: node for node in document.nodes}
    group = nodes.get(group_id)
    if group is None or group.type != "group":
        raise KeyError(group_id)
    rows, blocked = {}, []
    members = {node_id for node_id in group.data.member_node_ids
               if getattr(nodes[node_id].data, "generation_draft", None) is not None}
    dependencies = {node: set() for node in members}
    for node_id in sorted(members):
        node = nodes[node_id]
        draft = node.data.generation_draft
        try:
            inputs = canvas_input_sources(document, node, draft)
            dependencies[node_id] = {source for _, source, _ in inputs if source in members}
            if not draft.model.strip():
                raise ValueError("未选择模型")
            if not draft.prompt.strip() and not any(
                source in members or _has_content(document, nodes[source]) for _, source, _ in inputs
            ):
                raise ValueError("提示词和输入都为空")
        except ValueError as error:
            blocked.append({"node_id": node_id, "name": node.title, "reason": str(error)})
            continue
        count = 4 if draft.mode == "image" and image_family(draft.model) == "midjourney" else 1
        estimate = cost.generation_estimate(project_id, node_id, count, [{
            "op": "set_draft", "node_id": node_id, "mode": draft.mode, "model": draft.model,
            "alias": draft.alias, "params": canvas_allowed_draft_params(draft.mode, draft.params),
        }])
        rows[node_id] = {"node_id": node_id, "name": node.title, "mode": draft.mode, **estimate}

    order = []
    remaining = {node: set(deps) for node, deps in dependencies.items()}
    while remaining:
        ready = [node for node, deps in remaining.items() if not deps]
        if not ready:
            break
        node = min(ready, key=lambda n: (nodes[n].position.x, nodes[n].position.y, n))
        if node in rows:
            order.append(node)
        del remaining[node]
        for deps in remaining.values():
            deps.discard(node)
    steps = [rows[node] for node in order]
    total = round(sum(row["estimate_cny"] or 0 for row in steps), 6)
    return {"order": order, "steps": steps, "total_cny": total,
            "unpriced": sum(row["estimate_cny"] is None for row in steps),
            "blocked": blocked, "cycle": bool(remaining), "cycle_nodes": _cycle_members(remaining),
            "needs_confirmation": cost.needs_cost_confirmation(total)}
