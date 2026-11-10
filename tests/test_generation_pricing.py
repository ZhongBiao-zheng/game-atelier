import json
from pathlib import Path

import pytest

from character_workflow.lib import generation_pricing as pricing

CASES = json.loads(
    (Path(__file__).parent / "fixtures/generation_cost_cases.json").read_text()
)


@pytest.mark.parametrize("case", CASES)
def test_shared_generation_cases(case):
    assert pricing.estimate_cost_cny(**case["request"]) == case["expected"]


def test_text_unknown_price():
    assert pricing.estimate_text_cost_cny("unknown", 1000, 1000) is None


def test_text_token_rates(monkeypatch):
    monkeypatch.setitem(pricing._PRICES, "text_yuan_per_million_tokens", {
        "test-model": {"input": 2, "output": 8},
    })
    assert pricing.estimate_text_cost_cny("test-model", 1000, 2000) == 0.018
    assert pricing.estimate_text_cost_cny("test-model", 0, 0) == 0
    assert pricing.estimate_text_cost_cny("TEST-MODEL", 1000, 2000) is None


@pytest.mark.parametrize("kind,model,params", [
    ("image", "gpt-image-2", {"size": "1024x1024", "quality": "medium"}),
    ("video", "sora-2-pro", {"duration": 10, "resolution": "720p"}),
])
def test_batch_estimates_match_single_submission(monkeypatch, kind, model, params):
    from character_workflow.lib import keys
    from character_workflow.lib.keys import KeySpec, ModelSpec
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app

    key = KeySpec(alias="test", provider="custom", access_key="test-only",
                  base_url="https://api.openai-hk.com", created_at="2026-10-26T00:00:00Z",
                  models=[ModelSpec(id=model, name=model, modality=kind)])
    monkeypatch.setattr(keys, "find_by_alias", lambda alias: key if alias == "test" else None)
    with LocalTestClient(app=build_app(), base_url="http://127.0.0.1") as client:
        response = client.post("/api/pricing/estimate-batch", json={
            "kind": kind, "params": params, "items": [
                {"alias": "test", "model": model}, {"alias": "test", "model": "unknown"},
                {"alias": "missing", "model": model}, {"alias": "@auto", "model": "missing"},
            ],
        })
        assert response.status_code == 200
        assert response.json() == {
            f"test:{model}": pricing.estimate_submission(key, model, kind, params),
            "test:unknown": None, f"missing:{model}": None, "@auto:missing": None,
        }


def test_tokendance_kling_video_picks_feature_and_skips_input_billing(monkeypatch):
    from character_workflow.lib import tokendance_prices

    def sku(res, rate, feature=None):
        specs = {"resolution": res, **({"feature": feature} if feature else {})}
        return {"specs": specs, "rate": rate, "unit": "seconds"}

    snapshot = {
        "kling-3.0": {"items": [
            {"id": "kling:motion-control:video_seconds", "skus": [sku("720p", "0.72")]},
            {"id": "kling:text2video:video_seconds", "skus": [
                sku("720p", "0.48", "silent"), sku("720p", "0.72", "sound")]},
        ]},
        "kling-4.0": {"items": [
            {"id": "kling:omni-video-v2:video_input_seconds", "skus": [sku("720p", "0.6")]},
            {"id": "kling:omni-video-v2:video_seconds", "skus": [sku("720p", "1"), sku("1080p", "1.5")]},
        ]},
    }
    monkeypatch.setattr(tokendance_prices, "model_pricing", snapshot.get)

    def cost(model, **kw):
        return pricing.estimate_cost_cny(kind="video", provider="tokendance",
                                 base_url="https://tokendance.space/gateway/v1",
                                 model_id=model, protocol="klingai", duration=5, **kw)

    assert cost("kling-3.0", resolution="720p") == 2.4
    assert cost("kling-3.0", resolution="720p", generate_audio=True) == 3.6
    assert cost("kling-4.0", resolution="1080p") == 7.5
    # 带参考视频要加「输入秒」计费，拿不到输入时长就不估。
    assert cost("kling-4.0", resolution="720p", has_reference_video=True) is None
