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
def test_relocated_archive_runs_without_system_tools_and_preserves_data(tmp_path):
    archive = Path(os.environ["ATELIER_BUNDLE_ARCHIVE"])
    unpack = tmp_path / "relocated folder"
    shutil.unpack_archive(archive, unpack)
    folder = next(unpack.iterdir())
    python = folder / "python" / ("python.exe" if os.name == "nt" else "bin/python3")
    boot = folder / "app/scripts/bootstrap.py"
    data = tmp_path / "data"
    (data / ".config").mkdir(parents=True)
    sentinel = data / ".config/keep.txt"
    sentinel.write_text("persistent", encoding="utf-8")
    env = {**os.environ, "PATH": "", "GAME_ATELIER_DATA_ROOT": str(data),
           "GAME_ATELIER_NO_UPDATE_CHECK": "1", "BROWSER": "true",
           "PYTHONPATH": str(folder / "app/src"), "PYTHONUTF8": "1"}
    # Loopback remains available; outgoing HTTP is deliberately sent to an unused port.
    env.update(HTTP_PROXY="http://127.0.0.1:1", HTTPS_PROXY="http://127.0.0.1:1",
               NO_PROXY="127.0.0.1,localhost")
    try:
        started = time.perf_counter()
        result = subprocess.run([str(python), str(boot), "--launch"], env=env,
                                capture_output=True, text=True, encoding="utf-8", timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        port = (data / ".runtime/server.port").read_text().strip()
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10) as response:
            assert response.status == 200
        print(f"bundle relocated startup: {time.perf_counter() - started:.2f}s")
        assert sentinel.read_text() == "persistent"
        assert not (data / ".venv").exists()
    finally:
        # Windows stop uses taskkill; restore OS tools only for cleanup.
        env["PATH"] = os.environ.get("PATH", "")
        subprocess.run([str(python), str(boot), "--run", "-m", "viewer_server.server", "stop"],
                       env=env, check=True, timeout=30)
    shutil.rmtree(folder)
    assert sentinel.read_text() == "persistent"


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
