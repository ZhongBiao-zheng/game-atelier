"""Accent themes: user-saved themes, edits to built-in themes and the active choice.

Stored in `.config/accent-themes.json` so the desktop shell and the browser share them
(localStorage is per origin, and the port may shift when 5174 is taken).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from pydantic import ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import AccentThemes, AccentThemesUpdate


class AccentThemesError(Exception):
    """The persisted file cannot be trusted; its bytes are left untouched."""


class AccentThemesRevisionConflict(Exception):
    def __init__(self, current_revision: int):
        super().__init__(f"accent themes revision conflict: {current_revision}")
        self.current_revision = current_revision


def _read_unlocked() -> AccentThemes:
    path = data_root.accent_themes_file()
    if not path.exists():
        return AccentThemes()
    try:
        return AccentThemes.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError, json.JSONDecodeError) as error:
        raise AccentThemesError("主题色文件损坏，请检查 .config/accent-themes.json") from error


def read_accent_themes() -> AccentThemes:
    return _read_unlocked()


def save_accent_themes(payload: AccentThemesUpdate) -> AccentThemes:
    path = data_root.accent_themes_file()
    with file_lock(path.with_suffix(".lock")):
        current = _read_unlocked()
        if current.revision != payload.expected_revision:
            raise AccentThemesRevisionConflict(current.revision)
        updated = AccentThemes(
            revision=current.revision + 1,
            active=payload.active,
            overrides=payload.overrides,
            custom=payload.custom,
            updated_at=datetime.now(timezone.utc),
        )
        atomic_write_json(path, updated.model_dump(mode="json", exclude_none=True))
        return updated
