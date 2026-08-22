"""Draft processor with atomic rename — eliminates list/process/move race.
T5: 原子 rename 消除"列出文件 → 处理 → 移动"竞态窗口。
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root


_CHARACTER_PREFIX = "<!-- character: "


def _runtime_dir() -> Path:
    return data_root.runtime_dir()


def _belongs_to_character(path: Path, character_id: str) -> bool:
    try:
        first_line = path.read_text(encoding="utf-8").splitlines()[0]
    except (OSError, IndexError):
        return False
    return first_line == f"{_CHARACTER_PREFIX}{character_id} -->"


def process_drafts(character_id: str) -> list[dict[str, str]]:
    runtime = _runtime_dir()
    draft_dir = runtime / "draft"
    processing_dir = runtime / "processing"
    processed_dir = runtime / "draft-processed"
    processing_dir.mkdir(parents=True, exist_ok=True)
    processed_dir.mkdir(parents=True, exist_ok=True)

    batch_ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    snapshot: list[Path] = []
    for src in sorted(draft_dir.glob("*.md")):
        if not _belongs_to_character(src, character_id):
            continue
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
