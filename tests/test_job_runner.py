from __future__ import annotations

import json
import os
import struct
import zlib
from pathlib import Path

import pytest

from character_workflow.lib import job_runner
from character_workflow.lib.active_character import write_active
from character_workflow.lib.jobs import read_job, save_job, write_job
from character_workflow.lib.schemas import AssetSlot, Job, JobKind, JobParams, JobStatus


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    runtime = tmp_path / ".runtime"
    (runtime / "jobs").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "characters" / "holy" / "source").mkdir(parents=True)
    (tmp_path / "characters" / "holy" / "promo").mkdir()
    return tmp_path


def _write_png(path: Path, width: int = 2, height: int = 2) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + b"\xff\xff\xff" * width for _ in range(height))
    body = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(body)


def _write_jpeg_with_large_metadata(path: Path, width: int = 2048, height: int = 2048) -> None:
    app = b"\xff\xe1" + struct.pack(">H", 5002) + (b"x" * 5000)
    sof = (
        b"\xff\xc0"
        + struct.pack(">H", 17)
        + b"\x08"
        + struct.pack(">HH", height, width)
        + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
    )
    path.write_bytes(b"\xff\xd8" + app + sof + b"\xff\xd9")


def _add_stale_error(project_root: Path, job_id: str) -> None:
    path = project_root / ".runtime" / "jobs" / f"{job_id}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["error"] = "stale timeout"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def test_run_job_normalizes_refs_clears_error_and_skips_invalid_artifact(
    project, monkeypatch,
):
    src = project / "characters" / "holy" / "source" / "ref.png"
    _write_png(src)
    write_job(
        job_id="promo-001",
        character_id="holy",
        prompt="圣灵祭祀冒险启程 KV",
        model="generate_image_gpt_image_2",
        params={"size": "2048x1152", "n": 1, "reference_images": []},
        status=JobStatus.PENDING_CONFIRM,
        asset_slot=AssetSlot.PROMO,
        source_image=str(src),
        alias="oai",
    )
    _add_stale_error(project, "promo-001")

    captured: dict[str, object] = {}

    def fake_dispatch(*, prompt, model, alias, output_dir, n, size, params, **kw):
        captured.update({
            "prompt": prompt,
            "model": model,
            "alias": alias,
            "output_dir": Path(output_dir),
            "n": n,
            "size": size,
            "reference_images": list(params.get("reference_images") or []),
        })
        # First artifact is a zero-byte (invalid) file that must be skipped.
        bad = Path(output_dir) / "bad.png"
        bad.write_bytes(b"")
        good = Path(output_dir) / "good.png"
        _write_png(good, width=3, height=2)
        return [str(bad), str(good)]

    monkeypatch.setattr(job_runner, "dispatch", fake_dispatch)

    final = job_runner.run_job("promo-001")

    expected_path = project / "characters" / "holy" / "promo" / "v1.png"
    assert final.status == JobStatus.DONE
    assert final.error is None
    assert final.output_paths == [str(expected_path)]
    assert expected_path.exists()
    assert (expected_path.with_suffix(".md")).exists()
    params = final.params.model_dump()
    # source_image gets normalized into reference_images and forwarded to dispatch.
    assert params["reference_images"] == [str(src)]
    assert captured["reference_images"] == [str(src)]
    assert params["requested_size"] == "2048x1152"
    assert params["actual_size"] == "3x2"
    assert captured["alias"] == "oai"
    assert captured["size"] == "2048x1152"
    assert captured["output_dir"] != expected_path.parent
    assert read_job("promo-001").output_paths == [str(expected_path)]


def test_run_latest_uses_active_character_kind_and_newest_pending_job(project, monkeypatch):
    write_active("holy")
    write_job(
        job_id="portrait-001", character_id="holy", prompt="old",
        model="m", params={}, asset_slot=AssetSlot.PORTRAIT,
    )
    write_job(
        job_id="promo-001", character_id="holy", prompt="old",
        model="m", params={}, asset_slot=AssetSlot.PROMO,
    )
    write_job(
        job_id="promo-002", character_id="holy", prompt="new",
        model="m", params={}, asset_slot=AssetSlot.PROMO,
    )

    captured: list[str] = []

    def fake_run_job(job_id: str):
        captured.append(job_id)
        return read_job(job_id)

    monkeypatch.setattr(job_runner, "run_job", fake_run_job)

    selected = job_runner.run_latest(kind=AssetSlot.PROMO)

    assert selected.job_id == "promo-002"
    assert captured == ["promo-002"]


