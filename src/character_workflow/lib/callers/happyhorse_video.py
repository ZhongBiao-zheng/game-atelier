"""阿里百炼 HappyHorse 视频 caller（DashScope 异步任务通道）。

契约源 help.aliyun.com/zh/model-studio/happyhorse-api-reference（细节见
docs/references/provider-config.md「视频契约 — HappyHorse」）：
POST video-synthesis（Header 必带 X-DashScope-Async: enable）拿 output.task_id
→ GET tasks/{id} 轮询 output.task_status → SUCCEEDED 取 video_url 落 .mp4。

四模式 = 四个模型 id（按后缀分发请求体）：
- happyhorse-1.0-t2v        文生，无 media
- happyhorse-1.0-i2v        图生首帧，media: first_frame ×1，无 ratio（随首帧）
- happyhorse-1.0-r2v        全能参考，media: reference_image ×1-9
- happyhorse-1.0-video-edit 视频编辑，media: video ×1（仅公网 URL）+ reference_image ×0-5，
                            无 duration / ratio（随输入视频）

注意：官方 watermark 默认 true（右下角 "Happy Horse" 文案），本 caller 恒显式发 false。
TokenDance 网关 quickstart 的请求体字段与阿里官方不一致（img_url/size vs media[]/resolution），
此处按官方契约实现，网关实际接受哪套待充值实测（provider-config.md「TokenDance 转发坑」）。
"""
from __future__ import annotations

import base64
from collections.abc import Callable
from pathlib import Path
from typing import Any

import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib.callers import video_poll

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1"

_SUCCESS = {"SUCCEEDED", "SUCCEED", "SUCCESS"}
# UNKNOWN = 任务不存在/已过期（task_id 仅 24h），继续轮询无意义，按失败处理。
_FAILURE = {"FAILED", "FAIL", "ERROR", "CANCELED", "CANCELLED", "UNKNOWN"}


class HappyHorseVideoError(RuntimeError):
    pass


def _base_url(key) -> str:
    return str(getattr(key, "base_url", None) or "").rstrip("/") or DEFAULT_BASE_URL


def _api_root(base: str) -> str:
    """词元跳动网关把 HappyHorse 挂在 {gateway}/alibaba/happyhorse/v1（key 里存的
    base 是 OpenAI 兼容入口 …/gateway/v1，需剥掉 /v1）；百炼直连维持 base 原样。"""
    if "tokendance" in base:
        root = base[: -len("/v1")] if base.endswith("/v1") else base
        return f"{root}/alibaba/happyhorse/v1"
    return base


def _synthesis_url(base: str) -> str:
    root = _api_root(base)
    if "tokendance" in base:
        return f"{root}/video-synthesis"
    return f"{root}/services/aigc/video-generation/video-synthesis"


def _task_url(base: str, task_id: str) -> str:
    return f"{_api_root(base)}/tasks/{task_id}"


def _json(resp) -> dict[str, Any]:
    try:
        return resp.json()
    except Exception as e:  # noqa: BLE001
        raise HappyHorseVideoError(f"上游响应非 JSON: {getattr(resp, 'text', '')[:300]}") from e


def _output(payload: dict[str, Any]) -> dict[str, Any]:
    out = payload.get("output")
    return out if isinstance(out, dict) else {}


def _err(payload: dict[str, Any], status_code: int) -> str:
    return str(
        _output(payload).get("message")
        or payload.get("message")
        or payload.get("code")
        or f"HappyHorse 上游 HTTP {status_code}"
    )


def _image_payload_url(path_or_url: str) -> str:
    """本地路径 → base64 data-url（官方首帧/参考图均收 URL 或 base64）；http(s)/data: 直通。"""
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://", "data:")):
        return s
    try:
        raw = Path(s).read_bytes()
    except OSError as e:
        raise HappyHorseVideoError(f"读取参考图失败: {s}: {e}") from e
    ext = Path(s).suffix.lstrip(".").lower() or "png"
    mime = "image/jpeg" if ext in ("jpg", "jpeg") else f"image/{ext}"
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def _video_payload_url(path_or_url: str) -> str:
    """官方限制输入视频仅公网 URL，本地文件显式报错（与 volcengine_video 同策略）。"""
    s = str(path_or_url).strip()
    if s.startswith(("http://", "https://")):
        return s
    raise HappyHorseVideoError(f"HappyHorse 输入视频仅支持公网 http(s) 直链: {s}")


