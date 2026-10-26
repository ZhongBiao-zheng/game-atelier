"""Prepare a verified, independently runnable bundle without changing the active version."""
from __future__ import annotations

import copy
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import platform
import posixpath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import file_lock, try_file_lock

CNB = "https://cnb.cool/ZhongBiao-zheng/game-atelier/-/releases"
GITHUB = "https://github.com/ZhongBiao-zheng/game-atelier/releases"
GITHUB_LATEST = "https://api.github.com/repos/ZhongBiao-zheng/game-atelier/releases/latest"
VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")
MAX_ARCHIVE = 2 * 1024**3
MAX_UNPACKED = 4 * 1024**3
MAX_MEMBERS = 100_000


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, http.client.HTTPException):
        return {}


def block_version(root: Path, version: str, reason: str) -> None:
    with file_lock(root / "updates/blocked.lock"):
        blocked = _read_json(root / "updates/blocked.json")
        blocked[version] = reason
        atomic_write_json(root / "updates/blocked.json", blocked)


def _platform_name() -> str:
    machine = platform.machine().lower()
    if sys.platform == "win32" and machine in {"amd64", "x86_64"}:
        return "windows-x64"
    if sys.platform == "darwin" and machine in {"arm64", "aarch64"}:
        return "macos-arm64"
    if sys.platform.startswith("linux") and machine in {"amd64", "x86_64"}:
        return "linux-x64"
    raise ValueError("当前平台没有可用安装包。")


def _test_feed() -> str | None:
    value = os.environ.get("GAME_ATELIER_TEST_UPDATE_FEED")
    if not value or os.environ.get("GAME_ATELIER_TESTING") != "1":
        return None
    url = urllib.parse.urlsplit(value)
    if (url.scheme != "http" or url.hostname not in {"127.0.0.1", "::1"}
            or url.username or url.password or url.query or url.fragment):
        raise ValueError("测试更新源必须是本机 HTTP 地址。")
    return value.rstrip("/")


def _tag_from_url(location: str) -> str:
    tag = urllib.parse.urlsplit(location).path.rstrip("/").rsplit("/", 1)[-1]
    if not tag.startswith("v") or not VERSION.fullmatch(tag[1:]):
        raise ValueError("更新源没有正式版本。")
    return tag[1:]


def latest_version() -> str:
    feed = _test_feed()
    request = urllib.request.Request((feed + "/latest") if feed else CNB + "/latest",
                                     headers={"User-Agent": "GameAtelier-Updater"})
    opener = urllib.request.build_opener(_NoRedirect())
    try:
        try:
            with opener.open(request, timeout=10) as response:
                if not feed:
                    raise ValueError("CNB 未返回版本跳转。")
                data = json.loads(response.read(65537))
        except urllib.error.HTTPError as error:
            if error.code != 307:
                raise
            location = urllib.parse.urljoin(request.full_url, error.headers.get("Location", ""))
            parsed = urllib.parse.urlsplit(location)
            if not feed and (parsed.scheme != "https" or parsed.netloc != "cnb.cool"
                             or not parsed.path.startswith("/ZhongBiao-zheng/game-atelier/-/releases/tag/")):
                raise ValueError("CNB 版本跳转地址无效。") from None
            return _tag_from_url(location)
    except (OSError, ValueError):
        if feed:
            raise
        with urllib.request.urlopen(urllib.request.Request(
            GITHUB_LATEST, headers={"Accept": "application/vnd.github+json",
                                    "User-Agent": "GameAtelier-Updater"}), timeout=10) as response:
            data = json.loads(response.read(65537))
    if (not isinstance(data, dict) or data.get("draft") is not False
            or data.get("prerelease") is not False or not data.get("published_at")):
        raise ValueError("更新源没有正式发布版。")
    return _tag_from_url(str(data.get("tag_name", "")))


def _member_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if not name or "\\" in name or path.is_absolute() or ".." in path.parts or ":" in name:
        raise ValueError("安装包包含不安全的路径。")
    return path


