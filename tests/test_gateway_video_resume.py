"""第 2 批 A2：主机重启后续查视频任务——凭已存订单只轮询，不再提交。

真实的视频 caller，只替换 requests 的网络调用（假上游）。崩溃用不继承 Exception 的异常模拟：
run_task 接不住，任务停在执行中，再走 recover_after_restart + run_task 续查。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from character_workflow.lib import gateway_keys, gateway_quota, gateway_tasks, keys, model_routes
from character_workflow.lib.callers import (
    evolink, evolink_video, happyhorse_video, kling_video, klingai_video, openrouter_video,
    video_poll, volcengine_video,
)

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


def _owner(alias, provider, base_url, model, protocol=None):
    keys.add_key(keys.KeySpec(alias=alias, provider=provider, access_key="fake-test-secret",
                              base_url=base_url, modalities=["video"], created_at="test",
                              models=[keys.ModelSpec(id=model, name=model, modality="video",
                                                     protocol=protocol)]))
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
    # 协议不在续查名单（自定义接口的视频没有续查入口）。
    gateway_tasks._update(task.task_id, member_alias="evo",
                          member_model_id="kling-v4-flash-text-to-video",
                          resume_params={"video": {"protocol": "declarative",
                                                   "tasks": [{"id": "decl-1"}]}})
    gateway_tasks.recover_after_restart()
    failed = gateway_tasks._read(task.task_id)
    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed")


# ---------------------------------------------------------------- Seedance（火山 Ark）

ARK = "https://ark.cn-beijing.volces.com/api/v3"
SEEDANCE = "doubao-seedance-2-0-fast-260128"


def test_seedance_resumes_without_reuploading_and_filters_the_echoed_reference(monkeypatch):
    owner = _owner("ark", "seedance", ARK, SEEDANCE)
    counts = {"posts": 0, "uploads": 0, "polls": 0}
    downloads = []

    def upload(path):
        counts["uploads"] += 1
        return "https://oss/ref.mp4?sig=1"

    def post(url, **_kwargs):
        counts["posts"] += 1
        return _resp({"id": "cgt-1", "status": "queued"})

    def get(url, **_kwargs):
        if url.startswith("https://cdn/") or url.startswith("https://oss/"):
            downloads.append(url)
            return _resp(content=MP4)
        counts["polls"] += 1
        if counts["polls"] == 1:
            raise _Crash()
        # 上游把输入的参考视频回显在 content 里、排在产物前面：要靠提交时存下的回显集合滤掉。
        return _resp({"id": "cgt-1", "status": "succeeded", "content": [
            {"video_url": {"url": "https://oss/ref.mp4?sig=1"}},
            {"video_url": "https://cdn/sd.mp4"}]})

    monkeypatch.setattr(volcengine_video.oss_upload, "upload_for_url", upload)
    monkeypatch.setattr(volcengine_video.requests, "post", post)
    monkeypatch.setattr(volcengine_video.requests, "get", get)
    task = _submit(owner, f"seedance:{SEEDANCE}", files={"video": [("ref.mp4", MP4)]})
    waiting, done = _crash_then_resume(task)

    video = waiting.resume_params["video"]
    assert video["protocol"] == "seedance" and video["tasks"] == [{"id": "cgt-1"}]
    assert "https://oss/ref.mp4?sig=1" in video["sent"]
    assert counts["posts"] == 1 and counts["uploads"] == 1  # 续查期间提交 0 次、上传 0 次
    assert downloads == ["https://cdn/sd.mp4"]
    assert done.status == "done" and len(done.outputs) == 1


# ---------------------------------------------------------------- 可灵旧版（OpenAI-HK）

HK = "https://api.openai-hk.com/v1"


def test_old_kling_resumes_on_the_saved_endpoint(monkeypatch):
    owner = _owner("HK", "custom", HK, "kling-v2-6")
    counts = {"posts": 0, "polls": 0}

    def post(url, **_kwargs):
        counts["posts"] += 1
        return _resp({"data": {"task_id": "kl-1", "task_status": "submitted"}})

    def get(url, **_kwargs):
        if url == "https://cdn/kl.mp4":
            return _resp(content=MP4)
        assert url == "https://api.openai-hk.com/kling/v1/videos/text2video/kl-1"
        counts["polls"] += 1
        if counts["polls"] == 1:
            raise _Crash()
        return _resp({"data": {"task_status": "succeed",
                               "task_result": {"videos": [{"url": "https://cdn/kl.mp4"}]}}})

    monkeypatch.setattr(kling_video.requests, "post", post)
    monkeypatch.setattr(kling_video.requests, "get", get)
    waiting, done = _crash_then_resume(_submit(owner, "kling:kling-v2-6"))

    assert waiting.upstream_task_ids == ["kl-1"]  # 订单号拿到就上报（以前不报）
    assert waiting.resume_params["video"] == {
        "protocol": "kling", "tasks": [{"id": "kl-1"}], "act": "text2video", "sent": []}
    assert counts["posts"] == 1
    assert done.status == "done" and len(done.outputs) == 1


def test_old_kling_failure_after_submission_never_fails_over(monkeypatch):
    """以前可灵旧版不上报订单号：提交后失败会被当成没执行、换别家重提。"""
    owner = _owner("HK", "custom", HK, "kling-v2-6")
    posts = []
    monkeypatch.setattr(kling_video.requests, "post", lambda url, **_k: posts.append(url) or _resp(
        {"data": {"task_id": "kl-1"}}))
    monkeypatch.setattr(kling_video.requests, "get",
                        lambda url, **_k: _resp({"message": "busy"}, status=503))
    monkeypatch.setattr(kling_video.video_poll, "_transient_limit", lambda _interval: 1)
    failed = gateway_tasks.run_task(_submit(owner, "kling:kling-v2-6"))
    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed")
    assert len(posts) == 1


# ---------------------------------------------------------------- 可灵新版（词元跳动）

TD = "https://tokendance.space/gateway/v1"


def test_new_kling_resumes_with_the_saved_task_url(monkeypatch):
    owner = _owner("td", "tokendance", TD, "kling-4.0")
    counts = {"posts": 0, "polls": 0}
    task_url = "https://tokendance.space/gateway/kling/v2/text2video"

    def post(url, **_kwargs):
        counts["posts"] += 1
        return _resp({"code": 0, "data": {"id": "ka-1", "status": "submitted"}})

    def get(url, **_kwargs):
        if url == "https://cdn/ka.mp4":
            return _resp(content=MP4)
        assert url == f"{task_url}/ka-1"
        counts["polls"] += 1
        if counts["polls"] == 1:
            raise _Crash()
        return _resp({"data": [{"status": "succeeded",
                                "outputs": [{"type": "video", "url": "https://cdn/ka.mp4"}]}]})

    monkeypatch.setattr(klingai_video.requests, "post", post)
    monkeypatch.setattr(klingai_video.requests, "get", get)
    waiting, done = _crash_then_resume(_submit(owner, "klingai:kling-4.0"))

    assert waiting.resume_params["video"] == {
        "protocol": "klingai", "tasks": [{"id": "ka-1"}], "url": task_url, "sent": []}
    assert counts["posts"] == 1
    assert done.status == "done" and len(done.outputs) == 1


# ---------------------------------------------------------------- DashScope（HappyHorse）

HAPPYHORSE = "happyhorse-1.0-t2v"


def test_dashscope_resumes_by_polling_the_saved_task(monkeypatch):
    owner = _owner("td", "tokendance", TD, HAPPYHORSE)
    counts = {"posts": 0, "polls": 0}

    def post(url, **_kwargs):
        counts["posts"] += 1
        return _resp({"output": {"task_id": "hh-1", "task_status": "PENDING"}})

    def get(url, **_kwargs):
        if url == "https://cdn/hh.mp4":
            return _resp(content=MP4)
        assert url == "https://tokendance.space/gateway/alibaba/happyhorse/v1/tasks/hh-1"
        counts["polls"] += 1
        if counts["polls"] == 1:
            raise _Crash()
        return _resp({"output": {"task_status": "SUCCEEDED", "video_url": "https://cdn/hh.mp4"}})

    monkeypatch.setattr(happyhorse_video.requests, "post", post)
    monkeypatch.setattr(happyhorse_video.requests, "get", get)
    waiting, done = _crash_then_resume(_submit(owner, f"dashscope:{HAPPYHORSE}"))

    assert waiting.upstream_task_ids == ["hh-1"]  # 订单号拿到就上报（以前不报）
    assert waiting.resume_params["video"] == {
        "protocol": "dashscope", "tasks": [{"id": "hh-1"}], "sent": []}
    assert counts["posts"] == 1
    assert done.status == "done" and len(done.outputs) == 1


def test_dashscope_failure_after_submission_never_fails_over(monkeypatch):
    owner = _owner("td", "tokendance", TD, HAPPYHORSE)
    posts = []
    monkeypatch.setattr(happyhorse_video.requests, "post", lambda url, **_k: posts.append(url) or _resp(
        {"output": {"task_id": "hh-1"}}))
    monkeypatch.setattr(happyhorse_video.requests, "get",
                        lambda url, **_k: _resp({"message": "busy"}, status=503))
    monkeypatch.setattr(happyhorse_video.video_poll, "_transient_limit", lambda _interval: 1)
    failed = gateway_tasks.run_task(_submit(owner, f"dashscope:{HAPPYHORSE}"))
    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed")
    assert len(posts) == 1


# ---------------------------------------------------------------- 停机期间 KEY 被改过


@pytest.mark.parametrize("other_member", [False, True], ids=["route-gone", "route-kept"])
def test_protocol_changed_while_down_ends_unconfirmed_without_polling(monkeypatch, other_member):
    """存下的是 Seedance 订单，KEY 改成按 DashScope 走：不把 Seedance 的续查状态交给别的 caller。

    route-gone：协议进了路由 id，原路由随之消失，在路由检查处判未确认。
    route-kept：另一把 KEY 仍提供同一路由，走到续查分支的协议核对。
    """
    owner = _owner("td", "tokendance", TD, "seedance-2.0", protocol="seedance")
    if other_member:
        keys.add_key(keys.KeySpec(
            alias="td2", provider="tokendance", access_key="fake-test-secret", base_url=TD,
            modalities=["video"], created_at="test",
            models=[keys.ModelSpec(id="seedance-2.0", name="seedance-2.0", modality="video",
                                   protocol="seedance")]))
    calls = []

    def get(url, **_kwargs):
        calls.append(url)
        raise _Crash()

    monkeypatch.setattr(volcengine_video.requests, "post",
                        lambda url, **_k: _resp({"id": "cgt-1", "status": "queued"}))
    monkeypatch.setattr(volcengine_video.requests, "get", get)
    task = _submit(owner, "seedance:seedance-2.0")
    with pytest.raises(_Crash):
        gateway_tasks.run_task(task)
    assert gateway_tasks._read(task.task_id).resume_params["video"]["protocol"] == "seedance"

    keys.patch_key("td", {"models": [keys.ModelSpec(id="seedance-2.0", name="seedance-2.0",
                                                    modality="video", protocol="dashscope")]})
    later = []
    monkeypatch.setattr(happyhorse_video.requests, "get", lambda url, **_k: later.append(url))
    monkeypatch.setattr(volcengine_video.requests, "get", lambda url, **_k: later.append(url))
    gateway_tasks.recover_after_restart()
    resumed = gateway_tasks._read(task.task_id)
    assert resumed.status == "pending" and resumed.phase == "resuming"
    failed = gateway_tasks.run_task(resumed)
    assert (failed.status, failed.error_kind) == ("failed", "unconfirmed")
    assert later == []  # 两个 caller 都没被拿来轮询
