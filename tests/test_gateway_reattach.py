"""第 2 批 B1：成员端接回网关上的原任务——幂等键与请求指纹落盘、再次生成接回、下载重试。

主机是真实的回环网关（tests.test_gateway_client 的 gateway 夹具），上游厂商是假的 render。
成员端的网络故障用一个可注入故障的 requests.Session 模拟。
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
import requests

from character_workflow.lib import gateway_tasks, job_runner, jobs
from character_workflow.lib.callers import atelier_gateway
from character_workflow.lib.callers.openai_image import OpenAIImageError
from character_workflow.lib.jobs import gateway_reattach_params, read_job, save_job
from character_workflow.lib.schemas import JobStatus
from tests import test_gateway_client as _harness
from tests.test_gateway_client import _job

# 复用接入端测试的真实回环网关夹具。
_fast = _harness._fast
gateway = _harness.gateway
upstream = _harness.upstream


class _Faults:
    """lost_posts：提交照发、回应丢失；down_gets / down_outputs：查询 / 下载连不上。"""

    def __init__(self):
        self.lost_posts = 0
        self.down_gets = 0
        self.down_outputs = 0


@pytest.fixture
def faults(monkeypatch):
    state = _Faults()

    class FaultySession(requests.Session):
        def request(self, method, url, *args, **kwargs):
            if method == "POST" and url.endswith("/gateway/v1/tasks") and state.lost_posts:
                state.lost_posts -= 1
                super().request(method, url, *args, **kwargs)
                raise requests.ReadTimeout("response lost")
            if method == "GET" and "/outputs/" in url and state.down_outputs:
                state.down_outputs -= 1
                raise requests.ConnectionError("download dropped")
            if (method == "GET" and "/gateway/v1/tasks/" in url and "/outputs/" not in url
                    and state.down_gets):
                state.down_gets -= 1
                raise requests.ConnectionError("poll dropped")
            return super().request(method, url, *args, **kwargs)

    def session():
        faulty = FaultySession()
        faulty.trust_env = False
        return faulty

    monkeypatch.setattr(atelier_gateway, "_session", session)
    monkeypatch.setattr(atelier_gateway, "DOWNLOAD_RETRY_DELAYS", (0, 0, 0))
    return state


def _host_tasks():
    return gateway_tasks._all_tasks()


def _now_job(job_id, *, prompt="一只猫", **params):
    """_job 的提交时间是固定的旧日期；接回有 20 小时窗口，这里改成现在。"""
    return save_job(_job(job_id, **params).model_copy(update={
        "prompt": prompt, "submitted_at": datetime.now(timezone.utc).isoformat()}))


def _fail_unconfirmed(job_id, faults):
    """第一次运行：提交三次都丢了回应（主机已建任务），成员端判「未确认」。"""
    faults.lost_posts = 3
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(_now_job(job_id).job_id)
    failed = read_job(job_id)
    assert failed.status == JobStatus.FAILED and "未确认" in failed.error
    return failed


def _regenerate(source, new_id, *, prompt="一只猫"):
    """模拟「再次生成」：新任务 + 服务端按原失败轮次继承的接回字段。"""
    job = _now_job(new_id, prompt=prompt, **gateway_reattach_params(source, "Hub"))
    return job_runner.run_job(job.job_id)


def test_key_and_fingerprint_are_saved_and_lost_submits_create_one_host_task(gateway, upstream,
                                                                             faults):
    failed = _fail_unconfirmed("job-lost", faults)
    assert failed.params.gateway_unconfirmed is True
    assert failed.params.gateway_idempotency_key and failed.params.gateway_request_fingerprint
    assert len(_host_tasks()) == 1  # 三次重发用同一个幂等键


def test_regenerate_with_the_same_request_reattaches_the_original_host_task(gateway, upstream,
                                                                           faults):
    failed = _fail_unconfirmed("job-a", faults)
    done = _regenerate(failed, "job-a2")
    assert done.status == JobStatus.DONE
    assert len(_host_tasks()) == 1 and len(upstream["calls"]) == 1
    assert done.params.gateway_idempotency_key == failed.params.gateway_idempotency_key
    assert done.params.gateway_reattach_of == "job-a"


def test_regenerate_after_changing_the_prompt_places_a_new_order(gateway, upstream, faults):
    failed = _fail_unconfirmed("job-b", faults)
    done = _regenerate(failed, "job-b2", prompt="一只狗")
    assert done.status == JobStatus.DONE
    assert len(_host_tasks()) == 2 and len(upstream["calls"]) == 2
    assert done.params.gateway_idempotency_key != failed.params.gateway_idempotency_key
    assert done.params.gateway_reattach_of is None


def test_reattached_original_that_failed_on_the_host_is_reordered_in_the_same_run(
        gateway, upstream, faults, monkeypatch):
    monkeypatch.setattr(atelier_gateway, "POLL_GIVE_UP_SECONDS", 0.3)
    upstream["fail"]["Local"] = OpenAIImageError("内容审核未通过")
    faults.down_gets = 10_000  # 成员端一直查不到：未确认
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(_now_job("job-c").job_id)
    failed = read_job("job-c")
    assert failed.params.gateway_unconfirmed is True
    faults.down_gets = 0
    for _ in range(100):  # 等主机把原任务跑成失败
        if _host_tasks()[0].status == "failed":
            break
        time.sleep(0.05)
    upstream["fail"].clear()
    done = _regenerate(failed, "job-c2")
    assert done.status == JobStatus.DONE
    assert len(_host_tasks()) == 2  # 原任务失败 → 同一次运行里换新键下新单
    assert done.params.gateway_idempotency_key != failed.params.gateway_idempotency_key


def test_host_confirmed_failure_regenerates_as_a_new_order(gateway, upstream, faults):
    upstream["fail"]["Local"] = OpenAIImageError("内容审核未通过")
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(_job("job-d").job_id)
    failed = read_job("job-d")
    assert not failed.params.gateway_unconfirmed
    assert gateway_reattach_params(failed, "Hub") == {}


def test_download_is_retried(gateway, upstream, faults):
    faults.down_outputs = 2
    done = job_runner.run_job(_job("job-e").job_id)
    assert done.status == JobStatus.DONE and len(_host_tasks()) == 1


def test_download_that_keeps_failing_is_unconfirmed_and_regenerate_downloads_the_same_result(
        gateway, upstream, faults):
    faults.down_outputs = 4
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(_now_job("job-f").job_id)
    failed = read_job("job-f")
    assert failed.params.gateway_unconfirmed is True and "下载失败" in failed.error
    done = _regenerate(failed, "job-f2")
    assert done.status == JobStatus.DONE
    assert len(_host_tasks()) == 1 and len(upstream["calls"]) == 1


def test_reattach_window_and_other_guards():
    params = SimpleNamespace(gateway_unconfirmed=True, gateway_idempotency_key="k",
                             gateway_request_fingerprint="f" * 64)
    now = datetime.now(timezone.utc)

    def source(**changes):
        base = dict(job_id="job-x", status=JobStatus.FAILED, provider="atelier", alias="Hub",
                    params=params, submitted_at=(now - timedelta(hours=1)).isoformat())
        return SimpleNamespace(**{**base, **changes})

    assert gateway_reattach_params(source(), "Hub")["gateway_reattach_of"] == "job-x"
    assert gateway_reattach_params(
        source(submitted_at=(now - timedelta(hours=21)).isoformat()), "Hub") == {}
    assert gateway_reattach_params(source(alias="Other"), "Hub") == {}
    assert gateway_reattach_params(source(status=JobStatus.DONE), "Hub") == {}
    assert gateway_reattach_params(source(provider="openai"), "Hub") == {}
    assert gateway_reattach_params(None, "Hub") == {}
    assert jobs.GATEWAY_REATTACH_WINDOW == timedelta(hours=20)


def test_canvas_regenerate_finds_the_latest_job_of_the_same_node(monkeypatch):
    from character_workflow.lib import canvas_runs

    params = SimpleNamespace(gateway_unconfirmed=True, gateway_idempotency_key="k",
                             gateway_request_fingerprint="f" * 64)
    now = datetime.now(timezone.utc)

    def job(job_id, surface, minutes_ago, status=JobStatus.FAILED):
        return SimpleNamespace(
            job_id=job_id, namespace="canvas", canvas_project_id="p1", status=status,
            provider="atelier", alias="Hub", params=params,
            submitted_at=(now - timedelta(minutes=minutes_ago)).isoformat(),
            canvas_run=SimpleNamespace(snapshot=SimpleNamespace(surface_node_id=surface)))

    monkeypatch.setattr(canvas_runs, "list_jobs", lambda: [
        job("old", "n1", 30), job("latest", "n1", 5), job("other-node", "n2", 1)])
    assert canvas_runs._gateway_reattach("p1", "n1", "Hub")["gateway_reattach_of"] == "latest"
    monkeypatch.setattr(canvas_runs, "list_jobs", lambda: [
        job("old", "n1", 30), job("latest-done", "n1", 5, status=JobStatus.DONE)])
    assert canvas_runs._gateway_reattach("p1", "n1", "Hub") == {}  # 最近一次已成功：新单


def test_studio_create_only_inherits_from_an_unconfirmed_failed_studio_job(gateway, upstream,
                                                                          faults, monkeypatch):
    from tests.local_client import LocalTestClient
    from viewer_server import routes
    from viewer_server.server_app import build_app

    monkeypatch.setattr(routes, "_start_studio_job_task", lambda job_id: None)
    failed = _fail_unconfirmed("job-g", faults)
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    body = {"prompt": "一只猫", "model": "gpt-image-2", "alias": "Hub", "params": {"n": 1}}
    created = client.post("/api/studio/jobs", json={**body, "reattach_job_id": "job-g"})
    assert created.status_code == 201
    assert created.json()["params"]["gateway_idempotency_key"] == \
        failed.params.gateway_idempotency_key
    # 浏览器自己塞的网关字段一律丢弃。
    forged = client.post("/api/studio/jobs", json={**body, "params": {
        "n": 1, "gateway_idempotency_key": "forged", "gateway_reattach_of": "job-g"}})
    assert forged.json()["params"].get("gateway_idempotency_key") is None
    assert client.post("/api/studio/jobs",
                       json={**body, "reattach_job_id": "../x"}).status_code == 422
