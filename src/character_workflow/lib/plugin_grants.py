"""项目对插件的批准（ADR-0012 的 grant）。

批准绑定「项目 + 插件 + 一组能力」：在一个项目里批准过，不代表别的项目也批准。
文件在项目目录里但不进项目包——换一台机器要重新批准。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root, plugin_registry
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.canvas_projects import canvas_project_dir, read_canvas_project
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.plugin_registry import PluginError

logger = logging.getLogger(__name__)

GRANTS_NAME = "plugin-grants.json"
SCHEMA_VERSION = 1


def _grants_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / GRANTS_NAME


def _lock_path(project_id: str) -> Path:
    # 锁不放项目目录里：Windows 上删项目要 rename 整个目录，目录里有打开的句柄会失败。
    return data_root.runtime_dir() / "locks" / f"canvas-plugin-grants-{project_id}.lock"


def _require_project(project_id: str) -> None:
    try:
        read_canvas_project(project_id)
    except (KeyError, OSError, ValueError) as error:
        raise PluginError("PROJECT_NOT_FOUND", "找不到这个画布项目", status=404) from error


def _read_unlocked(project_id: str) -> dict[str, dict[str, Any]]:
    """读不出就当没批准过：最坏结果是用户再点一次「允许」，不会放大权限。"""
    try:
        raw = json.loads(_grants_path(project_id).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        logger.warning("plugin grants for %s unreadable: %s", project_id, error)
        return {}
    grants = raw.get("grants") if isinstance(raw, dict) else None
    if not isinstance(grants, dict):
        return {}
    return {
        plugin_id: entry for plugin_id, entry in grants.items()
        if isinstance(plugin_id, str) and isinstance(entry, dict)
        and isinstance(entry.get("capabilities"), list)
        and all(isinstance(item, str) for item in entry["capabilities"])
    }


def active_grants(project_id: str) -> dict[str, dict[str, Any]]:
    """当前有效的批准：插件已启用，且它现在要的能力都在批准过的范围内。

    插件更新后摘要会变；能力没有增加就沿用原批准，增加了就要重新批准（ADR-0012）。
    """
    _require_project(project_id)
    stored = _read_unlocked(project_id)
    enabled = plugin_registry.enabled_ids()
    active: dict[str, dict[str, Any]] = {}
    for record in plugin_registry.scan():
        entry = stored.get(record.plugin_id)
        if entry is None or record.lock is None or record.plugin_id not in enabled:
            continue
        if set(record.lock.capabilities) <= set(entry["capabilities"]):
            active[record.plugin_id] = {
                "capabilities": list(record.lock.capabilities),
                "granted_at": entry.get("granted_at"),
            }
    return active


def grant(project_id: str, plugin_id: str) -> dict[str, dict[str, Any]]:
    _require_project(project_id)
    record = plugin_registry.find(plugin_id)
    if record is None or record.lock is None or plugin_id not in plugin_registry.enabled_ids():
        raise PluginError("PLUGIN_DISABLED", "插件未启用", status=409)
    with file_lock(_lock_path(project_id)):
        stored = _read_unlocked(project_id)
        entry = {
            "digest": record.lock.digest,
            "capabilities": list(record.lock.capabilities),
            "granted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        atomic_write_json(_grants_path(project_id), {
            "schema_version": SCHEMA_VERSION, "grants": {**stored, plugin_id: entry},
        })
    return active_grants(project_id)


def revoke(project_id: str, plugin_id: str) -> dict[str, dict[str, Any]]:
    _require_project(project_id)
    with file_lock(_lock_path(project_id)):
        stored = _read_unlocked(project_id)
        if plugin_id in stored:
            remaining = {key: value for key, value in stored.items() if key != plugin_id}
            atomic_write_json(_grants_path(project_id), {
                "schema_version": SCHEMA_VERSION, "grants": remaining,
            })
    return active_grants(project_id)
