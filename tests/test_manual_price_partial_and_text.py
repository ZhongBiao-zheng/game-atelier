"""第 5 批 5-5：部分参数下才无同步价的模型也给单价框；文本模型手设单价（元 / 百万 token，输入输出各一个）。

规则与第三批一致：手设价只在拿不到同步价时用，同步价优先；按价格表来源结算，成功才扣、失败扣 0。
"""
from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import gateway_keys, gateway_quota, gateway_tasks, keys, model_routes
from character_workflow.lib.generation_pricing import (
    estimate_submission, estimate_text_cost_cny, has_no_synced_price,
)

ARK = "https://ark.cn-beijing.volces.com/api/v3"
SEEDANCE = "doubao-seedance-2-0-260128"
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64


@pytest.fixture(autouse=True)
def clean(isolated_data_root):
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    yield
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()


def _video_key(**model_extra):
    keys.add_key(keys.KeySpec(
        alias="ark", provider="seedance", base_url=ARK, access_key="test-only",
        modalities=["video"], created_at="test",
        models=[keys.ModelSpec(id=SEEDANCE, name="Seedance 2.0", modality="video", **model_extra)]))
    return keys.find_by_alias("ark")


VIDEO = {"duration": 5, "resolution": "720p", "ratio": "16:9"}


# ---------------------------------------------------------------- 部分参数


def test_video_priced_only_without_reference_video_is_flagged():
    key = _video_key()
    assert estimate_submission(key, SEEDANCE, "video", dict(VIDEO), manual=False) is not None
    assert estimate_submission(key, SEEDANCE, "video", {**VIDEO, "reference_videos": ["r.mp4"]},
                               manual=False) is None
    assert has_no_synced_price(key, key.models[0]) is True
    row = next(r for r in keys.keys_for_api() if r["alias"] == "ark")
    assert row["models"][0]["unpriced"] is True


def test_manual_price_covers_only_the_unpriced_combination():
    key = _video_key(per_call_cny=2.5)
    synced = estimate_submission(key, SEEDANCE, "video", dict(VIDEO))
    assert synced is not None and synced != 2.5  # 同步价优先
    assert estimate_submission(key, SEEDANCE, "video", {**VIDEO, "reference_videos": ["r.mp4"]}) == 2.5


def test_gateway_charges_the_manual_price_for_the_unpriced_combination(monkeypatch):
    from character_workflow.lib import callers

    _video_key(per_call_cny=2.5)
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    owner = gateway_keys.create_key("小王")[0]
    task = gateway_tasks.submit(owner, idempotency_key="v", model=f"seedance:{SEEDANCE}",
                                prompt="灯塔", n=1, size=None, params=dict(VIDEO),
                                files={"video": [("ref.mp4", MP4)]}, kind="video")
    assert (task.estimated_cny, task.reserved_cny) == (2.5, 2.5)

    def render(*, output_dir, **_kwargs):
        path = output_dir / "out.mp4"
        path.write_bytes(MP4)
        return [str(path)]

    monkeypatch.setattr(callers, "dispatch_video", render)
    monkeypatch.setattr("character_workflow.lib.job_runner.is_valid_video", lambda _p: True)
    done = gateway_tasks.run_task(gateway_tasks._update(task.task_id, status="running"))
    assert done.status == "done", done.error
    assert done.charged_cny == 2.5


def test_model_priced_in_every_probed_combination_is_not_flagged():
    from character_workflow.lib import openai_hk_prices
    from character_workflow.lib.atomic_io import atomic_write_json

    atomic_write_json(openai_hk_prices.snapshot_path(), {"models": {
        "gpt-image-2": {"quota_type": 1, "model_price": 0.08, "enable_groups": ["default"]}}})
    keys.add_key(keys.KeySpec(
        alias="hk", provider="openai", base_url="https://api.openai-hk.com", access_key="test-only",
        modalities=["image"], created_at="test",
        models=[keys.ModelSpec(id="gpt-image-2", name="GPT Image 2", modality="image")]))
    key = keys.find_by_alias("hk")
    assert has_no_synced_price(key, key.models[0]) is False


