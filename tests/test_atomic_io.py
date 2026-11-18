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
    monkeypatch.setattr(aio, "_RETRY_PERMISSION_ERRORS", True)
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
    monkeypatch.setattr(aio, "_RETRY_PERMISSION_ERRORS", True)
    monkeypatch.setattr(aio.time, "sleep", lambda _s: None)

    def always_denied(self, dst):
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr(Path, "replace", always_denied)
    target = tmp_path / "job.json"

    with pytest.raises(PermissionError):
        aio.atomic_write_json(target, {"x": 1})

    assert not target.exists()
    assert list(tmp_path.glob("*.tmp")) == []  # 失败后孤儿 tmp 也被清掉


def test_read_retries_while_file_is_being_replaced_on_windows(tmp_path, monkeypatch):
    # 保存供应商时 keys.json 被原地替换，同一瞬间启动的任务读它会拿到 PermissionError（Windows CI 实测）。
    monkeypatch.setattr(aio, "_RETRY_PERMISSION_ERRORS", True)
    monkeypatch.setattr(aio.time, "sleep", lambda _s: None)
    target = tmp_path / "keys.json"
    target.write_text('{"keys": []}', encoding="utf-8")
    calls = {"n": 0}
    real_read = Path.read_text

    def flaky_read(self, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] < 3:
            raise PermissionError(13, "Permission denied")
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", flaky_read)

    assert aio.read_text_with_retry(target) == '{"keys": []}'
    assert calls["n"] == 3


def test_read_does_not_retry_off_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(aio.os, "name", "posix")
    calls = {"n": 0}

    def denied(self, *args, **kwargs):
        calls["n"] += 1
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(Path, "read_text", denied)

    with pytest.raises(PermissionError):
        aio.read_text_with_retry(tmp_path / "keys.json")
    assert calls["n"] == 1


def test_keys_db_read_goes_through_the_retrying_reader(isolated_data_root, monkeypatch):
    # 不在这里把 os.name 改成 nt：pathlib 会据此去建 WindowsPath。只确认读取走的是带重试的入口。
    from character_workflow.lib import data_root, keys

    keys.write_keys_db(keys.KeysDB())
    seen = []
    real = keys.read_text_with_retry

    def spy(path, *args, **kwargs):
        seen.append(path)
        return real(path, *args, **kwargs)

    monkeypatch.setattr(keys, "read_text_with_retry", spy)

    assert keys.read_keys_db().keys == []
    assert seen == [data_root.keys_file()]
