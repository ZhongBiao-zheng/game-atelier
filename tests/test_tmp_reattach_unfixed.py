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


class _Crash(BaseException):
    """成员端进程在发送途中死掉：不是 Exception，谁也接不住。"""


class _Faults:
    """lost_posts：提交照发、回应丢失；down_gets / down_outputs：查询 / 下载连不上。"""

    def __init__(self):
        self.lost_posts = 0
        self.down_posts = 0      # 提交时连接都没建立（主机没收到）
        self.crash_posts = 0     # 提交途中成员端进程崩溃
        self.down_gets = 0
        self.down_outputs = 0


@pytest.fixture
def faults(monkeypatch):
    state = _Faults()

    class FaultySession(requests.Session):
        def request(self, method, url, *args, **kwargs):
            if method == "POST" and url.endswith("/gateway/v1/tasks") and state.crash_posts:
                state.crash_posts -= 1
                raise _Crash()
            if method == "POST" and url.endswith("/gateway/v1/tasks") and state.down_posts:
                state.down_posts -= 1
                raise requests.ConnectTimeout("connect timed out")
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


def _key(hours_ago: float) -> str:
    return f"{int(time.time() - hours_ago * 3600)}-{'0' * 32}"


def test_reattach_window_and_other_guards():
    def params(key):
        return SimpleNamespace(gateway_unconfirmed=True, gateway_idempotency_key=key,
                               gateway_request_fingerprint="f" * 64)

    def source(key=None, **changes):
        base = dict(job_id="job-x", status=JobStatus.FAILED, provider="atelier", alias="Hub",
                    params=params(key or _key(1)),
                    submitted_at=datetime.now(timezone.utc).isoformat())
        return SimpleNamespace(**{**base, **changes})

    assert gateway_reattach_params(source(), "Hub")["gateway_reattach_of"] == "job-x"
    # 窗口按幂等键第一次发出的时间算，不按任务提交时间：刚提交的任务带着 21 小时前的键也不接回。
    assert gateway_reattach_params(source(_key(21)), "Hub") == {}
    assert gateway_reattach_params(source("legacy-key-without-time"), "Hub") == {}
    assert gateway_reattach_params(source(alias="Other"), "Hub") == {}
    assert gateway_reattach_params(source(status=JobStatus.DONE), "Hub") == {}
    assert gateway_reattach_params(source(provider="openai"), "Hub") == {}
    assert gateway_reattach_params(None, "Hub") == {}
    assert jobs.GATEWAY_REATTACH_WINDOW == timedelta(hours=20)


def test_canvas_regenerate_finds_the_latest_job_of_the_same_node(monkeypatch):
    from character_workflow.lib import canvas_runs

    params = SimpleNamespace(gateway_unconfirmed=True, gateway_idempotency_key=_key(1),
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


# ---------------------------------------------------------------- 真实建任务入口
# 第一次任务以「网关未确认」失败后，不改任何输入、经真实入口再次生成：
# 新任务算出的指纹必须与原任务落盘的指纹相等，主机任务数为 1。


def _png_bytes() -> bytes:
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 80, 40)).save(buffer, format="PNG")
    return buffer.getvalue()


def _canvas_project() -> str:
    """参考图节点连到生成节点（指定 Hub）的画布项目。"""
    from character_workflow.lib.canvas_projects import (
        create_canvas_project, read_canvas_document, replace_canvas_node_media,
        save_canvas_document,
    )
    from character_workflow.lib.schemas import CanvasDocument

    now = datetime.now(timezone.utc).isoformat()
    pid = create_canvas_project("网关接回").project_id
    current = read_canvas_document(pid)
    payload = current.model_dump(mode="json")
    payload.update({
        "nodes": [
            {"id": "ref", "title": "参考", "type": "image", "position": {"x": 0, "y": 0},
             "z_index": 0, "data": {"current_version_id": None, "generation_draft": None,
                                    "active_run_id": None,
                                    "display": {"fit": "contain", "free_resize": False}}},
            {"id": "config", "title": "生成", "type": "image", "position": {"x": 300, "y": 0},
             "z_index": 0, "data": {"generation_draft": {
                 "mode": "image", "prompt": "一只纸雕狐狸", "input_policy": "all_connected",
                 "model": "gpt-image-2", "alias": "Hub", "params": {"ratio": "1:1"},
                 "updated_at": now}}},
        ],
        "connections": [{"id": "edge-ref", "role": "input", "source_node_id": "ref",
                         "target_node_id": "config"}],
    })
    saved = save_canvas_document(pid, CanvasDocument.model_validate(payload), current.revision)
    _v, saved, _ = replace_canvas_node_media(pid, "ref", "ref.png", ".png", _png_bytes(), "image",
                                             saved.revision)

    return pid


