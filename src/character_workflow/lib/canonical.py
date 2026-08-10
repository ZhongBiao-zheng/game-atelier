"""角色资产定稿（canonical）—— characters/<id>/canonical.json 唯一存储。

数据形态（A2，2026-08-10）：
{
  "portrait": {"path": "characters/<id>/portrait/v3.png", "set_at": "...", "spec_fingerprint": "..."},
  "promo": null,
  "turnaround": null
}

- path 一律存 data-root 相对路径（与 gallery sidecar 一致），写入前校验文件真实存在
  且落在该角色自己的 slot 目录下。
- spec_fingerprint = spec.md 的 visual_dna + anchors 两节内容 hash，供 A3 stale 检测比对。
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_text
from character_workflow.lib.schemas import AssetSlot, CanonicalEntry, CanonicalFile

_FINGERPRINT_SECTIONS = ("visual_dna", "anchors")


def _canonical_path(character_id: str) -> Path:
    return data_root.characters_dir() / character_id / "canonical.json"


def _extract_section(text: str, name: str) -> str:
    """抽出 spec.md 的 `## {name}` 节正文（到下一个同级或更高级 header 止）。"""
    lines = text.splitlines()
    out: list[str] = []
    capture = False
    for line in lines:
        stripped = line.strip()
        if stripped == f"## {name}":
            capture = True
            continue
        if capture and stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            if level <= 2:
                break
        if capture:
            out.append(line)
    return "\n".join(out).strip()


def spec_fingerprint(character_id: str) -> str:
    """visual_dna + anchors 内容 hash（12 hex）。spec 缺失 / 两节皆空 → ""。"""
    spec_path = data_root.characters_dir() / character_id / "spec.md"
    if not spec_path.exists():
        return ""
    try:
        text = spec_path.read_text(encoding="utf-8-sig")
    except OSError:
        return ""
    payload = "\n---\n".join(_extract_section(text, s) for s in _FINGERPRINT_SECTIONS)
    if not payload.strip("\n- "):
        return ""
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def read_canonical(character_id: str) -> CanonicalFile:
    p = _canonical_path(character_id)
    if not p.exists():
        return CanonicalFile()
    try:
        return CanonicalFile.model_validate(json.loads(p.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ValueError):
        # 损坏的 canonical 不应拖垮角色页 —— 当作未定稿，重新设定即自愈。
        return CanonicalFile()


def _write(character_id: str, file: CanonicalFile) -> CanonicalFile:
    atomic_write_text(_canonical_path(character_id), file.model_dump_json(indent=2))
    return file


def _normalize_rel_path(character_id: str, slot: AssetSlot, path: str) -> str:
    """绝对 / data-root 相对路径都接受；校验存在且在本角色 slot 目录下，返回相对路径。"""
    root = data_root.resolve_data_root().resolve()
    p = Path(path)
    abs_p = (p if p.is_absolute() else root / p).resolve()
    slot_dir = (data_root.characters_dir() / character_id / slot.value).resolve()
    if not abs_p.is_file():
        raise FileNotFoundError(f"canonical target not found: {abs_p}")
    if slot_dir not in abs_p.parents:
        raise ValueError(
            f"canonical target must live in {slot_dir}, got {abs_p}"
        )
    return abs_p.relative_to(root).as_posix()


def set_canonical(character_id: str, slot: AssetSlot, path: str) -> CanonicalFile:
    entry = CanonicalEntry(
        path=_normalize_rel_path(character_id, slot, path),
        set_at=datetime.now(timezone.utc).isoformat(),
        spec_fingerprint=spec_fingerprint(character_id),
    )
    file = read_canonical(character_id)
    setattr(file, slot.value, entry)
    return _write(character_id, file)


def clear_canonical(character_id: str, slot: AssetSlot) -> CanonicalFile:
    file = read_canonical(character_id)
    setattr(file, slot.value, None)
    return _write(character_id, file)
