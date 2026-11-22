"""Build the desktop installer for a runtime bundle built by build_release.py.

The installer does not carry the runtime: the shell downloads it on first start and checks it
against what this build records in stage/runtime.json (version, file, sha256 of the archive,
BUILD_ID, contract level; docs/contracts/desktop-shell.md「运行包下载」).

macOS: electron-builder's dmg. Windows: electron-builder's app folder, zipped, and wrapped by
Atelier's own installer (desktop/setup) into a setup.exe: the folder, its main program and appId,
plus the WebView2 bootstrapper, appended to the installer (desktop/setup/src/payload.rs).
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tarfile
import urllib.request
import zipfile
import zlib

REPO = Path(__file__).resolve().parent.parent
DESKTOP = REPO / "desktop"
SETUP = DESKTOP / "setup"
# Published file-name tail per platform. On Windows the zipped app folder feeds the shell smoke
# test; users get the setup.exe (SETUP_TAIL).
TAILS = {
    "macos-arm64": "macos-arm64.dmg",
    "windows-x64": "windows-x64.zip",
}
SETUP_TAIL = "windows-x64-setup.exe"
PAYLOAD_MAGIC = b"ATELPAY1"
WEBVIEW2_BOOTSTRAPPER = "MicrosoftEdgeWebview2Setup.exe"
WEBVIEW2_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"


def required_contract() -> int:
    source = (DESKTOP / "src/runtime.mjs").read_text(encoding="utf-8")
    return int(re.search(r"export const DESKTOP_CONTRACT = (\d+);", source)[1])


def runtime_markers(runtime: Path, version: str) -> dict[str, str]:
    """DESKTOP_CONTRACT and BUILD_ID of the runtime's version directory (written near the start)."""
    wanted = {f"GameAtelier/versions/{version}/{name}": name for name in ("DESKTOP_CONTRACT", "BUILD_ID")}
    found: dict[str, str] = {}
    if runtime.suffix == ".zip":
        with zipfile.ZipFile(runtime) as archive:
            for member, name in wanted.items():
                if member in archive.namelist():
                    found[name] = archive.read(member).decode("utf-8").strip()
        return found
    with tarfile.open(runtime, "r:gz") as archive:
        for member in archive:
            name = wanted.get(member.name)
            if name:
                found[name] = archive.extractfile(member).read().decode("utf-8").strip()
                if len(found) == len(wanted):
                    break
    return found


def verify_video_payload(runtime: Path, version: str) -> None:
    """Validate the native payload inside the exact archive recorded by the installer."""
    windows = runtime.suffix == ".zip"
    target = "windows-x64" if windows else "macos-arm64"
    prefix = f"GameAtelier/versions/{version}/app/video-encoder/{target}/"
    hashes = {}
    manifest = {}

    def inspect(name, stream):
        if name == "SHA256SUMS":
            for line in stream.read().decode("utf-8").splitlines():
                digest, filename = line.split(maxsplit=1)
                manifest[filename] = digest
        else:
            digest = hashlib.sha256()
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
            hashes[name] = digest.hexdigest()

    if windows:
        with zipfile.ZipFile(runtime) as archive:
            for entry in archive.infolist():
                if entry.filename.startswith(prefix) and not entry.is_dir():
                    with archive.open(entry) as stream:
                        inspect(entry.filename[len(prefix):], stream)
    else:
        with tarfile.open(runtime, "r|gz") as archive:
            for entry in archive:
                if entry.name.startswith(prefix) and entry.isfile():
                    with archive.extractfile(entry) as stream:
                        inspect(entry.name[len(prefix):], stream)
    binaries = {name + (".exe" if windows else "") for name in ("ffmpeg", "ffprobe")}
    if hashes != manifest or not binaries.union({"COPYING.LGPLv2.1", "configuration.txt"}) <= hashes.keys():
        raise ValueError("Runtime video encoder files or SHA256SUMS are incomplete")


def app_id() -> str:
    """The AppUserModelID / bundle id: `appId` in desktop/electron-builder.yml, the only place."""
    text = (DESKTOP / "electron-builder.yml").read_text(encoding="utf-8")
    return re.search(r"^appId: (\S+)$", text, re.M)[1]


def stage_runtime(runtime: Path, version: str) -> Path:
    """What the shell needs to know about the runtime that goes with this build: the download is
    checked against `sha256`, an unpacked version directory (including its native video tools) against `build`."""
    verify_video_payload(runtime, version)
    markers = runtime_markers(runtime, version)
    contract = int(markers.get("DESKTOP_CONTRACT", "0") or 0)
    if contract != required_contract():
        raise SystemExit(f"runtime declares DESKTOP_CONTRACT {contract}, the shell requires {required_contract()}")
    if not markers.get("BUILD_ID"):
        raise SystemExit("runtime has no BUILD_ID")
    with runtime.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    info = {"version": version, "file": runtime.name, "sha256": digest, "build": markers["BUILD_ID"],
            "contract": contract}
    staged = DESKTOP / "stage/runtime.json"
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_text(json.dumps(info) + "\n", encoding="utf-8")
    return staged


