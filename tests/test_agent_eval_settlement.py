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


def run_matrix(tmp_path, names, budget=True):
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
        "--out",
        str(output),
    ]
    if budget:
        args.extend(["--budget-cny", "10"])
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


def stream_without_usage(self, body, fail):
    frame = {
        "id": "loopback",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": body["model"],
    }
    first = {
        **frame,
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": "生成过文字"},
                "finish_reason": None,
            }
        ],
    }
    final = (
        {"error": {"message": "stream closed after producing tokens", "type": "server_error"}}
        if fail
        else {**frame, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
    )
    data = "".join("data: " + json.dumps(event) + "\n\n" for event in (first, final))
    self.send_payload((data + "data: [DONE]\n\n").encode(), "text/event-stream")


@pytest.mark.parametrize("reply", ["stream_error", "http_500", "missing_usage", "after_approval"])
def test_uncertain_provider_reply_cannot_spend_next_budget(monkeypatch, tmp_path, reply):
    original = Handler.do_POST
    count = 0

    def answer(self):
        nonlocal count
        if not self.path.endswith("/chat/completions"):
            return original(self)
        count += 1
        if reply == "after_approval" and count == 1:
            return original(self)
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if reply == "http_500":
            return self.send_error(500, "upstream status unknown")
        return stream_without_usage(self, body, fail=reply == "stream_error")

    monkeypatch.setattr(Handler, "do_POST", answer)
    code, rows = run_matrix(tmp_path, ["make-picture", "unstarted"])
    assert code == 0 and len(rows) == 1
    row = rows[0]
    assert row["case_id"] == "make-picture" and not row["usage"]["cost_complete"]
    if reply in {"missing_usage", "after_approval"}:
        assert row["status"] == "completed"
        assert any("token 用量" in notice for notice in row["unobservable"])
    else:
        assert row["status"] == "failed"
        assert any("结算" in notice for notice in row["unobservable"])
    if reply == "after_approval":
        assert row["usage"]["total_cost_cny"] > 0.25
        assert row["usage"]["chat_requests"] == 2
    else:
        assert row["usage"]["total_cost_cny"] == 0


@pytest.mark.parametrize("error", ["401：", "403：", "429："])
def test_explicit_provider_rejection_and_local_max_steps_are_terminal(error):
    from scripts.agent_eval.driver import request_may_be_in_flight

    assert not request_may_be_in_flight({"status": "failed", "error": "对话模型返回错误 " + error})
    assert not request_may_be_in_flight(
        {"status": "failed", "error": "这一轮步骤太多，已停下；可以让它继续"}
    )


def test_missing_sse_usage_without_global_budget_preserves_each_row(monkeypatch, tmp_path):
    original = Handler.do_POST

    def unmetered(self):
        if not self.path.endswith("/chat/completions"):
            return original(self)
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        return stream_without_usage(self, body, fail=False)

    monkeypatch.setattr(Handler, "do_POST", unmetered)
    code, rows = run_matrix(tmp_path, ["first", "second"], budget=False)
    assert code == 0 and len(rows) == 2
    assert all(r["status"] == "completed" and not r["usage"]["cost_complete"] for r in rows)
