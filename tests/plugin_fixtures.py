"""在临时目录里造插件包，让测试不依赖仓库里真实的官方插件。"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from character_workflow.lib import plugin_registry
from character_workflow.lib.plugin_manifest import package_digest

UI_HTML = b"<!doctype html><title>fixture</title>"


def manifest(plugin_id: str = "demo", **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "manifest_version": 1,
        "id": plugin_id,
        "name": "演示插件",
        "version": "1.0.0",
        "description": "测试用",
        "icon": "grid",
        "publisher": {"id": "atelier", "name": "Atelier"},
        "sdk_version": "1",
        "app_version": {"min": "1.0.0"},
        "ui": {"entry": "ui/index.html"},
        "capabilities": ["node.read_self", "node.write_self"],
        "contributes": {
            "nodes": [{
                "type": "demo", "title": "演示", "icon": "grid",
                "default_size": {"width": 320, "height": 240},
                "payload_schema_version": 1, "input_modalities": ["image"],
                "surfaces": ["node", "panel"],
            }],
        },
    }
    return {**base, **overrides}


def lock_for(source: dict[str, Any], files: dict[str, bytes]) -> dict[str, Any]:
    body = {
        **source,
        "files": [
            {"path": path, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
            for path, data in sorted(files.items())
        ],
        "source": "bundled",
    }
    return {**body, "digest": package_digest(body)}


def write_plugin(root: Path, plugin_id: str = "demo", *, lock: dict[str, Any] | None = None,
                 files: dict[str, bytes] | None = None, **overrides: Any) -> Path:
    files = {"ui/index.html": UI_HTML} if files is None else files
    package = root / plugin_id / "package"
    for path, data in files.items():
        target = package / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    package.mkdir(parents=True, exist_ok=True)
    content = lock if lock is not None else lock_for(manifest(plugin_id, **overrides), files)
    (package / "manifest.lock.json").write_text(json.dumps(content, ensure_ascii=False), encoding="utf-8")
    return package


def use_plugins_root(monkeypatch, root: Path, app_version: str = "5.137.0") -> None:
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(plugin_registry, "plugins_root", lambda: root)
    monkeypatch.setattr(plugin_registry, "app_version", lambda: app_version)
