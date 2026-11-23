import pytest

from scripts.agent_eval.report import compare, machine_checks, write_report
from tests.test_agent_eval_report import _row


@pytest.mark.parametrize(
    "status,reason",
    [
        ("failed", "HTTP 401"),
        ("failed", "HTTP 429"),
        ("stopped", "max_seconds"),
        ("stopped", "max_steps"),
        ("not_applicable", "当前提交没有该接口"),
    ],
)
def test_incomplete_turn_without_activity_gets_no_behavioral_credit(status, reason):
    row = _row()
    row.update(
        status=status,
        reason=reason,
        generations=[],
        final_reply="",
        expect={"images": 0, "asks_user": False},
    )
    checks = machine_checks(row)
    assert all(check["status"] == "na" and reason in check["reason"] for check in checks.values())


def test_partial_run_counts_only_completed_turns_in_report_and_comparison(tmp_path):
    row = _row()
    row.update(
        turns=[{"say": "第一轮", "expect": {"images": 1}}, {"say": "第二轮"}],
        expect={"images": 0, "asks_user": False},
        status="failed",
        reason="HTTP 429",
        generations=[],
        turn_outcomes=[
            {"turn_index": 1, "status": "completed"},
            {"turn_index": 2, "status": "failed", "reason": "HTTP 429"},
        ],
    )
    before = tmp_path / "before"
    write_report(before, [row])
    assert row["checks"]["1.images"]["status"] == "fail"
    assert all(
        check["status"] == "na" for key, check in row["checks"].items() if key.startswith("2.")
    )
    index = (before / "index.html").read_text()
    assert (
        "未完成的运行数" in index and 'class="fail"><strong>未完成原因</strong>　HTTP 429' in index
    )
    assert index.count("审查模式 · 脚本代替用户裁决") == 2
    row.update(status="completed", reason="")
    row["turn_outcomes"][-1].update(status="completed", reason="", final_reply="完成")
    after = tmp_path / "after"
    write_report(after, [row])
    text = compare(before, after, tmp_path)
    assert "未完成的运行数  |  1  |  0  |  -1" in text and "未完成原因  |  HTTP 429  |  —" in text
    assert "总体检查通过率  |  66.7% (2/3)  |  85.7% (6/7)" in text
