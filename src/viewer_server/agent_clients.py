"""把本机 Canvas MCP 适配器接到各 Agent 客户端：生成启动配置、一键写入、复制、服务启动时改写。

- 启动命令只有一套判断（`launch`）：运行包的解释器里没装本项目（判据同 bootstrap.is_bundle），
  要经 `bootstrap.py --run` 带上 PYTHONPATH；源码安装的环境里本项目是可编辑安装，直接 `-m`。
- 凭据不进客户端配置：适配器读 `<data_root>/.config/connections/agent.json`。
- 一键写入只动我们自己那一条（Codex 是 `[mcp_servers.game-atelier]`，JSON 客户端是 `mcpServers.atelier`），
  其余内容原样保留；写前留一份 `<文件名>.atelier-backup`，写后回读核对。读不懂的文件报错、不改。
- 运行包按版本目录存放解释器，更新器只留三个版本：服务每次启动（开关打开时）把各客户端里已有的
  我们那一条改写成本次的解释器。条目不存在不新建（用户删掉就是不要了）。
- 只提供「复制」的客户端：Claude Code（运行中会整体重写 ~/.claude.json，我们写进去可能被覆盖；
  装了 Atelier 插件时已经接入）、TRAE（官方文档没写全局配置文件位置）、WorkBuddy（查不到官方路径）。
"""
from __future__ import annotations

import json
import logging
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Literal

import tomlkit
from tomlkit.exceptions import TOMLKitError

from character_workflow.lib.atomic_io import atomic_write_text
from viewer_server.connection_auth import ConnectionError

AgentClientId = Literal["claude-code", "codex", "cursor", "claude-desktop", "trae", "workbuddy"]
CLIENT_IDS: tuple[str, ...] = ("claude-code", "codex", "cursor", "claude-desktop", "trae", "workbuddy")
WRITABLE: tuple[str, ...] = ("codex", "cursor", "claude-desktop")
CODEX_SERVER = "game-atelier"
JSON_SERVER = "atelier"
APP_DIR = Path(__file__).resolve().parents[2]
BOOTSTRAP = APP_DIR / "scripts" / "bootstrap.py"
logger = logging.getLogger(__name__)


def _home() -> Path:
    """测试替换点：客户端配置都在用户目录下，测试必须指到临时目录。"""
    return Path.home()


def _appdata() -> Path:
    value = os.environ.get("APPDATA")
    return Path(value) if value else _home() / "AppData" / "Roaming"


# ── 启动命令 ─────────────────────────────────────────────────────────────────────

def bundled(python: str) -> bool:
    return Path(python).resolve().is_relative_to(APP_DIR.parent / "python")


def launch(python: str, client: str) -> tuple[str, list[str]]:
    module = ["-m", "character_workflow.mcp", "--client", client]
    return python, ([str(BOOTSTRAP), "--run", *module] if bundled(python) else module)


# ── 配置位置 ─────────────────────────────────────────────────────────────────────

def codex_config_path() -> Path:
    home = os.environ.get("CODEX_HOME")
    return (Path(home) if home else _home() / ".codex") / "config.toml"


def config_path(client: str) -> Path | None:
    if client == "codex":
        return codex_config_path()
    if client == "cursor":
        return _home() / ".cursor" / "mcp.json"
    if client == "claude-desktop":
        if sys.platform == "darwin":
            return _home() / "Library" / "Application Support" / "Claude" / "claude_desktop_config.json"
        if os.name == "nt":
            return _appdata() / "Claude" / "claude_desktop_config.json"
        return _home() / ".config" / "Claude" / "claude_desktop_config.json"
    return None


