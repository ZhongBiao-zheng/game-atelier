"""正式 Release 发现、限时缓存和只更新 tag 的源码启动器。"""
import importlib.util
import io
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("bootstrap", REPO_ROOT / "scripts/bootstrap.py")
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


@pytest.fixture
def update_env(tmp_path, monkeypatch):
    cfg = tmp_path / "cfg"
    monkeypatch.setattr(bootstrap, "_user_config_dir", lambda: cfg)
    monkeypatch.setattr(bootstrap, "_current_version", lambda: "5.127.0")
    monkeypatch.setattr(bootstrap, "is_bundle", lambda: False)
    monkeypatch.delenv("GAME_ATELIER_NO_UPDATE_CHECK", raising=False)
    return cfg


def seed_cache(*, tag="v5.128.0", source="cnb", age=0, mode="git", **extra):
    bootstrap._write_update_cache({"channel": bootstrap.UPDATE_CACHE_CHANNEL, "mode": mode,
        "checked_at": time.time() - age, "release": bootstrap._release(tag, source) if tag else None,
        "latest": tag[1:] if tag else None, **extra})


def github_payload(tag="v5.128.0", **extra):
    return {"tag_name": tag, "draft": False, "prerelease": False,
            "published_at": "2026-10-26T00:00:00Z", **extra}


def test_fresh_fetch_and_source_cache_are_shared(update_env, monkeypatch):
    calls = []
    monkeypatch.setattr(bootstrap, "_fetch_latest_release", lambda use_git:
                        calls.append(use_git) or (bootstrap._release("v5.128.0", "cnb"), None))
    assert bootstrap.latest_release(use_git=True)["tag"] == "v5.128.0"
    assert bootstrap.update_info() == {"current": "5.127.0", "latest": "5.128.0",
                                      "update_available": True, "dismissed": False}
    assert calls == [True]


@pytest.mark.parametrize("tag", ["v5.127.0", "v5.126.0"])
def test_same_or_older_is_not_update(update_env, tag):
    seed_cache(tag=tag)
    assert not bootstrap.update_info()["update_available"]


def test_failures_have_one_diagnostic_and_failure_ttl(update_env, monkeypatch, capsys):
    calls = []
    monkeypatch.setattr(bootstrap, "_fetch_latest_release", lambda use_git: calls.append(1) or (None, "offline"))
    assert bootstrap.update_info()["latest"] is None
    assert bootstrap.update_info()["latest"] is None
    assert calls == [1]
    assert capsys.readouterr().err.count("无法检查更新：offline") == 1
    seed_cache(tag=None, age=bootstrap.UPDATE_CACHE_TTL_FAIL + 1)
    bootstrap.update_info()
    assert calls == [1, 1]


def test_success_cache_expires_and_old_main_cache_is_ignored(update_env, monkeypatch):
    calls = []
    monkeypatch.setattr(bootstrap, "_fetch_latest_release", lambda use_git:
                        calls.append(1) or (bootstrap._release("v5.128.0", "github"), None))
    seed_cache(age=bootstrap.UPDATE_CACHE_TTL_OK + 1)
    bootstrap.update_info()
    bootstrap._write_update_cache({"latest": "99.0.0", "checked_at": time.time()})
    assert bootstrap.update_info()["latest"] == "5.128.0"
    assert calls == [1, 1]


def test_bundle_cannot_reuse_source_only_tag_cache(update_env, monkeypatch):
    seed_cache(tag="v99.0.0")
    monkeypatch.setattr(bootstrap, "is_bundle", lambda: True)
    calls = []
    monkeypatch.setattr(bootstrap, "_fetch_latest_release", lambda use_git:
                        calls.append(use_git) or (bootstrap._release("v5.128.0", "github"), None))
    assert bootstrap.update_info()["latest"] == "5.128.0"
    assert calls == [False]


def test_dismiss_is_version_specific(update_env):
    seed_cache()
    assert bootstrap.dismiss_update() == 0
    assert bootstrap.update_info()["dismissed"] is True
    seed_cache(tag="v5.129.0", dismissed="5.128.0")
    assert not bootstrap.update_info()["dismissed"]


