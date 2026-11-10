"""EvoLink 视频 caller —— 可灵 Kling 3.0 / 3.0 Turbo / O3（3.0 Omni）/ 4.0 / 4.0 Flash。

契约源（各模型 OpenAPI）：https://evolink.ai/docs/en/api-manual/video-series/kling/<model>.json
- 统一提交 POST https://api.evolink.ai/v1/videos/generations，`model` 决定任务：
  EvoLink 把同一代模型按任务拆成 `<族>-text-to-video` / `-image-to-video` / `-reference-to-video`，
  画师只登记一个（通常是 text-to-video），这里按输入换成同族对应任务的 id。
- 查询 GET /v1/tasks/{id}：status pending / processing / completed / failed，产物在 results[]。
- 图片只收公网 URL：本地图走 EvoLink 自带文件上传（与 EvoLink 图片 caller 同一条路），
  参考视频不转存第三方，只收已有公网 URL。
"""
from __future__ import annotations

import math
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib.callers import evolink as _evo
from character_workflow.lib.callers import video_poll
from character_workflow.lib.callers.klingai_video import split_references
from character_workflow.lib.video_caps import KlingSpec, kling_spec

_TASK_SUFFIX = re.compile(r"-(?:text-to-video|image-to-video|reference-to-video|video-edit)$")


class EvoLinkVideoError(RuntimeError):
    pass


def family(model: str) -> str:
    """去掉任务后缀的模型族，如 kling-v4-flash-text-to-video → kling-v4-flash。"""
    return _TASK_SUFFIX.sub("", (model or "").strip().lower())


def build_request(prompt: str, model: str, params: dict[str, Any], key) -> tuple[KlingSpec, dict[str, Any]]:
    spec = kling_spec(model)
    if spec is None:
        raise EvoLinkVideoError(f"不是可灵 3.0 / 4.0 系模型: {model!r}")
    base = family(model)
    is_v4 = base.startswith("kling-v4")
    is_o3 = base.startswith("kling-o3")
    first, last, refs = split_references(params)
    videos = [str(v) for v in (params.get("reference_videos") or []) if v]
    if params.get("reference_audios"):
        raise EvoLinkVideoError(f"{spec.label} 不支持参考音频")
    if last and not first:
        raise EvoLinkVideoError(f"{spec.label} 不支持只设置尾帧，请先设置首帧")
    if last and spec.max_frames < 2:
        raise EvoLinkVideoError(f"{spec.label} 图生视频只支持首帧")
    # v4 / v4-flash 有 reference-to-video；O3 的参考图走 image-to-video 的 image_urls；v3 系没有。
    if (refs or videos) and not (is_v4 or is_o3):
        raise EvoLinkVideoError(f"{spec.label} 不支持全能参考，请改用首尾帧")
    if videos and (is_o3 or (first or last)):
        raise EvoLinkVideoError("EvoLink 的可灵参考视频不能与首尾帧或 O3 同时使用")
    if len(refs) > spec.max_images or len(videos) > spec.max_videos:
        raise EvoLinkVideoError(f"{spec.label} 最多参考 {spec.max_images} 张图、{spec.max_videos} 个视频")
    for video in videos:
        if not video.startswith(("http://", "https://")):
            raise EvoLinkVideoError("EvoLink 参考视频需要公网直链，本地视频请改用其他供应商")
    if is_v4 and (refs or videos) and first:
        raise EvoLinkVideoError(f"EvoLink 的 {spec.label} 参考图不能与首尾帧同时使用")

    if is_v4 and (refs or videos):
        task = "reference-to-video"
    elif first or refs:
        task = "image-to-video"
    else:
        task = "text-to-video"
    body: dict[str, Any] = {"model": f"{base}-{task}", "prompt": prompt}

    resolution = str(params.get("resolution") or "").lower()
    if resolution:
        if resolution not in spec.resolutions:
            raise EvoLinkVideoError(f"{spec.label} 不支持 {resolution}")
        body["quality"] = resolution
    if params.get("duration") is not None:
        duration = int(params["duration"])
        if not spec.min_duration <= duration <= spec.max_duration:
            raise EvoLinkVideoError(
                f"{spec.label} 时长必须在 {spec.min_duration}–{spec.max_duration} 秒之间"
            )
        body["duration"] = duration
    ratio = str(params.get("ratio") or params.get("aspect_ratio") or "")
    # v3 / v4 图生视频不收 aspect_ratio，比例随首帧；O3 图生收。
    if ratio and ratio != "adaptive" and (task != "image-to-video" or is_o3):
        if ratio not in spec.ratios:
            raise EvoLinkVideoError(f"{spec.label} 不支持画幅 {ratio}")
        body["aspect_ratio"] = ratio
    # 3.0 / O3 的 sound 默认 off，必须显式发；v4 路由传 sound 会 400，Turbo 无此字段。
    if spec.audio_toggle:
        body["sound"] = "on" if params.get("generate_audio") else "off"

    if first:
        body["image_start"] = _upload_image(first, key)
    if last:
        body["image_end"] = _upload_image(last, key)
    if refs:
        body["image_urls"] = [_upload_image(ref, key) for ref in refs]
    if videos:
        body["video_urls"] = [_public_url(video) for video in videos]
    return spec, body


