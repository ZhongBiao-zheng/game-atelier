"""OpenAI-HK 聚合可灵（Kling）视频 caller。

走 HK 的 /kling/v1/videos/{text2video|image2video|omni-video} 异步任务通道：
POST 提交拿 data.task_id → GET 同路径/{task_id} 轮询 data.task_status →
succeed 后取 data.task_result.videos[].url，拉字节落 .mp4。
鉴权与 HK 其他端点一致：Authorization: Bearer <hk key>。
契约来源：https://www.openai-hk.com/docs/lab/kling.html

模型差异（同文档）：
- mode std/pro：v2-master 不支持（不发）；v2-6 固定 pro；其余取 params.mode 或 std。
- sound on/off：仅 v2-6（由 params.generate_audio 映射）。
- duration："5"/"10"（t2v/i2v 为字符串，omni-video 示例为数字）。
- kling-video-o1 走 omni-video 端点；image/image_tail 字段沿用 i2v 命名（待真机验证）。
"""
from __future__ import annotations

import base64
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib.callers import video_poll

_SUCCESS = {"SUCCEED", "SUCCEEDED", "SUCCESS"}
_FAILURE = {"FAILED", "FAIL", "ERROR", "CANCELED", "CANCELLED", "TIMEOUT", "REJECTED"}


class KlingVideoError(RuntimeError):
    pass


def _api_root(key) -> str:
    """HK key 的 base_url 通常是 https://api.openai-hk.com/v1（OpenAI 兼容路径）；
    kling 通道挂在站点根（/kling/v1/...），所以只取 scheme://host。"""
    raw = str(getattr(key, "base_url", None) or "")
    parts = urlsplit(raw)
    if not parts.scheme or not parts.netloc:
        raise KlingVideoError(f"无效的 base_url: {raw!r}")
    return f"{parts.scheme}://{parts.netloc}"


def _json(resp) -> dict[str, Any]:
    try:
        return resp.json()
    except Exception as e:  # noqa: BLE001
        raise KlingVideoError(f"上游响应非 JSON: {getattr(resp, 'text', '')[:300]}") from e


def _data(payload: dict[str, Any]) -> dict[str, Any]:
    data = payload.get("data")
    return data if isinstance(data, dict) else {}


def _err(payload: dict[str, Any], status_code: int) -> str:
    return str(
        payload.get("message")
        or _data(payload).get("task_status_msg")
        or payload.get("error")
        or f"可灵上游 HTTP {status_code}"
    )


def _image_payload(path_or_url: str) -> str:
    """可灵 image 字段收 URL 或裸 base64（不带 data: 前缀）；本地路径读字节编码。"""
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://")):
        return s
    if s.startswith("data:"):
        return s.split(",", 1)[-1]
    try:
        raw = Path(s).read_bytes()
    except OSError as e:
        raise KlingVideoError(f"读取参考图失败: {s}: {e}") from e
    return base64.b64encode(raw).decode()


def _is_o1(model: str) -> bool:
    return "o1" in model.lower()


def _mode(model: str, params: dict[str, Any]) -> str | None:
    m = model.lower()
    if "v2-master" in m:
        return None
    if "v2-6" in m:
        return "pro"
    requested = str(params.get("mode") or "").lower()
    return requested if requested in ("std", "pro") else "std"


def _frame_images(params: dict[str, Any]) -> tuple[str | None, str | None]:
    """按 frame_mode 把 reference_images 映射到 image / image_tail。"""
    refs = [str(r) for r in (params.get("reference_images") or []) if r]
    if not refs:
        return None, None
    frame_mode = str(params.get("frame_mode") or "auto").lower()
    if frame_mode == "last":
        return None, refs[0]
    if frame_mode == "firstlast" and len(refs) >= 2:
        return refs[0], refs[1]
    return refs[0], None


