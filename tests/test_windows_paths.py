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
        alias="x", provider="lovart", access_key="a", secret_key="b",
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
