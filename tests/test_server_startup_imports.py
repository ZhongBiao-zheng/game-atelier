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
