"""OpenRouter 视频 caller（异步 job：提交 → 轮询 → 下载）。

契约源 openrouter.ai/docs/guides/overview/multimodal/video-generation：
POST {base}/videos 得 202 {id, polling_url, status} → GET polling_url 轮询
status（pending/in_progress → completed/failed）→ completed 后从
unsigned_urls[0]（即 {base}/videos/{id}/content）带鉴权拉字节落 .mp4。

参考图两种模式（frame_images 优先）：
- frame_mode=first/last/firstlast → frame_images（image-to-video，逐张标 frame_type）
- frame_mode=auto/缺省 → input_references（reference-to-video，风格参考）
"""
from __future__ import annotations

import base64
from collections.abc import Callable
from pathlib import Path
from typing import Any

import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib.callers import video_poll

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

_TERMINAL_FAILURE = {"failed", "cancelled", "expired"}


class OpenRouterVideoError(RuntimeError):
    pass


def _json(resp) -> dict[str, Any]:
    try:
        return resp.json()
    except Exception as e:  # noqa: BLE001
        raise OpenRouterVideoError(f"上游响应非 JSON: {getattr(resp, 'text', '')[:300]}") from e


def _err(payload: dict[str, Any], status_code: int) -> str:
    err = payload.get("error")
    if isinstance(err, dict):
        err = err.get("message") or err.get("code")
    return str(err or payload.get("message") or f"OpenRouter 上游 HTTP {status_code}")


def _image_payload_url(path_or_url: str) -> str:
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://", "data:")):
        return s
    try:
        raw = Path(s).read_bytes()
    except OSError as e:
        raise OpenRouterVideoError(f"读取参考图失败: {s}: {e}") from e
    ext = Path(s).suffix.lstrip(".").lower() or "png"
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def _frame_images(images: list[str], frame_mode: str) -> list[dict[str, Any]]:
    def entry(path: str, frame_type: str) -> dict[str, Any]:
        return {
            "type": "image_url",
            "image_url": {"url": _image_payload_url(path)},
            "frame_type": frame_type,
        }

    mode = (frame_mode or "").lower()
    if mode == "last":
        return [entry(images[0], "last_frame")]
    if mode == "firstlast" and len(images) >= 2:
        return [entry(images[0], "first_frame"), entry(images[1], "last_frame")]
    return [entry(images[0], "first_frame")]


