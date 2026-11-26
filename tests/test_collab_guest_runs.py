from types import SimpleNamespace

import pytest

from character_workflow.lib import collab_guest_runs as runs
from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, resolve_canvas_media, save_canvas_document,
)
from character_workflow.lib.schemas import CanvasDocument, CanvasFrozenGeneration
from tests.test_generation_recipe import NOW, png


def make_canvas(kind):
    pid = create_canvas_project("共享").project_id
    current = read_canvas_document(pid)
    raw = current.model_dump(mode="json")
    raw["nodes"] = [{"id": "n", "title": "来源", "type": kind,
                     "position": {"x": 0, "y": 0}, "data": {}}]
    save_canvas_document(pid, CanvasDocument.model_validate(raw), 0)
    return pid


def reserve(pid, mode="image"):
    return runs.reserve(pid, runs.Reservation(
        run_id="run-" + "1" * 24, source_node_id="n", expected_revision=1,
        mode=mode, model="mock", prompt="图像",
    ), auth)


def auth():
    return SimpleNamespace(client_id="guest1", display_name="小林")


def test_reserve_heartbeat_commit_preserves_multi_output_and_deduplicates():
    pid = make_canvas("image")
    pending = reserve(pid)
    assert reserve(pid) == pending
    run_id = pending["collab_run_id"]
    assert runs.heartbeat(pid, run_id, auth)["status"] == "pending"
    snapshot = CanvasFrozenGeneration(source_kind="canvas", mode="image", prompt="火山",
                                      model_id="mock", provider="custom", cost_cny=.2)
    files = [png((1, 2, 3)), png((4, 5, 6))]
    payload = runs.Outputs(snapshot=snapshot, media_count=2)
    done = runs.commit(pid, run_id, payload, files, auth)
    assert done["status"] == "done"
    doc = read_canvas_document(pid)
    final = next(n for n in doc.nodes if n.id == pending["node_id"])
    assert len(final.data.result_stack.member_node_ids) == 1
    assert doc.content_versions[final.data.current_version_id].frozen_generation.created_by == auth().display_name
    assert resolve_canvas_media(pid, final.data.current_version_id)[0].read_bytes() == files[0]
    assert runs.commit(pid, run_id, payload, files, auth) == done
    assert read_canvas_document(pid).revision == doc.revision


def test_stale_or_wrong_actor_cannot_replace_a_placeholder_and_late_heartbeat_rejected():
    pid = make_canvas("image")
    run_id = reserve(pid)["collab_run_id"]
    with pytest.raises(runs.RunError, match="其他成员"):
        runs.fail(pid, run_id, "unknown", lambda: SimpleNamespace(client_id="other"))
    assert runs.expire_runs(pid, now=10**12) == 1
    with pytest.raises(runs.RunError, match="已结束"):
        runs.heartbeat(pid, run_id, auth)
    assert read_canvas_document(pid).nodes[-1].collab_run.status == "interrupted"


def test_text_guest_normal_entry_runs_mock_provider_and_bills_local_archive(monkeypatch):
    from character_workflow.lib import job_runner, jobs
    from character_workflow.lib.canvas_runs import run_canvas_job
    from character_workflow.lib.keys import KeysDB, KeySpec, ModelSpec, write_keys_db
    from character_workflow.lib.collab_provenance import build_frozen_from_job
    from character_workflow.lib.canvas_projects import list_canvas_projects
    pid = make_canvas("text")
    source = read_canvas_document(pid)
    run_id = reserve(pid, "text")["collab_run_id"]
    body = runs.GuestRequest(surface_node_id="n", expected_revision=1, alias="测试",
                             model="mock-text", prompt="画面描述", params={"max_tokens": 12})
    write_keys_db(KeysDB(keys=[KeySpec(alias="测试", provider="openai", created_at=NOW, access_key="fake-test",
        models=[ModelSpec(name="Mock", id="mock-text", modality="text", protocol="openai")])]))
    local_id, kind = runs.stage_generation(run_id, source, "共享", body,
        lambda *_: pytest.fail("无参考文本生成不应请求任何媒体"))
    assert all(row.project_id != local_id for row in list_canvas_projects())
    monkeypatch.setattr(job_runner, "dispatch_text", lambda **kwargs: ["一幅油画"])
    job = runs.submit_staged(local_id, kind, body)
    done = run_canvas_job(job.job_id)
    assert done.status == "done"
    snapshot = build_frozen_from_job(done, local_id)
    runs.commit(pid, run_id, runs.Outputs(snapshot=snapshot, texts=["一幅油画"]), [], auth)
    runs.remove_stage(run_id, job.job_id)
    assert jobs.list_usage_archive()[0].job_id == job.job_id
    doc = read_canvas_document(pid)
    assert doc.content_versions[doc.nodes[-1].data.current_version_id].text == "一幅油画"


