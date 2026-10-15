"""Resolve native editing from the exact Canvas content version, never from a title."""
from __future__ import annotations

import requests

from .jobs import read_job
from .schemas import CanvasJobOutputOrigin, CanvasMediaVersion


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
