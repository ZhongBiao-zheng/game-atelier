"""Build a relocatable distribution from uv's standalone Python and the committed UI."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

REPO = Path(__file__).resolve().parent.parent


def build(output: Path, platform: str) -> Path:
    version = json.loads((REPO / ".claude-plugin/plugin.json").read_text())["version"]
    folder = output.resolve() / f"GameAtelier-{version}-{platform}"
    folder.mkdir(parents=True, exist_ok=False)
    # uv downloads python-build-standalone; pin the interpreter, never copy a local venv.
    subprocess.run(["uv", "python", "install", "3.11", "--no-bin"], check=True)
    executable = Path(subprocess.check_output(
        ["uv", "python", "find", "--managed-python", "3.11"], text=True,
    ).strip()).resolve()
    runtime = executable.parent if os.name == "nt" else executable.parent.parent
    shutil.copytree(runtime, folder / "python", symlinks=True)
    python = folder / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    requirements = folder / "requirements.txt"
    subprocess.run([
        "uv", "export", "--locked", "--no-dev", "--no-emit-project",
        "--output-file", str(requirements),
    ], cwd=REPO, check=True, stdout=subprocess.DEVNULL)
    subprocess.run([
        # 仅修改已复制进包的解释器；uv 的受管解释器原件保持不动。
        "uv", "pip", "install", "--python", str(python), "--break-system-packages",
        "--require-hashes",
        "-r", str(requirements),
    ], cwd=REPO, check=True)
    app = folder / "app"
    app.mkdir()
    for name in ("src", "web/dist", "scripts", "skills", ".claude-plugin"):
        shutil.copytree(REPO / name, app / name,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for name in ("pyproject.toml", "uv.lock", ".python-version"):
        shutil.copy2(REPO / name, app / name)
    (folder / "VERSION").write_text(version + "\n", encoding="utf-8")
    if os.name == "nt":
        (folder / "启动.bat").write_text(
            '@echo off\nchcp 65001 >nul\nsetlocal\n'
            'set "PYTHONUTF8=1"\nset "PYTHONPATH=%~dp0app\\src"\n'
            'set "VIRTUAL_ENV="\nset "UV_PROJECT_ENVIRONMENT="\n'
            '"%~dp0python\\python.exe" "%~dp0app\\scripts\\bootstrap.py" --launch\n'
            'if errorlevel 1 pause\n', encoding="utf-8", newline="\r\n",
        )
    else:
        launcher = folder / "启动.command"
        launcher.write_text(
            '#!/bin/sh\nset -eu\n'
            'BUNDLE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\n'
            # 浏览器下载会给整个包打隔离标记，未签名的 Python 与动态库随后被 Gatekeeper 拦下。
            # 用户放行本启动器即同意运行这个包，这里只清本包目录的标记。
            'if command -v xattr >/dev/null 2>&1; then\n'
            '  xattr -dr com.apple.quarantine "$BUNDLE_DIR" 2>/dev/null || true\n'
            'fi\n'
            'unset VIRTUAL_ENV UV_PROJECT_ENVIRONMENT\n'
            'export PYTHONPATH="$BUNDLE_DIR/app/src"\n'
            'exec "$BUNDLE_DIR/python/bin/python3" "$BUNDLE_DIR/app/scripts/bootstrap.py" --launch\n',
            encoding="utf-8",
        )
        launcher.chmod(0o755)
    archive = Path(shutil.make_archive(
        str(folder), "zip" if os.name == "nt" else "gztar",
        root_dir=folder.parent, base_dir=folder.name,
    ))
    with archive.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    archive.with_name(archive.name + ".sha256").write_text(
        f"{digest}  {archive.name}\n", encoding="utf-8",
    )
    print(f"{archive.name}: {archive.stat().st_size / 1024**2:.1f} MiB")
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--platform", choices=("windows-x64", "macos-arm64", "linux-x64"), required=True)
    args = parser.parse_args()
    build(args.output, args.platform)
