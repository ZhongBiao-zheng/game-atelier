"""Use the same public HTTP surface as a paid run, with a loopback-only fake vendor."""

from pathlib import Path

import pytest

from scripts.agent_eval.driver import decide, run_case
from scripts.agent_eval.fake import FakeProvider
from scripts.agent_eval.host import serve
from scripts.agent_eval.observations import job_cost, usage_from


def test_overrun_cancels_turn_before_generation_and_preserves_usage(tmp_path):
    case = {
        "id": "stop",
        "title": "预算",
        "surface": "studio",
        "settings": {"permission": "auto"},
        "turns": [{"say": "画一位旅行者。"}, {"say": "改变披风颜色"}],
        "limits": {"max_results": 1, "max_steps": 30, "max_seconds": 25, "max_cost_cny": 1},
    }
    root = Path(__file__).resolve().parents[1]
    with FakeProvider(["eval/chat"]) as vendor:
        with serve(root, keys_from=None, providers=[], fake_keys=vendor.keys) as api:
            row = run_case(api, case, "eval/chat", tmp_path, tmp_path / "results", 0.0001)
            assert api.get("/api/jobs").json() == []
    assert (row["status"], row["reason"]) == ("stopped", "budget_exceeded")
    assert row["usage"]["total_cost_cny"] > 0.0001
    assert row["effective_settings"]["permission_mode"] == "review"
    assert [m["text"] for m in row["messages"] if m["role"] == "user"] == ["画一位旅行者。"]


def test_single_card_requires_a_recognized_quote_and_reserves_output_count():
    cards = [
        {
            "tool": "run_generation",
            "call_id": "one",
            "summary": "1 项生成，预计 3 元\n模型 · 3 份 · 航拍",
        },
        {"tool": "run_generation", "call_id": "two", "summary": "1 项生成，未计价"},
        {
            "tool": "run_generation",
            "call_id": "three",
            "summary": "1 项生成，预计 0 元\n模型 · 1 份 · 图",
        },
    ]
    decisions, records = decide(None, "", cards, money_left=3, count_left=3, turn_index=1)
    assert [d["approve"] for d in decisions] == [True, False, False]
    assert [r["approved"] for r in records] == [True, False, False]


@pytest.mark.parametrize(
    "params,amount,source",
    [
        ({"estimated_cost_cny": 0.3, "actual_cost_cny": 0}, 0, "actual"),
        ({"estimated_cost_cny": 0.3}, 0.3, "estimated"),
        ({}, 0.5, "approval_estimate"),
    ],
)
def test_actual_charge_then_job_estimate_then_approval_quote(params, amount, source):
    job = {"params": params, "_approval_estimate": 0.5}
    assert job_cost(job) == (amount, source)
    result = usage_from(
        {"requests": 1, "cost_cny": 0.1, "source": "local", "unpriced": 0}, [job], {}
    )
    assert result["total_cost_cny"] == pytest.approx(amount + 0.1)
    assert result["cost_complete"]


@pytest.mark.parametrize(
    "state,logged,cancel_confirmed,lose_post,expected,timeout",
    [
        ("running", 0, True, False, False, False),
        ("running", 1, True, False, False, True),
        ("running", 1, True, False, False, False),
        ("running", 0, True, True, False, False),
        ("awaiting_approval", 1, False, False, False, False),
        ("awaiting_approval", 1, True, False, True, False),
    ],
)
def test_cancelled_inflight_request_may_settle_after_report(
    tmp_path, monkeypatch, state, logged, cancel_confirmed, lose_post, expected, timeout
):
    import json

    import requests

    import scripts.agent_eval.driver as driver

    def response(payload, code=200):
        reply = requests.Response()
        reply.status_code = code
        reply._content = json.dumps(payload).encode()
        return reply

    class SnapshotAPI:
        cancelled = False

        def get(self, path):
            if path.endswith("/skills"):
                return response({"skills": []})
            if path.endswith("/usage"):
                return response(
                    {"requests": logged, "cost_cny": 0.1 * logged, "unpriced": 0, "source": "local"}
                )
            if path.endswith("/jobs"):
                return response({"jobs": []})
            return response(
                {
                    "status": "interrupted" if self.cancelled else state,
                    "turns": [
                        {"steps": [{"step_id": "visible", "tool": "test", "status": "running"}]}
                    ],
                }
            )

        def post(self, path, **kwargs):
            if path.endswith("/cancel"):
                self.cancelled = True
                return response({"status": "interrupted"}, 200 if cancel_confirmed else 503)
            assert path.endswith("/messages")
            if lose_post:
                raise requests.exceptions.ReadTimeout()
            return response({"status": "running"})

    monkeypatch.setattr(driver, "set_up", lambda *args: ("/session", None, {}))
    case = {
        "id": "cancel",
        "title": "取消",
        "surface": "studio",
        "turns": [{"say": "生成"}],
        "limits": {"max_steps": 1, "max_cost_cny": 1.0, "max_seconds": 20, "max_results": 1},
    }
    if timeout:
        from types import SimpleNamespace

        ticks = iter([0.0, 0.1, 21.0, 21.0])
        monkeypatch.setattr(driver, "time", SimpleNamespace(monotonic=lambda: next(ticks)))
        case["limits"]["max_steps"] = 30
    api = SnapshotAPI()
    row = run_case(api, case, "fake/chat", tmp_path, tmp_path / "out", 1)
    assert api.cancelled
    if timeout:
        assert row["reason"] == "max_seconds"
    assert row["usage"]["total_cost_cny"] == 0.1 * logged
    assert row["usage"]["cost_complete"] is expected
    assert any("可能仍在结算" in item for item in row["unobservable"]) == (not expected)


