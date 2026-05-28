"""一次性脚本：把所有 .runtime/jobs/<id>.json 从老 schema 升级到新 schema.

老格式: {"kind": "portrait"|"promo"|"turnaround", ...}
新格式: {"asset_slot": ..., "kind": "image", "namespace": "character", ...}

幂等：只要含 "asset_slot" 就跳过. 不联合 "namespace" 判断 —— 若文件已半迁移
(asset_slot 已设但 namespace 缺失), 二次 pop("kind") 会拿到 "image" 把 asset_slot
覆盖成 "image" 造成损坏. 半迁移极少见, 真出现需人工修.

用法：CHARACTER_WORKFLOW_DATA_ROOT=/path/to/data uv run python scripts/migrate_jobs_2026_05_25.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def migrate(data_root: Path) -> tuple[int, int, int]:
    jobs_dir = data_root / ".runtime" / "jobs"
    if not jobs_dir.exists():
        print(f"[skip] {jobs_dir} 不存在")
        return 0, 0, 0
    migrated = skipped = errored = 0
    for path in sorted(jobs_dir.glob("*.json")):
        try:
            raw = json.loads(path.read_text())
        except Exception as e:
            print(f"[err] {path.name}: {e}")
            errored += 1
            continue
        if "asset_slot" in raw:
            skipped += 1
            continue
        old_kind = raw.pop("kind", "portrait")
        raw["asset_slot"] = old_kind
        raw["namespace"] = "character"
        raw["kind"] = "image"
        # atomic rename
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(raw, indent=2, ensure_ascii=False))
        tmp.replace(path)
        migrated += 1
    print(f"migrated={migrated} skipped={skipped} errored={errored}")
    return migrated, skipped, errored


if __name__ == "__main__":
    data_root_env = os.environ.get("CHARACTER_WORKFLOW_DATA_ROOT")
    if not data_root_env:
        print("set CHARACTER_WORKFLOW_DATA_ROOT", file=sys.stderr)
        sys.exit(2)
    migrate(Path(data_root_env))
