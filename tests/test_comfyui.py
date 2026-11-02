import copy
import json
from pathlib import Path

import pytest

from character_workflow.lib import comfyui_workflows as workflows, keys
from character_workflow.lib.callers import comfyui
from character_workflow.lib.comfyui_schema import WorkflowInput, local_base_url
from character_workflow.lib.generation_pricing import estimate_cost_cny
from tests.fake_comfyui import FakeComfyUI

FIXTURES = Path(__file__).parent / "fixtures" / "comfyui"


@pytest.fixture
def host(monkeypatch):
    monkeypatch.setattr(comfyui, "POLL_INTERVAL", 0.001)
    with FakeComfyUI() as server:
        keys.add_key(keys.KeySpec(alias="local", provider="comfyui", base_url=server.url,
                                  created_at="2026-11-02"))
        yield server


def imported(name="lora"):
    graph = json.loads((FIXTURES / f"{name}.json").read_text())
    inspected = workflows.inspect_workflow("local", graph)
    inputs = [WorkflowInput(**item) for item in inspected["inputs"]]
    return workflows.save_workflow("local", name=name, api_workflow=graph, inputs=inputs)


@pytest.mark.parametrize("url", ["http://192.168.1.2:8188", "http://localhost.evil:8188",
                                "http://user@localhost", "http://localhost/path", "file:///tmp",
                                "http://127.0.0.1?next=evil", "http://[::1]"])
def test_loopback_only(url):
    with pytest.raises(ValueError):
        local_base_url(url)


def test_import_storage_and_serialization(host):
    workflow = imported()
    assert workflows.read_workflow("local", workflow.id) == workflow
    model = keys.find_by_alias("local").models[0]
    assert model.workflow_inputs == workflow.inputs
    assert "workflow_inputs" not in keys.ModelSpec(id="gpt-image-2", name="GPT").model_dump()
    assert estimate_cost_cny(kind="image", provider="comfyui", model_id=workflow.id) == 0
    workflows.delete_workflow("local", workflow.id)
    assert not keys.find_by_alias("local").models
    with pytest.raises(ValueError):
        workflows.read_workflow("local", workflow.id)


@pytest.mark.parametrize("graph,message", [
    ({"nodes": [], "links": []}, "Export"),
    ({"1": {"class_type": "PreviewImage", "inputs": {}}}, "SaveImage"),
    ({"1": {"class_type": "SaveVideo", "inputs": {}}}, "暂不支持"),
])
def test_bad_formats(graph, message):
    with pytest.raises(ValueError, match=message):
        workflows.validate_api(graph)


def test_tagged_prompt_wins_over_an_earlier_untagged_clip(host):
    graph = json.loads((FIXTURES / "lora.json").read_text())
    negative = {"class_type": "CLIPTextEncode", "inputs": {"text": "negative"}}
    result = workflows.inspect_workflow("local", {"negative": negative, **graph})
    prompts = [item for item in result["inputs"] if item["type"] == "prompt"]
    assert len(prompts) == 1
    assert prompts[0]["node_id"] == "6"


@pytest.mark.parametrize("class_type", ["LoraLoader", "LoraLoaderModelOnly", "CustomStrength"])
def test_float_metadata_overrides_integer_default_through_execution(host, tmp_path, class_type):
    graph = json.loads((FIXTURES / "lora.json").read_text())
    graph["2"]["class_type"] = class_type
    graph["2"]["inputs"]["strength_model"] = 1
    inspected = workflows.inspect_workflow("local", graph)
    inputs = [WorkflowInput(**item) for item in inspected["inputs"]]
    strength = next(item for item in inputs if item.field == "strength_model")
    assert (strength.type, strength.default, strength.step) == ("float", 1, 0.01)
    assert (strength.min, strength.max) == (-10, 10)
    workflow = workflows.save_workflow("local", name="integer-default", api_workflow=graph,
                                        inputs=inputs)
    comfyui.render(prompt="cat", model=workflow.id, alias="local", output_dir=tmp_path,
                   params={"workflow_inputs": {strength.id: 0.8}})
    assert next(iter(host.prompts.values()))["prompt"]["2"]["inputs"]["strength_model"] == 0.8
    with pytest.raises(ValueError, match="超出范围"):
        workflows.validate_value(strength, 11)


