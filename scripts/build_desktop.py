"""Build the desktop installer around a runtime bundle built by build_release.py.

macOS: Tauri's dmg. Windows: Atelier's own installer (desktop/setup) with the app's files, the seed
and the WebView2 bootstrapper appended to it (desktop/setup/src/payload.rs). The installer only
sees "a folder of app files and the name of its main program"; how the app is built is this
script's business.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import urllib.request

REPO = Path(__file__).resolve().parent.parent
DESKTOP = REPO / "desktop"
SETUP = DESKTOP / "setup"
# Published file-name tail per platform.
PLATFORMS = {
    "macos-arm64": "macos-arm64.dmg",
    "windows-x64": "windows-x64-setup.exe",
}
PAYLOAD_MAGIC = b"ATELPAY1"
WEBVIEW2_BOOTSTRAPPER = "MicrosoftEdgeWebview2Setup.exe"
WEBVIEW2_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"


def _tauri(args: list[str]) -> None:
    pnpm = shutil.which("pnpm") or "pnpm"
    subprocess.run([pnpm, *args], cwd=DESKTOP, check=True)


def _build_dmg(seed: Path, version: str) -> Path:
    config = {"version": version, "bundle": {"resources": {str(seed.resolve()): f"seed/{seed.name}"}}}
    _tauri(["tauri", "build", "--bundles", "dmg", "--config", json.dumps(config)])
    return next((DESKTOP / "src-tauri/target/release/bundle/dmg").glob("*.dmg"))


def write_payload(setup: Path, target: Path, *, product: str, version: str, main: str,
                  app: Path, seed: Path, setup_files: list[Path]) -> None:
    """`<setup exe> <files…> <manifest> <u64 LE manifest length> <magic>` (payload.rs).

    Every file under `app` is installed at its relative path; `main` is the program inside it.
    The seed goes to `seed/`; `setup_files` stay with the installer (`setup/`).
    """
    files = [(path.relative_to(app).as_posix(), path) for path in sorted(app.rglob("*")) if path.is_file()]
    if main not in {name for name, _ in files}:
        raise SystemExit(f"{main} is not in {app}")
    files += [(f"seed/{seed.name}", seed)] + [(f"setup/{path.name}", path) for path in setup_files]
    exe = setup.read_bytes()
    entries = []
    with target.open("wb") as out:
        out.write(exe)
        for name, path in files:
            entries.append({"path": name, "offset": out.tell(), "size": path.stat().st_size})
            with path.open("rb") as source:
                shutil.copyfileobj(source, out, 1 << 20)
        manifest = json.dumps({"role": "install", "product": product, "version": version, "main": main,
                               "exe_len": len(exe), "files": entries}).encode()
        out.write(manifest)
        out.write(struct.pack("<Q", len(manifest)))
        out.write(PAYLOAD_MAGIC)


def _webview2_bootstrapper() -> Path:
    cached = SETUP / "target" / WEBVIEW2_BOOTSTRAPPER
    if not cached.is_file():
        cached.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(WEBVIEW2_URL, timeout=120) as response:
            cached.write_bytes(response.read())
    return cached


def _stage_app(version: str, product: str) -> tuple[Path, str]:
    """The app's files for the installer, and its main program. Today: the Tauri shell, one exe."""
    _tauri(["tauri", "build", "--no-bundle", "--config", json.dumps({"version": version})])
    app = SETUP / "target/app"
    shutil.rmtree(app, ignore_errors=True)
    app.mkdir(parents=True)
    main = f"{product}.exe"
    shutil.copy2(DESKTOP / "src-tauri/target/release/atelier-desktop.exe", app / main)
    return app, main


def _build_setup(seed: Path, version: str, product: str, target: Path) -> None:
    app, main = _stage_app(version, product)
    subprocess.run(["cargo", "build", "--release"], cwd=SETUP, check=True)
    write_payload(SETUP / "target/release/atelier-setup.exe", target, product=product, version=version,
                  main=main, app=app, seed=seed, setup_files=[_webview2_bootstrapper()])


def build(seed: Path, output: Path, platform: str) -> Path:
    version = json.loads((REPO / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))["version"]
    # Product name lives only in tauri.conf.json (rename-ready); the seed keeps its runtime name.
    product = json.loads((DESKTOP / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["productName"]
    expected = f"GameAtelier-{version}-{platform}."
    if not seed.name.startswith(expected):
        raise SystemExit(f"seed {seed.name} does not match {expected}*")
    _tauri(["icons"])
    output.mkdir(parents=True, exist_ok=True)
    target = output / f"{product}-{version}-{PLATFORMS[platform]}"
    if platform == "windows-x64":
        _build_setup(seed, version, product, target)
    else:
        shutil.copy2(_build_dmg(seed, version), target)
    with target.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    target.with_name(target.name + ".sha256").write_text(f"{digest}  {target.name}\n", encoding="utf-8")
    print(f"{target.name}: {target.stat().st_size / 1024**2:.1f} MiB")
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=Path, required=True, help="GameAtelier-<version>-<platform> archive")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--platform", choices=sorted(PLATFORMS), required=True)
    args = parser.parse_args()
    build(args.seed, args.output, args.platform)
