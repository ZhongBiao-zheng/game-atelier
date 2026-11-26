import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import collab_config
from character_workflow.lib.canvas_projects import read_canvas_document
from character_workflow.lib.jobs import read_job
from character_workflow.lib.keys import KeySpec, ModelSpec, read_keys_db, write_keys_db
from character_workflow.lib.usage_stats import mine_records
from tests.test_generation_recipe import NOW, canvas_run_with_inputs, png
from viewer_server.collab_app import create_collab_app


@pytest.mark.parametrize("change", ["view", "gateway"])
def test_borrowed_run_is_bound_to_current_policy_and_direct_model(monkeypatch, change):
    image = png((20, 40, 60))
    pid, _job, document = canvas_run_with_inputs(image, image, image)
    db = read_keys_db()
    db.keys.append(KeySpec(alias="gateway", provider="atelier", created_at=NOW,
                           access_key="test-private-value", base_url="http://192.168.1.10:5180",
                           models=[ModelSpec(id="gateway-only-model", name="网关模型")]))
    write_keys_db(db)
    collab_config.enable_share(pid, collab_config.ShareSettings())
    jobs = []
    monkeypatch.setattr("viewer_server.routes._run_canvas_job_safely", jobs.append)
    root = "/collab/v1/projects/" + pid
    with TestClient(create_collab_app(), base_url="http://127.0.0.1", client=("127.0.0.1", 50001)) as client:
        token = client.post(root + "/auth", json={"display_name":"访客"}).json()["collab_token"]
        headers = {"authorization":"Bearer " + token}
        assert client.get(root + "/borrowable-models", headers=headers).status_code == 403
        collab_config.enable_share(pid, collab_config.ShareSettings(allow_borrow_provider=True))
        models = client.get(root + "/borrowable-models", headers=headers)
        assert models.status_code == 200, models.text
        assert all(value not in models.text for value in ("192.168.", "test-private-value", "gateway-only-model", "access_key"))
        choice = next(model for model in models.json()["models"] if model["model"] == "gpt-image-1")
        request = {"expected_revision":document.revision, "surface_node_id":"config",
                   "model":choice["model"], "channel_id":choice["channel_id"], "prompt":"下一张"}
        response = client.post(root + "/runs/borrowed", headers=headers, json=request)
        assert response.status_code == 202, response.text
        duplicate = client.post(root + "/runs/borrowed", headers=headers, json=request)
        assert duplicate.status_code == 409
        assert len(jobs) == 1
        submitted = read_job(jobs[0])
        assert submitted.params.collab_guest_name == "访客"
        result = next(n for n in read_canvas_document(pid).nodes if n.id == response.json()["node_id"])
        assert result.collab_run.initiated_by == "访客" and result.collab_run.execution_mode == "borrowed"
        usage, = mine_records([submitted], {pid:"美术评审"})
        assert usage["member_label"] == "共享画布 · 访客" and usage["project_label"] == "美术评审"
        if change == "view":
            collab_config.enable_share(pid, collab_config.ShareSettings(mode="view", allow_borrow_provider=True))
            assert client.post(root + "/runs/borrowed", headers=headers, json=request).status_code == 403
        else:
            db.keys[0] = db.keys[-1].model_copy(update={"alias":submitted.alias, "models":db.keys[0].models})
            write_keys_db(db)
        from character_workflow.lib import job_runner
        from character_workflow.lib.canvas_runs import run_canvas_job
        def unexpected(*args, **kwargs):
            pytest.fail("provider ran after host changed admission")
        monkeypatch.setattr(job_runner, "dispatch", unexpected)
        with pytest.raises(job_runner.JobRunnerError, match="房主"):
            run_canvas_job(submitted.job_id)
        assert read_job(submitted.job_id).status == "failed"


