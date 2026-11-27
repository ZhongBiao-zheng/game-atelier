"""Vidu 视频 caller（兔子 /v1/videos 统一异步入口）—— Q4 Preview 与 Q3 全系 8 款型号。

契约源（2026-11-17 核验文档 + 2026-11-27 实测）：
- https://api.tu-zi.com/docs/api/video-viduq{4-preview,3-pro,3-pro-fast,3-turbo,3,3-drama,3-ad,3-mix}
- 入口：POST {root}/v1/videos（JSON，Authorization: Bearer <key>），模式由 metadata.action 指定
  （textGenerate / generate / firstTailGenerate / referenceGenerate）。
- 查询：GET {root}/v1/videos/{id}，status queued / in_progress → completed / failed；
  实测成片地址主要在 metadata.url（部分响应在顶层 video_url），缺失时兜底 /content。
- 图片：支持公网 URL 或 data:image/<mime>;base64,...（2026-11-27 实测 Q4 与 Q3 Pro 均直通）。
- 音频（Q4 Preview / Q3 Drama）：sounds[] 收 0–3 段 MP3，优先经 OSS 转公网 URL，未配置 OSS 时内联 base64。
"""
from __future__ import annotations

import base64
import mimetypes
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib import oss_upload
from character_workflow.lib.callers import task_submission, video_poll
from character_workflow.lib.callers.klingai_video import split_references
from character_workflow.lib.video_caps import ViduSpec, vidu_spec

_SUCCESS = {"SUCCEEDED", "SUCCEED", "SUCCESS", "COMPLETED"}
_FAILURE = {"FAILED", "FAIL", "ERROR", "CANCELED", "CANCELLED"}
_IMAGE_MIMES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


class ViduVideoError(RuntimeError):
    pass


class ViduVideoUnconfirmed(ViduVideoError, task_submission.SubmissionUnconfirmed):
    """提交可能已被上游受理（见 task_submission）：不重发、不换家。"""


def _api_root(key) -> str:
    raw = str(getattr(key, "base_url", None) or "").rstrip("/")
    parts = urlsplit(raw)
    if not parts.scheme or not parts.netloc:
        raise ViduVideoError(f"无效的 base_url: {raw!r}")
    return f"{parts.scheme}://{parts.netloc}"


def _json(resp) -> dict[str, Any]:
    try:
        payload = resp.json()
    except Exception as e:  # noqa: BLE001
        raise ViduVideoError(f"上游响应非 JSON: {getattr(resp, 'text', '')[:300]}") from e
    if not isinstance(payload, dict):
        raise ViduVideoError(f"上游响应格式异常: {str(payload)[:300]}")
    return payload


def _err(payload: dict[str, Any], status_code: int) -> str:
    err = payload.get("error")
    if isinstance(err, dict):
        err = err.get("message") or err.get("code")
    return str(err or payload.get("message") or f"Vidu 上游 HTTP {status_code}")


def _image_payload(path_or_url: str) -> str:
    """图片字段收公开 URL 或带 MIME 前缀的 data URI（PNG/JPEG/WebP）。"""
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://", "data:")):
        return s
    path = Path(s)
    try:
        raw = path.read_bytes()
    except OSError as e:
        raise ViduVideoError(f"读取参考图失败: {s}: {e}") from e
    mime = _IMAGE_MIMES.get(path.suffix.lower()) or mimetypes.guess_type(s)[0] or "image/png"
    if mime not in {"image/png", "image/jpeg", "image/webp"}:
        mime = "image/png"
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def _audio_payload(path_or_url: str) -> str:
    """参考音频优先经 OSS 换公开 MP3 URL（避免 data URI MIME 歧义），未配 OSS 时回退 base64。"""
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://", "data:")):
        return s
    try:
        return oss_upload.upload_for_url(s)
    except oss_upload.OssNotConfiguredError:
        pass
    except oss_upload.OssUploadError as e:
        raise ViduVideoError(str(e)) from e
    try:
        raw = Path(s).read_bytes()
    except OSError as e:
        raise ViduVideoError(f"读取参考音频失败: {s}: {e}") from e
    return f"data:audio/mpeg;base64,{base64.b64encode(raw).decode('ascii')}"


def _normalize_resolution(value: str, spec: ViduSpec) -> str:
    lowered = value.strip().lower()
    for candidate in spec.resolutions:
        if candidate.lower() == lowered:
            return candidate
    raise ViduVideoError(f"{spec.label} 不支持分辨率 {value}")


