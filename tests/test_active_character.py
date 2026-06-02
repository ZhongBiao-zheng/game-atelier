import time

import pytest

from character_workflow.lib.active_character import (
    read_active, write_active, ActiveCharacter,
)


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    runtime = tmp_path / ".runtime"
    runtime.mkdir()
    monkeypatch.setenv("RUNTIME_DIR", str(runtime))
    return runtime


def test_read_missing_returns_none(runtime):
    result = read_active()
    assert result.active_id is None


def test_write_then_read_roundtrip(runtime):
    write_active("shadow_assassin")
    result = read_active()
    assert result.active_id == "shadow_assassin"
    assert result.updated_at  # iso string non-empty


def test_overwrite_updates_timestamp(runtime):
    write_active("first")
    first_ts = read_active().updated_at
    time.sleep(0.01)
    write_active("second")
    second = read_active()
    assert second.active_id == "second"
    assert second.updated_at > first_ts


def test_write_creates_runtime_dir(tmp_path, monkeypatch):
    fresh = tmp_path / "fresh"
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(fresh))
    write_active("c1")
    assert (fresh / ".runtime" / "active-character.json").exists()


_ = ActiveCharacter  # silence unused import
