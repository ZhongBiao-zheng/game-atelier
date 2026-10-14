from __future__ import annotations

import sys
import tomllib
from pathlib import Path

from character_workflow.lib.private_json import read_private_json
from character_workflow.lib.projects import create_project
from tests.test_local_connection_auth import ORIGIN, bootstrap, client  # noqa: F401
from viewer_server.codex_config import codex_status, write_codex_entry

EXISTING = """# 用户自己的注释
model = "gpt-5"

[mcp_servers.blender]
command = "uvx"
args = ["blender-mcp"]

[mcp_servers.game-atelier]
command = "/old/python"
args = ["-m", "character_workflow.mcp"]
startup_timeout_sec = 30
"""


def test_write_creates_config_when_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    assert codex_status("/venv/python") == "missing"
    assert write_codex_entry("/venv/python") == "current"
    config = tomllib.loads((tmp_path / "codex" / "config.toml").read_text(encoding="utf-8"))
    assert config["mcp_servers"]["game-atelier"] == {
        "command": "/venv/python", "args": ["-m", "character_workflow.mcp", "--client", "codex"],
    }
    assert codex_status("/venv/python") == "current"
    assert codex_status("/other/python") == "outdated"


def test_write_replaces_only_own_entry_and_keeps_user_content(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    path = tmp_path / "config.toml"
    path.write_text(EXISTING, encoding="utf-8")
    assert codex_status("C:\\venv\\python.exe") == "outdated"
    write_codex_entry("C:\\venv\\python.exe")
    text = path.read_text(encoding="utf-8")
    assert "# 用户自己的注释" in text
    config = tomllib.loads(text)
    assert config["model"] == "gpt-5"
    assert config["mcp_servers"]["blender"] == {"command": "uvx", "args": ["blender-mcp"]}
    entry = config["mcp_servers"]["game-atelier"]
    assert entry["command"] == "C:\\venv\\python.exe"
    assert entry["args"][-2:] == ["--client", "codex"]
    assert entry["startup_timeout_sec"] == 30


def test_invalid_config_is_reported_and_left_untouched(client, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    path = tmp_path / "config.toml"
    path.write_text("[mcp_servers\n", encoding="utf-8")
    bootstrap(client)
    response = client.post("/api/connection/codex-config", json={})
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "CODEX_CONFIG_INVALID"
    assert path.read_text(encoding="utf-8") == "[mcp_servers\n"


def test_codex_config_route_is_local_management_only(client, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    assert client.get("/api/connection/codex-config").status_code == 401
    bootstrap(client)
    assert client.get("/api/connection/codex-config").json() == {
        "status": "missing", "path": str(tmp_path / "config.toml"),
    }
    response = client.post("/api/connection/codex-config", json={})
    assert response.json()["status"] == "current"
    assert tomllib.loads((tmp_path / "config.toml").read_text())["mcp_servers"]["game-atelier"][
        "command"] == sys.executable


def test_grants_report_which_clients_connected(client):  # noqa: F811
    bootstrap(client)
    project = create_project("连接状态")
    grant = client.post("/api/connection/agent-grants", json={
        "name": "本机 Agent", "project_ids": [project.id], "capabilities": ["read"], "default": True,
    }).json()
    assert grant["connections"] == {}
    assert client.get("/api/connection/agent-grants").json()["grants"][0]["connections"] == {}
    credential = read_private_json(Path(grant["credential_path"]))
    instance_id = client.get("/api/connection/status").json()["instance_id"]
    from fastapi.testclient import TestClient
    native = TestClient(client.app, base_url=ORIGIN)
    for agent in ("codex", None):
        payload = {"grant_id": credential["grant_id"], "grant_token": credential["grant_token"],
                   "instance_id": instance_id}
        assert native.post("/api/connection/agent-sessions",
                           json={**payload, **({"client": agent} if agent else {})}).status_code == 200
    connections = client.get("/api/connection/agent-grants").json()["grants"][0]["connections"]
    assert list(connections) == ["codex"]
    bad = native.post("/api/connection/agent-sessions", json={
        "grant_id": credential["grant_id"], "grant_token": credential["grant_token"],
        "instance_id": instance_id, "client": "cursor",
    })
    assert bad.status_code == 422
