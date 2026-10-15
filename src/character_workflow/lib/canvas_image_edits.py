"""Resolve native editing from the exact Canvas content version, never from a title."""
from __future__ import annotations

import requests

from .jobs import read_job
from .schemas import CanvasJobOutputOrigin, CanvasMediaVersion


def regional_plan(mask_body, key, model, options):
    """One planner for preview and paid submission; no browser-supplied crop geometry."""
    import hashlib
    import io
    import json
    from PIL import Image
    from .regional_image_edit import plan_regions

    with Image.open(io.BytesIO(mask_body)) as mask:
        regions = plan_regions(mask, key, model, context=options.context,
                               feather=options.feather, groups=options.groups)
    descriptors = [region.descriptor() for region in regions]
    fingerprint = json.dumps({"source": options.source_version_id, "alias": key.alias,
                              "model": model, "regions": descriptors}, sort_keys=True).encode()
    plan_id = hashlib.sha256(mask_body + fingerprint).hexdigest()
    if options.plan_id and options.plan_id != plan_id:
        raise ValueError("区域规划已变化，请确认最新预览后生成")
    if set(options.region_prompts) - {r.id for r in regions}:
        raise ValueError("区域提示词对应的分组已变化，请重新确认")
    return plan_id, regions


def preview_regional_edit(project_id, node_id, alias, model, body, options):
    import base64
    import io
    from PIL import Image
    from .canvas_projects import read_canvas_document, canvas_project_dir
    from .canvas_masks import normalize_canvas_mask
    from .keys import find_by_alias
    from .callers.image_edit import edit_transport
    from .callers.openai_image import _effective_image_protocol

    document = read_canvas_document(project_id)
    node = next((n for n in document.nodes if n.id == node_id), None)
    version = document.content_versions.get(getattr(getattr(node, "data", None),
                                                     "current_version_id", None))
    if (not isinstance(version, CanvasMediaVersion) or version.kind != "image"
            or version.version_id != options.source_version_id):
        raise ValueError("源图版本已经变化，请重新打开编辑器")
    key = find_by_alias(alias)
    if (not key or not any(m.id == model for m in key.models)
            or edit_transport(key.provider, model, _effective_image_protocol(key, model))
            not in {"mask", "guide"} or options.mode != "inpaint"):
        raise ValueError("请选择可用的通用编辑模型")
    mask = normalize_canvas_mask(canvas_project_dir(project_id) / version.path, version, body)
    plan_id, regions = regional_plan(mask.body, key, model, options)
    result = []
    for region in regions:
        overlay = Image.new("RGBA", region.weight.size, (212, 165, 116, 0))
        overlay.putalpha(region.weight.point(lambda p: round(p * .45)))
        buffer = io.BytesIO()
        overlay.save(buffer, format="PNG")
        result.append({**region.descriptor(), "preview": "data:image/png;base64," +
                       base64.b64encode(buffer.getvalue()).decode()})
    return {"plan_id": plan_id, "regions": result}


def has_resumable_mj_task(job) -> bool:
    if job.provider == "evolink":
        state = job.params.evolink_state or {}
        return bool(state.get("task_id") and not state.get("uncertain")
                    and state.get("terminal") not in {"failed", "rejected"})
    from .callers.openai_image import image_family
    if image_family(job.model) != "midjourney":
        return False
    if job.params.image_edit:
        state = job.params.mj_edit_state or {}
        return bool(state.get("task_id") and not state.get("uncertain"))
    return bool(job.params.mj_submission_ids and not job.params.mj_submit_uncertain)


def edit_size_params(key, model: str, width: int, height: int) -> dict:
    from .image_size import normalize_image_size_params
    from .image_size_catalog import image_size_options, is_nano_image_size_model

    if key.provider == "openrouter" or is_nano_image_size_model(model):
        ratios = [r for r in image_size_options(key.provider, key.base_url, model)["ratios"]
                  if r != "auto" and ":" in r]
        def value(r):
            a, b = r.split(":")
            return float(a) / float(b)
        if not ratios:
            raise ValueError("当前渠道未声明可用的编辑比例")
        ratio = min(ratios, key=lambda r: abs(value(r) / (width / height) - 1))
        if abs(value(ratio) / (width / height) - 1) > .02:
            raise ValueError("当前模型不支持这个画框比例，请调整画框或切换模型")
        params = {"size_mode": "ratio", "ratio": ratio, "size": ratio}
    else:
        params = {"size_mode": "custom", "size": f"{width}x{height}"}
    normalized = normalize_image_size_params(key, model, params)
    size = normalized.get("size", "")
    if "x" in size:
        a, b = map(int, size.split("x"))
        if abs((a / b) / (width / height) - 1) > .02:
            raise ValueError("当前模型无法匹配编辑画框比例，请调整画框或切换模型")
    return normalized


def mj_source(version: CanvasMediaVersion) -> dict | None:
    from .keys import find_by_alias
    from .callers.mj_image import channel_fingerprint
    origin = version.origin
    if not isinstance(origin, CanvasJobOutputOrigin):
        return None
    try:
        job = read_job(origin.job_id)
    except (FileNotFoundError, ValueError, KeyError):
        return None
    if not job.canvas_run or not job.alias:
        return None
    candidate = next((item for item in job.canvas_run.candidates
                      if item.candidate_id == origin.candidate_id), None)
    outputs = job.params.mj_outputs or []
    if candidate is None or candidate.index >= len(outputs):
        return None
    output = outputs[candidate.index]
    if output.get("sha256") != version.sha256:
        return None
    key = find_by_alias(job.alias)
    try:
        channel = channel_fingerprint(key) if key else None
    except RuntimeError:
        return None
    if not channel or output.get("channel") != channel:
        return None
    return {**output, "alias": job.alias, "model": job.model}


def editing_source(project_id: str, node_id: str) -> dict:
    from .canvas_projects import read_canvas_document
    from .callers import mj_edit

    document = read_canvas_document(project_id)
    node = next((item for item in document.nodes if item.id == node_id), None)
    version_id = getattr(getattr(node, "data", None), "current_version_id", None)
    version = document.content_versions.get(version_id)
    if not isinstance(version, CanvasMediaVersion) or version.kind != "image":
        raise ValueError("请选择已有图片")
    source = mj_source(version)
    result = {"source_version_id": version.version_id, "mj": None, "reason": None}
    if source:
        try:
            task = mj_edit.fetch_task(source["alias"], source["task_id"])
            if task.get("status") != "SUCCESS":
                raise ValueError("原 MJ 任务已不可用")
            result["mj"] = {
                "alias": source["alias"], "model": source["model"],
                "actions": mj_edit.actions(task.get("buttons") or [],
                                           source["image_index"], source["single"]),
            }
        except (ValueError, RuntimeError, requests.RequestException) as error:
            result["reason"] = str(error)
    return result
