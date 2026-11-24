import pytest

from scripts.agent_eval.report import compare, machine_checks, write_report
from tests.test_agent_eval_report import _row


@pytest.mark.parametrize(
    "status,reason",
    [
        ("failed", "HTTP 401"),
        ("failed", "HTTP 429"),
        ("stopped", "max_seconds"),
        ("stopped", "interrupted"),
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


@pytest.mark.parametrize(
    "expected,groups,hard_limit,verdict",
    [
        ({"images": 2}, [("image", 1), ("image", 1), ("image", 1)], 4, "pass"),
        ({"images": 2}, [("image", 4)], 3, "pass"),
        ({"images": 2}, [("image", 5)], 10, "fail"),
        ({"images": 0}, [("image", 1)], 2, "fail"),
        ({"images": 0}, [], 0, "pass"),
        ({"images": 1, "videos": 1}, [("image", 1), ("video", 3)], 4, "pass"),
        ({"videos": 1}, [("video", 2), ("image", 1)], 5, "fail"),
        ({}, [("image", 2)], 4, "na"),
    ],
)
def test_r6_counts_registered_results_against_per_turn_expected_plus_one_revision(
    expected,
    groups,
    hard_limit,
    verdict,
):
    row = _row()
    row.update(expect=expected, limits={"max_results": hard_limit})
    row["generations"] = [
        {
            "kind": kind,
            "requested_results": count,
            "turn_index": 1,
            "outputs": [{"kind": kind, "error": "media_unavailable"} for _ in range(count)],
        }
        for kind, count in groups
    ]
    grade = machine_checks(row)["generation_limit"]
    assert grade["status"] == verdict
    if expected:
        n = sum(expected.values())
        assert f"{n} 份 + 一轮修正最多 {n} 份 = 上限 {2 * n} 份" in grade["reason"]


def test_r6_two_turns_each_have_their_own_result_allowance():
    row = _row()
    row.update(
        turns=[{"say": "甲", "expect": {"images": 2}}, {"say": "乙"}],
        turn_outcomes=[
            {"turn_index": 1, "status": "completed"},
            {"turn_index": 2, "status": "completed"},
        ],
        expect={"images": 1},
        limits={"max_results": 10},
    )
    row["generations"] = [
        {"turn_index": index, "kind": "image", "requested_results": 3, "outputs": [{"kind": "image"}] * 3}
        for index in (1, 2)
    ]
    grades = machine_checks(row)
    assert (
        grades["1.generation_limit"]["status"] == "pass"
        and grades["2.generation_limit"]["status"] == "fail"
    )


@pytest.mark.parametrize(
    "model,expected,verdict",
    [
        ("sm/MJ_fast_imagine", "midjourney", "pass"),
        ("sm/v2-midjourney-pro", "midjourney", "pass"),
        ("sm/niji-7", "midjourney", "pass"),
        ("midjourney/flux", "midjourney", "fail"),
        ("sm/GPT_IMAGE_2", "gpt-image", "pass"),
        ("sm/NANO_BANANA_2", "nano-banana", "pass"),
        ("sm/GEMINI_3.1_FLASH_IMAGE_PREVIEW", "nano-banana", "pass"),
        ("sm/gemini-3-pro-image", "nano-banana", "pass"),
        ("sm/gemini-3-pro-text", "nano-banana", "fail"),
        ("sm/doubao-seededit-3.0", "seedream", "pass"),
        ("sm/doubao-seedream-5.0", "seedream", "pass"),
    ],
)
def test_model_families_follow_product_slug_and_gemini_image_aliases(model, expected, verdict):
    row = _row()
    row["expect"] = {"model_family": expected}
    row["generations"][0]["model"] = model
    check = machine_checks(row)["model_family"]
    assert check["status"] == verdict and model in check["reason"]


def test_partial_cost_is_in_recorded_total_without_entering_complete_cost_average(tmp_path):
    settled, interrupted = _row(), _row()
    settled.update(case_id="complete", directory="complete", generations=[])
    settled["usage"].update(cost_complete=True, total_cost_cny=1.125)
    interrupted.update(
        case_id="interrupted",
        directory="interrupted",
        generations=[],
        status="stopped",
        reason="keyboard_interrupt",
    )
    interrupted["usage"].update(
        cost_complete=False, chat_cost_cny=0.5, generation_cost_cny=0.25, total_cost_cny=0.75
    )
    after, before = tmp_path / "after", tmp_path / "before"
    write_report(after, [settled, interrupted])
    html = (after / "index.html").read_text()
    assert "已记录费用合计 / 元" in html and "<td>1.875</td>" in html
    assert "已记录费用（结算未完整）/ 元 <b>0.75</b>" in html
    interrupted["usage"].update(cost_complete=True, total_cost_cny=0.5)
    write_report(before, [settled, interrupted])
    table = compare(before, after, tmp_path)
    assert "已记录费用合计 / 元  |  1.625  |  1.875  |  +0.25" in table
    assert "未结清的运行数  |  0  |  1  |  +1" in table
    assert "平均费用 / 元  |  0.8125  |  1.125" in table
    assert (
        "已记录费用 / 元  |  0.5  |  0.75" in table and "费用记录  |  完整  |  结算未完整" in table
    )


def test_niji_inside_final_slug_is_midjourney():
    row = _row()
    row["expect"] = {"model_family": "midjourney"}
    row["generations"][0]["model"] = "gateway/custom-NiJi-image"
    assert machine_checks(row)["model_family"]["status"] == "pass"
