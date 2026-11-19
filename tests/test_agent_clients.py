"""Agent 客户端接入：启动命令只有一套判断、一键写入只动自己那一条、服务启动时改写、只复制的客户端。"""
from __future__ import annotations

import json
import shlex
import sys
import tomllib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from viewer_server import agent_clients
from viewer_server.connection_auth import ConnectionError
from tests.test_local_connection_auth import ORIGIN, bootstrap, client  # noqa: F401

REPO = Path(__file__).resolve().parents[1]
BUNDLED = str(REPO.parent / "python" / "bin" / "python3")


def _home() -> Path:
    return agent_clients._home()


def test_launch_uses_bootstrap_only_for_the_bundled_interpreter():
    assert agent_clients.launch("/venv/bin/python", "cursor") == (
        "/venv/bin/python", ["-m", "character_workflow.mcp", "--client", "cursor"])
    assert agent_clients.launch(BUNDLED, "trae") == (BUNDLED, [
        str(REPO / "scripts" / "bootstrap.py"), "--run",
        "-m", "character_workflow.mcp", "--client", "trae"])


def test_snippets_parse_and_carry_no_credential():
    python = "/venv/bin/python"
    rows = {row["id"]: row for row in agent_clients.status(python)}
    assert list(rows) == list(agent_clients.CLIENT_IDS)
    assert shlex.split(rows["claude-code"]["snippet"]) == [
        "claude", "mcp", "add", "-s", "user", "atelier", "--",
        python, "-m", "character_workflow.mcp", "--client", "claude-code"]
    assert tomllib.loads(rows["codex"]["snippet"])["mcp_servers"]["game-atelier"]["args"][-1] == "codex"
    for name in ("cursor", "claude-desktop", "trae", "workbuddy"):
        entry = json.loads(rows[name]["snippet"])["mcpServers"]["atelier"]
        assert entry == {"command": python, "args": ["-m", "character_workflow.mcp", "--client", name]}
    assert {rows[c]["mode"] for c in ("trae", "workbuddy", "claude-code")} == {"copy"}
    assert all(row["written"] is False for row in rows.values())
    assert "token" not in json.dumps(list(rows.values()))


def test_write_keeps_other_servers_and_our_extra_keys(isolated_data_root):
    path = _home() / ".cursor" / "mcp.json"
    path.parent.mkdir(parents=True)
    original = {"mcpServers": {"github": {"command": "npx", "args": ["gh"]},
                               "atelier": {"command": "/old/python", "args": [], "env": {"X": "1"}}},
                "other": True}
    path.write_text(json.dumps(original), encoding="utf-8")
    agent_clients.write("cursor", "/venv/bin/python")
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["other"] is True and saved["mcpServers"]["github"] == original["mcpServers"]["github"]
    assert saved["mcpServers"]["atelier"] == {
        "command": "/venv/bin/python", "args": ["-m", "character_workflow.mcp", "--client", "cursor"],
        "env": {"X": "1"}}
    assert json.loads(path.with_name("mcp.json.atelier-backup").read_text(encoding="utf-8")) == original
    assert next(r for r in agent_clients.status("/venv/bin/python") if r["id"] == "cursor")["written"]


def test_write_refuses_missing_clients_unreadable_files_and_copy_only_clients(isolated_data_root):
    with pytest.raises(ConnectionError) as missing:
        agent_clients.write("cursor", "/venv/bin/python")
    assert missing.value.code == "CLIENT_NOT_FOUND"
    path = agent_clients.config_path("claude-desktop")
    path.parent.mkdir(parents=True)
    path.write_text("{ // 注释不是 JSON\n}", encoding="utf-8")
    with pytest.raises(ConnectionError) as broken:
        agent_clients.write("claude-desktop", "/venv/bin/python")
    assert broken.value.code == "CLIENT_CONFIG_INVALID"
    assert path.read_text(encoding="utf-8") == "{ // 注释不是 JSON\n}"
    for name in ("trae", "workbuddy", "claude-code"):
        with pytest.raises(ConnectionError) as refused:
            agent_clients.write(name, "/venv/bin/python")
        assert refused.value.code == "CLIENT_NOT_WRITABLE"