def test_int_metadata_overrides_integral_float_default(host):
    graph = json.loads((FIXTURES / "lora.json").read_text())
    graph["3"]["inputs"]["steps"] = 20.0
    inspected = workflows.inspect_workflow("local", graph)
    steps = WorkflowInput(**next(item for item in inspected["candidates"]
                                 if item["field"] == "steps"))
    assert steps.type == "int" and type(steps.default) is int
    assert workflows.validate_value(steps, 21) == 21
    with pytest.raises(ValueError, match="类型"):
        workflows.validate_value(steps, 20.5)


@pytest.mark.parametrize("label,field", [("提示词", "text"), ("prompt", "value"), ("PROMPT", "prompt")])
def test_explicit_prompt_tag_maps_custom_text_and_reaches_execution(host, tmp_path, label, field):
    graph = json.loads((FIXTURES / "lora.json").read_text())
    graph["6"] = {"class_type": "CR Text", "_meta": {"title": f"in:{label}"},
                  "inputs": {"unused_number": 1, field: "original"}}
    negative = {"class_type": "CLIPTextEncode", "inputs": {"text": "negative"},
                "_meta": {"title": "in:负向提示词"}}
    other_clip = {"class_type": "CLIPTextEncode", "inputs": {"text": "other"},
                  "_meta": {"title": "in:其他文本"}}
    graph = {"negative": negative, "other": other_clip, **graph}
    inspected = workflows.inspect_workflow("local", graph)
    assert not inspected["warnings"]
    inputs = [WorkflowInput(**item) for item in inspected["inputs"]]
    prompts = [item for item in inputs if item.type == "prompt"]
    assert [(item.node_id, item.field) for item in prompts] == [("6", field)]
    assert all(item.type == "text" for item in inputs if item.node_id in {"negative", "other"})
    workflow = workflows.save_workflow("local", name="custom-prompt", api_workflow=graph, inputs=inputs)
    comfyui.render(prompt="new prompt", model=workflow.id, alias="local", output_dir=tmp_path)
    sent = next(iter(host.prompts.values()))["prompt"]
    assert sent["6"]["inputs"][field] == "new prompt"
    assert sent["negative"]["inputs"]["text"] == "negative"
    assert sent["other"]["inputs"]["text"] == "other"


def test_text_and_negative_prompt_tags_stay_text_without_main_prompt(host):
    graph = {"output": {"class_type": "SaveImage", "inputs": {"images": ["image", 0]}}}
    for i, (kind, label) in enumerate([("CR Text", "说明"), ("CR Text", "提示词后缀"),
                                      ("CLIPTextEncode", "说明"),
                                      ("CLIPTextEncode", "负向提示词"),
                                      ("CLIPTextEncode", "negative prompt")]):
        graph[str(i)] = {"class_type": kind, "inputs": {"text": "keep"},
                         "_meta": {"title": f"in:{label}"}}
    result = workflows.inspect_workflow("local", graph)
    assert len(result["inputs"]) == 5
    assert all(item["type"] == "text" for item in result["inputs"])


def test_explicit_prompt_tags_never_promote_multiple_fields_or_selects(host):
    graph = {"output": {"class_type": "SaveImage", "inputs": {"images": ["image", 0]}}}
    for node_id in ("a", "b"):
        graph[node_id] = {"class_type": "CR Text", "_meta": {"title": "in:提示词"},
                          "inputs": {"text": "main", "suffix": "keep"}}
    graph["enum"] = {"class_type": "SamplerChoice", "_meta": {"title": "in:prompt"},
                     "inputs": {"sampler_name": "euler"}}
    result = workflows.inspect_workflow("local", graph)
    assert [(item["node_id"], item["field"]) for item in result["candidates"]
            if item["type"] == "prompt"] == [("a", "text")]
    assert next(item for item in result["inputs"] if item["node_id"] == "enum")["type"] == "select"


