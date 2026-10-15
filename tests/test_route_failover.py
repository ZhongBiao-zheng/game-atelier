"""「自动」任务的失败切换：只在确定没执行的失败上换下一家。"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

import pytest
import requests

from character_workflow.lib import job_runner, keys, model_routes
from character_workflow.lib.callers.openai_image import OpenAIImageError
from character_workflow.lib.jobs import read_job, save_job
from character_workflow.lib.schemas import AssetSlot, Job, JobKind, JobParams, JobStatus


@pytest.fixture(autouse=True)
def _clear_cooldowns():
    model_routes._cooldowns.clear()
    yield
    model_routes._cooldowns.clear()


def _wrapped(message: str, cause: BaseException) -> OpenAIImageError:
    try:
        raise OpenAIImageError(message) from cause
    except OpenAIImageError as error:
        return error


@pytest.mark.parametrize(("error", "reason"), [
    (OpenAIImageError("image api 401: invalid api key"), "auth"),
    (OpenAIImageError("image api 403: 该令牌无权访问模型"), "auth"),
    (OpenAIImageError("image api 404: model not found"), "unavailable"),
    (OpenAIImageError('image api 503: {"error":"no_endpoints_available"}'), "unavailable"),
    (OpenAIImageError("image api 429: rate limited"), "quota"),
    (OpenAIImageError("text api 402: insufficient_quota"), "quota"),
    (_wrapped("connect timeout", requests.ConnectTimeout("timed out")), "unreachable"),
    # 上游可能已经在跑或换哪家都一样失败：一律不换。
    (OpenAIImageError("image api 503: upstream timeout"), None),
    (OpenAIImageError("image api 504: gateway timeout"), None),
    (OpenAIImageError("image api 500: internal"), None),
    (OpenAIImageError("image api 400: content policy violation"), None),
    (_wrapped("read timeout", requests.ReadTimeout("read timed out")), None),
    (_wrapped("dropped", requests.ConnectionError("Remote end closed connection")), None),
    (RuntimeError("视频提交结果未确认：厂商接口返回 HTTP 401，未自动重新提交。"), None),
    (RuntimeError("returned no valid image artifacts"), None),
])
def test_failover_reason_only_for_requests_that_never_ran(error, reason):
    assert model_routes.failover_reason(error) == reason


def _write_png(path: Path) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(
            ">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\xff\xff\xff" * 2 for _ in range(2))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _seed_keys() -> None:
    for alias in ("A", "B"):
        keys.add_key(keys.KeySpec(
            alias=alias, provider="openai", access_key="test-only", modalities=["image"],
            models=[keys.ModelSpec(id="gpt-image-2", name="gpt-image-2", modality="image")],
            created_at="test"))
    keys.set_default_alias("A")


def _job(route_id: str | None) -> Job:
    return save_job(Job(
        job_id=f"job-{route_id or 'pinned'}", character_id="A", prompt="x",
        submitted_at="2026-10-15T00:00:00+00:00", model="gpt-image-2",
        params=JobParams(n=1, route_id=route_id), output_paths=[], status=JobStatus.PENDING,
        error=None, asset_slot=AssetSlot.PORTRAIT, kind=JobKind.IMAGE, namespace="studio",
        alias="A", provider="openai",
    ))


def _dispatch_failing_on_a(error: BaseException, calls: list[str]):
    def fake_dispatch(*, alias, output_dir, **_kwargs):
        calls.append(alias)
        if alias == "A":
            raise error
        out = Path(output_dir) / "v1.png"
        _write_png(out)
        return [str(out)]
    return fake_dispatch


def test_auto_job_switches_to_next_provider_and_cools_the_failed_one(isolated_data_root, monkeypatch):
    _seed_keys()
    calls: list[str] = []
    monkeypatch.setattr(job_runner, "dispatch", _dispatch_failing_on_a(
        OpenAIImageError("image api 401: invalid api key"), calls))
    job = _job("gpt-image-2")

    done = job_runner.run_job(job.job_id)

    assert calls == ["A", "B"]
    assert (done.status, done.alias) == (JobStatus.DONE, "B")
    assert done.params.route_tried == ["A"]
    assert done.params.warnings == ["A密钥无效或没有权限，已改用 B"]
    # A 冷却期间「自动」直接从 B 开始。
    assert model_routes.resolve_auto("image", "gpt-image-2")[0].alias == "B"


@pytest.mark.parametrize("route_id", [None, "gpt-image-2"])
def test_no_switch_for_pinned_jobs_or_failures_that_may_have_run(isolated_data_root, monkeypatch, route_id):
    _seed_keys()
    calls: list[str] = []
    # 指定厂商：401 也不换；「自动」：504 上游可能已经在跑，不换。
    error = OpenAIImageError("image api 401: invalid" if route_id is None else "image api 504: timeout")
    monkeypatch.setattr(job_runner, "dispatch", _dispatch_failing_on_a(error, calls))
    job = _job(route_id)

    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(job.job_id)

    failed = read_job(job.job_id)
    assert calls == ["A"]
    assert (failed.status, failed.alias) == (JobStatus.FAILED, "A")


def test_switch_stops_when_every_provider_failed(isolated_data_root, monkeypatch):
    _seed_keys()
    calls: list[str] = []

    def always_unauthorized(*, alias, **_kwargs):
        calls.append(alias)
        raise OpenAIImageError("image api 401: invalid api key")

    monkeypatch.setattr(job_runner, "dispatch", always_unauthorized)
    job = _job("gpt-image-2")
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(job.job_id)
    failed = read_job(job.job_id)
    assert calls == ["A", "B"]
    assert (failed.status, failed.alias, failed.params.route_tried) == (JobStatus.FAILED, "B", ["A"])


@pytest.mark.parametrize(("status", "reason"), [
    (401, "auth"), (403, "auth"), (404, "unavailable"), (402, "quota"), (429, "quota"),
])
def test_evolink_rejection_keeps_classifiable_status(status, reason):
    from character_workflow.lib.callers.evolink import EvoLinkError, _error

    assert model_routes.failover_reason(EvoLinkError(_error({}, status, ""))) == reason


@pytest.mark.parametrize("state", [
    {"channel": "previous-channel", "terminal": "rejected", "uncertain": False},
    {"channel": "previous-channel", "uncertain": True},
    {"channel": "previous-channel", "task_id": "accepted-order"},
    {"channel": "previous-channel", "terminal": "completed"},
])
def test_evolink_route_switch_only_clears_definitely_rejected_state(
    isolated_data_root, monkeypatch, state,
):
    from character_workflow.lib.callers.evolink import EvoLinkError

    _seed_keys()
    job = _job("gpt-image-2")
    save_job(job.model_copy(update={
        "params": job.params.model_copy(update={"evolink_state": state}),
    }))
    switched = job_runner._switch_route(job.job_id, EvoLinkError("EvoLink HTTP 401: invalid"))
    current = read_job(job.job_id)
    if state.get("terminal") == "rejected":
        assert switched
        assert current.alias == "B"
        assert current.params.evolink_state is None
    else:
        assert not switched
        assert current.alias == "A"
        assert current.params.evolink_state == state