def test_menu_only_exposes_recognized_channels_and_public_labels():
    from character_workflow.lib.collab_borrow import borrowable_models
    from character_workflow.lib.keys import KeysDB

    def channel(alias, url, models, provider="custom", **overrides):
        return KeySpec(alias=alias, provider=provider, base_url=url, created_at=NOW,
                       models=models, **overrides)

    private = "/Users/host/private/workflows/test.json"
    text = ModelSpec(id="deepseek/test", name=private, modality="text", protocol="openai-chat",
                     input_cny_per_m=1.2, output_cny_per_m=8.7)
    speech = ModelSpec(id="tts-one", name="语音", modality="audio", protocol="openai-speech", per_call_cny=.4)
    channels = [
        channel("hidden-alias", "https://api.deepseek.com", [text, speech,
                text.model_copy(update={"id": private}), text.model_copy(update={"id": "declared", "protocol": "declarative"}),
                text.model_copy(update={"id": "sk-private-value"}),text.model_copy(update={"id":"bad-protocol","protocol":private})],
                access_key="sk-private-value", icon="file:" + "f"*64),
        channel("hidden-unknown-host", "https://example.invalid", [text]),
        channel("spoof-provider", "https://192.168.0.15/v1", [text], provider="openai"),
        channel("bad-suffix", "https://api.deepseek.com.example.invalid", [text]),
        channel("unlisted-subdomain", "https://unlisted.api.deepseek.com", [text]),
        channel("bad-user", "https://host-secret@api.deepseek.com", [text]),
        channel("disabled", "https://api.deepseek.com", [text], enabled=False),
    ]
    write_keys_db(KeysDB(keys=channels))
    choices = borrowable_models()
    assert len(choices) == 2
    first, second = choices
    assert first["name"] == first["model"] == text.id and first["icon"] is None
    assert first["provider"] == "deepseek" and first["provider_label"] == "DeepSeek"
    assert first["cost_unit"] == "million_tokens" and first["cost_cny"] is None
    assert (first["input_cny_per_m"],first["output_cny_per_m"]) == (1.2,8.7)
    assert second["cost_unit"] == "request" and second["cost_cny"] == .4
    assert all(secret not in str(choices) for secret in (private, "hidden-", "base_url", "192.168.",
                                                          "host-secret", "sk-private-value", "file:"))


def test_usage_scopes_collab_fields_to_host_canvas_and_local_staging():
    from character_workflow.lib.schemas import JobKind
    raw = png((1, 2, 3))
    pid, job, _ = canvas_run_with_inputs(raw, raw, raw)
    fields = job.params.model_copy(update={"collab_guest_name": "访客", "collab_guest_client": "id",
                                          "collab_borrow_channel": "a"*32, "collab_source_canvas": "远端画布"})
    spoof = job.model_copy(update={"params":fields, "namespace":"studio","canvas_project_id":None,"canvas_run":None})
    assert mine_records([spoof], {})[0]["member_label"] is None
    assert mine_records([spoof.model_copy(update={"kind":JobKind.TEXT})], {}) == []
    real = job.model_copy(update={"kind":JobKind.TEXT, "params":fields})
    assert mine_records([real], {pid:"房主画布"})[0]["project_label"] == "房主画布"
    staged = real.model_copy(update={"canvas_project_id":"canvas-collab-" + "b"*24,
        "params":job.params.model_copy(update={"collab_source_canvas":"远端画布"})})
    row, = mine_records([], {}, [staged])
    assert row["project_label"] == "远端画布" and row["kind"] == "text" and row["member_label"] is None


def test_pin_discards_changed_alias_and_exits_cleanly():
    from character_workflow.lib.collab_borrow import borrowed_execution, channel_id
    from character_workflow.lib.keys import find_by_alias

    raw = png((20, 0, 30))
    pid, job, _ = canvas_run_with_inputs(raw, raw, raw)
    collab_config.enable_share(pid, collab_config.ShareSettings(allow_borrow_provider=True))
    db = read_keys_db()
    first = db.keys[0]
    job.params.collab_guest_name = "访客"
    job.params.collab_guest_client = "stable-client"
    job.params.collab_borrow_channel = channel_id(first)
    with borrowed_execution(job):
        first.enabled = False
        write_keys_db(db)
        assert find_by_alias(job.alias).enabled
    assert not find_by_alias(job.alias).enabled


