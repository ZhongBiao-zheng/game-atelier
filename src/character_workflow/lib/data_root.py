"""Data root resolver: env var > global config file > default."""
from __future__ import annotations
import os
import sys
from pathlib import Path

import platformdirs

from character_workflow.lib.atomic_io import atomic_write_text, read_text_with_retry

_APP_NAME = "game-atelier"
_ENV_VAR = "GAME_ATELIER_DATA_ROOT"
# 首启的存放位置还没经用户确认（scripts/bootstrap.py 的 DATA_ROOT_UNCONFIRMED）；在 .runtime/ 下。
UNCONFIRMED_MARKER = "data-root-unconfirmed"


def _global_config_file() -> Path:
    return Path(platformdirs.user_config_dir(_APP_NAME)) / "data-root"


def resolve_data_root() -> Path:
    if env := os.environ.get(_ENV_VAR):
        return Path(env).expanduser().resolve()
    text = (read_global_config() or "").strip()
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


def creation_assets_dir() -> Path:
    return resolve_data_root() / "creation-assets"


def workspace_memory() -> Path:
    return resolve_data_root() / "MEMORY.md"


def workspace_worldview() -> Path:
    return resolve_data_root() / "worldview.md"


def keys_file() -> Path:
    return config_dir() / "keys.json"


def canvas_ui_file() -> Path:
    return config_dir() / "canvas-ui.json"


def accent_themes_file() -> Path:
    return config_dir() / "accent-themes.json"


AGENT_CREDENTIAL_NAME = "agent.json"


def agent_credential_file() -> Path:
    # 默认授权的凭据固定在这里：插件自带的 MCP 不写路径也能找到，重新授权只换内容不换位置。
    return config_dir() / "connections" / AGENT_CREDENTIAL_NAME


def read_global_config() -> str | None:
    """全局 data-root 配置文件的原文；没有文件时 None（换目录失败时按它原样退回）。"""
    try:
        return read_text_with_retry(_global_config_file())
    except FileNotFoundError:
        return None


def write_global_config(path: Path) -> None:
    """写全局 data-root 配置文件（用户手动改 data root 时用）。

    原子替换：中途强退只会留下旧指针或新指针，不会留下截断的半行。"""
    atomic_write_text(_global_config_file(), str(Path(path).expanduser().resolve()) + "\n")


def restore_global_config(text: str | None) -> None:
    """把指针退回 `read_global_config()` 读到的原文；原来没有文件就删掉。"""
    if text is None:
        _global_config_file().unlink(missing_ok=True)
    else:
        atomic_write_text(_global_config_file(), text)
