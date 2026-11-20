"""第 6 批 6-1：音潮音乐、EvoLink MJ、MJ 任务代理的提交失败按类型分类，不靠「未确认」文案。

每个调用方对 7 种失败各跑两遍，都打真实套接字，requests 自己产生报错对象：
- 本机：直接调 caller，断言原报错类（`pytest.raises(<原类>)`）、`is_unconfirmed` / `is_not_sent`、只发一次；
- 经网关：两把 KEY 的「自动」路由，断言主机 `error_kind` 与第二把 KEY 的提交次数。
期望值逐格对照 `team-reliability-PLAN-5.md`「第 6 批」的现状判定表（迁移前后行为一致）。

调用方把地址写死成厂商域名的（EvoLink）或超时较长的，由测试把 POST 改投到本机假服务、把超时缩短，
报错对象仍由 requests 对真实套接字产生。轮询入口（requests.get）抛 `_Stop` 停下，不替换 time.sleep。
"""
from __future__ import annotations

import socket
import threading
from urllib.parse import urlsplit

import pytest
import requests

from character_workflow.lib import gateway_keys, gateway_quota, gateway_tasks, keys, model_routes
from character_workflow.lib.callers import evolink, mj_image, task_submission, yinchao_music


class _Stop(BaseException):
    """第二把 KEY 提交成功后进轮询：在这里停下。"""


def _http(status: int, body: str, content_type: str = "application/json") -> bytes:
    data = body.encode()
    return (f"HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {len(data)}\r\n"
            "Connection: close\r\n\r\n").encode() + data


class _Upstream:
    """本机假上游：mode=close 读完请求就关连接；silent 读完不回；reply 读完整个请求后回 reply。"""

    def __init__(self, *, mode: str = "reply", reply: bytes | None = None):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.base = f"http://127.0.0.1:{self.sock.getsockname()[1]}"
        self.mode, self.reply = mode, reply
        self.held: list[socket.socket] = []
        threading.Thread(target=self._serve, daemon=True).start()

    @staticmethod
    def _read_request(conn: socket.socket) -> None:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(65536)
            if not chunk:
                return
            data += chunk
        head, _, body = data.partition(b"\r\n\r\n")
        length = next((int(line.split(b":", 1)[1]) for line in head.split(b"\r\n")
                       if line.lower().startswith(b"content-length:")), 0)
        while len(body) < length:
            chunk = conn.recv(65536)
            if not chunk:
                return
            body += chunk

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self._read_request(conn)
            if self.mode == "close":
                conn.close()
            elif self.mode == "silent":
                self.held.append(conn)
            else:
                conn.sendall(self.reply or b"")
                conn.close()

    def close(self):
        for conn in self.held:
            conn.close()
        self.sock.close()


def _closed_base() -> str:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"http://127.0.0.1:{port}"


FAULTS = ["refused", "close", "silent", "5xx", "2xx_not_json", "2xx_no_id", "4xx"]

# 每个调用方：(主机 error_kind 或 switch=换到第二把 KEY, 本机分类)。与现状判定表一致；
# EvoLink 与 MJ 任务代理在发送前落了「未确认」状态（evolink_state / mj_submit_uncertain），主机把它存进
# resume_params，之后任何失败（含 4xx 明确拒绝）在主机上都判未确认；MJ 的网络异常本机不包装（network）。
EXPECTED = {
    "yinchao": {"refused": ("switch", "not_sent"), "close": ("unconfirmed", "unconfirmed"),
                "silent": ("unconfirmed", "unconfirmed"), "5xx": ("unconfirmed", "unconfirmed"),
                "2xx_not_json": ("unconfirmed", "unconfirmed"),
                "2xx_no_id": ("unconfirmed", "unconfirmed"), "4xx": ("failed", "rejected")},
    "evolink": {"refused": ("unconfirmed", "unconfirmed"), "close": ("unconfirmed", "unconfirmed"),
                "silent": ("unconfirmed", "unconfirmed"), "5xx": ("unconfirmed", "unconfirmed"),
                "2xx_not_json": ("unconfirmed", "unconfirmed"),
                "2xx_no_id": ("unconfirmed", "unconfirmed"), "4xx": ("unconfirmed", "rejected")},
    "mj": {"refused": ("unconfirmed", "network"), "close": ("unconfirmed", "network"),
           "silent": ("unconfirmed", "network"), "5xx": ("unconfirmed", "rejected"),
           "2xx_not_json": ("unconfirmed", "rejected"), "2xx_no_id": ("unconfirmed", "rejected"),
           "4xx": ("unconfirmed", "rejected")},
}

CALLERS = {
    # name: (provider, base_url, model, modality, protocol, 原报错类, 成功响应体, 4xx 响应体)
    "yinchao": ("tokendance", "https://tokendance.space/gateway/v1", "yc-song-4.0", "audio",
                "yinchao-song", yinchao_music.YinchaoMusicError, '{"id": "t-1"}',
                '{"error": "bad prompt"}'),
    "evolink": ("evolink", "https://api.evolink.ai/v1", "mj-v8.2", "image", None,
                evolink.EvoLinkError, '{"id": "task-1"}',
                '{"error": {"message": "invalid parameters"}}'),
    "mj": ("midjourney", "https://api.tu-zi.com", "mj_fast_imagine", "image", None,
           mj_image.MidjourneyError, '{"code": 1, "result": "1786973745670123"}',
           '{"code": 4, "description": "参数错误"}'),
}


