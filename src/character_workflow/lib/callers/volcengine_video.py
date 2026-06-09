"""火山方舟 Ark 直连视频 caller（Seedance）。

不走聚合商通道——Seedance 是 Ark 直连：独立 base_url + Ark Bearer Key +
OpenAI-chat 式 content[] 数组带 role。提交 POST /contents/generations/tasks，
轮询 GET /contents/generations/tasks/{id}，输出 hosted url → 拉字节落 .mp4。
移植自 T8-penguin-canvas/backend/src/providers/volcengine.js。
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import requests

from character_workflow.lib import keys as _keys

DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
DEFAULT_MODEL = "doubao-seedance-2-0-fast-260128"

_SUCCESS = {"SUCCESS", "SUCCEED", "SUCCEEDED", "COMPLETED", "COMPLETE", "DONE", "FINISHED", "OK", "READY"}
_FAILURE = {"FAILURE", "FAILED", "FAIL", "ERROR", "ERRORED", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED", "EXPIRED"}

# 只跟随已知容器/url 键，避免把无关字符串当成视频地址（对应 T8 的 VIDEO_*_KEYS）。
_URL_KEYS = ("url", "video_url", "videoUrl", "mp4_url", "download_url", "output_url")
_CONTAINER_KEYS = ("data", "result", "results", "content", "output", "outputs", "video", "videos", "media")


class VolcengineVideoError(RuntimeError):
    pass


def _base_url(key) -> str:
    return str(getattr(key, "base_url", None) or "").rstrip("/") or DEFAULT_BASE_URL


def _json(resp) -> dict[str, Any]:
    try:
        return resp.json()
    except Exception as e:  # noqa: BLE001
        raise VolcengineVideoError(f"上游响应非 JSON: {getattr(resp, 'text', '')[:300]}") from e


def _err(payload: dict[str, Any], status_code: int) -> str:
    err = payload.get("error")
    if isinstance(err, dict) and err.get("message"):
        return str(err["message"])
    return str(err or payload.get("message") or f"火山上游 HTTP {status_code}")


def _frame_role(index: int, frame_mode: str) -> str:
    mode = (frame_mode or "auto").lower()
    if mode in ("first", "firstlast") and index == 0:
        return "first_frame"
    if mode == "firstlast" and index == 1:
        return "last_frame"
    return "reference_image"


def _build_content(prompt, images, videos, audios, frame_mode) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for i, url in enumerate(list(images)[:9]):
        content.append({"type": "image_url", "image_url": {"url": url}, "role": _frame_role(i, frame_mode)})
    for url in list(videos)[:3]:
        content.append({"type": "video_url", "video_url": {"url": url}, "role": "reference_video"})
    for url in list(audios)[:3]:
        content.append({"type": "audio_url", "audio_url": {"url": url}, "role": "reference_audio"})
    return content


def _collect_video_urls(value, out: list[str] | None = None) -> list[str]:
    if out is None:
        out = []
    if isinstance(value, str):
        s = value.strip()
        if s.startswith("http"):
            out.append(s)
        return out
    if isinstance(value, list):
        for item in value:
            _collect_video_urls(item, out)
        return out
    if isinstance(value, dict):
        for k in _CONTAINER_KEYS:
            if k in value:
                _collect_video_urls(value[k], out)
        for k in _URL_KEYS:
            if k in value:
                _collect_video_urls(value[k], out)
    return out


def _dedupe(urls: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


# 上游成功响应常回显输入参考图（i2v 场景的 image_url）；输出恒为视频，
# 取下载地址前先滤掉图片扩展名，避免把回显的输入图当成输出视频下载。
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic", ".heif", ".avif")


def _pick_video_url(urls: list[str]) -> str | None:
    """从候选 url 里挑出视频地址：先排除图片扩展名；若全是图片则退回原列表首个。"""
    non_image = [u for u in urls if not u.split("?", 1)[0].split("#", 1)[0].lower().endswith(_IMAGE_EXTS)]
    candidates = non_image or urls
    return candidates[0] if candidates else None


def _extract_status(raw: dict[str, Any]) -> str:
    data = raw.get("data") if isinstance(raw.get("data"), dict) else raw
    s = (data.get("status") or data.get("task_status")
         or raw.get("status") or raw.get("task_status") or "")
    return str(s).strip().upper()


def _extract_task_id(raw: dict[str, Any]) -> str:
    data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
    for src in (raw, data):
        for k in ("id", "task_id", "taskId"):
            v = src.get(k)
            if isinstance(v, str) and v:
                return v
    return ""


def _fail_reason(payload: dict[str, Any]) -> str:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    return str(data.get("message") or _err(payload, 0) or "火山视频任务失败")


def _download_mp4(url: str, output_dir: Path, index: int) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        resp = requests.get(url, timeout=600)
        resp.raise_for_status()
    except requests.RequestException as e:
        raise VolcengineVideoError(f"下载上游视频失败: {e}") from e
    path = output_dir / f"v{index}.mp4"
    path.write_bytes(resp.content)
    return str(path)


def _poll_video_task(*, base, headers, task_id, output_dir, max_polls, poll_interval) -> list[str]:
    url = f"{base}/contents/generations/tasks/{task_id}"
    for _ in range(max_polls):
        if poll_interval:
            time.sleep(poll_interval)
        resp = requests.get(url, headers=headers, timeout=180)
        payload = _json(resp)
        if not resp.ok:
            raise VolcengineVideoError(_err(payload, resp.status_code))
        status = _extract_status(payload)
        urls = _dedupe(_collect_video_urls(payload))
        if status in _SUCCESS or (not status and urls):
            picked = _pick_video_url(urls)
            if picked:
                return [_download_mp4(picked, output_dir, 1)]
            raise VolcengineVideoError("视频任务成功但未返回视频地址")
        if status in _FAILURE:
            raise VolcengineVideoError(_fail_reason(payload))
    raise VolcengineVideoError(f"视频任务轮询超时: {task_id}")


def render_video(
    *,
    prompt: str,
    model: str,
    alias: str | None,
    output_dir: Path | str,
    params: dict[str, Any] | None = None,
    max_polls: int = 180,
    poll_interval: float = 5.0,
    **_kwargs,
) -> list[str]:
    """提交一条 Seedance 视频任务，轮询到完成，下 .mp4，返回本地路径 list[str]。"""
    params = dict(params or {})
    key = _keys.find_by_alias(alias) if alias else None
    if key is None:
        raise VolcengineVideoError(f"未找到 Key: {alias}")
    base = _base_url(key)
    headers = {"Authorization": f"Bearer {key.access_key}", "Content-Type": "application/json"}
    content = _build_content(
        prompt,
        params.get("reference_images") or [],
        params.get("reference_videos") or [],
        params.get("reference_audios") or [],
        params.get("frame_mode") or "auto",
    )
    body: dict[str, Any] = {"model": model or DEFAULT_MODEL, "content": content}
    if params.get("duration") is not None:
        body["duration"] = int(params["duration"])
    if params.get("resolution"):
        body["resolution"] = str(params["resolution"])
    ratio = params.get("ratio") or params.get("aspect_ratio")
    if ratio:
        body["ratio"] = str(ratio)
    if params.get("seed") is not None and int(params["seed"]) >= 0:
        body["seed"] = int(params["seed"])
    if params.get("generate_audio"):
        body["generate_audio"] = True

    out_dir = Path(output_dir)
    resp = requests.post(f"{base}/contents/generations/tasks", headers=headers, json=body, timeout=600)
    payload = _json(resp)
    if not resp.ok:
        raise VolcengineVideoError(_err(payload, resp.status_code))
    urls = _dedupe(_collect_video_urls(payload))
    picked = _pick_video_url(urls)
    if picked:
        return [_download_mp4(picked, out_dir, 1)]
    task_id = _extract_task_id(payload)
    if not task_id:
        raise VolcengineVideoError(f"火山视频提交后未返回 task id: {payload!r}")
    return _poll_video_task(
        base=base, headers=headers, task_id=task_id,
        output_dir=out_dir, max_polls=max_polls, poll_interval=poll_interval,
    )
