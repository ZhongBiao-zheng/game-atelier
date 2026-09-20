"""团队库：挂载记录、目录清单、本机显示名。只读写目录，不执行任何同步命令（ADR-0020）。"""
from __future__ import annotations

import os
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import (
    TeamLibraryManifest,
    TeamLibraryMount,
    TeamLibraryMountFile,
    UserProfile,
)

MANIFEST_NAME = ".atelier-library.json"
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_ulid() -> str:
    value = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    out = []
    for _ in range(26):
        out.append(_CROCKFORD[value & 31])
        value >>= 5
    return "".join(reversed(out))


def _profile_path() -> Path:
    return data_root.config_dir() / "profile.json"


def _mounts_path() -> Path:
    return data_root.config_dir() / "team-libraries.json"


def _mounts_lock() -> Path:
    return data_root.runtime_dir() / "locks" / "team-libraries.lock"


def read_profile() -> UserProfile | None:
    path = _profile_path()
    if not path.is_file():
        return None
    try:
        return UserProfile.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError):
        return None


def write_profile(display_name: str) -> UserProfile:
    profile = UserProfile(display_name=display_name.strip())
    atomic_write_json(_profile_path(), profile.model_dump(mode="json"))
    return profile


def _read_mounts_unlocked() -> TeamLibraryMountFile:
    path = _mounts_path()
    if not path.is_file():
        return TeamLibraryMountFile(mounts=[])
    try:
        return TeamLibraryMountFile.model_validate_json(path.read_text(encoding="utf-8"))
    except ValidationError as error:
        # 显式 fail-loud：挂载表坏了要让路由层报出是哪个文件，不能静默当成「没挂过库」。
        raise ValueError(f"挂载记录格式不对：{path}") from error


def _write_mounts_unlocked(mounts: list[TeamLibraryMount]) -> None:
    atomic_write_json(_mounts_path(), TeamLibraryMountFile(mounts=mounts).model_dump(mode="json"))


def list_mounts(project_id: str | None = None) -> list[TeamLibraryMount]:
    with file_lock(_mounts_lock()):
        rows = _read_mounts_unlocked().mounts
    return [m for m in rows if project_id is None or m.project_id == project_id]


def get_mount(library_id: str) -> TeamLibraryMount:
    for mount in list_mounts():
        if mount.library_id == library_id:
            return mount
    raise KeyError(library_id)


def read_manifest(mount_path: Path) -> TeamLibraryManifest:
    path = mount_path / MANIFEST_NAME
    if not path.is_file():
        raise FileNotFoundError(str(path))
    try:
        return TeamLibraryManifest.model_validate_json(path.read_text(encoding="utf-8"))
    except ValidationError as error:
        raise ValueError("团队库清单格式不对") from error


def library_reachable(mount: TeamLibraryMount) -> bool:
    return (Path(mount.mount_path) / MANIFEST_NAME).is_file()


def mount_library(
    *, project_id: str, path: str, name: str | None, created_by: str
) -> TeamLibraryMount:
    folder = Path(os.path.expandvars(os.path.expanduser(path))).resolve()
    if not folder.is_dir():
        raise FileNotFoundError(str(folder))
    try:
        manifest = read_manifest(folder)
    except FileNotFoundError:
        manifest = TeamLibraryManifest(
            library_id=f"lib_{secrets.token_hex(8)}",
            name=(name or folder.name).strip() or folder.name,
            created_at=_now(),
            created_by=created_by,
        )
        atomic_write_json(folder / MANIFEST_NAME, manifest.model_dump(mode="json"))
    mount = TeamLibraryMount(
        library_id=manifest.library_id,
        project_id=project_id,
        mount_path=str(folder),
        name=manifest.name,
        mounted_at=_now(),
    )
    with file_lock(_mounts_lock()):
        # 去重键是 (project_id, library_id)：同一个库在同一项目下 checkout 两份，后挂载的那份生效，
        # 保证 get_mount(library_id) 唯一。同时清掉同项目下路径相同的旧记录（库 id 被改写过的情况）。
        rows = [
            m
            for m in _read_mounts_unlocked().mounts
            if not (
                m.project_id == project_id
                and (m.library_id == manifest.library_id or Path(m.mount_path) == folder)
            )
        ]
        _write_mounts_unlocked([*rows, mount])
    return mount


def unmount_library(library_id: str, project_id: str) -> None:
    with file_lock(_mounts_lock()):
        rows = _read_mounts_unlocked().mounts
        kept = [
            m for m in rows if not (m.library_id == library_id and m.project_id == project_id)
        ]
        if len(kept) == len(rows):
            raise KeyError(library_id)
        _write_mounts_unlocked(kept)
