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
