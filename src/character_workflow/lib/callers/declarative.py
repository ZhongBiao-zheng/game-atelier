"""自定义接口执行器：按接口模板发请求、轮询、取结果（ADR-0036）。

与内置 caller 共享的政策：
- 提交阶段只对「请求没送达」与 502/503/504 退避重试；读超时、连接建立后被掐、其余状态码当场
  致命——同步生成端点在出图前不吐字节，重试等于再付一次钱。
- 异步任务号拿到就落盘，再开始轮询；带着已有任务号进来时只轮询不提交。
- 报错格式 `custom api <状态码>: <厂商文字>`，让 job_runner._friendly_error 与路由失败切换
  沿用同一套识别。
"""
from __future__ import annotations

import base64
import binascii
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from math import ceil
from pathlib import Path
from typing import Any
from urllib.parse import SplitResult, urlencode, urlsplit

import requests

from character_workflow.lib import keys as _keys
from character_workflow.lib import net_env, outbound_guard
from character_workflow.lib.http_protocol_render import (
    MISSING, derive_values, first_value, render, render_path, strings_at,
)
from character_workflow.lib.http_protocol_schema import (
    HttpProtocol, ResultSpec, declared_capabilities,
)
from character_workflow.lib.http_protocols import (
    PROTOCOL, ProtocolUnavailableError, read_protocol,
)

from . import video_poll
from .image_output import image_extension, write_image

TASK_PROTOCOL = PROTOCOL
SUBMIT_RESPONSE_LIMIT = 64 * 1024 * 1024
POLL_RESPONSE_LIMIT = 2 * 1024 * 1024
IMAGE_LIMIT = 50 * 1024 * 1024
VIDEO_LIMIT = 1024 * 1024 * 1024
INPUT_IMAGE_LIMIT = 20 * 1024 * 1024
MAX_RESULTS = 8
ASYNC_SUBMIT_TIMEOUT = (30.0, 120.0)
POLL_REQUEST_TIMEOUT = 30.0
DEFAULT_POLL_TIMEOUT = {"image": 600, "video": 1800}
_RETRYABLE_STATUS = frozenset({502, 503, 504})
_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}


class DeclarativeError(RuntimeError):
    pass


class DeclarativePendingError(DeclarativeError):
    """轮询停止但厂商任务仍可能在跑：任务号已落盘，可续查，不能重新提交。"""


@dataclass(frozen=True)
class FilePart:
    """multipart 里以文件上传的参考图。"""
    path: str
    label: str


@dataclass
class PreparedCall:
    method: str
    url: str
    headers: dict[str, str]
    json_body: Any = None
    parts: list[tuple[str, tuple[str | None, Any, str | None]]] = field(default_factory=list)
    sent_urls: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class Binding:
    key: _keys.KeySpec
    protocol: HttpProtocol
    base: SplitResult


def bind(alias: str, model: str, kind: str) -> Binding:
    key = _keys.find_by_alias(alias)
    if key is None:
        raise DeclarativeError(f"未找到供应商 {alias}")
    spec = next((m for m in key.models if m.id == model), None)
    if spec is None or spec.protocol != PROTOCOL:
        raise DeclarativeError(f"模型 {model} 没有绑定自定义接口")
    if key.provider != "custom":
        raise DeclarativeError("只有自定义供应商可以使用自定义接口")
    try:
        protocol = read_protocol(spec.declarative_id or "")
    except ProtocolUnavailableError as error:
        raise DeclarativeError(str(error)) from None
    if protocol.kind != kind:
        label = "图片" if kind == "image" else "视频"
        raise DeclarativeError(f"自定义接口「{protocol.name}」不是{label}接口")
    try:
        base = outbound_guard.check_base_url(key.base_url)
    except outbound_guard.OutboundError as error:
        raise DeclarativeError(f"自定义接口的服务地址无效：{error}") from None
    return Binding(key, protocol, base)


# ---------------------------------------------------------------- 参数与上下文