def test_text_usage_prices_each_receipt_and_skips_missing_values(monkeypatch):
    from character_workflow.lib.collab_borrow import record_text_cost
    from character_workflow.lib.callers import openai_text

    raw = png((0, 0, 0))
    _, job, _ = canvas_run_with_inputs(raw, raw, raw)
    db = read_keys_db()
    db.keys[0].models = [ModelSpec(id="receipt-test", name="文本", input_cny_per_m=4, output_cny_per_m=10,
                                   modality="text",protocol="openai-responses")]
    write_keys_db(db)
    job.model = "receipt-test"
    params = job.params.model_dump(exclude_none=True)
    params.pop("actual_cost_cny", None)
    monkeypatch.setattr(openai_text, "_post_json", lambda **kw: {"output_text":"成品",
                                                               "usage":{"input_tokens":1_000,"output_tokens":100}})
    outputs = openai_text.generate(prompt="test",model=job.model,alias=job.alias,n=2,
        on_text_usage=lambda key, usage: record_text_cost(job,params,key,usage))
    assert outputs == ["成品","成品"] and read_job(job.job_id).params.actual_cost_cny == .01
    record_text_cost(job,params,db.keys[0],{})
    assert read_job(job.job_id).params.actual_cost_cny == .01


def test_borrowed_multi_candidate_makes_each_payment_visible(monkeypatch):
    from character_workflow.lib import job_runner
    from character_workflow.lib.canvas_runs import run_canvas_job, submit_canvas_run
    from character_workflow.lib.collab_borrow import BorrowedGeneration, channel_id

    image = png((14, 31, 61))
    pid, _, source = canvas_run_with_inputs(image,image,image)
    collab_config.enable_share(pid, collab_config.ShareSettings(allow_borrow_provider=True))
    key = read_keys_db().keys[0]
    selection = BorrowedGeneration(channel_id(key),"gpt-image-1","多图",{}, "访客","stable-id", lambda: None)
    submitted,_ = submit_canvas_run(pid,"config",source.revision,2,borrow=selection)
    costs = iter([.5, 1])
    def dispatch(*, output_dir, on_cost_usd, **kw):
        on_cost_usd(next(costs))
        target = output_dir/"result.png"
        target.write_bytes(image)
        return [str(target)]
    monkeypatch.setattr(job_runner,"dispatch",dispatch)
    done = run_canvas_job(submitted.job_id)
    assert done.status == "done"
    assert [candidate.actual_cost_cny for candidate in done.canvas_run.candidates] == [
        round(n * job_runner.USD_TO_CNY, 6) for n in (.5, 1)]
    assert done.params.actual_cost_cny == round(1.5 * job_runner.USD_TO_CNY,6)
    document = read_canvas_document(pid)
    by_id = {node.id: node for node in document.nodes}
    cover = by_id[done.canvas_run.result_node_id]
    assert cover.data.result_stack.run_id == done.canvas_run.run_id
    member, = (by_id[key] for key in cover.data.result_stack.member_node_ids)
    assert member.data.current_version_id == done.canvas_run.candidates[1].version_id
    assert (member.created_by, member.created_by_client) == ("访客", "stable-id")


