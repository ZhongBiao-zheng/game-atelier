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
    assert response.json()["error"]["code"] == "CLIENT_CONFIG_INVALID"
    assert path.read_text(encoding="utf-8") == "[mcp_servers\n"
    # Claude Code 不受 Codex 配置坏掉的影响：开关照样是开的。
    assert client.get("/api/connection/agent").json()["enabled"] is True


def test_status_reports_which_hosts_connected(client, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "absent"))
    bootstrap(client)
    from character_workflow.mcp.tool_catalog import TOOL_DEFINITIONS

    from viewer_server.agent_clients import status

    metadata = {
        "credential_path": str(data_root.agent_credential_file()),
        "clients": status(sys.executable),
        "tools": [{"name": tool.name, "billable": tool.billable} for tool in TOOL_DEFINITIONS],
    }
    assert metadata["clients"][1]["path"] == str(tmp_path / "absent" / "config.toml")
    assert client.get("/api/connection/agent").json() == {"enabled": False, "connections": {}, **metadata}
    assert client.put("/api/connection/agent", json={}).json() == {"enabled": True, "connections": {}, **metadata}
    credential = read_private_json(data_root.agent_credential_file())
    native = TestClient(client.app, base_url=ORIGIN)
    payload = {"grant_id": credential["grant_id"], "grant_token": credential["grant_token"],
               "instance_id": client.get("/api/connection/status").json()["instance_id"]}
    assert native.post("/api/connection/agent-sessions", json={**payload, "client": "codex"}).status_code == 200
    assert native.post("/api/connection/agent-sessions", json=payload).status_code == 200
    assert list(client.get("/api/connection/agent").json()["connections"]) == ["codex"]
    assert native.post("/api/connection/agent-sessions",
                       json={**payload, "client": "cursor"}).status_code == 200
    assert native.post("/api/connection/agent-sessions",
                       json={**payload, "client": "unknown-host"}).status_code == 422
    # 关掉开关：状态清空，旧凭据换不到会话。
    assert client.request("DELETE", "/api/connection/agent", json={}).json() == {
        "enabled": False, "connections": {}, **metadata,
    }
    assert native.post("/api/connection/agent-sessions", json=payload).status_code == 403


def _codex_entry(tmp_path):
    return tomllib.loads((tmp_path / "config.toml").read_text(encoding="utf-8"))["mcp_servers"]["game-atelier"]


def test_bundle_codex_entry_starts_through_bootstrap(client, tmp_path, monkeypatch):  # noqa: F811
    # 运行包的解释器里没有装本项目，Codex 直接 `python -m character_workflow.mcp` 会找不到模块；
    # 要和 Claude Code 插件一样经 bootstrap --run 带上 PYTHONPATH 启动。
    from pathlib import Path

    repo = Path(__file__).resolve().parents[1]
    monkeypatch.setattr(sys, "executable", str(repo.parent / "python" / "bin" / "python3"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "config.toml").write_text("", encoding="utf-8")
    bootstrap(client)
    client.put("/api/connection/agent", json={})
    assert _codex_entry(tmp_path)["args"] == [
        str(repo / "scripts" / "bootstrap.py"), "--run",
        "-m", "character_workflow.mcp", "--client", "codex",
    ]


def test_codex_entry_follows_the_runtime_after_an_update(tmp_path, monkeypatch):
    # 更新器只保留三个版本目录：开关打开时写下的解释器路径会在两次更新后被删掉。
    # 新版本启动时要把已有条目改写成当前解释器，Codex 才不会突然失去 Atelier 工具。
    from viewer_server.server_app import build_app

    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "config.toml").write_text("", encoding="utf-8")
    monkeypatch.setattr(sys, "executable", "/install/versions/0.5.1/python/bin/python3")
    first = TestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN)
    bootstrap(first)
    first.put("/api/connection/agent", json={})
    assert _codex_entry(tmp_path)["command"] == "/install/versions/0.5.1/python/bin/python3"

    monkeypatch.setattr(sys, "executable", "/install/versions/0.5.2/python/bin/python3")
    with TestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN):
        pass
    assert _codex_entry(tmp_path)["command"] == "/install/versions/0.5.2/python/bin/python3"


def test_startup_leaves_codex_config_alone_when_agent_is_off(tmp_path, monkeypatch):
    from viewer_server.server_app import build_app

    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    (tmp_path / "config.toml").write_text(EXISTING, encoding="utf-8")
    with TestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN):
        pass
    assert (tmp_path / "config.toml").read_text(encoding="utf-8") == EXISTING