def build_electron(runtime: Path, version: str, platform: str, app_id_override: str | None) -> Path:
    stage_runtime(runtime, version)
    pnpm = shutil.which("pnpm") or "pnpm"
    # Electron 45 has no postinstall: fetch the binary electron-builder packages (no-op once present).
    subprocess.run([pnpm, "exec", "install-electron"], cwd=DESKTOP, check=True)
    subprocess.run([pnpm, "stage"], cwd=DESKTOP, check=True)
    shutil.rmtree(DESKTOP / "dist", ignore_errors=True)
    target = ["--mac", "--arm64"] if platform == "macos-arm64" else ["--win", "--x64"]
    identity = app_id_override or app_id()
    command = [pnpm, "exec", "electron-builder", *target, "--publish", "never",
               f"-c.extraMetadata.version={version}", f"-c.extraMetadata.atelierAppId={identity}"]
    if app_id_override:
        command.append(f"-c.appId={app_id_override}")
    subprocess.run(command, cwd=DESKTOP, check=True)
    if platform == "macos-arm64":
        return next((DESKTOP / "dist").glob("*.dmg"))
    return DESKTOP / "dist" / "win-unpacked"


def write_payload(setup: Path, target: Path, *, product: str, version: str, main: str, app_id: str,
                  app: Path, setup_files: list[Path]) -> None:
    """`<setup exe> <files…> <manifest> <u64 LE manifest length> <magic>` (payload.rs).

    Every file under `app` is installed at its relative path; `main` is the program inside it.
    `setup_files` stay with the installer (`setup/`). App files are stored as raw deflate, the
    installer's own files as they are.
    """
    files = [(path.relative_to(app).as_posix(), path) for path in sorted(app.rglob("*")) if path.is_file()]
    names = {name for name, _ in files}
    if main not in names:
        raise SystemExit(f"{app} lacks {main}")
    files += [(f"setup/{path.name}", path) for path in setup_files]
    exe = setup.read_bytes()
    entries = []
    with target.open("wb") as out:
        out.write(exe)
        for name, path in files:
            store = name.startswith("setup/")
            start = out.tell()
            with path.open("rb") as source:
                if store:
                    shutil.copyfileobj(source, out, 1 << 20)
                else:
                    deflate = zlib.compressobj(9, zlib.DEFLATED, -15)
                    while chunk := source.read(1 << 20):
                        out.write(deflate.compress(chunk))
                    out.write(deflate.flush())
            entries.append({"path": name, "offset": start, "size": out.tell() - start,
                            "codec": "store" if store else "deflate"})
        manifest = json.dumps({"role": "install", "product": product, "version": version, "main": main,
                               "app_id": app_id, "exe_len": len(exe), "files": entries}).encode()
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


def build_setup(app: Path, target: Path, product: str, version: str, identity: str) -> Path:
    """Atelier's own installer around the Electron app folder (desktop/setup)."""
    subprocess.run(["cargo", "build", "--release"], cwd=SETUP, check=True)
    write_payload(SETUP / "target/release/atelier-setup.exe", target, product=product, version=version,
                  main=f"{product}.exe", app_id=identity, app=app, setup_files=[_webview2_bootstrapper()])
    return target


def _write_digest(target: Path) -> None:
    with target.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    target.with_name(target.name + ".sha256").write_text(f"{digest}  {target.name}\n", encoding="utf-8")
    print(f"{target.name}: {target.stat().st_size / 1024**2:.1f} MiB")


def build(runtime: Path, output: Path, platform: str, app_id_override: str | None = None) -> Path:
    version = json.loads((REPO / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))["version"]
    # The product name lives only in desktop/package.json; the runtime keeps its own name.
    product = json.loads((DESKTOP / "package.json").read_text(encoding="utf-8"))["productName"]
    expected = f"GameAtelier-{version}-{platform}."
    if not runtime.name.startswith(expected):
        raise SystemExit(f"runtime {runtime.name} does not match {expected}*")
    built = build_electron(runtime, version, platform, app_id_override)
    output.mkdir(parents=True, exist_ok=True)
    target = output / f"{product}-{version}-{TAILS[platform]}"
    if built.is_dir():
        target.unlink(missing_ok=True)
        shutil.make_archive(str(target.with_suffix("")), "zip", root_dir=built)
        setup = build_setup(built, output / f"{product}-{version}-{SETUP_TAIL}", product, version,
                            app_id_override or app_id())
        _write_digest(setup)
    else:
        shutil.copy2(built, target)
    _write_digest(target)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True,
                        help="GameAtelier-<version>-<platform> archive the shell will download and check")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--platform", choices=sorted(TAILS), required=True)
    parser.add_argument("--app-id", help="Local measurement builds only: keep clear of an installed Atelier")
    args = parser.parse_args()
    build(args.runtime, args.output, args.platform, args.app_id)
