#!/usr/bin/env python3
"""Bootstrap entrypoint for the game-ui-ai-workflow Plugin.

Only stdlib + platformdirs (single pure-Python dep). Runs under system python.
After venv is built, business logic switches to <data_root>/.venv/python.
"""
from __future__ import annotations
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import platformdirs

APP_NAME = "character-workflow"
ENV_VAR = "CHARACTER_WORKFLOW_DATA_ROOT"


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
    # Skeleton: assume next stages handle uv/venv/keys
    return {
        "status": "needs_uv",  # placeholder — Task 14 expands
        "data_root": str(data_root),
        "uv_path": shutil.which("uv"),
        "venv_python": None,
        "platform": sys.platform,
        "next_action": "(skeleton) 后续状态由 Task 14+ 实现",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=False)
    sub.add_parser("--check")
    # Accept --check as flag too
    args, rest = parser.parse_known_args()
    if "--check" in sys.argv:
        print(json.dumps(check(), ensure_ascii=False))
        return 0
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