def test_failed_partial_commit_keeps_pending_and_none_of_the_bytes():
    pid = make_canvas("image")
    run_id = reserve(pid)["collab_run_id"]
    payload = runs.Outputs(snapshot=CanvasFrozenGeneration(source_kind="canvas", mode="image", model_id="m",
                                                           provider="OpenAI"), media_count=2)
    with pytest.raises(runs.RunError):
        runs.commit(pid, run_id, payload, [png((1, 1, 1)), b"invalid"], auth)
    assert read_canvas_document(pid).content_versions == {}
    assert runs.fail(pid, run_id, "insufficient_balance", auth)["status"] == "failed"


def test_guest_layer_stack_preserves_source_and_named_layers():
    from tests.test_canvas_layer_decomposition import _configure_seedream, _project_with_decomposition_node
    from character_workflow.lib.schemas import LayerDecompositionResult
    _configure_seedream()
    project, source, ver = _project_with_decomposition_node()
    pid = project.project_id
    body = runs.GuestRequest(surface_node_id="layer-stack", expected_revision=source.revision,
                             alias="ark", model="doubao-seedream-5-0-pro-260628", prompt="拆分")
    run_id = "run-" + "2" * 24
    _ = runs.reserve(pid, runs.Reservation(run_id=run_id, source_node_id="layer-stack",
                      expected_revision=source.revision, mode="image", model=body.model), auth)
    local_id, kind = runs.stage_generation(run_id, source, "分层", body,
        lambda v, budget: resolve_canvas_media(pid, v.version_id)[0].read_bytes())
    job = runs.submit_staged(local_id, kind, body)
    assert job.params.layer_decomposition
    snapshot = CanvasFrozenGeneration(source_kind="canvas", mode="image", model_id=body.model, provider="seedream",
        inputs=[{"order": 0, "kind": "image", "role": "source", "version_id": ver.version_id}])
    layers = LayerDecompositionResult.model_validate({"outputs": [
        {"output_index": 0, "z_index": 0, "size": "4x4", "output_format": "png"},
        {"output_index": 1, "z_index": 1, "size": "4x4", "output_format": "png", "name": "前景",
         "bounding_box": {"absolute": [0, 0, 4, 4], "normalized": [0, 0, 1000, 1000]}},
    ]})
    runs.commit(pid, run_id, runs.Outputs(snapshot=snapshot, media_count=2, layers=layers),
                [png((0, 1, 2)), png((4, 5, 6))], auth)
    doc = read_canvas_document(pid)
    node = next(n for n in doc.nodes if n.collab_run)
    assert node.type == "layer_stack" and node.data.source_version_id == ver.version_id
    assert node.data.layers[0].name == "前景" and node.data.layers[0].version_id in doc.content_versions


