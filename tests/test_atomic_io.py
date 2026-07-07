"""atomic_io：Windows 下 os.replace 瞬时 access denied 的重试行为。

模拟的是真实事故——火山额度耗尽时，写 FAILED 错误这一步因 Defender / 长驻 server
占着文件抛 WinError 5，把真错误盖成误导性的文件改名错误。重试让该写入越过瞬时占用。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import character_workflow.lib.atomic_io as aio


def test_replace_retries_then_succeeds_on_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(aio.os, "name", "nt")
    monkeypatch.setattr(aio.time, "sleep", lambda _s: None)
    calls = {"n": 0}
    real_replace = Path.replace

    def flaky_replace(self, dst):
        calls["n"] += 1
        if calls["n"] < 3:
            raise PermissionError(13, "Access is denied")
        return real_replace(self, dst)

    monkeypatch.setattr(Path, "replace", flaky_replace)
    target = tmp_path / "job.json"

    aio.atomic_write_json(target, {"status": "FAILED", "error": "额度没了"})

    assert calls["n"] == 3
    assert json.loads(target.read_text(encoding="utf-8")) == {"status": "FAILED", "error": "额度没了"}
    assert list(tmp_path.glob("*.tmp")) == []  # 成功后无孤儿 tmp


def test_replace_reraises_after_exhausting_attempts(tmp_path, monkeypatch):
    monkeypatch.setattr(aio.os, "name", "nt")
    monkeypatch.setattr(aio.time, "sleep", lambda _s: None)

    def always_denied(self, dst):
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr(Path, "replace", always_denied)
    target = tmp_path / "job.json"

    with pytest.raises(PermissionError):
        aio.atomic_write_json(target, {"x": 1})

    assert not target.exists()
    assert list(tmp_path.glob("*.tmp")) == []  # 失败后孤儿 tmp 也被清掉
