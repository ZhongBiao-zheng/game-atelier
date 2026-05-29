"""submit CLI 子命令测试 — PENDING_CONFIRM 默认值集中点。

覆盖：
- portrait / promo / turnaround 三种 kind 落盘正确
- stdout 是纯 job_id（无前缀 / 无颜色码 / 单行）
- 缺 --character 且 active-character.json 不存在 → exit !=0
- --prompt-file 指向不存在文件 → exit !=0
- --character 显式传 / fallback 到 active-character.json
- 默认值（model / n / size / seed / status / job_id 格式）
"""
from __future__ import annotations

import json
import re
import subprocess
import sys


def _run(args, cwd, env=None):
    """直接调 python -m character_workflow，捕获 stdout/stderr/exit。"""
    cmd = [sys.executable, "-m", "character_workflow", *args]
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)


def _make_env(tmp_path, monkeypatch_env=None):
    import os
    from pathlib import Path
    env = os.environ.copy()
    env["CHARACTER_WORKFLOW_DATA_ROOT"] = str(tmp_path)
    # active_character.py still reads RUNTIME_DIR until it is migrated
    env["RUNTIME_DIR"] = str(tmp_path / ".runtime")
    # Ensure src/ is on PYTHONPATH so subprocesses can find character_workflow
    src_dir = str(Path(__file__).resolve().parent.parent / "src")
    env["PYTHONPATH"] = f"{src_dir}{os.pathsep}{env.get('PYTHONPATH', '')}"
    if monkeypatch_env:
        env.update(monkeypatch_env)
    return env


def _project_root() -> str:
    """子进程要在仓库根跑，否则找不到包。"""
    from pathlib import Path
    return str(Path(__file__).resolve().parent.parent)


def _write_default_key(tmp_path, *, alias="default", model="gpt-image-2", kind="portrait"):
    config = tmp_path / ".config"
    config.mkdir(parents=True, exist_ok=True)
    (config / "keys.json").write_text(
        json.dumps({
            "version": 1,
            "default_alias": alias,
            "keys": [{
                "alias": alias,
                "provider": "custom",
                "base_url": "https://api.example.test",
                "access_key": "ak-test",
                "secret_key": None,
                "capabilities": [kind],
                "models": [{"name": model, "id": model}],
                "homepage_url": None,
                "docs_url": None,
                "api_key_url": None,
                "modalities": ["image"],
                "routing_scope": "general",
                "routing_category": None,
                "routing_hints": [],
                "notes": "",
                "created_at": "2026-05-29T00:00:00+00:00",
            }],
        }),
        encoding="utf-8",
    )


def test_submit_portrait_default_values(tmp_path):
    """portrait + 默认值：落盘 status=PENDING_CONFIRM，kind=portrait，
    params.n=1，params.size=1024x1536，model 来自默认 API Key。"""
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("中文 prompt", encoding="utf-8")
    _write_default_key(tmp_path)

    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--prompt-file", str(prompt_file)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0, f"stderr={r.stderr}"
    job_id = r.stdout.strip()
    assert re.fullmatch(r"job-\d{14}[0-9a-f]{8}", job_id), f"job_id 格式不对: {job_id!r}"
    assert "\n" not in r.stdout.rstrip("\n")  # 只有一行

    # 落盘核对
    job_path = tmp_path / ".runtime" / "jobs" / f"{job_id}.json"
    assert job_path.exists()
    data = json.loads(job_path.read_text(encoding="utf-8"))
    assert data["status"] == "pending_confirm"
    assert data["asset_slot"] == "portrait"
    assert data["character_id"] == "holy"
    assert data["prompt"] == "中文 prompt"
    assert data["model"] == "gpt-image-2"
    assert data["alias"] == "default"
    assert data["provider"] == "custom"
    assert data["params"]["vendor"] == "default (custom)"
    assert data["params"]["n"] == 1
    assert data["params"]["size"] == "1024x1536"
    assert data["seed"] is None
    assert data["output_paths"] == []
    assert data["source_image"] is None