def test_guest_saved_image_edit_uses_local_source_and_mask_bytes():
    from tests.test_generation_recipe import canvas_mask_run
    src = png((0, 30, 1))
    pid, _, old = canvas_mask_run(src, png((4, 5, 7)))
    edit = next(n for n in old.nodes if n.type == "image_edit")
    body = runs.GuestRequest(surface_node_id=edit.id, expected_revision=old.revision,
                             alias="Evo", model="mj-v8.2", prompt="修改天空")
    run_id = "run-" + "3" * 24
    local_id, kind = runs.stage_generation(run_id, old, "局部编辑", body,
        lambda v, budget: resolve_canvas_media(pid, v.version_id)[0].read_bytes())
    job = runs.submit_staged(local_id, kind, body)
    assert job.params.image_edit and job.canvas_run.snapshot.mask_version_id
    assert "collab-staging" in job.params.mask_image
    assert resolve_canvas_media(local_id, edit.data.source_version_id)[0].read_bytes() == src


def test_public_http_reserve_commit_holds_token_and_mode():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from character_workflow.lib import collab_config
    from viewer_server.collab_access import authenticate
    from viewer_server.collab_guest_run_routes import collab_guest_lan_router
    pid = make_canvas("image")
    collab_config.enable_share(pid, collab_config.ShareSettings(mode="edit"))
    token = authenticate(pid, "", "测试画师")["collab_token"]
    headers = {"Authorization": "Bearer " + token}
    app = FastAPI()
    app.include_router(collab_guest_lan_router)
    with TestClient(app) as client:
        prefix = f"/collab/v1/projects/{pid}/runs"
        run_id = "run-" + "4" * 24
        body = {"source_node_id": "n", "expected_revision": 1, "run_id": run_id, "mode": "image", "model": "test"}
        assert client.post(prefix + "/reserve", json=body).status_code == 401
        assert client.post(prefix + "/reserve", json=body, headers=headers).status_code == 201
        files = {"manifest": (None, runs.Outputs(snapshot=CanvasFrozenGeneration(source_kind="canvas", mode="image",
                 model_id="test", provider="custom"), media_count=1).model_dump_json()),
                 "output-0": ("output", png((1,2,3)), "application/octet-stream")}
        collab_config.enable_share(pid, collab_config.ShareSettings(mode="view"))
        assert client.post(prefix + f"/{run_id}/commit", headers=headers, files=files).status_code == 403
        collab_config.enable_share(pid, collab_config.ShareSettings(mode="edit"))
        result = client.post(prefix + f"/{run_id}/commit", headers=headers, files=files)
        assert result.status_code == 200, result.text
        assert result.json()["status"] == "done"