def test_refresh_rewrites_only_existing_entries_and_survives_a_broken_file(isolated_data_root,
                                                                          monkeypatch, tmp_path):
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex"))
    (tmp_path / "codex").mkdir()
    (tmp_path / "codex" / "config.toml").write_text("[mcp_servers\n", encoding="utf-8")
    cursor = _home() / ".cursor" / "mcp.json"
    cursor.parent.mkdir(parents=True)
    cursor.write_text(json.dumps({"mcpServers": {"atelier": {"command": "/v1/python", "args": []}}}))
    desktop = agent_clients.config_path("claude-desktop")
    desktop.parent.mkdir(parents=True)
    desktop.write_text(json.dumps({"mcpServers": {"other": {"command": "x"}}}))
    assert agent_clients.refresh_all("/v2/python") == ["cursor"]
    assert json.loads(cursor.read_text())["mcpServers"]["atelier"]["command"] == "/v2/python"
    assert json.loads(desktop.read_text()) == {"mcpServers": {"other": {"command": "x"}}}
    assert agent_clients.refresh_all("/v2/python") == []


def test_server_start_refreshes_every_written_client(tmp_path, monkeypatch):
    from viewer_server.server_app import build_app

    cursor = _home() / ".cursor" / "mcp.json"
    cursor.parent.mkdir(parents=True)
    monkeypatch.setattr(sys, "executable", "/install/versions/0.5.1/python/bin/python3")
    first = TestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN)
    bootstrap(first)
    first.put("/api/connection/agent", json={})
    assert first.post("/api/connection/agent/client-config",
                      json={"client": "cursor"}).status_code == 200
    monkeypatch.setattr(sys, "executable", "/install/versions/0.5.2/python/bin/python3")
    with TestClient(build_app(dist_dir=tmp_path), base_url=ORIGIN):
        pass
    assert json.loads(cursor.read_text())["mcpServers"]["atelier"]["command"] == \
        "/install/versions/0.5.2/python/bin/python3"


def test_client_config_route_requires_the_switch(client):  # noqa: F811
    (_home() / ".cursor").mkdir(parents=True)
    bootstrap(client)
    off = client.post("/api/connection/agent/client-config", json={"client": "cursor"})
    assert off.status_code == 409 and off.json()["error"]["code"] == "AGENT_DISABLED"
    client.put("/api/connection/agent", json={})
    on = client.post("/api/connection/agent/client-config", json={"client": "cursor"})
    assert on.status_code == 200
    assert next(r for r in on.json()["clients"] if r["id"] == "cursor")["written"] is True
    assert client.post("/api/connection/agent/client-config",
                       json={"client": "trae"}).status_code == 422
    assert client.post("/api/connection/agent/client-config",
                       json={"client": "nope"}).status_code == 422


def test_startup_does_not_restore_an_entry_the_user_removed(isolated_data_root):
    path = _home() / ".cursor" / "mcp.json"
    path.parent.mkdir(parents=True)
    agent_clients.write("cursor", "/v1/python")
    document = json.loads(path.read_text())
    del document["mcpServers"]["atelier"]
    path.write_text(json.dumps(document))
    assert agent_clients.refresh_all("/v2/python") == []
    assert json.loads(path.read_text()) == {"mcpServers": {}}


def test_trae_warns_when_the_command_has_a_space():
    rows = {r["id"]: r for r in agent_clients.status("/Users/a/Library/Application Support/GameAtelier/python3")}
    assert rows["trae"]["warning"] == "安装路径含空格，TRAE 无法启动"
    assert {rows[c]["warning"] for c in agent_clients.CLIENT_IDS if c != "trae"} == {None}
    assert next(r for r in agent_clients.status("/venv/bin/python") if r["id"] == "trae")["warning"] is None


@pytest.mark.parametrize("layout", ["skills", "plugins"])
def test_claude_code_with_the_plugin_needs_nothing(isolated_data_root, layout):
    claude = _home() / ".claude"
    if layout == "skills":
        (claude / "skills" / "game-atelier").mkdir(parents=True)
    else:
        (claude / "plugins").mkdir(parents=True)
        (claude / "plugins" / "installed_plugins.json").write_text(
            json.dumps({"version": 2, "plugins": {"game-atelier@local": [{}]}}))
    assert next(r for r in agent_clients.status("/p") if r["id"] == "claude-code")["mode"] == "plugin"
