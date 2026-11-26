"""Windows permissions for atomic replacement of provider credentials."""
from __future__ import annotations

import stat
import sys
from pathlib import Path

from character_workflow.lib.private_json import _windows_acl, windows_user_sid


def restrict_keys_file_windows(path: Path) -> None:
    if sys.platform == "win32":
        _windows_acl(path, restrict=True)


def repair_legacy_keys_acl(path: Path) -> bool:
    """Recognize the original owner-only read/write ACE, which omitted DELETE."""
    import ntsecuritycon
    import pywintypes
    import win32security

    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        return False
    try:
        descriptor = win32security.GetNamedSecurityInfo(
            str(path), win32security.SE_FILE_OBJECT, win32security.DACL_SECURITY_INFORMATION,
        )
        acl = descriptor.GetSecurityDescriptorDacl()
        if acl is None:
            return False
        entries = (acl.GetAce(i) for i in range(acl.GetAceCount()))
        explicit = [ace for ace in entries if not ace[0][1] & win32security.INHERITED_ACE]
        if len(explicit) != 1:
            return False
        ace = explicit[0]
        old_mask = ntsecuritycon.FILE_GENERIC_READ | ntsecuritycon.FILE_GENERIC_WRITE
        if (ace[0][0] != win32security.ACCESS_ALLOWED_ACE_TYPE or ace[1] != old_mask
                or ace[2] != windows_user_sid()):
            return False
        restrict_keys_file_windows(path)
        return True
    except pywintypes.error as error:
        raise OSError(None, error.strerror, None, error.winerror) from error
