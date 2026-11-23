"""Verify evaluation accounting against a real isolated server and loopback providers."""

import io
import json
from pathlib import Path

import pytest
import requests
import yaml

from scripts.agent_eval import __main__ as cli
from scripts.agent_eval.fake import Handler
from scripts.agent_eval.host import LocalAPI


def demand(case_id):
    return {
        "id": case_id,
        "title": case_id,
        "surface": "studio",
        "turns": [{"say": case_id}],
        "limits": {"max_results": 1, "max_cost_cny": 2, "max_seconds": 30, "max_steps": 20},
    }


def run_matrix(tmp_path, names):
    path = tmp_path / "cases.yaml"
    path.write_text(yaml.safe_dump([demand(name) for name in names]), encoding="utf-8")
    output = tmp_path / "out"
    args = [
        "run",
        "--server-root",
        str(Path(__file__).resolve().parents[1]),
        "--cases",
        str(path),
        "--fixtures",
        str(tmp_path),
        "--budget-cny",
        "10",
        "--out",
        str(output),
    ]
    code = cli.main(args)
    rows = [json.loads(line) for line in (output / "results.jsonl").read_text().splitlines()]
    return code, rows


def test_rejected_chat_has_no_inflight_charge_and_next_real_session_runs(monkeypatch, tmp_path):
    original = Handler.do_POST

    def reject_first(self):
        if self.path.endswith("/chat/completions"):
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            last_user = next(
                m for m in reversed(json.loads(raw)["messages"]) if m["role"] == "user"
            )
            if "rate-limited" in str(last_user["content"]):
                self.send_error(429, "request rejected")
                return
            self.rfile = io.BytesIO(raw)
        return original(self)

    monkeypatch.setattr(Handler, "do_POST", reject_first)
    code, rows = run_matrix(tmp_path, ["rate-limited", "make-picture"])
    assert code == 0
    assert [(row["case_id"], row["status"]) for row in rows] == [
        ("rate-limited", "failed"),
        ("make-picture", "completed"),
    ]
    assert "429" in rows[0]["reason"] and rows[0]["usage"]["cost_complete"]
    assert rows[0]["usage"]["total_cost_cny"] == 0
    assert rows[1]["usage"]["total_cost_cny"] > 0


def test_lost_approval_reply_never_replays_post_or_starts_next_case(monkeypatch, tmp_path):
    original = LocalAPI.request
    approvals = []

    def lose_reply(self, method, url, **kwargs):
        response = original(self, method, url, **kwargs)
        if method.upper() == "POST" and url.endswith("/approvals"):
            approvals.append(kwargs.get("timeout"))
            response.close()  # server accepted the call; the evaluating client lost the reply
            raise requests.ReadTimeout("lost reply")
        return response

    monkeypatch.setattr(LocalAPI, "request", lose_reply)
    code, rows = run_matrix(tmp_path, ["make-picture", "unstarted"])
    assert code == 0
    assert approvals == [120]
    assert len(rows) == 1
    assert rows[0]["status"] == "failed"
    assert not rows[0]["usage"]["cost_complete"]
    assert len(rows[0]["generations"]) == 1


@pytest.mark.parametrize("state", ["failed", "interrupted"])
def test_terminal_local_state_keeps_explicit_unsettled_provider_charge(state):
    from scripts.agent_eval.driver import request_may_be_in_flight

    assert request_may_be_in_flight(
        {"status": state, "error": "连接中断，未自动重发（可能已计费）"}
    )
    assert not request_may_be_in_flight({"status": state, "error": "对话模型返回错误 429：已限流"})


def test_interrupt_after_paid_post_keeps_both_rows_and_costs(monkeypatch, tmp_path):
    original = LocalAPI.request
    submits = []

    def interrupt_after_second_approval(self, method, url, **kwargs):
        response = original(self, method, url, **kwargs)
        if method.upper() == "POST" and url.endswith("/approvals"):
            submits.append(url)
            if len(submits) == 2:
                response.close()
                raise KeyboardInterrupt
        return response

    monkeypatch.setattr(LocalAPI, "request", interrupt_after_second_approval)
    code, rows = run_matrix(tmp_path, ["completed", "interrupted-demand", "unstarted"])
    assert code == 130
    assert [r["case_id"] for r in rows] == ["completed", "interrupted-demand"]
    assert rows[0]["status"] == "completed" and rows[0]["usage"]["cost_complete"]
    partial = rows[1]
    assert (partial["status"], partial["reason"]) == ("stopped", "interrupted")
    assert not partial["usage"]["cost_complete"]
    assert partial["usage"]["chat_cost_cny"] > 0
    assert partial["usage"]["generation_cost_cny"] == 0.25
    assert partial["usage"]["total_cost_cny"] > 0.25
    assert len(submits) == 2 and len(partial["generations"]) == 1
    assert partial["approvals"] and partial["turn_outcomes"][0]["reason"] == "interrupted"


def test_interrupt_waiting_for_approval_cancels_turn(monkeypatch, tmp_path):
    original = LocalAPI.request
    cancelled = []
    interrupted = False

    def interrupt_at_card(self, method, url, **kwargs):
        nonlocal interrupted
        response = original(self, method, url, **kwargs)
        if method.upper() == "GET" and not interrupted and "/approvals/" in url:
            interrupted = True
            response.close()
            raise KeyboardInterrupt
        if method.upper() == "POST" and url.endswith("/cancel"):
            cancelled.append(url)
        return response

    monkeypatch.setattr(LocalAPI, "request", interrupt_at_card)
    code, rows = run_matrix(tmp_path, ["interrupt-at-card"])
    assert interrupted and len(cancelled) == 1
    assert code == 130 and len(rows) == 1
    assert rows[0]["reason"] == "interrupted"
    assert rows[0]["usage"]["chat_cost_cny"] > 0
    assert rows[0]["usage"]["generation_cost_cny"] == 0
    assert not rows[0]["usage"]["cost_complete"]


def test_interrupt_while_saving_final_media_preserves_charge(monkeypatch, tmp_path):
    from scripts.agent_eval import driver

    original = driver.media_evidence
    interrupted = False

    def stop_once(*args):
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            raise KeyboardInterrupt
        return original(*args)

    monkeypatch.setattr(driver, "media_evidence", stop_once)
    code, rows = run_matrix(tmp_path, ["produced"])
    assert code == 130 and len(rows) == 1
    assert rows[0]["reason"] == "interrupted"
    assert not rows[0]["usage"]["cost_complete"]
    assert rows[0]["usage"]["generation_cost_cny"] == 0.25
    assert len(rows[0]["generations"]) == 1
