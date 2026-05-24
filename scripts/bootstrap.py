#!/usr/bin/env python3
"""Bootstrap entrypoint for the game-ui-ai-workflow Plugin.

Only stdlib + platformdirs (single pure-Python dep). Runs under system python.
After venv is built, business logic switches to <data_root>/.venv/python.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

import platformdirs

APP_NAME = "character-workflow"
ENV_VAR = "CHARACTER_WORKFLOW_DATA_ROOT"

# Plugin directory == repo root (this file lives in scripts/).
PLUGIN_DIR = Path(__file__).resolve().parent.parent


def global_config_file() -> Path:
    return Path(platformdirs.user_config_dir(APP_NAME)) / "data-root"


def resolve_data_root() -> Path | None:
    if env := os.environ.get(ENV_VAR):
        return Path(env).expanduser().resolve()
    cfg = global_config_file()
    if cfg.exists():
        text = cfg.read_text().strip()
        if text:
            return Path(text).expanduser().resolve()
    return None


def _venv_python(data_root: Path) -> Path:
    if sys.platform == "win32":
        return data_root / ".venv" / "Scripts" / "python.exe"
    return data_root / ".venv" / "bin" / "python"


def _venv_hash_file(data_root: Path) -> Path:
    return data_root / ".config" / "venv-hash"


def _pyproject_hash() -> str:
    pyproject = PLUGIN_DIR / "pyproject.toml"
    return hashlib.sha256(pyproject.read_bytes()).hexdigest()


def _uv_install_instruction() -> str:
    if sys.platform == "win32":
        return "powershell -c \"irm https://astral.sh/uv/install.ps1 | iex\""
    return "curl -LsSf https://astral.sh/uv/install.sh | sh"


def check() -> dict:
    data_root = resolve_data_root()
    if data_root is None:
        return {
            "status": "needs_data_root",
            "data_root": None,
            "uv_path": shutil.which("uv"),
            "venv_python": None,
            "platform": sys.platform,
            "next_action": "选数据目录（CC 向导问用户）",
        }

    uv_path = shutil.which("uv")
    if uv_path is None:
        return {
            "status": "needs_uv",
            "data_root": str(data_root),
            "uv_path": None,
            "venv_python": None,
            "platform": sys.platform,
            "next_action": f"安装 uv: {_uv_install_instruction()}",
        }

    venv_py = _venv_python(data_root)
    hash_file = _venv_hash_file(data_root)
    expected_hash = _pyproject_hash()
    venv_hash = hash_file.read_text().strip() if hash_file.exists() else None

    if (not venv_py.exists()) or (venv_hash is None) or (venv_hash != expected_hash):
        return {
            "status": "needs_venv",
            "data_root": str(data_root),
            "uv_path": uv_path,
            "venv_python": str(venv_py),
            "platform": sys.platform,
            "next_action": "运行 bootstrap.py --ensure-venv 安装依赖",
        }

    keys_file = data_root / ".config" / "keys.json"
    if not keys_file.exists():
        return {
            "status": "needs_first_key",
            "data_root": str(data_root),
            "uv_path": uv_path,
            "venv_python": str(venv_py),
            "platform": sys.platform,
            "next_action": "添加第一把 Lovart key（CC 向导问用户）",
        }

    try:
        payload = json.loads(keys_file.read_text())
    except json.JSONDecodeError as e:
        return {
            "status": "needs_keys_repair",
            "data_root": str(data_root),
            "uv_path": uv_path,
            "venv_python": str(venv_py),
            "platform": sys.platform,
            "stderr": f"keys.json 解析失败: {e}",
            "next_action": "手动修复 keys.json 或删除后重新添加 key",
        }

    keys = payload.get("keys") if isinstance(payload, dict) else None
    if not keys:
        return {
            "status": "needs_first_key",
            "data_root": str(data_root),
            "uv_path": uv_path,
            "venv_python": str(venv_py),
            "platform": sys.platform,
            "next_action": "keys.json 中 'keys' 列表为空，添加第一把 key",
        }

    return {
        "status": "ready",
        "data_root": str(data_root),
        "uv_path": uv_path,
        "venv_python": str(venv_py),
        "platform": sys.platform,
        "next_action": "ready",
    }


def init_data_root(target: Path) -> int:
    """Create the data-root skeleton and write the global config pointer."""
    resolved = target.expanduser().resolve()
    for sub in (".config", ".runtime", "projects", "characters"):
        (resolved / sub).mkdir(parents=True, exist_ok=True)

    cfg = global_config_file()
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(str(resolved) + "\n")

    print(json.dumps({
        "status": "ok",
        "data_root": str(resolved),
        "config_file": str(cfg),
    }, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap the character-workflow plugin.")
    parser.add_argument("--check", action="store_true", help="Report current bootstrap state.")
    parser.add_argument(
        "--init-data-root",
        metavar="PATH",
        help="Create data-root skeleton at PATH and write global config pointer.",
    )
    args = parser.parse_args()

    if args.check:
        print(json.dumps(check(), ensure_ascii=False))
        return 0

    if args.init_data_root:
        return init_data_root(Path(args.init_data_root))

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
