"""可灵新版接口视频 caller（词元跳动转发）—— Kling 3.0 / 3.0 Turbo / 3.0 Omni / 4.0 / 4.0 Flash。

与 kling_video.py（OpenAI-HK 的旧版 /kling/v1/videos/*：model_name/mode/image/image_tail）
完全不同的一套形状，契约源：
- 官方 https://klingai.com/document-api/api/video/4-0（及 4-0-flash / 3-0-omni / 3-0-turbo）
- 词元跳动 https://tokendance.space/docs/protocol-kling-{text2video,image2video,omni-video}{,-v2}.md

提交 POST {gateway}/kling/{v1|v2}/{text2video|image2video|omni-video}，
body = model_name + prompt（文生）或 contents[]（图生 / 全能参考）+ settings{}；
返回 data.id → GET 同路径/{id} 轮询 data[0].status（submitted/processing/succeeded/failed），
成功后视频在 data[0].outputs[type=video].url。4.x 走 v2 路径，3.x 走 v1。

兔子（Tuzi）用同一套 contents + settings，但挂在自家统一视频入口：POST {root}/v1/videos
（body 用 model，文生也放进 contents），GET /v1/videos/{id} 轮询 status
queued / in_progress / completed / failed，产物在 video_url。契约源
https://api.tu-zi.com/api/pricing 的 kling-4.0 描述 + https://api.tu-zi.com/docs/api/video.md。
"""
from __future__ import annotations

import base64
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib import oss_upload
from character_workflow.lib.callers import video_poll
from character_workflow.lib.video_caps import KlingSpec, kling_spec

_SUCCESS = {"SUCCEEDED", "SUCCEED", "SUCCESS", "COMPLETED"}
_FAILURE = {"FAILED", "FAIL", "ERROR", "CANCELED", "CANCELLED"}


class KlingaiVideoError(RuntimeError):
    pass


def _is_tuzi(key) -> bool:
    host = (urlsplit(str(getattr(key, "base_url", None) or "")).hostname or "").lower()
    return host == "tu-zi.com" or host.endswith(".tu-zi.com")


def _tuzi_root(key) -> str:
    parts = urlsplit(str(getattr(key, "base_url", None) or "").rstrip("/"))
    return f"{parts.scheme}://{parts.netloc}"


def _gateway_root(key) -> str:
    """key 里存的是 OpenAI 兼容入口 …/gateway/v1，可灵端点挂在 …/gateway/kling/。"""
    raw = str(getattr(key, "base_url", None) or "").rstrip("/")
    parts = urlsplit(raw)
    if not parts.scheme or not parts.netloc:
        raise KlingaiVideoError(f"无效的 base_url: {raw!r}")
    return raw[: -len("/v1")] if raw.endswith("/v1") else raw


def _json(resp) -> dict[str, Any]:
    try:
        payload = resp.json()
    except Exception as e:  # noqa: BLE001
        raise KlingaiVideoError(f"上游响应非 JSON: {getattr(resp, 'text', '')[:300]}") from e
    if not isinstance(payload, dict):
        raise KlingaiVideoError(f"上游响应格式异常: {str(payload)[:300]}")
    return payload


def _err(payload: dict[str, Any], status_code: int) -> str:
    err = payload.get("error")
    if isinstance(err, dict):
        err = err.get("message") or err.get("code")
    return str(err or payload.get("message") or f"可灵上游 HTTP {status_code}")


def _image_payload(path_or_url: str) -> str:
    """官方：图片 url 字段收 URL 或 base64；本地文件编成裸 base64（不带 data: 前缀）。"""
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://")):
        return s
    if s.startswith("data:"):
        return s.split(",", 1)[-1]
    try:
        raw = Path(s).read_bytes()
    except OSError as e:
        raise KlingaiVideoError(f"读取参考图失败: {s}: {e}") from e
    return base64.b64encode(raw).decode()


