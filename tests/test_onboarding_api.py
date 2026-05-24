import os

import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def client(isolated_data_root):
    return TestClient(build_app())


def test_onboarding_status_returns_bootstrap_check_payload(client):
    resp = client.get("/api/onboarding/status")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert data["status"] in (
        "needs_data_root", "needs_uv", "needs_venv",
        "needs_first_key", "needs_keys_repair", "ready",
    )
    assert "platform" in data


def test_post_data_root_writes_global_config(client, tmp_path, monkeypatch):
    new_root = tmp_path / "switched-root"
    cfg_home = tmp_path / "cfg"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg_home))
    monkeypatch.setenv("APPDATA", str(cfg_home))
    # Clear the data-root override so bootstrap writes to global config
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", "")
    resp = client.post("/api/onboarding/data-root", json={"path": str(new_root)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["data_root"] == str(new_root.resolve())
    assert new_root.exists()
    for sub in (".config", ".runtime", "projects", "characters"):
        assert (new_root / sub).is_dir()


def test_post_data_root_validates_payload(client):
    resp = client.post("/api/onboarding/data-root", json={})
    assert resp.status_code == 422


# Silence unused import warning when running this file standalone.
_ = os