def extract_version(archive: Path, staging: Path, version: str) -> Path:
    """Extract only the selected payload; validate links before tar's data filter runs."""
    prefix = PurePosixPath("GameAtelier", "versions", version)
    staging.mkdir(parents=True, exist_ok=False)
    total = 0
    count = 0

    def selected(name: str, size: int) -> str | None:
        nonlocal total, count
        path = _member_path(name)
        count += 1
        if count > MAX_MEMBERS:
            raise ValueError("安装包文件数量超出限制。")
        if size < 0:
            raise ValueError("安装包文件大小无效。")
        total += size
        if total > MAX_UNPACKED:
            raise ValueError("安装包解压大小超出限制。")
        if not path.is_relative_to(prefix):
            return None
        relative = path.relative_to(prefix)
        return str(relative)

    try:
        if archive.suffix == ".zip":
            with zipfile.ZipFile(archive) as source:
                for member in source.infolist():
                    relative = selected(member.filename, member.file_size)
                    if relative is None:
                        continue
                    mode = member.external_attr >> 16
                    if stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR}:
                        raise ValueError("安装包包含不支持的链接或特殊文件。")
                    target = staging / relative
                    if member.is_dir():
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with source.open(member) as src, target.open("xb") as dst:
                            shutil.copyfileobj(src, dst)
                        target.chmod((mode & 0o755) or 0o644)
        else:
            with tarfile.open(archive, "r:gz") as source:
                for member in source:
                    relative = selected(member.name, member.size)
                    if relative is None:
                        continue
                    if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                        raise ValueError("安装包包含特殊文件。")
                    member = copy.copy(member)
                    member.name = relative
                    if member.issym():
                        link = member.linkname
                        if (not link or "\\" in link or ":" in link or link.startswith("/")
                                or posixpath.normpath(posixpath.join(posixpath.dirname(relative), link))
                                .startswith(("../", "/"))
                                or posixpath.normpath(posixpath.join(posixpath.dirname(relative), link)) == ".."):
                            raise ValueError("安装包链接指向版本目录外。")
                    elif member.islnk():
                        link = _member_path(member.linkname)
                        if not link.is_relative_to(prefix):
                            raise ValueError("安装包硬链接指向版本目录外。")
                        member.linkname = str(link.relative_to(prefix))
                    source.extract(member, path=staging, filter="data")
        return staging
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def probe_version(payload: Path, version: str) -> None:
    python = payload / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    entry = payload / "app/scripts/bootstrap.py"
    for path in (python, entry, payload / "VERSION"):
        if not path.is_file() or not path.resolve().is_relative_to(payload.resolve()):
            raise ValueError("新版安装包不完整。")
    if (payload / "VERSION").read_text(encoding="utf-8").strip() != version:
        raise ValueError("新版安装包版本不匹配。")
    with tempfile.TemporaryDirectory(prefix="atelier-update-probe-") as temporary:
        env = {**os.environ, "GAME_ATELIER_DATA_ROOT": temporary,
               "GAME_ATELIER_NO_UPDATE_CHECK": "1", "PYTHONUTF8": "1",
               "PYTHONPATH": str(payload / "app/src")}
        env.pop("VIRTUAL_ENV", None)
        env.pop("UV_PROJECT_ENVIRONMENT", None)
        env.pop("GAME_ATELIER_UPDATE_ID", None)
        env.pop("GAME_ATELIER_UPDATE_ROLLBACK_ID", None)
        result = subprocess.run([str(python), "-c", "import viewer_server.server"],
                                cwd=payload, env=env, capture_output=True, timeout=60)
        if result.returncode:
            raise ValueError("新版无法启动，请检查系统运行权限或重新下载安装包。")


