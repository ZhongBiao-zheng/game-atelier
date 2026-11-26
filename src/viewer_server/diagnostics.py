"""Download recent service errors without copying exception messages or source lines."""
from __future__ import annotations

import heapq
import json
import logging
import os
import platform
import re
import stat
import sys
import traceback
from collections import deque
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from character_workflow.lib import data_root
from viewer_server.connection_status import app_version

router = APIRouter()
logger = logging.getLogger(__name__)
_TAIL_BYTES = 1024 * 1024
_FILE_LIMIT = 4
_EVENT_LIMIT = 100
_FRAME_LIMIT = 6
_MARKER = "ATELIER_KEY_CONFIG_ERROR "
_HEADER = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3}) (DEBUG|INFO|WARNING|ERROR|CRITICAL) ([\w.]+): (.*)$")
_ROTATED = re.compile(r"server\.log\.\d{4}-\d\d-\d\d")
_FRAME = re.compile(r'^  File "([^"\r\n]+)", line (\d{1,7})(?:, in .*)?$')
_EXCEPTION = re.compile(r"^([a-zA-Z_][\w.]*)\s*:(.*)$")
_CODE = re.compile(r"^\s*\[(Errno|WinError) (-?\d{1,10})\]")
_PYWIN_CODE = re.compile(r"^\s*\((-?\d{1,10}),")
_KNOWN = frozenset("""
    ArithmeticError AssertionError AttributeError BlockingIOError BrokenPipeError
    CancelledError ChildProcessError ConnectError ConnectionAbortedError ConnectionError
    ConnectionRefusedError ConnectionResetError DecodeError FileExistsError FileNotFoundError
    HTTPError HTTPException ImportError IndexError IsADirectoryError JSONDecodeError
    KeyError KeysConfigError _UnreadableKeysJSON LookupError MemoryError ModuleNotFoundError NotADirectoryError NotImplementedError
    OSError OverflowError PermissionError ReadTimeout RecursionError RuntimeError
    TimeoutError TypeError UnicodeDecodeError UnicodeEncodeError ValueError ValidationError
    WindowsError ZeroDivisionError pywintypes.error
""".split())
_SRC = Path(__file__).resolve().parents[1]


@lru_cache(maxsize=1)
def _product_files():
    return {file.relative_to(_SRC).as_posix() for name in ("viewer_server", "character_workflow")
            for file in (_SRC / name).rglob("*.py")}


def _location(path, number):
    parts = path.replace("\\", "/").split("/")
    for index, part in enumerate(parts):
        if part in {"viewer_server", "character_workflow"}:
            module = "/".join(parts[index:])
            if module in _product_files() and 0 < number <= 9999999:
                return {"file": module, "line": number}
    return None


def _error_type(name):
    if name == "pywintypes.error":
        return name
    short = name.rsplit(".", 1)[-1]
    return short if short in _KNOWN else "Exception"


def _number(value):
    return value if type(value) is int and -(2**31) <= value < 2**32 else None


def record_key_config_error(error: BaseException, *, read_only: bool = False) -> None:
    """Log a handled key configuration failure without its alias, body or exception text."""
    cls = type(error)
    name = _error_type(f"{cls.__module__}.{cls.__name__}")
    locations = []
    for frame, number in traceback.walk_tb(error.__traceback__):
        if location := _location(frame.f_code.co_filename, number):
            locations.append(location)
    winerror = getattr(error, "winerror", None)
    if winerror is None and name == "pywintypes.error" and error.args:
        winerror = error.args[0]
    event = "key_read_failed" if read_only else "key_save_failed"
    record = {"event": event, "exception": name, "errno": _number(getattr(error, "errno", None)),
              "winerror": _number(winerror), "locations": locations[-_FRAME_LIMIT:]}
    logger.error("%s%s", _MARKER, json.dumps(record, separators=(",", ":")))


def _safe_record(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get("exception"), str):
        return None
    event = raw.get("event")
    if not isinstance(event, str) or event not in {"key_read_failed", "key_save_failed"}:
        return None
    locations = []
    rows = raw.get("locations")
    if not isinstance(rows, list):
        return None
    for row in rows[-_FRAME_LIMIT:]:
        if (isinstance(row, dict) and isinstance(row.get("file"), str)
                and type(row.get("line")) is int):
            if location := _location(row["file"], row["line"]):
                locations.append(location)
    return {"event": event, "exception": _error_type(raw["exception"]), "errno": _number(raw.get("errno")),
            "winerror": _number(raw.get("winerror")), "locations": locations}


