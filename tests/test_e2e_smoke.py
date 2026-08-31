"""端到端冒烟测试：起 server → 发请求 → 验证文件落地。
不跑前端（用 httpx 直接打 API），覆盖核心数据流。
"""
import json
import hashlib
import os
import socket
import time
import uuid
from multiprocessing import Process

import httpx
import pytest
import uvicorn


def _run_server(host: str, port: int, runtime_dir: str, cwd: str) -> None:
    os.environ["RUNTIME_DIR"] = runtime_dir
    os.environ["GAME_ATELIER_DATA_ROOT"] = cwd
    os.chdir(cwd)
    # Late import so env vars and cwd are set first
    from viewer_server.server_app import build_app
    uvicorn.run(build_app(), host=host, port=port, log_level="error")


@pytest.fixture
def server(tmp_path):
    runtime = tmp_path / ".runtime"
    runtime.mkdir()
    (runtime / "config.json").write_text(
        json.dumps({"image_storage_root": str(tmp_path / "images")})
    )
    (tmp_path / "images").mkdir()
    (tmp_path / "characters").mkdir()

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    p = Process(target=_run_server, args=("127.0.0.1", port, str(runtime), str(tmp_path)))
    p.start()
    # Wait for server lifespan startup (watchdog observer) to complete
    base_url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(60):
            try:
                r = httpx.get(f"{base_url}/api/connection/status", timeout=0.5)
                if r.status_code == 200 and r.json()["service"] == "game-atelier":
                    break
            except httpx.HTTPError:
                pass
            time.sleep(0.1)
        else:
            pytest.fail("Isolated server did not become ready")
        with httpx.Client(base_url=base_url, headers={
            "Origin": base_url, "Sec-Fetch-Site": "same-origin",
            "X-Atelier-Client": uuid.uuid4().hex,
        }) as client:
            assert client.get("/api/config").status_code == 401
            assert client.post("/api/connection/local-session", json={}).status_code == 200
            assert client.post("/api/connection/editor-lease", json={
                "client_id": client.headers["X-Atelier-Client"],
            }).status_code == 200
            yield client
    finally:
        p.terminate()
        p.join(timeout=3)
        if p.is_alive():
            p.kill()
            p.join(timeout=1)


def test_full_round_trip(server):
    assert server.get("/api/spec/test_char").status_code == 404
    revision = hashlib.sha256(b"").hexdigest()
    r = server.post("/api/spec/test_char", json={
        "content": "# test", "expected_revision": revision,
    })
    assert r.status_code == 200

    active = server.get("/api/active-character").json()
    assert active["active_id"] == "test_char"

    r = server.post("/api/feedback", json={"text": "make it darker", "character_id": "test_char"})
    assert r.status_code == 200

    r = server.post("/api/clipboard-attempt", json={
        "ts": "2026-05-18T10:00:00Z", "success": True,
    })
    assert r.status_code == 200

    chars = server.get("/api/characters").json()
    assert any(c["id"] == "test_char" for c in chars)
