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
