import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.parse import quote

import pytest

from scripts.agent_eval import _server, host


def test_only_named_providers_are_copied_to_the_disposable_db(tmp_path):
    private = tmp_path / ".config"
    private.mkdir()
    db = {
        "keys": [
            {"alias": "a", "access_key": "synthetic-a"},
            {"alias": "b", "access_key": "synthetic-b"},
        ],
        "default_alias": "b",
        "oss": {"access_key_secret": "synthetic-oss"},
    }
    path = private / "keys.json"
    path.write_text(json.dumps(db), encoding="utf-8")
    assert host.selected_keys(tmp_path, ["a"]) == {"version": 1, "keys": [db["keys"][0]]}
    assert json.loads(path.read_text(encoding="utf-8")) == db
    with pytest.raises(ValueError, match="不存在"):
        host.selected_keys(tmp_path, ["missing"])


def test_report_scrubber_removes_credentials_urls_and_nested_request_headers(tmp_path):
    token = "synthetic / token+123"
    with host.LocalAPI(31313, tmp_path / "data", {"keys": [{"access_key": token}]}) as api:
        row = api.scrub(
            {
                "prompt": "Draw a tree",
                "trace": [
                    {"nested": {"request_headers": {"X-Vendor-Proof": "private-header"}}},
                    "POST https://user:pw@host.invalid/generate?token=abc",
                    "Authorization: Bearer a-different-secret",
                    quote(token, safe=""),
                    {"parameter": token},
                    str(tmp_path / "data" / "job.png"),
                ],
            }
        )
    text = json.dumps(row)
    assert row["prompt"] == "Draw a tree"
    for private in (
        token,
        quote(token, safe=""),
        "host.invalid",
        "private-header",
        "a-different-secret",
        str(tmp_path),
    ):
        assert private not in text


def test_fake_transport_denies_external_dns_and_all_unselected_loopback_ports(monkeypatch, tmp_path):
    import socket

    with pytest.raises(ValueError, match="回环"):
        host._fake_ports({"keys": [{"base_url": "https://unselected.invalid/v1"}]})
    filters = []
    monkeypatch.setattr(_server.sys, "addaudithook", filters.append)
    _server.restrict_network({31314}, tmp_path / "preflight")
    (audit,) = filters
    with pytest.raises(PermissionError, match="DNS"):
        audit("socket.getaddrinfo", ("unselected.invalid", 443))
    with socket.socket() as client:
        for address in [("127.0.0.1", 31315), ("192.0.2.1", 31314)]:
            with pytest.raises(PermissionError, match="假上游"):
                audit("socket.connect", (client, address))
        audit("socket.connect", (client, ("127.0.0.1", 31314)))


# Pause a real evaluator only after it has authenticated to its actual child service.
# The subprocess observer records its pid without exposing any key or session token.
_RUNNING_EVALUATOR = """
import json
import sys
import time
from pathlib import Path
from scripts.agent_eval import __main__ as cli, host

root = Path(sys.argv[1])
start = host.subprocess.Popen
child = None
def observe(command, *args, **kwargs):
    global child
    proc = start(command, *args, **kwargs)
    if len(command) > 1 and Path(command[1]).name == '_server.py':
        child = proc.pid
    return proc
host.subprocess.Popen = observe

def pause(api, *args, **kwargs):
    key_file = api.data_root / '.config' / 'keys.json'
    assert json.loads(key_file.read_text(encoding='utf-8'))['keys']
    ready = root / 'ready.tmp'
    ready.write_text(json.dumps([child, str(api.data_root.parent), api.base_url]), encoding='utf-8')
    ready.replace(root / 'ready')
    time.sleep(60)

cli.run_case = pause
sys.exit(cli.main(['run', '--out', str(root / 'out')]))
"""


def _has_exited(pid):
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return ctypes.get_last_error() == 87  # ERROR_INVALID_PARAMETER (pid no longer exists)
        try:
            return kernel.WaitForSingleObject(wintypes.HANDLE(handle), 0) == 0
        finally:
            kernel.CloseHandle(wintypes.HANDLE(handle))
    # An orphan may already have exited while still awaiting reaping by the CI container's PID 1.
    status = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
    return not status.stdout.strip() or status.stdout.strip().startswith("Z")


@pytest.mark.parametrize(
    "end", [*(["SIGTERM", "SIGHUP", "SIGINT"] if os.name == "posix" else []), "parent-died"]
)
def test_termination_cleans_up_service_and_temporary_keys(tmp_path, end):
    import socket
    from urllib.parse import urlsplit

    home = tmp_path / "home"
    home.mkdir()
    env = os.environ | {
        "HOME": str(home),
        "USERPROFILE": str(home),
        "TMPDIR": str(tmp_path),
        "TEMP": str(tmp_path),
        "TMP": str(tmp_path),
    }
    proc = subprocess.Popen(
        [sys.executable, "-c", _RUNNING_EVALUATOR, str(tmp_path)],
        env=env,
        cwd=Path(__file__).resolve().parents[1],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ready = tmp_path / "ready"
        end_time = time.monotonic() + 30
        while not ready.exists() and time.monotonic() < end_time:
            assert proc.poll() is None, "evaluator exited before the isolated service was ready"
            time.sleep(0.05)
        child, work, base_url = json.loads(ready.read_text(encoding="utf-8"))
        assert (Path(work) / "data" / ".config" / "keys.json").is_file()
        if end == "parent-died":
            proc.kill()  # No Python cleanup; the service must observe EOF on its own.
        else:
            proc.send_signal(getattr(signal, end))
        proc.wait(timeout=15)
        end_time = time.monotonic() + 8
        keys = Path(work) / "data" / ".config" / "keys.json"
        gone = (lambda: not keys.exists()) if os.name == "nt" else (lambda: not Path(work).exists())
        while (not gone() or not _has_exited(child)) and time.monotonic() < end_time:
            time.sleep(0.05)
        # Windows 上进程删不掉自己仍打开的文件，工作目录会残留在系统临时目录；
        # 必须保证的是密钥已删除、服务已退出。其他平台要求整个目录被清掉。
        assert gone()
        assert _has_exited(child)
        with socket.socket() as listener_probe:
            assert listener_probe.connect_ex(("127.0.0.1", urlsplit(base_url).port)) != 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
