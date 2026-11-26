import json
import logging
import os

from fastapi.testclient import TestClient

from tests.test_local_connection_auth import ORIGIN, bootstrap, create_grant
from viewer_server import diagnostics
from viewer_server.server_app import build_app


def test_export_reads_recent_tracebacks_and_keeps_only_safe_fields(isolated_data_root):
    root = isolated_data_root / ".runtime"
    root.mkdir(exist_ok=True)
    stamp = "2026-11-25 13:16:49,100"
    private = "https://example.invalid/?token=USER_SECRET/raw-prompt"
    (root / "server.log.2026-11-24").write_text(
        f"{stamp} ERROR uvicorn.error: raw body {private}\n"
        "Traceback (most recent call last):\n"
        '  File "C:\\Users\\PERSON\\Atelier\\src\\viewer_server\\routes.py", line 1228, in USER_SECRET\n'
        f"    leak({private})\n"
        f'  File "/home/PERSON/character_workflow/lib/USER_SECRET.py", line 9, in save\n'
        f"pywintypes.error: (1332, 'LookupAccountName', '{private}')\n", encoding="utf-8")
    (root / "server.log").write_text(
        f"{stamp} ERROR uvicorn.error: failure\nTraceback (most recent call last):\n"
        '  File "/home/PERSON/src/character_workflow/lib/keys.py", line 77, in save\n'
        f"PermissionError: [WinError 5] {private}\n"
        f"{stamp} INFO user: {private}\nTraceback (most recent call last):\n"
        f"ValueError: {private}\n", encoding="utf-8")
    (root / "server.log.bak").write_text(
        f"{stamp} ERROR uvicorn.error: Untrusted\nTraceback (most recent call last):\n"
        "OverflowError: ignore\n", encoding="utf-8")

    client = TestClient(build_app(), base_url=ORIGIN)
    path = "/api/diagnostics/export"
    assert client.get(path).status_code == 401
    bootstrap(client)
    response = client.get(path)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-disposition"].startswith('attachment; filename="atelier-diagnostics-')
    events = response.json()["events"]
    assert [(e["exception"], e["winerror"]) for e in events] == [("pywintypes.error", 1332), ("PermissionError", 5)]
    assert events[0]["locations"] == [{"file": "viewer_server/routes.py", "line": 1228}]
    assert events[1]["locations"] == [{"file": "character_workflow/lib/keys.py", "line": 77}]
    assert all(secret not in response.text for secret in ("PERSON", "USER_SECRET", "example.invalid", "raw-prompt"))
    native, *_ = create_grant(client)
    assert native.get(path).status_code == 403


def test_safe_handled_error_roundtrips_without_logging_exception_message(caplog):
    try:
        raise PermissionError(13, "sk-private fixture prompt /home/visitor")
    except PermissionError as error:
        with caplog.at_level(logging.ERROR):
            diagnostics.record_key_config_error(error)
    message = caplog.records[-1].getMessage()
    assert "/home" not in message and "sk-private" not in message
    line = "2026-11-26 12:00:00,123 ERROR viewer_server.diagnostics: " + message
    event, = diagnostics._events(line)
    assert event["event"] == "key_save_failed" and event["exception"] == "PermissionError" and event["errno"] == 13
    forged = json.dumps({"event": "key_save_failed", "exception": "private.text", "winerror": "SECRET", "errno": {}, "locations": [
        {"file": "/home/secret/thing.py", "line": 44}]})
    other, = diagnostics._events(line[:line.index(diagnostics._MARKER)] + diagnostics._MARKER + forged)
    assert other["exception"] == "Exception" and other["winerror"] is None and other["locations"] == []


def test_bounded_logs_and_symlinks(monkeypatch, tmp_path):
    monkeypatch.setattr(diagnostics, "_TAIL_BYTES", 12)
    file = tmp_path / "server.log"
    file.write_bytes(b"ignored first line\nvisible\n")
    assert diagnostics._read_tail(file) == "visible\n"
    for day in range(1, 10):
        (tmp_path / f"server.log.2026-11-{day:02}").touch()
    assert [p.name for p in diagnostics._log_files(tmp_path)] == [
        "server.log.2026-11-07", "server.log.2026-11-08", "server.log.2026-11-09", "server.log"]
    if os.name != "nt":
        link = tmp_path / "server.log.2026-11-10"
        link.symlink_to(file)
        assert diagnostics._read_tail(link) == ""


