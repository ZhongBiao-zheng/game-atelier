"""第 5 批 5-2：画布图层拆分节点经网关提交未确认后，重新拆分接回主机上的原任务。

主机是真实回环网关，成员是 Seedream（Ark）；主机执行用假 dispatch（记调用次数、产出两层）。
成员端网络故障复用 test_gateway_reattach 的可注入故障 Session。
"""
from __future__ import annotations

import time

import pytest

from character_workflow.lib import callers, gateway_keys, keys, model_routes
from character_workflow.lib.callers import atelier_gateway
from character_workflow.lib.jobs import read_job
from character_workflow.lib.schemas import JobStatus
from tests import test_gateway_client as _harness
from tests import test_gateway_reattach as _reattach
from tests.test_gateway import _png

_fast = _harness._fast
faults = _reattach.faults

ARK_MODEL = "doubao-seedream-5-0-pro-260628"


@pytest.fixture
def layer_host(isolated_data_root, monkeypatch):
    calls: list[dict] = []

    def fake_dispatch(*, params, output_dir, **_kwargs):
        calls.append(dict(params))
        paths = [output_dir / f"out{i}.png" for i in range(2)]
        for path in paths:
            _png(path)
        params["layer_decomposition_result"] = {"outputs": [
            dict(output_index=0, z_index=0, size="2x2", output_format="png"),
            dict(output_index=1, z_index=1, size="2x2", output_format="png",
                 bounding_box={"absolute": [0, 0, 2, 2], "normalized": [0, 0, 1000, 1000]})]}
        return [str(path) for path in paths]

    monkeypatch.setattr(callers, "dispatch", fake_dispatch)
    keys.add_key(keys.KeySpec(
        alias="Ark", provider="seedream", base_url="https://ark.cn-beijing.volces.com/api/v3",
        access_key="test-only", modalities=["image"], created_at="test",
        models=[keys.ModelSpec(id=ARK_MODEL, name="Seedream 5.0 Pro", modality="image")]))
    _record, token = gateway_keys.create_key("小王", None)
    port = _harness._free_port()
    server = _harness.GatewayServer(host="127.0.0.1")
    server.start(port)
    base = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            atelier_gateway.check_gateway(base, token)
            break
        except Exception:  # noqa: BLE001 — 等服务起来
            time.sleep(0.1)
    routes = atelier_gateway.check_gateway(base, token)["models"]
    via_model = next(m for m in atelier_gateway.gateway_models(routes) if m.id == ARK_MODEL)
    keys.add_key(keys.KeySpec(alias="Hub", provider="atelier", access_key=token, base_url=base,
                              modalities=["image"], models=[via_model], created_at="test"))
    model_routes.put_alias_first("Hub")
    yield calls
    server.stop()


def _layer_project() -> str:
    from character_workflow.lib.canvas_projects import save_canvas_document
    from character_workflow.lib.schemas import (
        CanvasInputConnection, CanvasLayerStackData, CanvasLayerStackNode, CanvasPoint, CanvasSize,
    )
    from tests.test_canvas_layer_decomposition import _project_with_source_image

    project, current, version = _project_with_source_image()
    stack = CanvasLayerStackNode(
        id="layer-stack", title="拆分图层", type="layer_stack",
        position=CanvasPoint(x=420, y=40), size=CanvasSize(width=760, height=480), z_index=0,
        data=CanvasLayerStackData(source_version_id=version.version_id, alias="Hub",
                                  model=ARK_MODEL, prompt="拆出主体", resolution="auto"))
    edge = CanvasInputConnection(id="src-to-stack", role="input",
                                 source_node_id="source-image", target_node_id=stack.id)
    save_canvas_document(project.project_id, current.model_copy(update={
        "nodes": [*current.nodes, stack], "connections": [*current.connections, edge]}),
        current.revision)
    return project.project_id


def _attempt(pid: str):
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.canvas_runs import run_canvas_job, submit_layer_decomposition_run

    job, _doc = submit_layer_decomposition_run(
        pid, "layer-stack", read_canvas_document(pid).revision, "Hub", ARK_MODEL)
    try:
        run_canvas_job(job.job_id)
    except Exception:  # noqa: BLE001 — 失败时画布 runner 可能抛出，下面看落盘结果
        pass
    return read_job(job.job_id)


def test_layer_split_resubmit_reattaches_the_original_host_task(layer_host, faults):
    pid = _layer_project()
    faults.lost_posts = 3  # 主机收到了，回应三次都丢
    first = _attempt(pid)
    assert first.status == JobStatus.FAILED and first.params.gateway_unconfirmed is True

    second = _attempt(pid)
    assert second.params.gateway_reattach_of == first.job_id
    assert second.status == JobStatus.DONE, second.error
    assert second.params.gateway_request_fingerprint == first.params.gateway_request_fingerprint
    [host] = _reattach._host_settled()
    assert second.params.provider_task_ids == [host.task_id]
    assert len(layer_host) == 1


def test_layer_split_chain_survives_a_middle_attempt_that_could_not_connect(layer_host, faults):
    pid = _layer_project()
    faults.lost_posts = 3
    task1 = _attempt(pid)
    assert task1.params.gateway_unconfirmed is True
    faults.down_posts = 3  # 第二次连接都没建立
    task2 = _attempt(pid)
    assert task2.params.gateway_reattach_of == task1.job_id
    assert task2.params.gateway_unconfirmed is True
    assert task2.params.gateway_idempotency_key == task1.params.gateway_idempotency_key
    faults.down_posts = 0
    task3 = _attempt(pid)
    assert task3.status == JobStatus.DONE, task3.error
    assert task3.params.gateway_reattach_of == task2.job_id
    [host] = _reattach._host_settled()
    assert task3.params.provider_task_ids == [host.task_id]
    assert len(layer_host) == 1


def test_layer_split_with_changed_settings_places_a_new_order(layer_host, faults):
    from character_workflow.lib.canvas_projects import read_canvas_document, save_canvas_document

    pid = _layer_project()
    faults.lost_posts = 3
    first = _attempt(pid)
    assert first.params.gateway_unconfirmed is True
    current = read_canvas_document(pid)
    save_canvas_document(pid, current.model_copy(update={"nodes": [
        node.model_copy(update={"data": node.data.model_copy(update={"resolution": "2K"})})
        if node.id == "layer-stack" else node for node in current.nodes]}), current.revision)

    second = _attempt(pid)
    assert second.status == JobStatus.DONE, second.error
    assert second.params.gateway_reattach_of is None
    assert second.params.gateway_idempotency_key != first.params.gateway_idempotency_key
    assert len(_reattach._host_settled()) == 2 and len(layer_host) == 2
