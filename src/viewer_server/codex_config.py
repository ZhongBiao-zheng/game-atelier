"""打开 Agent 开关时把 MCP 适配器写进 Codex 配置，Codex 新会话即可用工坊和画布工具。

只动 `[mcp_servers.game-atelier]` 的 command / args，其余条目、注释和用户加的键（超时、env）原样保留。
不带 `--credentials`：适配器读固定位置的凭据，重新打开开关不用再写一次。
"""
from __future__ import annotations

import os
from pathlib import Path

import tomlkit
from tomlkit.exceptions import TOMLKitError

from character_workflow.lib.atomic_io import atomic_write_text
from viewer_server.connection_auth import ConnectionError

SERVER_NAME = "game-atelier"


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


def write_codex_entry_if_installed(python: str) -> None:
    path = codex_config_path()
    # 没装 Codex（目录都不存在）就不替用户建配置。
    if not path.parent.is_dir():
        return
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
        atomic_write_text(path, tomlkit.dumps(document))
    except OSError as error:
        raise ConnectionError(
            "CODEX_CONFIG_INVALID", f"无法写入 {path}：{type(error).__name__}: {error}", 500,
        ) from error