def _choice(value: Any, allowed: list | None, label: str, *, numeric: bool = False) -> Any:
    if allowed is None:
        return None
    if value in (None, "", "auto"):
        return allowed[0]
    try:
        candidate = int(value) if numeric else str(value)
    except (TypeError, ValueError):
        raise DeclarativeError(f"{label} {value} 不在该接口支持的范围内") from None
    if candidate not in allowed:
        options = "、".join(map(str, allowed))
        raise DeclarativeError(f"{label} {value} 不在该接口支持的范围内（可选：{options}）")
    return candidate


def _assign_images(caps: dict, refs: list[str], frame_mode: str) -> dict[str, Any]:
    frames, reference = caps["frames"], caps["reference_images"]
    use_frames = frames and (reference == 0 or frame_mode in ("first", "last", "firstlast"))
    if use_frames:
        if len(refs) > frames:
            raise DeclarativeError(f"该接口最多接受 {frames} 张首尾帧")
        if frame_mode == "last" and refs and frames == 2:
            return {"lastFrame": refs[0]}
        return {"firstFrame": refs[0] if refs else None,
                "lastFrame": refs[1] if len(refs) > 1 else None}
    if len(refs) > reference:
        raise DeclarativeError("该接口不接受参考图" if reference == 0
                               else f"该接口最多接受 {reference} 张参考图")
    return {"images": refs or None, "image": refs[0] if refs else None}


def encode_image(path: str, encode: str, label: str) -> Any:
    if encode == "file":
        return FilePart(path, label)
    file = Path(path)
    if file.stat().st_size > INPUT_IMAGE_LIMIT:
        raise DeclarativeError(f"{label}超过 20 MB，请压缩后重试")
    raw = file.read_bytes()
    data = base64.b64encode(raw).decode("ascii")
    if encode == "base64":
        return data
    return f"data:{_MIME[image_extension(raw)]};base64,{data}"


def build_context(protocol: HttpProtocol, *, prompt: str, model: str,
                  params: dict[str, Any],
                  encoder: Callable[[str, str, str], Any] = encode_image) -> dict[str, Any]:
    """把一次任务的参数换成占位符的值；不合声明的参数当场拒绝，请求不发出。"""
    caps = declared_capabilities(protocol)
    n = int(params.get("n") or 1)
    if not 1 <= n <= caps["max_count"]:
        raise DeclarativeError(f"该接口一次最多出 {caps['max_count']} 张")
    duration = _choice(params.get("duration"), caps["durations"], "时长", numeric=True)
    context: dict[str, Any] = {
        "prompt": prompt, "model": model, "n": n,
        "ratio": _choice(params.get("ratio"), caps["ratios"], "比例"),
        "resolution": _choice(params.get("resolution"), caps["resolutions"], "分辨率"),
        "duration": duration, "durationText": f"{duration}s" if duration is not None else None,
    }
    refs = [str(p) for p in params.get("reference_images") or []]
    slots = _assign_images(caps, refs, str(params.get("frame_mode") or "auto"))
    encoding = protocol.inputs.images.encode if protocol.inputs.images else "data_url"
    labels = {path: f"图片{index}" for index, path in enumerate(refs, start=1)}
    for name, value in slots.items():
        if isinstance(value, list):
            context[name] = [encoder(p, encoding, labels[p]) for p in value]
        elif value is not None:
            context[name] = encoder(value, encoding, labels[value])
    context.update(derive_values(protocol.derive, context))
    return context


# ---------------------------------------------------------------- 请求


