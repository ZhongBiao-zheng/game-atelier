"""把默认授权的 MCP 适配器写进 Codex 配置：页面点一次，Codex 新会话即可用工坊工具。

只动 `[mcp_servers.game-atelier]` 的 command / args，其余条目、注释和用户加的键（超时、env）原样保留。
不带 `--credentials`：适配器读默认授权的固定凭据，重新授权不用再写一次。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

import tomlkit
from tomlkit.exceptions import TOMLKitError

from character_workflow.lib.atomic_io import atomic_write_text
from viewer_server.connection_auth import ConnectionError

SERVER_NAME = "game-atelier"
CodexStatus = Literal["missing", "current", "outdated"]


def codex_config_path() -> Path:
    home = os.environ.get("CODEX_HOME")
    return (Path(home) if home else Path.home() / ".codex") / "config.toml"


def _args() -> list[str]:
    return ["-m", "character_workflow.mcp", "--client", "codex"]


def _load(path: Path) -> tomlkit.TOMLDocument:
    try:
        return tomlkit.parse(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return tomlkit.document()
    except (OSError, UnicodeDecodeError, TOMLKitError) as error:
        raise ConnectionError(
            "CODEX_CONFIG_INVALID", f"无法读取 {path}：{type(error).__name__}: {error}", 500,
        ) from error


def codex_status(python: str) -> CodexStatus:
    entry = _load(codex_config_path()).get("mcp_servers", {}).get(SERVER_NAME)
    if entry is None:
        return "missing"
    if entry.get("command") == python and list(entry.get("args", [])) == _args():
        return "current"
    return "outdated"


def write_codex_entry(python: str) -> CodexStatus:
    path = codex_config_path()
    document = _load(path)
    servers = document.get("mcp_servers")
    if servers is None:
        servers = tomlkit.table(is_super_table=True)
        document["mcp_servers"] = servers
    entry = servers.get(SERVER_NAME)
    if entry is None:
        entry = tomlkit.table()
        servers[SERVER_NAME] = entry
    entry["command"] = python
    entry["args"] = _args()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(path, tomlkit.dumps(document))
    except OSError as error:
        raise ConnectionError(
            "CODEX_CONFIG_INVALID", f"无法写入 {path}：{type(error).__name__}: {error}", 500,
        ) from error
    return "current"
