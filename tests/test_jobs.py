import os

import pytest

from character_workflow.lib.jobs import (
    write_job, update_job_status, read_job, list_jobs, clone_job_for_retry,
)
from character_workflow.lib.schemas import JobStatus


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    return runtime


def test_write_default_is_pending_confirm(runtime):
    job = write_job(
        job_id="job-001", character_id="c1", prompt="p",
        model="gpt-image-2", params={"size": "1024x1024"},
    )
    assert job.status == JobStatus.PENDING_CONFIRM
    assert (runtime / "jobs" / "job-001.json").exists()


def test_write_with_explicit_pending(runtime):
    job = write_job(
        job_id="job-002", character_id="c1", prompt="p",
        model="gpt-image-2", params={},
        status=JobStatus.PENDING,
    )
    assert job.status == JobStatus.PENDING


def test_update_status_to_done(runtime):
    write_job(
        job_id="job-001", character_id="c1", prompt="p",
        model="gpt-image-2", params={},
    )
    updated = update_job_status(
        "job-001", status=JobStatus.DONE,
        output_paths=["/tmp/a.png", "/tmp/b.png"],
    )
    assert updated.status == JobStatus.DONE
    assert updated.output_paths == ["/tmp/a.png", "/tmp/b.png"]


def test_update_status_to_failed_records_error(runtime):
    write_job(
        job_id="job-001", character_id="c1", prompt="p",
        model="gpt-image-2", params={},
    )
    updated = update_job_status("job-001", status=JobStatus.FAILED, error="API timeout")
    assert updated.status == JobStatus.FAILED
    assert updated.error == "API timeout"


def test_update_status_to_done_can_clear_old_error(runtime):
    write_job(
        job_id="job-001", character_id="c1", prompt="p",
        model="gpt-image-2", params={},
    )
    update_job_status("job-001", status=JobStatus.FAILED, error="stale timeout")

    updated = update_job_status("job-001", status=JobStatus.DONE, error=None)

    assert updated.status == JobStatus.DONE
    assert updated.error is None


def test_read_returns_full_job(runtime):
    write_job(
        job_id="job-001", character_id="c1", prompt="p",
        model="gpt-image-2", params={},
    )
    job = read_job("job-001")
    assert job.job_id == "job-001"
    assert job.status == JobStatus.PENDING_CONFIRM


def test_write_job_fills_alias_from_preferred_when_missing(runtime):
    from character_workflow.lib import keys
    keys.add_key(keys.KeySpec(
        alias="lov", provider="seedream", access_key="ak", secret_key="sk",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    job = write_job(
        job_id="job-alias-auto", character_id="c1", prompt="p",
        model="m", params={},
    )
    assert job.alias == "lov"
    assert job.provider == "seedream"


def test_write_job_alias_null_when_no_key_matches(runtime):
    job = write_job(
        job_id="job-alias-none", character_id="c1", prompt="p",
        model="m", params={},
    )
    assert job.alias is None
    assert job.provider is None


def test_write_job_explicit_alias_overrides_default(runtime):
    from character_workflow.lib import keys
    keys.add_key(keys.KeySpec(
        alias="lov", provider="seedream", access_key="ak", secret_key="sk",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.add_key(keys.KeySpec(
        alias="oa", provider="openai", access_key="x", secret_key=None,
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.set_default_alias("lov")
    job = write_job(
        job_id="job-alias-explicit", character_id="c1", prompt="p",
        model="m", params={}, alias="oa",
    )
    assert job.alias == "oa"
    assert job.provider == "openai"


def test_list_jobs_skips_bad_file(runtime):
    """坏 job 文件跳过，不再让整个 list_jobs 抛异常。

    覆盖两类坏文件：
    - JSONDecodeError（半写截断）
    - 合法 JSON 但顶层非 dict（被手改 / 截断成 `[]` 或裸值）——这类若在 _load_job 的
      `.pop` 阶段抛 Type/AttributeError 会逃逸 except 容错网，让整个 list_jobs / /api/jobs 崩。
    """
    write_job(
        job_id="ok-1", character_id="c1", prompt="p",
        model="m", params={},
    )
    (runtime / "jobs" / "corrupt.json").write_text("{half-written")
    (runtime / "jobs" / "corrupt-list.json").write_text("[]")
    (runtime / "jobs" / "corrupt-str.json").write_text('"oops"')
    (runtime / "jobs" / "corrupt-num.json").write_text("42")
    (runtime / "jobs" / "corrupt-null.json").write_text("null")
    assert [j.job_id for j in list_jobs()] == ["ok-1"]


def test_list_jobs_ignores_lock_files(runtime):
    """job_lock 的 sidecar .lock 文件不算 job。"""
    write_job(
        job_id="ok-1", character_id="c1", prompt="p",
        model="m", params={},
    )
    assert (runtime / "jobs" / "ok-1.lock").exists()
    assert [j.job_id for j in list_jobs()] == ["ok-1"]


def test_clone_job_for_retry(runtime):
    """failed job 克隆为新 PENDING_CONFIRM job：参数原样、结果字段清空、retry_of 指回原 job。"""
    write_job(
        job_id="job-001", character_id="c1", prompt="p", model="m",
        params={
            "size": "1024x1024", "n": 2,
            "reference_images": ["/tmp/a.png"],
            "actual_size": "1024x1024", "warnings": ["timeout once"],
        },
    )
    update_job_status("job-001", status=JobStatus.FAILED, error="API timeout")

    clone = clone_job_for_retry("job-001")

    assert clone.job_id != "job-001"
    assert clone.retry_of == "job-001"
    assert clone.status == JobStatus.PENDING_CONFIRM
    assert clone.error is None
    assert clone.output_paths == []
    assert clone.prompt == "p"
    assert clone.params.reference_images == ["/tmp/a.png"]
    assert clone.params.n == 2
    assert clone.params.actual_size is None
    assert clone.params.warnings is None
    # 原 job 与错误记录原样保留
    original = read_job("job-001")
    assert original.status == JobStatus.FAILED
    assert original.error == "API timeout"


def test_clone_job_for_retry_rejects_non_failed(runtime):
    write_job(
        job_id="job-002", character_id="c1", prompt="p",
        model="m", params={},
    )
    with pytest.raises(ValueError, match="not failed"):
        clone_job_for_retry("job-002")


def test_list_jobs_tolerates_legacy_seed_field(runtime):
    """存量 job JSON 带已废弃的 seed 字段，加载时剥离后不能被 extra=forbid 丢弃。"""
    (runtime / "jobs" / "job-legacy.json").write_text(
        '{"job_id":"job-legacy","character_id":"c","prompt":"p",'
        '"submitted_at":"2026-05-29T00:00:00Z","model":"m","params":{},'
        '"seed":123,"output_paths":[],"status":"done","error":null}',
        encoding="utf-8",
    )
    assert "job-legacy" in [j.job_id for j in list_jobs()]
    assert read_job("job-legacy").job_id == "job-legacy"


@pytest.mark.skipif(os.name == "nt", reason="POSIX flock 探测；Windows 走 msvcrt 分支")
def test_job_lock_is_exclusive(runtime):
    """持锁期间第二个 fd 拿不到锁 —— 读改写区间互斥的根。"""
    import fcntl

    from character_workflow.lib.jobs import job_lock

    with job_lock("j-lock"):
        with open(runtime / "jobs" / "j-lock.lock", "a+") as f:
            with pytest.raises(BlockingIOError):
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    # 释放后能再拿到
    with open(runtime / "jobs" / "j-lock.lock", "a+") as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