def prepare(base: SplitResult, access_key: str, protocol: HttpProtocol,
            context: dict[str, Any], *, poll: bool = False) -> PreparedCall:
    if poll:
        assert protocol.poll is not None
        path_template, body, method, fmt = (protocol.poll.path, protocol.poll.body,
                                            protocol.poll.method, "json")
    else:
        path_template, body, method, fmt = (protocol.submit.path, protocol.submit.body,
                                            "POST", protocol.submit.format)
    url = base.geturl().rstrip("/") + render_path(path_template, context)
    if outbound_guard.origin(urlsplit(url)) != outbound_guard.origin(base):
        raise DeclarativeError("自定义接口的地址拼接后离开了服务地址")
    headers = dict(protocol.submit.headers)
    auth = protocol.auth
    if auth.type == "bearer":
        headers["Authorization"] = f"Bearer {access_key}"
    elif auth.type == "header":
        headers[auth.name or ""] = f"{auth.prefix or ''}{access_key}"
    elif auth.type == "query":
        url += ("&" if "?" in url else "?") + urlencode({auth.name or "": access_key})
    rendered = render(body, context) if body is not None else None
    call = PreparedCall(method=method, url=url, headers=headers)
    if rendered is MISSING or rendered is None:
        return call
    call.sent_urls = video_poll.sent_url_set(_strings(rendered))
    if fmt == "multipart":
        call.parts = _multipart(rendered)
    else:
        call.json_body = rendered
    return call


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in _strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in _strings(v)]
    return []


def _text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _multipart(body: dict[str, Any]) -> list[tuple[str, tuple[str | None, Any, str | None]]]:
    parts: list[tuple[str, tuple[str | None, Any, str | None]]] = []
    for name, value in body.items():
        # 数组（多张参考图）展开成同名重复字段，这是表单上传多文件的通行写法。
        for item in value if isinstance(value, list) else [value]:
            if isinstance(item, FilePart):
                raw = Path(item.path).read_bytes()
                if len(raw) > INPUT_IMAGE_LIMIT:
                    raise DeclarativeError(f"{item.label}超过 20 MB，请压缩后重试")
                ext = image_extension(raw)
                parts.append((name, (f"image{ext}", raw, _MIME[ext])))
            else:
                parts.append((name, (None, _text(item), None)))
    return parts


def _error_text(payload: Any, raw: bytes, path: str | None) -> str:
    detail = first_value(payload, path) if path else None
    for fallback in ("error.message", "error", "message", "detail", "msg"):
        if detail not in (None, "", {}):
            break
        detail = first_value(payload, fallback)
    if isinstance(detail, (dict, list)):
        detail = json.dumps(detail, ensure_ascii=False)
    text = str(detail) if detail not in (None, "") else raw[:300].decode("utf-8", "replace")
    return text[:500]


def _decode_json(raw: bytes) -> Any:
    try:
        return json.loads(raw)
    except ValueError:
        return None


def send(call: PreparedCall, *, timeout, error_path: str | None) -> Any:
    """发提交请求：只在确定没执行的失败上重试；返回解析后的 JSON。"""
    from .openai_image import _is_pre_flight_failure

    for attempt in range(3):
        try:
            with requests.request(
                call.method, call.url, headers=call.headers,
                json=call.json_body if not call.parts else None,
                files=call.parts or None, timeout=timeout, stream=True, allow_redirects=False,
            ) as response:
                status = response.status_code
                raw = outbound_guard.read_limited(response, SUBMIT_RESPONSE_LIMIT)
        except outbound_guard.OutboundError as error:
            raise DeclarativeError(f"custom api 响应过大：{error}") from None
        except requests.RequestException as error:
            if _is_pre_flight_failure(error) and attempt < 2:
                time.sleep(1 + attempt)
                continue
            raise DeclarativeError(f"custom api request failed: {error}") from error
        payload = _decode_json(raw)
        if 300 <= status < 400:
            raise DeclarativeError(f"custom api {status}: 接口返回了重定向，自定义接口不跟随重定向")
        if status >= 400:
            if status in _RETRYABLE_STATUS and attempt < 2:
                time.sleep(1 + attempt)
                continue
            raise DeclarativeError(f"custom api {status}: {_error_text(payload, raw, error_path)}")
        if payload is None:
            raise DeclarativeError(
                "custom api 返回的内容不是 JSON，这次请求可能已经执行，请先到厂商后台确认")
        return payload
    raise DeclarativeError("custom api: retries exhausted")


# ---------------------------------------------------------------- 结果


def _summary(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False)[:300]


