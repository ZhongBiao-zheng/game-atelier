"""ComfyUI 经网关暴露与执行：真实 HTTP 假服务，不调用外部厂商。"""
import json

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import gateway_keys, gateway_tasks, keys, model_routes
from character_workflow.lib.callers import atelier_gateway
from tests.test_comfyui import host as comfy_host, imported
from viewer_server.gateway_app import create_gateway_app

host = comfy_host


@pytest.fixture
def client(host, monkeypatch):
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    model_routes._cooldowns.clear()
    record, token = gateway_keys.create_key("成员", None)
    client = TestClient(create_gateway_app())
    client.headers["Authorization"] = f"Bearer {token}"
    client.record = record
    yield client
    model_routes._cooldowns.clear()


def test_catalog_snapshot_and_permissions(client, monkeypatch):
    workflow = imported()
    routes = client.get("/gateway/v1/models").json()["models"]
    assert routes[0]["workflow_inputs"] == [item.model_dump() for item in workflow.inputs]
    assert "api_workflow" not in json.dumps(routes)
    assert client.get("/gateway/v1/info").json()["protocol"] == 2
    keys.add_key(keys.KeySpec(alias="Hub", provider="atelier", access_key="test-only",
                              base_url="http://127.0.0.1:5180", created_at="test"))
    monkeypatch.setattr(atelier_gateway, "check_gateway", lambda *args: {"models": routes})
    atelier_gateway.sync_gateway_key("Hub")
    assert keys.find_by_alias("Hub").models[0].workflow_inputs == workflow.inputs
    gateway_keys.update_key(client.record.id, allowed_aliases=["other"])
    assert client.get("/gateway/v1/models").json()["models"] == []


def test_empty_declarations_survive_snapshot():
    model = atelier_gateway.gateway_models([{
        "id": "comfyui-empty", "name": "无参数", "modality": "image", "workflow_inputs": [],
        "members": [{"alias": "local", "provider": "comfyui", "model_id": "comfyui-empty",
                     "name": "无参数"}],
    }])[0]
    assert model.model_dump()["workflow_inputs"] == []


def submit(client, workflow, *, prompt="cat", params=None, files=None):
    response = client.post("/gateway/v1/tasks", headers={"Idempotency-Key": "test"},
                           data={"request": json.dumps({"kind": "image", "model": workflow.id,
                                 "prompt": prompt, "n": 1, "params": params or {}})}, files=files)
    assert response.status_code == 202, response.text
    return gateway_tasks.run_task(gateway_tasks.get_task(client.record.id, response.json()["task_id"]))


def test_values_ordered_images_mask_and_task_prefix(client, host):
    from character_workflow.lib import comfyui_workflows as workflows
    from character_workflow.lib.comfyui_schema import WorkflowInput

    workflow = imported("inpaint")
    graph = workflow.api_workflow
    graph["12"] = {"class_type": "LoadImage", "inputs": {"image": "second.png"}}
    inputs = [*workflow.inputs, WorkflowInput(id="second", label="第二张", type="image",
               node_id="12", class_type="LoadImage", field="image", required=True)]
    workflow = workflows.save_workflow("local", name=workflow.name, api_workflow=graph,
                                       inputs=inputs, identifier=workflow.id)
    strength = next(i for i in inputs if i.type == "float")
    task = submit(client, workflow, params={"workflow_inputs": {strength.id: 0.25}}, files=[
        ("ref_1", ("second.png", b"second-image")), ("mask", ("mask.png", b"mask-data")),
        ("ref_0", ("first.png", b"first-image")),
    ])
    assert task.status == "done", task.error
    graph = host.prompts["prompt-1"]["prompt"]
    assert graph["10"]["inputs"]["image"] == "uploaded-1.png"
    assert graph["12"]["inputs"]["image"] == "uploaded-2.png"
    assert graph["11"]["inputs"]["image"] == "uploaded-3.png"
    assert b"first-image" in host.uploads[0] and b"second-image" in host.uploads[1]
    assert b"mask-data" in host.uploads[2]
    assert graph["2"]["inputs"]["strength_model"] == 0.25
    assert graph["9"]["inputs"]["filename_prefix"] == f"atelier/{task.task_id}"


