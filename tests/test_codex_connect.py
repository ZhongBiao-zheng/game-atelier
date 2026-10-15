from __future__ import annotations

import sys
import tomllib

from fastapi.testclient import TestClient

from character_workflow.lib import data_root
from character_workflow.lib.private_json import read_private_json
from tests.test_local_connection_auth import ORIGIN, bootstrap, client  # noqa: F401

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


def test_enabling_writes_codex_entry_and_keeps_user_content(client, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    path = tmp_path / "config.toml"
    path.write_text(EXISTING, encoding="utf-8")
    bootstrap(client)
    assert client.put("/api/connection/agent", json={}).json()["enabled"] is True
    text = path.read_text(encoding="utf-8")
    assert "# 用户自己的注释" in text
    config = tomllib.loads(text)
    assert config["model"] == "gpt-5"
    assert config["mcp_servers"]["blender"] == {"command": "uvx", "args": ["blender-mcp"]}
    assert config["mcp_servers"]["game-atelier"] == {
        "command": sys.executable,
        "args": ["-m", "character_workflow.mcp", "--client", "codex"],
        "startup_timeout_sec": 30,
    }


def test_enabling_creates_codex_config_only_when_codex_is_installed(client, tmp_path, monkeypatch):  # noqa: F811
    bootstrap(client)
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "absent"))
    assert client.put("/api/connection/agent", json={}).status_code == 200
    assert not (tmp_path / "absent").exists()
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    client.put("/api/connection/agent", json={})
    entry = tomllib.loads((tmp_path / "config.toml").read_text())["mcp_servers"]["game-atelier"]
    assert entry["args"][-2:] == ["--client", "codex"]


def test_invalid_codex_config_is_reported_and_left_untouched(client, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    path = tmp_path / "config.toml"
    path.write_text("[mcp_servers\n", encoding="utf-8")
    bootstrap(client)
    response = client.put("/api/connection/agent", json={})
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "CODEX_CONFIG_INVALID"
    assert path.read_text(encoding="utf-8") == "[mcp_servers\n"
    # Claude Code 不受 Codex 配置坏掉的影响：开关照样是开的。
    assert client.get("/api/connection/agent").json()["enabled"] is True


def test_status_reports_which_hosts_connected(client, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "absent"))
    bootstrap(client)
    assert client.get("/api/connection/agent").json() == {"enabled": False, "connections": {}}
    assert client.put("/api/connection/agent", json={}).json() == {"enabled": True, "connections": {}}
    credential = read_private_json(data_root.agent_credential_file())
    native = TestClient(client.app, base_url=ORIGIN)
    payload = {"grant_id": credential["grant_id"], "grant_token": credential["grant_token"],
               "instance_id": client.get("/api/connection/status").json()["instance_id"]}
    assert native.post("/api/connection/agent-sessions", json={**payload, "client": "codex"}).status_code == 200
    assert native.post("/api/connection/agent-sessions", json=payload).status_code == 200
    assert list(client.get("/api/connection/agent").json()["connections"]) == ["codex"]
    assert native.post("/api/connection/agent-sessions",
                       json={**payload, "client": "cursor"}).status_code == 422
    # 关掉开关：状态清空，旧凭据换不到会话。
    assert client.request("DELETE", "/api/connection/agent", json={}).json() == {
        "enabled": False, "connections": {},
    }
    assert native.post("/api/connection/agent-sessions", json=payload).status_code == 403