def _mode(model: str) -> str:
    m = (model or "").lower()
    if "video-edit" in m:
        return "edit"
    if "r2v" in m:
        return "r2v"
    if "i2v" in m:
        return "i2v"
    return "t2v"


def _build_body(prompt: str, model: str, params: dict[str, Any]) -> dict[str, Any]:
    mode = _mode(model)
    images = [str(p) for p in (params.get("reference_images") or []) if p]
    videos = [str(p) for p in (params.get("reference_videos") or []) if p]

    media: list[dict[str, str]] = []
    if mode == "i2v":
        if not images:
            raise HappyHorseVideoError("happyhorse i2v 需要 1 张首帧图")
        media.append({"type": "first_frame", "url": _image_payload_url(images[0])})
    elif mode == "r2v":
        if not images:
            raise HappyHorseVideoError("happyhorse r2v 需要 1-9 张参考图")
        media.extend(
            {"type": "reference_image", "url": _image_payload_url(u)} for u in images[:9]
        )
    elif mode == "edit":
        if not videos:
            raise HappyHorseVideoError("happyhorse video-edit 需要 1 个输入视频")
        media.append({"type": "video", "url": _video_payload_url(videos[0])})
        media.extend(
            {"type": "reference_image", "url": _image_payload_url(u)} for u in images[:5]
        )

    inp: dict[str, Any] = {"prompt": prompt}
    if media:
        inp["media"] = media

    # 官方 watermark 默认 true（"Happy Horse" 角标）；产品默认关，但允许节点显式开启。
    parameters: dict[str, Any] = {"watermark": bool(params.get("watermark", False))}
    if params.get("resolution"):
        parameters["resolution"] = str(params["resolution"]).upper()  # 官方要求大写 P
    if mode in ("t2v", "r2v") and params.get("ratio"):
        parameters["ratio"] = str(params["ratio"])
    if mode != "edit" and params.get("duration") is not None:
        parameters["duration"] = int(params["duration"])
    if params.get("seed") is not None and int(params["seed"]) >= 0:
        parameters["seed"] = int(params["seed"])

    return {"model": model, "input": inp, "parameters": parameters}


def _extract_task_id(payload: dict[str, Any]) -> str:
    for src in (_output(payload), payload):
        v = src.get("task_id") or src.get("taskId")
        if isinstance(v, str) and v:
            return v
    return ""


def _extract_status(payload: dict[str, Any]) -> str:
    s = _output(payload).get("task_status") or payload.get("task_status") or ""
    return str(s).strip().upper()


_OUTPUT_URL_KEYS = ("video_url", "videoUrl", "url")


def _extract_video_url(payload: dict[str, Any], sent: set[str] | None = None) -> str | None:
    """只认 output 下的产物位置，再按「本次发出去的 URL」排除回显。

    原先还会兜底扫 payload 顶层的 url —— video-edit 模式发出去的输入视频按契约必须是
    公网直链，一旦上游把它回显到顶层就会被当成产物下载：is_valid_video 当然过得了
    （它本来就是合法 mp4），job 标 DONE，交付的是用户自己的输入原片，全程零报错。
    DashScope 契约把产物固定放在 output 下，顶层兜底除了制造这个坑没有别的用处。
    """
    out = _output(payload)
    results = out.get("results")
    sources: list[dict[str, Any]] = [out]
    if isinstance(results, dict):
        sources.append(results)
    elif isinstance(results, list):
        sources.extend(item for item in results if isinstance(item, dict))
    for src in sources:
        for k in _OUTPUT_URL_KEYS:
            v = src.get(k)
            if isinstance(v, str) and v.startswith("http") and not video_poll.is_echoed_input(v, sent):
                return v
    return None