# ---------------------------------------------------------------- 文本手设单价


def _text_key(alias="txt", **model_extra):
    keys.add_key(keys.KeySpec(
        alias=alias, provider="custom", base_url=f"https://{alias}.example/v1", access_key="test-only",
        modalities=["llm"], created_at="test",
        models=[keys.ModelSpec(id="gpt-test", name="GPT 测试", modality="text",
                               protocol="openai-chat", **model_extra)]))
    return keys.find_by_alias(alias)


def test_text_model_without_a_synced_price_is_flagged():
    key = _text_key()
    assert has_no_synced_price(key, key.models[0]) is True
    row = next(r for r in keys.keys_for_api() if r["alias"] == "txt")
    assert row["models"][0]["unpriced"] is True


def test_text_manual_rates_apply_only_when_both_are_set():
    key = _text_key(input_cny_per_m=2.0, output_cny_per_m=8.0)
    assert estimate_text_cost_cny("gpt-test", 1000, 500, key=key) == pytest.approx(0.006)
    assert estimate_text_cost_cny("gpt-test", 1000, 500, key=key, manual=False) is None
    half = _text_key("half", input_cny_per_m=2.0)
    assert estimate_text_cost_cny("gpt-test", 1000, 500, key=half) is None


def test_text_manual_rates_do_not_override_a_synced_price(monkeypatch):
    from character_workflow.lib import generation_pricing

    key = _text_key(input_cny_per_m=100.0, output_cny_per_m=100.0)
    monkeypatch.setattr(generation_pricing, "_synced_text_cost", lambda *_a, **_k: 0.001)
    assert estimate_text_cost_cny("gpt-test", 1000, 500, key=key) == 0.001


@pytest.fixture
def text_relay(monkeypatch):
    from viewer_server import gateway_openai
    from viewer_server.gateway_app import create_gateway_app

    _text_key(input_cny_per_m=2.0, output_cny_per_m=8.0)
    _owner, token = gateway_keys.create_key("文本手设价")
    state = {"status": 200, "usage": {"prompt_tokens": 1000, "completion_tokens": 500}}

    def handle(_request):
        body = {"choices": []} if state["usage"] is None else {"choices": [], "usage": state["usage"]}
        return httpx.Response(state["status"], json=body)

    monkeypatch.setattr(gateway_openai, "_client", lambda: httpx.AsyncClient(
        transport=httpx.MockTransport(handle)))
    client = TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {token}"})
    return client, state


def _last_row():
    return gateway_tasks.read_usage(gateway_tasks._now().astimezone().strftime("%Y-%m"))[-1]


def _chat(client):
    return client.post("/gateway/v1/openai/chat/completions",
                       json={"model": "gpt-test", "messages": [{"role": "user", "content": "hi"}]})


def test_gateway_text_success_is_charged_by_the_manual_rates(text_relay):
    client, _state = text_relay
    assert _chat(client).status_code == 200
    row = _last_row()
    assert row["charged_cny"] == pytest.approx(0.006)
    assert row["status"] == "done"


def test_gateway_text_failure_and_missing_usage_charge_nothing(text_relay):
    client, state = text_relay
    state["status"] = 500
    _chat(client)
    assert _last_row()["charged_cny"] == 0
    state.update(status=200, usage=None)
    assert _chat(client).status_code == 200
    row = _last_row()
    assert row["charged_cny"] == 0 and row["usage_missing"] is True


def test_old_keys_without_the_text_rates_serialize_unchanged():
    dumped = _text_key().models[0].model_dump()
    assert "input_cny_per_m" not in dumped and "output_cny_per_m" not in dumped


@pytest.mark.parametrize("value", [-1, 10_001, float("nan")])
def test_invalid_text_rates_are_rejected(value):
    with pytest.raises(ValueError):
        keys.ModelSpec(id="m", name="m", modality="text", input_cny_per_m=value)