@pytest.mark.parametrize("host_acknowledges", [True, False])
def test_local_submit_through_host_http_with_mock_text_caller(monkeypatch, host_acknowledges):
    import time
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from character_workflow.lib import collab_config, job_runner, jobs
    from character_workflow.lib.keys import KeysDB, KeySpec, ModelSpec, write_keys_db
    from viewer_server import collab_guest_run_routes as routes
    from viewer_server.collab_access import authenticate
    from character_workflow.lib.collab_sanitize import public_document
    pid = make_canvas("text")
    collab_config.enable_share(pid, collab_config.ShareSettings(mode="edit"))
    headers = {"Authorization": "Bearer " + authenticate(pid, "", "访客")["collab_token"]}
    host, guest = FastAPI(), FastAPI()
    host.include_router(routes.collab_guest_lan_router)
    guest.include_router(routes.collab_guest_local_router)
    write_keys_db(KeysDB(keys=[KeySpec(alias="local", provider="openai", created_at=NOW,
        access_key="test", models=[ModelSpec(id="test", name="文本", modality="text")])]))
    calls = []
    reservations = []
    def fake_text(**kwargs):
        calls.append(kwargs["model"])
        return ["成品文本"]
    monkeypatch.setattr(job_runner, "dispatch_text", fake_text)
    with TestClient(host) as owner, TestClient(guest) as member:
        def remote(request, peer, project_id, suffix, *, method="GET", **opts):
            if suffix == "document":
                return {"document": public_document(pid), "name": "共享", "mode": "edit"}
            if not host_acknowledges and suffix.endswith("/commit"):
                from fastapi import HTTPException
                raise HTTPException(403, "房主已关闭共享")
            res = owner.request(method, f"/collab/v1/projects/{pid}/{suffix}", headers=headers, **opts)
            assert res.status_code < 300, res.text
            if suffix == "runs/reserve":
                reservations.append(res.json()["collab_run_id"])
                if host_acknowledges and len(reservations) == 1:
                    from fastapi import HTTPException
                    raise HTTPException(502, "模拟房主预留成功后回执丢失")
            return res.json()
        monkeypatch.setattr(routes, "remote_json", remote)
        from concurrent.futures import ThreadPoolExecutor
        url = f"/api/collab/remote/host/projects/{pid}/runs/local"
        body = {"request_id": "a" * 32, "surface_node_id": "n", "expected_revision": 1,
                "alias": "local", "model": "test", "prompt": "一条描述"}
        if host_acknowledges:
            assert member.post(url, json=body).status_code == 502
        with ThreadPoolExecutor(2) as pool:
            first, second = [pool.submit(member.post, url, json=body) for _ in range(2)]
            result, duplicate = first.result(), second.result()
        assert result.status_code == duplicate.status_code == 202, result.text
        assert result.json()["collab_run_id"] == duplicate.json()["collab_run_id"]
        assert member.post(url, json={**body, "model": "changed"}).status_code == 409
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline and not jobs.list_usage_archive():
            time.sleep(.03)
        replay = member.post(url, json={**body, "expected_revision": read_canvas_document(pid).revision})
        assert replay.status_code == 202 and replay.json()["node_id"] == result.json()["node_id"]
        assert len(set(reservations)) == 1
    assert calls == ["test"] and len(jobs.list_usage_archive()) == 1
    doc = read_canvas_document(pid)
    result_node = next(n for n in doc.nodes if n.id == result.json()["node_id"])
    if host_acknowledges:
        assert result_node.collab_run.status == "done" and doc.content_versions[result_node.data.current_version_id].text == "成品文本"
    else:
        from character_workflow.lib.canvas_projects import list_canvas_projects
        retained, = [p for p in list_canvas_projects() if p.name.endswith("未回传的生成结果")]
        saved = read_canvas_document(retained.project_id)
        version, = [v for v in saved.content_versions.values() if v.kind == "text" and v.text == "成品文本"]
        assert version.frozen_generation.prompt == "一条描述" and result_node.collab_run.status == "failed"


def test_restart_interrupts_unclaimed_guests_and_recovers_completed_results(monkeypatch):
    from character_workflow.lib import jobs, job_runner
    from character_workflow.lib.canvas_projects import list_canvas_projects
    from character_workflow.lib.canvas_runs import reconcile_canvas_jobs, run_canvas_job
    from character_workflow.lib.keys import KeysDB, KeySpec, ModelSpec, write_keys_db

    pid = make_canvas("text")
    source = read_canvas_document(pid)
    body = runs.GuestRequest(surface_node_id="n", expected_revision=1, alias="local", model="mock",
                             prompt="恢复产物")
    write_keys_db(KeysDB(keys=[KeySpec(alias="local", provider="openai", created_at=NOW,
        models=[ModelSpec(id="mock",name="文本",modality="text")])]))
    monkeypatch.setattr(job_runner, "dispatch_text", lambda **kw: ["恢复成片"])
    for idx in ("1","2"):
        local, kind = runs.stage_generation("run-" + idx*24, source,"共享",body, lambda *_: b"")
        job = runs.submit_staged(local,kind,body)
        if idx == "1":
            assert run_canvas_job(job.job_id).status == "done"
        else:
            pending = job.job_id
    reconcile_canvas_jobs(fail_pending=True)
    assert jobs.read_job(pending).status == "failed"
    runs.recover_staged_results()
    runs.recover_staged_results()
    assert len([c for c in list_canvas_projects() if c.name.endswith("未回传的生成结果")]) == 1
    assert len(jobs.list_usage_archive()) == 2
    assert not [j for j in jobs.list_jobs() if j.canvas_project_id and j.canvas_project_id.startswith("canvas-collab-")]