def test_studio_regenerate_through_the_real_route_keeps_the_fingerprint(gateway, upstream, faults,
                                                                        monkeypatch):
    from tests.local_client import LocalTestClient
    from viewer_server import routes
    from viewer_server.server_app import build_app

    monkeypatch.setattr(routes, "_start_studio_job_task", lambda job_id: None)
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    uploaded = client.post("/api/uploads", files={"file": ("ref.png", _png_bytes(), "image/png")})
    assert uploaded.status_code == 200
    body = {"prompt": "一只橘猫", "model": "gpt-image-2", "alias": "Hub",
            "params": {"n": 1, "ratio": "1:1", "size_mode": "ratio",
                       "reference_images": [uploaded.json()["path"]]}}

    first = client.post("/api/studio/jobs", json=body).json()
    faults.lost_posts = 3
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(first["job_id"])
    failed = read_job(first["job_id"])
    assert failed.params.gateway_unconfirmed is True

    second = client.post("/api/studio/jobs", json={**body, "reattach_job_id": failed.job_id}).json()
    done = job_runner.run_job(second["job_id"])
    assert done.status == JobStatus.DONE
    assert done.params.gateway_request_fingerprint == failed.params.gateway_request_fingerprint
    assert done.params.gateway_reattach_of == failed.job_id
    assert len(_host_tasks()) == 1 and len(upstream["calls"]) == 1


def test_canvas_regenerate_through_the_real_run_path_keeps_the_fingerprint(gateway, upstream,
                                                                           faults):
    from character_workflow.lib.canvas_projects import (
        read_canvas_document,
    )
    from character_workflow.lib.canvas_runs import run_canvas_job, submit_canvas_run

    pid = _canvas_project()
    saved = read_canvas_document(pid)
    first, _doc = submit_canvas_run(pid, "config", saved.revision)
    faults.lost_posts = 3
    try:
        run_canvas_job(first.job_id)
    except Exception:  # noqa: BLE001 — 画布 runner 失败时可能抛出，下面看落盘结果
        pass
    failed = read_job(first.job_id)
    assert failed.status == JobStatus.FAILED and failed.params.gateway_unconfirmed is True

    second, _doc = submit_canvas_run(pid, "config", read_canvas_document(pid).revision)
    assert second.params.gateway_reattach_of == failed.job_id
    done = run_canvas_job(second.job_id)
    assert done.status == JobStatus.DONE
    assert done.params.gateway_request_fingerprint == failed.params.gateway_request_fingerprint
    assert len(_host_tasks()) == 1 and len(upstream["calls"]) == 1


def test_gateway_error_mentioning_unconfirmed_is_not_treated_as_unconfirmed(gateway, upstream,
                                                                           monkeypatch):
    """按类型判断：主机明确拒绝、文案里碰巧带「未确认」的错误，不记 gateway_unconfirmed。"""
    def reject(*_args, **_kwargs):
        raise atelier_gateway.GatewayError("gateway api 422: 素材来源未确认")

    monkeypatch.setattr(atelier_gateway, "_submit", reject)
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(_now_job("job-text").job_id)
    assert not read_job("job-text").params.gateway_unconfirmed


# ---------------------------------------------------------------- 接回链不能在中间断开
# 任务 1 提交回应丢失（主机已收到、在出图）→ 任务 2 再次生成时连接都没建立 → 网络恢复后任务 3
# 再次生成：必须仍然接回任务 1 在主机上的那一单。


def _studio(monkeypatch):
    from tests.local_client import LocalTestClient
    from viewer_server import routes
    from viewer_server.server_app import build_app

    monkeypatch.setattr(routes, "_start_studio_job_task", lambda job_id: None)
    client = LocalTestClient(base_url="http://127.0.0.1", app=build_app())
    body = {"prompt": "一只橘猫", "model": "gpt-image-2", "alias": "Hub",
            "params": {"n": 1, "ratio": "1:1", "size_mode": "ratio"}}

    def create(reattach=None):
        extra = {"reattach_job_id": reattach} if reattach else {}
        return client.post("/api/studio/jobs", json={**body, **extra}).json()["job_id"]
    return create


def _run_failing(job_id):
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(job_id)
    return read_job(job_id)


