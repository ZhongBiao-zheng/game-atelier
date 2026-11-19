"""第 5 批 5-1：异步任务提交的统一判据（callers/task_submission）。

各视频协议都用真实 caller，只替换 requests 的网络调用（假上游）。判据（2026-11-19 飙哥定 Q1-1=A）：
任何网络异常（含连接建立前）、HTTP ≥ 500、2xx 非 JSON、2xx 无任务号都算「未确认」——不重发、不换家、扣 0；
4xx 是明确拒绝。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
import requests

from character_workflow.lib import gateway_keys, gateway_quota, gateway_tasks, keys, model_routes
from character_workflow.lib.callers import task_submission

HK = "https://api.openai-hk.com/v1"
TD = "https://tokendance.space/gateway/v1"

# (协议, 供应商, base_url, 模型, 路由 id, 上游受理时的响应)
PROTOCOLS = [
    ("kling", "custom", HK, "kling-v2-6", "kling:kling-v2-6",
     {"data": {"task_id": "t-1", "task_status": "submitted"}}),
    ("dashscope", "tokendance", TD, "happyhorse-1.0-t2v", "dashscope:happyhorse-1.0-t2v",
     {"output": {"task_id": "t-1", "task_status": "PENDING"}}),
    ("openrouter", "openrouter", "https://openrouter.ai/api/v1", "google/veo-3.1",
     "openrouter:veo-3.1", {"id": "t-1", "polling_url": "https://openrouter.ai/api/v1/videos/t-1"}),
]
IDS = [item[0] for item in PROTOCOLS]


class _Stop(BaseException):
    """提交成功后不再往下轮询：本文件只关心提交。"""


def _resp(payload=None, *, status=200, json_error=False):
    def as_json():
        if json_error:
            raise ValueError("not json")
        return payload

    return SimpleNamespace(status_code=status, ok=200 <= status < 300, headers={},
                           json=as_json, text="<html>", content=b"",
                           raise_for_status=lambda: None)


FAULTS = {
    "aborted": lambda: requests.ConnectionError("('Connection aborted.', RemoteDisconnected())"),
    "read_timeout": lambda: requests.ReadTimeout("read timed out"),
    "connect_refused": lambda: requests.ConnectionError("Failed to establish a new connection"),
    "503_no_channel": lambda: _resp({"error": {"message": "无可用渠道 no available channel"}},
                                    status=503),
    "2xx_not_json": lambda: _resp(json_error=True),
    "2xx_no_task_id": lambda: _resp({"status": "ok"}),
}


@pytest.fixture(autouse=True)
def isolated(isolated_data_root, monkeypatch):
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    yield
    model_routes._cooldowns.clear()


def _two_members(provider, base_url, model, protocol):
    for alias, secret in (("first", "first-test-secret"), ("second", "second-test-secret")):
        keys.add_key(keys.KeySpec(
            alias=alias, provider=provider, access_key=secret, base_url=base_url,
            modalities=["video"], created_at="test",
            models=[keys.ModelSpec(id=model, name=model, modality="video", protocol=protocol)]))
    return gateway_keys.create_key("小王")[0]


def _gateway_task(owner, route_id):
    task = gateway_tasks.submit(owner, idempotency_key="k1", model=route_id, prompt="海边的灯塔",
                                n=1, size=None, params={"duration": 5}, files={}, kind="video")
    return gateway_tasks._update(task.task_id, status="running")


def _posting(monkeypatch, outcome):
    posts: list[str] = []

    def post(url, headers=None, **_kwargs):
        posts.append(str((headers or {}).get("Authorization", "")))
        result = outcome()
        if isinstance(result, BaseException):
            raise result
        return result

    def get(url, **_kwargs):
        raise _Stop()

    monkeypatch.setattr(requests, "post", post)
    monkeypatch.setattr(requests, "get", get)
    return posts


@pytest.mark.parametrize("fault", list(FAULTS))
@pytest.mark.parametrize(("protocol", "provider", "base_url", "model", "route_id", "_ok"),
                         PROTOCOLS, ids=IDS)
def test_unsure_submission_is_unconfirmed_and_never_fails_over(
        monkeypatch, protocol, provider, base_url, model, route_id, _ok, fault):
    owner = _two_members(provider, base_url, model, protocol)
    posts = _posting(monkeypatch, FAULTS[fault])
    failed = gateway_tasks.run_task(_gateway_task(owner, route_id))

    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed"), failed.error
    assert failed.charged_cny == 0
    assert len(posts) == 1 and "second" not in posts[0]  # 不重发，也不换到第二把 KEY
    [attempt] = failed.submission_attempts
    assert attempt["outcome"] == "unconfirmed" and attempt["started_at"]


@pytest.mark.parametrize(("protocol", "provider", "base_url", "model", "route_id", "_ok"),
                         PROTOCOLS, ids=IDS)
def test_4xx_is_a_rejection_recorded_as_a_response(
        monkeypatch, protocol, provider, base_url, model, route_id, _ok):
    owner = _two_members(provider, base_url, model, protocol)
    _posting(monkeypatch, lambda: _resp({"error": {"message": "prompt 不合规"}}, status=400))
    failed = gateway_tasks.run_task(_gateway_task(owner, route_id))

    assert failed.status == "failed" and failed.error_kind != "unconfirmed"
    assert [a["outcome"] for a in failed.submission_attempts] == ["response"]


@pytest.mark.parametrize(("protocol", "provider", "base_url", "model", "route_id", "ok"),
                         PROTOCOLS, ids=IDS)
def test_second_order_dropped_after_the_first_was_accepted(
        monkeypatch, protocol, provider, base_url, model, route_id, ok):
    owner = _two_members(provider, base_url, model, protocol)
    answers = iter([lambda: _resp(ok), FAULTS["aborted"]])
    posts = _posting(monkeypatch, lambda: next(answers)())
    task = gateway_tasks.submit(owner, idempotency_key="k2", model=route_id, prompt="海边的灯塔",
                                n=2, size=None, params={"duration": 5}, files={}, kind="video")
    failed = gateway_tasks.run_task(gateway_tasks._update(task.task_id, status="running"))

    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed")
    assert failed.upstream_task_ids == ["t-1"] and len(posts) == 2
    assert [a["outcome"] for a in failed.submission_attempts] == ["response", "unconfirmed"]


def test_error_types_keep_their_caller_class_and_are_unconfirmed_by_type():
    from character_workflow.lib.callers import happyhorse_video, kling_video, openrouter_video
    from character_workflow.lib.model_routes import failover_reason

    pairs = [(kling_video.KlingVideoError, kling_video.KlingVideoUnconfirmed),
             (happyhorse_video.HappyHorseVideoError, happyhorse_video.HappyHorseVideoUnconfirmed),
             (openrouter_video.OpenRouterVideoError, openrouter_video.OpenRouterVideoUnconfirmed)]
    for base, unconfirmed in pairs:
        assert issubclass(unconfirmed, base)
        assert issubclass(unconfirmed, task_submission.SubmissionUnconfirmed)
        # 文案里没有「未确认」、链上有连接建立前的失败：仍按类型判未确认，不换家。
        error = unconfirmed("HTTP 503 无可用渠道")
        error.__cause__ = requests.ConnectTimeout("connect timed out")
        assert task_submission.is_unconfirmed(error)
        assert failover_reason(error) is None


def test_local_auto_video_job_does_not_fail_over_after_an_unsure_submission(monkeypatch):
    from character_workflow.lib import job_runner
    from character_workflow.lib.jobs import read_job, save_job
    from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus

    _two_members("custom", HK, "kling-v2-6", "kling")
    route = model_routes.find_route("video", "kling:kling-v2-6")
    posts = _posting(monkeypatch, FAULTS["aborted"])
    save_job(Job(job_id="local-1", character_id="A", prompt="海边的灯塔",
                 submitted_at="2026-11-19T00:00:00+00:00", model="kling-v2-6",
                 params=JobParams(n=1, duration=5, route_id=route.id), output_paths=[],
                 status=JobStatus.PENDING, error=None, kind=JobKind.VIDEO, namespace="studio",
                 alias="first", provider="custom"))
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job("local-1")
    job = read_job("local-1")
    assert job.status == JobStatus.FAILED and job.alias == "first"
    assert len(posts) == 1
    assert [a.outcome for a in job.params.video_submission_attempts] == ["unconfirmed"]