def test_old_member_uses_defaults(client, host):
    workflow = imported()
    task = submit(client, workflow)
    assert task.status == "done", task.error
    assert host.prompts["prompt-1"]["prompt"]["2"]["inputs"]["strength_model"] == 0.8


def test_no_prompt_workflow_and_required_image(client, host):
    workflow = imported("upscale")
    task = submit(client, workflow, prompt="", files={"ref_0": ("ref.png", host.png)})
    assert task.status == "done", task.error


def test_old_member_missing_required_image_fails_clearly(client, host):
    task = submit(client, imported("upscale"), prompt="")
    assert task.status == "failed" and "参考图" in task.error
    assert not host.prompts


@pytest.mark.parametrize("values", [{"api_workflow": "malicious"}, {"image": "/etc/passwd"}])
def test_undeclared_values_cannot_submit_graph_or_paths(client, host, values):
    task = submit(client, imported(), params={"workflow_inputs": values})
    assert task.status == "failed" and "未声明" in task.error
    assert not host.prompts


def test_gateway_rejects_raw_workflow(client, host):
    workflow = imported()
    response = client.post("/gateway/v1/tasks", headers={"Idempotency-Key": "test"}, data={
        "request": json.dumps({"model": workflow.id, "prompt": "cat", "params": {
            "api_workflow": workflow.api_workflow}})})
    assert response.status_code == 422 and not host.prompts


def test_offline_is_unavailable(client, host):
    from tests.test_gateway_client import _free_port

    workflow = imported()
    keys.patch_key("local", {"base_url": f"http://127.0.0.1:{_free_port()}"})
    task = submit(client, workflow)
    assert (task.status, task.error_kind, task.error) == (
        "failed", "unavailable", "主机的 ComfyUI 未启动")
    assert not host.prompts


def test_connection_lost_after_submission_is_not_safe_to_retry(client, host, monkeypatch):
    import requests

    workflow = imported()
    real_request = requests.Session.request

    def disconnected(session, method, url, **kwargs):
        if "/history/" in url:
            raise requests.ConnectionError("connection lost")
        return real_request(session, method, url, **kwargs)

    monkeypatch.setattr(requests.Session, "request", disconnected)
    task = submit(client, workflow)
    assert task.status == "failed" and task.error_kind == "unconfirmed"
    assert "未确认" in task.error and len(host.prompts) == 1


@pytest.fixture
def live_gateway(host, monkeypatch):
    import time
    from tests.test_gateway_client import _free_port
    from viewer_server.gateway_app import GatewayServer

    model_routes._cooldowns.clear()
    monkeypatch.setattr(atelier_gateway, "POLL_INTERVAL_SECONDS", 0.01)
    record, token = gateway_keys.create_key("成员", None)
    server = GatewayServer(host="127.0.0.1")
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    server.start(port)
    try:
        for _ in range(50):
            try:
                atelier_gateway.check_gateway(base, token)
                break
            except Exception:  # noqa: BLE001 — 等待本机 HTTP 服务启动
                time.sleep(0.05)
        keys.add_key(keys.KeySpec(alias="Hub", provider="atelier", access_key=token,
                                  base_url=base, created_at="test"))
        yield record
    finally:
        server.stop()
        model_routes._cooldowns.clear()


