"""音潮歌曲生成（异步：提交 → 轮询 → 下载）。

契约：词元跳动转发 `tokendance.space/docs/protocol-yinchao-song.md`，官方
`platform.yinchaoyongxian.com/docs/guides/prompt-generate`、`instrumental-generate`。
- 提交：`POST {base}/song/generate`（task_type=normal，prompt，可选 lyric，n≤2）
  或 `POST {base}/song/instrumental`（纯音乐，prompt，n）；响应 `id` 是任务号。
- 查询：`GET {base}/task/query?task_id=`；每首在 `choices[]`，状态
  pending / running / stream / done / fail，done 时 `audio_url` 可下载，另有 `title`、`lyric`。
任务号拿到就落盘；带任务号进入时只查询，不重新提交（避免重复计费）。
"""
from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
from typing import Any, Callable
from urllib.parse import quote, urlsplit

import requests

from character_workflow.lib import outbound_guard
from character_workflow.lib.audio_caps import AUDIO_CAPS, normalize_music_params
from character_workflow.lib.callers import task_submission
from character_workflow.lib.callers.video_poll import poll_responses, with_task_ref

PROTOCOL = "yinchao-song"
TASK_PROTOCOL = "yinchao"
SUBMIT_TIMEOUT = (30.0, 120.0)
POLL_TIMEOUT = 30.0
POLL_INTERVAL = 3.0
# 官方说通常数十秒出歌；给 10 分钟上限，超时带任务号报错，留人工找回。
MAX_POLLS = 200
MAX_AUDIO_BYTES = 50 * 1024 * 1024
_AUDIO_SUFFIXES = {".mp3", ".wav", ".flac"}
_TERMINAL = {"done", "fail"}
_UNCONFIRMED = "音乐提交结果未确认：网络请求未完成，未自动重新提交。请先核对厂商记录，避免重复计费。"


class YinchaoMusicError(RuntimeError):
    pass


class YinchaoMusicUnconfirmed(YinchaoMusicError, task_submission.SubmissionUnconfirmed):
    """提交可能已被厂商受理、结局不知道：不重发、不换家（第 6 批：按类型判断，不看文案）。"""


def api_base(base_url: str) -> str:
    """词元跳动走 /gateway/yinchao/v1；其余（官方 open.yinchaoyongxian.com/api/v1）按填写的地址。"""
    parts = urlsplit(base_url)
    host = (parts.hostname or "").lower()
    if host == "tokendance.space" or host.endswith(".tokendance.space"):
        return f"{parts.scheme}://{parts.netloc}/gateway/yinchao/v1"
    return base_url.rstrip("/")


def _submit(base: str, headers: dict[str, str], model: str, prompt: str,
            settings: dict[str, Any]) -> str:
    if settings["instrumental"]:
        url = f"{base}/song/instrumental"
        body: dict[str, Any] = {"model": model, "prompt": prompt, "n": settings["n"]}
    else:
        url = f"{base}/song/generate"
        body = {"model": model, "task_type": "normal", "prompt": prompt, "n": settings["n"]}
        if settings.get("lyrics"):
            body["lyric"] = settings["lyrics"]
    try:
        response = requests.post(url, headers=headers, json=body, timeout=SUBMIT_TIMEOUT)
    except requests.RequestException as error:
        if task_submission.network_outcome(error) == "not_sent":
            # 连接都没建立（连接超时 / 被拒 / DNS 失败 / 代理不通）：请求肯定没送达，报「连不上」、可以换家。
            # 第 6 批前被拒与 DNS 失败的文案写成「未确认」，行为同样是换家；文案按管理会话同意改成这句。
            raise task_submission.not_sent_error(YinchaoMusicError)(f"音乐接口连不上：{error}") from error
        raise YinchaoMusicUnconfirmed(_UNCONFIRMED) from error
    if response.status_code >= 500:
        raise YinchaoMusicUnconfirmed(
            f"音乐提交结果未确认：厂商接口返回 HTTP {response.status_code}，未自动重新提交。"
        )
    if response.status_code >= 400:
        raise YinchaoMusicError(f"music api {response.status_code}: {response.text[:500]}")
    try:
        payload = response.json()
    except ValueError as error:
        raise YinchaoMusicUnconfirmed(f"音乐提交结果未确认：响应不是 JSON：{response.text[:200]}") from error
    task_id = str(payload.get("id") or "").strip() if isinstance(payload, dict) else ""
    if not task_id or len(task_id) > 200:
        raise YinchaoMusicUnconfirmed(f"音乐提交结果未确认：响应里没有任务号：{json.dumps(payload)[:200]}")
    return task_id