def _results(payload: Any, spec: ResultSpec, sent: set[str],
             task_ref: str = "") -> list[tuple[str, str]]:
    items = [("base64", v) for v in strings_at(payload, spec.base64)]
    items += [("url", v) for v in strings_at(payload, spec.urls)
              if not video_poll.is_echoed_input(v, sent)]
    if not items:
        paths = "、".join([*spec.base64, *spec.urls])
        raise DeclarativeError(video_poll.with_task_ref(
            f"自定义接口按 {paths} 取不到结果，请核对接口模板；厂商响应：{_summary(payload)}",
            task_ref))
    return items[:MAX_RESULTS]


def _decode_base64(value: str, limit: int) -> bytes:
    data = value.split(",", 1)[1] if value.startswith("data:") and "," in value else value
    if len(data) * 3 // 4 > limit:
        raise DeclarativeError("厂商返回的 base64 结果超过大小上限")
    try:
        return base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise DeclarativeError("厂商返回的 base64 结果无法解码") from None


def _download(url: str, limit: int, trusted, task_ref: str, sink=None) -> bytes:
    try:
        return outbound_guard.fetch(url, max_bytes=limit, trusted=trusted, sink=sink)
    except (outbound_guard.OutboundError, requests.RequestException) as error:
        # 走到这里厂商已经出完并计费：带上任务号与源地址，留人工取回的钩子。
        raise DeclarativeError(video_poll.with_task_ref(
            f"下载结果失败（源地址 {url}）：{error}", task_ref)) from error