def _video_payload(path_or_url: str) -> str:
    """官方：参考视频只收 URL。本地文件走 OSS 中转换 presigned 直链（与 Seedance 同一条路）。"""
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://")):
        return s
    try:
        return oss_upload.upload_for_url(s)
    except (oss_upload.OssNotConfiguredError, oss_upload.OssUploadError) as e:
        raise KlingaiVideoError(str(e)) from e


def split_references(params: dict[str, Any]) -> tuple[str | None, str | None, list[str]]:
    """按 frame_mode 把 reference_images 拆成 (首帧, 尾帧, 其余参考图)。

    首尾帧模式（first/last/firstlast）占前一两张，多出来的当全能参考图；
    没有 frame_mode（全能参考模式 / 文生）时全部是参考图。
    """
    refs = [str(r) for r in (params.get("reference_images") or []) if r]
    mode = str(params.get("frame_mode") or "").lower()
    if mode == "first" and refs:
        return refs[0], None, refs[1:]
    if mode == "last" and refs:
        return None, refs[0], refs[1:]
    if mode == "firstlast" and len(refs) >= 2:
        return refs[0], refs[1], refs[2:]
    if mode == "firstlast" and refs:
        return refs[0], None, refs[1:]
    return None, None, refs


def build_request(prompt: str, model: str, params: dict[str, Any], *,
                  unified: bool = False) -> tuple[KlingSpec, str, dict[str, Any]]:
    """返回 (型号能力, 端点名, 请求体)。越界组合在这里当场拒绝，不发一个注定被拒的计费请求。"""
    spec = kling_spec(model)
    if spec is None:
        raise KlingaiVideoError(f"不是可灵 3.0 / 4.0 系模型: {model!r}")
    first, last, refs = split_references(params)
    videos = [str(v) for v in (params.get("reference_videos") or []) if v]
    if params.get("reference_audios"):
        raise KlingaiVideoError(f"{spec.label} 不支持参考音频")
    if last and not first:
        raise KlingaiVideoError(f"{spec.label} 不支持只设置尾帧，请先设置首帧")
    if last and spec.max_frames < 2:
        raise KlingaiVideoError(f"{spec.label} 图生视频只支持首帧")

    if "omni-video" in spec.endpoints and (refs or videos or spec.endpoints == ("omni-video",)):
        endpoint = "omni-video"
    elif refs or videos:
        raise KlingaiVideoError(f"{spec.label} 不支持全能参考，请改用首尾帧")
    elif first:
        endpoint = "image2video"
    else:
        endpoint = "text2video"
    if len(refs) > spec.max_images or len(videos) > spec.max_videos:
        raise KlingaiVideoError(
            f"{spec.label} 最多参考 {spec.max_images} 张图、{spec.max_videos} 个视频"
        )

    settings: dict[str, Any] = {}
    resolution = str(params.get("resolution") or "").lower()
    if resolution:
        if resolution not in spec.resolutions:
            raise KlingaiVideoError(f"{spec.label} 不支持 {resolution}")
        settings["resolution"] = resolution
    if params.get("duration") is not None:
        duration = int(params["duration"])
        if not spec.min_duration <= duration <= spec.max_duration:
            raise KlingaiVideoError(
                f"{spec.label} 时长必须在 {spec.min_duration}–{spec.max_duration} 秒之间"
            )
        settings["duration"] = duration
    ratio = str(params.get("ratio") or params.get("aspect_ratio") or "")
    # 图生视频的比例随首帧，官方 image-to-video 没有 aspect_ratio 字段。
    if ratio and endpoint != "image2video":
        if ratio not in spec.ratios and ratio != "adaptive":
            raise KlingaiVideoError(f"{spec.label} 不支持画幅 {ratio}")
        settings["aspect_ratio"] = ratio
    # 3.0 / 3.0 Omni 的 audio 默认 off：开关必须显式发；4.x 恒有声、Turbo 无此参数。
    if spec.audio_toggle:
        settings["audio"] = "native" if params.get("generate_audio") else "off"

    # unified = 兔子统一入口：模型字段叫 model，文生也走 contents。
    body: dict[str, Any] = {"model": model} if unified else {"model_name": model}
    if endpoint == "text2video" and not unified:
        body["prompt"] = prompt
    else:
        contents: list[dict[str, Any]] = [{"type": "prompt", "text": prompt}]
        if first:
            contents.append({"type": "first_frame", "url": _image_payload(first)})
        for i, ref in enumerate(refs, start=1):
            contents.append({"type": "refer_image", "url": _image_payload(ref), "id": f"image_{i}"})
        for i, video in enumerate(videos, start=1):
            contents.append({"type": "feature_video", "url": _video_payload(video), "id": f"video_{i}"})
        # 官方要求尾帧排在 contents 最后。
        if last:
            contents.append({"type": "last_frame", "url": _image_payload(last)})
        body["contents"] = contents
    if settings:
        body["settings"] = settings
    return spec, endpoint, body


