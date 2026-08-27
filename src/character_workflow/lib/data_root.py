"""Data root resolver: env var > global config file > default."""
from __future__ import annotations
import os
import sys
from pathlib import Path

import platformdirs

_APP_NAME = "game-atelier"
_ENV_VAR = "GAME_ATELIER_DATA_ROOT"


def _global_config_file() -> Path:
    return Path(platformdirs.user_config_dir(_APP_NAME)) / "data-root"


def resolve_data_root() -> Path:
    if env := os.environ.get(_ENV_VAR):
        return Path(env).expanduser().resolve()
    cfg = _global_config_file()
    if cfg.exists():
        text = cfg.read_text(encoding="utf-8").strip()
        if text:
            return Path(text).expanduser().resolve()
    return (Path.home() / "game-atelier").resolve()


def config_dir() -> Path:
    return resolve_data_root() / ".config"


def runtime_dir() -> Path:
    return resolve_data_root() / ".runtime"


def venv_dir() -> Path:
    return resolve_data_root() / ".venv"


def venv_python() -> Path:
    if sys.platform == "win32":
        return venv_dir() / "Scripts" / "python.exe"
    return venv_dir() / "bin" / "python"


def projects_dir() -> Path:
    return resolve_data_root() / "projects"


def characters_dir() -> Path:
    return resolve_data_root() / "characters"


def canvases_dir() -> Path:
    return resolve_data_root() / "canvases"


def workspace_memory() -> Path:
    return resolve_data_root() / "MEMORY.md"


def workspace_worldview() -> Path:
    return resolve_data_root() / "worldview.md"


def keys_file() -> Path:
    return config_dir() / "keys.json"


def canvas_ui_file() -> Path:
    return config_dir() / "canvas-ui.json"


def write_global_config(path: Path) -> None:
    """写全局 data-root 配置文件（用户手动改 data root 时用）。"""
    cfg = _global_config_file()
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(str(Path(path).expanduser().resolve()) + "\n", encoding="utf-8")
