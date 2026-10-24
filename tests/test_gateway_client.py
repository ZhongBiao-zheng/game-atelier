"""局域网 Atelier 接入端（ADR-0025）：经真实网关服务（只绑回环）提交 / 轮询 / 下载、恢复、失败切换。

同一个 data root 同时扮演网关和接入端：网关跳过 provider=atelier 的成员，所以不会转发给自己。
上游厂商用假的 openai_image.render 代替，不发任何外部请求。
"""
from __future__ import annotations

import socket
import struct
import time
import zlib
from pathlib import Path

import pytest

from character_workflow.lib import gateway_keys, job_runner, keys, model_routes
from character_workflow.lib.callers import atelier_gateway, openai_image
from character_workflow.lib.callers.openai_image import OpenAIImageError
from character_workflow.lib.jobs import read_job, save_job
from character_workflow.lib.schemas import AssetSlot, Job, JobKind, JobParams, JobStatus
from viewer_server.gateway_app import GatewayServer


def _png(path: Path) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(
            ">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + b"\xff\xff\xff" * 2 for _ in range(2))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    model_routes._cooldowns.clear()
    monkeypatch.setattr(atelier_gateway, "POLL_INTERVAL_SECONDS", 0.05)
    yield
    model_routes._cooldowns.clear()


@pytest.fixture
def upstream(monkeypatch):
    """网关那边的厂商：按别名记录调用，可指定某家失败。"""
    state = {"calls": [], "fail": {}}

    def fake_render(*, alias, output_dir, params, **_kwargs):
        state["calls"].append({"alias": alias, "params": dict(params)})
        if alias in state["fail"]:
            raise state["fail"][alias]
        out = Path(output_dir) / "up.png"
        _png(out)
        return [str(out)]

    monkeypatch.setattr(openai_image, "render", fake_render)
    return state


def _add(alias: str, provider: str, model: keys.ModelSpec, **extra) -> None:
    keys.add_key(keys.KeySpec(alias=alias, provider=provider, access_key=extra.pop("token", "test-only"),
                              modalities=["image"], models=[model], created_at="test", **extra))


@pytest.fixture
def gateway(isolated_data_root, upstream):
    _add("Local", "openai", keys.ModelSpec(id="gpt-image-2", name="gpt-image-2", modality="image"))
    _record, token = gateway_keys.create_key("小王", None)
    port = _free_port()
    server = GatewayServer(host="127.0.0.1")
    server.start(port)
    base = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            atelier_gateway.check_gateway(base, token)
            break
        except Exception:  # noqa: BLE001 — 等服务起来
            time.sleep(0.1)
    routes = atelier_gateway.check_gateway(base, token)["models"]
    via_model = atelier_gateway.gateway_models(routes)[0]
    _add("Hub", "atelier", via_model, base_url=base, token=token)
    model_routes.put_alias_first("Hub")
    yield {"base": base, "token": token, "server": server}
    server.stop()


def _job(job_id: str, alias: str = "Hub", route_id: str | None = "gpt-image-2", **params) -> Job:
    return save_job(Job(
        job_id=job_id, character_id="A", prompt="一只猫", submitted_at="2026-10-16T00:00:00+00:00",
        model="gpt-image-2", params=JobParams(n=1, route_id=route_id, **params), output_paths=[],
        status=JobStatus.PENDING, error=None, asset_slot=AssetSlot.PORTRAIT, kind=JobKind.IMAGE,
        namespace="studio", alias=alias, provider="atelier" if alias == "Hub" else "openai",
    ))


def test_models_carry_the_gateway_members_and_hub_goes_first(gateway):
    hub = keys.find_by_alias("Hub")
    assert [(m.id, [v.alias for v in m.via]) for m in hub.models] == [("gpt-image-2", ["Local"])]
    assert "test-only" not in hub.model_dump_json()
    route = model_routes.find_route("image", "gpt-image-2")
    assert [m.alias for m in route.members] == ["Hub", "Local"]


def test_job_runs_through_the_gateway(gateway, upstream):
    done = job_runner.run_job(_job("job-gw").job_id)

    assert done.status == JobStatus.DONE and done.alias == "Hub"
    assert [c["alias"] for c in upstream["calls"]] == ["Local"]
    assert done.params.provider_task_protocol == "atelier_gateway"
    assert len(done.params.provider_task_ids) == 1
    assert done.params.gateway_member == "Local"
    assert Path(done.output_paths[0]).read_bytes().startswith(b"\x89PNG")


def test_reference_images_are_uploaded_not_sent_as_paths(gateway, upstream, tmp_path):
    ref = tmp_path / "ref.png"
    _png(ref)
    job_runner.run_job(_job("job-ref", reference_images=[str(ref)]).job_id)
    sent = upstream["calls"][0]["params"]["reference_images"]
    assert sent[0] != str(ref) and Path(sent[0]).read_bytes() == ref.read_bytes()


def test_resume_only_polls_the_existing_task(gateway, upstream):
    job_runner.run_job(_job("job-first").job_id)
    task_id = read_job("job-first").params.provider_task_ids[0]
    resumed = _job("job-resume", provider_task_protocol="atelier_gateway",
                   provider_task_ids=[task_id])

    done = job_runner.run_job(resumed.job_id)

    assert done.status == JobStatus.DONE
    assert len(upstream["calls"]) == 1  # 没有再提交第二次


def test_unreachable_gateway_switches_to_the_local_key(gateway, upstream):
    gateway["server"].stop()
    done = job_runner.run_job(_job("job-down").job_id)
    assert (done.status, done.alias, done.params.route_tried) == (JobStatus.DONE, "Local", ["Hub"])
    assert done.params.warnings == ["Hub连不上，已改用 Local"]


def test_gateway_quota_switches_to_the_local_key(gateway, upstream):
    record = gateway_keys.read_config().keys[0]
    gateway_keys.update_key(record.id, limits=[{"period": "day", "cap_cny": 0.01}])
    keys.patch_key("Local", {"base_url": "https://api.openai-hk.com"})
    done = job_runner.run_job(_job("job-quota").job_id)
    assert (done.status, done.alias) == (JobStatus.DONE, "Local")
    assert done.params.warnings == ["Hub限流，已改用 Local"]


def test_revoked_key_switches_to_the_local_key(gateway, upstream):
    gateway_keys.revoke_key(gateway_keys.read_config().keys[0].id)
    done = job_runner.run_job(_job("job-revoked").job_id)
    assert (done.status, done.alias) == (JobStatus.DONE, "Local")


def test_upstream_failure_that_may_have_run_is_not_switched(gateway, upstream):
    upstream["fail"]["Local"] = OpenAIImageError("image api 504: gateway timeout")
    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job(_job("job-504").job_id)
    failed = read_job("job-504")
    assert (failed.status, failed.alias) == (JobStatus.FAILED, "Hub")
    assert len(upstream["calls"]) == 1


@pytest.mark.parametrize(("status", "reason"), [
    ({"status": "failed", "error_kind": "unavailable", "error": "都不可用"}, "unavailable"),
    ({"status": "failed", "error_kind": "unconfirmed", "error": "网关重启，未确认是否已出图"}, None),
    ({"status": "failed", "error_kind": "failed", "error": "内容审核未通过"}, None),
])
def test_task_errors_map_onto_failover_rules(status, reason):
    assert model_routes.failover_reason(atelier_gateway._task_error(status)) == reason


def test_size_is_normalized_for_the_gateway_member(isolated_data_root):
    from character_workflow.lib.image_size import normalize_image_size_params

    via = keys.ViaMember(alias="OR", provider="openrouter", base_url=None,
                         model_id="openai/gpt-image-2", name="gpt-image-2")
    hub = keys.KeySpec(alias="Hub", provider="atelier", base_url="http://192.0.2.1:5180",
                       access_key="atg_x", created_at="test",
                       models=[keys.ModelSpec(id="gpt-image-2", name="gpt-image-2",
                                              modality="image", via=[via])])
    channel_key, channel_model = keys.size_channel(hub, hub.models[0])
    assert (channel_key.provider, channel_model.id) == ("openrouter", "openai/gpt-image-2")
    params = normalize_image_size_params(hub, "gpt-image-2", {"size_mode": "ratio", "ratio": "1:1"})
    direct = normalize_image_size_params(channel_key, channel_model.id,
                                         {"size_mode": "ratio", "ratio": "1:1"})
    assert params == direct


def test_edit_downloads_process_inputs(gateway, monkeypatch, tmp_path):
    from character_workflow.lib.callers import image_edit

    def render(*, params, output_dir, **kwargs):
        assert params["image_edit"] == {"mode": "inpaint", "x": 0, "y": 0}
        assert Path(params["mask_image"]).is_file()
        out, guide = output_dir / "out.png", output_dir / "guide.png"
        _png(out)
        _png(guide)
        params["edit_inputs"] = [{"role": "guide", "path": str(guide)}]
        return [str(out)]

    monkeypatch.setattr(image_edit, "render", render)
    source = tmp_path / "source.png"
    _png(source)
    params = dict(reference_images=[str(source)], mask_image=str(source),
                  image_edit={"mode": "inpaint", "source_version_id": "local-only"})
    outputs = atelier_gateway.render_edit(prompt="edit", model="gpt-image-2", alias="Hub",
                                          output_dir=tmp_path / "download", params=params)
    assert Path(outputs[0]).is_file()
    assert params["edit_inputs"][0]["role"] == "guide"
    assert Path(params["edit_inputs"][0]["path"]).parent == tmp_path / "download/edit-inputs"
    assert Path(params["edit_inputs"][0]["path"]).read_bytes() == source.read_bytes()


def test_video_sync_groups_with_local_and_job_restart_only_polls(gateway, monkeypatch):
    from character_workflow.lib import callers, gateway_tasks
    from character_workflow.lib.jobs import fail_orphan_studio_jobs, resumable_studio_jobs

    local = keys.ModelSpec(id="seedance-test", name="Video", modality="video", protocol="seedance")
    _add("Video", "seedream", local)
    atelier_gateway.sync_gateway_key("Hub")
    model = next(m for m in keys.find_by_alias("Hub").models if m.modality == "video")
    assert model.protocol == "seedance"
    routes = model_routes.list_routes("video")
    assert len(routes) == 1
    assert {m.alias for m in routes[0].members} == {"Video", "Hub"}
    calls = []
    original = callers.dispatch_video

    def render(**kwargs):
        if kwargs["alias"] == "Hub":
            return original(**kwargs)
        calls.append(kwargs)
        assert kwargs["params"]["n"] == 2
        kwargs["on_task_id"]("upstream-private-id")
        out = kwargs["output_dir"] / "video.mp4"
        out.write_bytes(b"\x00\x00\x00\x18ftypisom")
        return [str(out)]

    monkeypatch.setattr(callers, "dispatch_video", render)
    first = _job("video-first", route_id=routes[0].id).model_copy(update={
        "model": model.id, "kind": JobKind.VIDEO,
        "params": JobParams(n=2, route_id=routes[0].id),
    })
    save_job(first)
    done = job_runner.run_job(first.job_id)
    assert done.status == JobStatus.DONE
    assert done.params.provider_task_protocol == "atelier_gateway"
    assert done.params.provider_task_ids != ["upstream-private-id"]
    task = gateway_tasks._read(done.params.provider_task_ids[0])
    assert task.upstream_task_ids == ["upstream-private-id"]
    resumed = done.model_copy(update={"job_id": "video-resume", "status": JobStatus.PENDING,
                                     "output_paths": [], "runner_started_at": None})
    save_job(resumed)
    assert resumed.job_id in resumable_studio_jobs()
    assert resumed.job_id not in fail_orphan_studio_jobs()
    again = job_runner.run_job(resumed.job_id)
    assert again.status == JobStatus.DONE
    assert len(calls) == 1


def test_audio_job_and_canvas_capability_use_gateway(gateway, monkeypatch):
    from character_workflow.lib.callers import openai_audio
    from character_workflow.lib.canvas_runs import _supports_openai_speech

    _add("Speech", "openai", keys.ModelSpec(id="tts-1", name="Speech", modality="audio"))
    atelier_gateway.sync_gateway_key("Hub")
    key = keys.find_by_alias("Hub")
    model = next(m for m in key.models if m.modality == "audio")
    assert _supports_openai_speech(key, model)

    def render(*, output_dir, params, **kwargs):
        assert params["voice"] == "alloy"
        out = output_dir / "speech.mp3"
        out.write_bytes(b"ID3audio")
        return [str(out)]
    monkeypatch.setattr(openai_audio, "render", render)
    job = _job("audio", route_id="tts-1", voice="alloy").model_copy(update={
        "model": "tts-1", "kind": JobKind.AUDIO,
    })
    save_job(job)
    done = job_runner.run_job(job.job_id)
    assert done.status == JobStatus.DONE
    assert done.params.provider_task_protocol == "atelier_gateway"
    assert Path(done.output_paths[0]).read_bytes() == b"ID3audio"
