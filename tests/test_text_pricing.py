"""第三批第 4 步：文本按 token 计价与网关结算。数字取自 2026-11-18 付费小测的账单，无真实请求。"""
from datetime import datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import (
    gateway_keys, gateway_live, gateway_quota, gateway_stats, gateway_tasks, generation_pricing,
    keys, model_routes, openai_hk_prices, tokendance_prices, tuzi_prices,
)
from character_workflow.lib.atomic_io import atomic_write_json
from viewer_server import gateway_openai
from viewer_server.gateway_app import create_gateway_app

BASE = "/gateway/v1/openai"
SONNET, NANO, SEED = "claude-sonnet-5-5", "gpt-4.1-nano", "seed-2.0-lite"


class _Response:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def _tuzi_body(**group_overrides):
    group = {
        "billing_expr": {},
        "model_ratio": {SONNET: 1, NANO: 0.05},
        "model_completion_ratio": {SONNET: 5},  # NANO 缺，账单用模型行的 4
        "model_cache_ratio": {SONNET: 0.05, NANO: 0.25},
        "pricing_source": {SONNET: "global_fallback", NANO: "group_override"},
        "effective_group": {},
        "model_multiplier": {},
    }
    for name, value in group_overrides.items():
        group[name] = {**group[name], **value}
    return {
        "success": True,
        "data": [
            {"model_name": SONNET, "quota_type": 1, "model_price": 0, "model_ratio": 1,
             "completion_ratio": 5, "enable_groups": ["default", "vip"]},
            {"model_name": NANO, "quota_type": 1, "model_price": 0, "model_ratio": 0.05,
             "completion_ratio": 4, "enable_groups": ["default", "vip"]},
        ],
        "group_ratio": {"default": 1, "vip": 1.5, "azTb": 2.86},
        "group_model_pricing": {"default": group, "vip": group},
    }


def _sync_tuzi(monkeypatch, **group_overrides):
    monkeypatch.setattr(tuzi_prices, "_configured_models",
                        lambda: {"default": {SONNET, NANO}, "vip": {SONNET}})
    bodies = {"pricing": _tuzi_body(**group_overrides),
              "status": {"success": True, "data": {"usd_exchange_rate": 0.7}}}
    monkeypatch.setattr(tuzi_prices.requests, "get",
                        lambda url, timeout: _Response(bodies[url.rsplit("/", 1)[-1]]))
    return tuzi_prices.sync()


def _key(alias, *, provider="custom", base_url, model, group=None):
    return keys.KeySpec(alias=alias, provider=provider, access_key=f"secret-{alias}",
                        base_url=base_url, billing_group=group, created_at="test",
                        models=[keys.ModelSpec(id=model, name=model, modality="text")])


TUZI = _key("Tuzi", base_url="https://api.tu-zi.com", model=SONNET, group="default")


def _seed_pricing():
    def item(name, *rates):
        bounds = [{"upper": 32}, {"lower": 32, "upper": 128}]
        return {"id": f"openai:chat-completions:{name}", "plans": [
            {"unit": "millionTokens", "rate": rate,
             "range": {"item": "openai:chat-completions:prompt_tokens", "unit": "kTokens", **b}}
            for rate, b in zip(rates, bounds)]}
    return {"items": [item("input_tokens", "0.3", "0.45"), item("completion_tokens", "1.8", "2.7"),
                      item("cached_tokens", "0.06", "0.09")]}


# ---------------------------------------------------------------- 估价


def test_tuzi_text_price_matches_the_bill(monkeypatch):
    snapshot = _sync_tuzi(monkeypatch)
    assert snapshot["text_ratio"]["default"][NANO]["completion_ratio"] == 4
    # 账单：sonnet 1088 + 1×5 = 1093 quota；nano (618 + 1×4) × 0.05 = 31.1 记 31。
    # 500000 quota = 1 美元，汇率 0.7。
    assert generation_pricing.estimate_text_cost_cny(SONNET, 1088, 1, key=TUZI) == 0.00153
    assert generation_pricing.estimate_text_cost_cny(NANO, 618, 1, key=TUZI) == 0.000043


