"""Bundle runtime boundaries; archive smoke is opt-in against the actual build artifact."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

import pytest

REPO = Path(__file__).resolve().parent.parent


def test_bundle_interpreter_skips_uv_and_venv(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("bundle_bootstrap", REPO / "scripts/bootstrap.py")
    boot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(boot)
    app = tmp_path / "app"
    (app / "web/dist").mkdir(parents=True)
    (app / "web/dist/index.html").touch()
    executable = tmp_path / "python/bin/python3"
    executable.parent.mkdir(parents=True)
    executable.touch()
    monkeypatch.setattr(boot, "PLUGIN_DIR", app)
    monkeypatch.setattr(sys, "executable", str(executable))
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path / "user-data"))
    monkeypatch.setattr(boot.shutil, "which", lambda name: None)
    assert boot.is_bundle()
    assert boot.check()["status"] == "needs_first_key"
    assert boot.ensure_venv() == 0
    assert not (tmp_path / "user-data/.venv").exists()
    monkeypatch.setattr(sys, "executable", str(tmp_path / "system/python"))
    assert not boot.is_bundle()
    assert boot.check()["status"] == "needs_uv"


@pytest.mark.skipif(not os.environ.get("ATELIER_BUNDLE_ARCHIVE"), reason="requires release archive")
@pytest.mark.parametrize("service", [False, True])
def test_relocated_archive_runs_without_system_tools_and_preserves_data(tmp_path, service):
    archive = Path(os.environ["ATELIER_BUNDLE_ARCHIVE"])
    unpack = tmp_path / "relocated folder"
    shutil.unpack_archive(archive, unpack)
    folder = next(unpack.iterdir())
    assert folder.name == "GameAtelier"
    version = (folder / "last-good").read_text().strip()
    payload = folder / "versions" / version
    python = payload / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    boot = payload / "app/scripts/bootstrap.py"
    data = tmp_path / "data"
    (data / ".config").mkdir(parents=True)
    sentinel = data / ".config/keep.txt"
    sentinel.write_text("persistent", encoding="utf-8")
    env = {**os.environ, "PATH": "", "GAME_ATELIER_DATA_ROOT": str(data),
           "GAME_ATELIER_NO_UPDATE_CHECK": "1", "BROWSER": "true",
           "PYTHONPATH": str(payload / "app/src"), "PYTHONUTF8": "1"}
    # Loopback remains available; outgoing HTTP is deliberately sent to an unused port.
    env.update(HTTP_PROXY="http://127.0.0.1:1", HTTPS_PROXY="http://127.0.0.1:1",
               NO_PROXY="127.0.0.1,localhost")
    process = None
    try:
        started = time.perf_counter()
        # Exercise the actual stable launcher, including recovery from a missing current.
        (folder / "current").unlink()
        if os.name == "nt":
            powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            command = [str(powershell), "-NoProfile", "-ExecutionPolicy", "Bypass",
                       "-File", str(folder / "launch.ps1")]
            if service:
                command += ["-Service", "-DataRoot", str(data)]
        else:
            command = ([str(python), str(boot), "--select-version", "--service"] if service
                       else [str(folder / "启动.command")])
        if service:
            process = subprocess.Popen(command, env=env, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 60
            while not (data / ".runtime/server.port").exists() and time.monotonic() < deadline:
                assert process.poll() is None, "foreground service exited before startup"
                time.sleep(0.1)
        else:
            result = subprocess.run(command, env=env,
                                    capture_output=True, text=True, encoding="utf-8", timeout=60)
            assert result.returncode == 0, result.stdout + result.stderr
        assert (folder / "current").read_text().strip() == version
        port = (data / ".runtime/server.port").read_text().strip()
        deadline = time.monotonic() + 10
        while True:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2) as response:
                    assert response.status == 200
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)
        if service:
            assert process.poll() is None
        print(f"bundle relocated startup: {time.perf_counter() - started:.2f}s")
        assert sentinel.read_text() == "persistent"
        assert not (data / ".venv").exists()
    finally:
        # Windows stop uses taskkill; restore OS tools only for cleanup.
        env["PATH"] = os.environ.get("PATH", "")
        subprocess.run([str(python), str(boot), "--run", "-m", "viewer_server.server", "stop"],
                       env=env, check=True, timeout=30)
        if process is not None:
            process.wait(timeout=30)
    shutil.rmtree(folder)
    assert sentinel.read_text() == "persistent"


@pytest.fixture
def versioned_bundle(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("layout_bootstrap", REPO / "scripts/bootstrap.py")
    boot = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(boot)
    root = tmp_path / "Game Atelier"
    for version in ("5.129.0", "5.129.1"):
        payload = root / "versions" / version
        executable = payload / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
        executable.parent.mkdir(parents=True)
        executable.touch()
        (payload / "app/scripts").mkdir(parents=True)
        (payload / "app/scripts/bootstrap.py").touch()
        (payload / "VERSION").write_text(version, encoding="utf-8")
    old = root / "versions/5.129.0"
    (root / "current").write_text("5.129.0\n", encoding="utf-8")
    (root / "last-good").write_text("5.129.0\n", encoding="utf-8")
    monkeypatch.setattr(boot, "PLUGIN_DIR", old / "app")
    monkeypatch.setattr(sys, "executable", str(old / "python" / (
        "python.exe" if os.name == "nt" else "bin/python3")))
    return boot, root


def test_bundle_selects_current_without_promoting_a_higher_download(versioned_bundle):
    boot, root = versioned_bundle
    assert boot.bundle_root() == root
    assert boot.select_bundle_version(root).name == "5.129.0"
    (root / "current").write_text("5.129.1\n", encoding="utf-8")
    assert boot.select_bundle_version(root).name == "5.129.1"
    assert (root / "last-good").read_text().strip() == "5.129.0"


@pytest.mark.parametrize("invalid", [None, "../outside", "5.130.0", "5.129.1-rc1", "\x00"])
def test_bundle_invalid_current_restores_last_good(versioned_bundle, invalid):
    boot, root = versioned_bundle
    if invalid is None:
        (root / "current").unlink()
    else:
        (root / "current").write_text(invalid, encoding="utf-8")
    assert boot.select_bundle_version(root).name == "5.129.0"
    assert (root / "current").read_text() == "5.129.0\n"


@pytest.mark.parametrize("missing", ["VERSION", "app/scripts/bootstrap.py", "python"])
def test_bundle_incomplete_current_uses_confirmed_version(versioned_bundle, missing):
    boot, root = versioned_bundle
    (root / "current").write_text("5.129.1", encoding="utf-8")
    target = root / "versions/5.129.1" / missing
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    assert boot.select_bundle_version(root).name == "5.129.0"


def test_bundle_wrong_manifest_and_missing_fallback_fail_closed(versioned_bundle):
    boot, root = versioned_bundle
    (root / "versions/5.129.0/VERSION").write_text("5.129.1", encoding="utf-8")
    with pytest.raises(ValueError, match="重新下载"):
        boot.select_bundle_version(root)


def test_bundle_invalid_manifest_encoding_restores_last_good(versioned_bundle):
    boot, root = versioned_bundle
    (root / "current").write_text("5.129.1", encoding="utf-8")
    (root / "versions/5.129.1/VERSION").write_bytes(b"\xff")
    assert boot.select_bundle_version(root).name == "5.129.0"


def test_bundle_failed_pointer_replace_preserves_old_value(versioned_bundle, monkeypatch):
    from character_workflow.lib import atomic_io
    boot, root = versioned_bundle
    (root / "current").write_text("5.130.0", encoding="utf-8")
    def fail(*args):
        raise PermissionError("locked")
    monkeypatch.setattr(atomic_io, "_replace_with_retry", fail)
    with pytest.raises(PermissionError):
        boot.select_bundle_version(root)
    assert (root / "current").read_text() == "5.130.0"
    assert not list(root.glob("*.tmp"))


@pytest.mark.parametrize("service", [False, True])
def test_bundle_dispatches_selected_interpreter_and_clean_environment(versioned_bundle, monkeypatch, service):
    boot, root = versioned_bundle
    (root / "current").write_text("5.129.1", encoding="utf-8")
    monkeypatch.setenv("VIRTUAL_ENV", "wrong")
    monkeypatch.setenv("UV_PROJECT_ENVIRONMENT", "wrong")
    monkeypatch.setenv("GAME_ATELIER_NO_UPDATE_CHECK", "1")
    def run(command, *, env):
        assert "versions/5.129.1/python" in Path(command[0]).as_posix()
        assert env["PYTHONPATH"] == str(root / "versions/5.129.1/app/src")
        assert "VIRTUAL_ENV" not in env and "UV_PROJECT_ENVIRONMENT" not in env
        if service:
            assert command[-2:] == ["start", "--no-browser"]
            assert env["GAME_ATELIER_SERVICE"] == "1"
            assert "GAME_ATELIER_NO_UPDATE_CHECK" not in env
        else:
            assert command[-1] == "--launch"
        return subprocess.CompletedProcess(command, 0)
    monkeypatch.setattr(boot.subprocess, "run", run)
    assert boot.launch_selected_version(service=service) == 0


@pytest.fixture
def release_checkout(tmp_path):
    """只向临时 bare 仓库推 tag，绝不触及真实 origin。"""
    import json
    if os.name == "nt" or not shutil.which("make"):
        pytest.skip("make release guard tests use the POSIX developer command")
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    local = tmp_path / "checkout"
    local.mkdir()
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=local, text=True, encoding="utf-8").strip()
    git("init", "-b", "main")
    git("config", "user.email", "test@example.invalid")
    git("config", "user.name", "Test")
    shutil.copyfile(REPO / "Makefile", local / "Makefile")
    (local / ".claude-plugin").mkdir()
    (local / ".claude-plugin/plugin.json").write_text(json.dumps({"version": "5.128.0"}), encoding="utf-8")
    (local / "web/src/lib").mkdir(parents=True)
    (local / "web/src/lib/changelog.ts").write_text("[{ version: '5.128.0', headline: 'Release' }]", encoding="utf-8")
    git("add", ".")
    git("commit", "-m", "release")
    git("remote", "add", "origin", str(remote))
    git("push", "-u", "origin", "main")
    return local, remote, git


def _make_release(local):
    import shlex
    return subprocess.run(["make", "release", "PYTHON=" + shlex.quote(sys.executable)], cwd=local,
                          capture_output=True, text=True, encoding="utf-8", timeout=45)


@pytest.mark.parametrize("condition,expected", [
    ("branch", "当前分支必须是 main"), ("dirty", "工作区必须干净"),
    ("local_tag", "本地已存在"), ("remote_tag", "远端已存在"),
    ("unpublished", "HEAD 与远端 main 不一致"),
    ("remote_advanced", "HEAD 与远端 main 不一致"),
    ("changelog", "更新日志最新一条"), ("version", "版本号必须是正式三段版本"),
    ("offline", "ls-remote 失败"),
])
def test_make_release_rejects_each_guard(release_checkout, condition, expected):
    local, remote, git = release_checkout
    if condition == "branch":
        git("switch", "-c", "dev")
    elif condition == "dirty":
        (local / "untracked.txt").write_text("work")
    elif condition in {"local_tag", "remote_tag"}:
        git("tag", "v5.128.0")
        if condition == "remote_tag":
            git("push", "origin", "v5.128.0")
            git("tag", "-d", "v5.128.0")
    elif condition in {"unpublished", "remote_advanced"}:
        before = git("rev-parse", "HEAD")
        (local / "extra.txt").write_text("another commit")
        git("add", ".")
        git("commit", "-m", "advance")
        if condition == "remote_advanced":
            git("push", "origin", "main")
            git("reset", "--hard", before)
            # 本地缓存故意指向旧提交；实时ls-remote仍必须发现远端领先。
            git("update-ref", "refs/remotes/origin/main", before)
    elif condition in {"changelog", "version"}:
        if condition == "changelog":
            (local / "web/src/lib/changelog.ts").write_text("[{ version: '5.127.0' }]")
        else:
            (local / ".claude-plugin/plugin.json").write_text('{"version":"5.128.0-rc1"}')
        git("add", ".")
        git("commit", "-m", "invalid metadata")
        git("push", "origin", "main")
    elif condition == "offline":
        git("remote", "set-url", "origin", str(local / "missing.git"))
    result = _make_release(local)
    assert result.returncode != 0
    assert expected in result.stderr
    tags = subprocess.check_output(["git", "--git-dir", str(remote), "tag"], text=True)
    assert tags.strip() == ("v5.128.0" if condition == "remote_tag" else "")


def test_make_release_pushes_only_approved_local_tag(release_checkout):
    local, remote, git = release_checkout
    # 不依赖过期的origin/main缓存：真实远端正确时应成功。
    git("update-ref", "-d", "refs/remotes/origin/main")
    result = _make_release(local)
    assert result.returncode == 0, result.stderr
    assert "已推送 v5.128.0" in result.stdout
    assert "https://github.com/" in result.stdout
    assert subprocess.check_output(["git", "--git-dir", str(remote), "rev-parse", "refs/tags/v5.128.0"], text=True).strip() == git("rev-parse", "HEAD")


@pytest.fixture
def update_feed(tmp_path, monkeypatch):
    """Loopback-only source exercises real HTTP download/checksum boundaries."""
    import functools
    import hashlib
    import http.server
    import threading
    from viewer_server import bundle_download as download

    root = tmp_path / "installation"
    root.mkdir()
    (root / "current").write_text("5.129.0", encoding="utf-8")
    (root / "last-good").write_text("5.129.0", encoding="utf-8")
    feed = tmp_path / "feed"
    files = feed / "download/v5.129.1"
    files.mkdir(parents=True)
    payload = tmp_path / "archive/GameAtelier/versions/5.129.1"
    (payload / "app/scripts").mkdir(parents=True)
    (payload / "app/scripts/bootstrap.py").write_text("# ready", encoding="utf-8")
    (payload / "VERSION").write_text("5.129.1", encoding="utf-8")
    (payload / "python/bin").mkdir(parents=True)
    executable = payload / "python/bin/python3"
    executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    executable.chmod(0o755)
    archive = Path(shutil.make_archive(str(files / "GameAtelier-5.129.1-linux-x64"), "gztar",
                                      root_dir=tmp_path / "archive", base_dir="GameAtelier"))
    checksum = archive.with_name(archive.name + ".sha256")
    checksum.write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name,
                        encoding="ascii")
    hits = []
    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            hits.append(self.path)
            if self.path == "/latest":
                self.send_response(307)
                self.send_header("Location", "/tag/v5.129.1")
                self.end_headers()
            else:
                super().do_GET()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
                                            functools.partial(Handler, directory=str(feed)))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    monkeypatch.setenv("GAME_ATELIER_TESTING", "1")
    monkeypatch.setenv("GAME_ATELIER_TEST_UPDATE_FEED", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setattr(download, "_platform_name", lambda: "linux-x64")
    monkeypatch.setattr(download, "probe_version", lambda *args: None)
    try:
        yield download, root, archive, checksum, hits
    finally:
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()


def test_bundle_downloader_prepares_verified_version_once(update_feed):
    download, root, archive, _, hits = update_feed
    updater = download.BundleDownloader(root, "5.129.0")
    result = updater.check()
    assert result["status"] == "ready"
    assert result["to"] == "5.129.1"
    assert result["bytes"] == archive.stat().st_size
    assert (root / "versions/5.129.1/VERSION").read_text() == "5.129.1"
    assert (root / "current").read_text() == "5.129.0"
    assert (root / "last-good").read_text() == "5.129.0"
    before = list(hits)
    assert updater.check()["status"] == "ready"
    assert hits[len(before):] == ["/latest"]
    assert not list((root / "updates").glob("*.staging"))


def test_bundle_checksum_error_is_retryable_without_blocking(update_feed):
    import hashlib
    download, root, archive, checksum, _ = update_feed
    updater = download.BundleDownloader(root, "5.129.0")
    checksum.write_text("0" * 64, encoding="ascii")
    assert updater.check()["status"] == "error"
    assert not (root / "updates/blocked.json").exists()
    assert not (root / "versions/5.129.1").exists()
    assert not list((root / "updates").glob("*.part"))
    checksum.write_text(hashlib.sha256(archive.read_bytes()).hexdigest(), encoding="ascii")
    assert updater.check()["status"] == "ready"


def test_bundle_probe_failure_blocks_until_explicit_retry(update_feed, monkeypatch):
    import json
    download, root, _, _, hits = update_feed
    updater = download.BundleDownloader(root, "5.129.0")
    def fail(*args):
        raise OSError("application policy denied interpreter")
    monkeypatch.setattr(download, "probe_version", fail)
    assert updater.check()["status"] == "blocked"
    assert "5.129.1" in json.loads((root / "updates/blocked.json").read_text())
    assert not (root / "versions/5.129.1").exists()
    before = list(hits)
    assert updater.check()["status"] == "blocked"
    assert hits[len(before):] == ["/latest"]
    monkeypatch.setattr(download, "probe_version", lambda *args: None)
    assert updater.check(retry_blocked=True)["status"] == "ready"
    assert json.loads((root / "updates/blocked.json").read_text()) == {}


def test_bundle_download_lock_prevents_parallel_check(update_feed):
    from character_workflow.lib.file_lock import try_file_lock
    download, root, _, _, hits = update_feed
    with try_file_lock(root / "updates/download.lock") as acquired:
        assert acquired
        assert download.BundleDownloader(root, "5.129.0").check()["status"] == "idle"
    assert hits == []


@pytest.mark.parametrize("name", ["/outside", "../outside", "GameAtelier/versions/5.129.1/../../outside",
                                  "C:/outside", "GameAtelier\\versions\\5.129.1\\outside"])
@pytest.mark.parametrize("kind", ["zip", "tar"])
def test_bundle_extraction_rejects_unsafe_member_paths(tmp_path, name, kind):
    import io
    import tarfile
    import zipfile
    from viewer_server.bundle_download import extract_version
    archive = tmp_path / ("package.zip" if kind == "zip" else "package.tar.gz")
    if kind == "zip":
        with zipfile.ZipFile(archive, "w") as source:
            # ZipInfo normalizes backslashes on Windows. Preserve the adversarial
            # archive name on disk so all platforms exercise the same input.
            member = zipfile.ZipInfo("placeholder")
            member.filename = name
            source.writestr(member, "bad")
    else:
        with tarfile.open(archive, "w:gz") as source:
            member = tarfile.TarInfo(name)
            member.size = 3
            source.addfile(member, io.BytesIO(b"bad"))
    staging = tmp_path / "staging"
    with pytest.raises(ValueError, match="路径"):
        extract_version(archive, staging, "5.129.1")
    assert not staging.exists()
    assert not (tmp_path / "outside").exists()


def test_bundle_tar_preserves_internal_links_and_executable_mode(tmp_path):
    import io
    import tarfile
    from viewer_server.bundle_download import extract_version
    archive = tmp_path / "package.tar.gz"
    prefix = "GameAtelier/versions/5.129.1/"
    with tarfile.open(archive, "w:gz") as source:
        file = tarfile.TarInfo(prefix + "python/bin/python3.11")
        file.size, file.mode = 3, 0o755
        source.addfile(file, io.BytesIO(b"exe"))
        link = tarfile.TarInfo(prefix + "python/bin/python3")
        link.type, link.linkname = tarfile.SYMTYPE, "python3.11"
        source.addfile(link)
    target = extract_version(archive, tmp_path / "staging", "5.129.1")
    assert (target / "python/bin/python3").read_bytes() == b"exe"
    if os.name != "nt":
        assert (target / "python/bin/python3.11").stat().st_mode & 0o111


@pytest.mark.parametrize("link_type,target", [("symlink", "../../../../outside"),
                                             ("hardlink", "GameAtelier/other/file")])
def test_bundle_tar_rejects_external_links(tmp_path, link_type, target):
    import tarfile
    from viewer_server.bundle_download import extract_version
    archive = tmp_path / "package.tar.gz"
    with tarfile.open(archive, "w:gz") as source:
        link = tarfile.TarInfo("GameAtelier/versions/5.129.1/link")
        link.type = tarfile.SYMTYPE if link_type == "symlink" else tarfile.LNKTYPE
        link.linkname = target
        source.addfile(link)
    with pytest.raises(ValueError, match="目录外"):
        extract_version(archive, tmp_path / "staging", "5.129.1")
    assert not (tmp_path / "staging").exists()


def test_bundle_test_feed_requires_explicit_testing_and_loopback(monkeypatch):
    from viewer_server.bundle_download import _test_feed
    monkeypatch.delenv("GAME_ATELIER_TESTING", raising=False)
    monkeypatch.setenv("GAME_ATELIER_TEST_UPDATE_FEED", "http://example.com")
    assert _test_feed() is None
    monkeypatch.setenv("GAME_ATELIER_TESTING", "1")
    with pytest.raises(ValueError, match="本机"):
        _test_feed()


def test_bundle_probe_uses_isolated_data_and_disables_update_checks(tmp_path, monkeypatch):
    from viewer_server.bundle_download import probe_version
    monkeypatch.setenv("GAME_ATELIER_UPDATE_ID", "previous-update")
    monkeypatch.setenv("GAME_ATELIER_UPDATE_ROLLBACK_ID", "previous-rollback")
    payload = tmp_path / "payload"
    executable = payload / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    executable.parent.mkdir(parents=True)
    executable.touch()
    (payload / "app/scripts").mkdir(parents=True)
    (payload / "app/scripts/bootstrap.py").touch()
    (payload / "VERSION").write_text("5.129.1", encoding="utf-8")
    observed = []
    def run(command, **kwargs):
        data = Path(kwargs["env"]["GAME_ATELIER_DATA_ROOT"])
        assert data.is_dir()
        assert data != tmp_path
        assert kwargs["env"]["GAME_ATELIER_NO_UPDATE_CHECK"] == "1"
        assert "GAME_ATELIER_UPDATE_ID" not in kwargs["env"]
        assert "GAME_ATELIER_UPDATE_ROLLBACK_ID" not in kwargs["env"]
        assert kwargs["timeout"] == 60
        assert command[-1] == "import viewer_server.server"
        observed.append(data)
        return subprocess.CompletedProcess(command, 0)
    monkeypatch.setattr(subprocess, "run", run)
    probe_version(payload, "5.129.1")
    assert observed and not observed[0].exists()
