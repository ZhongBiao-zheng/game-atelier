"""Build the desktop installer around a runtime bundle built by build_release.py.

macOS: Tauri's dmg. Windows: the shell exe plus Atelier's own installer (desktop/setup), with the
shell, the seed and the WebView2 bootstrapper appended to it (desktop/setup/src/payload.rs).
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


def write_payload(setup: Path, target: Path, product: str, version: str,
                  files: list[tuple[str, Path]]) -> None:
    """`<setup exe> <files…> <manifest> <u64 LE manifest length> <magic>` (payload.rs)."""
    exe = setup.read_bytes()
    entries = []
    with target.open("wb") as out:
        out.write(exe)
        for name, path in files:
            entries.append({"path": name, "offset": out.tell(), "size": path.stat().st_size})
            with path.open("rb") as source:
                shutil.copyfileobj(source, out, 1 << 20)
        manifest = json.dumps({"role": "install", "product": product, "version": version,
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


def _build_setup(seed: Path, version: str, product: str, target: Path) -> None:
    # The shell itself: Tauri compiles it with this version; the installer does the packaging.
    _tauri(["tauri", "build", "--no-bundle", "--config", json.dumps({"version": version})])
    shell = DESKTOP / "src-tauri/target/release/atelier-desktop.exe"
    subprocess.run(["cargo", "build", "--release"], cwd=SETUP, check=True)
    setup = SETUP / "target/release/atelier-setup.exe"
    write_payload(setup, target, product, version, [
        (f"{product}.exe", shell),
        (f"seed/{seed.name}", seed),
        (WEBVIEW2_BOOTSTRAPPER, _webview2_bootstrapper()),
    ])


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
