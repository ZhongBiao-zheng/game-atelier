"""Cross-platform path resolution + Windows-only ACL smoke test."""
from __future__ import annotations

import sys

import pytest


def test_venv_python_posix(monkeypatch, isolated_data_root):
    if sys.platform == "win32":
        pytest.skip("POSIX-only assertion")
    from character_workflow.lib import data_root
    monkeypatch.setattr("character_workflow.lib.data_root.sys.platform", "linux")
    result = data_root.venv_python()
    assert result.name == "python"
    assert result.parent.name == "bin"


def test_venv_python_windows_via_monkeypatch(monkeypatch, isolated_data_root):
    from character_workflow.lib import data_root
    monkeypatch.setattr("character_workflow.lib.data_root.sys.platform", "win32")
    result = data_root.venv_python()
    assert result.name == "python.exe"
    assert result.parent.name == "Scripts"


def test_uv_install_command_windows(monkeypatch):
    import scripts.bootstrap as bs
    monkeypatch.setattr(bs.sys, "platform", "win32")
    cmd = bs._uv_install_instruction()
    assert "powershell" in cmd
    assert "irm" in cmd


def test_uv_install_command_posix(monkeypatch):
    import scripts.bootstrap as bs
    monkeypatch.setattr(bs.sys, "platform", "linux")
    cmd = bs._uv_install_instruction()
    assert "curl" in cmd


def test_win_acl_module_is_noop_on_posix(tmp_path):
    if sys.platform == "win32":
        pytest.skip("POSIX-only test")
    from character_workflow.lib.win_acl import restrict_keys_file_windows
    p = tmp_path / "fake-keys.json"
    p.write_text("{}")
    restrict_keys_file_windows(p)  # must not raise on POSIX


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only ACL test")
def test_keys_file_acl_restricts_to_owner(isolated_data_root):
    from character_workflow.lib import data_root, keys
    keys.add_key(keys.KeySpec(
        alias="x", provider="seedream", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    import win32security
    sd = win32security.GetFileSecurity(
        str(data_root.keys_file()),
        win32security.DACL_SECURITY_INFORMATION,
    )
    dacl = sd.GetSecurityDescriptorDacl()
    assert dacl.GetAceCount() >= 1


@pytest.mark.skipif(sys.platform != "win32", reason="Requires NTFS ACLs")
def test_provider_save_in_modify_only_directory_replaces_legacy_file(isolated_data_root):
    """v5.142 protected the temp/target with read+write; Modify directories lack DELETE_CHILD."""
    import ntsecuritycon
    import win32security
    from character_workflow.lib import data_root, keys
    from character_workflow.lib.private_json import windows_user_sid

    path = data_root.keys_file()
    spec = keys.KeySpec(alias="tuzi", provider="custom", access_key="test",
                        created_at="2026-05-22T00:00:00Z")
    keys.add_key(spec)
    sid = windows_user_sid()

    def restrict(item, mask):
        acl = win32security.ACL()
        acl.AddAccessAllowedAce(win32security.ACL_REVISION, mask, sid)
        flags = win32security.DACL_SECURITY_INFORMATION | win32security.PROTECTED_DACL_SECURITY_INFORMATION
        win32security.SetNamedSecurityInfo(str(item), win32security.SE_FILE_OBJECT, flags, None, None, acl, None)

    restrict(path.parent, ntsecuritycon.FILE_ALL_ACCESS & ~ntsecuritycon.FILE_DELETE_CHILD)
    try:
        restrict(path, ntsecuritycon.FILE_GENERIC_READ | ntsecuritycon.FILE_GENERIC_WRITE)
        # Reproduce the release writer's restricted temp file before checking the fixed API.
        legacy_tmp = path.with_suffix(".probe")
        legacy_tmp.write_bytes(path.read_bytes())
        restrict(legacy_tmp, ntsecuritycon.FILE_GENERIC_READ | ntsecuritycon.FILE_GENERIC_WRITE)
        try:
            with pytest.raises(PermissionError):
                legacy_tmp.replace(path)
        finally:
            if legacy_tmp.exists():
                restrict(legacy_tmp, ntsecuritycon.FILE_ALL_ACCESS)
                legacy_tmp.unlink()
        keys.patch_key("tuzi", {"models": ["gpt-image-2.6"]})
        keys.add_key(spec.model_copy(update={"alias": "openrouter", "provider": "openrouter"}))
        assert [item.alias for item in keys.read_keys_db().keys] == ["tuzi", "openrouter"]
        assert keys.find_by_alias("tuzi").models[0].id == "gpt-image-2.6"
        descriptor = win32security.GetFileSecurity(str(path), win32security.DACL_SECURITY_INFORMATION)
        acl = descriptor.GetSecurityDescriptorDacl()
        assert acl.GetAceCount() == 1
        _, mask, trustee = acl.GetAce(0)
        assert trustee == sid and mask & ntsecuritycon.DELETE
    finally:
        restrict(path.parent, ntsecuritycon.FILE_ALL_ACCESS)
