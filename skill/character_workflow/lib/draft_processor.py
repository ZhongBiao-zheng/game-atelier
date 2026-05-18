"""Draft processor with atomic rename — eliminates list/process/move race.
T5: 原子 rename 消除"列出文件 → 处理 → 移动"竞态窗口。
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path


def _runtime_dir() -> Path:
    return Path(os.environ.get("RUNTIME_DIR", ".runtime"))


def process_drafts() -> list[dict[str, str]]:
    runtime = _runtime_dir()
    draft_dir = runtime / "draft"
    processing_dir = runtime / "processing"
    processed_dir = runtime / "draft-processed"
    processing_dir.mkdir(parents=True, exist_ok=True)
    processed_dir.mkdir(parents=True, exist_ok=True)

    batch_ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    snapshot: list[Path] = []
    for src in sorted(draft_dir.glob("*.md")):
        dst = processing_dir / f"{batch_ts}-{src.name}"
        try:
            src.rename(dst)
        except FileNotFoundError:
            continue
        snapshot.append(dst)

    results: list[dict[str, str]] = []
    for path in snapshot:
        results.append({"path": str(path), "content": path.read_text(encoding="utf-8")})

    for path in snapshot:
        final = processed_dir / path.name
        path.rename(final)

    return results
