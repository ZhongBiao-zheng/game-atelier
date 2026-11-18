"""第 2 批 A1：主机重启后续查网关任务——不丢、不重复提交、不重复扣。全部本机假上游。"""
import base64
import copy
from datetime import timedelta
from pathlib import Path

import pytest

from character_workflow.lib import (
    callers, gateway_keys, gateway_quota, gateway_tasks, keys, model_routes,
)
from character_workflow.lib.callers import openai_image
from tests.test_gateway import _png, _seed_keys


class _Crash(BaseException):
    """模拟主机进程在轮询途中崩溃：不是 Exception，run_task 接不住，任务停在执行中。"""


# 各 caller 拿到订单后落进 params 的续查状态（键与 lib/jobs.py 的本机续查相同）。
STATES = {
    "tuzi_images": {"provider_task_protocol": "tuzi_images", "provider_task_ids": ["up-1"]},
    "declarative": {"provider_task_protocol": "declarative", "provider_task_ids": ["up-1"]},
    "evolink": {"provider_task_protocol": "evolink", "provider_task_ids": ["up-1"],
                "evolink_state": {"task_id": "up-1", "channel": "c"}},
    "yinchao": {"provider_task_protocol": "yinchao", "provider_task_ids": ["up-1"]},
    "mj_proxy": {"mj_submission_ids": ["up-1"], "mj_submit_uncertain": False},
}


@pytest.fixture(autouse=True)
def isolated_state(isolated_data_root, monkeypatch):
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    yield
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()


@pytest.fixture
def owner():
    _seed_keys()
    return gateway_keys.create_key("小王", [{"period": "day", "cap_cny": 1}])[0]


def _submit(owner, nonce="one"):
    task = gateway_tasks.submit(owner, idempotency_key=nonce, model="gpt-image-2", prompt="猫",
                                n=1, size=None, params={}, files={})
    return gateway_tasks._update(task.task_id, status="running")  # pump 会做的事


def _caller(calls, state, *, fail_on_resume=None):
    """第一次调用：提交（计数）、落订单、然后崩溃；带着订单再调用：只轮询。"""
    def fake(*, alias, output_dir, params, on_params_changed, **_kwargs):
        if any(params.get(name) for name in state):
            calls.append(("poll", alias, {k: params.get(k) for k in state}))
            if fail_on_resume is not None:
                raise fail_on_resume
            out = Path(output_dir) / "v1.png"
            _png(out)
            return [str(out)]
        calls.append(("submit", alias, None))
        params.update(copy.deepcopy(state))
        on_params_changed()
        raise _Crash()
    return fake


def _crash_then_restart(owner, monkeypatch, calls, state, **kwargs):
    monkeypatch.setattr(callers, "dispatch", _caller(calls, state, **kwargs))
    task = _submit(owner)
    with pytest.raises(_Crash):
        gateway_tasks.run_task(task)
    gateway_tasks.recover_after_restart()
    return gateway_tasks._read(task.task_id)


def _rows():
    return gateway_tasks.read_usage(gateway_tasks._now().astimezone().strftime("%Y-%m"))


@pytest.mark.parametrize("name", sorted(STATES))
def test_restart_resumes_the_saved_order_without_resubmitting(owner, monkeypatch, name):
    calls = []
    waiting = _crash_then_restart(owner, monkeypatch, calls, STATES[name])
    assert waiting.status == "pending" and waiting.phase == "resuming"
    assert waiting.resume_params == STATES[name]
    # 续查期间预占还在。
    assert gateway_quota.usage_summary(owner)[0]["reserved_cny"] == .08

    done = gateway_tasks.run_task(waiting)
    assert [kind for kind, *_ in calls] == ["submit", "poll"]
    assert calls[1][2] == STATES[name]
    assert done.status == "done" and done.charged_cny == .08
    assert len(_rows()) == 1
    assert gateway_quota.usage_summary(owner)[0]["reserved_cny"] == 0


def test_resume_stays_on_the_original_member_even_when_it_is_cooling_down(owner, monkeypatch):
    calls = []
    waiting = _crash_then_restart(owner, monkeypatch, calls, STATES["tuzi_images"])
    first = calls[0][1]
    model_routes.cool_down("image", first, "rate_limited", seconds=600)
    gateway_tasks.run_task(waiting)
    assert [alias for _, alias, _ in calls] == [first, first]


def test_resume_failure_is_unconfirmed_and_never_fails_over(owner, monkeypatch):
    from character_workflow.lib.callers.openai_image import OpenAIImageError

    calls = []
    waiting = _crash_then_restart(owner, monkeypatch, calls, STATES["tuzi_images"],
                                  fail_on_resume=OpenAIImageError("image api 504: gateway timeout"))
    failed = gateway_tasks.run_task(waiting)
    assert [kind for kind, *_ in calls] == ["submit", "poll"]  # 504 本来会换下一家
    assert (failed.status, failed.error_kind, failed.charged_cny) == ("failed", "unconfirmed", 0)