def _download_mp4(url: str, output_dir: Path, index: int, *, task_ref: str = "") -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        resp = requests.get(url, timeout=600)
        resp.raise_for_status()
    except requests.RequestException as e:
        # 任务已跑完并计费，只是产物没拉下来 —— 带上 task_id 和源地址供人工找回。
        raise HappyHorseVideoError(
            video_poll.with_task_ref(f"下载上游视频失败（源地址 {url}）: {e}", task_ref)
        ) from e
    path = output_dir / f"v{index}.mp4"
    path.write_bytes(resp.content)
    return str(path)


def _poll_task(
    *, base, headers, task_id, max_polls, poll_interval, sent_urls=None, should_cancel=None
) -> str:
    """轮询到终态返回产物地址。

    网络抖动 / 5xx 交给 video_poll 吞掉重试（不扣 max_polls）；终态只认 output.task_status。
    此处失败一律带 task_id —— 但注意 task_id 仅 24h 有效，过期后 UNKNOWN 就再也查不回来。
    """
    url = _task_url(base, task_id)
    for resp in video_poll.poll_responses(
        url=url, headers=headers, timeout=180, max_polls=max_polls,
        poll_interval=poll_interval, task_ref=task_id, error_cls=HappyHorseVideoError,
        should_cancel=should_cancel,
    ):
        payload = _json(resp)
        if not resp.ok:
            raise HappyHorseVideoError(
                video_poll.with_task_ref(_err(payload, resp.status_code), task_id)
            )
        status = _extract_status(payload)
        if status in _SUCCESS:
            picked = _extract_video_url(payload, sent_urls)
            if picked:
                return picked
            raise HappyHorseVideoError(
                video_poll.with_task_ref("视频任务成功但未返回视频地址", task_id)
            )
        if status in _FAILURE:
            raise HappyHorseVideoError(
                video_poll.with_task_ref(_err(payload, resp.status_code), task_id)
            )
    raise HappyHorseVideoError(f"视频任务轮询超时: {task_id}")


def render_video(
    *,
    prompt: str,
    model: str,
    alias: str | None,
    output_dir: Path | str,
    params: dict[str, Any] | None = None,
    max_polls: int = 120,
    poll_interval: float = 15.0,  # 官方建议 15s 轮询（查询 RPS 上限 20）
    on_phase: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    **_kwargs,
) -> list[str]:
    """提交 n 条 HappyHorse 视频任务（先全部提交再逐个轮询），下 .mp4，返回本地路径 list[str]。

    on_phase: 进度卡点回调 —— 全部提交成功后 "sent"、开始下载产物时 "downloading"。"""
    params = dict(params or {})
    key = _keys.find_by_alias(alias) if alias else None
    if key is None:
        raise HappyHorseVideoError(f"未找到 Key: {alias}")
    base = _base_url(key)
    headers = {
        "Authorization": f"Bearer {key.access_key}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",  # 缺了直接报错（官方硬要求）
    }
    body = _build_body(prompt, model, params)
    # video-edit 的输入视频只能是公网直链，最容易被回显成「产物」；参考图若也是直链一并排除。
    sent_urls = video_poll.sent_url_set([
        str(m.get("url") or "") for m in (body.get("input", {}).get("media") or [])
    ])
    submit_url = _synthesis_url(base)

    n = max(1, min(4, int(params.get("n") or 1)))
    task_ids: list[str] = []
    for _ in range(n):
        resp = requests.post(submit_url, headers=headers, json=body, timeout=600)
        payload = _json(resp)
        if not resp.ok:
            raise HappyHorseVideoError(_err(payload, resp.status_code))
        task_id = _extract_task_id(payload)
        if not task_id:
            raise HappyHorseVideoError(f"HappyHorse 提交后未返回 task id: {payload!r}")
        task_ids.append(task_id)
    if on_phase:
        on_phase("sent")

    out_dir = Path(output_dir)
    ready_urls = [
        _poll_task(base=base, headers=headers, task_id=t,
                   max_polls=max_polls, poll_interval=poll_interval, sent_urls=sent_urls,
                   should_cancel=should_cancel)
        for t in task_ids
    ]
    if on_phase:
        on_phase("downloading")
    return [
        _download_mp4(url, out_dir, i + 1, task_ref=task_ids[i])
        for i, url in enumerate(ready_urls)
    ]
