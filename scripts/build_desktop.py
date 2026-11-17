"""Build the desktop installer around a runtime bundle built by build_release.py."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

REPO = Path(__file__).resolve().parent.parent
DESKTOP = REPO / "desktop"
# Tauri bundle, built file suffix and published file-name tail per platform.
PLATFORMS = {
    "macos-arm64": ("dmg", "dmg", "macos-arm64.dmg"),
    "windows-x64": ("nsis", "exe", "windows-x64-setup.exe"),
}


def build(seed: Path, output: Path, platform: str) -> Path:
    bundle, suffix, tail = PLATFORMS[platform]
    version = json.loads((REPO / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))["version"]
    # Product name lives only in tauri.conf.json (rename-ready); the seed keeps its runtime name.
    product = json.loads((DESKTOP / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["productName"]
    expected = f"GameAtelier-{version}-{platform}."
    if not seed.name.startswith(expected):
        raise SystemExit(f"seed {seed.name} does not match {expected}*")
    # Installer and seed share one version; the shell reports it from this config.
    config = {"version": version, "bundle": {"resources": {str(seed.resolve()): f"seed/{seed.name}"}}}
    pnpm = shutil.which("pnpm") or "pnpm"
    subprocess.run([pnpm, "icons"], cwd=DESKTOP, check=True)
    subprocess.run([pnpm, "tauri", "build", "--bundles", bundle, "--config", json.dumps(config)],
                   cwd=DESKTOP, check=True)
    built = next((DESKTOP / "src-tauri/target/release/bundle" / bundle).glob(f"*.{suffix}"))
    output.mkdir(parents=True, exist_ok=True)
    target = output / f"{product}-{version}-{tail}"
    shutil.copy2(built, target)
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