def test_crash_during_resume_resumes_again_with_one_submission(owner, monkeypatch):
    calls = []
    waiting = _crash_then_restart(owner, monkeypatch, calls, STATES["declarative"],
                                  fail_on_resume=_Crash())
    with pytest.raises(_Crash):
        gateway_tasks.run_task(gateway_tasks._update(waiting.task_id, status="running"))
    gateway_tasks.recover_after_restart()
    monkeypatch.setattr(callers, "dispatch", _caller(calls, STATES["declarative"]))
    done = gateway_tasks.run_task(gateway_tasks._read(waiting.task_id))
    assert [kind for kind, *_ in calls] == ["submit", "poll", "poll"]
    assert done.status == "done" and len(_rows()) == 1


@pytest.mark.parametrize("state,remove_member", [
    ({"mj_submission_ids": ["up-1"], "mj_submit_uncertain": True}, False),  # MJ 提交未确认
    ({"provider_task_protocol": "seedance", "provider_task_ids": ["up-1"]}, False),  # 视频待 A2
    (STATES["tuzi_images"], True),  # 原供应商已删
])
def test_unresumable_running_tasks_stay_unconfirmed(owner, monkeypatch, state, remove_member):
    calls = []
    monkeypatch.setattr(callers, "dispatch", _caller(calls, state))
    task = _submit(owner)
    with pytest.raises(_Crash):
        gateway_tasks.run_task(task)
    if remove_member:
        keys.delete_key(calls[0][1])
    gateway_tasks.recover_after_restart()
    failed = gateway_tasks._read(task.task_id)
    assert (failed.status, failed.error_kind, failed.charged_cny) == ("failed", "unconfirmed", 0)
    assert [kind for kind, *_ in calls] == ["submit"]


def test_never_sent_task_stays_queued_and_is_not_cleaned_up(owner):
    task = gateway_tasks.submit(owner, idempotency_key="q", model="gpt-image-2", prompt="猫",
                                n=1, size=None, params={}, files={})
    gateway_tasks.recover_after_restart()
    assert gateway_tasks._read(task.task_id).status == "pending"
    assert gateway_tasks.cleanup(gateway_tasks._now() + timedelta(hours=25)) == 0
    assert gateway_tasks._read(task.task_id) is not None


def test_old_task_file_without_resume_params_reads(owner):
    import json

    task = _submit(owner)
    path = gateway_tasks._task_file(task.task_id)
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw.pop("resume_params", None)
    path.write_text(json.dumps(raw), encoding="utf-8")
    assert gateway_tasks._read(task.task_id).resume_params is None
    gateway_tasks.recover_after_restart()
    assert gateway_tasks._read(task.task_id).error_kind == "unconfirmed"


def test_real_tuzi_caller_resumes_by_polling_the_saved_order(isolated_data_root, monkeypatch,
                                                            tmp_path):
    """端到端：真实 openai_image（Tuzi 异步）路径，只替换最底层的 Tuzi 任务接口。"""
    keys.add_key(keys.KeySpec(
        alias="Tuzi", provider="custom", access_key="test-only", modalities=["image"],
        base_url="https://api.tu-zi.com", created_at="test",
        models=[keys.ModelSpec(id="gpt-image-2", name="gpt-image-2", modality="image")]))
    owner = gateway_keys.create_key("小李")[0]
    image = tmp_path / "out.png"
    _png(image)
    submitted, polled = [], []

    def execute_json(*, task_id, on_task_id, **_kwargs):
        if task_id is None:
            submitted.append(1)
            on_task_id("tuzi-task-1")
            raise _Crash()
        polled.append(task_id)
        return {"data": [{"b64_json": base64.b64encode(image.read_bytes()).decode("ascii")}]}

    monkeypatch.setattr(openai_image.tuzi_async, "execute_json", execute_json)
    task = _submit(owner)
    with pytest.raises(_Crash):
        gateway_tasks.run_task(task)
    gateway_tasks.recover_after_restart()
    done = gateway_tasks.run_task(gateway_tasks._read(task.task_id))
    assert submitted == [1] and polled == ["tuzi-task-1"]
    assert done.status == "done" and len(done.outputs) == 1


def test_mj_failure_after_submission_never_fails_over(owner, monkeypatch):
    """MJ 任务代理的提交号只在 mj_submission_ids 里（不进 upstream_task_ids）；
    提交后出可切换的错（504）也不能换家重提。"""
    from character_workflow.lib.callers.openai_image import OpenAIImageError

    calls = []

    def fake(*, alias, params, on_params_changed, **_kwargs):
        calls.append(alias)
        params.update(copy.deepcopy(STATES["mj_proxy"]))
        on_params_changed()
        raise OpenAIImageError("image api 504: gateway timeout")

    monkeypatch.setattr(callers, "dispatch", fake)
    failed = gateway_tasks.run_task(_submit(owner))
    assert len(calls) == 1
    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed")