def test_untagged_clip_prompt_suggestion_skips_named_negative(host):
    graph = json.loads((FIXTURES / "lora.json").read_text())
    for node in graph.values():
        node.pop("_meta", None)
    graph["7"]["_meta"] = {"title": "Negative prompt"}
    graph = {"7": graph.pop("7"), **graph}
    result = workflows.inspect_workflow("local", graph)
    assert result["tagged"] is False
    assert [item["node_id"] for item in result["inputs"] if item["type"] == "prompt"] == ["6"]


def test_ambiguous_custom_prompt_fields_require_manual_mapping(host):
    graph = {"1": {"class_type": "CustomText", "_meta": {"title": "in:提示词"},
                   "inputs": {"first": "a", "second": "b"}},
             "2": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}}}
    result = workflows.inspect_workflow("local", graph)
    assert all(item["type"] != "prompt" for item in result["candidates"])


def test_stale_mapping_and_link_input_fail(host):
    workflow = imported()
    for change in ("missing", "class", "link"):
        graph = copy.deepcopy(workflow.api_workflow)
        item = workflow.inputs[0]
        if change == "missing":
            del graph[item.node_id]
        elif change == "class":
            graph[item.node_id]["class_type"] = "Other"
        else:
            graph[item.node_id]["inputs"][item.field] = ["9", 0]
        with pytest.raises(ValueError, match="工作流已变更"):
            workflows.validate_mappings(graph, workflow.inputs)


def test_values_reject_unknown_type_range_and_selection(host):
    workflow = imported()
    with pytest.raises(ValueError, match="未声明"):
        workflows.validate_values(workflow.inputs, {"arbitrary": "value"})
    item = next(item for item in workflow.inputs if item.type == "float")
    for value in ("0.5", True, 999, float("nan")):
        with pytest.raises(ValueError):
            workflows.validate_values(workflow.inputs, {item.id: value})


def test_http_execution_queue_seed_prefix_outputs(host, tmp_path):
    workflow = imported()
    phases = []
    paths = comfyui.render(prompt="cat", model=workflow.id, alias="local", n=2,
                           output_dir=tmp_path, on_phase=phases.append, job_id="test-job")
    assert len(paths) == 2 and all(Path(path).read_bytes() == host.png for path in paths)
    assert "queued:1" in phases
    graphs = [item["prompt"] for item in host.prompts.values()]
    assert graphs[0]["3"]["inputs"]["seed"] != graphs[1]["3"]["inputs"]["seed"]
    assert graphs[0]["9"]["inputs"]["filename_prefix"] == "atelier/test-job"
    assert graphs[0]["6"]["inputs"]["text"] == "cat"


def test_image_upload_no_prompt_and_missing_required(host, tmp_path):
    workflow = imported("upscale")
    with pytest.raises(ValueError, match="请填写"):
        comfyui.render(prompt="", model=workflow.id, alias="local", output_dir=tmp_path)
    image = tmp_path / "input.png"
    image.write_bytes(host.png)
    assert comfyui.render(prompt="", model=workflow.id, alias="local", output_dir=tmp_path,
                          params={"reference_images": [str(image)]})
    assert host.uploads
    assert next(iter(host.prompts.values()))["prompt"]["1"]["inputs"]["image"] == "uploaded-1.png"


def test_execution_error(host, tmp_path):
    workflow = imported()
    host.mode = "error"
    with pytest.raises(ValueError, match="fake execution error"):
        comfyui.render(prompt="cat", model=workflow.id, alias="local", output_dir=tmp_path)


def test_timeout_deletes_only_owned_pending_task(host, tmp_path, monkeypatch):
    workflow = imported()
    host.mode = "timeout"
    now = iter([0, 0, 1801])
    from types import SimpleNamespace
    monkeypatch.setattr(comfyui, "time", SimpleNamespace(monotonic=lambda: next(now), sleep=lambda _: None))
    with pytest.raises(TimeoutError):
        comfyui.render(prompt="cat", model=workflow.id, alias="local", output_dir=tmp_path)
    assert host.deleted == ["prompt-1"]
    assert not host.interrupted