def _public_url(value: str) -> str:
    try:
        return _evo._public_url(value)
    except _evo.EvoLinkError as error:
        raise EvoLinkVideoError(str(error)) from error


def _upload_image(value: str, key) -> str:
    try:
        return _evo._reference_url(str(value), key)
    except _evo.EvoLinkError as error:
        raise EvoLinkVideoError(str(error)) from error


def _video_results(payload: dict[str, Any], sent: set[str]) -> list[str]:
    results = payload.get("results")
    if not isinstance(results, list):
        results = [item.get("url") for item in (payload.get("result_data") or [])
                   if isinstance(item, dict)]
    return [url for url in results
            if isinstance(url, str) and url.startswith("http")
            and not video_poll.is_echoed_input(url, sent)]


def _sent(body: dict[str, Any]) -> set[str]:
    urls = [body.get("image_start"), body.get("image_end"),
            *(body.get("image_urls") or []), *(body.get("video_urls") or [])]
    return video_poll.sent_url_set([u for u in urls if isinstance(u, str)])


def _json(resp) -> dict[str, Any]:
    try:
        return _evo._json(resp)
    except _evo.EvoLinkError as error:
        raise EvoLinkVideoError(str(error)) from error


def _submit(root: str, key, body: dict[str, Any], attempt: int,
            on_submission: Callable[[dict[str, Any]], None] | None) -> str:
    """提交一次，不自动重试：网络断在半路时上游可能已经建单计费。"""
    url = f"{root}/v1/videos/generations"
    diagnostic: dict[str, Any] = {"attempt": attempt, "method": "POST", "url": url,
                                  "outcome": "submitting"}
    if on_submission:
        on_submission(dict(diagnostic))
    try:
        resp = requests.post(url, headers={"Authorization": f"Bearer {key.access_key}"},
                             json=body, timeout=(10, 120), allow_redirects=False)
    except requests.RequestException as error:
        diagnostic.update(outcome="unconfirmed", error_type=type(error).__name__)
        if on_submission:
            on_submission(dict(diagnostic))
        raise EvoLinkVideoError(
            "视频提交结果未确认：网络请求未完成，未自动重新提交。请先核对厂商记录，避免重复计费。"
        ) from error
    diagnostic.update(http_status=resp.status_code,
                      outcome="unconfirmed" if resp.status_code >= 500 else "response")
    if on_submission:
        on_submission(dict(diagnostic))
    if resp.status_code >= 500:
        raise EvoLinkVideoError(
            f"视频提交结果未确认：厂商接口返回 HTTP {resp.status_code}，未自动重新提交。"
            "请先核对厂商记录，避免重复计费。"
        )
    payload = _json(resp)
    if not resp.ok:
        raise EvoLinkVideoError(_evo._error(payload, resp.status_code, key.access_key))
    task_id = payload.get("id")
    if not isinstance(task_id, str) or not task_id:
        raise EvoLinkVideoError("视频提交结果未确认：未返回任务 ID，请先核对厂商记录。")
    return task_id