def test_submit_promo_with_source_image(tmp_path):
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("promo prompt", encoding="utf-8")
    src = tmp_path / "src.png"
    src.write_bytes(b"fake")
    _write_default_key(tmp_path, kind="promo")

    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "promo", "--character", "holy",
         "--prompt-file", str(prompt_file), "--source-image", str(src)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0, f"stderr={r.stderr}"
    job_id = r.stdout.strip()
    data = json.loads(
        (tmp_path / ".runtime" / "jobs" / f"{job_id}.json").read_text(encoding="utf-8")
    )
    assert data["asset_slot"] == "promo"
    assert data["source_image"] == str(src)
    assert data["params"]["reference_images"] == [str(src)]


def test_submit_turnaround_kind(tmp_path):
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("turnaround prompt", encoding="utf-8")
    _write_default_key(tmp_path, kind="turnaround")

    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "turnaround", "--character", "holy",
         "--prompt-file", str(prompt_file)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0, f"stderr={r.stderr}"
    job_id = r.stdout.strip()
    data = json.loads(
        (tmp_path / ".runtime" / "jobs" / f"{job_id}.json").read_text(encoding="utf-8")
    )
    assert data["asset_slot"] == "turnaround"


def test_submit_n4_explicit(tmp_path):
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("multi prompt", encoding="utf-8")
    _write_default_key(tmp_path)
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--prompt-file", str(prompt_file), "--n", "4"],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0
    job_id = r.stdout.strip()
    data = json.loads(
        (tmp_path / ".runtime" / "jobs" / f"{job_id}.json").read_text(encoding="utf-8")
    )
    assert data["params"]["n"] == 4


def test_submit_falls_back_to_active_character(tmp_path):
    """不传 --character 时读 .runtime/active-character.json。"""
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")
    runtime = tmp_path / ".runtime"
    runtime.mkdir()
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"}),
        encoding="utf-8",
    )
    _write_default_key(tmp_path)

    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--prompt-file", str(prompt_file)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0, f"stderr={r.stderr}"
    job_id = r.stdout.strip()
    data = json.loads(
        (tmp_path / ".runtime" / "jobs" / f"{job_id}.json").read_text(encoding="utf-8")
    )
    assert data["character_id"] == "holy"


def test_submit_missing_character_and_active(tmp_path):
    """不传 --character 且 active-character.json 不存在 → exit !=0。"""
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")

    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--prompt-file", str(prompt_file)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode != 0
    assert r.stdout.strip() == ""
    assert "character" in r.stderr.lower() or "active" in r.stderr.lower()


def test_submit_missing_prompt_file(tmp_path):
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--prompt-file", str(tmp_path / "nope.md")],
        cwd=_project_root(), env=env,
    )
    assert r.returncode != 0
    assert r.stdout.strip() == ""
    assert "prompt" in r.stderr.lower() or "not" in r.stderr.lower() or "exist" in r.stderr.lower()


def test_submit_stdout_is_pure_job_id(tmp_path):
    """stdout 一行 job_id，可直接 $(...) 捕获。"""
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")
    _write_default_key(tmp_path)
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--prompt-file", str(prompt_file)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0
    # 严格：stdout 末尾最多一个 \n，去掉后必须匹配 job-... 格式
    stripped = r.stdout.rstrip("\n")
    assert re.fullmatch(r"job-\d{14}[0-9a-f]{8}", stripped), \
        f"非纯 job_id: {r.stdout!r}"
    assert "\n" not in stripped


def test_submit_size_explicit(tmp_path):
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")
    _write_default_key(tmp_path)
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--prompt-file", str(prompt_file), "--size", "2048x2048"],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0
    job_id = r.stdout.strip()
    data = json.loads(
        (tmp_path / ".runtime" / "jobs" / f"{job_id}.json").read_text(encoding="utf-8")
    )
    assert data["params"]["size"] == "2048x2048"


def test_submit_model_explicit(tmp_path):
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")
    _write_default_key(tmp_path)
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--prompt-file", str(prompt_file), "--model", "custom_model"],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0
    job_id = r.stdout.strip()
    data = json.loads(
        (tmp_path / ".runtime" / "jobs" / f"{job_id}.json").read_text(encoding="utf-8")
    )
    assert data["model"] == "custom_model"


def test_submit_without_default_key_fails(tmp_path):
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--prompt-file", str(prompt_file)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 2
    assert r.stdout.strip() == ""
    assert "没有可用默认 Key" in r.stderr
