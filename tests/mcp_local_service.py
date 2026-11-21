"""Run the real stdio adapter against a viewer bound to an ephemeral loopback socket."""
import asyncio
import socket
import sys
import threading
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

from viewer_server.server_app import build_app


@asynccontextmanager
async def adapter_session(data_root, tmp_path):
    repo = Path(__file__).resolve().parents[1]
    app = build_app(dist_dir=tmp_path / "dist")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning", ws="none", lifespan="off"))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
        thread.start()
        try:
            async with asyncio.timeout(10):
                while not server.started:
                    await asyncio.sleep(0.01)
            runtime = data_root / ".runtime"
            runtime.mkdir(exist_ok=True)
            (runtime / "server.port").write_text(str(port), encoding="utf-8")
            app.state.connection_store.enable_agent(f"http://127.0.0.1:{port}")
            params = StdioServerParameters(command=sys.executable,
                args=["-m", "character_workflow.mcp"], cwd=str(repo),
                env={"GAME_ATELIER_DATA_ROOT": str(data_root), "PYTHONPATH": str(repo / "src"),
                     "HOME": str(tmp_path / "home"), "CODEX_HOME": str(tmp_path / "codex")})
            async with Client(params, read_timeout_seconds=30) as client:
                yield client
        finally:
            server.should_exit = True
            thread.join(10)
            assert not thread.is_alive()