def test_run_job_routes_custom_provider_through_dispatch(project, monkeypatch):
    save_job(Job(
        job_id="studio-zz-001",
        character_id="zz-main",
        prompt="fox",
        submitted_at="2026-05-28T00:00:00+08:00",
        model="gpt-image-2-all",
        params=JobParams(size="2048x2048", n=1),
        output_paths=[],
        status=JobStatus.PENDING,
        error=None,
        asset_slot=AssetSlot.PORTRAIT,
        kind=JobKind.IMAGE,
        namespace="studio",
        alias="zz-main",
        provider="custom",
    ))

    captured: dict[str, object] = {}

    def fake_dispatch(*, prompt, model, alias, output_dir, n, size, params, **kw):
        captured.update({
            "prompt": prompt,
            "model": model,
            "alias": alias,
            "output_dir": Path(output_dir),
            "n": n,
            "size": size,
            "params": params,
        })
        out = Path(output_dir) / "v1.png"
        _write_png(out, width=5, height=4)
        return [str(out)]

    monkeypatch.setattr(job_runner, "dispatch", fake_dispatch)

    final = job_runner.run_job("studio-zz-001")

    expected = project / "studio" / "studio-zz-001" / "v1.png"
    assert final.status == JobStatus.DONE
    assert final.output_paths == [str(expected)]
    assert expected.exists()
    assert expected.with_suffix(".md").exists()
    assert final.params.actual_size == "5x4"
    assert captured["alias"] == "zz-main"
    assert captured["model"] == "gpt-image-2-all"
    assert captured["output_dir"] != expected.parent


def test_deferred_image_attempt_keeps_job_pending_and_appends_new_output(project, monkeypatch):
    existing = project / "studio" / "studio-batch" / "existing.png"
    existing.parent.mkdir(parents=True)
    _write_png(existing)
    save_job(Job(
        job_id="studio-batch",
        character_id="zz-main",
        prompt="fox",
        submitted_at="2026-05-28T00:00:00+08:00",
        model="gpt-image-2-all",
        params=JobParams(size="1024x1024", n=1),
        output_paths=[str(existing)],
        status=JobStatus.PENDING,
        error=None,
        asset_slot=AssetSlot.PORTRAIT,
        kind=JobKind.IMAGE,
        namespace="studio",
        alias="zz-main",
        provider="custom",
    ))

    def fake_dispatch(*, output_dir, **_kwargs):
        output = Path(output_dir) / "new.png"
        _write_png(output, width=4, height=3)
        return [str(output)]

    monkeypatch.setattr(job_runner, "dispatch", fake_dispatch)

    attempt = job_runner.run_job("studio-batch", defer_terminal=True)

    assert attempt.status == JobStatus.PENDING
    assert attempt.completed_at is None
    assert attempt.error is None
    assert attempt.output_paths[0] == str(existing)
    assert len(attempt.output_paths) == 2
    assert Path(attempt.output_paths[1]).is_file()


def test_valid_image_rejects_zero_byte(project):
    zero = project / "characters" / "holy" / "promo" / "lovart_empty.png"
    zero.write_bytes(b"")
    valid = project / "characters" / "holy" / "promo" / "v1.png"
    _write_png(valid)

    assert job_runner.is_valid_image(zero) is False
    assert job_runner.is_valid_image(valid) is True


def test_valid_image_accepts_jpeg_with_large_metadata(project):
    valid = project / "characters" / "holy" / "promo" / "seedream.jpg"
    _write_jpeg_with_large_metadata(valid)

    assert job_runner.image_dimensions(valid) == (2048, 2048)
    assert job_runner.is_valid_image(valid) is True


def _write_mp4(path: Path) -> None:
    # mp4 magic: "ftyp" 在偏移 4（不是字节 0）
    path.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 32)


