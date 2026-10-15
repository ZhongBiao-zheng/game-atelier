"""Resolve native editing from the exact Canvas content version, never from a title."""
from __future__ import annotations

import requests

from .jobs import read_job
from .schemas import CanvasJobOutputOrigin, CanvasMediaVersion


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
