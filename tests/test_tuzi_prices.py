"""Tuzi 价格快照：表达式结果何时还要乘分组倍率（2026-11-13 账单核对）。"""
from character_workflow.lib import tuzi_prices
from character_workflow.lib.tuzi_estimate import estimate

SEEDREAM_55 = "doubao-seedream-5-5-261028"
FLARE = "gpt-image-2.5-flare"
# 账单原文：Seedream 5.5 的表达式把官方人民币价除以 7，生效分组「官方优惠」再 ×7 扣成 $0.13。
SEEDREAM_55_EXPR = (
    'v2:(imagePixels(param("size")) > 0 && imagePixels(param("size")) <= 2610000)'
    ' ? tier("small", (input_image_count * 0.05 + output_image_count * 0.13) / 7)'
    ' : tier("large", (input_image_count * 0.05 + output_image_count * 0.23) / 7)'
)


class _Response:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


def _pricing_body():
    return {
        "success": True,
        "data": [
            {"model_name": SEEDREAM_55, "quota_type": 1, "model_price": 0,
             "enable_groups": ["default"]},
            {"model_name": FLARE, "quota_type": 1, "model_price": 0,
             "enable_groups": ["default"]},
        ],
        "group_ratio": {"default": 1, "官方优惠": 7},
        "group_model_pricing": {"default": {
            "billing_expr": {
                SEEDREAM_55: SEEDREAM_55_EXPR,
                FLARE: 'v2:tier("flat", output_image_count * 0.3)',
            },
            "pricing_source": {SEEDREAM_55: "global_fallback", FLARE: "group_override"},
            "effective_group": {SEEDREAM_55: "官方优惠"},
        }},
    }


def _sync(monkeypatch):
    monkeypatch.setattr(tuzi_prices, "_configured_models", lambda: {"default": {SEEDREAM_55, FLARE}})
    bodies = {
        "pricing": _pricing_body(),
        "status": {"success": True, "data": {"usd_exchange_rate": 0.7}},
    }
    monkeypatch.setattr(
        tuzi_prices.requests, "get",
        lambda url, timeout: _Response(bodies[url.rsplit("/", 1)[-1]]),
    )
    return tuzi_prices.sync()


def _estimate(model, size, refs=0):
    return estimate(model_id=model, provider="custom", base_url="https://api.tu-zi.com/v1",
                    billing_group="default", protocol=None, n=1, size=size, quality=None,
                    reference_image_count=refs)


def test_global_fallback_expression_is_multiplied_by_effective_group_ratio(monkeypatch):
    snapshot = _sync(monkeypatch)
    assert snapshot["expr_multiplier"] == {"default": {SEEDREAM_55: 7}}
    # 账单：1600x1600 无参考图扣 $0.13 = 0.091 元（汇率 0.7）。
    assert _estimate(SEEDREAM_55, "1600x1600") == 0.091
    assert _estimate(SEEDREAM_55, "1600x1600", refs=1) == 0.126
    assert _estimate(SEEDREAM_55, "2150x2150") == 0.161


def test_group_override_expression_is_already_final(monkeypatch):
    _sync(monkeypatch)
    # 账单：group_override 的 gpt-image-2.5-flare 表达式 0.3 即扣 $0.3。
    assert _estimate(FLARE, "1024x1024") == 0.21