@pytest.mark.parametrize("overrides,group", [
    ({"effective_group": {SONNET: "azTb"}}, "default"),       # 生效分组倍率 2.86 没对过账
    ({"model_multiplier": {SONNET: 5}}, "default"),           # 模型乘数没对过账
    ({}, "vip"),                                              # 分组倍率 1.5 没对过账
    ({"billing_expr": {SONNET: 'v2:tier("x", 0.1)'}}, "default"),  # 表达式计价的文本模型
    ({"pricing_source": {SONNET: "group_multiplier"}}, "default"),
])
def test_tuzi_unverified_combinations_stay_unpriced(monkeypatch, overrides, group):
    _sync_tuzi(monkeypatch, **overrides)
    key = TUZI.model_copy(update={"billing_group": group})
    assert generation_pricing.estimate_text_cost_cny(SONNET, 1088, 1, key=key) is None


def test_tuzi_old_snapshot_without_text_ratios_is_unpriced(monkeypatch):
    from character_workflow.lib.atomic_io import atomic_write_json

    snapshot = _sync_tuzi(monkeypatch)
    snapshot.pop("text_ratio")
    atomic_write_json(tuzi_prices.snapshot_path(), snapshot)
    assert generation_pricing.estimate_text_cost_cny(SONNET, 1088, 1, key=TUZI) is None


def test_tokendance_text_price_matches_the_bill():
    tokendance_prices._write({SEED: _seed_pricing()})
    key = _key("td", provider="tokendance", base_url="https://tokendance.space", model=SEED)
    # 账单（微元）：53×0.3 + 37×1.8 = 82.5 记 82；1149×0.3 + 38×1.8 = 413.1 记 413。取整方式未确认。
    assert generation_pricing.estimate_text_cost_cny(SEED, 53, 37, key=key) == pytest.approx(
        0.0000825, abs=1e-6)
    assert generation_pricing.estimate_text_cost_cny(SEED, 1149, 38, key=key) == 0.000413
    # 按 prompt 长度分档；缓存命中部分按缓存价。
    assert generation_pricing.estimate_text_cost_cny(SEED, 40_000, 0, key=key) == 0.018
    assert generation_pricing.estimate_text_cost_cny(
        SEED, 1000, 0, key=key, cached_tokens=1000) == 0.00006


def _hk_snapshot(**row_overrides):
    row = {"quota_type": 0, "model_price": 0, "model_ratio": 0.05, "completion_ratio": 2,
           "enable_groups": ["default", "vip"]}
    row.update(row_overrides)
    atomic_write_json(openai_hk_prices.snapshot_path(), {
        "synced_at": "test", "models": {NANO: row}, "group_ratio": {"default": 7, "vip": 3}})


HK = _key("HK", base_url="https://api.openai-hk.com", model=NANO)


def test_openai_hk_text_matches_console_bills(isolated_data_root):
    _hk_snapshot()
    # 控制台账单（gpt-4.1-nano，default 分组）：0.112 记 1 积分、126.119 记 127、21.154 记 22。
    assert generation_pricing.estimate_text_cost_cny(NANO, 14, 1, key=HK) == 0.0001
    assert generation_pricing.estimate_text_cost_cny(NANO, 18015, 1, key=HK) == 0.0127
    assert generation_pricing.estimate_text_cost_cny(NANO, 22, 1500, key=HK) == 0.0022
    # 缓存命中没有读缓存倍率，按全价。
    assert generation_pricing.estimate_text_cost_cny(
        NANO, 18015, 1, key=HK, cached_tokens=18000) == 0.0127


@pytest.mark.parametrize("group, row, note", [
    ("vip", {}, "非 default 分组"),
    (None, {"quota_type": 1, "model_price": 0.08}, "按次计价"),
    (None, {"model_ratio": None}, "缺模型倍率"),
    (None, {"completion_ratio": None}, "缺补全倍率"),
    (None, {"enable_groups": ["vip"]}, "default 分组未开通"),
])
def test_openai_hk_text_outside_the_verified_case_stays_unpriced(isolated_data_root, monkeypatch,
                                                                 group, row, note):
    monkeypatch.setitem(generation_pricing._PRICES["text_yuan_per_million_tokens"],
                        NANO, {"input": 1, "output": 1})  # 不回落到打包价格表
    _hk_snapshot(**row)
    key = _key("HK", base_url="https://api.openai-hk.com", model=NANO, group=group)
    assert generation_pricing.estimate_text_cost_cny(NANO, 1000, 1000, key=key) is None, note


def test_openai_hk_text_without_a_synced_row_stays_unpriced(isolated_data_root):
    assert generation_pricing.estimate_text_cost_cny(NANO, 1000, 1000, key=HK) is None


# ---------------------------------------------------------------- 网关结算