def test_kill_switch_does_not_query_or_write(update_env, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_NO_UPDATE_CHECK", "1")
    assert bootstrap.update_info() is None
    assert bootstrap.latest_release(use_git=True) is None
    assert not update_env.exists()


def test_cnb_selects_largest_strict_semver_without_http(monkeypatch):
    tags = "\n".join("a" * 40 + "\trefs/tags/" + tag for tag in
                     ["v5.9.0", "v5.128.0", "v5.129.0-rc1", "unrelated", "v05.200.0"])
    def run(command, **kwargs):
        assert command == ["git", "ls-remote", "--tags", "--refs", bootstrap.CNB_URL]
        assert kwargs["timeout"] <= 1.5
        return subprocess.CompletedProcess(command, 0, tags, "")
    monkeypatch.setattr(bootstrap.subprocess, "run", run)
    monkeypatch.setattr(bootstrap.urllib.request, "urlopen", lambda *a, **k: pytest.fail("无需HTTP"))
    assert bootstrap._query_latest_release(True, time.monotonic() + 3)["tag"] == "v5.128.0"


def test_cnb_timeout_leaves_budget_for_github(monkeypatch):
    def timeout(*a, **k):
        raise subprocess.TimeoutExpired("git", 1.5)
    monkeypatch.setattr(bootstrap.subprocess, "run", timeout)
    def urlopen(request, timeout):
        assert request.full_url == bootstrap.LATEST_RELEASE_URL
        assert 0 < timeout <= 3
        return io.BytesIO(json.dumps(github_payload()).encode())
    monkeypatch.setattr(bootstrap.urllib.request, "urlopen", urlopen)
    assert bootstrap._query_latest_release(True, time.monotonic() + 3)["source"] == "github"


@pytest.mark.parametrize("payload", [
    github_payload(draft=True), github_payload(prerelease=True), github_payload(published_at=None),
    github_payload("v5.128.0-rc1"), github_payload("main"), {"version": "5.128.0"}, [],
])
def test_http_rejects_unpublished_or_invalid_release(monkeypatch, payload):
    monkeypatch.setattr(bootstrap.urllib.request, "urlopen", lambda *a, **k:
                        io.BytesIO(json.dumps(payload).encode()))
    with pytest.raises((OSError, ValueError)):
        bootstrap._query_latest_release(False, time.monotonic() + 3)


def test_slow_response_cannot_exceed_total_budget_or_write_late_cache(update_env, monkeypatch):
    monkeypatch.setattr(bootstrap, "UPDATE_FETCH_TIMEOUT", .05)
    def slow(*args):
        time.sleep(.2)
        return bootstrap._release("v99.0.0", "github")
    monkeypatch.setattr(bootstrap, "_query_latest_release", slow)
    start = time.monotonic()
    assert bootstrap.latest_release() is None
    assert time.monotonic() - start < .18
    time.sleep(.25)
    assert bootstrap._read_update_cache()["release"] is None


def load_updater(monkeypatch, repo):
    monkeypatch.setitem(sys.modules, "bootstrap", bootstrap)
    spec = importlib.util.spec_from_file_location("self_update", REPO_ROOT / "scripts/self_update.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "REPO", repo)
    # 一键启动不读缓存、每次实查：查询源固定到本地测试仓库，不碰真实网络。
    origin = subprocess.check_output(["git", "remote", "get-url", "origin"], cwd=repo, text=True).strip()
    monkeypatch.setattr(bootstrap, "CNB_URL", origin)
    monkeypatch.setattr(bootstrap, "GITHUB_URL", origin)
    monkeypatch.setattr(bootstrap, "LATEST_RELEASE_URL", "http://127.0.0.1:9/releases/latest")
    return module


def git(repo, *args):
    return subprocess.check_output(["git", *args], cwd=repo, text=True, encoding="utf-8").strip()


@pytest.fixture
def source_repos(tmp_path):
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    producer = tmp_path / "producer"
    producer.mkdir()
    git(producer, "init", "-b", "main")
    git(producer, "config", "user.email", "test@example.invalid")
    git(producer, "config", "user.name", "Test")
    (producer / ".claude-plugin").mkdir()
    (producer / "web/dist").mkdir(parents=True)
    (producer / "web/dist/index.html").write_text("initial")
    (producer / ".claude-plugin/plugin.json").write_text('{"version":"5.127.0"}')
    git(producer, "add", ".")
    git(producer, "commit", "-m", "initial")
    git(producer, "remote", "add", "origin", str(remote))
    git(producer, "push", "-u", "origin", "main")
    local = tmp_path / "client"
    subprocess.run(["git", "clone", "-b", "main", str(remote), str(local)], check=True, capture_output=True)
    (producer / ".claude-plugin/plugin.json").write_text('{"version":"5.128.0"}')
    git(producer, "commit", "-am", "release")
    git(producer, "tag", "v5.128.0")
    released = git(producer, "rev-parse", "HEAD")
    (producer / "unreleased.txt").write_text("must not update to main")
    git(producer, "add", ".")
    git(producer, "commit", "-m", "unreleased")
    git(producer, "push", "origin", "main", "v5.128.0")
    return local, remote, released


def test_source_updates_only_to_published_tag_not_newer_main(source_repos, update_env, monkeypatch):
    local, remote, released = source_repos
    updater = load_updater(monkeypatch, local)
    # 缓存里是一小时前「已是最新」的结果：一键启动必须实查，不能被缓存挡住新发布的版本。
    seed_cache(tag="v5.127.0", age=3600)
    monkeypatch.setattr(bootstrap, "CNB_URL", str(remote))
    assert updater.main() == 10
    assert git(local, "rev-parse", "HEAD") == released
    assert not (local / "unreleased.txt").exists()
    assert git(local, "branch", "--show-current") == "main"
    monkeypatch.setattr(updater, "fetch", lambda *a: pytest.fail("同版本不能fetch"))
    assert updater.main() == 0


def test_source_offline_does_not_fetch_or_restore(source_repos, update_env, monkeypatch, capsys):
    local, _, _ = source_repos
    updater = load_updater(monkeypatch, local)
    monkeypatch.setattr(bootstrap, "_fetch_latest_release", lambda *a: (None, "offline"))
    monkeypatch.setattr(updater, "fetch", lambda *a: pytest.fail("离线不能fetch"))
    monkeypatch.setattr(updater, "restore_dist", lambda: pytest.fail("离线不改产物"))
    assert updater.main() == 0
    assert "无法检查更新：offline" in capsys.readouterr().err


def test_source_other_branch_is_not_auto_merged(source_repos, update_env, monkeypatch):
    local, _, _ = source_repos
    git(local, "switch", "-c", "dev")
    updater = load_updater(monkeypatch, local)
    seed_cache()
    monkeypatch.setattr(updater, "ask", lambda *a: "2")
    monkeypatch.setattr(updater, "fetch", lambda *a: pytest.fail("不应fetch"))
    assert updater.main() == 0
    assert git(local, "branch", "--show-current") == "dev"


def test_source_blocks_conflicts_then_stashes_only_named_files(source_repos, update_env, monkeypatch):
    local, remote, released = source_repos
    git(local, "config", "user.email", "test@example.invalid")
    git(local, "config", "user.name", "Test")
    updater = load_updater(monkeypatch, local)
    seed_cache()
    monkeypatch.setattr(bootstrap, "CNB_URL", str(remote))
    (local / ".claude-plugin/plugin.json").write_text('{"version":"5.127.0","local":true}')
    (local / "notes.txt").write_text("keep")
    monkeypatch.setattr(updater, "ask", lambda *a: "2")
    assert updater.main() == 0
    monkeypatch.setattr(updater, "ask", lambda *a: "1")
    assert updater.main() == 10
    assert git(local, "rev-parse", "HEAD") == released
    assert (local / "notes.txt").read_text() == "keep"
    assert "local" in git(local, "show", "stash@{0}:.claude-plugin/plugin.json")


def test_source_diverged_commits_are_not_overwritten(source_repos, update_env, monkeypatch, capsys):
    local, remote, _ = source_repos
    git(local, "config", "user.email", "test@example.invalid")
    git(local, "config", "user.name", "Test")
    (local / "local-work.txt").write_text("keep my commit")
    git(local, "add", ".")
    git(local, "commit", "-m", "local work")
    before = git(local, "rev-parse", "HEAD")
    updater = load_updater(monkeypatch, local)
    seed_cache()
    monkeypatch.setattr(bootstrap, "CNB_URL", str(remote))
    assert updater.main() == 0
    assert git(local, "rev-parse", "HEAD") == before
    assert "无法自动更新" in capsys.readouterr().out


def test_source_rejects_tag_manifest_mismatch(source_repos, update_env, monkeypatch, capsys):
    local, remote, _ = source_repos
    subprocess.run(["git", "--git-dir", str(remote), "tag", "v5.129.0", "main"], check=True)
    updater = load_updater(monkeypatch, local)
    seed_cache(tag="v5.129.0")
    monkeypatch.setattr(bootstrap, "CNB_URL", str(remote))
    before = git(local, "rev-parse", "HEAD")
    assert updater.main() == 0
    assert git(local, "rev-parse", "HEAD") == before
    assert "tag 与发布版本不一致" in capsys.readouterr().out
