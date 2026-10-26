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


def write_launchers(folder: Path, *, windows: bool) -> None:
    """Stable entrypoints delegate version selection to the last confirmed runtime."""
    if windows:
        (folder / "启动.bat").write_text(
            '@echo off\nchcp 65001 >nul\nsetlocal\n'
            'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1"\n'
            'if errorlevel 1 pause\n', encoding="utf-8", newline="\r\n",
        )
        (folder / "launch.ps1").write_text(
            "param([switch]$Service, [string]$DataRoot)\n"
            "$ErrorActionPreference = 'Stop'\n"
            "$version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'last-good') -Raw).Trim()\n"
            "if ($version -notmatch '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$') {\n"
            "  throw 'Invalid last-good version. Please download the bundle again.'\n}\n"
            "$runtime = Join-Path $PSScriptRoot ('versions\\' + $version)\n"
            "$env:PYTHONUTF8 = '1'\n"
            "$env:PYTHONPATH = Join-Path $runtime 'app\\src'\n"
            "Remove-Item Env:VIRTUAL_ENV -ErrorAction SilentlyContinue\n"
            "Remove-Item Env:UV_PROJECT_ENVIRONMENT -ErrorAction SilentlyContinue\n"
            "if ($DataRoot) { $env:GAME_ATELIER_DATA_ROOT = $DataRoot }\n"
            "$arguments = @((Join-Path $runtime 'app\\scripts\\bootstrap.py'), '--select-version')\n"
            "if ($Service) { $arguments += '--service' }\n"
            "& (Join-Path $runtime 'python\\python.exe') @arguments\n"
            "exit $LASTEXITCODE\n", encoding="utf-8-sig",
        )
    else:
        launcher = folder / "启动.command"
        launcher.write_text(
            '#!/bin/sh\nset -eu\n'
            'BUNDLE_DIR="$(CDPATH= cd -- "${0%/*}" && pwd)"\n'
            'if command -v xattr >/dev/null 2>&1; then\n'
            '  xattr -dr com.apple.quarantine "$BUNDLE_DIR" 2>/dev/null || true\n'
            'fi\n'
            'IFS= read -r VERSION < "$BUNDLE_DIR/last-good"\n'
            'case "$VERSION" in ""|*[!0-9.]*) echo "Invalid last-good version" >&2; exit 1;; esac\n'
            'RUNTIME="$BUNDLE_DIR/versions/$VERSION"\n'
            'unset VIRTUAL_ENV UV_PROJECT_ENVIRONMENT\n'
            'export PYTHONPATH="$RUNTIME/app/src"\n'
            'exec "$RUNTIME/python/bin/python3" "$RUNTIME/app/scripts/bootstrap.py" --select-version\n',
            encoding="utf-8",
        )
        launcher.chmod(0o755)


def build(output: Path, platform: str) -> Path:
    version = json.loads((REPO / ".claude-plugin/plugin.json").read_text())["version"]
    folder = output.resolve() / "GameAtelier"
    payload = folder / "versions" / version
    payload.mkdir(parents=True, exist_ok=False)
    (folder / "updates").mkdir()
    for pointer in ("current", "last-good"):
        (folder / pointer).write_text(version + "\n", encoding="utf-8")
    # uv downloads python-build-standalone; pin the interpreter, never copy a local venv.
    subprocess.run(["uv", "python", "install", "3.11", "--no-bin"], check=True)
    executable = Path(subprocess.check_output(
        ["uv", "python", "find", "--managed-python", "3.11"], text=True,
    ).strip()).resolve()
    runtime = executable.parent if os.name == "nt" else executable.parent.parent
    shutil.copytree(runtime, payload / "python", symlinks=True)
    python = payload / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    requirements = payload / "requirements.txt"
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
    app = payload / "app"
    app.mkdir()
    for name in ("src", "web/dist", "scripts", "skills", ".claude-plugin"):
        shutil.copytree(REPO / name, app / name,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for name in ("pyproject.toml", "uv.lock", ".python-version"):
        shutil.copy2(REPO / name, app / name)
    (payload / "VERSION").write_text(version + "\n", encoding="utf-8")
    write_launchers(folder, windows=os.name == "nt")
    archive = Path(shutil.make_archive(
        str(output.resolve() / f"GameAtelier-{version}-{platform}"),
        "zip" if os.name == "nt" else "gztar",
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