def test_desktop_log_is_read_only_from_matching_installed_runtime(tmp_path, monkeypatch):
    from types import SimpleNamespace
    local = tmp_path / "windows-local"
    monkeypatch.setenv("LOCALAPPDATA", str(local))
    monkeypatch.setenv("ATELIER_RUNTIME_ROOT", str(tmp_path / "arbitrary"))
    monkeypatch.setattr(diagnostics, "sys", SimpleNamespace(platform="win32"))
    expected = local / "game-atelier" / "runtime"
    source = expected / "GameAtelier" / "versions" / "5.142.0" / "app" / "src"
    monkeypatch.setattr(diagnostics, "_SRC", source)
    assert diagnostics._desktop_log() == expected / "shell.log"
    monkeypatch.setattr(diagnostics, "_SRC", tmp_path / "portable" / "GameAtelier" / "versions" / "5.142.0" / "app" / "src")
    assert diagnostics._desktop_log() is None
    monkeypatch.setattr(diagnostics, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(diagnostics, "_SRC", source)
    assert diagnostics._desktop_log() is None


def test_old_and_new_desktop_events_merge_without_shell_urls_or_raw_messages(isolated_data_root, monkeypatch):
    runtime = isolated_data_root / ".runtime"
    runtime.mkdir(exist_ok=True)
    (runtime / "server.log").write_text(
        "2026-11-25 09:00:00,100 ERROR uvicorn.error: SECRET\nTraceback (most recent call last):\n"
        "ValueError: https://secret.invalid/prompt\n", encoding="utf-8")
    shell = isolated_data_root / "shell.log"
    shell.write_text(
        "1700000000 page process gone: oom\n"
        "1700000001 page process gone: crashed (exit -1073741819)\n"
        "1700000002 page process gone: crashed (exit 1) https://secret.invalid\n"
        "1700000003 page process gone: clean-exit\n"
        "1700000004 page process gone: SECRET\n"
        "1700000005 page loaded http://secret.invalid\n"
        "1700000006 server stopped; restarting it once\n", encoding="utf-8")
    monkeypatch.setattr(diagnostics, "_desktop_log", lambda: shell)
    client = TestClient(build_app(), base_url=ORIGIN)
    bootstrap(client)
    response = client.get("/api/diagnostics/export")
    rows = response.json()["events"]
    assert [row["event"] for row in rows] == [
        "desktop_renderer_gone", "desktop_renderer_gone", "desktop_server_restart", "traceback"]
    assert rows[0]["reason"] == "oom" and rows[0]["exit_code"] is None
    assert rows[1]["reason"] == "crashed" and rows[1]["exit_code"] == -1073741819
    assert "SECRET" not in response.text and "secret.invalid" not in response.text


def test_recent_limit_compares_service_local_time_and_desktop_unix_time(isolated_data_root, monkeypatch):
    from datetime import datetime, timezone

    # Logging.Formatter uses the machine's local clock. Generate a local line for an
    # absolute instant, and verify both its UTC representation and the cutoff across sources.
    instant = datetime(2026, 11, 25, 1, 0, tzinfo=timezone.utc)
    local_stamp = instant.astimezone().strftime("%Y-%m-%d %H:%M:%S,500")
    trace = f"{local_stamp} ERROR uvicorn.error: example\nTraceback (most recent call last):\nOSError: sample\n"
    event, = diagnostics._events(trace)
    assert event["time"] == "2026-11-25T01:00:00.500000+00:00"
    runtime = isolated_data_root / ".runtime"
    runtime.mkdir(exist_ok=True)
    (runtime / "server.log").write_text(trace, encoding="utf-8")
    shell = isolated_data_root / "shell.log"
    shell.write_text(f"{int(instant.timestamp()) + 1} page process gone: oom\n", encoding="utf-8")
    monkeypatch.setattr(diagnostics, "_desktop_log", lambda: shell)
    monkeypatch.setattr(diagnostics, "_EVENT_LIMIT", 1)
    report = json.loads(diagnostics.export_diagnostics().body)
    assert report["events"][0]["event"] == "desktop_renderer_gone"


def test_handled_key_read_errors_preserve_only_known_storage_types(caplog):
    from character_workflow.lib.keys import KeysConfigError, _UnreadableKeysJSON

    for kind in (KeysConfigError, _UnreadableKeysJSON):
        with caplog.at_level(logging.ERROR):
            diagnostics.record_key_config_error(kind("/home/private raw credential"), read_only=True)
        message = caplog.records[-1].getMessage()
        assert "private" not in message
        event, = diagnostics._events("2026-11-26 12:00:00,123 ERROR viewer_server.diagnostics: " + message)
        assert (event["event"], event["exception"]) == ("key_read_failed", kind.__name__)
