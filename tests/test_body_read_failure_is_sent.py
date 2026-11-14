"""响应头已到、读响应体时失败 = 请求已被厂商受理：不重试、不换家（重复计费回归）。"""
import pytest
import requests

from character_workflow.lib import model_routes
from character_workflow.lib.callers import openai_image
from character_workflow.lib.job_runner import _friendly_error
import socket
import threading


class StallingServer:
    """回 200 响应头 + 8 字节后不再发送：复现「头到体停」，统计收到几次请求。"""

    def __init__(self):
        self.connections = 0
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.url = f"http://127.0.0.1:{self.sock.getsockname()[1]}"
        self.open: list = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            self.open.append(conn)
            conn.recv(65536)
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                         b"Content-Length: 100\r\n\r\n{\"data\":")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        for conn in self.open:
            conn.close()
        self.sock.close()


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(openai_image.time, "sleep", lambda _s: None)


def _body_timeout() -> requests.RequestException:
    with StallingServer() as server:
        try:
            requests.post(server.url, json={}, timeout=(1, 1))
        except requests.RequestException as error:
            return error
    raise AssertionError("expected a body read timeout")


def test_post_json_submits_once_when_the_body_stalls():
    with StallingServer() as server:
        with pytest.raises(openai_image.OpenAIImageError, match="Read timed out") as error:
            openai_image._post_json(server.url + "/v1/images/generations", "sk-test",
                                    {"model": "gpt-image-2", "prompt": "x"}, timeout=(1, 1))
        assert server.connections == 1
    hint = _friendly_error(error.value)
    assert "请求可能已经执行" in hint and "厂商后台核对" in hint


def test_body_timeout_is_classified_as_sent_everywhere():
    error = _body_timeout()
    assert isinstance(error, requests.ConnectionError)  # 不是 ReadTimeout：原 bug 的根源
    assert not openai_image._is_pre_flight_failure(error)
    # 路由失败切换也读这个判定：已受理的请求不能换下一家再提交一次。
    wrapped = openai_image.OpenAIImageError("image api failed")
    wrapped.__cause__ = error
    assert model_routes.failover_reason(wrapped) is None


@pytest.mark.parametrize("message", [
    "HTTPConnectionPool(host='x', port=80): Read timed out.",
    "('Connection broken: IncompleteRead(8 bytes read, 92 more expected)', IncompleteRead(...))",
])
def test_read_phase_messages_are_sent(message):
    assert not openai_image._is_pre_flight_failure(requests.ConnectionError(message))


def test_unsent_failures_still_retry():
    assert openai_image._is_pre_flight_failure(requests.ConnectTimeout("connect timed out"))
    assert openai_image._is_pre_flight_failure(requests.ConnectionError(
        "Max retries exceeded with url: / (Caused by NewConnectionError: Connection refused)"))
    with pytest.raises(openai_image.OpenAIImageError):
        openai_image._post_json("http://127.0.0.1:1/v1/images/generations", "k", {}, timeout=(1, 1))