def test_run_job_video_branch_writes_mp4_and_done(project, monkeypatch):
    from character_workflow.lib.schemas import JobKind
    write_job(
        job_id="vid-1", character_id="ark", prompt="a calm sea",
        model="doubao-seedance-2-0-fast-260128", params={"duration": 5, "frame_mode": "auto"},
        status=JobStatus.PENDING, alias="ark",
    )
    # video job 落 studio namespace；用 save_job 直接打 kind/namespace
    job = read_job("vid-1").model_copy(update={"kind": JobKind.VIDEO, "namespace": "studio"})
    save_job(job)

    def fake_dispatch_video(*, prompt, model, alias, output_dir, params=None, **kw):
        out = Path(output_dir) / "v1.mp4"
        _write_mp4(out)
        return [str(out)]

    monkeypatch.setattr(job_runner, "dispatch_video", fake_dispatch_video)
    result = job_runner.run_job("vid-1")
    assert result.status == JobStatus.DONE
    assert len(result.output_paths) == 1
    assert result.output_paths[0].endswith(".mp4")
    assert Path(result.output_paths[0]).exists()


def test_run_job_video_branch_writes_progress_phases(project, monkeypatch):
    """caller 的 on_phase 回调要把 sent/downloading 真实卡点写进 job 文件，终态清空。"""
    from character_workflow.lib.schemas import JobKind
    write_job(
        job_id="vid-phase", character_id="ark", prompt="a calm sea",
        model="doubao-seedance-2-0-fast-260128", params={"frame_mode": "auto"},
        status=JobStatus.PENDING, alias="ark",
    )
    job = read_job("vid-phase").model_copy(update={"kind": JobKind.VIDEO, "namespace": "studio"})
    save_job(job)

    observed: list[str | None] = []

    def fake_dispatch_video(*, prompt, model, alias, output_dir, params=None, on_phase=None, **kw):
        on_phase("sent")
        observed.append(read_job("vid-phase").progress_phase)
        on_phase("downloading")
        observed.append(read_job("vid-phase").progress_phase)
        out = Path(output_dir) / "v1.mp4"
        _write_mp4(out)
        return [str(out)]

    monkeypatch.setattr(job_runner, "dispatch_video", fake_dispatch_video)
    result = job_runner.run_job("vid-phase")
    assert observed == ["sent", "downloading"]
    # DONE 终态清空进度卡点
    assert result.status == JobStatus.DONE
    assert result.progress_phase is None


def test_is_valid_video_accepts_mp4_rejects_empty(project, tmp_path):
    good = tmp_path / "good.mp4"
    _write_mp4(good)
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"")
    assert job_runner.is_valid_video(good) is True
    assert job_runner.is_valid_video(bad) is False


def test_run_job_video_branch_marks_failed_on_no_valid_artifacts(project, monkeypatch):
    from character_workflow.lib.schemas import JobKind
    write_job(
        job_id="vid-bad", character_id="ark", prompt="x",
        model="doubao-seedance-2-0-fast-260128", params={"frame_mode": "auto"},
        status=JobStatus.PENDING, alias="ark",
    )
    job = read_job("vid-bad").model_copy(update={"kind": JobKind.VIDEO, "namespace": "studio"})
    save_job(job)

    # dispatch_video 返回空 → 无有效视频产物 → 必须落 FAILED 并抛 JobRunnerError。
    monkeypatch.setattr(job_runner, "dispatch_video", lambda **kw: [])

    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job("vid-bad")
    assert read_job("vid-bad").status == JobStatus.FAILED


# ---- _friendly_error 报错分类（图生图上传/网关掐断 实测挖出的两类误报修正）----

def test_friendly_error_write_timeout_reads_as_upload_not_upstream():
    # 实测：connect 超时兜不住 1.6MB 参考图上传 → 上传阶段 write 超时。
    # 旧版命中通用 timeout 分支报「上游过载」，误导；应识别为上传超时。
    err = Exception("('Connection aborted.', TimeoutError('The write operation timed out'))")
    msg = job_runner._friendly_error(err)
    assert "上传参考图超时" in msg
    assert "上游过载" not in msg


def test_friendly_error_remote_disconnect_reads_as_gateway_not_network():
    # 实测：上传过后网关等上游出图 ~136s 直接掐连接（RemoteDisconnected）。
    # 旧版「connection aborted」命中「网络连不上/检查代理」，把人往代理坑带；应识别为网关中途断开。
    err = Exception(
        "('Connection aborted.', RemoteDisconnected('Remote end closed connection without response'))"
    )
    msg = job_runner._friendly_error(err)
    assert "网关中途断开" in msg
    assert "网络连不上" not in msg
    assert "代理" not in msg


def test_friendly_error_genuine_connect_failure_still_network():
    err = Exception(
        "HTTPSConnectionPool(host='api.openai-hk.com', port=443): Max retries exceeded "
        "(Caused by NewConnectionError('Failed to establish a new connection: "
        "[Errno 61] Connection refused'))"
    )
    assert "网络连不上厂商接口" in job_runner._friendly_error(err)