def _fault_upstream(fault: str, caller: str) -> _Upstream | None:
    replies = {
        "5xx": _http(503, '{"error": "busy"}'),
        "2xx_not_json": _http(200, "<html>ok</html>", "text/html"),
        "2xx_no_id": _http(200, '{"status": "ok"}'),
        "4xx": _http(400, CALLERS[caller][7]),
    }
    if fault == "refused":
        return None
    if fault in ("close", "silent"):
        return _Upstream(mode=fault)
    return _Upstream(reply=replies[fault])


@pytest.fixture(autouse=True)
def isolated(isolated_data_root, monkeypatch):
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)

    def stop(*_args, **_kwargs):
        raise _Stop()

    monkeypatch.setattr(requests, "get", stop)
    yield
    model_routes._cooldowns.clear()


def _route_posts(monkeypatch, targets: dict[str, str]) -> list[str]:
    """POST 按 Authorization 里的 KEY 名改投到本机假服务（路径不变），超时缩短；返回每次提交是哪把 KEY。"""
    real = requests.post
    sent: list[str] = []

    def post(url, *args, headers=None, **kwargs):
        auth = str((headers or {}).get("Authorization", ""))
        who = "first" if "first" in auth else "second"
        sent.append(who)
        kwargs["timeout"] = (2.0, 0.5)
        return real(targets[who] + urlsplit(url).path, *args, headers=headers, **kwargs)

    monkeypatch.setattr(requests, "post", post)
    return sent


def _add(caller: str, alias: str) -> None:
    provider, base_url, model, modality, protocol, *_ = CALLERS[caller]
    keys.add_key(keys.KeySpec(
        alias=alias, provider=provider, access_key=f"{alias}-test-secret", base_url=base_url,
        modalities=[modality], created_at="test",
        models=[keys.ModelSpec(id=model, name=model, modality=modality, protocol=protocol)]))


def _render(caller: str, alias: str, tmp_path, params: dict):
    model = CALLERS[caller][2]
    module = {"yinchao": yinchao_music, "evolink": evolink, "mj": mj_image}[caller]
    return module.render(prompt="海边的灯塔", model=model, alias=alias, output_dir=tmp_path,
                         n=1, params=params)


@pytest.mark.parametrize("fault", FAULTS)
@pytest.mark.parametrize("caller", list(CALLERS))
def test_local_failure_keeps_its_class_and_is_classified_by_type(monkeypatch, tmp_path, caller, fault):
    _add(caller, "first")
    upstream = _fault_upstream(fault, caller)
    sent = _route_posts(monkeypatch, {"first": upstream.base if upstream else _closed_base()})
    expected = EXPECTED[caller][fault][1]
    raised = requests.RequestException if expected == "network" else CALLERS[caller][5]
    try:
        with pytest.raises(raised) as error:
            _render(caller, "first", tmp_path, {})
    finally:
        if upstream:
            upstream.close()
    assert sent == ["first"]  # 只发一次，不重发
    assert task_submission.is_unconfirmed(error.value) is (expected == "unconfirmed")
    assert task_submission.is_not_sent(error.value) is (expected == "not_sent")


def _gateway_task(caller: str):
    owner = gateway_keys.create_key("小王")[0]
    modality = CALLERS[caller][3]
    route = next(r for r in model_routes.list_routes(modality) if len(r.members) == 2)
    task = gateway_tasks.submit(owner, idempotency_key="k1", model=route.id, prompt="海边的灯塔",
                                n=1, size=None, params={}, files={}, kind=modality)
    return gateway_tasks._update(task.task_id, status="running")


@pytest.mark.parametrize("fault", FAULTS)
@pytest.mark.parametrize("caller", list(CALLERS))
def test_through_the_gateway_kind_and_failover_follow_the_table(monkeypatch, caller, fault):
    _add(caller, "first")
    _add(caller, "second")
    upstream = _fault_upstream(fault, caller)
    ok = _Upstream(reply=_http(200, CALLERS[caller][6]))
    sent = _route_posts(monkeypatch, {"first": upstream.base if upstream else _closed_base(),
                                      "second": ok.base})
    host_kind = EXPECTED[caller][fault][0]
    try:
        task = _gateway_task(caller)
        if host_kind == "switch":
            with pytest.raises(_Stop):  # 第二把 KEY 提交成功、进了轮询
                gateway_tasks.run_task(task)
        else:
            finished = gateway_tasks.run_task(task)
            assert finished.status == "failed" and finished.error_kind == host_kind
            assert finished.charged_cny == 0
    finally:
        ok.close()
        if upstream:
            upstream.close()
    assert sent == (["first", "second"] if host_kind == "switch" else ["first"])


@pytest.mark.parametrize("fault", ["refused", "dns"])
def test_yinchao_connection_never_made_says_it_could_not_connect(monkeypatch, tmp_path, fault):
    """管理会话同意 Q6-2：连接被拒与 DNS 失败和连接超时同一句「音乐接口连不上」，行为仍是「未送达、可换家」。"""
    _add("yinchao", "first")
    if fault == "dns":
        original = socket.getaddrinfo

        def getaddrinfo(host, *args, **kwargs):
            if host == "atelier-unresolvable.invalid":
                raise socket.gaierror(socket.EAI_NONAME, "nodename nor servname provided, or not known")
            return original(host, *args, **kwargs)

        monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
        target = "http://atelier-unresolvable.invalid"
    else:
        target = _closed_base()
    _route_posts(monkeypatch, {"first": target})
    with pytest.raises(yinchao_music.YinchaoMusicError, match="^音乐接口连不上：") as error:
        _render("yinchao", "first", tmp_path, {})
    assert task_submission.is_not_sent(error.value) and not task_submission.is_unconfirmed(error.value)
    assert "未确认" not in str(error.value)
    assert model_routes.failover_reason(error.value) == "unreachable"