def test_queue_position_follows_submission_number_not_heap_array(host, tmp_path):
    workflow = imported()
    # A valid min-heap: the fourth array element belongs ahead of the third.
    host.pending_queue = [[1, "earlier-1", {}, {}, []], [2, "earlier-2", {}, {}, []],
                          [4, "prompt-1", {}, {}, []], [3, "earlier-3", {}, {}, []]]
    phases = []
    comfyui.render(prompt="cat", model=workflow.id, alias="local", output_dir=tmp_path,
                   on_phase=phases.append)
    assert "queued:4" in phases
    assert "queued:3" not in phases


def test_cancel_never_interrupts_foreign_prompt(host):
    from character_workflow.lib.comfyui_client import ComfyUIClient
    with ComfyUIClient(host.url) as client:
        comfyui._cancel(client, "not-running")
    assert not host.deleted and not host.interrupted


def test_cancel_owned_running_prompt(host):
    from character_workflow.lib.comfyui_client import ComfyUIClient
    host.foreign_running = False
    host.polls = host.delay + 1
    with ComfyUIClient(host.url) as client:
        result = client.post("/prompt", json={"prompt": {}, "client_id": "test"})
        host.polls = host.delay + 1
        comfyui._cancel(client, result["prompt_id"])
    assert host.interrupted == [result["prompt_id"]]
    assert not host.deleted


def test_cancel_handles_pending_to_running_race(host):
    from character_workflow.lib.comfyui_client import ComfyUIClient

    host.mode = "timeout"
    host.start_on_delete = True
    with ComfyUIClient(host.url) as client:
        identifier = client.post("/prompt", json={"prompt": {}})["prompt_id"]
        comfyui._cancel(client, identifier)
    assert host.interrupted == [identifier] and not host.deleted


def test_targeted_interrupt_cannot_interrupt_next_job(host):
    from character_workflow.lib.comfyui_client import ComfyUIClient

    host.foreign_running = False
    host.finish_before_interrupt = True
    with ComfyUIClient(host.url) as client:
        identifier = client.post("/prompt", json={"prompt": {}})["prompt_id"]
        client.post("/prompt", json={"prompt": {}})
        host.polls = host.delay + 1
        comfyui._cancel(client, identifier)
    assert host.queue()["queue_running"][0][1] == "prompt-2"
    assert not host.interrupted


@pytest.mark.parametrize("phase", ["queued:1", "sent", "downloading"])
def test_phase_callback_cancellation_stops_owned_task(host, tmp_path, phase):
    from character_workflow.lib.job_runner import JobCanceled

    workflow = imported()
    if phase == "sent":
        host.foreign_running = False
        host.delay = 0

    def changed(value):
        if value == phase:
            raise JobCanceled("cancel")

    with pytest.raises(JobCanceled):
        comfyui.render(prompt="cat", model=workflow.id, alias="local", output_dir=tmp_path,
                       n=3, on_phase=changed)
    assert len(host.prompts) == 1
    assert host.deleted == (["prompt-1"] if phase == "queued:1" else [])
    assert host.interrupted == (["prompt-1"] if phase == "sent" else [])
    assert not list(tmp_path.glob("*.png"))


def test_reimport_migrates_node_ids_and_reports_lost(host):
    workflow = imported()
    graph = copy.deepcopy(workflow.api_workflow)
    graph["new-prompt"] = graph.pop("6")
    result = workflows.inspect_workflow("local", graph, workflow.id)
    assert not result["unmapped"]
    assert next(item for item in result["inputs"] if item["type"] == "prompt")["node_id"] == "new-prompt"
    graph["new-prompt"]["_meta"]["title"] = "in:changed"
    assert workflows.inspect_workflow("local", graph, workflow.id)["unmapped"]


def test_runner_persists_phases_and_zero_cost(host):
    from character_workflow.lib.job_runner import run_job
    from character_workflow.lib.jobs import list_jobs
    from viewer_server.routes import _StudioJobCreate, _create_user_job
    workflow = imported()
    job = _create_user_job(_StudioJobCreate(
        prompt="cat", model=workflow.id, alias="local", params={"n": 1},
    ), namespace="studio")
    result = run_job(job.job_id)
    assert result.status.value == "done", result.error
    assert result.params.estimated_cost_cny == 0
    assert result.completed_at is not None
    assert len(list_jobs()) == 1


