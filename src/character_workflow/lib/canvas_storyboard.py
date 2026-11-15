"""分镜节点：载荷的宽容读取（ADR-0038）。

分镜节点存成插件节点外壳，`plugin_id` 是宿主保留的 `atelier.storyboard`，镜头数据在 `payload`。
画布文档的读盘模型对 `payload` 只有大小约束，形状由这里解析：缺字段补默认、类型不对取默认、
超长截断、多余字段丢弃。载荷可能来自项目包、局域网分享或粘贴，一律当不可信数据。
与前端 `web/src/lib/canvasStoryboard.ts` 的 normalizeStoryboardPayload 同一套规则，
共用夹具 `tests/fixtures/storyboard_payload_cases.json`。
"""
from __future__ import annotations

import math
import re
from typing import Any

STORYBOARD_PLUGIN_ID = "atelier.storyboard"
STORYBOARD_NODE_TYPE = "board"

MAX_SHOTS = 120
MAX_ENTITIES = 60
MAX_SHOT_ENTITIES = 20
MAX_SCRIPT_NODES = 8
MAX_NODE_ID = 120
DEFAULT_RATIO = "16:9"
DEFAULT_DURATION_S = 5
MIN_DURATION_S = 1
MAX_DURATION_S = 60
ENTITY_KINDS = ("character", "scene", "prop")

_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_RATIO = re.compile(r"^[1-9]\d?:[1-9]\d?$")
_SHOT_TEXT = {"scene": 60, "shot_size": 20, "camera": 40, "visual": 2000, "dialogue": 1000,
              "image_prompt": 4000, "video_prompt": 4000}


def is_storyboard_node(node: Any) -> bool:
    return (getattr(node, "type", None) == "plugin"
            and node.data.plugin_id == STORYBOARD_PLUGIN_ID
            and node.data.node_type == STORYBOARD_NODE_TYPE)


def _text(value: Any, limit: int) -> str:
    return value[:limit] if isinstance(value, str) else ""


def _node_id(value: Any) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= MAX_NODE_ID else None


def _items(value: Any) -> list:
    return value if isinstance(value, list) else []


def _duration(value: Any) -> float | int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return DEFAULT_DURATION_S
    return min(MAX_DURATION_S, max(MIN_DURATION_S, value))


def _unique_ids(values: Any, allowed: set[str] | None, limit: int) -> list[str]:
    result: list[str] = []
    for value in _items(values):
        if _node_id(value) is None or value in result or (allowed is not None and value not in allowed):
            continue
        result.append(value)
        if len(result) == limit:
            break
    return result


def _valid_id(item: Any, seen: set[str]) -> bool:
    return (isinstance(item, dict) and isinstance(item.get("id"), str)
            and bool(_ID.match(item["id"])) and item["id"] not in seen)


def normalize_payload(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    entities: list[dict[str, Any]] = []
    entity_ids: set[str] = set()
    for item in _items(source.get("entities")):
        if len(entities) == MAX_ENTITIES:
            break
        if not _valid_id(item, entity_ids):
            continue
        entity_ids.add(item["id"])
        entities.append({
            "id": item["id"],
            "kind": item.get("kind") if item.get("kind") in ENTITY_KINDS else "character",
            "name": _text(item.get("name"), 40),
            "description": _text(item.get("description"), 1000),
            "reference_node_id": _node_id(item.get("reference_node_id")),
        })
    shots: list[dict[str, Any]] = []
    shot_ids: set[str] = set()
    for item in _items(source.get("shots")):
        if len(shots) == MAX_SHOTS:
            break
        if not _valid_id(item, shot_ids):
            continue
        shot_ids.add(item["id"])
        shots.append({
            "id": item["id"],
            **{field: _text(item.get(field), limit) for field, limit in _SHOT_TEXT.items()},
            "duration_s": _duration(item.get("duration_s")),
            "entity_ids": _unique_ids(item.get("entity_ids"), entity_ids, MAX_SHOT_ENTITIES),
            "image_node_id": _node_id(item.get("image_node_id")),
            "video_node_id": _node_id(item.get("video_node_id")),
        })
    ratio = source.get("ratio")
    return {
        "ratio": ratio if isinstance(ratio, str) and _RATIO.match(ratio) else DEFAULT_RATIO,
        "style_prefix": _text(source.get("style_prefix"), 2000),
        "entities": entities,
        "shots": shots,
        "script_node_ids": _unique_ids(source.get("script_node_ids"), None, MAX_SCRIPT_NODES),
    }


def bound_node_id(document: Any, node_id: str | None, node_type: str) -> str | None:
    """载荷里的节点 id 只在当前文档内解析：不存在或类型不符一律当作没有绑定。"""
    if node_id is None:
        return None
    return next((node.id for node in document.nodes if node.id == node_id and node.type == node_type), None)


def agent_view(document: Any, node: Any, text_limit: int = 300) -> dict[str, Any]:
    """给画布 Agent 看的镜头摘要：只读，长文本截短。"""
    payload = normalize_payload(node.data.payload)
    names = {entity["id"]: entity["name"] for entity in payload["entities"]}
    return {
        "storyboard": {
            "ratio": payload["ratio"],
            "total_duration_s": sum(shot["duration_s"] for shot in payload["shots"]),
            "entities": [{"kind": entity["kind"], "name": entity["name"],
                          "reference_node_id": bound_node_id(document, entity["reference_node_id"], "image")}
                         for entity in payload["entities"]],
            "shots": [{
                "index": index + 1, "scene": shot["scene"], "shot_size": shot["shot_size"],
                "camera": shot["camera"], "duration_s": shot["duration_s"],
                "visual": shot["visual"][:text_limit], "dialogue": shot["dialogue"][:text_limit],
                "entities": [names[entity_id] for entity_id in shot["entity_ids"]],
                "image_node_id": bound_node_id(document, shot["image_node_id"], "image"),
                "video_node_id": bound_node_id(document, shot["video_node_id"], "video"),
            } for index, shot in enumerate(payload["shots"])],
        },
    }


def timeline(document: Any, node: Any) -> list[dict[str, Any]]:
    """按镜头顺序列出每镜选定的视频，给「视频时间线导出」读取。

    每镜只有一个出处：`video_node_id` 指向的视频节点的当前内容版本。绑定的节点不存在、不是
    视频节点、或还没有内容时 `video_version_id` 为 None，由调用方决定跳过还是中止。
    `duration_ms` 取版本上登记的时长；生成出的视频目前不登记时长，为 None 时需要调用方自己探测。
    与前端 `storyboardTimeline` 同一套规则，共用夹具 `tests/fixtures/storyboard_timeline_case.json`。
    """
    payload = normalize_payload(node.data.payload)
    nodes = {item.id: item for item in document.nodes}
    rows: list[dict[str, Any]] = []
    for index, shot in enumerate(payload["shots"]):
        video_id = bound_node_id(document, shot["video_node_id"], "video")
        version = (document.content_versions.get(nodes[video_id].data.current_version_id or "")
                   if video_id else None)
        ready = version is not None and version.kind == "video"
        rows.append({
            "shot_id": shot["id"], "index": index + 1, "planned_duration_s": shot["duration_s"],
            "dialogue": shot["dialogue"], "video_node_id": video_id,
            "video_version_id": version.version_id if ready else None,
            "duration_ms": version.duration_ms if ready else None,
        })
    return rows
