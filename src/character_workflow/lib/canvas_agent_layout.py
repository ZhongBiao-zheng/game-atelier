"""画布 Agent 新建节点的落点：不用模型给的坐标，按「上一次出图的右侧、不和任何节点重叠」摆放。

模型看不到画面，自己编的坐标经常压在已有内容上或飞得很远。所以 Agent 走 apply_changes 时，
add_text / add_media_node / add_surface 的 position 一律由这里重新计算：
- 锚点：本会话建过的节点里最右那个（Agent 一路往右摆，最右即最近一次；还在生成的空节点也算）
  → 画布上最近一次出图的图片 / 视频节点 → 全部内容的右边缘 → 原点。
- 从锚点右侧一个间距处开始放；和谁重叠就跳到那个节点的右边缘之后，直到不重叠。
节点尺寸按前端 canvasNodeRenderedSize 的规则估算；空的生成节点按同批 set_draft 的比例估算出图后的大小。
"""
from __future__ import annotations

from dataclasses import dataclass

from character_workflow.lib.schemas import CanvasDocument, CanvasNode, JobParams

GAP = 48
DEFAULT_SIZE = (320.0, 176.0)  # 与前端 CANVAS_DEFAULT_NODE_SIZE 一致
TEXT_SIZE = (256.0, 144.0)  # 与前端 CANVAS_TEXT_NODE_DEFAULT_SIZE 一致
ADD_OPS = frozenset({"add_text", "add_media_node", "add_surface"})


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    width: float
    height: float

    @property
    def right(self) -> float:
        return self.x + self.width

    def overlaps(self, other: "Rect", gap: float = GAP) -> bool:
        """两个矩形之间不足 gap 也算重叠，新节点不贴着别人放。"""
        return not (self.right + gap <= other.x or other.right + gap <= self.x
                    or self.y + self.height + gap <= other.y
                    or other.y + other.height + gap <= self.y)


def _locked_size(size: tuple[float, float] | None, width: int | None,
                 height: int | None) -> tuple[float, float]:
    """前端 sizeLockedToCanvasVersion：按产物比例锁节点尺寸。"""
    if not width or not height:
        return size or DEFAULT_SIZE
    ratio = width / height
    if size and abs(size[0] / ratio - size[1]) <= 1:
        return size
    w = min(4000.0, max(240.0, size[0] if size else DEFAULT_SIZE[0]))
    h = w / ratio
    if h < 150:
        h, w = 150.0, 150.0 * ratio
    if h > 4000:
        h, w = 4000.0, 4000.0 * ratio
    if w > 4000:
        w, h = 4000.0, 4000.0 / ratio
    return w, h


def node_rect(node: CanvasNode, document: CanvasDocument) -> Rect:
    size = (node.size.width, node.size.height) if node.size is not None else None
    if node.type == "text":
        w, h = size or TEXT_SIZE
    elif node.type in {"image", "video"} and not getattr(node.data.display, "free_resize", False) \
            and node.data.current_version_id:
        version = document.content_versions.get(node.data.current_version_id)
        w, h = _locked_size(size, getattr(version, "width", None), getattr(version, "height", None))
    else:
        w, h = size or DEFAULT_SIZE
    return Rect(node.position.x, node.position.y, w, h)


def _anchor(document: CanvasDocument, rects: dict[str, Rect],
            session_ids: frozenset[str]) -> Rect | None:
    mine = [rects[node_id] for node_id in session_ids if node_id in rects]
    if mine:
        return max(mine, key=lambda rect: (rect.right, rect.y))
    latest: tuple[str, str] | None = None
    for node in document.nodes:
        if node.id not in rects or node.type not in {"image", "video"}:
            continue
        version_id = node.data.current_version_id
        version = document.content_versions.get(version_id) if version_id else None
        if version is not None and (latest is None or version.created_at > latest[0]):
            latest = (version.created_at, node.id)
    if latest:
        return rects[latest[1]]
    if rects:
        rightmost = max(rects.values(), key=lambda rect: rect.right)
        top = min(rect.y for rect in rects.values())
        return Rect(rightmost.x, top, rightmost.width, rightmost.height)
    return None


def place(obstacles: list[Rect], anchor: Rect | None, width: float, height: float) -> Rect:
    candidate = Rect(anchor.right + GAP, anchor.y, width, height) if anchor else \
        Rect(0, 0, width, height)
    while True:
        blocking = [rect for rect in obstacles if candidate.overlaps(rect)]
        if not blocking:
            return candidate
        candidate = Rect(max(rect.right for rect in blocking) + GAP, candidate.y, width, height)


def _estimated_size(change: dict, drafts: dict[str, dict]) -> tuple[float, float]:
    if change.get("op") == "add_text":
        return TEXT_SIZE
    if change.get("op") == "add_surface" and change.get("kind") in {"image", "video"}:
        params = drafts.get(str(change.get("node_id") or ""), {}).get("params")
        if isinstance(params, dict):
            from character_workflow.lib.canvas_runs import _result_image_size
            try:
                size = _result_image_size(JobParams(**params))
            except (TypeError, ValueError):
                return DEFAULT_SIZE
            return size.width, size.height
    return DEFAULT_SIZE


def with_auto_positions(document: CanvasDocument, changes: list,
                        session_ids: frozenset[str]) -> list:
    """Return changes with every add_* position replaced by a non-overlapping slot."""
    if not any(isinstance(change, dict) and change.get("op") in ADD_OPS for change in changes):
        return changes
    removed = {change.get("node_id") for change in changes
               if isinstance(change, dict) and change.get("op") == "remove_node"}
    rects = {node.id: node_rect(node, document) for node in document.nodes if node.id not in removed}
    obstacles = list(rects.values())
    anchor = _anchor(document, rects, session_ids)
    drafts = {str(change.get("node_id")): change for change in changes
              if isinstance(change, dict) and change.get("op") == "set_draft"}
    result = []
    for change in changes:
        if not isinstance(change, dict) or change.get("op") not in ADD_OPS:
            result.append(change)
            continue
        slot = place(obstacles, anchor, *_estimated_size(change, drafts))
        obstacles.append(slot)
        anchor = slot  # 同一批的下一个接着往右摆
        result.append({**change, "position": {"x": round(slot.x), "y": round(slot.y)}})
    return result