@pytest.mark.parametrize("regenerate_from", ["task2", "task1"])
def test_studio_chain_survives_a_middle_regenerate_that_could_not_connect(
        gateway, upstream, faults, monkeypatch, regenerate_from):
    create = _studio(monkeypatch)
    faults.lost_posts = 3
    task1 = _run_failing(create())
    assert task1.params.gateway_unconfirmed is True and len(_host_tasks()) == 1

    faults.down_posts = 3  # 网络断着：任务 2 沿用旧键，连接都没建立
    task2 = _run_failing(create(task1.job_id))
    assert task2.params.gateway_idempotency_key == task1.params.gateway_idempotency_key
    assert task2.params.gateway_unconfirmed is True  # 结局仍未知，标记不能丢
    assert "未确认" in task2.error
    faults.down_posts = 0  # 网络恢复

    source = task2 if regenerate_from == "task2" else task1
    task3 = job_runner.run_job(create(source.job_id))
    assert task3.status == JobStatus.DONE and not task3.params.gateway_unconfirmed
    [host] = _host_tasks()
    assert task3.params.provider_task_ids == [host.task_id]  # 拿回的是任务 1 在主机上的那一单
    assert len(upstream["calls"]) == 1


def test_canvas_chain_survives_a_middle_regenerate_that_could_not_connect(gateway, upstream,
                                                                          faults):
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.canvas_runs import run_canvas_job, submit_canvas_run

    pid = _canvas_project()

    def attempt():
        job, _doc = submit_canvas_run(pid, "config", read_canvas_document(pid).revision)
        try:
            run_canvas_job(job.job_id)
        except Exception:  # noqa: BLE001 — 失败时画布 runner 可能抛出，下面看落盘结果
            pass
        return read_job(job.job_id)

    faults.lost_posts = 3
    task1 = attempt()
    assert task1.params.gateway_unconfirmed is True
    faults.down_posts = 3
    task2 = attempt()  # 服务端取的是同一节点最近一次（任务 1）
    assert task2.params.gateway_reattach_of == task1.job_id and task2.params.gateway_unconfirmed
    faults.down_posts = 0  # 网络恢复
    task3 = attempt()  # 最近一次是任务 2
    assert task3.status == JobStatus.DONE and task3.params.gateway_reattach_of == task2.job_id
    [host] = _host_tasks()
    assert task3.params.provider_task_ids == [host.task_id] and len(upstream["calls"]) == 1


def test_chain_older_than_twenty_hours_places_a_new_order(gateway, upstream, faults, monkeypatch):
    create = _studio(monkeypatch)
    faults.lost_posts = 3
    task1 = _run_failing(create())
    # 把这把键的签发时间改到 21 小时前（键在主机上的那一单保持不变）。
    old_key = f"{int(time.time()) - 21 * 3600}-" + task1.params.gateway_idempotency_key.split("-")[1]
    save_job(task1.model_copy(update={"params": task1.params.model_copy(update={
        "gateway_idempotency_key": old_key})}))
    task2 = job_runner.run_job(create(task1.job_id))
    assert task2.status == JobStatus.DONE and task2.params.gateway_reattach_of is None
    assert task2.params.gateway_idempotency_key != old_key
    assert len(_host_tasks()) == 2


def test_reattach_waits_while_the_original_is_still_running_on_the_host(gateway, upstream, faults,
                                                                        monkeypatch):
    import threading

    from character_workflow.lib.callers import openai_image

    release = threading.Event()
    real_render = openai_image.render

    def slow_render(**kwargs):
        release.wait(10)  # 主机上的原任务一直在跑，直到放行
        return real_render(**kwargs)

    monkeypatch.setattr(openai_image, "render", slow_render)
    create = _studio(monkeypatch)
    faults.lost_posts = 3
    task1 = _run_failing(create())
    assert _host_tasks()[0].status in ("pending", "running")
    threading.Timer(1.0, release.set).start()
    task2 = job_runner.run_job(create(task1.job_id))  # 接着等原任务出完，不报失败
    assert task2.status == JobStatus.DONE
    assert len(_host_tasks()) == 1 and len(upstream["calls"]) == 1


def test_flag_is_saved_before_resending_an_old_key(gateway, upstream, faults, monkeypatch):
    """沿用旧键发送前就记「结局未知」：发送途中成员端崩溃，落盘的任务仍能被下一次再次生成接回。"""
    create = _studio(monkeypatch)
    faults.lost_posts = 3
    task1 = _run_failing(create())
    task2_id = create(task1.job_id)
    faults.crash_posts = 1
    with pytest.raises(_Crash):
        job_runner.run_job(task2_id)
    task2 = read_job(task2_id)
    assert task2.params.gateway_unconfirmed is True
    assert task2.params.gateway_idempotency_key == task1.params.gateway_idempotency_key
