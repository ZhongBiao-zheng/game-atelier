"""Owner-only, bounded credential files; never fall back to an unchecked ACL."""
from __future__ import annotations

import json
import os
import stat
import uuid
from pathlib import Path
from typing import Any

from character_workflow.lib.atomic_io import _replace_with_retry


def _windows_acl(path: Path, *, restrict: bool = False) -> None:
    import ntsecuritycon
    import win32api
    import win32con
    import win32security

    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        owner = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()
    if restrict:
        dacl = win32security.ACL()
        dacl.AddAccessAllowedAce(win32security.ACL_REVISION, ntsecuritycon.FILE_ALL_ACCESS, owner)
        # An elevated token can default new files to the Administrators group owner.
        # Set both owner and protected ACL on our empty temporary before writing secrets.
        win32security.SetNamedSecurityInfo(
            str(path), win32security.SE_FILE_OBJECT,
            win32security.OWNER_SECURITY_INFORMATION | win32security.DACL_SECURITY_INFORMATION
            | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
            owner, None, dacl, None,
        )
    descriptor = win32security.GetNamedSecurityInfo(
        str(path), win32security.SE_FILE_OBJECT,
        win32security.OWNER_SECURITY_INFORMATION | win32security.DACL_SECURITY_INFORMATION,
    )
    dacl = descriptor.GetSecurityDescriptorDacl()
    if descriptor.GetSecurityDescriptorOwner() != owner or dacl is None or not dacl.GetAceCount():
        raise PermissionError("Credential must belong only to the current OS user")
    for index in range(dacl.GetAceCount()):
        header, _mask, sid = dacl.GetAce(index)
        if header[0] != win32security.ACCESS_ALLOWED_ACE_TYPE or sid != owner:
            raise PermissionError("Credential ACL grants another principal access")


def _check_path(path: Path) -> None:
    if any(parent.is_symlink() for parent in (path, *path.parents)):
        raise PermissionError("Credential path cannot contain symbolic links")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise PermissionError("Credential must be a regular file")
    if os.name == "nt":
        _windows_acl(path)
    elif info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise PermissionError("Credential must have owner-only 0600 permissions")


def read_private_json(path: Path, max_bytes: int = 16 * 1024) -> Any:
    path = Path(path).absolute()
    _check_path(path)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, "rb") as handle:
        opened = os.fstat(handle.fileno())
        current = path.stat()
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise PermissionError("Credential changed while opening")
        raw = handle.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError("Credential exceeds size limit")
    return json.loads(raw)


def write_private_json(path: Path, value: Any) -> None:
    path = Path(path).absolute()
    if any(parent.is_symlink() for parent in (path, *path.parents)):
        raise PermissionError("Credential path cannot contain symbolic links")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            if os.name == "nt":
                _windows_acl(temporary, restrict=True)
            handle.write(json.dumps(value, ensure_ascii=False).encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        _check_path(temporary)
        _replace_with_retry(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
