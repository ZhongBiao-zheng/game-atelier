"""界面偏好与已读记录：`<data_root>/.config/ui-prefs.json`。

为什么不放 localStorage：5174 被占时服务顺延到 5175，网页 origin 跟着变，localStorage 整个换一份，
公告会重弹、更新日志已读丢失。存在数据目录里就与端口无关（`accent-themes.json` 同理）。

每个键一个 JSON 值，整份写回；键名与总大小有上限，这里不是业务数据的存放处。
"""
from __future__ import annotations

import json
import re
from typing import Any

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import file_lock

KEY_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,63}$")
MAX_BYTES = 64 * 1024


class UiPrefsError(ValueError):
    """键名不合法或写入后超出大小上限。"""


def _path():
    return data_root.config_dir() / "ui-prefs.json"


def read_prefs() -> dict[str, Any]:
    try:
        value = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def set_pref(key: str, value: Any) -> dict[str, Any]:
    """写一个键；value 为 None 时删除。返回写后的全部偏好。"""
    if not KEY_PATTERN.fullmatch(key):
        raise UiPrefsError("偏好名称不合法")
    path = _path()
    with file_lock(path.with_suffix(".lock")):
        prefs = read_prefs()
        if value is None:
            prefs.pop(key, None)
        else:
            prefs[key] = value
        if len(json.dumps(prefs, ensure_ascii=False).encode("utf-8")) > MAX_BYTES:
            raise UiPrefsError("界面偏好超出大小上限")
        atomic_write_json(path, prefs)
    return prefs
