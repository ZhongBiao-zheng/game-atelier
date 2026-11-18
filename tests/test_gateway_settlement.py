"""网关结算：失败只扣能确认上游已收费的（第三批第 1 步）。逐供应商按各家 caller 的实际回报方式驱动。"""
from __future__ import annotations

from pathlib import Path

import pytest

from character_workflow.lib import callers, gateway_tasks
from character_workflow.lib.job_runner import USD_TO_CNY, JobCanceled
from tests.test_gateway import _png, _submit, client  # noqa: F401 — 复用网关夹具


def _upstream_cost(usd, then=None):
    """EvoLink / OpenRouter：上游回报真实金额（on_cost_usd），之后成功或失败。"""
    def run(*, output_dir, on_cost_usd, **_kwargs):
        on_cost_usd(usd)
        if then is not None:
            raise then
        out = Path(output_dir) / "o.png"
        _png(out)
        return [str(out)]
    return run


def _price_table(cny, valid=True):
    """语音 / 图层拆分 / 音乐：caller 按价格表 × 上游回报数量写 params.actual_cost_cny。"""
    def run(*, output_dir, params, **_kwargs):
        params["actual_cost_cny"] = cny
        out = Path(output_dir) / "o.png"
        if valid:
            _png(out)
        else:
            out.write_bytes(b"not an image")
        return [str(out)]
    return run


def _no_cost(error=None):
    """OpenAI 兼容 / Tuzi / Ark / MJ / 自定义接口：没有实付，只能用估价。"""
    def run(*, output_dir, **_kwargs):
        if error is not None:
            raise error
        out = Path(output_dir) / "o.png"
        _png(out)
        return [str(out)]
    return run


HK_ESTIMATE = 0.08  # tests.test_gateway._seed_keys 写入的 OpenAI-HK 快照单价

CASES = [
    # (说明, caller 行为, 终态, 扣费, 实付来源)
    ("EvoLink 成功，上游回报 0.10 美元", _upstream_cost(0.10), "done",
     round(0.10 * USD_TO_CNY, 6), "upstream"),
    ("EvoLink 视频两段，第二段失败，第一段已回报 0.20 美元", _upstream_cost(0.20, RuntimeError("第二段失败")),
     "failed", round(0.20 * USD_TO_CNY, 6), "upstream"),
    ("OpenRouter 补张中途失败，已回报 0.03 美元", _upstream_cost(0.03, RuntimeError("补张失败")),
     "failed", round(0.03 * USD_TO_CNY, 6), "upstream"),
    ("OpenRouter 首个请求就失败，没有回报", _no_cost(RuntimeError("内容审核未通过")), "failed", 0, None),
    ("语音 / 音乐成功，价格表 0.50 元", _price_table(0.50), "done", 0.50, "price_table"),
    ("图层拆分 / 语音产物无效而失败，价格表 0.50 元", _price_table(0.50, valid=False),
     "failed", 0, "price_table"),
    ("OpenAI-HK 成功，没有实付，按估价", _no_cost(), "done", HK_ESTIMATE, None),
    ("OpenAI-HK 失败", _no_cost(RuntimeError("内容审核未通过")), "failed", 0, None),
    ("取消前上游已回报 0.10 美元", _upstream_cost(0.10, JobCanceled("已按请求停止")),
     "canceled", round(0.10 * USD_TO_CNY, 6), "upstream"),
]


@pytest.mark.parametrize(("label", "caller", "status", "charged", "source"), CASES,
                         ids=[case[0] for case in CASES])
def test_settlement_by_provider(client, monkeypatch, label, caller, status, charged, source):  # noqa: F811
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    monkeypatch.setattr(callers, "dispatch", caller)
    task = gateway_tasks.get_task(client.record.id, _submit(client).json()["task_id"])
    done = gateway_tasks.run_task(task)
    assert (done.status, done.charged_cny, done.actual_cost_source) == (status, charged, source), label
    [row] = [row for row in gateway_tasks.read_usage(gateway_tasks._now().astimezone().strftime("%Y-%m"))
             if row["task_id"] == done.task_id]
    assert (row["charged_cny"], row["actual_cost_source"]) == (charged, source)


LEGACY = [
    # 旧任务文件没有 actual_cost_source：结算与改动前完全一致。
    ("失败但有实付", "failed", 0.5, 0.3, 0.5),
    ("取消但有实付", "canceled", 0.5, 0.3, 0.5),
    ("失败无实付", "failed", None, 0.3, 0),
    ("成功无实付按估价", "done", None, 0.3, 0.3),
    ("成功无实付无估价", "done", None, None, 0),
    ("成功有实付", "done", 0.5, 0.3, 0.5),
]


def _old_formula(task):
    """改动前 `_finish` 里的原式，用来断言旧任务的结果不变。"""
    return task.actual_cost_cny if task.actual_cost_cny is not None else (
        (task.estimated_cny or 0) if task.status == "done" else 0)


@pytest.mark.parametrize(("label", "status", "actual", "estimate", "charged"), LEGACY,
                         ids=[case[0] for case in LEGACY])
def test_old_task_files_settle_exactly_as_before(label, status, actual, estimate, charged):
    legacy = gateway_tasks.GatewayTask.model_validate({
        "task_id": "a" * 32, "key_id": "k", "key_name": "小王", "idempotency_key": "i",
        "route_id": "gpt-image-2", "prompt": "p", "n": 1, "status": status,
        "actual_cost_cny": actual, "estimated_cny": estimate,
        "created_at": "2026-11-18T00:00:00+00:00", "updated_at": "2026-11-18T00:00:00+00:00",
    })
    assert legacy.actual_cost_source is None
    assert gateway_tasks.settled_charge(legacy) == charged == _old_formula(legacy), label
