"""老 job json 在 schema 重命名后仍能反序列化 — 不变量必须保住."""
from __future__ import annotations

import json

import pytest

from character_workflow.lib.schemas import AssetSlot, Job, JobKind


def _make_legacy_job_dict() -> dict:
    """老 schema：kind 字段是 portrait/promo/turnaround 字符串."""
    return {
        "job_id": "job-legacy-001",
        "character_id": "char-test",
        "prompt": "test prompt",
        "submitted_at": "2026-05-19T10:00:00Z",
        "model": "lovart",
        "params": {"size": "1024x1024"},
        "seed": None,
        "output_paths": [],
        "status": "done",
        "error": None,
        "kind": "portrait",  # 老字段名
        "source_image": None,
        "alias": None,
        "provider": None,
    }


def test_legacy_job_without_migration_does_not_load():
    """没跑 migration 的老 json 现在会失败 — 这是预期的 (跑 migration 前不应该读)."""
    legacy = _make_legacy_job_dict()
    with pytest.raises(Exception):
        Job(**legacy)


def test_migrated_job_loads_with_defaults():
    """migration 后老 job 注入 asset_slot + namespace="character" + kind="image"."""
    migrated = _make_legacy_job_dict()
    migrated.pop("kind")
    migrated["asset_slot"] = "portrait"
    migrated["namespace"] = "character"
    migrated["kind"] = "image"
    job = Job(**migrated)
    assert job.asset_slot == AssetSlot.PORTRAIT
    assert job.namespace == "character"
    assert job.kind == JobKind.IMAGE
    assert job.character_id == "char-test"


def test_studio_job_with_namespace_studio():
    """Studio job: namespace='studio', asset_slot 仍是 PORTRAIT 占位（runner 不读它）."""
    studio = _make_legacy_job_dict()
    studio.pop("kind")
    studio["job_id"] = "job-studio-001"
    studio["character_id"] = "char-test"  # placeholder, runner 看 namespace
    studio["asset_slot"] = "portrait"
    studio["namespace"] = "studio"
    studio["kind"] = "image"
    job = Job(**studio)
    assert job.namespace == "studio"
    assert job.kind == JobKind.IMAGE


def test_video_kind_value_in_enum():
    """JobKind 必须包含 VIDEO 占位（实际 runner 抛 NotImplementedError 由其他测试覆盖）."""
    assert JobKind.VIDEO.value == "video"


def test_migration_script_idempotent(tmp_path):
    """脚本对老 json 升级；二次执行无效果."""
    from scripts.migrate_jobs_2026_05_25 import migrate

    data_root = tmp_path
    jobs_dir = data_root / ".runtime" / "jobs"
    jobs_dir.mkdir(parents=True)
    legacy = _make_legacy_job_dict()
    (jobs_dir / "job-legacy-001.json").write_text(json.dumps(legacy))
    # 第一次：1 migrated
    m1, s1, e1 = migrate(data_root)
    assert (m1, s1, e1) == (1, 0, 0)
    # 第二次：0 migrated, 1 skipped
    m2, s2, e2 = migrate(data_root)
    assert (m2, s2, e2) == (0, 1, 0)
    # 内容验证
    new = json.loads((jobs_dir / "job-legacy-001.json").read_text())
    assert new["asset_slot"] == "portrait"
    assert new["namespace"] == "character"
    assert new["kind"] == "image"
    # 用 Pydantic 反序列化必须成功
    job = Job(**new)
    assert job.asset_slot == AssetSlot.PORTRAIT


def test_migrate_returns_zero_when_jobs_dir_missing(tmp_path):
    from scripts.migrate_jobs_2026_05_25 import migrate
    # tmp_path has no .runtime/jobs/
    assert migrate(tmp_path) == (0, 0, 0)


def test_migrate_counts_corrupt_json_as_errored(tmp_path):
    from scripts.migrate_jobs_2026_05_25 import migrate
    jobs_dir = tmp_path / ".runtime" / "jobs"
    jobs_dir.mkdir(parents=True)
    (jobs_dir / "bad.json").write_text("{not valid json")
    m, s, e = migrate(tmp_path)
    assert (m, s, e) == (0, 0, 1)
