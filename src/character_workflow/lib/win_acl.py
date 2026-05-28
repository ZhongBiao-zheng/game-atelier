"""Windows ACL helpers — restrict keys.json to owner only.

On non-Windows platforms this module's functions are no-ops.
keys.py calls restrict_keys_file_windows() after writing keys.json.
"""
from __future__ import annotations

import sys
from pathlib import Path


def restrict_keys_file_windows(path: Path) -> None:
    """Set DACL on path to owner-only read/write. No-op on non-Windows or if pywin32 missing."""
    if sys.platform != "win32":
        return
    try:
        import os
        import ntsecuritycon
        import win32security
    except ImportError:
        return

    user_sid, _, _ = win32security.LookupAccountName("", os.getlogin())
    sd = win32security.SECURITY_DESCRIPTOR()
    dacl = win32security.ACL()
    dacl.AddAccessAllowedAce(
        win32security.ACL_REVISION,
        ntsecuritycon.FILE_GENERIC_READ | ntsecuritycon.FILE_GENERIC_WRITE,
        user_sid,
    )
    sd.SetSecurityDescriptorDacl(1, dacl, 0)
    win32security.SetFileSecurity(
        str(path), win32security.DACL_SECURITY_INFORMATION, sd,
    )
