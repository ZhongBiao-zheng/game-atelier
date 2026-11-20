"""第 6 批 6-1 补充：主机转述的「未确认」按结构化字段（error_kind）判断，不靠文案（管理会话指出的转述路径）。

删掉 failover_reason 里的 `"未确认" in text` 后，主机任务以 error_kind="unconfirmed" 失败时，成员端
`_task_error` 以前返回不带类型的 GatewayError(主机文案)，文案里带的 `api 404` / `HTTP 401` / 「余额不足」/
`HTTP 503 无可用渠道` 会被状态码与标记判断读成可换家，成员「自动」换到自己的下一家，主机上游的原单可能已出图 →
两边各出一单。现在 error_kind="unconfirmed" 映射成 GatewayHostUnconfirmed（未确认类型），不换家；
error_kind="failed" 的同样文案行为与改动前一致。

实测补充：成员端拿到主机任务号后（提交成功即落盘 provider_task_ids），job_runner._switch_route 本来就不换家，
所以经 job_runner 的这条路径在删文案判断前后都不会换家；GatewayHostUnconfirmed 是按结构化字段的第二道保证，
覆盖以后任何直接对 `_task_error` 结果调 failover_reason 的地方（如 cool_down 记账）。

主机不实际执行（pump 置空），成员端 `_poll` 直接返回构造的主机终态；upstream 记的是成员自己直连第二家（Local）的提交。
"""
from __future__ import annotations

import pytest

from character_workflow.lib import gateway_tasks, job_runner, model_routes
from character_workflow.lib.callers import atelier_gateway, task_submission
from character_workflow.lib.jobs import read_job
from character_workflow.lib.schemas import JobStatus
from tests import test_gateway_client as _client

gateway = _client.gateway
upstream = _client.upstream
_fast = _client._fast

UPSTREAM_TEXTS = [
    "image api 404: model not found",
    "HTTP 401 invalid api key",
    "上游余额不足，请充值",
    'HTTP 503 {"error": "无可用渠道"}',
]
HOST_UNCONFIRMED_PREFIX = "上游任务结果未确认："


def _host_ends(monkeypatch, kind: str, text: str) -> None:
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)  # 主机不执行：上游调用只来自成员直连
    message = HOST_UNCONFIRMED_PREFIX + text if kind == "unconfirmed" else text
    monkeypatch.setattr(atelier_gateway, "_poll", lambda *_a, **_k: {
        "status": "failed", "error_kind": kind, "error": message, "charged_cny": 0})


@pytest.mark.parametrize("text", UPSTREAM_TEXTS)
def test_host_unconfirmed_never_fails_over_to_the_members_next_key(gateway, upstream, monkeypatch, text):
    _host_ends(monkeypatch, "unconfirmed", text)
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(_client._job("job-relayed").job_id)
    failed = read_job("job-relayed")
    assert (failed.status, failed.alias) == (JobStatus.FAILED, "Hub")
    assert upstream["calls"] == []  # 第二家（Local）提交 0 次
    assert text in failed.error


@pytest.mark.parametrize("text", UPSTREAM_TEXTS)
def test_host_failed_with_the_same_text_behaves_as_before(gateway, upstream, monkeypatch, text):
    """error_kind="failed"：与改动前一致——主机已收下（成员拿到了主机任务号）的任务失败后，成员不换家。

    挡住它的是 job_runner._switch_route 的 `params.provider_task_ids` 判断（主机任务号在提交后就落盘），
    与文案无关；failover_reason 对这类错误照旧按状态码给出原因（见下一条），只是走不到换家那一步。
    """
    _host_ends(monkeypatch, "failed", text)
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(_client._job("job-plain").job_id)
    failed = read_job("job-plain")
    assert (failed.status, failed.alias) == (JobStatus.FAILED, "Hub")
    assert failed.params.provider_task_ids  # 换家的前置判断就挡在这里
    assert upstream["calls"] == []


@pytest.mark.parametrize("text", UPSTREAM_TEXTS)
def test_task_error_types_follow_error_kind_not_text(text):
    unsure = atelier_gateway._task_error(
        {"status": "failed", "error_kind": "unconfirmed", "error": HOST_UNCONFIRMED_PREFIX + text})
    assert isinstance(unsure, atelier_gateway.GatewayHostUnconfirmed)
    assert task_submission.is_unconfirmed(unsure) and model_routes.failover_reason(unsure) is None
    # 不是 GatewayUnconfirmed：创作台不会把主机已终态的任务挂成「等待网关」反复接回。
    assert not isinstance(unsure, atelier_gateway.GatewayUnconfirmed)
    plain = atelier_gateway._task_error({"status": "failed", "error_kind": "failed", "error": text})
    assert not task_submission.is_unconfirmed(plain)
    assert model_routes.failover_reason(plain) is not None


def test_charged_failure_keeps_the_unconfirmed_type(gateway, upstream, monkeypatch):
    """主机判未确认、又对完成部分扣了费：补「已扣」那句时不能把类型丢回普通 GatewayError。"""
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    monkeypatch.setattr(atelier_gateway, "_poll", lambda *_a, **_k: {
        "status": "failed", "error_kind": "unconfirmed", "charged_cny": 0.4,
        "error": HOST_UNCONFIRMED_PREFIX + "HTTP 401 invalid api key"})
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(_client._job("job-charged").job_id)
    failed = read_job("job-charged")
    assert upstream["calls"] == [] and "已扣 ¥0.4" in failed.error
    assert failed.params.actual_cost_cny == 0.4


def test_a_host_never_forwards_to_another_gateway_and_relayed_unsure_stays_unconfirmed(
        isolated_data_root, monkeypatch):
    """多级网关：主机选成员时跳过 provider=atelier；即使将来放开，转述来的未确认在主机上也落 unconfirmed。"""
    from character_workflow.lib import gateway_keys, keys

    for alias, provider in (("Upper", "atelier"), ("Direct", "openai")):
        keys.add_key(keys.KeySpec(
            alias=alias, provider=provider, access_key="test-only", modalities=["image"],
            base_url="http://192.0.2.1:5180" if provider == "atelier" else "https://api.openai-hk.com",
            models=[keys.ModelSpec(id="gpt-image-2", name="gpt-image-2", modality="image")],
            created_at="test"))
    owner = gateway_keys.create_key("小王")[0]
    route = model_routes.find_route("image", "gpt-image-2")
    assert {m.alias for m in route.members} == {"Upper", "Direct"}
    picked = gateway_tasks._pick_member(route.id, [], owner, "image")
    assert picked is not None and picked[0].alias == "Direct"  # 跳过网关成员

    from character_workflow.lib import callers

    def relayed(**_kwargs):
        raise atelier_gateway.GatewayHostUnconfirmed(HOST_UNCONFIRMED_PREFIX + "HTTP 401 invalid api key")

    monkeypatch.setattr(callers, "dispatch", relayed)
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    task = gateway_tasks.submit(owner, idempotency_key="1795100000-" + "a" * 32, model=route.id,
                                prompt="一只猫", n=1, size=None, params={}, files={}, kind="image")
    finished = gateway_tasks.run_task(gateway_tasks._update(task.task_id, status="running"))
    assert finished.status == "failed" and finished.error_kind == "unconfirmed"