def test_member_job_preserves_all_save_images_and_zero_cost(live_gateway, host):
    from pathlib import Path
    from character_workflow.lib import comfyui_workflows as workflows, job_runner
    from character_workflow.lib.jobs import save_job
    from character_workflow.lib.schemas import Job, JobParams

    workflow = imported()
    graph = workflow.api_workflow
    graph["99"] = {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "x"}}
    workflows.save_workflow("local", name=workflow.name, api_workflow=graph,
                            inputs=workflow.inputs, identifier=workflow.id)
    atelier_gateway.sync_gateway_key("Hub")
    save_job(Job(job_id="member-workflow", character_id="A", prompt="cat", model=workflow.id,
                 alias="Hub", provider="atelier", namespace="studio", params=JobParams(n=1),
                 output_paths=[], status="pending", error=None,
                 submitted_at="2026-11-02T00:00:00+00:00"))
    done = job_runner.run_job("member-workflow")
    assert done.status.value == "done", done.error
    assert len(done.output_paths) == 2
    assert all(Path(path).read_bytes() == host.png for path in done.output_paths)
    assert done.params.actual_cost_cny == 0
    task = gateway_tasks.get_task(live_gateway.id, done.params.provider_task_ids[0])
    assert task.actual_cost_cny == task.charged_cny == 0
    assert task.created_at <= task.updated_at
    assert done.completed_at and done.completed_at > done.submitted_at


def test_member_caller_sends_mask_and_values(live_gateway, host, tmp_path):
    workflow = imported("inpaint")
    atelier_gateway.sync_gateway_key("Hub")
    ref, mask = tmp_path / "ref.png", tmp_path / "mask.png"
    ref.write_bytes(host.png)
    mask.write_bytes(b"separate-mask")
    strength = next(i for i in workflow.inputs if i.type == "float")
    params = {"workflow_inputs": {strength.id: 0.35}, "reference_images": [str(ref)], "mask_image": str(mask)}
    outputs = atelier_gateway.render(prompt="cat", model=workflow.id, alias="Hub",
                                      output_dir=tmp_path / "out", params=params)
    assert len(outputs) == 1
    graph = host.prompts["prompt-1"]["prompt"]
    assert graph["2"]["inputs"]["strength_model"] == 0.35
    assert graph["11"]["inputs"]["image"] == "uploaded-2.png"
    assert b"separate-mask" in host.uploads[1]


def test_member_job_observes_queue_and_leaves_queue_when_running(live_gateway, host, monkeypatch):
    from character_workflow.lib import job_runner
    from character_workflow.lib.callers import comfyui
    from character_workflow.lib.jobs import read_job, save_job
    from character_workflow.lib.schemas import Job, JobParams

    workflow = imported()
    atelier_gateway.sync_gateway_key("Hub")
    monkeypatch.setattr(comfyui, "POLL_INTERVAL", 0.04)
    phases = []
    update = job_runner.update_job_phase

    def observe(job_id, phase):
        update(job_id, phase)
        phases.append(read_job(job_id).progress_phase)

    monkeypatch.setattr(job_runner, "update_job_phase", observe)
    save_job(Job(job_id="member-queue", character_id="A", prompt="cat", model=workflow.id,
                 alias="Hub", provider="atelier", namespace="studio", params=JobParams(n=1),
                 output_paths=[], status="pending", error=None,
                 submitted_at="2026-11-02T00:00:00+00:00"))
    done = job_runner.run_job("member-queue")
    assert done.status.value == "done", done.error
    queued = phases.index("queued:1")
    assert "sent" in phases[queued + 1:]
    assert done.progress_phase is None
    assert gateway_tasks.MAX_RUNNING == 8 and gateway_tasks.MAX_RUNNING_PER_KEY == 4


