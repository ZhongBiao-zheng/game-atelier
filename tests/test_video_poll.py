"""视频轮询公共外壳的政策测试（四家 caller 共用这一层，坏了就是四家一起坏）。"""
from __future__ import annotations

import pytest
import requests

from character_workflow.lib.callers import video_poll
from character_workflow.lib.job_runner import _friendly_error


class _Resp:
    def __init__(self, status_code: int = 200):
        self.status_code = status_code

    @property
    def ok(self) -> bool:
        return self.status_code < 400


class _Err(RuntimeError):
    pass


def _scripted_get(script: list, seen: list):
    """按脚本逐个返回/抛出；脚本用完后一直返回 200。"""
    def fake_get(url, headers=None, timeout=None):
        seen.append(url)
        if not script:
            return _Resp(200)
        item = script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item
    return fake_get


def _drain(*, max_polls=3, poll_interval=0.0, task_ref="task-1"):
    return list(video_poll.poll_responses(
        url="https://vendor/tasks/task-1", headers={}, timeout=1,
        max_polls=max_polls, poll_interval=poll_interval,
        task_ref=task_ref, error_cls=_Err,
    ))


def test_transient_network_error_does_not_consume_poll_budget(monkeypatch):
    # 关键不变式：抖动不吃 max_polls。否则一次切节点等价于偷偷缩短轮询窗口，
    # 15-30 分钟的长任务会在真出结果前被判超时。
    seen: list[str] = []
    script = [requests.ConnectionError("boom"), requests.ConnectionError("boom")]
    monkeypatch.setattr(video_poll.requests, "get", _scripted_get(script, seen))

    got = _drain(max_polls=2)

    assert len(got) == 2, "两次网络异常后仍应剩满 2 次预算"
    assert len(seen) == 4, "两次异常 + 两次真轮询"


def test_success_resets_consecutive_counter(monkeypatch):
    # 抖一下→成功→再抖一下 不该累加成「连续失败」，否则长任务里零星抖动会攒够阈值误杀。
    monkeypatch.setattr(video_poll, "_TRANSIENT_WINDOW_SECONDS", 3.0)  # poll_interval=0 → 阈值 3
    script = []
    for _ in range(3):
        script += [requests.ConnectionError("blip"), requests.ConnectionError("blip"), _Resp(200)]
    monkeypatch.setattr(video_poll.requests, "get", _scripted_get(script, []))

    assert len(_drain(max_polls=3)) == 3


def test_abandons_after_consecutive_failures_and_names_task_id(monkeypatch):
    monkeypatch.setattr(video_poll, "_TRANSIENT_WINDOW_SECONDS", 3.0)
    monkeypatch.setattr(
        video_poll.requests, "get",
        _scripted_get([requests.ConnectionError("down")] * 50, []),
    )

    with pytest.raises(_Err) as excinfo:
        _drain(max_polls=99, task_ref="cgt-20260813-abc")

    assert "cgt-20260813-abc" in str(excinfo.value)
    assert isinstance(excinfo.value.__cause__, requests.RequestException), "原始异常须留在 __cause__"


def test_5xx_is_transient_but_4xx_reaches_caller(monkeypatch):
    # 上游从不用 5xx 表达任务结论；把 5xx 当任务失败＝拿网关抽风给已计费任务判死刑。
    seen: list[str] = []
    script = [_Resp(503), _Resp(502), _Resp(200)]
    monkeypatch.setattr(video_poll.requests, "get", _scripted_get(script, seen))
    assert len(_drain(max_polls=1)) == 1
    assert len(seen) == 3

    # 401/403/404 重试无用，必须原样交给调用方按厂商文案报错。
    monkeypatch.setattr(video_poll.requests, "get", _scripted_get([_Resp(404)], []))
    got = _drain(max_polls=1)
    assert [r.status_code for r in got] == [404]


def test_429_is_transient(monkeypatch):
    monkeypatch.setattr(video_poll.requests, "get", _scripted_get([_Resp(429), _Resp(200)], []))
    assert len(_drain(max_polls=1)) == 1


def test_transient_limit_tracks_wall_clock_not_call_count():
    # 四家 poll_interval 差 3 倍，按次数定阈值会让同一次故障在不同厂商忍耐时长不一致。
    assert video_poll._transient_limit(5.0) == 18   # Seedance / 可灵：18×5s ≈ 90s
    assert video_poll._transient_limit(15.0) == 6   # HappyHorse / OpenRouter：6×15s = 90s
    assert video_poll._transient_limit(0) >= video_poll._MIN_TRANSIENT_TRIES


def test_abandon_message_survives_friendly_error():
    """job_runner._friendly_error 会按英文关键词整条替换报错。

    放弃文案一旦带上 timed out / connection reset / gateway 之类的词，就会被换成
    一句通用提示，辛苦带上的 task_id 直接蒸发——人工找回的钩子没了。
    这条测试把「文案不许命中翻译表」钉死。
    """
    for status in (None, 504, 500):
        msg = video_poll._abandon_message("cgt-keep-me", 6, status)
        assert _friendly_error(RuntimeError(msg)) == msg
        assert "cgt-keep-me" in _friendly_error(RuntimeError(msg))


def test_echoed_input_matching_ignores_query_string():
    # 预签名直链回显时 query 常被改写，按去 query 的路径也要能认出是自己发出去的。
    sent = video_poll.sent_url_set(["https://oss.example/refs/a.mp4?sig=1&exp=2"])
    assert video_poll.is_echoed_input("https://oss.example/refs/a.mp4?sig=9", sent)
    assert video_poll.is_echoed_input("https://oss.example/refs/a.mp4", sent)
    assert not video_poll.is_echoed_input("https://cdn.example/out/real.mp4", sent)
    # 本地路径 / data-url 不进排除集（不是 http，回显也不会被当下载地址）
    assert video_poll.sent_url_set(["/tmp/clip.mp4", "data:video/mp4;base64,AA"]) == set()
