from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib import collab_config
from character_workflow.lib.canvas_projects import create_canvas_project, read_canvas_document, resolve_canvas_media
from character_workflow.lib.canvas_reproduce import reproduce_frozen_version
from character_workflow.lib.canvas_runs import submit_canvas_run
from character_workflow.lib.collab_provenance import build_frozen_from_job, studio_output_snapshot
from character_workflow.lib.jobs import read_job
from character_workflow.lib.keys import KeysDB, KeySpec, ModelSpec, write_keys_db
from character_workflow.lib.schemas import CanvasPoint, JobKind
from tests.test_generation_recipe import MP4, NOW, VIDEO_MODEL, _studio_job, _upload, png
from viewer_server.collab_app import create_collab_app


def test_ingest_snapshot_and_reproduce_with_local_inputs(isolated_data_root):
    original_ref = _upload(isolated_data_root, "input.png", png((20, 80, 10)))
    job = _studio_job(png((10, 20, 30)), {"reference_images": [str(original_ref)], "quality": "high"})
    output, snapshot, refs = studio_output_snapshot(job, 0)
    pid = create_canvas_project("房主画布").project_id
    collab_config.enable_share(pid, collab_config.ShareSettings())
    root = f"/collab/v1/projects/{pid}"
    with TestClient(create_collab_app(), base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        token = client.post(root + "/auth", json={"display_name": "林"}).json()["collab_token"]
        headers = {"authorization": "Bearer " + token}
        files = {name: ("media", path.read_bytes()) for name, path in {"output": output, **refs}.items()}
        data = {"snapshot": snapshot.model_dump_json()}
        broken = client.post(root + "/ingest-node", headers=headers, data=data, files={"output": files["output"]})
        assert broken.status_code == 422
        assert read_canvas_document(pid).revision == 0
        result = client.post(root + "/ingest-node", headers=headers, data=data, files=files)
        assert result.status_code == 200, result.text
        collab_config.enable_share(pid, collab_config.ShareSettings(mode="view"))
        assert client.post(root + "/ingest-node", headers=headers, data=data, files=files).status_code == 403
    doc = read_canvas_document(pid)
    node, = doc.nodes
    assert node.created_by == "林" and doc.revision == 1
    version = doc.content_versions[node.data.current_version_id]
    ref_id = version.frozen_generation.inputs[0].version_id
    assert ref_id not in refs
    Path(job.output_paths[0]).unlink()
    original_ref.unlink()
    assert resolve_canvas_media(pid, ref_id)[0].read_bytes() == png((20, 80, 10))
    copied = reproduce_frozen_version(pid, version.version_id, CanvasPoint(x=50, y=0), None, None, 1)
    assert len(copied.nodes) == 3
    assert copied.nodes[-1].data.generation_draft.model == ""
    assert copied.nodes[-1].data.generation_draft.params.quality == "high"
    assert copied.connections[0].source_node_id == copied.nodes[-2].id


def _replay_studio_output(original, model, provider):
    output, frozen, refs = studio_output_snapshot(original, 0)
    pid = create_canvas_project("复刻").project_id
    collab_config.enable_share(pid, collab_config.ShareSettings())
    root = f"/collab/v1/projects/{pid}"
    with TestClient(create_collab_app(), base_url="http://127.0.0.1",
                    client=("127.0.0.1", 50000)) as client:
        token = client.post(root + "/auth", json={"display_name": "测试"}).json()["collab_token"]
        files = {key: ("media", path.read_bytes()) for key, path in {"output": output, **refs}.items()}
        result = client.post(root + "/ingest-node", headers={"authorization": "Bearer " + token},
                             data={"snapshot": frozen.model_dump_json()}, files=files)
        assert result.status_code == 200, result.text
    doc = read_canvas_document(pid)
    source = doc.nodes[0].data.current_version_id
    write_keys_db(KeysDB(default_alias="local", keys=[KeySpec(
        alias="local", provider=provider, access_key="fixture", created_at=NOW, models=[model],
    )]))
    doc = reproduce_frozen_version(pid, source, CanvasPoint(x=0, y=0), "local", model.id, doc.revision)
    job, doc = submit_canvas_run(pid, doc.nodes[-1].id, doc.revision)
    return read_job(job.job_id), doc


def test_frozen_video_seed_reaches_seedance_request():
    from character_workflow.lib.callers.volcengine_video import _request_body

    original = _studio_job(MP4, {"seed": 0, "duration": 5})
    path = Path(original.output_paths[0]).rename(Path(original.output_paths[0]).with_suffix(".mp4"))
    original = original.model_copy(update={
        "kind": JobKind.VIDEO, "model": VIDEO_MODEL, "output_paths": [str(path)],
    })
    job, _ = _replay_studio_output(original, ModelSpec(
        id=VIDEO_MODEL, name="Seedance", modality="video", protocol="seedance",
    ), "openai")
    assert job.canvas_run.snapshot.normalized_params["seed"] == 0
    assert _request_body(job.prompt, job.model, job.params.model_dump(exclude_none=True))["seed"] == 0


@pytest.mark.parametrize(("version", "role"), [("6", "mj_cref"), ("7", "mj_oref")])
def test_frozen_mj_refs_reach_matching_provider_flags(isolated_data_root, monkeypatch, version, role):
    from character_workflow.lib.callers import mj_image

    roles = ["reference_images", "mj_sref", role]
    refs = {name: [_upload(isolated_data_root, f"{name}.png", png((i, 20, 30))).as_posix()]
            for i, name in enumerate(roles)}
    model = ModelSpec(name="Midjourney", id=f"midjourney-v{version}", modality="image")
    original = _studio_job(png((40, 50, 60)), {**refs, "mj_version": version}).model_copy(
        update={"model": model.id, "provider": "midjourney"})
    job, doc = _replay_studio_output(original, model, "midjourney")
    params = job.params.model_dump(exclude_none=True)
    for name in roles:
        replayed, = params[name]
        assert Path(replayed).read_bytes() == Path(refs[name][0]).read_bytes()
    assert [row.role for row in build_frozen_from_job(job, doc.project_id, document=doc).inputs] == [
        "reference", "mj_sref", role,
    ]
    monkeypatch.setattr(mj_image, "_public_url", lambda local: "https://media.example/" + Path(local).name)
    prompt = mj_image._append_flags(job.prompt, params)
    body = mj_image._submit_body(prompt, params)
    for name in ["mj_sref", role]:
        assert f"--{name[3:]} https://media.example/{Path(params[name][0]).name}" in body["prompt"]
    assert len(body["base64Array"]) == 1


def test_unsupported_fixed_video_seed_stops_before_provider(isolated_data_root, monkeypatch):
    from character_workflow.lib.callers import dispatch_video, video_registry

    model = ModelSpec(name="Kling", id="kling-v1", modality="video", protocol="kling")
    write_keys_db(KeysDB(default_alias="test", keys=[KeySpec(
        alias="test", provider="custom", access_key="fixture", created_at=NOW, models=[model],
    )]))
    adapter = video_registry.VideoAdapter("kling", "test", lambda **kw: pytest.fail("unexpected request"))
    monkeypatch.setitem(video_registry.VIDEO_ADAPTERS, "kling", adapter)
    with pytest.raises(ValueError, match="不支持固定种子"):
        dispatch_video(prompt="复刻", model=model.id, alias="test",
                       output_dir=isolated_data_root, params={"seed": 0})