def _usd(payload: dict[str, Any]) -> float | None:
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    cost = usage.get("cost") if isinstance(usage.get("cost"), dict) else {}
    usd = cost.get("usd")
    if isinstance(usd, (int, float)) and math.isfinite(usd) and usd >= 0:
        return float(usd)
    return None


def _poll(*, root: str, key, task_id: str, max_polls: int, poll_interval: float,
          sent: set[str], should_cancel: Callable[[], bool] | None,
          ) -> tuple[list[str], float | None]:
    for resp in video_poll.poll_responses(
        url=f"{root}/v1/tasks/{quote(task_id, safe='')}",
        headers={"Authorization": f"Bearer {key.access_key}"}, timeout=60,
        max_polls=max_polls, poll_interval=poll_interval, task_ref=task_id,
        error_cls=EvoLinkVideoError, should_cancel=should_cancel,
    ):
        payload = _json(resp)
        if not resp.ok:
            raise EvoLinkVideoError(video_poll.with_task_ref(
                _evo._error(payload, resp.status_code, key.access_key), task_id))
        status = str(payload.get("status") or "").lower()
        if status == "failed":
            raise EvoLinkVideoError(video_poll.with_task_ref(
                _evo._error(payload, 200, key.access_key), task_id))
        if status == "completed":
            urls = _video_results(payload, sent)
            if not urls:
                raise EvoLinkVideoError(
                    video_poll.with_task_ref("EvoLink 任务成功但未返回视频地址", task_id))
            return urls, _usd(payload)
    raise EvoLinkVideoError(f"EvoLink 任务轮询超时: {task_id}")


def _download_mp4(url: str, output_dir: Path, index: int, *, task_ref: str) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        resp = requests.get(url, timeout=600)
        resp.raise_for_status()
    except requests.RequestException as e:
        # 任务已跑完并计费，只是产物没拉下来 —— 带上 task_id 和源地址供人工找回。
        raise EvoLinkVideoError(
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
    on_cost_usd: Callable[[float], None] | None = None,
    **_kwargs,
) -> list[str]:
    """提交 n 条 EvoLink 可灵任务（先全部提交再逐个轮询），下 .mp4，返回本地路径 list[str]。"""
    params = dict(params or {})
    key = _keys.find_by_alias(alias) if alias else None
    if key is None:
        raise EvoLinkVideoError(f"未找到 Key: {alias}")
    try:
        root = _evo._api_root(key)
    except _evo.EvoLinkError as error:
        raise EvoLinkVideoError(str(error)) from error
    _spec, body = build_request(prompt, model, params, key)
    sent = _sent(body)
    n = max(1, min(4, int(params.get("n") or 1)))

    task_ids: list[str] = []
    for index in range(n):
        if should_cancel and should_cancel():
            raise EvoLinkVideoError("生成已按请求停止")
        task_id = _submit(root, key, body, index + 1, on_submission)
        if on_task_id:
            on_task_id(task_id)
        task_ids.append(task_id)
    if on_phase:
        on_phase("sent")

    out_dir = Path(output_dir)
    paths: list[str] = []
    total_usd: float | None = None
    for task_id in task_ids:
        urls, usd = _poll(root=root, key=key, task_id=task_id, max_polls=max_polls,
                          poll_interval=poll_interval, sent=sent, should_cancel=should_cancel)
        if usd is not None:
            total_usd = (total_usd or 0.0) + usd
        if on_phase and not paths:
            on_phase("downloading")
        paths.append(_download_mp4(urls[0], out_dir, len(paths) + 1, task_ref=task_id))
    if on_cost_usd and total_usd is not None:
        on_cost_usd(total_usd)
    return paths
