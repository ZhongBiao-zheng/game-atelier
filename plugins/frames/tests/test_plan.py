"""抽帧计划与输出尺寸：与界面共用 plan_cases.json。"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("frames_plan_under_test", HERE.parent / "server" / "plan.py")
plan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plan)
CASES = json.loads((HERE / "plan_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES["plan"], ids=[case["name"] for case in CASES["plan"]])
def test_plan_frames(case):
    if "error" in case:
        with pytest.raises(ValueError, match=case["error"]):
            plan.plan_frames(case["frame_count"], case["fps"], case["params"])
    else:
        assert plan.plan_frames(case["frame_count"], case["fps"], case["params"]) == case["expect"]


@pytest.mark.parametrize("case", CASES["size"], ids=[case["name"] for case in CASES["size"]])
def test_output_size(case):
    assert list(plan.output_size(case["width"], case["height"], case["long_edge"])) == case["expect"]


@pytest.mark.parametrize("bad", [{"start": "0"}, {"start": True}, {"count": float("nan")}, {"mode": "every"}])
def test_rejects_malformed_params(bad):
    with pytest.raises(ValueError):
        plan.plan_frames(100, 24, {"start": 0, "end": None, "mode": "count", "count": 3, **bad})


@pytest.mark.parametrize("long_edge", [8, 5000, 512.0, True])
def test_rejects_out_of_range_long_edge(long_edge):
    with pytest.raises(ValueError):
        plan.output_size(100, 100, long_edge)
