from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path

import pytest

from character_workflow.lib import job_runner
from character_workflow.lib.callers import lovart as lc
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


def test_run_job_normalizes_refs_clears_error_and_selects_valid_new_artifact(
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
        seed=None,
        status=JobStatus.PENDING_CONFIRM,
        asset_slot=AssetSlot.PROMO,
        source_image=str(src),
    )
    _add_stale_error(project, "promo-001")

    captured: dict[str, object] = {}

    def fake_upload(paths):
        captured["uploaded"] = paths
        return ["https://assets.lovart.ai/ref.png"]

    def fake_submit(*, prompt, model, output_dir, n, attachments=None, timeout=600.0):
        captured["submit"] = {
            "prompt": prompt,
            "model": model,
            "output_dir": Path(output_dir),
            "n": n,
            "attachments": attachments,
        }
        old = Path(output_dir) / "old.png"
        old.write_bytes(b"")
        new = Path(output_dir) / "new.png"
        _write_png(new, width=3, height=2)
        return lc.LovartResult(
            output_paths=[str(old), str(new)],
            raw_json={
                "thread_id": "thread-001",
                "final_status": "timeout",
                "downloaded": [
                    {"type": "image", "local_path": str(old), "new": False},
                    {"type": "image", "local_path": str(new), "new": True},
                ],
            },
        )

    monkeypatch.setattr(job_runner.lovart_caller, "upload_files", fake_upload)
    monkeypatch.setattr(job_runner.lovart_caller, "submit_and_wait", fake_submit)

    final = job_runner.run_job("promo-001")

    expected_path = project / "characters" / "holy" / "promo" / "v1.png"
    assert final.status == JobStatus.DONE
    assert final.error is None
    assert final.output_paths == [str(expected_path)]
    assert expected_path.exists()
    assert (expected_path.with_suffix(".md")).exists()
    params = final.params.model_dump()
    assert params["reference_images"] == [str(src)]
    assert params["lovart_attachments"] == ["https://assets.lovart.ai/ref.png"]
    assert params["lovart_thread_id"] == "thread-001"
    assert params["lovart_final_status"] == "timeout"
    assert params["requested_size"] == "2048x1152"
    assert params["actual_size"] == "3x2"
    assert "valid artifact selected" in params["warnings"][0]
    assert captured["uploaded"] == [str(src)]
    assert captured["submit"]["attachments"] == ["https://assets.lovart.ai/ref.png"]
    assert captured["submit"]["output_dir"] != expected_path.parent
    assert read_job("promo-001").output_paths == [str(expected_path)]


def test_run_latest_uses_active_character_kind_and_newest_pending_job(project, monkeypatch):
    write_active("holy")
    write_job(
        job_id="portrait-001", character_id="holy", prompt="old",
        model="m", params={}, seed=None, asset_slot=AssetSlot.PORTRAIT,
    )
    write_job(
        job_id="promo-001", character_id="holy", prompt="old",
        model="m", params={}, seed=None, asset_slot=AssetSlot.PROMO,
    )
    write_job(
        job_id="promo-002", character_id="holy", prompt="new",
        model="m", params={}, seed=None, asset_slot=AssetSlot.PROMO,
    )

    captured: list[str] = []

    def fake_run_job(job_id: str):
        captured.append(job_id)
        return read_job(job_id)

    monkeypatch.setattr(job_runner, "run_job", fake_run_job)

    selected = job_runner.run_latest(kind=AssetSlot.PROMO)

    assert selected.job_id == "promo-002"
    assert captured == ["promo-002"]


def test_run_job_routes_custom_t8star_provider_through_dispatch(project, monkeypatch):
    save_job(Job(
        job_id="studio-zz-001",
        character_id="zz-main",
        prompt="fox",
        submitted_at="2026-05-28T00:00:00+08:00",
        model="gpt-image-2-all",
        params=JobParams(size="2048x2048", n=1),
        seed=None,
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

    def fake_dispatch(*, prompt, model, alias, output_dir, n, size, params):
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
