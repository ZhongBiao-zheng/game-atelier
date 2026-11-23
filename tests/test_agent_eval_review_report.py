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


@pytest.mark.parametrize(
    "pixels,ratio,verdict",
    [
        ((1456, 816), "16:9", "pass"),
        ((1344, 768), "16:9", "pass"),
        ((98, 100), "1:1", "pass"),
        ((102, 100), "1:1", "pass"),
        ((9799, 10000), "1:1", "fail"),
        ((10201, 10000), "1:1", "fail"),
    ],
)
def test_r4_ratio_accepts_inclusive_two_percent_relative_error(pixels, ratio, verdict):
    row = _row()
    row.update(expect={"ratio": ratio})
    row["generations"][0]["outputs"][0].update(width=pixels[0], height=pixels[1])
    check = machine_checks(row)["dimensions"]
    assert check["status"] == verdict
    assert "允许 ±2%" in check["reason"] and f"{pixels[0]}×{pixels[1]}" in check["reason"]


def test_r4_size_is_an_exact_pixel_requirement():
    row = _row()
    row.update(expect={"size": "1024x1536"})
    output = row["generations"][0]["outputs"][0]
    output.update(width=1024, height=1535)
    check = machine_checks(row)["dimensions"]
    assert (
        check["status"] == "fail"
        and "精确为 1024×1536" in check["reason"]
        and "1024×1535" in check["reason"]
    )
    output["height"] = 1536
    assert machine_checks(row)["dimensions"]["status"] == "pass"


@pytest.mark.parametrize(
    "observed,verdict",
    [(4.499, "fail"), (4.5, "pass"), (5.04, "pass"), (5.5, "pass"), (5.501, "fail"), (None, "na")],
)
def test_r4_duration_tolerance_is_inclusive_half_second(observed, verdict):
    row = _row()
    row.update(expect={"duration_s": 5})
    row["generations"][0]["outputs"] = [{"kind": "video", "duration_s": observed}]
    check = machine_checks(row)["duration_s"]
    assert check["status"] == verdict and "4.5 至 5.5 秒" in check["reason"]
    assert ("未知" if observed is None else f"{observed:.3f}") in check["reason"]
