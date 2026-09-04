"""Exercise the installed official SDK, not a fake MCP implementation.

This verifies a dependency seam only. It must not be reported as acceptance of
Atelier tools, authorization, Skills, or real Codex/Claude clients.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters


FIXTURE = Path(__file__).parent / "fixtures" / "mcp_sdk_probe.py"


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_sdk_stdio_subprocess_discovery_and_typed_tool_call(tmp_path, mode):
    params = StdioServerParameters(
        command=sys.executable,
        args=[str(FIXTURE.resolve())],
        cwd=tmp_path,
        env={"GAME_ATELIER_DATA_ROOT": str(tmp_path / "unused-data")},
    )
    async with asyncio.timeout(20):
        async with Client(params, mode=mode, read_timeout_seconds=5) as client:
            tools = await client.list_tools()
            assert [tool.name for tool in tools.tools] == ["dependency_echo"]
            assert "payload" in tools.tools[0].input_schema["properties"]
            result = await client.call_tool("dependency_echo", {"payload": {"text": "中文协议回归"}})
            assert not result.is_error
            assert result.structured_content == {"text": "中文协议回归"}
            for payload in ({"text": "x", "confirmed": True}, {"text": 42}, {"text": ""}):
                rejected = await client.call_tool("dependency_echo", {"payload": payload})
                assert rejected.is_error
            resources = await client.list_resources()
            assert resources.resources == []
    assert not (tmp_path / "unused-data").exists()
