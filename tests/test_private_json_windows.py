"""Windows credentials must have a user owner as well as a user-only DACL."""
import os
import sys
from types import SimpleNamespace

import pytest

from character_workflow.lib.private_json import _windows_acl, read_private_json, write_private_json


class _WinError(Exception):
    def __init__(self, winerror, funcname, strerror):
        super().__init__(winerror, funcname, strerror)
        self.winerror, self.funcname, self.strerror = winerror, funcname, strerror


def _fake_win32(monkeypatch, owner, set_security=None):
    state = SimpleNamespace(owner=owner, dacl=None, closed=False, writes=[])

    class ACL:
        def __init__(self):
            self.entries = []

        def AddAccessAllowedAce(self, revision, mask, sid):
            self.entries.append(((0, 0), mask, sid))

        def GetAceCount(self):
            return len(self.entries)

        def GetAce(self, index):
            return self.entries[index]

    def record(path, kind, flags, new_owner, group, dacl, sacl):
        state.writes.append(flags)
        if flags & 1:
            state.owner = new_owner
        state.dacl = dacl

    descriptor = SimpleNamespace(GetSecurityDescriptorOwner=lambda: state.owner,
                                 GetSecurityDescriptorDacl=lambda: state.dacl)
    monkeypatch.setitem(sys.modules, "pywintypes", SimpleNamespace(error=_WinError))
    monkeypatch.setitem(sys.modules, "ntsecuritycon", SimpleNamespace(FILE_ALL_ACCESS=0x1F01FF))
    monkeypatch.setitem(sys.modules, "win32api", SimpleNamespace(GetCurrentProcess=lambda: 1))
    monkeypatch.setitem(sys.modules, "win32con", SimpleNamespace(TOKEN_QUERY=8))
    monkeypatch.setitem(sys.modules, "win32security", SimpleNamespace(
        OpenProcessToken=lambda *_: SimpleNamespace(Close=lambda: setattr(state, "closed", True)),
        GetTokenInformation=lambda *_: ("current-user", 0), TokenUser=1,
        ACL=ACL, ACL_REVISION=2, SE_FILE_OBJECT=1, ACCESS_ALLOWED_ACE_TYPE=0,
        OWNER_SECURITY_INFORMATION=1, DACL_SECURITY_INFORMATION=4,
        PROTECTED_DACL_SECURITY_INFORMATION=0x80000000,
        SetNamedSecurityInfo=set_security or record, GetNamedSecurityInfo=lambda *_: descriptor,
    ))
    return state


def test_restrict_explicitly_sets_user_owner_before_validating_acl(monkeypatch, tmp_path):
    state = _fake_win32(monkeypatch, "administrators")
    path = tmp_path / "credential.json"
    _windows_acl(path, restrict=True)
    assert state.owner == "current-user" and state.closed
    assert state.writes == [1 | 4 | 0x80000000]
    assert state.dacl.GetAce(0)[2] == "current-user"
    state.owner = "administrators"
    with pytest.raises(PermissionError, match="belong"):
        _windows_acl(path)
    assert len(state.writes) == 1  # Reading an unsafe file never repairs or trusts it.


def test_restrict_keeps_owner_when_already_current_user(monkeypatch, tmp_path):
    # Folders granting only "Modify" (e.g. on D:\) deny WRITE_OWNER; rewriting the DACL still works.
    state = _fake_win32(monkeypatch, "current-user")
    _windows_acl(tmp_path / "credential.json", restrict=True)
    assert state.writes == [4 | 0x80000000]
    assert state.dacl.GetAce(0)[2] == "current-user"


def test_win32_failure_surfaces_as_os_error(monkeypatch, tmp_path):
    def deny(*_):
        raise _WinError(5, "SetNamedSecurityInfo", "Access is denied.")

    _fake_win32(monkeypatch, "administrators", set_security=deny)
    with pytest.raises(OSError, match="SetNamedSecurityInfo: Access is denied"):
        _windows_acl(tmp_path / "credential.json", restrict=True)


@pytest.mark.skipif(os.name != "nt", reason="Requires native Windows file security")
def test_native_windows_credential_owner_and_unsafe_dacl_rejection(tmp_path):
    import ntsecuritycon
    import win32api
    import win32con
    import win32security

    path = tmp_path / "credential.json"
    write_private_json(path, {"token": "test-only"})
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        owner = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()
    descriptor = win32security.GetNamedSecurityInfo(
        str(path), win32security.SE_FILE_OBJECT,
        win32security.OWNER_SECURITY_INFORMATION | win32security.DACL_SECURITY_INFORMATION)
    assert descriptor.GetSecurityDescriptorOwner() == owner
    assert read_private_json(path) == {"token": "test-only"}
    dacl = descriptor.GetSecurityDescriptorDacl()
    dacl.AddAccessAllowedAce(win32security.ACL_REVISION, ntsecuritycon.FILE_GENERIC_READ,
                             win32security.CreateWellKnownSid(win32security.WinWorldSid))
    win32security.SetNamedSecurityInfo(
        str(path), win32security.SE_FILE_OBJECT, win32security.DACL_SECURITY_INFORMATION,
        None, None, dacl, None)
    with pytest.raises(PermissionError, match="another principal"):
        read_private_json(path)
