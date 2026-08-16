"""bootstrap.py 更新检查：缓存 TTL / 版本比较 / dismiss / 关网开关。

进程内 import bootstrap 模块做单测（test_bootstrap.py 走子进程黑盒，这里要 mock 网络）。
"""
import importlib.util
import json
import time
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent

spec = importlib.util.spec_from_file_location("bootstrap", REPO_ROOT / "scripts" / "bootstrap.py")
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


@pytest.fixture
def update_env(tmp_path, monkeypatch):
    """隔离 cache 目录、解除 conftest 的关网开关、mock 网络与当前版本。"""
    cfg_dir = tmp_path / "cfg"
    monkeypatch.setattr(bootstrap, "_user_config_dir", lambda: cfg_dir)
    monkeypatch.delenv("GAME_ATELIER_NO_UPDATE_CHECK", raising=False)
    monkeypatch.setattr(bootstrap, "_current_version", lambda: "5.0.0")
    return cfg_dir


def _seed_cache(cfg_dir: Path, **fields):
    cfg_dir.mkdir(parents=True, exist_ok=True)
    (cfg_dir / "update-check.json").write_text(
        json.dumps(fields, ensure_ascii=False), encoding="utf-8"
    )


def test_fresh_fetch_detects_update(update_env, monkeypatch):
    monkeypatch.setattr(bootstrap, "_fetch_latest_version", lambda: "5.1.0")
    info = bootstrap.update_info()
    assert info == {
        "current": "5.0.0", "latest": "5.1.0", "update_available": True, "dismissed": False,
    }
    cache = json.loads((update_env / "update-check.json").read_text(encoding="utf-8"))
    assert cache["latest"] == "5.1.0"
    assert cache["checked_at"] > 0


def test_fresh_cache_skips_network(update_env, monkeypatch):
    _seed_cache(update_env, checked_at=time.time(), latest="5.1.0")

    def boom():
        raise AssertionError("cache 未过期不应联网")

    monkeypatch.setattr(bootstrap, "_fetch_latest_version", boom)
    info = bootstrap.update_info()
    assert info["update_available"] is True


def test_same_or_lower_version_is_not_update(update_env, monkeypatch):
    for latest in ("5.0.0", "4.9.9"):
        _seed_cache(update_env, checked_at=time.time(), latest=latest)
        info = bootstrap.update_info()
        assert info["update_available"] is False, latest


def test_network_failure_is_silent_and_cached(update_env, monkeypatch):
    calls = []

    def fail():
        calls.append(1)
        return None

    monkeypatch.setattr(bootstrap, "_fetch_latest_version", fail)
    info = bootstrap.update_info()
    assert info["update_available"] is False
    assert info["latest"] is None
    # 失败结果也缓存（1h TTL）：紧接着再查不该重复联网
    bootstrap.update_info()
    assert len(calls) == 1


def test_failure_cache_expires_after_fail_ttl(update_env, monkeypatch):
    _seed_cache(update_env, checked_at=time.time() - bootstrap.UPDATE_CACHE_TTL_FAIL - 1,
                latest=None)
    monkeypatch.setattr(bootstrap, "_fetch_latest_version", lambda: "5.1.0")
    assert bootstrap.update_info()["update_available"] is True


def test_dismiss_silences_same_version_only(update_env, monkeypatch):
    _seed_cache(update_env, checked_at=time.time(), latest="5.1.0")
    assert bootstrap.dismiss_update() == 0
    assert bootstrap.update_info()["dismissed"] is True

    # 出了更高版本：dismissed 自动失效
    cache = json.loads((update_env / "update-check.json").read_text(encoding="utf-8"))
    cache.update({"checked_at": time.time(), "latest": "5.2.0"})
    _seed_cache(update_env, **cache)
    info = bootstrap.update_info()
    assert info["update_available"] is True
    assert info["dismissed"] is False


def test_kill_switch_returns_none(update_env, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_NO_UPDATE_CHECK", "1")
    assert bootstrap.update_info() is None


def test_malformed_latest_version_is_not_update(update_env):
    _seed_cache(update_env, checked_at=time.time(), latest="5.1.0-beta")
    assert bootstrap.update_info()["update_available"] is False