def claude_code_plugin_installed() -> bool:
    """装了 Atelier 插件的 Claude Code 已经带着同一个 MCP（插件 mcpServers.atelier），不用再配。"""
    claude = _home() / ".claude"
    if (claude / "skills" / "game-atelier").exists():
        return True
    try:
        plugins = json.loads((claude / "plugins" / "installed_plugins.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    names = plugins.get("plugins") if isinstance(plugins, dict) else None
    return isinstance(names, dict) and any(str(name).split("@", 1)[0] == "game-atelier" for name in names)


# ── 复制用的配置片段 ──────────────────────────────────────────────────────────────

def _shell_join(parts: list[str]) -> str:
    return subprocess.list2cmdline(parts) if os.name == "nt" else shlex.join(parts)


def snippet(client: str, python: str) -> str:
    command, args = launch(python, client)
    if client == "claude-code":
        return _shell_join(["claude", "mcp", "add", "-s", "user", JSON_SERVER, "--", command, *args])
    if client == "codex":
        document = tomlkit.document()
        servers = tomlkit.table(is_super_table=True)
        entry = tomlkit.table()
        entry["command"] = command
        entry["args"] = args
        servers[CODEX_SERVER] = entry
        document["mcp_servers"] = servers
        return tomlkit.dumps(document).strip()
    return json.dumps({"mcpServers": {JSON_SERVER: {"command": command, "args": args}}},
                      ensure_ascii=False, indent=2)


# ── 读写 ─────────────────────────────────────────────────────────────────────────

def _invalid(path: Path, action: str, error: BaseException) -> ConnectionError:
    return ConnectionError("CLIENT_CONFIG_INVALID",
                           f"无法{action} {path}：{type(error).__name__}: {error}", 500)


def _load_toml(path: Path) -> tomlkit.TOMLDocument:
    try:
        return tomlkit.parse(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return tomlkit.document()
    except (OSError, UnicodeDecodeError, TOMLKitError) as error:
        raise _invalid(path, "读取", error) from error


def _load_json(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError) as error:
        raise _invalid(path, "读取", error) from error
    if not text.strip():
        return {}
    try:
        value = json.loads(text)
    except ValueError as error:
        raise _invalid(path, "读取", error) from error
    if not isinstance(value, dict) or not isinstance(value.get("mcpServers", {}), dict):
        raise _invalid(path, "读取", ValueError("顶层或 mcpServers 不是对象"))
    return value


def _entry(client: str, path: Path) -> dict | None:
    if client == "codex":
        found = (_load_toml(path).get("mcp_servers") or {}).get(CODEX_SERVER)
        return {"command": found.get("command"), "args": list(found.get("args") or [])} \
            if found is not None else None
    found = _load_json(path).get("mcpServers", {}).get(JSON_SERVER)
    return found if isinstance(found, dict) else None


def _matches(found: dict | None, command: str, args: list[str]) -> bool:
    return found is not None and found.get("command") == command and list(found.get("args") or []) == args


def _write_text(path: Path, text: str) -> None:
    try:
        if path.exists():
            shutil.copy2(path, path.with_name(path.name + ".atelier-backup"))
        atomic_write_text(path, text)
    except OSError as error:
        raise _invalid(path, "写入", error) from error


def _put(client: str, path: Path, python: str) -> None:
    command, args = launch(python, client)
    if client == "codex":
        document = _load_toml(path)
        servers = document.get("mcp_servers")
        if servers is None:
            servers = tomlkit.table(is_super_table=True)
            document["mcp_servers"] = servers
        entry = servers.get(CODEX_SERVER)
        if entry is None:
            entry = tomlkit.table()
            servers[CODEX_SERVER] = entry
        entry["command"] = command
        entry["args"] = args
        _write_text(path, tomlkit.dumps(document))
    else:
        document = _load_json(path)
        servers = document.setdefault("mcpServers", {})
        # 用户在我们这一条里加的键（env、超时）保留，只换启动命令。
        current = servers.get(JSON_SERVER) if isinstance(servers.get(JSON_SERVER), dict) else {}
        servers[JSON_SERVER] = {**current, "command": command, "args": args}
        _write_text(path, json.dumps(document, ensure_ascii=False, indent=2) + "\n")
    if not _matches(_entry(client, path), command, args):
        raise _invalid(path, "写入", ValueError("写完回读不一致"))


def write(client: str, python: str) -> None:
    """一键写入。客户端的配置目录不存在（多半没装）时报错，不替用户建目录。"""
    path = config_path(client)
    if client not in WRITABLE or path is None:
        raise ConnectionError("CLIENT_NOT_WRITABLE", "这个客户端请复制配置后手动添加", 422)
    if not path.parent.is_dir():
        raise ConnectionError("CLIENT_NOT_FOUND", f"没找到 {path.parent}，请先安装并打开一次该客户端", 404)
    _put(client, path, python)


def write_codex_if_installed(python: str) -> None:
    """打开开关时顺手写 Codex（ADR-0022）：没装 Codex（目录都不存在）就不建配置。"""
    if codex_config_path().parent.is_dir():
        _put("codex", codex_config_path(), python)


def refresh_all(python: str) -> list[str]:
    """服务启动时调用：已写过的条目指向的不是本次的启动命令就改写。返回改写了的客户端。"""
    refreshed = []
    for client in WRITABLE:
        path = config_path(client)
        if path is None or not path.is_file():
            continue
        command, args = launch(python, client)
        try:
            found = _entry(client, path)
            if found is None or _matches(found, command, args):
                continue
            _put(client, path, python)
        except ConnectionError as error:
            # 一个客户端的配置读不懂，不影响其他客户端；只记日志。
            logger.warning("agent client %s not refreshed: %s", client, error.message)
            continue
        refreshed.append(client)
    return refreshed


TRAE_SPACE_WARNING = "安装路径含空格，TRAE 无法启动"


def warning(client: str, python: str) -> str | None:
    """TRAE 官方要求 command 不含空格（docs.trae.cn「添加 MCP Server」）；macOS 桌面版的解释器在
    ~/Library/Application Support/GameAtelier 下，默认就命中。"""
    command, _ = launch(python, client)
    return TRAE_SPACE_WARNING if client == "trae" and " " in command else None


def status(python: str) -> list[dict[str, Any]]:
    """设置页的客户端卡片：写入方式、配置位置、我们那一条是否已是当前启动命令、可复制的片段。"""
    rows = []
    for client in CLIENT_IDS:
        path = config_path(client)
        mode = "write" if client in WRITABLE else "copy"
        if client == "claude-code" and claude_code_plugin_installed():
            mode = "plugin"
        written = False
        if path is not None and path.is_file():
            command, args = launch(python, client)
            try:
                written = _matches(_entry(client, path), command, args)
            except ConnectionError:
                written = False
        rows.append({"id": client, "mode": mode, "path": str(path) if path else None,
                     "written": written, "snippet": snippet(client, python),
                     "warning": warning(client, python)})
    return rows
