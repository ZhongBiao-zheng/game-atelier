"""主机手设的每次调用价格（第三批第 3 步）：只在没有同步价时生效，同步价优先。"""
from __future__ import annotations

import json

import pytest

from character_workflow.lib import callers, gateway_keys, gateway_tasks, keys, model_routes
from character_workflow.lib.generation_pricing import estimate_submission, has_no_synced_price
from tests.test_gateway import _dispatch, _seed_keys


@pytest.fixture
def unpriced(isolated_data_root, monkeypatch):
    """一家没有任何同步价的供应商，模型手设 0.3 元 / 次。"""
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    model_routes._cooldowns.clear()
    _seed_keys()
    for alias in ("A", "B"):
        keys.patch_key(alias, {"base_url": "https://unpriced.example"})
    key = keys.find_by_alias("A")
    keys.patch_key("A", {"models": [
        {**key.models[0].model_dump(), "per_call_cny": 0.3},
    ]})
    return keys.find_by_alias("A")


def test_manual_price_is_used_only_without_a_synced_price(unpriced):
    assert estimate_submission(unpriced, "gpt-image-2", "image", {}) == 0.3
    assert estimate_submission(unpriced, "gpt-image-2", "image", {}, manual=False) is None
    hk = keys.find_by_alias("B")
    keys.patch_key("B", {"base_url": "https://api.openai-hk.com", "models": [
        {**hk.models[0].model_dump(), "per_call_cny": 9.9},
    ]})
    assert estimate_submission(keys.find_by_alias("B"), "gpt-image-2", "image", {}) == 0.08  # 同步价优先


def test_gateway_reserves_and_charges_the_manual_price(unpriced, monkeypatch):
    owner, _token = gateway_keys.create_key("小王", {"period": "day", "cap_cny": 1})
    model_routes.put_alias_first("A")
    task = gateway_tasks.submit(owner, idempotency_key="m", model="gpt-image-2", prompt="猫", n=1,
                                size=None, params={}, files={})
    assert (task.estimated_cny, task.reserved_cny) == (0.3, 0.3)
    monkeypatch.setattr(callers, "dispatch", _dispatch([]))
    assert gateway_tasks.run_task(task).charged_cny == 0.3


def test_host_local_job_estimate_uses_the_manual_price(unpriced):
    from character_workflow.lib import job_runner
    from character_workflow.lib.jobs import read_job, save_job
    from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus

    save_job(Job(job_id="job-manual", character_id="studio", prompt="猫",
                 submitted_at="2026-11-18T00:00:00+00:00", model="gpt-image-2",
                 params=JobParams(n=1), output_paths=[], status=JobStatus.PENDING, error=None,
                 kind=JobKind.IMAGE, namespace="studio", alias="A", provider="openai"))
    job = read_job("job-manual")
    params = job.params.model_dump()
    job_runner._freeze_estimated_cost(job, params)
    assert params["estimated_cost_cny"] == 0.3 == read_job("job-manual").params.estimated_cost_cny


def test_keys_api_flags_unpriced_models_and_round_trips_the_price(unpriced):
    rows = {row["alias"]: row for row in keys.keys_for_api()}
    assert rows["A"]["models"][0]["unpriced"] is True and rows["A"]["models"][0]["per_call_cny"] == 0.3
    keys.patch_key("B", {"base_url": "https://api.openai-hk.com"})
    assert "unpriced" not in {row["alias"]: row for row in keys.keys_for_api()}["B"]["models"][0]
    assert has_no_synced_price(keys.find_by_alias("B"), keys.find_by_alias("B").models[0]) is False


def test_old_keys_file_without_the_field_reads_and_writes_unchanged(isolated_data_root):
    _seed_keys()
    from character_workflow.lib import data_root

    raw = json.loads((data_root.config_dir() / "keys.json").read_text(encoding="utf-8"))
    assert all("per_call_cny" not in model for key in raw["keys"] for model in key["models"])
    assert keys.find_by_alias("A").models[0].per_call_cny is None


@pytest.mark.parametrize("value", [-0.1, 10_001, float("inf")])
def test_invalid_manual_price_is_rejected(isolated_data_root, value):
    with pytest.raises(ValueError):
        keys.ModelSpec(id="m", name="m", per_call_cny=value)
