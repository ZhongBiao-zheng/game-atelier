"""第 5 批 5-1d：正向识别「连接建立阶段失败、请求确定没发出」（callers/connect_failure）。

用真实的 requests 报错对象：对本机没人监听的端口、解析不了的主机名、连上后立刻关闭的本机假服务、
收完请求不回应的本机假服务各发一次。前两种「未送达」，后两种「未确认」。认不出的一律算未确认。
解析失败用 getaddrinfo 对那个主机名抛 gaierror 造出来（本机沙箱会接管对外解析），其余由 requests / urllib3 自己生成。
"""
from __future__ import annotations

import socket
import threading

import pytest
import requests

from character_workflow.lib.callers import task_submission
from character_workflow.lib.callers.connect_failure import never_sent

UNRESOLVABLE = "atelier-unresolvable.invalid"


def _session():
    session = requests.Session()
    session.trust_env = False  # 不走本机代理环境变量
    return session


def _caught(url, timeout=(2.0, 2.0)) -> requests.RequestException:
    with pytest.raises(requests.RequestException) as error:
        _session().post(url, json={"prompt": "x"}, timeout=timeout)
    return error.value


def _closed_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class _Server:
    """本机假服务：close_at_once=True 收到请求即关连接；否则读完请求后一直不回应。"""

    def __init__(self, close_at_once: bool):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.port = self.sock.getsockname()[1]
        self.close_at_once = close_at_once
        self.open: list[socket.socket] = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            conn.recv(65536)
            if self.close_at_once:
                conn.close()
            else:
                self.open.append(conn)

    def close(self):
        for conn in self.open:
            conn.close()
        self.sock.close()


def test_refused_connection_is_never_sent():
    error = _caught(f"http://127.0.0.1:{_closed_port()}/v1/tasks")
    assert never_sent(error)
    assert task_submission.network_outcome(error) == "not_sent"


def test_unresolvable_host_is_never_sent(monkeypatch):
    original = socket.getaddrinfo

    def getaddrinfo(host, *args, **kwargs):
        if host == UNRESOLVABLE:
            raise socket.gaierror(socket.EAI_NONAME, "nodename nor servname provided, or not known")
        return original(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    error = _caught(f"http://{UNRESOLVABLE}/v1/tasks")
    assert never_sent(error)


def test_connection_closed_right_after_the_request_is_unconfirmed():
    server = _Server(close_at_once=True)
    try:
        error = _caught(f"http://127.0.0.1:{server.port}/v1/tasks")
    finally:
        server.close()
    assert not never_sent(error)
    assert task_submission.network_outcome(error) == "unconfirmed"


def test_request_received_but_never_answered_is_unconfirmed():
    server = _Server(close_at_once=False)
    try:
        error = _caught(f"http://127.0.0.1:{server.port}/v1/tasks", timeout=(2.0, 0.5))
    finally:
        server.close()
    assert isinstance(error, requests.ReadTimeout)
    assert not never_sent(error)


@pytest.mark.parametrize("error", [
    requests.ConnectionError("reset"),
    requests.ConnectionError("something unexpected"),
    requests.exceptions.ProxyError("Unable to connect to proxy: connection refused"),
    requests.exceptions.SSLError("certificate verify failed"),
    requests.exceptions.ChunkedEncodingError("Connection broken"),
], ids=["bare-reset", "unknown", "proxy", "ssl", "chunked"])
def test_anything_not_recognised_counts_as_possibly_sent(error):
    assert not never_sent(error)


def test_text_is_only_a_fallback_when_there_is_no_exception_object():
    assert never_sent(requests.ConnectionError(
        "Failed to establish a new connection: [Errno 61] Connection refused"))
    assert never_sent(requests.ConnectTimeout("connect timed out"))
