"""第 5 批 5-6B 端到端：真实 MCP 适配器进程（python -m character_workflow.mcp，stdio）连隔离的本机服务。

服务端是真实应用（uvicorn，随机回环端口，隔离数据目录），凭据由连接存储签发，适配器按 .runtime/server.port 找服务。
只验证两个自定义接口工具能经完整链路拿到内容；不发任何出站请求。
"""
from __future__ import annotations

import asyncio
import json
import socket
import sys
import threading
from importlib.resources import files
from pathlib import Path

import uvicorn
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

from viewer_server.server_app import build_app

REPO = Path(__file__).resolve().parent.parent
MANUAL = files("character_workflow").joinpath("data/http_protocol_manual.md").read_text(encoding="utf-8")
IMAGE = next(item["document"] for item in json.loads(
    (REPO / "web/src/pages/settings/customInterfaceExamples.json").read_text(encoding="utf-8"))
    if item["id"] == "openai-sync-image")


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


async def test_a_real_adapter_process_reads_the_manual_and_validates(isolated_data_root, tmp_path):
    port = _free_port()
    app = build_app(dist_dir=tmp_path / "dist")
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", ws="none"))
    thread = threading.Thread(target=server.run, name="e2e-viewer", daemon=True)
    thread.start()
    started = threading.Event()
    for _ in range(200):
        if server.started:
            break
        started.wait(0.05)
    assert server.started, "隔离服务 10 秒内没有起来"
    try:
        (isolated_data_root / ".runtime" / "server.port").write_text(str(port), encoding="utf-8")
        app.state.connection_store.enable_agent(f"http://127.0.0.1:{port}")
        params = StdioServerParameters(
            command=sys.executable, args=["-m", "character_workflow.mcp"], cwd=str(REPO),
            env={"GAME_ATELIER_DATA_ROOT": str(isolated_data_root), "PYTHONPATH": str(REPO / "src"),
                 "HOME": str(tmp_path / "home"), "CODEX_HOME": str(tmp_path / "codex-home-absent")},
        )
        async with asyncio.timeout(60):
            async with Client(params, read_timeout_seconds=30) as client:
                names = {tool.name for tool in (await client.list_tools()).tools}
                assert {"atelier_protocol_manual", "atelier_protocol_validate"} <= names
                manual = await client.call_tool("atelier_protocol_manual", {"payload": {}})
                assert not manual.is_error, manual.content
                assert manual.structured_content == {"markdown": MANUAL}
                checked = await client.call_tool("atelier_protocol_validate", {"payload": {"document": IMAGE}})
                assert not checked.is_error, checked.content
                assert checked.structured_content["valid"] is True
                submit = checked.structured_content["preview"]["submit"]
                assert submit["url"].startswith("https://服务地址/")
                assert submit["hidden_fields"] == ["headers.Authorization"]
    finally:
        server.should_exit = True
        thread.join(10)
    assert not thread.is_alive()
