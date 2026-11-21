"""Measure the two runtime layouts; fetch only the checksum-pinned BtbN comparison."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.request import urlopen
import zipfile

BTBN_NAME = "ffmpeg-n8.1.3-39-g660b5aa7db-win64-lgpl-8.1.zip"
BTBN_URL = (
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/"
    f"autobuild-2026-11-20-12-40/{BTBN_NAME}"
)
BTBN_SHA256 = "a16d63673d8b28ec0b4fb7311677fd8f6fa9f221f40bf00b48c01ce8e9122be8"


def btbn(destination):
    archive = destination / BTBN_NAME
    if not archive.exists():
        with urlopen(BTBN_URL, timeout=180) as source, archive.open("wb") as target:
            shutil.copyfileobj(source, target)
    with archive.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != BTBN_SHA256:
            raise ValueError("BtbN archive SHA-256 mismatch")
    with zipfile.ZipFile(archive) as package:
        for name in ("ffmpeg.exe", "ffprobe.exe"):
            member, = [item for item in package.namelist() if item.endswith("/bin/" + name)]
            with package.open(member) as source, (destination / name).open("wb") as target:
                shutil.copyfileobj(source, target)
    return {"url": BTBN_URL, "sha256": BTBN_SHA256, "download_bytes": archive.stat().st_size}


def inventory(directory, out, upstream):
    suffix = ".exe" if os.name == "nt" else ""
    encoder = directory / ("ffmpeg" + suffix)
    report = {"upstream": upstream, "payloads": {}}
    for flag, key in (("-version", "version"), ("-L", "license")):
        report[key] = subprocess.check_output([encoder, flag], stderr=subprocess.STDOUT,
                                              text=True, encoding="utf-8", errors="replace")
    with tempfile.TemporaryDirectory(dir=out) as work:
        root = Path(work) / "runtime"
        root.mkdir()
        for name in ("ffmpeg", "ffprobe"):
            shutil.copy2(directory / (name + suffix), root)
            archive = shutil.make_archive(str(Path(work) / name),
                                          "zip" if suffix else "gztar", root)
            report["payloads"]["encoder" if name == "ffmpeg" else "encoder_and_probe"] = {
                "raw": sum(entry.stat().st_size for entry in root.iterdir()),
                "compressed": Path(archive).stat().st_size,
                "sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                           for p in sorted(root.iterdir())},
            }
    (out / "inventory.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--btbn", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(exist_ok=True, parents=True)
    args.directory.mkdir(exist_ok=True, parents=True)
    upstream = btbn(args.directory) if args.btbn else {}
    inventory(args.directory.resolve(), args.out, upstream)
