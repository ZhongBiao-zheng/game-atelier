"""Derive evaluation evidence solely from the evaluated server's HTTP projections."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import requests
from PIL import Image

from .media_artifacts import save_output


def _arguments(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            pass
    return value


def steps_from(session):
    if "turns" in session:
        return [
            {
                "tool": step["tool"],
                "arguments": step.get("arguments"),
                "result": step.get("result", step.get("summary")),
                "status": step.get("status"),
                "call_id": step["step_id"],
                "turn_index": number,
            }
            for number, turn in enumerate(session["turns"], 1)
            for step in turn.get("steps", [])
        ]
    if session.get("history"):
        steps = []
        pending = {}
        turn = 0
        for item in session["history"]:
            if item.get("role") == "user":
                turn += 1
            if item.get("type") == "function_call":
                step = {
                    "tool": item["name"],
                    "arguments": _arguments(item.get("arguments")),
                    "result": None,
                    "status": "pending",
                    "call_id": item.get("call_id"),
                    "turn_index": turn,
                }
                steps.append(step)
                pending[step["call_id"]] = step
            elif item.get("type") == "function_call_output" and item.get("call_id") in pending:
                step = pending.pop(item["call_id"])
                result = str(item.get("output", ""))
                step.update(
                    result=result[:4000],
                    status="failed"
                    if result.startswith(("参数错误", "错误", "Error"))
                    else "completed",
                )
        return steps
    steps = []
    turn = 0
    for message in session.get("messages", []):
        if message.get("role") == "user":
            turn += 1
        elif message.get("role") == "tool":
            steps.append(
                {
                    "tool": message.get("title"),
                    "arguments": None,
                    "result": message.get("text"),
                    "status": None,
                    "turn_index": turn or None,
                }
            )
    return steps


def skills_from(session, steps):
    skills = set()
    for step in steps:
        if step["tool"] == "load_skill" and step["status"] == "completed":
            args = step["arguments"]
            if isinstance(args, dict) and args.get("name"):
                skills.add(args["name"])
            elif re.fullmatch(r"[\w.-]+", step.get("result") or ""):
                skills.add(step["result"])
    # Studio's HTTP tool messages retain the successful load_skill argument.
    for msg in session.get("messages", []):
        if msg.get("role") == "tool" and msg.get("title") == "load_skill":
            if re.fullmatch(r"[\w.-]+", msg.get("text") or ""):
                skills.add(msg["text"])
    return sorted(skills)


def per_turn_observation(session, steps, attachments, turn_index):
    number = 0
    messages = []
    for message in session.get("messages", []):
        if message.get("role") == "user":
            number += 1
        if number == turn_index:
            messages.append(message)
    scoped_steps = [step for step in steps if step.get("turn_index") == turn_index]
    answer = next(
        (m["text"] for m in reversed(messages) if m.get("role") == "assistant" and m.get("text")),
        "",
    )
    return {
        "turn_index": turn_index,
        "final_reply": answer,
        "attachments": attachments,
        "loaded_skills": skills_from({"messages": messages}, scoped_steps) if messages else None,
    }


def canvas_result(job, document, selected):
    """Confirm that the Job actually contributed content to the visible result node."""
    context = job.get("canvas_run") or {}
    result_id = context.get("result_node_id")
    if not document or not result_id or "candidates" not in context or not selected:
        return {"on_canvas": None, "canvas_evidence": None}
    node = next((n for n in document["nodes"] if n["id"] == result_id), None)
    versions = {c["version_id"] for c in context["candidates"] if c.get("version_id")}
    visible = set(document["content_versions"]) & versions
    linked = {
        e["source_node_id"] for e in document["connections"] if e["target_node_id"] == result_id
    }
    linked.update(
        e["target_node_id"] for e in document["connections"] if e["source_node_id"] == result_id
    )
    installed = bool(
        node
        and node.get("data", {}).get("current_version_id") in visible
        and visible == versions
        and len(versions) == len(job.get("output_paths", []))
    )
    return {
        "on_canvas": installed and set(selected) <= linked,
        "canvas_evidence": {
            "result_node_id": result_id,
            "selected_node_ids": list(selected),
            "linked_node_ids": sorted(linked),
            "visible_version_ids": sorted(visible),
            "output_version_ids": sorted(versions),
        },
    }


def job_cost(job):
    params = job.get("params") or {}
    if params.get("gateway_charged_on") and params["gateway_charged_on"] != job.get("job_id"):
        return 0, "charged_on_other_job"
    for field, source in (("actual_cost_cny", "actual"), ("estimated_cost_cny", "estimated")):
        if params.get(field) is not None:
            return params[field], source
    if job.get("_approval_estimate") is not None:
        return job["_approval_estimate"], "approval_estimate"
    return None, "unknown"


def usage_from(usage, jobs, session):
    costs = [job_cost(job)[0] for job in jobs]
    generation = sum(value for value in costs if value is not None)
    chat = usage.get("cost_cny")
    if usage.get("requests") == 0:
        chat = 0
    local = usage.get("source") == "local"
    # Session totals do not distinguish individual settled and unsettled gateway requests.
    complete = chat is not None and usage.get("unpriced") == 0 and None not in costs
    tokens = session.get("token_usage", {})
    return {
        "input_tokens": usage.get("input_tokens", tokens.get("input_tokens")),
        "output_tokens": usage.get("output_tokens", tokens.get("output_tokens")),
        "chat_cost_cny": chat,
        "chat_cost_source": (
            "unknown"
            if chat is None
            else "estimated"
            if local
            else "settlement"
            if usage.get("source") == "lan"
            else "mixed"
        ),
        "chat_requests": usage.get("requests"),
        "unpriced_chat_requests": usage.get("unpriced"),
        "generation_cost_cny": round(generation, 8) if None not in costs else None,
        "total_cost_cny": round((chat or 0) + generation, 8),
        "cost_complete": complete,
    }


def _reference_paths(job):
    params = job.get("params") or {}
    paths = [job.get("source_image")]
    for key in (
        "reference_images",
        "reference_videos",
        "reference_audios",
        "mj_sref",
        "mj_cref",
        "mj_oref",
    ):
        paths.extend(params.get(key) or [])
    paths.extend(params.get(name) for name in ("source_image", "mask_image", "markup_image"))
    paths.extend(
        item.get("path") for item in params.get("edit_inputs") or [] if isinstance(item, dict)
    )
    return list(dict.fromkeys(path for path in paths if isinstance(path, str) and path))


def media_evidence(api, job, directory, number, turn_index, notices):
    params = job.get("params") or {}
    cost, source = job_cost(job)
    references = []
    for path in _reference_paths(job):
        digest = None
        try:
            with api.get(
                "/api/raw", params={"job_id": job["job_id"], "path": path}, stream=True
            ) as response:
                response.raise_for_status()
                hasher = hashlib.sha256()
                for part in response.iter_content(1024 * 1024):
                    hasher.update(part)
                digest = hasher.hexdigest()
        except requests.RequestException:
            pass
        references.append({"source": Path(path).name, "sha256": digest})
        if digest is None:
            notices.add("参考素材的 HTTP 响应不可用，无法比对附件内容")
    outputs = []
    for index, path in enumerate(job.get("output_paths") or [], 1):
        kind = job.get("kind", "image")
        try:
            with api.get(
                "/api/raw", params={"job_id": job["job_id"], "path": path}, stream=True
            ) as response:
                response.raise_for_status()
                outputs.append(
                    save_output(
                        response,
                        api.data_root,
                        directory,
                        f"generation-{number:02d}-output-{index:02d}",
                        kind,
                    )
                )
        except (
            requests.RequestException,
            OSError,
            ValueError,
            SyntaxError,
            Image.DecompressionBombError,
        ):
            notices.add(f"第 {number} 次生成的第 {index} 个结果无法下载或解码")
            outputs.append({"path": None, "kind": kind, "error": "media_unavailable"})

    # Keep complete public parameter values, with uploaded media represented by filenames.
    def local_names(value):
        if isinstance(value, dict):
            return {k: local_names(v) for k, v in value.items()}
        if isinstance(value, list):
            return [local_names(v) for v in value]
        if isinstance(value, str) and (
            Path(value).is_absolute() or re.match(r"^[A-Za-z]:[\\/]", value)
        ):
            return re.split(r"[\\/]", value)[-1]
        return value

    return {
        "job_id": job["job_id"],
        "turn_index": turn_index,
        "kind": job.get("kind", "image"),
        "model": job.get("model"),
        "alias": job.get("alias"),
        "prompt": job.get("prompt"),
        "params": local_names(params),
        "status": job.get("status"),
        "error": job.get("error"),
        "retry_of": job.get("retry_of"),
        "references": references,
        "outputs": outputs,
        "estimated_cost_cny": cost
        if source == "approval_estimate"
        else params.get("estimated_cost_cny"),
        "actual_cost_cny": params.get("actual_cost_cny"),
        "cost_cny": cost,
        "cost_source": source,
        "submitted_at": job.get("submitted_at"),
        "completed_at": job.get("completed_at"),
    }