def test_local_api_import_and_access_boundary(host):
    from fastapi.testclient import TestClient
    from tests.local_client import LocalTestClient
    from viewer_server.server_app import build_app
    app = build_app()
    with TestClient(app, base_url="http://127.0.0.1") as anonymous:
        assert anonymous.get("/api/comfyui/local/workflows").status_code == 401
    with LocalTestClient(app, base_url="http://127.0.0.1") as client:
        assert client.post("/api/keys", json={"alias": "second", "provider": "comfyui"}).status_code == 201
        assert client.post("/api/comfyui/connection", json={"base_url": host.url}).json()["devices"]
        graph = json.loads((FIXTURES / "lora.json").read_text())
        inspected = client.post("/api/comfyui/local/inspect", json={"api_workflow": graph})
        assert inspected.status_code == 200
        saved = client.post("/api/comfyui/local/workflows", json={
            "name": "local workflow", "api_workflow": graph, "inputs": inspected.json()["inputs"],
        })
        assert saved.status_code == 200, saved.text
        identifier = saved.json()["id"]
        assert client.patch("/api/keys/local", json={"models": []}).status_code == 422
        assert client.delete(f"/api/comfyui/second/workflows/{identifier}").status_code == 422
        assert client.delete(f"/api/comfyui/local/workflows/{identifier}").status_code == 204


def test_canvas_preserves_workflow_values_and_runs(host):
    from character_workflow.lib.canvas_projects import create_canvas_project
    from character_workflow.lib.canvas_runs import submit_canvas_run, run_canvas_job
    from character_workflow.lib.jobs import read_job
    from tests.test_generation_recipe import NOW, _media_node, _save_nodes
    workflow = imported()
    strength = next(item for item in workflow.inputs if item.type == "float")
    draft = {"mode": "image", "prompt": "cat", "alias": "local", "model": workflow.id,
             "params": {"n": 1, "workflow_inputs": {strength.id: 0.45}}, "updated_at": NOW}
    project = create_canvas_project("ComfyUI canvas")
    document = _save_nodes(project.project_id, [_media_node("source", draft)], [])
    job, _ = submit_canvas_run(project.project_id, "source", document.revision)
    assert job.params.workflow_inputs == {strength.id: 0.45}
    run_canvas_job(job.job_id)
    assert read_job(job.job_id).status.value == "done", read_job(job.job_id).error
    graph = next(iter(host.prompts.values()))["prompt"]
    assert graph[strength.node_id]["inputs"][strength.field] == 0.45


def test_canvas_without_prompt_ignores_previous_prompt(host):
    from character_workflow.lib.canvas_projects import create_canvas_project
    from character_workflow.lib.canvas_runs import submit_canvas_run
    from tests.test_generation_recipe import NOW, _media_node, _save_nodes
    workflow = imported()
    workflow = workflows.save_workflow(
        "local", name=workflow.name, identifier=workflow.id, api_workflow=workflow.api_workflow,
        inputs=[item for item in workflow.inputs if item.type != "prompt"],
    )
    draft = {"mode": "image", "prompt": "old prompt", "alias": "local", "model": workflow.id,
             "params": {"n": 1}, "updated_at": NOW}
    project = create_canvas_project("No prompt")
    document = _save_nodes(project.project_id, [_media_node("source", draft)], [])
    job, _ = submit_canvas_run(project.project_id, "source", document.revision)
    assert job.prompt == ""


def test_mask_without_declared_input_is_rejected_before_upload(host, tmp_path):
    workflow = imported()
    mask = tmp_path / "mask.png"
    mask.write_bytes(host.png)
    with pytest.raises(ValueError, match="没有遮罩输入"):
        comfyui.render(prompt="cat", model=workflow.id, alias="local", output_dir=tmp_path,
                       params={"mask_image": str(mask)})
    assert not host.uploads and not host.prompts