def _sent_urls(body: dict[str, Any]) -> set[str]:
    return video_poll.sent_url_set([
        str(item["url"]) for item in body.get("contents") or []
        if isinstance(item, dict) and isinstance(item.get("url"), str)
    ])


def _task(payload: dict[str, Any]) -> dict[str, Any]:
    """轮询响应 data 是数组（官方 GET /tasks 批量查询形状），提交响应 data 是对象。"""
    data = payload.get("data")
    if isinstance(data, list):
        return data[0] if data and isinstance(data[0], dict) else {}
    if isinstance(data, dict):
        return data
    return payload  # 兔子统一入口：任务对象就在顶层


def _video_urls(task: dict[str, Any], sent: set[str]) -> list[str]:
    urls: list[str] = []
    direct = task.get("video_url")
    if isinstance(direct, str) and direct.startswith("http") and not video_poll.is_echoed_input(direct, sent):
        urls.append(direct)
    for item in task.get("outputs") or []:
        if not isinstance(item, dict) or item.get("type") != "video":
            continue
        url = item.get("url")
        if isinstance(url, str) and url.startswith("http") and not video_poll.is_echoed_input(url, sent):
            urls.append(url)
    return urls


def _submit(url: str, headers: dict[str, str], body: dict[str, Any], attempt: int,
            on_submission: Callable[[dict[str, Any]], None] | None) -> str:
    """提交一次，不自动重试：网络断在半路时上游可能已经建单计费。"""
    parsed = urlsplit(url)
    diagnostic: dict[str, Any] = {
        "attempt": attempt,
        "method": "POST",
        "url": urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", "")),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "outcome": "submitting",
    }
    if on_submission:
        on_submission(dict(diagnostic))
    try:
        resp = requests.post(url, headers=headers, json=body, timeout=600)
    except requests.RequestException as error:
        diagnostic.update(outcome="unconfirmed", error_type=type(error).__name__)
        if on_submission:
            on_submission(dict(diagnostic))
        raise KlingaiVideoError(
            "视频提交结果未确认：网络请求未完成，未自动重新提交。请先核对厂商记录，避免重复计费。"
        ) from error
    diagnostic["http_status"] = resp.status_code
    diagnostic["outcome"] = "unconfirmed" if resp.status_code >= 500 else "response"
    if on_submission:
        on_submission(dict(diagnostic))
    if resp.status_code >= 500:
        raise KlingaiVideoError(
            f"视频提交结果未确认：厂商接口返回 HTTP {resp.status_code}，未自动重新提交。"
            "请先核对厂商记录，避免重复计费。"
        )
    payload = _json(resp)
    if not resp.ok:
        raise KlingaiVideoError(f"视频提交被拒：HTTP {resp.status_code}；{_err(payload, resp.status_code)}")
    code = payload.get("code")
    if code not in (None, 0, "0"):
        raise KlingaiVideoError(f"视频提交被拒：{_err(payload, resp.status_code)}")
    task = _task(payload)
    task_id = task.get("id") or task.get("task_id")
    if not task_id:
        raise KlingaiVideoError("视频提交结果未确认：未返回任务 ID，请先核对厂商记录。")
    return str(task_id)