@pytest.mark.parametrize("running", [False, True])
def test_member_cancel_reaches_comfyui_and_stops_remaining_images(live_gateway, host, monkeypatch, running):
    from character_workflow.lib import job_runner
    from character_workflow.lib.jobs import read_job, save_job, request_job_cancel
    from character_workflow.lib.schemas import Job, JobParams

    workflow = imported()
    atelier_gateway.sync_gateway_key("Hub")
    host.mode = "timeout"
    host.foreign_running = not running
    host.delay = 0 if running else 10000
    def should_cancel():
        if host.prompts and host.polls:
            request_job_cancel("cancel-member")
            return True
        return False
    save_job(Job(job_id="cancel-member", character_id="A", prompt="cat", model=workflow.id,
                 alias="Hub", provider="atelier", namespace="studio", params=JobParams(n=3),
                 output_paths=[], status="pending", error=None, submitted_at="2026-11-02T00:00:00+00:00"))
    with pytest.raises(job_runner.JobCanceled):
        job_runner.run_job("cancel-member", should_cancel=should_cancel)
    done = read_job("cancel-member")
    assert done.status.value == "canceled" and done.output_paths == []
    assert done.error == "已停止" and done.params.actual_cost_cny == 0
    assert len(host.prompts) == 1
    assert host.interrupted == (["prompt-1"] if running else [])
    assert host.deleted == ([] if running else ["prompt-1"])
    task = gateway_tasks.get_task(live_gateway.id, done.params.provider_task_ids[0])
    assert task.status == "canceled" and task.outputs == []


def test_canvas_member_can_submit_and_execute_workflow(live_gateway, host):
    from character_workflow.lib.canvas_projects import create_canvas_project
    from character_workflow.lib.canvas_runs import submit_canvas_run, run_canvas_job
    from character_workflow.lib.jobs import read_job
    from tests.test_generation_recipe import NOW, _media_node, _save_nodes

    workflow = imported()
    atelier_gateway.sync_gateway_key("Hub")
    strength = next(item for item in workflow.inputs if item.type == "float")
    draft = {"mode": "image", "prompt": "cat", "alias": "Hub", "model": workflow.id,
             "params": {"n": 1, "workflow_inputs": {strength.id: 0.45}}, "updated_at": NOW}
    project = create_canvas_project("Member canvas")
    document = _save_nodes(project.project_id, [_media_node("source", draft)], [])
    job, _ = submit_canvas_run(project.project_id, "source", document.revision)
    assert job.alias == "Hub" and job.provider == "atelier"
    run_canvas_job(job.job_id)
    done = read_job(job.job_id)
    assert done.status.value == "done", done.error
    assert done.params.actual_cost_cny == 0
    assert host.prompts["prompt-1"]["prompt"]["2"]["inputs"]["strength_model"] == 0.45


@pytest.mark.parametrize("alias", ["Hub", None])
def test_studio_rejects_undeclared_workflow_values_before_creating_job(
    live_gateway, host, monkeypatch, alias,
):
    from character_workflow.lib.jobs import list_jobs
    from tests.local_client import LocalTestClient
    from viewer_server import routes
    from viewer_server.server_app import build_app

    workflow = imported()
    atelier_gateway.sync_gateway_key("Hub")
    submitted = []
    monkeypatch.setattr(routes, "_run_studio_job_safely", submitted.append)
    with LocalTestClient(build_app(), base_url="http://127.0.0.1") as client:
        response = client.post("/api/studio/jobs", json={
            "alias": alias, "prompt": "cat", "model": workflow.id,
            "params": {"workflow_inputs": {"undeclared": 1}},
        })
    assert response.status_code == 422 and "未声明" in response.text
    assert list_jobs() == [] and submitted == [] and host.prompts == {}


