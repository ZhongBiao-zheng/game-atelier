"""火山方舟 Ark 直连视频 caller（Seedance）。

不走聚合商通道——Seedance 是 Ark 直连：独立 base_url + Ark Bearer Key +
OpenAI-chat 式 content[] 数组带 role。提交 POST /contents/generations/tasks，
轮询 GET /contents/generations/tasks/{id}，输出 hosted url → 拉字节落 .mp4。
移植自 T8-penguin-canvas/backend/src/providers/volcengine.js。
"""
from __future__ import annotations

import base64
from collections.abc import Callable
from pathlib import Path
from typing import Any

import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib import oss_upload
from character_workflow.lib.callers import video_poll

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


def _tasks_url(base: str) -> str:
    """视频任务提交/轮询的根 URL。

    词元跳动网关把 Ark 视频任务挂在 {gateway}/ark/v3/generations/tasks（key 里存的
    base 是 OpenAI 兼容入口 …/gateway/v1，需剥掉 /v1）；Ark 直连维持
    {base}/contents/generations/tasks。
    """
    if "tokendance" in base:
        root = base[: -len("/v1")] if base.endswith("/v1") else base
        return f"{root}/ark/v3/generations/tasks"
    return f"{base}/contents/generations/tasks"


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
    if mode == "last" and index == 0:
        return "last_frame"
    return "reference_image"


def _image_payload_url(path_or_url: str) -> str:
    """本地路径 → base64 data-url；http(s)/data: 直通。

    reference_images 来自 Web 上传（/api/upload 返回本地绝对路径），Ark 服务端
    拉不到本机文件，必须内联——与 openai_image._image_data_url 同一模式。
    """
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://", "data:")):
        return s
    try:
        raw = Path(s).read_bytes()
    except OSError as e:
        raise VolcengineVideoError(f"读取参考图失败: {s}: {e}") from e
    ext = Path(s).suffix.lstrip(".").lower() or "png"
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def _video_payload_url(path_or_url: str) -> str:
    """参考视频只接受公网直链：上游显式拒 base64（reference_video must be a web url，
    2026-06-12 经 TokenDance 网关实测）。本地文件走 OSS 中转换成 presigned 直链。"""
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://")):
        return s
    try:
        return oss_upload.upload_for_url(s)
    except (oss_upload.OssNotConfiguredError, oss_upload.OssUploadError) as e:
        raise VolcengineVideoError(str(e)) from e


_AUDIO_MIME = {"mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4", "ogg": "audio/ogg"}
# 官方契约音频单段 ≤15MB；base64 膨胀 ~1.33x 后仍在 64MB 请求体帽内。
_AUDIO_INLINE_MAX_BYTES = 15 * 1024 * 1024


def _audio_payload_url(path_or_url: str) -> str:
    """本地音频 → base64 data-url；http(s)/data: 直通。

    与视频不同，audio_url 官方支持 base64（2026-06-12 经 TokenDance 网关实测通过）。
    """
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://", "data:")):
        return s
    try:
        raw = Path(s).read_bytes()
    except OSError as e:
        raise VolcengineVideoError(f"读取参考音频失败: {s}: {e}") from e
    if len(raw) > _AUDIO_INLINE_MAX_BYTES:
        raise VolcengineVideoError(f"参考音频超过官方单段 15MB 上限: {s}")
    ext = Path(s).suffix.lstrip(".").lower()
    mime = _AUDIO_MIME.get(ext, "audio/mpeg")
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def _build_content(prompt, images, videos, audios, frame_mode) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for i, url in enumerate(list(images)[:9]):
        content.append({
            "type": "image_url",
            "image_url": {"url": _image_payload_url(url)},
            "role": _frame_role(i, frame_mode),
        })
    for url in list(videos)[:3]:
        content.append({
            "type": "video_url",
            "video_url": {"url": _video_payload_url(url)},
            "role": "reference_video",
        })
    for url in list(audios)[:3]:
        content.append({
            "type": "audio_url",
            "audio_url": {"url": _audio_payload_url(url)},
            "role": "reference_audio",
        })
    return content


_PAYLOAD_URL_KEYS = ("image_url", "video_url", "audio_url")


def _sent_urls(content: list[dict[str, Any]]) -> set[str]:
    """本次请求实际发出去的公网 URL —— 收结果时要把它们从候选里剔掉。

    data: 内联的参考图不用管（不是 http，回显也不会被当成下载地址）；有杀伤力的是
    参考视频和 OSS 预签名直链：它们本身就是合法 .mp4。
    """
    return video_poll.sent_url_set([
        part[k]["url"]
        for part in content
        for k in _PAYLOAD_URL_KEYS
        if isinstance(part.get(k), dict) and isinstance(part[k].get("url"), str)
    ])


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
# 扩展名过滤只是第二道网——真正拦得住的是 sent 排除集，见下。
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".heic", ".heif", ".avif")


