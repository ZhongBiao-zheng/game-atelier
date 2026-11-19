"""打开 Agent 开关时把 MCP 适配器写进 Codex 配置，Codex 新会话即可用工坊和画布工具。

只动 `[mcp_servers.game-atelier]` 的 command / args，其余条目、注释和用户加的键（超时、env）原样保留。
不带 `--credentials`：适配器读固定位置的凭据，重新打开开关不用再写一次。
运行包按版本目录存放解释器，更新器只留三个版本：服务每次启动时把已有条目改写成当前解释器（开关打开时）。
"""
from __future__ import annotations

import os
from pathlib import Path

import tomlkit
from tomlkit.exceptions import TOMLKitError

from character_workflow.lib.atomic_io import atomic_write_text
from viewer_server.connection_auth import ConnectionError

SERVER_NAME = "game-atelier"
APP_DIR = Path(__file__).resolve().parents[2]
BOOTSTRAP = APP_DIR / "scripts" / "bootstrap.py"


def codex_config_path() -> Path:
    home = os.environ.get("CODEX_HOME")
    return (Path(home) if home else Path.home() / ".codex") / "config.toml"


def _args(python: str) -> list[str]:
    module = ["-m", "character_workflow.mcp", "--client", "codex"]
    # 运行包的解释器里没装本项目（判据同 bootstrap.is_bundle），直接 -m 找不到模块；
    # 和 Claude Code 插件一样经 bootstrap --run 带上 PYTHONPATH。源码安装的环境里本项目是可编辑安装。
    if Path(python).resolve().is_relative_to(APP_DIR.parent / "python"):
        return [str(BOOTSTRAP), "--run", *module]
    return module


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
    entry["args"] = _args(python)
    _write(path, document)


def refresh_codex_entry(python: str) -> bool:
    """服务启动时调用：已有条目指向的不是当前解释器就改写；没有条目（用户删了或没装 Codex）不新建。"""
    path = codex_config_path()
    if not path.is_file():
        return False
    document = _load(path)
    entry = (document.get("mcp_servers") or {}).get(SERVER_NAME)
    if entry is None or (entry.get("command"), list(entry.get("args") or [])) == (python, _args(python)):
        return False
    entry["command"] = python
    entry["args"] = _args(python)
    _write(path, document)
    return True


def _write(path: Path, document: tomlkit.TOMLDocument) -> None:
    try:
        atomic_write_text(path, tomlkit.dumps(document))
    except OSError as error:
        raise ConnectionError(
            "CODEX_CONFIG_INVALID", f"无法写入 {path}：{type(error).__name__}: {error}", 500,
        ) from error
