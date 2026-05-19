"""character-workflow CLI — turn 起始一步合一，省 Python 冷启。

用法：
  python -m skill.character_workflow turn-start
  python -m skill.character_workflow set-active <id>
  python -m skill.character_workflow append-lesson --kind portrait --line "...经验..."
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from skill.character_workflow.lib.active_character import read_active, write_active
from skill.character_workflow.lib.context_loader import (
    load_lessons, load_worldview,
)
from skill.character_workflow.lib.draft_processor import process_drafts
from skill.character_workflow.lib.lessons import append_lesson


def _characters_dir() -> Path:
    return Path(os.environ.get("CHARACTERS_DIR", "characters"))


def _read_spec(active_id: str | None) -> str | None:
    if not active_id:
        return None
    p = _characters_dir() / active_id / "spec.md"
    if not p.exists():
        return None
    return p.read_text(encoding="utf-8")


def turn_start(kind: str = "portrait") -> dict:
    """一次拉齐：draft 反馈、活跃角色、当前 spec、项目世界观、历代经验。"""
    drafts = process_drafts()
    active = read_active()
    return {
        "drafts": drafts,
        "active_id": active.active_id,
        "active_updated_at": active.updated_at,
        "spec": _read_spec(active.active_id),
        "worldview": load_worldview(),
        "lessons": load_lessons(kind),
        "lessons_kind": kind,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="character-workflow")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_turn = sub.add_parser("turn-start", help="处理 draft + 读 active + spec + worldview + lessons")
    p_turn.add_argument("--kind", default="portrait", choices=("portrait", "promo", "turnaround"))

    p_set = sub.add_parser("set-active", help="切换活跃角色")
    p_set.add_argument("character_id", nargs="?", default=None)

    p_lesson = sub.add_parser("append-lesson", help="原子追加一条历代经验到 lessons/<kind>.md")
    p_lesson.add_argument("--kind", required=True, choices=("portrait", "promo", "turnaround"))
    p_lesson.add_argument("--line", required=True, help="完整一行 markdown，不带换行")

    args = parser.parse_args(argv)
    if args.cmd == "turn-start":
        print(json.dumps(turn_start(args.kind), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "set-active":
        result = write_active(args.character_id or None)
        print(json.dumps({"active_id": result.active_id, "updated_at": result.updated_at}, ensure_ascii=False))
        return 0
    if args.cmd == "append-lesson":
        path = append_lesson(args.kind, args.line)
        print(json.dumps({"ok": True, "path": str(path)}, ensure_ascii=False))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