def _poll(*, url: str, headers: dict[str, str], task_id: str, max_polls: int,
          poll_interval: float, sent: set[str],
          should_cancel: Callable[[], bool] | None, content_fallback: bool = False) -> list[str]:
    for resp in video_poll.poll_responses(
        url=f"{url}/{task_id}", headers=headers, timeout=180, max_polls=max_polls,
        poll_interval=poll_interval, task_ref=task_id, error_cls=KlingaiVideoError,
        should_cancel=should_cancel,
    ):
        payload = _json(resp)
        if not resp.ok:
            raise KlingaiVideoError(
                video_poll.with_task_ref(_err(payload, resp.status_code), task_id)
            )
        task = _task(payload)
        status = str(task.get("status") or "").strip().upper()
        if status in _SUCCESS:
            urls = _video_urls(task, sent)
            if urls:
                return urls
            if content_fallback:
                # 兔子统一入口：completed 后也可从 /v1/videos/{id}/content 带鉴权取字节。
                return [f"{url}/{task_id}/content"]
            raise KlingaiVideoError(video_poll.with_task_ref("可灵任务成功但未返回视频地址", task_id))
        if status in _FAILURE:
            error = task.get("error")
            if isinstance(error, dict):
                error = error.get("message") or error.get("code")
            reason = str(task.get("message") or error or _err(payload, resp.status_code)
                         or "可灵视频任务失败")
            raise KlingaiVideoError(video_poll.with_task_ref(reason, task_id))
    raise KlingaiVideoError(f"可灵任务轮询超时: {task_id}")


def _download_mp4(url: str, output_dir: Path, index: int, *, task_ref: str,
                  headers: dict[str, str] | None = None) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        resp = requests.get(url, headers=headers, timeout=600)
        resp.raise_for_status()
    except requests.RequestException as e:
        # 任务已跑完并计费，只是产物没拉下来 —— 带上 task_id 和源地址供人工找回。
        raise KlingaiVideoError(
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
    """提交 n 条可灵任务（先全部提交再逐个轮询），下 .mp4，返回本地路径 list[str]。"""
    params = dict(params or {})
    key = _keys.find_by_alias(alias) if alias else None
    if key is None:
        raise KlingaiVideoError(f"未找到 Key: {alias}")
    tuzi = _is_tuzi(key)
    spec, endpoint, body = build_request(prompt, model, params, unified=tuzi)
    url = (f"{_tuzi_root(key)}/v1/videos" if tuzi
           else f"{_gateway_root(key)}/kling/{spec.endpoint_version}/{endpoint}")
    headers = {"Authorization": f"Bearer {key.access_key}", "Content-Type": "application/json"}
    sent = _sent_urls(body)
    n = max(1, min(4, int(params.get("n") or 1)))

    task_ids: list[str] = []
    for index in range(n):
        if should_cancel and should_cancel():
            raise KlingaiVideoError("生成已按请求停止")
        task_id = _submit(url, headers, body, index + 1, on_submission)
        if on_task_id:
            on_task_id(task_id)
        task_ids.append(task_id)
    if on_phase:
        on_phase("sent")

    out_dir = Path(output_dir)
    paths: list[str] = []
    downloading = False
    for task_id in task_ids:
        for video_url in _poll(url=url, headers=headers, task_id=task_id, max_polls=max_polls,
                               poll_interval=poll_interval, sent=sent, should_cancel=should_cancel,
                               content_fallback=tuzi):
            if on_phase and not downloading:
                downloading = True
                on_phase("downloading")
            # 只有回到本渠道自己的 content 端点才带鉴权，绝不把 key 发给第三方存储。
            auth = headers if video_url.startswith(f"{url}/") else None
            paths.append(_download_mp4(video_url, out_dir, len(paths) + 1, task_ref=task_id,
                                       headers=auth))
    return paths