@pytest.mark.parametrize("alias", ["local", "Hub"])
@pytest.mark.parametrize("has_prompt", [True, False])
def test_canvas_inpaint_uploads_original_and_independent_mask(live_gateway, host, alias, has_prompt):
    import io
    from PIL import Image
    from character_workflow.lib.canvas_projects import create_canvas_project, replace_canvas_node_media
    from character_workflow.lib.canvas_runs import run_canvas_job
    from tests.canvas_edit_helpers import submit_saved_edit
    from tests.test_generation_recipe import NOW, _media_node, _save_nodes, png
    from character_workflow.lib import comfyui_workflows as workflows

    workflow = imported("inpaint")
    if not has_prompt:
        workflow = workflows.save_workflow("local", name=workflow.name, api_workflow=workflow.api_workflow,
            inputs=[i for i in workflow.inputs if i.type != "prompt"], identifier=workflow.id)
    atelier_gateway.sync_gateway_key("Hub")
    strength = next(i.id for i in workflow.inputs if i.type == "float")
    prompt = "蓝色帽子" if has_prompt else ""
    draft = {"mode": "image", "prompt": prompt, "alias": alias, "model": workflow.id,
             "params": {"workflow_inputs": {strength: 0.35}}, "updated_at": NOW}
    pid = create_canvas_project("重绘工作流").project_id
    doc = _save_nodes(pid, [_media_node("source", draft)], [])
    version, doc, _ = replace_canvas_node_media(pid, "source", "s.png", ".png",
                                               png((255, 0, 0), (64, 64)), "image", doc.revision)
    mask = Image.new("L", (64, 64), 255)
    mask.paste(0, (16, 16, 48, 48))
    stream = io.BytesIO()
    mask.save(stream, format="PNG")
    job, _ = submit_saved_edit(pid, "source", doc.revision, 2, stream.getvalue())
    assert job.prompt == prompt and job.params.workflow_inputs == {strength: 0.35}
    done = run_canvas_job(job.job_id)
    assert done.status.value == "done", done.error
    assert len(done.output_paths) == 2 and len(host.uploads) == 4
    assert done.params.actual_cost_cny == 0
    graphs = [payload["prompt"] for payload in host.prompts.values()]
    assert len(graphs) == 2 and graphs[0]["3"]["inputs"]["seed"] != graphs[1]["3"]["inputs"]["seed"]
    for graph in graphs:
        assert graph["6"]["inputs"]["text"] == (prompt if has_prompt else "a cat")
        assert graph["2"]["inputs"]["strength_model"] == 0.35
        assert graph["10"]["inputs"]["image"] != graph["11"]["inputs"]["image"]
    # Extract the multipart PNG, asserting both ComfyUI red and inverse-alpha semantics.
    for index, body in enumerate(host.uploads):
        image = Image.open(io.BytesIO(body[body.index(b"\x89PNG\r\n\x1a\n"):])).convert("RGBA")
        assert image.size == (64, 64)
        if index % 2 == 0:
            assert image.getpixel((32, 32)) == (255, 0, 0, 255)
        else:
            assert image.getpixel((0, 0)) == (0, 0, 0, 255)
            assert image.getpixel((32, 32)) == (255, 255, 255, 0)
    with Image.open(done.output_paths[0]) as output:
        assert output.getpixel((0, 0)) == (255, 0, 0, 255)
        assert output.getpixel((32, 32)) == (102, 153, 136, 255)


@pytest.mark.parametrize("alias", ["Hub", None])
def test_studio_http_accepts_empty_prompt_only_for_workflow_without_prompt(
    live_gateway, host, monkeypatch, isolated_data_root, alias,
):
    from character_workflow.lib import job_runner
    from tests.local_client import LocalTestClient
    from viewer_server import routes
    from viewer_server.server_app import build_app

    upscale = imported("upscale")
    lora = imported()
    atelier_gateway.sync_gateway_key("Hub")
    monkeypatch.setattr(routes, "_run_studio_job_safely", lambda _id: None)
    ref = isolated_data_root / "reference.png"
    ref.write_bytes(host.png)
    with LocalTestClient(build_app(), base_url="http://127.0.0.1") as client:
        payload = {"alias": alias, "prompt": "", "model": upscale.id,
                   "params": {"reference_images": [str(ref)]}}
        response = client.post("/api/studio/jobs", json=payload)
        assert response.status_code == 201, response.text
        done = job_runner.run_job(response.json()["job_id"])
        assert done.status.value == "done", done.error
        assert done.prompt == "" and done.alias == "Hub"
        response = client.post("/api/studio/jobs", json={**payload, "model": lora.id, "params": {}})
        assert response.status_code == 422 and "提示词不能为空" in response.text
