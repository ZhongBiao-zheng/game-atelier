"""画布 Agent 新节点落点：排在上一次出图右侧，跳过挡路的节点，同批依次往右，永不重叠。"""
from __future__ import annotations

from itertools import combinations
from types import SimpleNamespace

from character_workflow.lib import canvas_agent_layout as layout


def _image(node_id: str, x: float, y: float, version: str | None = None, size=None):
    return SimpleNamespace(
        id=node_id, type="image", position=SimpleNamespace(x=x, y=y),
        size=SimpleNamespace(width=size[0], height=size[1]) if size else None,
        data=SimpleNamespace(current_version_id=version, display=SimpleNamespace(free_resize=False)))


def _document(nodes, versions=None):
    return SimpleNamespace(nodes=nodes, content_versions=versions or {})


def _version(created_at: str, width=1024, height=1024):
    return SimpleNamespace(created_at=created_at, width=width, height=height)


def _surface(node_id: str) -> dict:
    return {"op": "add_surface", "kind": "image", "node_id": node_id, "title": node_id,
            "position": {"x": 99999, "y": -99999}}  # 模型乱给的坐标会被覆盖


def _rects(document, changes):
    rects = [layout.node_rect(node, document) for node in document.nodes]
    for change in changes:
        if change["op"] == "add_surface":
            rects.append(layout.Rect(change["position"]["x"], change["position"]["y"],
                                     *layout.DEFAULT_SIZE))
    return rects


def test_new_node_goes_right_of_latest_output_and_skips_blockers():
    document = _document(
        [_image("old", 0, 0, "v-old"), _image("latest", 0, 600, "v-new"),
         _image("blocker", 380, 620, None, (400, 300))],
        {"v-old": _version("2026-10-01"), "v-new": _version("2026-10-08")},
    )
    [placed] = layout.with_auto_positions(document, [_surface("s1")], frozenset())
    # latest 是 320×320（按 1:1 锁比例），右侧 368 处被 blocker 挡住 → 跳到 blocker 右边。
    assert placed["position"] == {"x": 380 + 400 + layout.GAP, "y": 600}


def test_batch_places_one_after_another_without_overlap():
    document = _document([_image("a", 0, 0, "v1")], {"v1": _version("2026-10-08")})
    changes = [_surface("s1"), {"op": "set_draft", "node_id": "s1", "params": {}},
               _surface("s2")]
    placed = layout.with_auto_positions(document, changes, frozenset())
    assert placed[0]["position"]["x"] < placed[2]["position"]["x"]
    rects = _rects(document, placed)
    assert not any(a.overlaps(b, gap=0) for a, b in combinations(rects, 2))


def test_session_nodes_win_over_older_outputs_and_empty_canvas_starts_at_origin():
    document = _document([_image("mine", 2000, 50), _image("other", 0, 0, "v1")],
                         {"v1": _version("2026-10-08")})
    [placed] = layout.with_auto_positions(document, [_surface("s1")], frozenset({"mine"}))
    assert placed["position"] == {"x": 2000 + 320 + layout.GAP, "y": 50}
    [first] = layout.with_auto_positions(_document([]), [_surface("s1")], frozenset())
    assert first["position"] == {"x": 0, "y": 0}


def test_tall_draft_ratio_reserves_tall_slot():
    document = _document([_image("a", 0, 0, "v1"), _image("below", 368, 400, None, (320, 176))],
                         {"v1": _version("2026-10-08")})
    changes = [_surface("s1"), {"op": "set_draft", "node_id": "s1", "params": {"ratio": "9:16"}}]
    placed = layout.with_auto_positions(document, changes, frozenset())
    # 9:16 出图后约 320×569，会压到下方的 below → 必须跳过它。
    assert placed[0]["position"]["x"] == 368 + 320 + layout.GAP
