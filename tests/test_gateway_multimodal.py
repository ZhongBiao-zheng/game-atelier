"""Protocol v2 modalities: uploads, ownership, artifacts and uncertain submission."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import callers, gateway_keys, gateway_tasks, keys, model_routes
from character_workflow.lib.callers import image_edit
from viewer_server.gateway_app import create_gateway_app
from tests.test_gateway import _png


@pytest.fixture
def hub(monkeypatch, isolated_data_root):
    monkeypatch.setattr(gateway_tasks, "pump", lambda: None)
    model_routes._cooldowns.clear()
    models = [keys.ModelSpec(id=id, name=id, modality=modality, protocol=protocol)
              for id, modality, protocol in [("gpt-image-2.5", "image", None),
                  ("seedance-test", "video", "seedance"), ("tts-1", "audio", None)]]
    keys.add_key(keys.KeySpec(alias="up", provider="openai", access_key="fake",
        modalities=["image", "video", "audio"], models=models, created_at="test"))
    owner, token = gateway_keys.create_key("owner", None)
    client = TestClient(create_gateway_app(), headers={"Authorization": f"Bearer {token}"})
    return client, owner


def submit(hub, kind, params=None, files=None):
    client, _ = hub
    model = {"video": "seedance:seedance-test", "audio": "tts-1"}.get(kind, "gpt-image-2.5")
    return client.post("/gateway/v1/tasks", headers={"Idempotency-Key": "test"},
        data={"request": json.dumps(dict(kind=kind, model=model, prompt="test", n=1,
                                        params=params or {}))}, files=files or {})


@pytest.mark.parametrize("kind", ["image", "image_edit", "layer_split", "video", "audio"])
def test_multimodal_roundtrip(hub, monkeypatch, kind):
    params, files = {}, {}
    if kind in {"image_edit", "layer_split", "video"}:
        files["ref_0"] = ("source.png", b"uploaded-image")
    if kind == "image_edit":
        params["image_edit"] = {"mode": "inpaint"}
        files["mask"] = ("mask.png", b"uploaded-mask")
    if kind == "layer_split":
        params["layer_decomposition"] = True
    if kind == "image":
        files = {f"{group}_0": ("ref.png", group.encode())
                 for group in ("mj_sref", "mj_cref", "mj_oref")}
    if kind == "video":
        files.update(video_0=("ref.mp4", b"video"), audio_0=("ref.mp3", b"audio"))

    def render(*, params, output_dir, **kwargs):
        for group in files:
            name = "mask_image" if group == "mask" else gateway_tasks.FILE_PARAMS[group.rsplit("_", 1)[0]]
            path = params[name] if group == "mask" else params[name][0]
            assert Path(path).read_bytes() == files[group][1]
        suffix, data = {"video": (".mp4", b"\x00\x00\x00\x18ftypisom"),
                        "audio": (".mp3", b"ID3audio")}.get(kind, (".png", None))
        paths = [output_dir / f"out{i}{suffix}" for i in range(2 if kind == "layer_split" else 1)]
        for path in paths:
            path.write_bytes(data) if data else _png(path)
        if kind == "image_edit":
            extra = output_dir / "guide.png"
            _png(extra)
            params["edit_inputs"] = [{"role": "mask", "path": str(extra)}]
        if kind == "layer_split":
            params["layer_decomposition_result"] = {"outputs": [
                dict(output_index=0, z_index=0, size="2x2", output_format="png"),
                dict(output_index=1, z_index=1, size="2x2", output_format="png",
                     bounding_box={"absolute": [0, 0, 2, 2], "normalized": [0, 0, 1000, 1000]})]}
        return list(map(str, paths))

    target, name = (image_edit, "render") if kind == "image_edit" else (callers,
        {"video": "dispatch_video", "audio": "dispatch_audio"}.get(kind, "dispatch"))
    monkeypatch.setattr(target, name, render)
    response = submit(hub, kind, params, files)
    assert response.status_code == 202, response.text
    client, owner = hub
    tid = response.json()["task_id"]
    task = gateway_tasks.run_task(gateway_tasks.get_task(owner.id, tid))
    assert task.status == "done", task.error
    view = client.get(f"/gateway/v1/tasks/{tid}").json()
    assert view["kind"] == kind
    assert view["outputs"] == (2 if kind == "layer_split" else 1)
    assert "upstream_task_ids" not in view and "files" not in view
    for index, mime in enumerate(view["output_types"]):
        result = client.get(f"/gateway/v1/tasks/{tid}/outputs/{index}")
        assert result.status_code == 200 and result.headers["content-type"] == mime
    if kind == "layer_split":
        assert len(view["layer_result"]["outputs"]) == 2
    if kind == "image_edit":
        assert view["extras"] == [{"role": "mask", "index": 0}]
        url = f"/gateway/v1/tasks/{tid}/extras/0"
        assert client.get(url).status_code == 200
        _, token = gateway_keys.create_key("other", None)
        assert client.get(url, headers={"Authorization": f"Bearer {token}"}).status_code == 404


@pytest.mark.parametrize("kind", list(gateway_tasks.ALLOWED_PARAMS_BY_KIND))
@pytest.mark.parametrize("field", [*gateway_tasks.FILE_PARAMS.values(), "source_image", "edit_inputs"])
def test_local_paths_rejected(hub, kind, field):
    assert submit(hub, kind, {field: "/private/path"}).status_code == 422


@pytest.mark.parametrize("options,files", [
    ({"mode": "inpaint"}, {}),
    ({"mode": "outpaint", "width": 10, "height": 10}, {"ref_0": ("x.png", b"x")}),
    ({"mode": "outpaint"}, {"ref_0": ("x.png", b"x"), "mask": ("m.png", b"m")}),
    ({"mode": "inpaint", "source_image": "/x"}, {"ref_0": ("x.png", b"x"), "mask": ("m.png", b"m")}),
])
def test_edit_input_validation(hub, options, files):
    assert submit(hub, "image_edit", {"image_edit": options}, files).status_code == 422


@pytest.mark.parametrize("known", [False, True])
def test_video_uncertainty_never_fails_over(hub, monkeypatch, known):
    def render(**kwargs):
        if known:
            kwargs["on_task_id"]("private-order")
        else:
            kwargs["on_submission"]({"attempt": 1, "outcome": "unconfirmed"})
        raise RuntimeError("api 429")
    monkeypatch.setattr(callers, "dispatch_video", render)
    response = submit(hub, "video")
    client, owner = hub
    tid = response.json()["task_id"]
    task = gateway_tasks.run_task(gateway_tasks.get_task(owner.id, tid))
    assert task.status == "failed" and task.error_kind == "unconfirmed"
    assert task.member_trail == ["up"]
    assert "private-order" not in client.get(f"/gateway/v1/tasks/{tid}").text


@pytest.mark.parametrize("files", [
    {"ref_1": ("x.png", b"x")}, {"ref_16": ("x.png", b"x")},
    {"mj_sref_8": ("x.png", b"x")}, {"unknown": ("x.png", b"x")},
    {"mask_0": ("x.png", b"x")},
    [("ref_0", ("x.png", b"x")), ("ref_0", ("y.png", b"y"))],
])
def test_upload_fields_are_bounded_and_unambiguous(hub, files):
    assert submit(hub, "image", files=files).status_code == 422


def test_file_and_total_size_limits(hub, monkeypatch):
    monkeypatch.setattr(gateway_tasks, "file_limit", lambda group: 3)
    assert submit(hub, "image", files={"ref_0": ("x.png", b"1234")}).status_code == 413
    import viewer_server.gateway_app as app
    monkeypatch.setattr(app, "MAX_BODY_BYTES", 10)
    assert submit(hub, "image").status_code == 413


def test_invalid_layers_charge_reported_cost_once(hub, monkeypatch):
    from character_workflow.lib.job_runner import USD_TO_CNY

    def render(*, output_dir, on_cost_usd, **kwargs):
        on_cost_usd(1)
        path = output_dir / "out.png"
        _png(path)
        return [str(path)]
    monkeypatch.setattr(callers, "dispatch", render)
    response = submit(hub, "layer_split", {"layer_decomposition": True},
                      {"ref_0": ("x.png", b"x")})
    tid = response.json()["task_id"]
    task = gateway_tasks.run_task(gateway_tasks.get_task(hub[1].id, tid))
    assert task.status == "failed"
    assert task.charged_cny == USD_TO_CNY


def test_backend_gateway_capabilities_require_all_members(hub):
    from character_workflow.lib.callers.openai_image import supports_layer_decomposition
    from character_workflow.lib.callers.atelier_gateway import gateway_models
    from character_workflow.lib.callers.image_edit import edit_transport_for_key

    members = [dict(alias="up", provider="seedream", base_url=None,
                    model_id="seedream-5.0-pro", name="Seedream", protocol="ark")]
    model = gateway_models([dict(id="seedream-5.0-pro", name="Seedream", modality="image",
                                members=members)])[0]
    key = keys.KeySpec(alias="hub", provider="atelier", access_key="fake",
                       models=[model], created_at="test")
    assert supports_layer_decomposition(key, model.id)
    assert edit_transport_for_key(key, model.id)
    model.via.append(keys.ViaMember(**{**members[0], "provider": "unknown", "protocol": "unknown"}))
    assert not supports_layer_decomposition(key, model.id)
    assert edit_transport_for_key(key, model.id) is None


def test_canvas_gateway_video_survives_restart(hub):
    from character_workflow.lib.callers.atelier_gateway import gateway_models
    from character_workflow.lib.canvas_projects import create_canvas_project
    from character_workflow.lib.canvas_runs import submit_canvas_run, reconcile_canvas_jobs
    from character_workflow.lib.jobs import save_job, read_job
    from tests.test_generation_recipe import _media_node, _save_nodes, NOW

    model = gateway_models([dict(id="seedance:seedance-test", name="Video", modality="video",
        members=[dict(alias="up", provider="seedance", base_url=None, name="Video",
                      model_id="seedance-test", protocol="seedance")])])[0]
    keys.add_key(keys.KeySpec(alias="hub", provider="atelier", access_key="fake",
                             models=[model], created_at=NOW))
    project = create_canvas_project("gateway video")
    doc = _save_nodes(project.project_id, [_media_node("video", dict(mode="video", prompt="test",
        model=model.id, alias="hub", params={}, updated_at=NOW), "video")], [])
    job, _ = submit_canvas_run(project.project_id, "video", doc.revision)
    save_job(job.model_copy(update={"runner_started_at": NOW, "params": job.params.model_copy(update={
        "provider_task_protocol": "atelier_gateway", "provider_task_ids": ["gateway-order"]})}))
    assert job.job_id in reconcile_canvas_jobs(fail_pending=True, project_id=project.project_id)
    assert read_job(job.job_id).status.value == "pending"


@pytest.mark.parametrize("kind", [[], {}, None, 1, "unknown"])
def test_invalid_kind_returns_validation_error(hub, kind):
    response = hub[0].post("/gateway/v1/tasks", headers={"Idempotency-Key": "bad-kind"},
        data={"request": json.dumps(dict(kind=kind, model="gpt-image-2.5", prompt="test"))})
    assert response.status_code == 422