@pytest.fixture
def relay(isolated_data_root, monkeypatch):
    model_routes._cooldowns.clear()
    gateway_quota._inflight.clear()
    gateway_live._calls.clear()
    _sync_tuzi(monkeypatch)
    owner, token = gateway_keys.create_key("文本计价")
    client = TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {token}"})

    def use(key, handle):
        keys.add_key(key)
        monkeypatch.setattr(gateway_openai, "_client", lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(handle)))
        return client
    yield use
    gateway_quota._inflight.clear()
    gateway_live._calls.clear()


def _rows():
    return gateway_tasks.read_usage(gateway_tasks._now().astimezone().strftime("%Y-%m"))


def test_success_charges_token_price_and_reads_completion_tokens(relay):
    # Tuzi 转 Claude 同时回 completion_tokens=1 与 output_tokens=0，账单按 completion_tokens。
    client = relay(TUZI, lambda request: httpx.Response(200, json={"choices": [], "usage": {
        "prompt_tokens": 1088, "completion_tokens": 1, "input_tokens": 1088, "output_tokens": 0}}))
    assert client.post(f"{BASE}/chat/completions", json={"model": SONNET}).status_code == 200
    row = _rows()[0]
    assert (row["input_tokens"], row["output_tokens"]) == (1088, 1)
    assert row["charged_cny"] == row["actual_cost_cny"] == 0.00153
    assert row["actual_cost_source"] == "price_table" and row["usage_missing"] is None


def test_openai_hk_text_through_the_gateway_is_charged(relay):
    """以前经网关转发到 OpenAI-HK 的文本 / Agent 调用扣 0；现在按控制台账单的公式计价。"""
    _hk_snapshot()
    client = relay(HK, lambda request: httpx.Response(200, json={"choices": [], "usage": {
        "prompt_tokens": 18015, "completion_tokens": 1}}))
    assert client.post(f"{BASE}/chat/completions", json={"model": NANO}).status_code == 200
    row = _rows()[0]
    assert row["charged_cny"] == row["actual_cost_cny"] == 0.0127
    assert row["actual_cost_source"] == "price_table"


def test_openrouter_usage_cost_is_charged_even_when_the_stream_fails(relay):
    key = _key("OR", provider="openrouter", base_url="https://openrouter.ai/api/v1", model=SONNET)
    wire = b'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":0.001}}\n\n'

    class Broken(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield wire
            raise httpx.ReadError("lost connection")

    client = relay(key, lambda request: httpx.Response(200, stream=Broken()))
    client.post(f"{BASE}/chat/completions", json={"model": SONNET, "stream": True})
    row = _rows()[0]
    assert row["status"] == "failed"
    assert row["charged_cny"] == row["actual_cost_cny"] == 0.007  # 0.001 美元 × 7
    assert row["actual_cost_source"] == "upstream"


def test_accepted_stream_without_usage_charges_nothing_and_is_counted(relay):
    client = relay(TUZI, lambda request: httpx.Response(200, stream=httpx.ByteStream(
        b'data: {"choices":[]}\n\ndata: [DONE]\n\n')))
    client.post(f"{BASE}/chat/completions", json={"model": SONNET, "stream": True})
    row = _rows()[0]
    assert row["status"] == "done" and row["charged_cny"] == 0
    assert row["usage_missing"] is True and row["actual_cost_cny"] is None
    now = datetime.now().astimezone()
    summary = gateway_stats.summarize(now - timedelta(days=1), now + timedelta(minutes=1))
    assert summary["tasks"]["text_usage_missing"] == 1


def test_never_accepted_call_is_not_marked_usage_missing(relay):
    def refuse(request):
        raise httpx.ConnectError("refused")
    client = relay(TUZI, refuse)
    client.post(f"{BASE}/chat/completions", json={"model": SONNET})
    row = _rows()[0]
    assert row["status"] == "failed" and row["charged_cny"] == 0
    assert row["usage_missing"] is None


def test_admission_reserves_with_the_token_price(relay):
    seen = []

    def handle(request):
        seen.append(gateway_quota.usage_summary(gateway_keys.read_config().keys[0])[0])
        return httpx.Response(200, json={"choices": [], "usage": {
            "prompt_tokens": 10, "completion_tokens": 1}})
    gateway_keys.update_key(gateway_keys.read_config().keys[0].id,
                            limits=[{"period": "day", "cap_cny": 1}])
    client = relay(TUZI, handle)
    client.post(f"{BASE}/chat/completions", json={"model": SONNET, "messages": ["x" * 3000]})
    assert seen and seen[0]["reserved_cny"] > 0
