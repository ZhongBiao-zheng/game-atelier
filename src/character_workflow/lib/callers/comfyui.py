"""Execute a registered image workflow; submitted values never contain a graph."""
from __future__ import annotations

import copy
import secrets
import time
from pathlib import Path
from uuid import uuid4

from character_workflow.lib import comfyui_workflows as workflows
from character_workflow.lib.comfyui_client import ComfyUIClient

CLIENT_ID = uuid4().hex
POLL_INTERVAL = 1.5


def _queue_ids(queue: dict, name: str) -> list[str]:
    rows = [item for item in queue.get(name, []) if isinstance(item, list) and len(item) > 1]
    return [str(item[1]) for item in sorted(rows, key=lambda item: item[0])]


def _cancel(client: ComfyUIClient, prompt_id: str) -> None:
    queue = client.get("/queue")
    if prompt_id in _queue_ids(queue, "queue_pending"):
        client.request("POST", "/queue", json={"delete": [prompt_id]})
        # It may have started between GET and delete; only interrupt our own id.
        queue = client.get("/queue")
    if prompt_id in _queue_ids(queue, "queue_running"):
        # Pass the id too so supported ComfyUI versions recheck the running task.
        client.request("POST", "/interrupt", json={"prompt_id": prompt_id})


def render(*, prompt: str, model: str, alias: str, output_dir: Path | str,
           n: int = 1, params: dict | None = None, on_phase=None,
           should_cancel=None, job_id: str | None = None, **kwargs) -> list[str]:
    from character_workflow.lib.job_runner import JobCanceled

    key = workflows.provider(alias)
    workflow = workflows.read_workflow(alias, model)
    workflows.validate_mappings(workflow.api_workflow, workflow.inputs)
    params = params if params is not None else {}
    values = workflows.validate_values(workflow.inputs, params.get("workflow_inputs") or {})
    if type(n) is not int or not 1 <= n <= 4:
        raise ValueError("工作流张数必须在 1–4 之间")
    if n != 1 and any(item.type == "seed" and values[item.id] is not None
                      for item in workflow.inputs):
        raise ValueError("固定种子时每次只能生成 1 张")
    refs = list(params.get("reference_images") or [])
    image_inputs = [item for item in workflow.inputs if item.type == "image"]
    if len(refs) > len(image_inputs):
        raise ValueError(f"工作流最多接受 {len(image_inputs)} 张参考图")
    if params.get("mask_image") and not any(item.type == "mask" for item in workflow.inputs):
        raise ValueError("工作流没有遮罩输入，不接受遮罩")
    for index, item in enumerate(image_inputs):
        workflows.validate_value(item, refs[index] if index < len(refs) else None)
    for item in workflow.inputs:
        if item.type == "prompt":
            workflows.validate_value(item, prompt)
        if item.type == "mask":
            workflows.validate_value(item, params.get("mask_image"))
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    prefix = "atelier/" + (job_id or uuid4().hex)
    outputs = []
    with ComfyUIClient(key.base_url) as client:
        def check_cancel(prompt_id=None):
            if should_cancel and should_cancel():
                if prompt_id:
                    _cancel(client, prompt_id)
                raise JobCanceled("任务已取消")

        def phase_changed(phase, prompt_id):
            # Runner phase callbacks can observe cancellation before the next poll.
            try:
                if on_phase:
                    on_phase(phase)
            except JobCanceled:
                _cancel(client, prompt_id)
                raise

        check_cancel()
        uploaded = {}
        for item, path in [(item, refs[index] if index < len(refs) else None)
                           for index, item in enumerate(image_inputs)] + [
                               (item, params.get("mask_image")) for item in workflow.inputs
                               if item.type == "mask"]:
            if not path:
                continue
            check_cancel()
            with Path(path).open("rb") as file:
                result = client.post("/upload/image", files={
                    "image": (uuid4().hex + Path(path).suffix, file)}, data={"type": "input"})
            uploaded[item.id] = "/".join(filter(None, [result.get("subfolder"), result["name"]]))
        for _ in range(n):
            check_cancel()
            graph = copy.deepcopy(workflow.api_workflow)
            declared_seeds = {(item.node_id, item.field) for item in workflow.inputs
                              if item.type == "seed"}
            for node_id, node in graph.items():
                for field in ("seed", "noise_seed"):
                    if (node["class_type"] in {"KSampler", "KSamplerAdvanced"}
                            and type(node["inputs"].get(field)) is int
                            and (node_id, field) not in declared_seeds):
                        node["inputs"][field] = secrets.randbelow(9007199254740992)
            for item in workflow.inputs:
                value = (prompt if item.type == "prompt" else uploaded.get(item.id)
                         if item.type in {"image", "mask"} else values[item.id])
                if item.type == "seed" and value is None:
                    low = max(0, int(item.min or 0))
                    high = min(9007199254740991, int(item.max) if item.max is not None
                               else 9007199254740991)
                    value = low + secrets.randbelow(high - low + 1)
                if value is not None:
                    graph[item.node_id]["inputs"][item.field] = value
            for node in graph.values():
                if node["class_type"] == "SaveImage":
                    node["inputs"]["filename_prefix"] = prefix
            submitted = client.post("/prompt", json={"prompt": graph, "client_id": CLIENT_ID})
            prompt_id = submitted.get("prompt_id")
            if not prompt_id or submitted.get("node_errors"):
                raise ValueError(f"ComfyUI 拒绝工作流：{submitted.get('node_errors', submitted)}")
            client.execution_started = True
            deadline = time.monotonic() + workflow.timeout_seconds
            while True:
                check_cancel(prompt_id)
                if time.monotonic() >= deadline:
                    _cancel(client, prompt_id)
                    raise TimeoutError("ComfyUI 工作流执行超时")
                entry = client.get(f"/history/{prompt_id}").get(prompt_id)
                if entry:
                    status = entry.get("status", {})
                    if status.get("status_str") == "error":
                        message = next((data.get("exception_message", "执行失败")
                                        for name, data in status.get("messages", [])
                                        if name == "execution_error"), "工作流执行失败")
                        raise ValueError(f"ComfyUI：{message}")
                    if status.get("completed"):
                        break
                queue = client.get("/queue")
                pending = _queue_ids(queue, "queue_pending")
                phase = (f"queued:{pending.index(prompt_id) + 1}" if prompt_id in pending
                         else "sent")
                phase_changed(phase, prompt_id)
                time.sleep(POLL_INTERVAL)
            check_cancel(prompt_id)
            phase_changed("downloading", prompt_id)
            start_count = len(outputs)
            for node_output in entry.get("outputs", {}).values():
                for image in node_output.get("images", []):
                    if image.get("type") != "output":
                        continue
                    check_cancel(prompt_id)
                    response = client.request("GET", "/view", params={
                        name: image.get(name, "") for name in ("filename", "subfolder", "type")})
                    check_cancel(prompt_id)
                    suffix = Path(image["filename"]).suffix.lower()
                    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
                        raise ValueError("ComfyUI 返回了不支持的图片格式")
                    path = directory / f"{uuid4().hex}{suffix}"
                    path.write_bytes(response.content)
                    outputs.append(str(path))
            if len(outputs) == start_count:
                raise ValueError("ComfyUI 未返回 SaveImage 图片")
    return outputs
