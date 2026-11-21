"""Server start-up must not load Pillow.

A freshly unpacked runtime pays a one-time macOS/Defender check for every native library on its
first load; Pillow and its bundled dylibs cost about 2.6 s of that on the desktop app's first
start. Image work imports PIL inside the functions that need it.
"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

SRC = Path(__file__).resolve().parents[1] / "src"


def test_importing_the_server_app_does_not_load_pillow():
    probe = (
        "import sys, viewer_server.server_app; "
        "print(sorted(m for m in sys.modules if m.split('.')[0] == 'PIL'))"
    )
    env = {**os.environ, "PYTHONPATH": str(SRC)}
    out = subprocess.run([sys.executable, "-c", probe], env=env, capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "[]", f"PIL loaded at server start-up: {out.stdout.strip()}"


def test_building_the_app_does_not_load_pillow(tmp_path):
    """真实启动会调 build_app()：它在函数内导入各路由模块，这些模块也不能在顶层带进 Pillow。

    子进程用临时数据目录与 HOME，不碰用户的 ~/game-atelier。"""
    probe = (
        "import sys, viewer_server.server_app as server_app; server_app.build_app(); "
        "print(sorted(m for m in sys.modules if m.split('.')[0] == 'PIL'))"
    )
    env = {**os.environ, "PYTHONPATH": str(SRC), "GAME_ATELIER_DATA_ROOT": str(tmp_path / "data"),
           "HOME": str(tmp_path / "home"), "CODEX_HOME": str(tmp_path / "codex")}
    out = subprocess.run([sys.executable, "-c", probe], env=env, capture_output=True, text=True, check=True)
    assert out.stdout.strip().splitlines()[-1] == "[]", f"PIL loaded by build_app(): {out.stdout.strip()}"
