"""Tests for JobKind enum + 写盘按 kind 分发 + 旧 json fallback.

覆盖 plan §11.3 + §11.4 三条断言：
1. JobKind round-trip 落盘 / 读回字段不丢
2. 旧 .runtime/jobs/*.json 无 kind 字段 → Pydantic 自动 fallback PORTRAIT
3. job_output_dir() 按 kind 写到 characters/<id>/<kind>/
"""
import json

import pytest

from character_workflow.lib.jobs import (
    job_output_dir, read_job, write_job,
)
from character_workflow.lib.schemas import AssetSlot, Job, JobStatus


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    return runtime


def test_default_kind_is_portrait(runtime):
    job = write_job(
        job_id="j1", character_id="holy", prompt="p",
        model="gpt_image_2", params={}, seed=None,
    )
    assert job.asset_slot == AssetSlot.PORTRAIT
    assert job.source_image is None


def test_kind_round_trip(runtime):
    write_job(
        job_id="j1", character_id="holy", prompt="p",
        model="gpt_image_2", params={}, seed=None,
        asset_slot=AssetSlot.PROMO, source_image="/abs/upload.png",
    )
    re_read = read_job("j1")
    assert re_read.asset_slot == AssetSlot.PROMO
    assert re_read.source_image == "/abs/upload.png"


def test_legacy_json_without_kind_falls_back_to_portrait(runtime):
    """模拟历史 job json 没有 asset_slot / source_image —— Pydantic 默认补上 PORTRAIT/None。"""
    (runtime / "jobs" / "legacy.json").write_text(json.dumps({
        "job_id": "legacy", "character_id": "old", "prompt": "p",
        "submitted_at": "2026-05-18T10:00:00Z", "model": "gpt-image-2",
        "params": {}, "seed": None, "output_paths": [],
        "status": "done", "error": None,
    }))
    job = read_job("legacy")
    assert job.asset_slot == AssetSlot.PORTRAIT
    assert job.source_image is None
    assert job.status == JobStatus.DONE


def test_job_output_dir_routes_by_kind(tmp_path):
    base = tmp_path
    assert job_output_dir("holy", AssetSlot.PORTRAIT, base) == base / "characters" / "holy" / "portrait"
    assert job_output_dir("holy", AssetSlot.PROMO, base) == base / "characters" / "holy" / "promo"
    assert job_output_dir("holy", AssetSlot.TURNAROUND, base) == base / "characters" / "holy" / "turnaround"


def test_job_model_accepts_all_three_kinds():
    base_kwargs = dict(
        job_id="x", character_id="c", prompt="p", submitted_at="2026-05-19T10:00:00Z",
        model="m", params={}, seed=None, output_paths=[],
        status=JobStatus.PENDING_CONFIRM, error=None,
    )
    for k in (AssetSlot.PORTRAIT, AssetSlot.PROMO, AssetSlot.TURNAROUND):
        j = Job(**base_kwargs, asset_slot=k)
        assert j.asset_slot == k


def test_source_image_persists_to_disk(runtime):
    write_job(
        job_id="j2", character_id="holy", prompt="p",
        model="gpt_image_2", params={}, seed=None,
        asset_slot=AssetSlot.TURNAROUND, source_image="/abs/refs/three-view-source.png",
    )
    raw = json.loads((runtime / "jobs" / "j2.json").read_text(encoding="utf-8"))
    assert raw["asset_slot"] == "turnaround"
    assert raw["source_image"] == "/abs/refs/three-view-source.png"
