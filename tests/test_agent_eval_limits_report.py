import pytest

from scripts.agent_eval.report import machine_checks
from tests.test_agent_eval_report import _row


@pytest.mark.parametrize("reason", ["max_steps", "max_results", "max_cost_cny"])
def test_agent_limit_stops_keep_partial_evidence_and_fail_generation_limit(reason):
    row = _row()
    row.update(status="stopped", reason=reason)
    row["generations"][0]["outputs"][0].update(width=64, height=32)
    checks = machine_checks(row)
    assert (
        checks["generation_limit"]["status"] == "fail"
        and reason in checks["generation_limit"]["reason"]
    )
    assert all(
        checks[key]["status"] == "pass"
        for key in ("images", "dimensions", "model_family", "uses_all_attachments")
    )
    assert all(
        checks[key]["status"] == "na"
        for key in ("skills", "asks_user", "no_resubmit_after_failure")
    )
    row["expect"].update(images=2, size="32x32")
    checks = machine_checks(row)
    assert checks["images"]["status"] == checks["dimensions"]["status"] == "fail"


def test_agent_step_limit_with_no_artifacts_only_fails_own_turn():
    row = _row()
    expect = {"images": 0, "asks_user": False}
    row.update(
        status="stopped",
        reason="max_steps",
        turns=[{"say": "A", "expect": expect}, {"say": "B", "expect": expect}, {"say": "C"}],
        generations=[],
        expect=expect,
        turn_outcomes=[
            {"turn_index": 1, "status": "completed", "final_reply": "完成"},
            {"turn_index": 2, "status": "stopped", "reason": "max_steps"},
        ],
    )
    checks = machine_checks(row)
    assert checks["1.generation_limit"]["status"] == "pass"
    assert checks["2.generation_limit"]["status"] == "fail"
    assert checks["2.images"]["status"] == checks["2.asks_user"]["status"] == "na"
    assert all(grade["status"] == "na" for key, grade in checks.items() if key.startswith("3."))


def test_cancelled_and_failed_jobs_consume_every_requested_result_even_without_media(tmp_path):
    from scripts.agent_eval.report import compare, write_report

    row = _row()
    row.update(
        expect={"images": 2},
        generations=[
            {"kind": "image", "status": "failed", "requested_results": 3, "outputs": []},
            {"kind": "video", "status": "cancelled", "requested_results": 2, "outputs": []},
        ],
    )
    old, new = tmp_path / "before", tmp_path / "after"
    write_report(old, [row])
    assert row["result_counts"] == {
        "submitted": 5,
        "submitted_min": 5,
        "delivered": 0,
        "delivered_min": 0,
    }
    assert row["checks"]["generation_limit"]["status"] == "fail"
    first = (old / "index.html").read_text()
    assert "已提交份数 <b>5</b>" in first and "已交付份数 <b>0</b>" in first
    row["generations"][0]["requested_results"] = 2
    write_report(new, [row])
    assert row["checks"]["generation_limit"]["status"] == "pass"
    comparison = compare(old, new, tmp_path)
    assert "已提交份数  |  5  |  4" in comparison and "已交付份数  |  0  |  0" in comparison


@pytest.mark.parametrize(
    "generations,expected,verdict,quantity",
    [
        (
            [{"kind": "image", "requested_results": None, "params": {"n": 1}, "outputs": []}],
            1,
            "na",
            "至少 1",
        ),
        (
            [{"kind": "video", "requested_results": None, "outputs": [{"kind": "video"}] * 3}],
            1,
            "na",
            "至少 1",
        ),
        ([{"kind": "image", "params": {"n": 4}, "outputs": []}], 1, "fail", "4"),
        (
            [{"kind": "image", "params": {"n": 1, "actual_n": 1}, "outputs": [{"kind": "image"}]}],
            1,
            "na",
            "至少 1",
        ),
        (
            [{"kind": "image", "model": "mj-fast", "params": {"n": 1}, "outputs": []}],
            1,
            "fail",
            "4",
        ),
    ],
)
def test_submitted_quantity_uses_evidence_and_preserves_unknown_upper_bound(
    generations, expected, verdict, quantity
):
    row = _row()
    row.update(expect={"images": expected}, generations=generations)
    grade = machine_checks(row)["generation_limit"]
    assert grade["status"] == verdict and f"已提交份数 {quantity}，" in grade["reason"]


def test_three_jobs_with_unknown_quantities_prove_three_submissions_without_delivery():
    row = _row()
    row.update(
        expect={"images": 1},
        generations=[
            {"kind": "image", "requested_results": None, "outputs": [], "status": "failed"}
            for _ in range(3)
        ],
    )
    check = machine_checks(row)["generation_limit"]
    assert check["status"] == "fail" and "已提交份数 至少 3，已交付份数 0" in check["reason"]