@pytest.mark.parametrize("fail_last", [False, True])
def test_recovery_keeps_every_successful_image_candidate_with_original_bytes(monkeypatch, fail_last):
    from character_workflow.lib import job_runner
    from character_workflow.lib.canvas_projects import list_canvas_projects
    from character_workflow.lib.canvas_runs import run_canvas_job
    from character_workflow.lib.keys import KeysDB, KeySpec, ModelSpec, write_keys_db

    pid = make_canvas("image")
    req = runs.GuestRequest(surface_node_id="n", expected_revision=1, alias="local",
                            model="gpt-image-1", prompt="恢复候选", requested_count=3)
    write_keys_db(KeysDB(keys=[KeySpec(alias="local", provider="openai", created_at=NOW, access_key="test",
        models=[ModelSpec(id=req.model, name="测试", modality="image")])]))
    originals = []

    def render(**kwargs):
        if fail_last and len(originals) == 2:
            raise RuntimeError("本地模拟失败")
        path = kwargs["output_dir"] / "candidate.png"
        originals.append(png((len(originals) * 70, 42, 1)))
        path.write_bytes(originals[-1])
        return [str(path)]

    monkeypatch.setattr(job_runner, "dispatch", render)
    local, kind = runs.stage_generation("run-" + "f" * 24, read_canvas_document(pid), "共享", req, lambda *_: b"")
    done = run_canvas_job(runs.submit_staged(local, kind, req).job_id)
    assert done.status == ("partial" if fail_last else "done")
    if fail_last:
        from character_workflow.lib import canvas_paste
        from character_workflow.lib.schemas import CanvasTextNode

        def interrupted(**kwargs):
            raise OSError("模拟首次复制中断")

        with monkeypatch.context() as transient:
            transient.setattr(canvas_paste, "paste_from_document", interrupted)
            with pytest.raises(OSError, match="中断"):
                runs.preserve_stage(done)
        target, = [c.project_id for c in list_canvas_projects() if c.name.endswith("未回传的生成结果")]
        current = read_canvas_document(target)
        current.nodes.append(CanvasTextNode(type="text", id="note", title="访客笔记", position={"x": 0, "y": 500}, data={}))
        save_canvas_document(target, current, current.revision)
    target = runs.preserve_stage(done)
    runs.recover_staged_results()
    runs.recover_staged_results()
    assert [c.project_id for c in list_canvas_projects() if c.name.endswith("未回传的生成结果")] == [target]
    recovered = read_canvas_document(target)
    if fail_last:
        assert any(node.id == "note" for node in recovered.nodes)
    cover, = [node for node in recovered.nodes if node.type == "image" and node.data.result_stack]
    members = {node.id: node for node in recovered.nodes}
    ids = [cover.id, *cover.data.result_stack.member_node_ids]
    saved = [resolve_canvas_media(target, members[key].data.current_version_id) for key in ids]
    assert [path.read_bytes() for path, _ in saved] == originals
    assert all(version.frozen_generation.prompt == req.prompt for _, version in saved)


def test_collab_audio_output_sniffs_flac_and_opus():
    for magic, mime in [(b"OggS", "audio/ogg"),(b"fLaC","audio/flac")]:
        pid = make_canvas("audio")
        run_id = reserve(pid,"audio")["collab_run_id"]
        body = magic + b"test" * 100
        snapshot = CanvasFrozenGeneration(source_kind="canvas", mode="audio", model_id="tts", provider="openai")
        result = runs.commit(pid,run_id,runs.Outputs(snapshot=snapshot,media_count=1),[body],auth)
        node = next(n for n in read_canvas_document(pid).nodes if n.id == result["node_id"])
        path,version = resolve_canvas_media(pid,node.data.current_version_id)
        assert path.read_bytes() == body and version.mime_type == mime
