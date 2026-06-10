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
    env["GAME_ATELIER_DATA_ROOT"] = str(tmp_path)
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


def _write_two_keys(tmp_path):
    """default_alias 指向 gpt 这把；另有一把 nano（非默认）。"""
    config = tmp_path / ".config"
    config.mkdir(parents=True, exist_ok=True)

    def _key(alias, model):
        return {
            "alias": alias, "provider": "custom",
            "base_url": "https://api.example.test", "access_key": "ak",
            "secret_key": None, "capabilities": ["portrait"],
            "models": [{"name": model, "id": model}],
            "homepage_url": None, "docs_url": None, "api_key_url": None,
            "modalities": ["image"], "routing_scope": "general",
            "routing_category": None, "routing_hints": [], "notes": "",
            "created_at": "2026-05-29T00:00:00+00:00",
        }

    (config / "keys.json").write_text(
        json.dumps({
            "version": 1, "default_alias": "gpt",
            "keys": [_key("gpt", "gpt-image-2"), _key("nano", "nano-banana-x")],
        }),
        encoding="utf-8",
    )


def test_submit_alias_pins_non_default_key(tmp_path):
    """--alias 能把出图钉到非默认 Key（跨 Key 选模型）。"""
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")
    _write_two_keys(tmp_path)
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--alias", "nano", "--model", "nano-banana-x",
         "--prompt-file", str(prompt_file)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0, r.stderr
    data = json.loads(
        (tmp_path / ".runtime" / "jobs" / f"{r.stdout.strip()}.json").read_text(encoding="utf-8")
    )
    assert data["alias"] == "nano"
    assert data["model"] == "nano-banana-x"
    assert "nano" in data["params"]["vendor"]


def test_submit_multiple_reference_images(tmp_path):
    """--reference-image 可重复传多张，全部按序落 params.reference_images，无需手改 JSON。"""
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")
    img_a = tmp_path / "a.png"
    img_a.write_bytes(b"x")
    img_b = tmp_path / "b.png"
    img_b.write_bytes(b"x")
    _write_default_key(tmp_path)
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--prompt-file", str(prompt_file),
         "--reference-image", str(img_a), "--reference-image", str(img_b)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0, r.stderr
    data = json.loads(
        (tmp_path / ".runtime" / "jobs" / f"{r.stdout.strip()}.json").read_text(encoding="utf-8")
    )
    assert data["params"]["reference_images"] == [str(img_a), str(img_b)]
    assert data["source_image"] is None


def test_submit_source_image_merges_with_reference_images(tmp_path):
    """--source-image 仍是首张参考图（兼容别名）；与 --reference-image 合并去重。"""
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")
    src = tmp_path / "src.png"
    src.write_bytes(b"x")
    img_a = tmp_path / "a.png"
    img_a.write_bytes(b"x")
    _write_default_key(tmp_path, kind="promo")
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "promo", "--character", "holy",
         "--prompt-file", str(prompt_file),
         "--source-image", str(src),
         "--reference-image", str(img_a), "--reference-image", str(src)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0, r.stderr
    data = json.loads(
        (tmp_path / ".runtime" / "jobs" / f"{r.stdout.strip()}.json").read_text(encoding="utf-8")
    )
    assert data["source_image"] == str(src)
    assert data["params"]["reference_images"] == [str(src), str(img_a)]


def test_submit_prints_confirmation_card_to_stderr(tmp_path):
    """确认卡由 CLI 生成打到 stderr（job_id / Key / model / size / 参考图全列表 / prompt 全文），
    stdout 仍是纯 job_id。"""
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("中文 prompt 全文", encoding="utf-8")
    img_a = tmp_path / "a.png"
    img_a.write_bytes(b"x")
    _write_default_key(tmp_path)
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--prompt-file", str(prompt_file), "--reference-image", str(img_a)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0, r.stderr
    job_id = r.stdout.strip()
    assert re.fullmatch(r"job-\d{14}[0-9a-f]{8}", job_id)  # stdout 契约不破
    card = r.stderr
    assert "出图确认卡" in card
    assert job_id in card
    assert "default (custom)" in card
    assert "gpt-image-2" in card
    assert "1024x1536" in card
    assert str(img_a) in card
    assert "中文 prompt 全文" in card


def test_retry_job_clones_failed_job(tmp_path, monkeypatch):
    """retry-job：克隆 failed job → 新 PENDING_CONFIRM + retry_of；原 job 错误记录保留。"""
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")
    _write_default_key(tmp_path)
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--prompt-file", str(prompt_file)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 0, r.stderr
    job_id = r.stdout.strip()

    # 在本测试进程内把 job 翻成 FAILED（经 lib 写入，不手写 JSON）
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    from character_workflow.lib.jobs import update_job_status
    from character_workflow.lib.schemas import JobStatus
    update_job_status(job_id, status=JobStatus.FAILED, error="network down")

    r2 = _run(["retry-job", job_id], cwd=_project_root(), env=env)
    assert r2.returncode == 0, r2.stderr
    new_id = r2.stdout.strip()
    assert re.fullmatch(r"job-\d{14}[0-9a-f]{8}", new_id)
    assert new_id != job_id
    assert "出图确认卡" in r2.stderr and job_id in r2.stderr  # 卡上有 retry_of

    jobs_dir = tmp_path / ".runtime" / "jobs"
    clone = json.loads((jobs_dir / f"{new_id}.json").read_text(encoding="utf-8"))
    assert clone["retry_of"] == job_id
    assert clone["status"] == "pending_confirm"
    assert clone["error"] is None
    original = json.loads((jobs_dir / f"{job_id}.json").read_text(encoding="utf-8"))
    assert original["status"] == "failed"
    assert original["error"] == "network down"


def test_retry_job_rejects_non_failed(tmp_path):
    """非 failed job 不可重试 → exit 2。"""
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")
    _write_default_key(tmp_path)
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--prompt-file", str(prompt_file)],
        cwd=_project_root(), env=env,
    )
    job_id = r.stdout.strip()
    r2 = _run(["retry-job", job_id], cwd=_project_root(), env=env)
    assert r2.returncode == 2
    assert "not failed" in r2.stderr


def test_retry_job_missing_job(tmp_path):
    env = _make_env(tmp_path)
    r = _run(["retry-job", "job-nope"], cwd=_project_root(), env=env)
    assert r.returncode == 2
    assert "不存在" in r.stderr


def test_submit_unknown_alias_fails(tmp_path):
    prompt_file = tmp_path / "p.md"
    prompt_file.write_text("p", encoding="utf-8")
    _write_two_keys(tmp_path)
    env = _make_env(tmp_path)
    r = _run(
        ["submit", "--kind", "portrait", "--character", "holy",
         "--alias", "nope", "--prompt-file", str(prompt_file)],
        cwd=_project_root(), env=env,
    )
    assert r.returncode == 2
    assert "nope" in r.stderr


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