def _poll(base: str, headers: dict[str, str], task_id: str,
          should_cancel: Callable[[], bool] | None) -> list[dict[str, Any]]:
    url = f"{base}/task/query?task_id={quote(task_id, safe='')}"
    for response in poll_responses(
        url=url, headers=headers, timeout=POLL_TIMEOUT, max_polls=MAX_POLLS,
        poll_interval=POLL_INTERVAL, task_ref=task_id, error_cls=YinchaoMusicError,
        should_cancel=should_cancel,
    ):
        if response.status_code >= 400:
            raise YinchaoMusicError(with_task_ref(
                f"查询音乐任务失败：HTTP {response.status_code} {response.text[:200]}", task_id))
        try:
            body = response.json()
        except ValueError:
            continue
        choices = body.get("choices") if isinstance(body, dict) else None
        if isinstance(choices, list) and choices and all(
            isinstance(item, dict) and item.get("status") in _TERMINAL for item in choices
        ):
            return choices
    raise YinchaoMusicError(with_task_ref("音乐生成超时，任务可能仍在厂商侧继续", task_id))


def _suffix(url: str) -> str:
    suffix = PurePosixPath(urlsplit(url).path).suffix.lower()
    return suffix if suffix in _AUDIO_SUFFIXES else ".mp3"


def render(
    *,
    prompt: str,
    model: str,
    alias: str,
    output_dir: Path | str,
    params: dict[str, Any] | None = None,
    n: int | None = None,
    on_params_changed: Callable[[], None] | None = None,
    on_phase: Callable[[str], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    **_kwargs: Any,
) -> list[str]:
    from character_workflow.lib import keys
    from character_workflow.lib.generation_pricing import music_cost_cny

    key = keys.find_by_alias(alias)
    if key is None:
        raise YinchaoMusicError(f"alias not found: {alias}")
    base_url = (key.base_url or "").strip()
    if not base_url:
        raise YinchaoMusicError("音乐供应商缺少接口地址")
    caps = AUDIO_CAPS[PROTOCOL]
    options = params if params is not None else {}
    text = prompt.strip()
    if not text:
        raise YinchaoMusicError("请描述想要的音乐")
    if len(text) > caps.max_chars:
        raise YinchaoMusicError(f"音乐描述不能超过 {caps.max_chars} 字")
    try:
        # 局域网网关把首数作为独立参数传进来；本机任务的首数在 params.n。
        settings = normalize_music_params(
            caps, model, {**options, "n": n if n is not None else options.get("n")})
    except ValueError as error:
        raise YinchaoMusicError(str(error)) from error

    def changed() -> None:
        if on_params_changed is not None:
            on_params_changed()

    base = api_base(base_url)
    headers = {"Authorization": f"Bearer {key.access_key}", "Content-Type": "application/json"}
    existing = (options.get("provider_task_ids")
                if options.get("provider_task_protocol") == TASK_PROTOCOL else None)
    if existing:
        task_id = str(existing[-1])
    else:
        if should_cancel and should_cancel():
            raise YinchaoMusicError("生成已按请求停止，尚未提交厂商任务")
        task_id = _submit(base, headers, model, text, settings)
        # 从这一刻起已经计费：任务号先落盘，再轮询。
        options["provider_task_protocol"] = TASK_PROTOCOL
        options["provider_task_ids"] = [task_id]
        changed()
    if on_phase:
        on_phase("sent")
    choices = _poll(base, headers, task_id, should_cancel)
    done = [item for item in choices if item.get("status") == "done" and item.get("audio_url")]
    if not done:
        reason = next((str(item.get("error")) for item in choices if item.get("error")), "厂商没有返回歌曲")
        raise YinchaoMusicError(with_task_ref(f"音乐生成失败：{reason}", task_id))

    if on_phase:
        on_phase("downloading")
    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    trusted = outbound_guard.origin(urlsplit(base_url))
    paths: list[str] = []
    tracks: list[dict[str, str]] = []
    for index, item in enumerate(done):
        url = str(item["audio_url"])
        target = target_dir / f"song-{index}{_suffix(url)}"
        try:
            target.write_bytes(outbound_guard.fetch(url, max_bytes=MAX_AUDIO_BYTES, trusted=trusted))
        except outbound_guard.OutboundError as error:
            raise YinchaoMusicError(with_task_ref(f"下载歌曲失败：{error}", task_id)) from error
        paths.append(str(target))
        tracks.append({"title": str(item.get("title") or "")[:200],
                       "lyric": str(item.get("lyric") or "")[:10000]})
    options["music_tracks"] = tracks
    cost = music_cost_cny(provider=key.provider, model_id=model, songs=len(paths))
    if cost is not None:
        options["actual_cost_cny"] = cost
    changed()
    return paths
