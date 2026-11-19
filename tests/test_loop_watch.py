"""第 4 批 4-2：事件循环卡顿取证、锁持有时长、网关线程看护。全部本机。"""
from __future__ import annotations

import asyncio
import logging
import socket
import time

import pytest

from character_workflow.lib import gateway_tasks
from character_workflow.lib.timed_lock import TimedLock
from viewer_server import gateway_app, loop_watch


@pytest.fixture(autouse=True)
def _fast_watcher(monkeypatch):
    monkeypatch.setattr(loop_watch, "_CHECK_SECONDS", 0.05)


def _blocked_loop(watch: loop_watch.LoopWatch, block_seconds: float) -> None:
    def stuck_somewhere_specific():
        time.sleep(block_seconds)  # 事件循环线程被同步调用卡住

    async def main():
        task = asyncio.create_task(watch.run())
        await asyncio.sleep(0.2)
        stuck_somewhere_specific()
        await asyncio.sleep(0.2)  # 恢复后打点协程补记「已恢复」
        task.cancel()

    asyncio.run(main())


def test_a_stalled_loop_dumps_every_thread_stack_once(caplog):
    caplog.set_level(logging.WARNING, logger="viewer_server.loop_watch")
    _blocked_loop(loop_watch.LoopWatch("测试", dump_after=0.3), 1.0)
    dumps = [r for r in caplog.records if "事件循环卡住" in r.getMessage()]
    assert len(dumps) == 1  # 同一次卡顿只写一次
    assert "stuck_somewhere_specific" in dumps[0].getMessage()  # 栈里有卡住的位置
    assert any("事件循环已恢复" in r.getMessage() for r in caplog.records)


def test_loop_lag_over_the_threshold_is_logged(caplog):
    caplog.set_level(logging.WARNING, logger="viewer_server.loop_watch")
    # 打点间隔 0.5 秒：卡 1 秒保证晚醒远超 0.1 秒的阈值（卡 0.4 秒时晚醒只有约 0.1 秒，Windows 上不稳）。
    _blocked_loop(loop_watch.LoopWatch("网关", dump_after=100, warn_after=0.1), 1.0)
    assert any("事件循环延迟 loop=网关" in r.getMessage() for r in caplog.records)
    assert not any("事件循环卡住" in r.getMessage() for r in caplog.records)


def test_a_finished_loop_is_no_longer_watched():
    watch = loop_watch.LoopWatch("短命", dump_after=0.1)

    async def main():
        task = asyncio.create_task(watch.run())
        await asyncio.sleep(0.1)
        task.cancel()

    asyncio.run(main())
    assert watch not in loop_watch._watches


def test_lock_held_too_long_is_logged_with_the_call_site(caplog):
    caplog.set_level(logging.WARNING, logger="character_workflow.lib.timed_lock")
    lock = TimedLock("测试锁", warn_after=0.05)
    with lock:
        time.sleep(0.1)
        with lock:  # 可重入：只量最外层（内层很快，外层持有了 0.1 秒）
            pass
    [record] = [r for r in caplog.records if "锁持有过久" in r.getMessage()]
    assert "lock=测试锁" in record.getMessage() and "test_loop_watch.py:" in record.getMessage()
    with lock:
        pass
    assert len([r for r in caplog.records if "锁持有过久" in r.getMessage()]) == 1


def test_lock_warnings_are_throttled(caplog):
    caplog.set_level(logging.WARNING, logger="character_workflow.lib.timed_lock")
    lock = TimedLock("测试锁", warn_after=0.0)
    # 每次持有 50 ms：Windows 的单调时钟精度约 15 ms，10 ms 的持有可能量成 0。
    for _ in range(3):
        with lock:
            time.sleep(0.05)
    assert len([r for r in caplog.records if "锁持有过久" in r.getMessage()]) == 1
    lock._throttle._last -= 60  # 过了限频窗口
    with lock:
        time.sleep(0.05)
    last = [r for r in caplog.records if "锁持有过久" in r.getMessage()][-1]
    assert "另有 2 次" in last.getMessage()


def test_gateway_task_lock_is_timed():
    assert isinstance(gateway_tasks._lock, TimedLock)


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_gateway_comes_up_once_its_port_is_freed(isolated_data_root, caplog):
    port = _free_port()
    server = gateway_app.GatewayServer(host="127.0.0.1")
    with socket.socket() as squatter:
        squatter.bind(("127.0.0.1", port))
        squatter.listen()
        server.start(port)
        assert not server.running and "已被占用" in server.error
        server.supervise_once()
        assert not server.running
    try:
        server.supervise_once()
        assert server.running and server.error is None
    finally:
        server.stop()
    server.supervise_once()  # 设置里关掉了：看护不再拉起
    assert not server.running


def test_a_dead_gateway_thread_is_restarted_without_recovering_running_tasks(
        isolated_data_root, monkeypatch):
    recovered = []
    monkeypatch.setattr(gateway_tasks, "recover_after_restart", lambda: recovered.append(1))
    server = gateway_app.GatewayServer(host="127.0.0.1")
    server.start(_free_port())
    try:
        assert recovered == [1]
        server._server.should_exit = True  # 网关线程意外退出
        server._thread.join(10)
        assert not server.running
        server.supervise_once()
        assert server.running and recovered == [1]  # 任务线程还在跑：不做重启恢复
    finally:
        server.stop()


def test_the_gateway_loop_is_watched_while_it_runs(isolated_data_root):
    server = gateway_app.GatewayServer(host="127.0.0.1")
    server.start(_free_port())
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not any(w.name == "网关" for w in loop_watch._watches):
            time.sleep(0.05)
        [watch] = [w for w in loop_watch._watches if w.name == "网关"]
        assert watch.warn_after == 0.2
    finally:
        server.stop()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and any(w.name == "网关" for w in loop_watch._watches):
        time.sleep(0.05)
    assert not any(w.name == "网关" for w in loop_watch._watches)


def test_the_main_service_loop_is_watched(isolated_data_root):
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app

    with LocalTestClient(base_url="http://127.0.0.1",
                         app=build_app(dist_dir=isolated_data_root / "dist")):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not any(
                w.name == "主服务" for w in loop_watch._watches):
            time.sleep(0.05)
        assert any(w.name == "主服务" for w in loop_watch._watches)