def test_legacy_studio_and_rounded_canvas_quotes():
    from scripts.agent_eval.driver import _single_quote

    def decide_single(summary, money):
        cards = [{"tool": "run_generation", "call_id": "one", "summary": summary}]
        return decide(None, "", cards, money, 3, 1)[0][0]["approve"]

    assert not decide_single("1 项生成，预计 0.25 元", 0.25)
    assert not decide_single("1 项生成，未计价", 1)
    assert not decide_single("1 项生成，预计 1...2 元", 10)
    summary = "在节点 node 上生成 2 个结果\n模型 · 预计 0.25¥"
    assert _single_quote({"summary": summary})[0]["estimate_cny"] == 0.25
    assert not decide_single(summary, 0.25)
    assert decide_single(summary, 0.255)
    assert decide_single("在节点 node 上生成 1 个结果\n模型 · 预计 <0.01¥", 0.01)
    assert decide_single("在节点 node 上生成 1 个结果\n模型 · 预计 0¥", 0)


def test_gateway_charge_reported_on_another_job_has_no_additional_estimated_cost():
    job = {"job_id": "copy", "params": {"gateway_charged_on": "original", "estimated_cost_cny": 1}}
    assert job_cost(job) == (0, "charged_on_other_job")


def test_four_result_cap_reserves_each_batch_item_and_each_card():
    from types import SimpleNamespace

    class Quotes:
        def get(self, url):
            amounts = [3, 2, 1] if "first" in url else [1]
            return SimpleNamespace(
                ok=True,
                json=lambda: {
                    "items": [
                        {"index": i, "count": n, "estimate_cny": n / 4, "model": "image"}
                        for i, n in enumerate(amounts)
                    ]
                },
            )

    cards = [{"tool": "run_generations", "call_id": call} for call in ("first", "second")]
    decisions, records = decide(Quotes(), "/session", cards, 3.0, 4, 1)
    assert decisions == [
        {"call_id": "first", "approve": True, "items": [0, 2]},
        {"call_id": "second", "approve": False},
    ]
    assert records[0]["items"][0]["reserved_results"] == 3


def test_inflight_jobs_reserve_requested_quantity_and_terminal_jobs_count_real_outputs():
    from scripts.agent_eval.driver import occupied_results

    jobs = [
        {"kind": "image", "status": "pending", "params": {"n": 3}, "output_paths": []},
        {"kind": "video", "status": "partial", "params": {"n": 4}, "output_paths": ["only.mp4"]},
        {"kind": "image", "status": "failed", "params": {"n": 2}, "output_paths": []},
        {"kind": "video", "status": "done", "params": {"n": 1}, "output_paths": ["a.mp4", "b.mp4"]},
    ]
    assert occupied_results(jobs) == 6
    jobs[0].update(status="failed")
    assert occupied_results(jobs) == 3


def test_zero_result_cap_without_global_budget_refuses_generation_in_auto(tmp_path):
    root = Path(__file__).resolve().parents[1]
    case = {
        "id": "zero",
        "title": "零份",
        "surface": "studio",
        "settings": {"permission": "auto"},
        "turns": [{"say": "画一个旅行者。"}],
        "limits": {"max_results": 0, "max_cost_cny": 2, "max_steps": 30, "max_seconds": 20},
    }
    with (
        FakeProvider(["eval/chat"]) as vendor,
        serve(root, keys_from=None, providers=[], fake_keys=vendor.keys) as api,
    ):
        row = run_case(api, case, "eval/chat", tmp_path, tmp_path / "out", None)
        assert api.get("/api/jobs").json() == []
    assert row["status"] == "completed"
    assert row["effective_settings"]["permission_mode"] == "review"
    assert row["approvals"] and not any(a["approved"] for a in row["approvals"])


def test_canvas_selected_reference_is_connected_to_actual_result_node(tmp_path):
    root = Path(__file__).resolve().parents[1]
    case = {
        "id": "13-canvas-turnaround",
        "surface": "canvas",
        "title": "画布选中角色图",
        "canvas": {
            "nodes": [{"id": "hero", "type": "image", "title": "女剑客", "file": "hero-a.png"}],
            "selected": ["hero"],
        },
        "turns": [{"say": "做一张她的三视图"}],
        "limits": {"max_results": 2, "max_cost_cny": 2, "max_steps": 30, "max_seconds": 20},
    }
    folder = root / "scripts/agent_eval/fixtures"
    with (
        FakeProvider(["eval/chat"]) as vendor,
        serve(root, keys_from=None, providers=[], fake_keys=vendor.keys) as api,
    ):
        row = run_case(api, case, "eval/chat", folder, tmp_path / "out", None)
    [message] = [m for m in row["messages"] if m["role"] == "user"]
    assert [ref["node_id"] for ref in message["references"]] == ["hero"]
    [job] = row["generations"]
    assert job["on_canvas"] is True and row["turn_outcomes"][0]["on_canvas"] is True
    mark = job["canvas_evidence"]
    assert mark["selected_node_ids"] == mark["linked_node_ids"] == ["hero"]
    assert len(mark["output_version_ids"]) == 1
    assert mark["output_version_ids"] == mark["visible_version_ids"]
