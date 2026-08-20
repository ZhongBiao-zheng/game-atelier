"""Import existing character art into the managed data-root asset slots."""
from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from character_workflow.lib import data_root
from character_workflow.lib.schemas import AssetSlot


_IMPORTABLE_SLOTS = {AssetSlot.PORTRAIT, AssetSlot.TURNAROUND}
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_once(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if _sha256(target) != _sha256(source):
            raise ValueError(f"目标文件已存在但内容不同: {target}")
        return
    shutil.copy2(source, target)


def import_reference(
    character_id: str,
    source_path: str | Path,
    slot: AssetSlot,
) -> dict[str, str]:
    """Back up one existing image and register it in a typed asset slot.

    Imported files deliberately do not update canonical.json: canonical selection
    remains a separate, explicit artist decision.
    """
    if slot not in _IMPORTABLE_SLOTS:
        raise ValueError("参考素材只能归档到 portrait 或 turnaround")

    characters_dir = data_root.characters_dir().resolve()
    character_dir = (characters_dir / character_id).resolve()
    if character_dir.parent != characters_dir or not character_dir.is_dir():
        raise FileNotFoundError(f"角色目录不存在: {character_id}")

    source = Path(source_path).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(f"参考图不存在: {source}")
    if source.stat().st_size == 0:
        raise ValueError(f"参考图是空文件: {source}")
    suffix = source.suffix.lower()
    if suffix not in _IMAGE_SUFFIXES:
        raise ValueError(f"不支持的参考图格式: {suffix or '无扩展名'}")

    digest = _sha256(source)
    filename = f"reference-{digest[:12]}{suffix}"
    backup = character_dir / "source" / filename
    registered = character_dir / slot.value / filename
    _copy_once(source, backup)
    _copy_once(source, registered)

    root = data_root.resolve_data_root().resolve()
    return {
        "character_id": character_id,
        "slot": slot.value,
        "source_path": backup.relative_to(root).as_posix(),
        "slot_path": registered.relative_to(root).as_posix(),
    }
