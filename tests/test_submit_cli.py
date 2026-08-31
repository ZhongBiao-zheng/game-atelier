"""The CLI freezes requests; only a human session can approve their provider execution."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from character_workflow.lib import jobs, keys, projects
from character_workflow.lib.character_derivatives import initialize_character_directory
from character_workflow.lib.workshop_generation import approve_generation


def _env(root):
    return {**os.environ, "GAME_ATELIER_DATA_ROOT": str(root),
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}


def _run(root, args):
    return subprocess.run([sys.executable, "-m", "character_workflow", *args],
        cwd=Path(__file__).resolve().parents[1], env=_env(root), capture_output=True,
        text=True, encoding="utf-8")


@pytest.fixture
def workspace(tmp_path):
    with patch.dict(os.environ, {"GAME_ATELIER_DATA_ROOT": str(tmp_path)}):
        project = projects.create_project("CLI 回归")
        initialize_character_directory("holy", "# 圣灵祭祀")
        projects.assign_character("holy", project.id)
        keys.write_keys_db(keys.KeysDB(default_alias="default", keys=[keys.KeySpec(
            alias="default", provider="custom", access_key="test-only", modalities=["image"],
            capabilities=["portrait", "promo", "turnaround"], models=[keys.ModelSpec(
                id="gpt-image-2", name="GPT Image", modality="image")], created_at="test")]))
    (tmp_path / "prompt.md").write_text("中文 prompt 全文", encoding="utf-8")
    return tmp_path


def _submit(root, *extra, kind="portrait", character=True):
    args = ["submit", "--kind", kind, "--prompt-file", str(root / "prompt.md")]
    return _run(root, [*args, *(["--character", "holy"] if character else []), *extra])


def _record(root, result):
    assert result.returncode == 0, result.stderr
    view = json.loads(result.stdout)
    path = root / ".runtime" / "workshop" / "requests" / f"{view['request_id']}.json"
    return view, json.loads(path.read_text(encoding="utf-8"))


def _reference(root, name):
    path = root / "characters" / "holy" / "source" / name
    path.write_bytes(b"test reference")
    return path


def test_submit_portrait_default_values(workspace):
    view, record = _record(workspace, _submit(workspace))
    assert re.fullmatch(r"wr-[a-f0-9]{40}", view["request_id"])
    assert view["state"] == "awaiting_approval" and view["job_id"] is None
    assert view["target"]["asset_slot"] == "portrait" and view["target"]["character_id"] == "holy"
    assert view["model"] == "gpt-image-2" and view["alias"] == "default" and view["provider"] == "custom"
    assert view["params"]["n"] == 1 and view["params"]["size"] == "1024x1536"
    assert record["frozen_params"]["reference_images"] == []
    assert not list((workspace / ".runtime" / "jobs").glob("*.json"))


def test_submit_promo_with_source_image(workspace):
    source = _reference(workspace, "source.png")
    view, record = _record(workspace, _submit(workspace, "--source-image", str(source), kind="promo"))
    assert view["target"]["asset_slot"] == "promo"
    assert Path(record["frozen_params"]["reference_images"][0]).read_bytes() == source.read_bytes()


def test_submit_turnaround_kind(workspace):
    assert _record(workspace, _submit(workspace, kind="turnaround"))[0]["target"]["asset_slot"] == "turnaround"


def test_submit_n4_explicit(workspace):
    assert _record(workspace, _submit(workspace, "--n", "4"))[0]["params"]["n"] == 4


def test_submit_falls_back_to_active_character(workspace):
    (workspace / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00Z"}), encoding="utf-8")
    assert _record(workspace, _submit(workspace, character=False))[0]["target"]["character_id"] == "holy"


def test_submit_missing_character_and_active(workspace):
    result = _submit(workspace, character=False)
    assert result.returncode != 0 and not result.stdout.strip()
    assert "character" in result.stderr or "active" in result.stderr


def test_submit_missing_prompt_file(workspace):
    result = _run(workspace, ["submit", "--kind", "portrait", "--character", "holy",
                              "--prompt-file", str(workspace / "missing.md")])
    assert result.returncode != 0 and not result.stdout.strip() and "prompt" in result.stderr


def test_submit_stdout_is_single_json_request(workspace):
    result = _submit(workspace)
    assert result.returncode == 0 and "\n" not in result.stdout.rstrip("\n")
    assert json.loads(result.stdout)["state"] == "awaiting_approval"


def test_submit_size_explicit(workspace):
    assert _record(workspace, _submit(workspace, "--size", "2048x2048"))[0]["params"]["size"] == "2048x2048"


def test_submit_model_explicit(workspace):
    with patch.dict(os.environ, {"GAME_ATELIER_DATA_ROOT": str(workspace)}):
        keys.patch_key("default", {"models": [keys.ModelSpec(id="custom_model", name="Explicit")]})
    assert _record(workspace, _submit(workspace, "--model", "custom_model"))[0]["model"] == "custom_model"


def test_submit_unconfigured_model_rejected(workspace):
    result = _submit(workspace, "--model", "unconfigured-model")
    assert result.returncode != 0 and "没有在本机配置" in result.stderr


def test_submit_alias_pins_non_default_key(workspace):
    with patch.dict(os.environ, {"GAME_ATELIER_DATA_ROOT": str(workspace)}):
        keys.add_key(keys.KeySpec(alias="nano", provider="custom", access_key="test-only",
            modalities=["image"], models=[keys.ModelSpec(id="nano-banana-x", name="Nano")], created_at="test"))
    view, _ = _record(workspace, _submit(workspace, "--alias", "nano", "--model", "nano-banana-x"))
    assert view["alias"] == "nano" and view["model"] == "nano-banana-x"


def test_submit_multiple_reference_images(workspace):
    first, second = _reference(workspace, "a.png"), _reference(workspace, "b.png")
    view, record = _record(workspace, _submit(workspace, "--reference-image", str(first), "--reference-image", str(second)))
    assert [item["title"] for item in view["references"]] == ["a.png", "b.png"]
    assert len(record["frozen_params"]["reference_images"]) == 2


def test_submit_source_image_merges_with_reference_images(workspace):
    source, other = _reference(workspace, "source.png"), _reference(workspace, "other.png")
    view, _ = _record(workspace, _submit(workspace, "--source-image", str(source),
        "--reference-image", str(other), "--reference-image", str(source), kind="promo"))
    assert [item["title"] for item in view["references"]] == ["source.png", "other.png"]


def test_submit_unregistered_reference_is_rejected(workspace):
    path = workspace / "not-registered.png"
    path.write_bytes(b"test")
    result = _submit(workspace, "--reference-image", str(path))
    assert result.returncode != 0 and "导入当前工坊目标" in result.stderr


def test_submit_prints_confirmation_link_and_frozen_card(workspace):
    result = _submit(workspace)
    view, _ = _record(workspace, result)
    assert view["approval_url"] in result.stderr and "本地工坊批准页" in result.stderr
    assert view["prompt"] == "中文 prompt 全文" and view["model"] == "gpt-image-2"
    assert view["params"]["size"] == "1024x1536" and str(workspace) not in result.stdout


def test_retry_job_requires_new_request_and_preserves_failed_job(workspace):
    view, _ = _record(workspace, _submit(workspace))
    with patch.dict(os.environ, {"GAME_ATELIER_DATA_ROOT": str(workspace)}):
        local = SimpleNamespace(kind="local", session_id="human", grant_id=None)
        approved = approve_generation(local, view["request_id"], 1, lambda *_: True)
        jobs.update_job_status(approved["job_id"], status=jobs.JobStatus.FAILED, error="network down")
        result = _run(workspace, ["retry-job", approved["job_id"]])
        assert result.returncode == 2 and "新建生成请求" in result.stderr
        assert jobs.read_job(approved["job_id"]).error == "network down" and len(jobs.list_jobs()) == 1


def test_retry_job_rejects_non_failed(workspace):
    with patch.dict(os.environ, {"GAME_ATELIER_DATA_ROOT": str(workspace)}):
        jobs.write_job(job_id="studio-pending", character_id="studio", prompt="x", model="m", params={}, namespace="studio")
    result = _run(workspace, ["retry-job", "studio-pending"])
    assert result.returncode == 2 and "not failed" in result.stderr


def test_retry_job_missing_job(workspace):
    result = _run(workspace, ["retry-job", "missing-job"])
    assert result.returncode == 2 and "不存在" in result.stderr


def test_submit_unknown_alias_fails(workspace):
    result = _submit(workspace, "--alias", "nope")
    assert result.returncode == 2 and "nope" in result.stderr


def test_submit_without_default_key_fails(workspace):
    with patch.dict(os.environ, {"GAME_ATELIER_DATA_ROOT": str(workspace)}):
        keys.write_keys_db(keys.KeysDB())
    result = _submit(workspace)
    assert result.returncode == 2 and "没有可用默认 Key" in result.stderr and not result.stdout.strip()
