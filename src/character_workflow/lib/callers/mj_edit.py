"""Native MJ actions. Button IDs and task affinity are supplied by a verified source."""
from __future__ import annotations

import base64
import hashlib
import io
from pathlib import Path
from urllib.parse import quote

from PIL import Image, ImageOps

from character_workflow.lib import keys
from . import mj_image as mj


def actions(buttons: list[dict], image_index: int, single: bool) -> list[dict]:
    result = []
    for button in buttons:
        custom_id = str(button.get("customId") or "")
        label = str(button.get("label") or "")
        lower = custom_id.lower()
        kind = None
        if not single and "::upsample::" in lower and (
            image_index == 0 or f"::upsample::{image_index}::" in lower
        ):
            kind, label = "prepare", f"准备单图 {label}".strip()
        elif single:
            if "::inpaint::" in lower:
                kind, label = "inpaint", "局部修改"
            elif "::zoom::" in lower or "::pan::" in lower or "custom_zoom" in lower:
                kind = "outpaint"
        if kind:
            result.append({"custom_id": custom_id, "kind": kind, "label": label or kind})
    return result


def mask_base64(path: Path) -> str:
    with Image.open(path) as opened:
        mask = ImageOps.invert(opened.convert("L"))
    stream = io.BytesIO()
    mask.save(stream, format="PNG")
    return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii")


def fetch_task(alias: str, task_id: str) -> dict:
    key = keys.find_by_alias(alias)
    if key is None:
        raise ValueError("原 MJ 任务的密钥已不存在")
    response = mj.requests.get(f"{mj._api_root(key)}/mj/task/{quote(task_id, safe='')}/fetch",
                               headers={"Authorization": f"Bearer {key.access_key}"}, timeout=30)
    payload = mj._json(response)
    if not response.ok:
        raise mj.MidjourneyError(mj._err(payload, response.status_code))
    return payload


def render(*, prompt: str, model: str, alias: str, output_dir: Path, params: dict,
           on_params_changed=None, on_phase=None, should_cancel=None,
           max_polls=120, poll_interval=3., **_kwargs) -> list[str]:
    options = params["image_edit"]
    key = keys.find_by_alias(alias)
    if key is None:
        raise ValueError("原 MJ 任务的密钥已不存在")
    root = mj._api_root(key)
    if options.get("channel") and options["channel"] != mj.channel_fingerprint(key):
        raise mj.MidjourneyError("原 MJ 任务的授权已变化，不能跨渠道编辑")
    headers = {"Authorization": f"Bearer {key.access_key}", "Content-Type": "application/json"}
    state = params.setdefault("mj_edit_state", {})

    def save():
        if on_params_changed:
            on_params_changed()

    def submit(endpoint, body):
        if should_cancel and should_cancel():
            raise mj.MidjourneyError("已停止")
        state["uncertain"] = True
        save()
        response = mj.requests.post(f"{root}/mj/submit/{endpoint}", headers=headers,
                                    json=body, timeout=120)
        payload = mj._json(response)
        accepted_codes = {1, 21, 22} if endpoint == "action" else {1, 22}
        if not response.ok or payload.get("code") not in accepted_codes:
            raise mj.MidjourneyError(mj._err(payload, response.status_code))
        task_id = mj._extract_task_id(payload)
        if not task_id:
            raise mj.MidjourneyError("MJ 未返回任务 ID，请核对订单；不会自动重复提交")
        state.update(task_id=task_id, uncertain=False)
        if endpoint == "modal":
            state["modal_sent"] = True
        save()
        return task_id

    if state.get("uncertain"):
        raise mj.MidjourneyError("MJ 上次提交结果未确认，请核对供应商订单；不会重复提交")
    task_id = state.get("task_id")
    if not task_id:
        source = fetch_task(alias, options["task_id"])
        allowed = actions(source.get("buttons") or [], options["image_index"], options["single"])
        if source.get("status") != "SUCCESS" or not any(
            action["custom_id"] == options["custom_id"] and action["kind"] == options["mode"]
            for action in allowed
        ):
            raise mj.MidjourneyError("原任务不再支持这个动作，请重新打开编辑器")
        task_id = submit("action", {"taskId": options["task_id"],
                                    "customId": options["custom_id"]})
    # Code 21 also means an existing task. Only the fetched MODAL state authorizes modal submit.
    def on_modal(modal_id):
        if state.get("modal_sent"):
            return
        body = {"taskId": modal_id, "prompt": prompt, "maskBase64": ""}
        if options["mode"] == "inpaint":
            body["maskBase64"] = mask_base64(Path(params["mask_image"]))
        if "custom_zoom" in options["custom_id"].lower():
            body["prompt"] = prompt + f" --zoom {options.get('zoom', 1.5)}"
        submitted_id = submit("modal", body)
        if submitted_id != modal_id:
            raise mj.MidjourneyError("MJ 弹窗返回了不同的任务 ID，请核对供应商订单")
    if on_phase:
        on_phase("sent")
    result = {}
    try:
        urls = mj._poll_task(root=root, headers=headers, task_id=task_id,
                             max_polls=max_polls, poll_interval=poll_interval,
                             should_cancel=should_cancel, on_modal=on_modal, on_result=result.update)
    except mj.MidjourneyPendingError:
        state["poll_paused"] = True
        save()
        raise
    state["poll_paused"] = False
    if on_phase:
        on_phase("downloading")
    paths, outputs = [], []
    for index, url in enumerate(urls, 1):
        path = mj._download_png(url, output_dir, index, task_ref=task_id)
        paths.append(path)
        single = options["mode"] == "prepare" or (
            len(urls) == 1 and any("::inpaint::" in str(button.get("customId", "")).lower()
                                  for button in result.get("buttons", [])))
        outputs.append({"task_id": task_id,
                        "image_index": index if single or result.get("imageUrls") else 0,
                        "single": single,
                        "channel": mj.channel_fingerprint(key),
                        "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest()})
    params["mj_outputs"] = outputs
    mj._publish_actual_n(params, params.get("n", 4), len(paths))
    save()
    return paths
