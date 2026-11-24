"""End-to-end runs against a disposable viewer service and loopback vendor."""

import json
from pathlib import Path
import sys

import pytest

from scripts.agent_eval import cli
from scripts.agent_eval.driver import run_case
from scripts.agent_eval.fake import FakeProvider
from scripts.agent_eval.host import serve

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="隔离评测服务只支持 macOS 与 Linux")


def test_matrix_stops_at_ninety_percent_and_reports_scrubbed_outputs(tmp_path, monkeypatch):
    # Exercise the real loopback service, chat SDK, job runner, scoring and all artifact writers.
    key = "temporary-eval-test-key-010203040506"

    class KnownKeyProvider(cli.FakeProvider):
        def __init__(self, models):
            super().__init__(models)
            for channel in self.keys["keys"]:
                channel["access_key"] = key

    monkeypatch.setattr(cli, "FakeProvider", KnownKeyProvider)
    cases = tmp_path / "cases.yaml"
    case = {
        "id": "redaction",
        "title": "报告文字脱敏",
        "turns": [{"say": "请出图 " + key}],
        "surface": "studio",
        "settings": {"creation_mode": "image", "permission": "review"},
    }
    cases.write_text(json.dumps([case, case | {"id": "must-skip"}]), encoding="utf-8")
    out = tmp_path / "out"
    assert cli.main(["run", "--cases", str(cases), "--out", str(out), "--budget-cny", "0.275"]) == 0
    [row] = [json.loads(s) for s in (out / "results.jsonl").read_text().splitlines()]
    assert row["case_id"] == "redaction" and row["status"] == "completed"
    assert row["generations"][0]["outputs"][0]["width"] == 640
    assert 0.275 * 0.9 <= row["usage"]["total_cost_cny"] < 0.275
    assert "90%" in row["matrix_stop_reason"] and "[redacted]" in row["turns"][0]["say"]
    for path in out.rglob("*"):
        if path.is_file():
            assert key.encode() not in path.read_bytes()


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
