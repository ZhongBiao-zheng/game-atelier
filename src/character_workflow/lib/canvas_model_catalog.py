"""Configured generation models exposed to Canvas tools."""
from character_workflow.lib import keys
from character_workflow.lib.canvas_tool_common import CanvasToolError

def model_configuration(alias: str, model_id: str, kind: str):
    key = keys.find_by_alias(alias)
    if key is not None and not key.enabled:
        raise CanvasToolError("MODEL_UNAVAILABLE", "供应商已停用", 422)
    model = next((m for m in key.models if m.id == model_id), None) if key else None
    if key is None or model is None or not key.access_key:
        raise CanvasToolError("MODEL_UNAVAILABLE", "模型没有在本机配置，请先在设置中配置", 422)
    modalities = key.modalities or (["image"] if key.capabilities else [])
    if (model.modality is not None and model.modality != kind) or (
        model.modality is None and kind not in modalities
    ):
        raise CanvasToolError("MODEL_UNAVAILABLE", "当前模型不支持此生成类型", 422)
    if kind == "video":
        from character_workflow.lib.callers import _effective_protocol
        from character_workflow.lib.callers.video_registry import VIDEO_ADAPTERS
        protocol = _effective_protocol(key, model.id)
        if protocol not in VIDEO_ADAPTERS:
            raise CanvasToolError("MODEL_UNAVAILABLE", "当前视频模型没有已支持的调用协议", 422)
        model = model.model_copy(update={"protocol": protocol})
    else:
        from character_workflow.lib.callers import _provider_render
        if _provider_render(key, model.id) is None:
            raise CanvasToolError("MODEL_UNAVAILABLE", "当前图片模型没有已支持的调用协议", 422)
    return key, model


def model_rows(kind: str) -> list[dict]:
    rows = []
    for key in keys.read_keys_db().keys:
        for model in key.models:
            try:
                _, configured = model_configuration(key.alias, model.id, kind)
            except CanvasToolError:
                continue
            from character_workflow.lib.callers.openai_image import (
                fixed_nano_resolution_quality, image_family, max_reference_images,
                supports_image_quality,
            )
            from character_workflow.lib.video_caps import seedance_limits
            limits = {"image": max_reference_images(model.id), "video": 0, "audio": 0}
            duration = None
            if kind == "video":
                caps = seedance_limits(model.id) if configured.protocol == "seedance" else None
                image_limit = None if configured.protocol == "openrouter" else 2
                if configured.protocol == "dashscope":
                    normalized = model.id.lower()
                    if "video-edit" in normalized:
                        continue  # Local video references are not supported by this transport.
                    image_limit = 9 if "r2v" in normalized else (1 if "i2v" in normalized else 0)
                limits = {"image": caps.max_images if caps else image_limit,
                          "video": caps.max_videos if caps else 0,
                          "audio": caps.max_audios if caps else 0}
                if caps and caps.min_duration is not None and caps.max_duration is not None:
                    duration = {"min": caps.min_duration, "max": caps.max_duration}
            count = {"min": 1, "max": 4} if kind == "image" else {"min": 1, "max": 1}
            if kind == "image" and image_family(model.id) == "midjourney":
                count = {"min": 4, "max": 4}
            quality = (["auto", "low", "medium", "high"]
                       if kind == "image" and supports_image_quality(model.id) else None)
            rows.append({"alias": key.alias, "provider": key.provider, "model": model.id,
                         "name": model.name, "kind": kind, "protocol": configured.protocol,
                         "reference_limits": limits, "estimated_cost_cny": None,
                         "capabilities": {"count": count, "quality": quality,
                                          "fixed_quality": (fixed_nano_resolution_quality(model.id)
                                                            if kind == "image" else None),
                                          "size": None, "ratio": None, "duration": duration,
                                          "resolution": None},
                         "request_limits": {"max_references": 12},
                         "capability_basis": "当前本地适配器约束；null 表示未确认，prepare 会校验已知限制",
                         "price_basis": "费用待确认；以供应商实际账单为准"})
    return _auto_rows(kind, rows) + rows


def _auto_rows(kind: str, rows: list[dict]) -> list[dict]:
    """多家共有的模型加一行「自动」（alias 为 None，model 是路由 id）；组内每家都可用才给。"""
    from character_workflow.lib.model_routes import list_routes

    by_member = {(row["alias"], row["model"]): row for row in rows}
    auto = []
    for route in list_routes(kind):
        members = [by_member.get((m.alias, m.model_id)) for m in route.members]
        if len(members) < 2 or any(row is None for row in members):
            continue
        auto.append({**members[0], "alias": None, "provider": None, "model": route.id,
                     "name": route.name, "route_members": [m.alias for m in route.members]})
    return auto