def build_request(prompt: str, model: str, params: dict[str, Any]) -> tuple[ViduSpec, str, dict[str, Any]]:
    """构造 Tuzi /v1/videos 请求体，越界组合当场拒绝，不发注定失败的计费请求。"""
    spec = vidu_spec(model)
    if spec is None:
        raise ViduVideoError(f"不是已支持的 Vidu 模型: {model!r}")
    prompt_text = (prompt or "").strip()
    if not prompt_text:
        raise ViduVideoError(f"{spec.label} 需要非空提示词")

    first, last, refs = split_references(params)
    videos = [str(v) for v in (params.get("reference_videos") or []) if v]
    audios = [str(a) for a in (params.get("reference_audios") or []) if a]
    if videos:
        raise ViduVideoError(f"{spec.label} 不支持参考视频")
    if audios and spec.max_audios <= 0:
        raise ViduVideoError(f"{spec.label} 不支持参考音频")
    if last and not first:
        raise ViduVideoError(f"{spec.label} 不支持只设置尾帧，请先设置首帧")

    images_in: list[str] = []
    if spec.actions == ("referenceGenerate",):
        action = "referenceGenerate"
        all_refs = [x for x in (first, last, *refs) if x]
        if not all_refs:
            raise ViduVideoError(f"{spec.label} 至少需要 1 张参考图")
        if len(all_refs) > spec.max_images:
            raise ViduVideoError(f"{spec.label} 最多参考 {spec.max_images} 张图")
        images_in = all_refs
    elif refs or audios:
        if "referenceGenerate" not in spec.actions:
            raise ViduVideoError(f"{spec.label} 不支持图片参考模式，请改用首尾帧")
        if first or last:
            raise ViduVideoError(f"{spec.label} 图片参考模式不能与首尾帧同时使用")
        if not refs:
            raise ViduVideoError(f"{spec.label} 图片参考模式至少需要 1 张参考图")
        if len(refs) > spec.max_images:
            raise ViduVideoError(f"{spec.label} 最多参考 {spec.max_images} 张图")
        action = "referenceGenerate"
        images_in = refs
    elif first and last:
        if "firstTailGenerate" not in spec.actions:
            raise ViduVideoError(f"{spec.label} 不支持首尾帧模式")
        action = "firstTailGenerate"
        images_in = [first, last]
    elif first:
        if "generate" not in spec.actions:
            raise ViduVideoError(f"{spec.label} 不支持图生视频模式")
        action = "generate"
        images_in = [first]
    else:
        if "textGenerate" not in spec.actions:
            raise ViduVideoError(f"{spec.label} 不支持纯文生视频，请至少提供 1 张首帧图或参考图")
        action = "textGenerate"

    if audios and len(audios) > spec.max_audios:
        raise ViduVideoError(f"{spec.label} 最多参考 {spec.max_audios} 段音频")
    if audios and action != "referenceGenerate":
        raise ViduVideoError(f"{spec.label} 仅图片参考模式支持参考音频")

    min_dur, max_dur = (
        spec.ref_duration_range
        if action == "referenceGenerate" and spec.ref_duration_range is not None
        else (spec.min_duration, spec.max_duration)
    )
    metadata: dict[str, Any] = {"action": action}
    body: dict[str, Any] = {"model": model, "prompt": prompt_text, "metadata": metadata}

    if params.get("duration") is not None:
        duration = int(params["duration"])
        if not min_dur <= duration <= max_dur:
            raise ViduVideoError(f"{spec.label} 当前模式时长必须在 {min_dur}–{max_dur} 秒之间")
        body["duration"] = duration
        metadata["duration"] = duration

    raw_resolution = str(params.get("resolution") or "").strip()
    if raw_resolution:
        resolution = _normalize_resolution(raw_resolution, spec)
        body["resolution"] = resolution
        metadata["resolution"] = resolution

    ratio = str(params.get("ratio") or params.get("aspect_ratio") or "").strip()
    if ratio and action in {"textGenerate", "referenceGenerate"}:
        if ratio in {"adaptive", "auto"}:
            if action == "referenceGenerate" and spec.ref_supports_auto_ratio:
                body["aspect_ratio"] = "auto"
        elif ratio in spec.ratios:
            body["aspect_ratio"] = ratio
        else:
            raise ViduVideoError(f"{spec.label} 不支持画幅 {ratio}")

    # Q3 Turbo 的图片参考模式官方文档无 audio 开关，省略不发。
    audio_enabled = spec.audio_toggle and not (
        action == "referenceGenerate" and not spec.ref_audio_toggle
    )
    if audio_enabled:
        body["audio"] = bool(params.get("generate_audio"))

    # 水印默认值在官方多处文档存在矛盾，始终显式发送。
    body["watermark"] = bool(params.get("watermark"))

    seed = params.get("seed")
    if seed is not None and int(seed) >= 0:
        body["seed"] = int(seed)

    if images_in:
        body["images"] = [_image_payload(item) for item in images_in]
    if audios:
        body["sounds"] = [_audio_payload(item) for item in audios]
    return spec, action, body


def _sent_urls(body: dict[str, Any]) -> set[str]:
    urls = [
        item for item in (*(body.get("images") or []), *(body.get("sounds") or []))
        if isinstance(item, str) and item.startswith(("http://", "https://"))
    ]
    return video_poll.sent_url_set(urls)


