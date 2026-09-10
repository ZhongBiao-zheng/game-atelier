"""Application-level Canvas UI preferences, intentionally outside project packages."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from pydantic import ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import (
    CanvasGenerationDefaults,
    CanvasImageToolbarPreferences,
    CanvasUiPreferences,
    CanvasUiPreferencesUpdate,
)


DEFAULT_IMAGE_TOOL_IDS = [
    "info",
    "download",
    "crop",
    "split",
    "removeBackground",
    "upscale",
]


class CanvasUiPreferencesError(Exception):
    """The persisted application preference file cannot be trusted."""


class CanvasUiRevisionConflict(Exception):
    def __init__(self, current_revision: int):
        super().__init__(f"canvas UI preference revision conflict: {current_revision}")
        self.current_revision = current_revision


def default_canvas_ui_preferences() -> CanvasUiPreferences:
    return CanvasUiPreferences(
        image_toolbar=CanvasImageToolbarPreferences(
            tool_ids=DEFAULT_IMAGE_TOOL_IDS,
        ),
        generation_defaults=CanvasGenerationDefaults(),
    )


def _read_unlocked() -> CanvasUiPreferences:
    path = data_root.canvas_ui_file()
    if not path.exists():
        return default_canvas_ui_preferences()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        # Trigger: 5.48.1 曾把「显示按钮文字」存成 image_toolbar.show_labels，5.49.1 起文字常显、字段退役
        # Why: schema 是 extra=forbid，不丢这个键，升级前写过偏好的用户会被判成文件损坏
        # Outcome: 只丢这一个键，其余内容照常严格校验
        if isinstance(raw, dict) and isinstance(raw.get("image_toolbar"), dict):
            raw["image_toolbar"].pop("show_labels", None)
        # strict 模式下 datetime 只在 JSON 校验路径接受字符串，所以丢键后仍走 JSON 校验。
        return CanvasUiPreferences.model_validate_json(json.dumps(raw))
    except (OSError, ValidationError, json.JSONDecodeError) as error:
        raise CanvasUiPreferencesError(
            "Canvas 界面偏好文件损坏，请检查 .config/canvas-ui.json"
        ) from error


def read_canvas_ui_preferences() -> CanvasUiPreferences:
    return _read_unlocked()


def save_canvas_ui_preferences(payload: CanvasUiPreferencesUpdate) -> CanvasUiPreferences:
    path = data_root.canvas_ui_file()
    with file_lock(path.with_suffix(".lock")):
        current = _read_unlocked()
        if current.revision != payload.expected_revision:
            raise CanvasUiRevisionConflict(current.revision)
        updated = CanvasUiPreferences(
            revision=current.revision + 1,
            image_toolbar=payload.image_toolbar,
            generation_defaults=payload.generation_defaults,
            updated_at=datetime.now(timezone.utc),
        )
        atomic_write_json(path, updated.model_dump(mode="json", exclude_none=True))
        return updated
