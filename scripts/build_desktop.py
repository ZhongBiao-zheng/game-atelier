"""Build the desktop installer around a runtime bundle built by build_release.py."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import zipfile

REPO = Path(__file__).resolve().parent.parent
DESKTOP = REPO / "desktop"
# Published file-name tail per platform.
TAILS = {
    "macos-arm64": "macos-arm64.dmg",
    "windows-x64": "windows-x64-setup.exe",
}


def required_contract() -> int:
    source = (DESKTOP / "src/runtime.mjs").read_text(encoding="utf-8")
    return int(re.search(r"export const DESKTOP_CONTRACT = (\d+);", source)[1])


def seed_markers(seed: Path, version: str) -> dict[str, str]:
    """DESKTOP_CONTRACT and BUILD_ID of the seed's version directory (written near the start)."""
    wanted = {f"GameAtelier/versions/{version}/{name}": name for name in ("DESKTOP_CONTRACT", "BUILD_ID")}
    found: dict[str, str] = {}
    if seed.suffix == ".zip":
        with zipfile.ZipFile(seed) as archive:
            for member, name in wanted.items():
                if member in archive.namelist():
                    found[name] = archive.read(member).decode("utf-8").strip()
        return found
    with tarfile.open(seed, "r:gz") as archive:
        for member in archive:
            name = wanted.get(member.name)
            if name:
                found[name] = archive.extractfile(member).read().decode("utf-8").strip()
                if len(found) == len(wanted):
                    break
    return found


def stage_seed(seed: Path, version: str) -> None:
    """Copy the seed where electron-builder picks it up, with the facts the shell checks at start
    (docs/contracts/desktop-shell.md): the shell never reads the archive before unpacking it."""
    markers = seed_markers(seed, version)
    contract = int(markers.get("DESKTOP_CONTRACT", "0") or 0)
    if contract != required_contract():
        raise SystemExit(f"seed declares DESKTOP_CONTRACT {contract}, the shell requires {required_contract()}")
    if not markers.get("BUILD_ID"):
        raise SystemExit("seed has no BUILD_ID")
    staged = DESKTOP / "stage/seed"
    shutil.rmtree(staged, ignore_errors=True)
    staged.mkdir(parents=True)
    shutil.copy2(seed, staged / seed.name)
    info = {"file": seed.name, "version": version, "build": markers["BUILD_ID"], "contract": contract}
    (staged / "seed.json").write_text(json.dumps(info) + "\n", encoding="utf-8")


def build_electron(seed: Path, version: str, app_id: str | None) -> Path:
    stage_seed(seed, version)
    pnpm = shutil.which("pnpm") or "pnpm"
    subprocess.run([pnpm, "icons"], cwd=DESKTOP, check=True)
    shutil.rmtree(DESKTOP / "dist", ignore_errors=True)
    command = [pnpm, "exec", "electron-builder", "--mac", "--arm64", "--publish", "never",
               f"-c.extraMetadata.version={version}"]
    if app_id:
        command.append(f"-c.appId={app_id}")
    subprocess.run(command, cwd=DESKTOP, check=True)
    return next((DESKTOP / "dist").glob("*.dmg"))


def build_tauri_windows(seed: Path, version: str) -> Path:
    # Windows still ships the Tauri shell until it moves to Electron (batch 3).
    config = {"version": version, "bundle": {"resources": {str(seed.resolve()): f"seed/{seed.name}"}}}
    pnpm = shutil.which("pnpm") or "pnpm"
    subprocess.run([pnpm, "tauri-icons"], cwd=DESKTOP, check=True)
    subprocess.run([pnpm, "tauri", "build", "--bundles", "nsis", "--config", json.dumps(config)],
                   cwd=DESKTOP, check=True)
    return next((DESKTOP / "src-tauri/target/release/bundle/nsis").glob("*.exe"))


def build(seed: Path, output: Path, platform: str, app_id: str | None = None) -> Path:
    version = json.loads((REPO / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))["version"]
    # The product name lives only in desktop/package.json; the seed keeps its runtime name.
    product = json.loads((DESKTOP / "package.json").read_text(encoding="utf-8"))["productName"]
    expected = f"GameAtelier-{version}-{platform}."
    if not seed.name.startswith(expected):
        raise SystemExit(f"seed {seed.name} does not match {expected}*")
    if platform == "macos-arm64":
        built = build_electron(seed, version, app_id)
    else:
        built = build_tauri_windows(seed, version)
    output.mkdir(parents=True, exist_ok=True)
    target = output / f"{product}-{version}-{TAILS[platform]}"
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
    parser.add_argument("--platform", choices=sorted(TAILS), required=True)
    parser.add_argument("--app-id", help="Local measurement builds only: keep clear of an installed Atelier")
    args = parser.parse_args()
    build(args.seed, args.output, args.platform, args.app_id)