class BundleDownloader:
    def __init__(self, root: Path, current: str):
        self.root = root
        self.current = current
        self.updates = root / "updates"

    def state(self) -> dict:
        return _read_json(self.updates / "state.json") or {
            "status": "idle", "to": None, "version": None, "bytes": 0, "reason": "",
        }

    def _state(self, status: str, version: str | None = None, *, size: int = 0,
               reason: str = "") -> dict:
        value = {"status": status, "to": version, "version": version, "bytes": size,
                 "reason": reason, "checked_at": time.time()}
        atomic_write_json(self.updates / "state.json", value)
        return value

    def _download(self, version: str) -> Path:
        target_platform = _platform_name()
        suffix = ".zip" if target_platform == "windows-x64" else ".tar.gz"
        filename = f"GameAtelier-{version}-{target_platform}{suffix}"
        archive = self.updates / filename
        part = archive.with_name(filename + ".part")
        feed = _test_feed()
        sources = [feed] if feed else [CNB, GITHUB]
        for base in sources:
            try:
                url = f"{base}/download/v{version}/{filename}"
                with urllib.request.urlopen(url + ".sha256", timeout=15) as response:
                    checksum = response.read(1025).decode("ascii").split()
                if not checksum or not re.fullmatch(r"[a-fA-F0-9]{64}", checksum[0]):
                    raise ValueError("安装包校验文件无效。")
                digest = hashlib.sha256()
                size = 0
                deadline = time.monotonic() + 15 * 60
                with urllib.request.urlopen(url, timeout=15) as response, part.open("wb") as output:
                    if int(response.headers.get("Content-Length", 0)) > MAX_ARCHIVE:
                        raise ValueError("安装包大小超出限制。")
                    while chunk := response.read(1024 * 1024):
                        size += len(chunk)
                        if size > MAX_ARCHIVE or time.monotonic() > deadline:
                            raise ValueError("安装包下载超出大小或时间限制。")
                        output.write(chunk)
                        digest.update(chunk)
                        self._state("downloading", version, size=size)
                if digest.hexdigest() != checksum[0].lower():
                    raise ValueError("安装包校验失败，请重新检查。")
                part.replace(archive)
                return archive
            except (OSError, ValueError, http.client.HTTPException):
                part.unlink(missing_ok=True)
                archive.unlink(missing_ok=True)
        raise ValueError("安装包下载或校验失败，请重新检查。")

    def check(self, retry_blocked: bool = False) -> dict:
        with try_file_lock(self.updates / "download.lock") as acquired:
            if not acquired:
                return self.state()
            previous = self.state()
            self._state("checking")
            version = None
            staging = None
            try:
                version = latest_version()
                if not VERSION.fullmatch(self.current):
                    raise ValueError("当前版本无效。")
                if tuple(map(int, version.split("."))) <= tuple(map(int, self.current.split("."))):
                    return self._state("idle")
                blocked = _read_json(self.updates / "blocked.json")
                if version in blocked and not retry_blocked:
                    return self._state("blocked", version, reason=str(blocked[version]))
                destination = self.root / "versions" / version
                if previous.get("status") == "ready" and previous.get("to") == version and destination.is_dir():
                    return self._state("ready", version, size=previous.get("bytes", 0))
                # Never replace a directory referenced by either active pointer.
                for pointer in ("current", "last-good"):
                    if (self.root / pointer).is_file() and (self.root / pointer).read_text().strip() == version:
                        raise ValueError("目标版本正在使用，不能重新下载。")
                archive = self._download(version)
                size = archive.stat().st_size
                staging = self.updates / f"{version}.staging"
                if staging.exists():
                    shutil.rmtree(staging)
                extract_version(archive, staging, version)
                try:
                    probe_version(staging, version)
                except (OSError, ValueError, subprocess.SubprocessError):
                    reason = "新版无法启动，已停止自动重试；可在设置中重新检查。"
                    block_version(self.root, version, reason)
                    return self._state("blocked", version, reason=reason)
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.exists():
                    shutil.rmtree(destination)
                staging.replace(destination)
                with file_lock(self.updates / "blocked.lock"):
                    blocked = _read_json(self.updates / "blocked.json")
                    blocked.pop(version, None)
                    atomic_write_json(self.updates / "blocked.json", blocked)
                archive.unlink(missing_ok=True)
                return self._state("ready", version, size=size)
            except (OSError, ValueError, http.client.HTTPException,
                    tarfile.TarError, zipfile.BadZipFile) as error:
                return self._state("error", version, reason=str(error))
            finally:
                if staging is not None and staging.exists():
                    shutil.rmtree(staging, ignore_errors=True)
