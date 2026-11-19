"""第 2 批 A2：主机重启后续查视频任务——凭已存订单只轮询，不再提交。

真实的视频 caller，只替换 requests 的网络调用（假上游）。崩溃用不继承 Exception 的异常模拟：
run_task 接不住，任务停在执行中，再走 recover_after_restart + run_task 续查。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from character_workflow.lib import gateway_keys, gateway_quota, gateway_tasks, keys, model_routes
from character_workflow.lib.callers import evolink, evolink_video, openrouter_video, video_poll

MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 32
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


class _Crash(BaseException):
    """主机进程在轮询途中崩溃。"""


def _resp(payload=None, *, status=200, content=b""):
    return SimpleNamespace(status_code=status, ok=200 <= status < 300, content=content,
                           headers={}, json=lambda: payload,
                           raise_for_status=lambda: None)


@pytest.fixture(autouse=True)
def isolated(isolated_data_root, monkeypatch):
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    monkeypatch.setattr(video_poll.time, "sleep", lambda _seconds: None)  # 不真等轮询间隔
    yield
    model_routes._cooldowns.clear()


def _owner(alias, provider, base_url, model):
    keys.add_key(keys.KeySpec(alias=alias, provider=provider, access_key="fake-test-secret",
                              base_url=base_url, modalities=["video"], created_at="test",
                              models=[keys.ModelSpec(id=model, name=model, modality="video")]))
    return gateway_keys.create_key("小王")[0]


def _submit(owner, model, files=None):
    task = gateway_tasks.submit(owner, idempotency_key="v1", model=model, prompt="海边的灯塔", n=1,
                                size=None, params={"duration": 5}, files=files or {}, kind="video")
    return gateway_tasks._update(task.task_id, status="running")


def _crash_then_resume(task):
    with pytest.raises(_Crash):
        gateway_tasks.run_task(task)
    waiting = gateway_tasks._read(task.task_id)
    gateway_tasks.recover_after_restart()
    resumed = gateway_tasks._read(task.task_id)
    assert resumed.status == "pending" and resumed.phase == "resuming"
    return waiting, gateway_tasks.run_task(resumed)


# ---------------------------------------------------------------- EvoLink 可灵视频


def test_evolink_video_resumes_by_polling_without_resubmitting_or_reuploading(monkeypatch):
    owner = _owner("evo", "evolink", "https://api.evolink.ai/v1", "kling-v4-text-to-video")
    counts = {"posts": 0, "uploads": 0, "polls": 0}

    def upload(value, _key):
        counts["uploads"] += 1
        return "https://files/source.png"

    def post(url, **_kwargs):
        counts["posts"] += 1
        return _resp({"id": "evo-task-1", "status": "pending"})

    def get(url, **_kwargs):
        if url == "https://cdn/out.mp4":
            return _resp(content=MP4)
        counts["polls"] += 1
        if counts["polls"] == 1:
            raise _Crash()
        # 上游把输入素材也回显在结果里：续查时要用提交时存下的回显集合把它滤掉。
        return _resp({"id": "evo-task-1", "status": "completed",
                      "results": ["https://files/source.png", "https://cdn/out.mp4"],
                      "usage": {"cost": {"usd": 0.28}}})

    monkeypatch.setattr(evolink, "_reference_url", upload)
    monkeypatch.setattr(evolink_video.requests, "post", post)
    monkeypatch.setattr(evolink_video.requests, "get", get)
    task = _submit(owner, "evolink:kling-v4-text-to-video", files={"ref": [("a.png", PNG)]})
    waiting, done = _crash_then_resume(task)

    video = waiting.resume_params["video"]
    assert video["protocol"] == "evolink" and video["tasks"] == [{"id": "evo-task-1"}]
    assert video["sent"] == ["https://files/source.png"]
    assert counts["posts"] == 1 and counts["uploads"] == 1  # 续查期间提交 0 次、上传 0 次
    assert done.status == "done" and len(done.outputs) == 1
    assert done.actual_cost_source == "upstream" and done.charged_cny == pytest.approx(1.96)
    assert len(gateway_tasks.read_usage(gateway_tasks._now().astimezone().strftime("%Y-%m"))) == 1


def test_evolink_video_with_an_unconfirmed_submission_is_not_resumed(monkeypatch):
    owner = _owner("evo", "evolink", "https://api.evolink.ai/v1", "kling-v4-flash-text-to-video")
    posts = []

    def post(url, **_kwargs):
        posts.append(url)
        if len(posts) == 1:
            return _resp({"id": "evo-task-1", "status": "pending"})
        return _resp({}, status=503)  # 第二单提交结果未确认

    def get(url, **_kwargs):
        raise _Crash()

    monkeypatch.setattr(evolink_video.requests, "post", post)
    monkeypatch.setattr(evolink_video.requests, "get", get)
    task = gateway_tasks.submit(owner, idempotency_key="v2", model="evolink:kling-v4-flash-text-to-video",
                                prompt="海边", n=2, size=None, params={"duration": 5}, files={},
                                kind="video")
    task = gateway_tasks._update(task.task_id, status="running")
    failed = gateway_tasks.run_task(task)  # 第二单 503：未确认，不换家
    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed")
    assert len(posts) == 2


def test_unconfirmed_attempt_blocks_video_resume_after_restart(monkeypatch):
    owner = _owner("evo", "evolink", "https://api.evolink.ai/v1", "kling-v4-flash-text-to-video")
    task = _submit(owner, "evolink:kling-v4-flash-text-to-video")
    gateway_tasks._update(task.task_id, submission_attempts=[
        {"attempt": 1, "outcome": "response"}, {"attempt": 2, "outcome": "unconfirmed"}],
        resume_params={"video": {"protocol": "evolink", "tasks": [{"id": "evo-task-1"}],
                                 "sent": []}},
        member_alias="evo", member_model_id="kling-v4-flash-text-to-video")
    gateway_tasks.recover_after_restart()
    failed = gateway_tasks._read(task.task_id)
    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed")


# ---------------------------------------------------------------- OpenRouter 视频


def test_openrouter_video_resumes_with_the_saved_polling_url(monkeypatch):
    owner = _owner("OR", "openrouter", "https://openrouter.ai/api/v1", "google/veo-3.1")
    counts = {"posts": 0, "polls": 0}
    polling_url = "https://openrouter.ai/api/v1/videos/job1/status-by-upstream"

    def post(url, **_kwargs):
        counts["posts"] += 1
        return _resp({"id": "job1", "polling_url": polling_url, "status": "pending"})

    def get(url, **_kwargs):
        if url.endswith("/content?index=0"):
            return _resp(content=MP4)
        assert url == polling_url  # 续查用的是提交时上游给的地址，不是自己拼的
        counts["polls"] += 1
        if counts["polls"] == 1:
            raise _Crash()
        return _resp({"id": "job1", "status": "completed",
                      "unsigned_urls": ["https://openrouter.ai/api/v1/videos/job1/content?index=0"],
                      "usage": {"cost": 0.25}})

    monkeypatch.setattr(openrouter_video.requests, "post", post)
    monkeypatch.setattr(openrouter_video.requests, "get", get)
    task = _submit(owner, "openrouter:veo-3.1")
    waiting, done = _crash_then_resume(task)

    assert waiting.upstream_task_ids == ["job1"]  # 订单号拿到就上报（以前不报）
    assert waiting.resume_params["video"] == {
        "protocol": "openrouter", "tasks": [{"id": "job1", "poll_url": polling_url}]}
    assert counts["posts"] == 1
    assert done.status == "done" and done.actual_cost_source == "upstream"
    assert done.charged_cny == pytest.approx(1.75)


def test_openrouter_video_failure_after_submission_never_fails_over(monkeypatch):
    """以前 OpenRouter 视频不上报订单号：提交后失败会被当成没执行、换别家重提。"""
    owner = _owner("OR", "openrouter", "https://openrouter.ai/api/v1", "google/veo-3.1")
    posts = []
    monkeypatch.setattr(openrouter_video.requests, "post", lambda url, **_k: posts.append(url) or _resp(
        {"id": "job1", "polling_url": f"{url}/job1"}))
    monkeypatch.setattr(openrouter_video.requests, "get",
                        lambda url, **_k: _resp({"error": {"message": "api 503"}}, status=503))
    monkeypatch.setattr(openrouter_video.video_poll, "_transient_limit", lambda _interval: 1)
    failed = gateway_tasks.run_task(_submit(owner, "openrouter:veo-3.1"))
    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed")
    assert len(posts) == 1


def test_video_without_resume_entry_stays_unconfirmed_after_restart(monkeypatch):
    owner = _owner("evo", "evolink", "https://api.evolink.ai/v1", "kling-v4-flash-text-to-video")
    task = _submit(owner, "evolink:kling-v4-flash-text-to-video")
    gateway_tasks._update(task.task_id, member_alias="evo",
                          member_model_id="kling-v4-flash-text-to-video",
                          resume_params={"video": {"protocol": "seedance",
                                                   "tasks": [{"id": "ark-1"}]}})
    gateway_tasks.recover_after_restart()
    failed = gateway_tasks._read(task.task_id)
    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed")
