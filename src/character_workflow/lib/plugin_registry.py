"""插件注册表：扫描随应用发布的插件包，管理应用级启用状态（ADR-0037）。

未启用的插件只读它的 `manifest.lock.json`，不 import 任何插件代码。
一个插件的清单坏了只影响它自己，不影响其他插件与主程序启动。
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.plugin_manifest import (
    SUPPORTED_CAPABILITIES,
    SUPPORTED_SDK_VERSIONS,
    PluginPackageLock,
    package_digest,
    parse_semver,
)

logger = logging.getLogger(__name__)

LOCK_NAME = "manifest.lock.json"
STATE_SCHEMA_VERSION = 1


class PluginError(Exception):
    """启停被拒绝；`code` 给前端分支用，`message` 给用户看。"""

    def __init__(self, code: str, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass(frozen=True)
class PluginRecord:
    plugin_id: str
    package_dir: Path
    lock: PluginPackageLock | None
    # invalid：清单读不出；incompatible：清单合法但当前版本不能运行；ok：可启用。
    availability: str
    reason: str | None = None


def plugins_root() -> Path:
    """随应用发布的插件目录：源码工作区与安装包的 `app/` 下都是 `plugins/`。"""
    return Path(__file__).resolve().parents[3] / "plugins"


def state_file() -> Path:
    return data_root.config_dir() / "plugins.json"


def app_version() -> str:
    manifest = Path(__file__).resolve().parents[3] / ".claude-plugin" / "plugin.json"
    return json.loads(manifest.read_text(encoding="utf-8"))["version"]


def _incompatibility(lock: PluginPackageLock, current_app: str) -> str | None:
    current = parse_semver(current_app)
    if current < parse_semver(lock.app_version.min):
        return f"需要 Atelier {lock.app_version.min} 以上"
    if lock.app_version.max is not None and current > parse_semver(lock.app_version.max):
        return f"仅支持到 Atelier {lock.app_version.max}"
    if lock.sdk_version not in SUPPORTED_SDK_VERSIONS:
        return "需要更高版本的 Atelier"
    if not set(lock.capabilities) <= SUPPORTED_CAPABILITIES:
        return "需要更高版本的 Atelier"
    if any(asset.required for asset in lock.assets):
        # 资产下载器随第一个带大文件的插件交付（方案 C3）。
        return "需要更高版本的 Atelier"
    return None


def _load_record(package_dir: Path, current_app: str) -> PluginRecord:
    plugin_id = package_dir.parent.name
    try:
        raw = json.loads((package_dir / LOCK_NAME).read_text(encoding="utf-8"))
        lock = PluginPackageLock.model_validate(raw)
        if lock.id != plugin_id:
            raise ValueError(f"清单 id {lock.id} 与目录名不一致")
        if package_digest(raw) != lock.digest:
            raise ValueError("包摘要与清单内容不一致")
    except (OSError, ValueError, ValidationError) as error:
        logger.warning("plugin %s manifest rejected: %s", plugin_id, error)
        return PluginRecord(plugin_id, package_dir, None, "invalid", _short(error))
    reason = _incompatibility(lock, current_app)
    return PluginRecord(plugin_id, package_dir, lock, "incompatible" if reason else "ok", reason)


def _short(error: Exception) -> str:
    if isinstance(error, ValidationError):
        first = error.errors()[0]
        return f"{'.'.join(str(part) for part in first['loc'])}: {first['msg']}"[:200]
    return str(error)[:200]


def scan() -> list[PluginRecord]:
    root = plugins_root()
    if not root.is_dir():
        return []
    current_app = app_version()
    return [
        _load_record(lock_path.parent, current_app)
        for lock_path in sorted(root.glob(f"*/package/{LOCK_NAME}"))
    ]


def find(plugin_id: str) -> PluginRecord | None:
    return next((record for record in scan() if record.plugin_id == plugin_id), None)


def _read_state_unlocked() -> dict[str, dict[str, Any]]:
    """读启用状态。整份文件坏了按「全部未启用」处理并保留坏文件；单条不合规只丢该条。"""
    path = state_file()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        _quarantine(path, error)
        return {}
    plugins = raw.get("plugins") if isinstance(raw, dict) else None
    if not isinstance(plugins, dict):
        _quarantine(path, ValueError("plugins.json 结构不合规"))
        return {}
    return {
        plugin_id: entry for plugin_id, entry in plugins.items()
        if isinstance(plugin_id, str) and isinstance(entry, dict) and isinstance(entry.get("enabled"), bool)
    }


def _quarantine(path: Path, error: Exception) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = path.with_name(f"{path.name}.broken-{stamp}")
    logger.warning("plugins.json unreadable (%s); kept as %s", error, target.name)
    try:
        path.replace(target)
    except OSError:
        logger.exception("could not set aside broken plugins.json")


def enabled_ids() -> set[str]:
    """可用且已启用的插件 id。清单失效或不兼容的插件即使记录为启用也不算。"""
    state = _read_state_unlocked()
    return {
        record.plugin_id for record in scan()
        if record.availability == "ok" and state.get(record.plugin_id, {}).get("enabled") is True
    }


def describe(record: PluginRecord, state: dict[str, dict[str, Any]]) -> dict[str, Any]:
    enabled = record.availability == "ok" and state.get(record.plugin_id, {}).get("enabled") is True
    return {
        "id": record.plugin_id,
        "availability": record.availability,
        "reason": record.reason,
        "enabled": enabled,
        "manifest": record.lock.model_dump(mode="json") if record.lock is not None else None,
    }


def list_plugins() -> list[dict[str, Any]]:
    state = _read_state_unlocked()
    return [describe(record, state) for record in scan()]


def set_enabled(plugin_id: str, enabled: bool) -> list[dict[str, Any]]:
    record = find(plugin_id)
    if record is None:
        raise PluginError("PLUGIN_NOT_FOUND", "没有这个插件", status=404)
    if enabled and (record.availability != "ok" or record.lock is None):
        raise PluginError("PLUGIN_UNAVAILABLE", record.reason or "插件不可用")
    path = state_file()
    with file_lock(path.with_suffix(".lock")):
        state = _read_state_unlocked()
        entry: dict[str, Any] = {"enabled": enabled}
        if enabled and record.lock is not None:
            entry["enabled_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            entry["digest"] = record.lock.digest
        atomic_write_json(path, {
            "schema_version": STATE_SCHEMA_VERSION, "plugins": {**state, plugin_id: entry},
        })
    return list_plugins()


def package_file(plugin_id: str, relative: str) -> Path:
    """已启用插件的包内文件；只放行清单 `files` 里登记过的路径。"""
    record = find(plugin_id)
    if record is None or record.lock is None or plugin_id not in enabled_ids():
        raise PluginError("PLUGIN_DISABLED", "插件未启用", status=404)
    if relative not in {item.path for item in record.lock.files}:
        raise PluginError("PLUGIN_FILE_NOT_FOUND", "插件包里没有这个文件", status=404)
    root = record.package_dir.resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise PluginError("PLUGIN_FILE_NOT_FOUND", "插件包里没有这个文件", status=404)
    return path
