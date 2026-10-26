"""Bundle runtime boundaries; archive smoke is opt-in against the actual build artifact."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

import pytest

REPO = Path(__file__).resolve().parent.parent


def test_bundle_interpreter_skips_uv_and_venv(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("bundle_bootstrap", REPO / "scripts/bootstrap.py")
    boot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(boot)
    app = tmp_path / "app"
    (app / "web/dist").mkdir(parents=True)
    (app / "web/dist/index.html").touch()
    executable = tmp_path / "python/bin/python3"
    executable.parent.mkdir(parents=True)
    executable.touch()
    monkeypatch.setattr(boot, "PLUGIN_DIR", app)
    monkeypatch.setattr(sys, "executable", str(executable))
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path / "user-data"))
    monkeypatch.setattr(boot.shutil, "which", lambda name: None)
    assert boot.is_bundle()
    assert boot.check()["status"] == "needs_first_key"
    assert boot.ensure_venv() == 0
    assert not (tmp_path / "user-data/.venv").exists()
    monkeypatch.setattr(sys, "executable", str(tmp_path / "system/python"))
    assert not boot.is_bundle()
    assert boot.check()["status"] == "needs_uv"


@pytest.mark.skipif(not os.environ.get("ATELIER_BUNDLE_ARCHIVE"), reason="requires release archive")
def test_relocated_archive_runs_without_system_tools_and_preserves_data(tmp_path):
    archive = Path(os.environ["ATELIER_BUNDLE_ARCHIVE"])
    unpack = tmp_path / "relocated folder"
    shutil.unpack_archive(archive, unpack)
    folder = next(unpack.iterdir())
    python = folder / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    boot = folder / "app/scripts/bootstrap.py"
    data = tmp_path / "data"
    (data / ".config").mkdir(parents=True)
    sentinel = data / ".config/keep.txt"
    sentinel.write_text("persistent", encoding="utf-8")
    env = {**os.environ, "PATH": "", "GAME_ATELIER_DATA_ROOT": str(data),
           "GAME_ATELIER_NO_UPDATE_CHECK": "1", "BROWSER": "true",
           "PYTHONPATH": str(folder / "app/src"), "PYTHONUTF8": "1"}
    # Loopback remains available; outgoing HTTP is deliberately sent to an unused port.
    env.update(HTTP_PROXY="http://127.0.0.1:1", HTTPS_PROXY="http://127.0.0.1:1",
               NO_PROXY="127.0.0.1,localhost")
    try:
        started = time.perf_counter()
        result = subprocess.run([str(python), str(boot), "--launch"], env=env,
                                capture_output=True, text=True, encoding="utf-8", timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        port = (data / ".runtime/server.port").read_text().strip()
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10) as response:
            assert response.status == 200
        print(f"bundle relocated startup: {time.perf_counter() - started:.2f}s")
        assert sentinel.read_text() == "persistent"
        assert not (data / ".venv").exists()
    finally:
        # Windows stop uses taskkill; restore OS tools only for cleanup.
        env["PATH"] = os.environ.get("PATH", "")
        subprocess.run([str(python), str(boot), "--run", "-m", "viewer_server.server", "stop"],
                       env=env, check=True, timeout=30)
    shutil.rmtree(folder)
    assert sentinel.read_text() == "persistent"