def _pick_video_url(urls: list[str], sent: set[str] | None = None) -> str | None:
    """从候选 url 里挑出真·输出视频地址。

    _CONTAINER_KEYS 里的 "content" 正是请求体里那个数组的键名，所以下钻时回显的输入
    会排在真输出前面被先抓到。光靠扩展名过滤挡不住视频参考场景：参考视频按契约必须是
    公网直链（见 _video_payload_url），剥掉 query 后就是 .mp4，过得了图片过滤——
    结果是 job 标 DONE、产物是用户自己的输入原片、全程零报错。所以先按「本次发出去的
    URL」硬排除，再走扩展名过滤兜底。

    排干净后没有候选就返回 None：让调用方按「成功但没拿到产物」报错，
    绝不退回原列表首个（那正好是回显的输入）。
    """
    fresh = [u for u in urls if not video_poll.is_echoed_input(u, sent)]
    return next(
        (u for u in fresh if not video_poll.strip_query(u).lower().endswith(_IMAGE_EXTS)),
        None,
    )


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


def _download_mp4(url: str, output_dir: Path, index: int, *, task_ref: str = "") -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        resp = requests.get(url, timeout=600)
        resp.raise_for_status()
    except requests.RequestException as e:
        # 走到这里任务已经跑完并计费了，只是产物没拉下来：带上 task_id 和源地址，
        # 让人工能去控制台把片子取回来，而不是重新出一遍。
        raise VolcengineVideoError(
            video_poll.with_task_ref(f"下载上游视频失败（源地址 {url}）: {e}", task_ref)
        ) from e
    path = output_dir / f"v{index}.mp4"
    path.write_bytes(resp.content)
    return str(path)


def _poll_video_task(*, tasks_url, headers, task_id, max_polls, poll_interval, sent_urls) -> str:
    """轮询到任务完成，返回选中的视频下载地址（不负责落盘）。

    网络抖动 / 5xx 由 video_poll 吞掉重试（不扣 max_polls），这里只解读上游给出的
    终态；一切在此处失败的路径都已经有一个在跑的计费任务，报错必须带 task_id。
    """
    url = f"{tasks_url}/{task_id}"
    for resp in video_poll.poll_responses(
        url=url, headers=headers, timeout=180, max_polls=max_polls,
        poll_interval=poll_interval, task_ref=task_id, error_cls=VolcengineVideoError,
    ):
        payload = _json(resp)
        if not resp.ok:
            raise VolcengineVideoError(
                video_poll.with_task_ref(_err(payload, resp.status_code), task_id)
            )
        status = _extract_status(payload)
        picked = _pick_video_url(_dedupe(_collect_video_urls(payload)), sent_urls)
        if status in _SUCCESS:
            if picked:
                return picked
            raise VolcengineVideoError(
                video_poll.with_task_ref("视频任务成功但未返回视频地址", task_id)
            )
        # 无 status 的响应只有在挑出「真输出」时才算完成：只回显了输入 URL 说明还没出片，
        # 继续等，不能拿输入原片交差。
        if not status and picked:
            return picked
        if status in _FAILURE:
            raise VolcengineVideoError(
                video_poll.with_task_ref(_fail_reason(payload), task_id)
            )
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
    on_phase: Callable[[str], None] | None = None,
    **_kwargs,
) -> list[str]:
    """提交 n 条 Seedance 视频任务（先全部提交再逐个轮询），下 .mp4，返回本地路径 list[str]。

    on_phase: 进度卡点回调 —— 全部提交成功后 "sent"、开始下载产物时 "downloading"。"""
    params = dict(params or {})
    key = _keys.find_by_alias(alias) if alias else None
    if key is None:
        raise VolcengineVideoError(f"未找到 Key: {alias}")
    tasks_url = _tasks_url(_base_url(key))
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
    # 上游默认 true（2.0 系）：关闭必须显式发 false，省略字段≠关闭。
    if params.get("generate_audio") is not None:
        body["generate_audio"] = bool(params["generate_audio"])

    out_dir = Path(output_dir)
    n = max(1, min(4, int(params.get("n") or 1)))
    sent_urls = _sent_urls(content)
    # 先把 n 条任务全部提交（上游并行跑），再逐个轮询取结果。
    # ready: (下载地址, task_id)——task_id 只为报错留痕，内联直出的那条没有。
    ready: list[tuple[str, str]] = []
    pending_ids: list[str] = []
    for _ in range(n):
        resp = requests.post(tasks_url, headers=headers, json=body, timeout=600)
        payload = _json(resp)
        if not resp.ok:
            raise VolcengineVideoError(_err(payload, resp.status_code))
        status = _extract_status(payload)
        if status in _FAILURE:
            raise VolcengineVideoError(_fail_reason(payload))
        # 提交响应里的 URL 更不能盲信：这里连 status 门都没有，回显的输入原片会被
        # 当成「同步直出」直接下载。只有在没被判失败、且挑出的不是回显输入时才认。
        picked = _pick_video_url(_dedupe(_collect_video_urls(payload)), sent_urls)
        if picked and (not status or status in _SUCCESS):
            ready.append((picked, ""))
            continue
        task_id = _extract_task_id(payload)
        if not task_id:
            raise VolcengineVideoError(f"火山视频提交后未返回 task id: {payload!r}")
        pending_ids.append(task_id)
    if on_phase:
        on_phase("sent")
    for task_id in pending_ids:
        ready.append((_poll_video_task(
            tasks_url=tasks_url, headers=headers, task_id=task_id,
            max_polls=max_polls, poll_interval=poll_interval, sent_urls=sent_urls,
        ), task_id))
    if on_phase:
        on_phase("downloading")
    return [
        _download_mp4(url, out_dir, i + 1, task_ref=task_id)
        for i, (url, task_id) in enumerate(ready)
    ]