def test_friendly_error_read_timeout_still_upstream_overload():
    err = Exception("HTTPSConnectionPool(host='api.openai-hk.com', port=443): Read timed out. (read timeout=180.0)")
    msg = job_runner._friendly_error(err)
    assert "厂商接口超时未响应" in msg
    assert "上传参考图" not in msg  # read 超时 ≠ 上传超时，别串台


def test_default_timeout_connect_covers_upload_phase():
    # 回归守卫：connect 超时兼管请求体上传阶段（urllib3 特性），压回 10s 会让大参考图图生图
    # 在上传阶段 write 超时。别再改回 10。
    from character_workflow.lib import net_env
    assert net_env.DEFAULT_TIMEOUT[0] >= 30


def test_default_timeout_read_has_headroom_over_generation():
    # 回归守卫：读超时须明显高于真实出图耗时（复杂生成 ~180s+）。若读超时 ≈ 生成耗时（旧 180s），
    # 首次请求会在响应到达前假超时 → _post_json 重试 → 再跑一次完整生成 → 墙钟翻倍 + 厂商双计费
    # （实测 180s→350s）。别再压回 180。
    from character_workflow.lib import net_env
    assert net_env.DEFAULT_TIMEOUT[1] >= 240


def test_direct_bypass_covers_tuzi(monkeypatch):
    # 回归守卫：tu-zi.com 必须在直连白名单——实测未放行时小火箭代理会 ProxyError 掐死 Tuzi 调用。
    from character_workflow.lib import net_env
    assert "tu-zi.com" in net_env.DIRECT_HOST_SUFFIXES
    monkeypatch.setenv("NO_PROXY", "localhost")
    net_env.configure_proxy_bypass()
    assert "tu-zi.com" in os.environ["NO_PROXY"]


def test_friendly_error_no_endpoints_reads_as_model_not_enabled_not_transient():
    # 实测（词元跳动 seedream-5.0-pro 打 OpenAI 兼容入口）：503 但错误体是确定性的
    # no_endpoints_available。旧版落到「网关瞬时超时…请稍后重试」，让画师白等。
    err = Exception(
        'image api 503: {"error":{"message":"模型 \'seedream-5.0-pro\' 下无可用端点",'
        '"code":"no_endpoints_available"}}'
    )
    msg = job_runner._friendly_error(err)
    assert "没有可用端点" in msg
    assert "未开通" in msg
    assert "瞬时" not in msg


def test_friendly_error_pixel_floor_tells_user_to_enlarge():
    err = Exception(
        'image api 400: {"error":{"message":"The parameter `size` specified in the request '
        'is not valid: image size must be at least 3686400 pixels."}}'
    )
    msg = job_runner._friendly_error(err)
    assert "像素下限" in msg
    assert "尺寸调大" in msg


def test_friendly_error_timeout_warns_about_probable_billing():
    """读超时 = 上游多半仍在出图且已计费；旧文案「稍后重试」等于引导再买一次。"""
    err = Exception("HTTPSConnectionPool(host='api.tu-zi.com', port=443): Read timed out.")
    msg = job_runner._friendly_error(err)
    assert "已经计费" in msg
    assert "确认" in msg


def test_friendly_error_no_image_response_is_not_a_network_problem():
    """实测 HK nano-banana-hd：跑满 28s 回 NO_IMAGE，有响应没图。"""
    err = Exception(
        "image api returned no downloadable image: {'data': [{'revised_prompt': 'NO_IMAGE'}]}"
    )
    msg = job_runner._friendly_error(err)
    assert "没有图片" in msg
    assert "内容审核" in msg


def test_friendly_error_never_swallows_task_id():
    """视频侧把 task_id 挂在报错里（产物已计费、要靠它人工找回）。

    翻译分支一旦整条替换，这个标识就没了 —— 而厂商原文里恰好常含 timeout / quota
    这类会命中翻译表的词。原文必须始终保留。
    """
    err = Exception(
        "seedance 任务轮询放弃 task_id=cgt-2026-abc123：connection reset by peer"
    )
    msg = job_runner._friendly_error(err)
    assert "cgt-2026-abc123" in msg


def test_friendly_error_passes_unknown_errors_through():
    err = Exception("something nobody has a translation for")
    assert job_runner._friendly_error(err) == "something nobody has a translation for"