def _build_body(prompt: str, model: str, params: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {"model": model, "prompt": prompt}
    images = [str(p) for p in (params.get("reference_images") or []) if p]
    frame_mode = str(params.get("frame_mode") or "auto").lower()
    if images:
        if frame_mode in ("first", "last", "firstlast"):
            body["frame_images"] = _frame_images(images, frame_mode)
        else:
            body["input_references"] = [
                {"type": "image_url", "image_url": {"url": _image_payload_url(u)}}
                for u in images
            ]
    if params.get("duration") is not None:
        body["duration"] = int(params["duration"])
    if params.get("resolution"):
        body["resolution"] = str(params["resolution"])
    ratio = params.get("ratio") or params.get("aspect_ratio")
    if ratio:
        body["aspect_ratio"] = str(ratio)
    if params.get("generate_audio") is not None:
        body["generate_audio"] = bool(params["generate_audio"])
    if params.get("seed") is not None and int(params["seed"]) >= 0:
        body["seed"] = int(params["seed"])
    return body


def _poll_job(
    *, polling_url: str, headers: dict, max_polls: int, poll_interval: float,
    task_ref: str = "", should_cancel: Callable[[], bool] | None = None,
) -> str:
    """轮询到终态返回下载地址。

    网络抖动 / 5xx 交给 video_poll 吞掉重试（不扣 max_polls）；终态只认 body 里的 status。
    此处失败一律带 job id —— OpenRouter 的产物挂在 {base}/videos/{id}/content，
    有 id 就还能手动取回。
    """
    ref = task_ref or polling_url
    for resp in video_poll.poll_responses(
        url=polling_url, headers=headers, timeout=180, max_polls=max_polls,
        poll_interval=poll_interval, task_ref=ref, error_cls=OpenRouterVideoError,
        should_cancel=should_cancel,
    ):
        payload = _json(resp)
        if not resp.ok:
            raise OpenRouterVideoError(
                video_poll.with_task_ref(_err(payload, resp.status_code), ref)
            )
        status = str(payload.get("status") or "").lower()
        if status == "completed":
            # unsigned_urls 是上游明确的产物位置，不刮整个 payload：输入参考图走
            # input_references / frame_images，回显进不了这里。
            urls = payload.get("unsigned_urls")
            if isinstance(urls, list) and urls and isinstance(urls[0], str):
                return urls[0]
            raise OpenRouterVideoError(
                video_poll.with_task_ref("视频任务成功但未返回下载地址", ref)
            )
        if status in _TERMINAL_FAILURE:
            raise OpenRouterVideoError(
                video_poll.with_task_ref(_err(payload, resp.status_code), ref)
            )
    raise OpenRouterVideoError(f"视频任务轮询超时: {ref}")


def _download_mp4(
    url: str, headers: dict, output_dir: Path, index: int, *, task_ref: str = ""
) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        # unsigned_urls 指向 {base}/videos/{id}/content，仍需 Bearer 鉴权。
        resp = requests.get(url, headers=headers, timeout=600)
        resp.raise_for_status()
    except requests.RequestException as e:
        # 任务已跑完并计费，只是产物没拉下来 —— 带上 job id 和源地址供人工找回。
        raise OpenRouterVideoError(
            video_poll.with_task_ref(f"下载上游视频失败（源地址 {url}）: {e}", task_ref)
        ) from e
    path = output_dir / f"v{index}.mp4"
    path.write_bytes(resp.content)
    return str(path)


def render_video(
    *,
    prompt: str,
    model: str,
    alias: str | None,
    output_dir: Path | str,
    params: dict[str, Any] | None = None,
    max_polls: int = 120,
    poll_interval: float = 15.0,
    on_phase: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    **_kwargs,
) -> list[str]:
    """提交 n 条 OpenRouter 视频任务（先全部提交再逐个轮询），下 .mp4，返回本地路径 list[str]。

    on_phase: 进度卡点回调 —— 全部提交成功后 "sent"、开始下载产物时 "downloading"。"""
    params = dict(params or {})
    key = _keys.find_by_alias(alias) if alias else None
    if key is None:
        raise OpenRouterVideoError(f"未找到 Key: {alias}")
    base = str(key.base_url or "").rstrip("/") or DEFAULT_BASE_URL
    headers = {
        "Authorization": f"Bearer {key.access_key}",
        "Content-Type": "application/json",
    }
    body = _build_body(prompt, model, params)

    n = max(1, min(4, int(params.get("n") or 1)))
    # (polling_url, job id)——id 是报错时唯一能拿去找回产物的标识，单独留着。
    jobs: list[tuple[str, str]] = []
    for _ in range(n):
        resp = requests.post(f"{base}/videos", headers=headers, json=body, timeout=600)
        payload = _json(resp)
        if not resp.ok:
            raise OpenRouterVideoError(_err(payload, resp.status_code))
        job_id = str(payload.get("id") or "")
        polling_url = payload.get("polling_url") or (f"{base}/videos/{job_id}" if job_id else None)
        if not polling_url:
            raise OpenRouterVideoError(f"OpenRouter 提交后未返回 job id: {payload!r}")
        jobs.append((str(polling_url), job_id))
    if on_phase:
        on_phase("sent")

    out_dir = Path(output_dir)
    ready_urls = [
        _poll_job(
            polling_url=u, headers=headers, max_polls=max_polls,
            poll_interval=poll_interval, task_ref=job_id,
            should_cancel=should_cancel,
        )
        for u, job_id in jobs
    ]
    if on_phase:
        on_phase("downloading")
    return [
        _download_mp4(url, headers, out_dir, i + 1, task_ref=jobs[i][1])
        for i, url in enumerate(ready_urls)
    ]