def _act_and_body(prompt: str, model: str, params: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    first, last = _frame_images(params)
    body: dict[str, Any] = {"model_name": model, "prompt": prompt}
    mode = _mode(model, params)
    if mode:
        body["mode"] = mode
    ratio = params.get("ratio") or params.get("aspect_ratio")
    if ratio:
        body["aspect_ratio"] = str(ratio)
    if params.get("cfg_scale") is not None:
        body["cfg_scale"] = float(params["cfg_scale"])
    duration = int(params.get("duration") or 5)
    if "v2-6" in model.lower():
        body["sound"] = "on" if params.get("generate_audio") else "off"

    if _is_o1(model):
        body["duration"] = duration  # omni-video 示例为数字
        if first:
            body["image"] = _image_payload(first)
        if last:
            body["image_tail"] = _image_payload(last)
        return "omni-video", body

    body["duration"] = str(duration)  # t2v/i2v 为字符串枚举 "5"/"10"
    if first or last:
        if first:
            body["image"] = _image_payload(first)
        if last:
            body["image_tail"] = _image_payload(last)
        return "image2video", body
    return "text2video", body


def _extract_task_id(payload: dict[str, Any]) -> str:
    v = _data(payload).get("task_id") or payload.get("task_id")
    return str(v) if v else ""


def _video_urls(payload: dict[str, Any], sent: set[str] | None = None) -> list[str]:
    """只认 data.task_result.videos[].url —— 上游明确的输出位置。

    这里不做「刮整个 payload」：可灵的输入图走 image / image_tail 字段，回显也进不了
    task_result.videos[]。sent 排除集仍然保留一道，防止上游把 http 输入图塞进输出数组。
    """
    result = _data(payload).get("task_result")
    videos = result.get("videos") if isinstance(result, dict) else None
    urls: list[str] = []
    for item in videos or []:
        url = item.get("url") if isinstance(item, dict) else None
        if isinstance(url, str) and url.startswith("http"):
            if video_poll.is_echoed_input(url, sent):
                continue
            urls.append(url)
    return urls


def _download_mp4(url: str, output_dir: Path, index: int, *, task_ref: str = "") -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        resp = requests.get(url, timeout=600)
        resp.raise_for_status()
    except requests.RequestException as e:
        # 任务已跑完并计费，只是产物没拉下来 —— 带上 task_id 和源地址供人工找回。
        raise KlingVideoError(
            video_poll.with_task_ref(f"下载上游视频失败（源地址 {url}）: {e}", task_ref)
        ) from e
    path = output_dir / f"v{index}.mp4"
    path.write_bytes(resp.content)
    return str(path)


def _poll_task(
    *, root: str, headers: dict[str, str], act: str, task_id: str,
    max_polls: int, poll_interval: float, sent_urls: set[str] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> list[str]:
    """轮询到终态，返回输出视频地址列表。

    网络抖动 / 5xx 交给 video_poll 吞掉重试（不扣 max_polls）；这里只解读 task_status。
    此处所有失败路径都对应一个已提交、已计费的任务，报错一律带 task_id。
    """
    url = f"{root}/kling/v1/videos/{act}/{task_id}"
    for resp in video_poll.poll_responses(
        url=url, headers=headers, timeout=180, max_polls=max_polls,
        poll_interval=poll_interval, task_ref=task_id, error_cls=KlingVideoError,
        should_cancel=should_cancel,
    ):
        payload = _json(resp)
        if not resp.ok:
            raise KlingVideoError(
                video_poll.with_task_ref(_err(payload, resp.status_code), task_id)
            )
        status = str(_data(payload).get("task_status") or "").strip().upper()
        if status in _SUCCESS:
            urls = _video_urls(payload, sent_urls)
            if urls:
                return urls
            raise KlingVideoError(
                video_poll.with_task_ref("可灵任务成功但未返回视频地址", task_id)
            )
        if status in _FAILURE:
            raise KlingVideoError(
                video_poll.with_task_ref(_err(payload, resp.status_code), task_id)
            )
    raise KlingVideoError(f"可灵任务轮询超时: {task_id}")


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
    should_cancel: Callable[[], bool] | None = None,
    **_kwargs,
) -> list[str]:
    """提交 n 条可灵视频任务（先全部提交再逐个轮询），下 .mp4，返回本地路径 list[str]。

    on_phase: 进度卡点回调 —— 全部提交成功后 "sent"、开始下载产物时 "downloading"。"""
    params = dict(params or {})
    key = _keys.find_by_alias(alias) if alias else None
    if key is None:
        raise KlingVideoError(f"未找到 Key: {alias}")
    root = _api_root(key)
    headers = {"Authorization": f"Bearer {key.access_key}", "Content-Type": "application/json"}
    act, body = _act_and_body(prompt, model, params)
    # image / image_tail 可能是公网直链（本地文件已被编成裸 base64，不进排除集）。
    sent_urls = video_poll.sent_url_set([
        str(body[k]) for k in ("image", "image_tail") if isinstance(body.get(k), str)
    ])
    n = max(1, min(4, int(params.get("n") or 1)))

    task_ids: list[str] = []
    for _ in range(n):
        resp = requests.post(f"{root}/kling/v1/videos/{act}", headers=headers, json=body, timeout=600)
        payload = _json(resp)
        if not resp.ok:
            raise KlingVideoError(_err(payload, resp.status_code))
        task_id = _extract_task_id(payload)
        if not task_id:
            raise KlingVideoError(f"可灵提交后未返回 task id: {payload!r}")
        task_ids.append(task_id)
    if on_phase:
        on_phase("sent")

    out_dir = Path(output_dir)
    paths: list[str] = []
    downloading = False
    for task_id in task_ids:
        for url in _poll_task(
            root=root, headers=headers, act=act, task_id=task_id,
            max_polls=max_polls, poll_interval=poll_interval, sent_urls=sent_urls,
            should_cancel=should_cancel,
        ):
            if on_phase and not downloading:
                downloading = True
                on_phase("downloading")
            paths.append(_download_mp4(url, out_dir, len(paths) + 1, task_ref=task_id))
    return paths