def _write_images(items, output_dir: Path, trusted, task_ref: str) -> list[str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for index, (kind, value) in enumerate(items, start=1):
        data = (_decode_base64(value, IMAGE_LIMIT) if kind == "base64"
                else _download(value, IMAGE_LIMIT, trusted, task_ref))
        paths.append(str(write_image(output_dir, f"v{index}", data)))
    return paths


def _write_videos(items, output_dir: Path, trusted, task_ref: str) -> list[str]:
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for index, (kind, value) in enumerate(items, start=1):
        target = output_dir / f"v{index}.mp4"
        if kind == "base64":
            target.write_bytes(_decode_base64(value, VIDEO_LIMIT))
        else:
            with target.open("wb") as stream:
                _download(value, VIDEO_LIMIT, trusted, task_ref, sink=stream.write)
        paths.append(str(target))
    return paths


# ---------------------------------------------------------------- 异步


def _task_id(value: Any) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    text = str(value).strip()
    if not text:
        return None
    if len(text) > 200:
        raise DeclarativeError("厂商返回的任务号过长")
    return text


def _run_async(binding: Binding, context: dict[str, Any], params: dict[str, Any], *,
               persist: Callable[[str], None], on_phase, should_cancel) -> tuple[Any, str]:
    protocol = binding.protocol
    poll = protocol.poll
    assert poll is not None
    existing = (params.get("provider_task_ids")
                if params.get("provider_task_protocol") == TASK_PROTOCOL else None)
    if existing:
        task_id = str(existing[-1])
    else:
        if should_cancel and should_cancel():
            raise DeclarativeError("生成已按请求停止，尚未提交厂商任务")
        call = prepare(binding.base, binding.key.access_key, protocol, context)
        payload = send(call, timeout=ASYNC_SUBMIT_TIMEOUT, error_path=protocol.result.error)
        found = _task_id(first_value(payload, poll.task_id))
        if not found:
            raise DeclarativeError(
                f"custom api 提交后按 {poll.task_id} 取不到任务号；厂商响应：{_summary(payload)}")
        task_id = found
        params["provider_task_protocol"] = TASK_PROTOCOL
        params["provider_task_ids"] = [task_id]
        # 从这一刻起请求可能已计费：任务号先落盘，再轮询。
        persist(task_id)
    if on_phase:
        on_phase("sent")
    call = prepare(binding.base, binding.key.access_key, protocol,
                   {**context, "taskId": task_id}, poll=True)
    window = poll.timeout_seconds or DEFAULT_POLL_TIMEOUT[protocol.kind]
    success = {s.lower() for s in poll.success}
    failure = {s.lower() for s in poll.failure}
    status = ""
    for response in video_poll.poll_responses(
        url=call.url, headers=call.headers, timeout=POLL_REQUEST_TIMEOUT,
        max_polls=ceil(window / poll.interval_seconds) + 10, poll_interval=poll.interval_seconds,
        task_ref=task_id, error_cls=DeclarativePendingError, should_cancel=should_cancel,
        max_elapsed_seconds=window, method=call.method, json_body=call.json_body,
        follow_redirects=False,
    ):
        if 300 <= response.status_code < 400:
            raise DeclarativeError(video_poll.with_task_ref(
                f"custom api {response.status_code}: 查询任务时接口返回了重定向，自定义接口不跟随重定向",
                task_id))
        raw = response.content or b""
        if len(raw) > POLL_RESPONSE_LIMIT:
            raise DeclarativeError(video_poll.with_task_ref("查询任务的响应超过 2 MB 上限", task_id))
        payload = _decode_json(raw)
        if response.status_code >= 400:
            raise DeclarativeError(video_poll.with_task_ref(
                f"custom api {response.status_code}: "
                f"{_error_text(payload, raw, poll.result.error)}", task_id))
        status = str(first_value(payload, poll.status) or "").strip()
        if status.lower() in success:
            if on_phase:
                on_phase("downloading")
            return payload, task_id
        if status.lower() in failure:
            raise DeclarativeError(video_poll.with_task_ref(
                f"厂商报告任务失败：{_error_text(payload, raw, poll.result.error)}", task_id))
    raise DeclarativePendingError(video_poll.with_task_ref(
        f"查询超时，厂商最后状态：{status or '未取得'}；任务可能仍在厂商侧运行", task_id))


# ---------------------------------------------------------------- 入口


def _execute(binding: Binding, context: dict[str, Any], params: dict[str, Any], *,
             persist, on_phase, should_cancel) -> tuple[list[tuple[str, str]], str]:
    protocol = binding.protocol
    if protocol.poll is not None:
        payload, task_id = _run_async(binding, context, params, persist=persist,
                                      on_phase=on_phase, should_cancel=should_cancel)
        return _results(payload, protocol.poll.result, set(), task_id), task_id
    if should_cancel and should_cancel():
        raise DeclarativeError("生成已按请求停止，尚未提交厂商请求")
    call = prepare(binding.base, binding.key.access_key, protocol, context)
    if on_phase:
        on_phase("sent")
    payload = send(call, timeout=net_env.DEFAULT_TIMEOUT, error_path=protocol.result.error)
    if on_phase:
        on_phase("downloading")
    return _results(payload, protocol.result, call.sent_urls), ""


def render_image(*, prompt: str, model: str, alias: str, output_dir: Path | str,
                 n: int = 1, params: dict[str, Any] | None = None, on_phase=None,
                 on_params_changed=None, should_cancel=None, **_kwargs) -> list[str]:
    params = params if params is not None else {}
    binding = bind(alias, model, "image")
    context = build_context(binding.protocol, prompt=prompt, model=model,
                            params={**params, "n": params.get("n") or n})

    def persist(_task_id: str) -> None:
        if on_params_changed:
            on_params_changed()

    items, task_id = _execute(binding, context, params, persist=persist, on_phase=on_phase,
                              should_cancel=should_cancel)
    return _write_images(items, Path(output_dir), outbound_guard.origin(binding.base), task_id)


def render_video(*, prompt: str, model: str, alias: str, output_dir: Path | str,
                 params: dict[str, Any] | None = None, on_phase=None, on_task_id=None,
                 should_cancel=None, **_kwargs) -> list[str]:
    params = params if params is not None else {}
    binding = bind(alias, model, "video")
    context = build_context(binding.protocol, prompt=prompt, model=model, params=params)

    def persist(task_id: str) -> None:
        if on_task_id:
            on_task_id(task_id)

    items, task_id = _execute(binding, context, params, persist=persist, on_phase=on_phase,
                              should_cancel=should_cancel)
    return _write_videos(items[:1], Path(output_dir), outbound_guard.origin(binding.base),
                         task_id)