def _read_tail(path):
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode)
                or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            return ""
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or not os.path.samestat(info, opened):
                return ""
            start = max(0, opened.st_size - _TAIL_BYTES)
            stream.seek(start)
            raw = stream.read(_TAIL_BYTES)
            if start:
                raw = raw.partition(b"\n")[2]
            return raw.decode("utf-8", errors="replace")
    except OSError:
        return ""


def _events(content):
    timestamp = None
    in_trace = False
    locations = deque(maxlen=_FRAME_LIMIT)
    for line in content.splitlines():
        if len(line) > 8192:
            continue
        header = _HEADER.match(line)
        if header:
            timestamp = None
            in_trace = False
            locations.clear()
            stamp, level, component, message = header.groups()
            if level not in {"ERROR", "CRITICAL", "WARNING"}:
                continue
            try:
                timestamp = datetime.fromisoformat(stamp.replace(",", ".")).astimezone(timezone.utc).isoformat()
            except (ValueError, OSError, OverflowError):
                continue
            if component == __name__ and message.startswith(_MARKER):
                try:
                    record = _safe_record(json.loads(message[len(_MARKER):]))
                except (ValueError, RecursionError):
                    continue
                if record:
                    yield {"time": timestamp, **record}
            continue
        if timestamp is None:
            continue
        if line == "Traceback (most recent call last):":
            in_trace = True
            locations.clear()
            continue
        if not in_trace:
            continue
        if frame := _FRAME.match(line):
            if location := _location(frame[1], int(frame[2])):
                locations.append(location)
        elif error := _EXCEPTION.match(line):
            in_trace = False
            kind = _error_type(error[1])
            errno = winerror = None
            if code := _CODE.match(error[2]):
                if code[1] == "WinError":
                    winerror = _number(int(code[2]))
                else:
                    errno = _number(int(code[2]))
            elif kind == "pywintypes.error" and (code := _PYWIN_CODE.match(error[2])):
                winerror = _number(int(code[1]))
            yield {"time": timestamp, "event": "traceback", "exception": kind,
                   "errno": errno, "winerror": winerror, "locations": list(locations)}


def _log_files(runtime):
    try:
        info = runtime.lstat()
        if (not stat.S_ISDIR(info.st_mode)
                or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            return []
        rotated = heapq.nlargest(_FILE_LIMIT - 1, (p for p in runtime.iterdir() if _ROTATED.fullmatch(p.name)))
        return [*reversed(rotated), runtime / "server.log"]
    except OSError:
        return []


def _desktop_log():
    # Desktop runtime layout is fixed by desktop/src/runtime.mjs. A source server,
    # portable bundle or Linux service cannot attribute a user's shell logs to itself.
    app = _SRC.parent
    version = app.parent
    bundle = version.parent.parent
    if (app.name != "app" or version.parent.name != "versions" or bundle.name != "GameAtelier"
            or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version.name)):
        return None
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        return None
    expected = base / "game-atelier" / "runtime"
    return expected / "shell.log" if base.is_absolute() and bundle.parent == expected else None


_RENDERER_EVENT = re.compile(
    r"(\d{10}) page process gone: "
    r"(abnormal-exit|killed|crashed|oom|launch-failed|integrity-failure|memory-eviction)"
    r"(?: \(exit (-?\d{1,10})\))?"
)
_RESTART_EVENT = re.compile(r"(\d{10}) server stopped; restarting it once")


def _desktop_events(content):
    for line in content.splitlines():
        if match := _RENDERER_EVENT.fullmatch(line):
            event = {"event": "desktop_renderer_gone", "reason": match[2],
                     "exit_code": _number(int(match[3])) if match[3] else None}
        elif match := _RESTART_EVENT.fullmatch(line):
            event = {"event": "desktop_server_restart"}
        else:
            continue
        try:
            stamp = datetime.fromtimestamp(int(match[1]), timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            continue
        yield {"time": stamp, **event}


@router.get("/api/diagnostics/export")
def export_diagnostics():
    now = datetime.now(timezone.utc)
    events = deque(maxlen=_EVENT_LIMIT)
    for path in _log_files(data_root.runtime_dir()):
        events.extend(_events(_read_tail(path)))
    latest = list(events)
    shell = _desktop_log()
    if shell is not None:
        latest.extend(deque(_desktop_events(_read_tail(shell)), maxlen=_EVENT_LIMIT))
        latest = sorted(latest, key=lambda event: event["time"])[-_EVENT_LIMIT:]
    os_name = platform.system()
    report = {"schema_version": 1, "exported_at": now.isoformat(), "app_version": app_version(),
              "os": os_name if os_name in {"Windows", "Darwin", "Linux"} else "Other",
              "events": latest}
    return JSONResponse(report, headers={
        "Content-Disposition": f'attachment; filename="atelier-diagnostics-{now:%Y%m%d}.json"',
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    })
