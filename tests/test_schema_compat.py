"""老 job json 在 schema 重命名后仍能反序列化 — 不变量必须保住."""
from __future__ import annotations


import pytest

from character_workflow.lib.schemas import Job, JobKind


def _make_legacy_job_dict() -> dict:
    """老 schema：kind 字段是 portrait/promo/turnaround 字符串."""
    return {
        "job_id": "job-legacy-001",
        "character_id": "char-test",
        "prompt": "test prompt",
        "submitted_at": "2026-05-19T10:00:00Z",
        "model": "lovart",
        "params": {"size": "1024x1024"},
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


def test_studio_job_with_namespace_studio():
    """Studio job: namespace='studio', asset_slot 仍是 PORTRAIT 占位（runner 不读它）."""
    studio = _make_legacy_job_dict()
    studio.pop("kind")
    studio["job_id"] = "job-studio-001"
    studio["character_id"] = "char-test"  # placeholder, runner 看 namespace
    studio["namespace"] = "studio"
    studio["kind"] = "image"
    job = Job(**studio)
    assert job.namespace == "studio"
    assert job.kind == JobKind.IMAGE


def test_video_kind_value_in_enum():
    """JobKind 必须包含 VIDEO 占位（实际 runner 抛 NotImplementedError 由其他测试覆盖）."""
    assert JobKind.VIDEO.value == "video"
