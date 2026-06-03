#!/usr/bin/env python3
"""Bootstrap entrypoint for the game-atelier Plugin.

Only stdlib + platformdirs (single pure-Python dep). Runs under system python.
After venv is built, business logic switches to <data_root>/.venv/python.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import platformdirs

APP_NAME = "game-atelier"
ENV_VAR = "GAME_ATELIER_DATA_ROOT"

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


def _web_dist_ok() -> bool:
    """前端构建产物是否随插件就位。缺失 → viewer-server 无前端可挂、开窗 404。"""
    return (PLUGIN_DIR / "web" / "dist" / "index.html").exists()


def _uv_install_instruction() -> str:
    if sys.platform == "win32":
        return "powershell -c \"irm https://astral.sh/uv/install.ps1 | iex\""
    return "curl -LsSf https://astral.sh/uv/install.sh | sh"


def check() -> dict:
    # 前端产物缺失先于一切：没有 UI，启了 server 也只会开窗 404。
    if not _web_dist_ok():
        return {
            "status": "needs_web_build",
            "data_root": None,
            "uv_path": shutil.which("uv"),
            "venv_python": None,
            "platform": sys.platform,
            "next_action": (
                "前端未构建（缺 web/dist）。开发模式跑 `make build`；"
                "插件用户：安装包缺预构建 UI，请重装插件或反馈打包问题——不要在此状态下开窗。"
            ),
        }

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
            "next_action": "添加第一把图像服务 key（CC 向导问用户）",
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


def ensure_venv() -> int:
    """Run `uv sync` against PLUGIN_DIR into <data_root>/.venv, then write venv-hash."""
    data_root = resolve_data_root()
    if data_root is None:
        print(json.dumps({
            "status": "error",
            "error": "data_root not configured — run --init-data-root first",
        }, ensure_ascii=False))
        return 1

    uv_path = shutil.which("uv")
    if uv_path is None:
        print(json.dumps({
            "status": "error",
            "error": f"uv not installed — install via: {_uv_install_instruction()}",
        }, ensure_ascii=False))
        return 2

    venv = data_root / ".venv"
    venv.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv)}
    proc = subprocess.run(
        [uv_path, "sync", "--project", str(PLUGIN_DIR)],
        env=env, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(json.dumps({
            "status": "error",
            "error": "uv sync failed",
            "stderr": proc.stderr or "",
            "stdout": proc.stdout or "",
        }, ensure_ascii=False))
        return 3

    hash_file = _venv_hash_file(data_root)
    hash_file.parent.mkdir(parents=True, exist_ok=True)
    hash_file.write_text(_pyproject_hash())

    print(json.dumps({
        "status": "ok",
        "data_root": str(data_root),
        "venv_python": str(_venv_python(data_root)),
        "venv_hash": _pyproject_hash(),
    }, ensure_ascii=False))
    return 0


_MEMORY_TEMPLATE = """\
# game-atelier MEMORY

## 出图通用

## 开发

<!-- session-count: 0/5 -->
"""


def init_data_root(target: Path) -> int:
    """Create the data-root skeleton and write the global config pointer."""
    resolved = target.expanduser().resolve()
    for sub in (".config", ".runtime", "projects", "characters"):
        (resolved / sub).mkdir(parents=True, exist_ok=True)

    memory_file = resolved / "MEMORY.md"
    if not memory_file.exists():
        memory_file.write_text(_MEMORY_TEMPLATE, encoding="utf-8")

    cfg = global_config_file()
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(str(resolved) + "\n")

    print(json.dumps({
        "status": "ok",
        "data_root": str(resolved),
        "config_file": str(cfg),
    }, ensure_ascii=False))
    return 0


def run_in_venv(forward_args: list[str]) -> int:
    """Forward `forward_args` to <data_root>/.venv/python. Use from SKILL.md so
    installed-Plugin invocations don't depend on system python."""
    data_root = resolve_data_root()
    if data_root is None:
        print(json.dumps({
            "status": "error",
            "error": "data_root not set — run bootstrap.py --init-data-root first",
        }, ensure_ascii=False))
        return 1
    venv_py = _venv_python(data_root)
    if not venv_py.exists():
        print(json.dumps({
            "status": "error",
            "error": "venv not built — run bootstrap.py --ensure-venv",
        }, ensure_ascii=False))
        return 2
    proc = subprocess.run([str(venv_py), *forward_args])
    return proc.returncode


def _force_utf8_stdio() -> None:
    """Windows 控制台默认 GBK；强制 stdout/stderr UTF-8，防中文 next_action / JSON mojibake。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


def main() -> int:
    _force_utf8_stdio()
    # Handle --run before argparse so the remaining args pass through unparsed.
    if len(sys.argv) >= 2 and sys.argv[1] == "--run":
        return run_in_venv(sys.argv[2:])

    parser = argparse.ArgumentParser(description="Bootstrap the game-atelier plugin.")
    parser.add_argument("--check", action="store_true", help="Report current bootstrap state.")
    parser.add_argument(
        "--init-data-root",
        metavar="PATH",
        help="Create data-root skeleton at PATH and write global config pointer.",
    )
    parser.add_argument(
        "--ensure-venv",
        action="store_true",
        help="Run `uv sync` into <data_root>/.venv and write venv-hash.",
    )
    parser.add_argument(
        "--run",
        action="store_true",
        help="Forward remaining args to <data_root>/.venv/python (handled before argparse).",
    )
    args = parser.parse_args()

    if args.check:
        print(json.dumps(check(), ensure_ascii=False))
        return 0

    if args.init_data_root:
        return init_data_root(Path(args.init_data_root))

    if args.ensure_venv:
        return ensure_venv()

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
