"""正向识别「连接建立阶段就失败、请求确定没发出」的网络异常。

只有明确认出来的才算没送达；认不出的一律当成「可能已送达」（调用方按未确认处理，不换家、不重发）。
默认方向是保守的：把一次已送达的请求误判成没送达，会换家重提或自动重试，可能两家各下一单、重复计费；
反过来误判只是让用户手动重试一次。

识别以类型为主，沿 `__cause__` / `__context__` / `args` / urllib3 `MaxRetryError.reason` 找：

- `requests.ConnectTimeout`；urllib3 `NewConnectionError`（含 `NameResolutionError`）、`ConnectTimeoutError`；
- `socket.gaierror`（解析失败）、`ConnectionRefusedError`、`OSError` 的 `ECONNREFUSED`。

类型一个都拿不到时（只有报错文本），才看报文，且只收几种明确的说法。

`requests.ProxyError` / `requests.SSLError` 一律算可能已送达：
- 代理：连上代理之后，请求体可能已经交给代理转发，本机无从知道代理有没有发往上游；
- TLS：握手失败多半发生在发请求之前，但证书校验失败与握手后被掐在 requests 里是同一个类型，分不开。
"""
from __future__ import annotations

import errno
import socket

import requests
from urllib3 import exceptions as urllib3_exceptions

_MARKERS = (
    "connection refused",
    "failed to establish a new connection",
    "name resolution",
    "failed to resolve",
    "name or service not known",
    "nodename nor servname provided",
    "getaddrinfo failed",
)
_CONNECT_TYPES = (
    urllib3_exceptions.NewConnectionError,  # NameResolutionError 是它的子类
    urllib3_exceptions.ConnectTimeoutError,
    socket.gaierror,
    ConnectionRefusedError,
)
_UNKNOWN_DELIVERY = (
    requests.exceptions.ProxyError, requests.exceptions.SSLError,
    urllib3_exceptions.ProxyError, urllib3_exceptions.SSLError,
)


def _related(error: BaseException) -> list[BaseException]:
    items = (error.__cause__, error.__context__, getattr(error, "reason", None), *error.args)
    return [item for item in items if isinstance(item, BaseException)]


def _walk(error: BaseException) -> list[BaseException]:
    seen: list[BaseException] = []
    pending = [error]
    while pending and len(seen) < 32:
        current = pending.pop()
        if any(current is item for item in seen):
            continue
        seen.append(current)
        pending.extend(_related(current))
    return seen


def never_sent(error: BaseException) -> bool:
    """这次失败是不是「连接建立阶段失败、请求确定没发出」。认不出的返回 False。"""
    chain = _walk(error)
    if any(isinstance(item, _UNKNOWN_DELIVERY) for item in chain):
        return False
    if isinstance(error, requests.exceptions.ConnectTimeout):
        return True
    for item in chain:
        if isinstance(item, _CONNECT_TYPES):
            return True
        if isinstance(item, OSError) and item.errno == errno.ECONNREFUSED:
            return True
    # 拿到了别的异常对象（ProtocolError、RemoteDisconnected、ReadTimeoutError……）：按类型就是认不出。
    if len(chain) > 1:
        return False
    text = str(error).lower()
    return any(marker in text for marker in _MARKERS)