@pytest.mark.parametrize("operation", ["inpaint", "outpaint", "layer_decomposition"])
def test_shared_operation_rejected_before_guest_reservation_or_host_job(monkeypatch, operation):
    from fastapi import FastAPI

    from character_workflow.lib.canvas_projects import save_canvas_document
    from character_workflow.lib.collab_borrow import OPERATION_ERRORS, channel_id
    from character_workflow.lib.collab_sanitize import public_document
    from character_workflow.lib.jobs import list_jobs
    from character_workflow.lib.keys import KeysDB
    from character_workflow.lib.schemas import CanvasImageEditNode
    from tests.test_canvas_layer_decomposition import _project_with_decomposition_node
    from viewer_server import collab_guest_run_routes
    from viewer_server.collab_access import authenticate

    model = ModelSpec(id="gpt-image-1", name="GPT Image 1", modality="image")
    key = KeySpec(alias="image", provider="openai", created_at=NOW, models=[model])
    write_keys_db(KeysDB(keys=[key]))
    project, document, source = _project_with_decomposition_node(alias=key.alias, model=model.id)
    pid = project.project_id
    target = "layer-stack"
    if operation != "layer_decomposition":
        target = "saved-edit"
        edit = CanvasImageEditNode(id=target, title="编辑", type="image_edit", position={"x": 60, "y": 50},
                                   data={"source_version_id": source.version_id, "options": {"mode": operation}})
        document = save_canvas_document(pid, document.model_copy(update={"nodes": [*document.nodes, edit]}),
                                        document.revision)
    collab_config.enable_share(pid, collab_config.ShareSettings(allow_borrow_provider=True))
    token = authenticate(pid, "", "访客")["collab_token"]
    submitted = {"surface_node_id": target, "expected_revision": document.revision, "model": model.id}
    with TestClient(create_collab_app(), base_url="http://127.0.0.1",
                    client=("127.0.0.1", 50001)) as owner:
        borrowed = owner.post(f"/collab/v1/projects/{pid}/runs/borrowed",
                              headers={"Authorization": "Bearer " + token},
                              json={**submitted, "channel_id": channel_id(key)})
    code, message = OPERATION_ERRORS[operation]
    assert borrowed.status_code == 422 and borrowed.json()["detail"] == {"code": code, "message": message}

    app = FastAPI()
    app.include_router(collab_guest_run_routes.collab_guest_local_router)
    def remote(request, peer_key, project_id, suffix, **kwargs):
        assert suffix == "document", "an unsupported tool must not reserve a host node"
        return {"document": public_document(pid), "name": "共享画布"}
    monkeypatch.setattr(collab_guest_run_routes, "remote_json", remote)
    with TestClient(app) as guest:
        local = guest.post(f"/api/collab/remote/owner/projects/{pid}/runs/local",
                           json={**submitted, "alias": key.alias})
    assert local.status_code == 422 and local.json()["detail"] == borrowed.json()["detail"]
    assert read_canvas_document(pid).revision == document.revision and not list_jobs()


def test_menu_reports_real_edit_and_layer_capabilities_and_distinguishes_workflow_edit_modes():
    from character_workflow.lib.collab_borrow import borrowable_models, supported_operations
    from character_workflow.lib.keys import KeysDB

    def model(name, protocol=None):
        return ModelSpec(id=name, name=name, modality="image", protocol=protocol)
    image = KeySpec(alias="direct", provider="openai", created_at=NOW, models=[
        model("gpt-image-1"), model("gpt-image-2.5"), model("doubao-seedream-5-0-pro-260628", "ark")])
    write_keys_db(KeysDB(keys=[image]))
    capabilities = {row["model"]: row["supported_operations"] for row in borrowable_models()}
    assert capabilities == {"gpt-image-1": [], "gpt-image-2.5": ["inpaint", "outpaint"],
                            "doubao-seedream-5-0-pro-260628": ["inpaint", "outpaint", "layer_decomposition"]}
    workflow = ModelSpec(id="comfyui-mask", name="蒙版", modality="image", workflow_inputs=[
        {"type": kind, "id": kind, "label": kind, "class_type": "LoadImage", "node_id": str(i), "field": kind}
        for i, kind in enumerate(["image", "mask"])
    ])
    local = KeySpec(alias="本机", provider="comfyui", created_at=NOW, models=[workflow])
    assert supported_operations(local, workflow) == ["inpaint"]


def test_borrowed_proxy_preserves_known_operation_rejections():
    import json

    import httpx
    from viewer_server.collab_proxy import _borrowed_operation_error

    def upstream(code):
        body = json.dumps({"detail": {"code": code, "message": "private host detail"}}).encode()
        return httpx.Response(422, stream=httpx.ByteStream(body))
    assert _borrowed_operation_error(upstream("canvas_outpaint_model_invalid")) == {
        "code": "canvas_outpaint_model_invalid", "message": "当前模型不支持扩图，请选择兼容模型。"}
    assert _borrowed_operation_error(upstream("some_other_error")) is None
