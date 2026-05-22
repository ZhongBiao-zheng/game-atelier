"""端到端冒烟测试：起 server → 发请求 → 验证文件落地。
不跑前端（用 httpx 直接打 API），覆盖核心数据流。
"""
import json
import os
import time
from multiprocessing import Process
from pathlib import Path

import httpx
import pytest
import uvicorn


def _run_server(host: str, port: int, runtime_dir: str, cwd: str) -> None:
    os.environ["RUNTIME_DIR"] = runtime_dir
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

    p = Process(target=_run_server, args=("127.0.0.1", 5180, str(runtime), str(tmp_path)))
    p.start()
    # Wait for server lifespan startup (watchdog observer) to complete
    base_url = "http://127.0.0.1:5180"
    for _ in range(60):
        try:
            r = httpx.get(f"{base_url}/api/config", timeout=0.5)
            if r.status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    yield "http://127.0.0.1:5180"
    p.terminate()
    p.join(timeout=3)
    if p.is_alive():
        p.kill()
        p.join(timeout=1)


def test_full_round_trip(server):
    base = server

    r = httpx.post(f"{base}/api/spec/test_char", json={"content": "# test"})
    assert r.status_code == 200

    active = httpx.get(f"{base}/api/active-character").json()
    assert active["active_id"] == "test_char"

    r = httpx.post(f"{base}/api/feedback", json={"text": "make it darker", "character_id": "test_char"})
    assert r.status_code == 200

    r = httpx.post(f"{base}/api/clipboard-attempt", json={
        "ts": "2026-05-18T10:00:00Z", "success": True,
    })
    assert r.status_code == 200

    chars = httpx.get(f"{base}/api/characters").json()
    assert any(c["id"] == "test_char" for c in chars)