def _video_urls(task: dict[str, Any], sent: set[str]) -> list[str]:
    urls: list[str] = []
    meta = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    for candidate in (task.get("video_url"), meta.get("url")):
        if (isinstance(candidate, str) and candidate.startswith("http")
                and not video_poll.is_echoed_input(candidate, sent)
                and candidate not in urls):
            urls.append(candidate)
    for item in task.get("outputs") or []:
        if not isinstance(item, dict) or item.get("type") != "video":
            continue
        url = item.get("url")
        if (isinstance(url, str) and url.startswith("http")
                and not video_poll.is_echoed_input(url, sent)
                and url not in urls):
            urls.append(url)
    return urls


def _submit(url: str, headers: dict[str, str], body: dict[str, Any], attempt: int,
            on_submission: Callable[[dict[str, Any]], None] | None) -> str:
    submitted = task_submission.submit_task(
        url=url, headers=headers, body=body, attempt=attempt, on_submission=on_submission,
        rejected=ViduVideoError, unconfirmed=ViduVideoUnconfirmed,
        reject_message=lambda payload, status: f"视频提交被拒：HTTP {status}；{_err(payload, status)}",
    )
    payload = submitted.payload
    code = payload.get("code")
    if code not in (None, 0, "0"):
        raise ViduVideoError(f"视频提交被拒：{_err(payload, submitted.status)}")
    task_id = payload.get("id") or payload.get("task_id")
    if not task_id and isinstance(payload.get("data"), dict):
        task_id = payload["data"].get("id") or payload["data"].get("task_id")
    if not task_id:
        raise submitted.unconfirmed(task_submission.MISSING_ID_UNCONFIRMED.format(noun="视频"))
    return str(task_id)


def _poll(*, url: str, headers: dict[str, str], task_id: str, max_polls: int,
          poll_interval: float, sent: set[str],
          should_cancel: Callable[[], bool] | None) -> list[str]:
    for resp in video_poll.poll_responses(
        url=f"{url}/{task_id}", headers=headers, timeout=180, max_polls=max_polls,
        poll_interval=poll_interval, task_ref=task_id, error_cls=ViduVideoError,
        should_cancel=should_cancel,
    ):
        payload = _json(resp)
        if not resp.ok:
            raise ViduVideoError(
                video_poll.with_task_ref(_err(payload, resp.status_code), task_id)
            )
        status = str(payload.get("status") or "").strip().upper()
        if status in _SUCCESS:
            urls = _video_urls(payload, sent)
            if urls:
                return urls
            return [f"{url}/{task_id}/content"]
        if status in _FAILURE:
            error = payload.get("error")
            if isinstance(error, dict):
                error = error.get("message") or error.get("code")
            reason = str(payload.get("message") or error or _err(payload, resp.status_code)
                         or "Vidu 视频任务失败")
            raise ViduVideoError(video_poll.with_task_ref(reason, task_id))
    raise ViduVideoError(f"Vidu 任务轮询超时: {task_id}")


def _download_mp4(url: str, output_dir: Path, index: int, *, task_ref: str,
                  headers: dict[str, str] | None = None) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        resp = requests.get(url, headers=headers, timeout=600)
        resp.raise_for_status()
    except requests.RequestException as e:
        raise ViduVideoError(
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
    max_polls: int = 240,
    poll_interval: float = 5.0,
    on_phase: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    on_task_id: Callable[[str], None] | None = None,
    on_submission: Callable[[dict[str, Any]], None] | None = None,
    **_kwargs,
) -> list[str]:
    """提交 n 条 Vidu 视频任务并轮询下载 .mp4，返回本地路径 list[str]。"""
    params = dict(params or {})
    key = _keys.find_by_alias(alias) if alias else None
    if key is None:
        raise ViduVideoError(f"未找到 Key: {alias}")
    headers = {"Authorization": f"Bearer {key.access_key}", "Content-Type": "application/json"}
    resume = _kwargs.get("resume_video")
    report = _kwargs.get("on_resume_state")
    task_ids: list[str] = []
    if resume:
        url = str(resume["url"])
        sent = set(resume.get("sent") or [])
        task_ids = [str(item["id"]) for item in resume.get("tasks") or []]
    else:
        _spec, _action, body = build_request(prompt, model, params)
        url = f"{_api_root(key)}/v1/videos"
        sent = _sent_urls(body)
        n = max(1, min(4, int(params.get("n") or 1)))
        for index in range(n):
            if should_cancel and should_cancel():
                raise ViduVideoError("生成已按请求停止")
            task_id = _submit(url, headers, body, index + 1, on_submission)
            if on_task_id:
                on_task_id(task_id)
            task_ids.append(task_id)
            if report:
                report({"tasks": [{"id": item} for item in task_ids], "url": url,
                        "sent": sorted(sent)})
    if on_phase:
        on_phase("sent")

    out_dir = Path(output_dir)
    paths: list[str] = []
    downloading = False
    for task_id in task_ids:
        for video_url in _poll(url=url, headers=headers, task_id=task_id, max_polls=max_polls,
                               poll_interval=poll_interval, sent=sent, should_cancel=should_cancel):
            if on_phase and not downloading:
                downloading = True
                on_phase("downloading")
            auth = headers if video_url.startswith(f"{url}/") else None
            paths.append(_download_mp4(video_url, out_dir, len(paths) + 1, task_ref=task_id,
                                       headers=auth))
    return paths
