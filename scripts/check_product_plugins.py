"""产品内插件的入库检查（ADR-0037）。

`check_plugin.py` 管的是 Claude Code Plugin 渠道（`.claude-plugin/`）；这里管 `plugins/<id>/`：
入库的包必须与源清单一致、文件摘要与磁盘一致、包里没有清单之外的文件。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

from character_workflow.lib.plugin_manifest import (  # noqa: E402
    PluginManifest,
    PluginPackageLock,
    package_digest,
)

LOCK_NAME = "manifest.lock.json"
# 服务端模块要生成内容只能走宿主的 Run 入口，这样成本统计与网关配额才覆盖得到。
_FORBIDDEN_IMPORT = re.compile(
    r"^\s*(?:from|import)\s+character_workflow\.lib\.(?:callers|job_runner)\b", re.MULTILINE)


def check_plugin(plugin_dir: Path) -> list[str]:
    name = plugin_dir.name
    try:
        source = json.loads((plugin_dir / "manifest.json").read_text(encoding="utf-8"))
        PluginManifest.model_validate(source)
    except (OSError, ValueError) as error:
        return [f"{name}: manifest.json 无效：{error}"]
    if source.get("id") != name:
        return [f"{name}: manifest.json 的 id 与目录名不一致"]
    package = plugin_dir / "package"
    try:
        raw = json.loads((package / LOCK_NAME).read_text(encoding="utf-8"))
        lock = PluginPackageLock.model_validate(raw)
    except (OSError, ValueError) as error:
        return [f"{name}: package/{LOCK_NAME} 无效，重新运行 make build：{error}"]
    errors: list[str] = []
    built_from = {key: value for key, value in raw.items() if key not in {"files", "digest", "source"}}
    if built_from != source:
        errors.append(f"{name}: 包与 manifest.json 不一致，重新运行 make build")
    if package_digest(raw) != lock.digest:
        errors.append(f"{name}: 包摘要与内容不一致")
    listed = {item.path: item for item in lock.files}
    on_disk = {
        path.relative_to(package).as_posix()
        for path in package.rglob("*") if path.is_file() and path.name != LOCK_NAME
    }
    for path in sorted(on_disk - set(listed)):
        errors.append(f"{name}: 包里有清单之外的文件 {path}")
    for path, item in sorted(listed.items()):
        target = package / path
        if not target.is_file():
            errors.append(f"{name}: 包里缺少 {path}")
            continue
        data = target.read_bytes()
        if len(data) != item.bytes or hashlib.sha256(data).hexdigest() != item.sha256:
            errors.append(f"{name}: {path} 与清单里的摘要不一致")
    declares_server = lock.contributes.server is not None
    server_dir = plugin_dir / "server"
    if declares_server != (server_dir / "__init__.py").is_file():
        errors.append(f"{name}: 清单的 contributes.server 与 server/ 目录不对应")
    for module in sorted(server_dir.rglob("*.py")) if server_dir.is_dir() else []:
        if _FORBIDDEN_IMPORT.search(module.read_text(encoding="utf-8")):
            errors.append(f"{name}: {module.relative_to(plugin_dir).as_posix()} 不能直接调用厂商或 Job Runner")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=REPO)
    root = parser.parse_args().repo / "plugins"
    plugin_dirs = sorted(path.parent for path in root.glob("*/manifest.json")) if root.is_dir() else []
    errors = [error for plugin_dir in plugin_dirs for error in check_plugin(plugin_dir)]
    for error in errors:
        print(f"FAIL: {error}")
    if errors:
        return 1
    print(f"OK: {len(plugin_dirs)} product plugin(s) checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
