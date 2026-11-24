"""Process-lifecycle checks on platforms supporting the isolated service."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="隔离服务的进程与信号测试需要 POSIX"
)


# Pause a real evaluator only after it has authenticated to its actual child service.
# The subprocess observer records its pid without exposing any key or session token.
_RUNNING_EVALUATOR = """
import json
import os
import signal
import sys
import time
from pathlib import Path
from scripts.agent_eval import cli, host

root = Path(sys.argv[1])
background = sys.argv[2] == 'background'
if background:
    for sig in (signal.SIGHUP, signal.SIGINT):
        assert signal.getsignal(sig) == signal.SIG_IGN
else:
    # CI shells may themselves ignore SIGINT or SIGHUP.
    signal.signal(signal.SIGHUP, signal.SIG_DFL)
    signal.signal(signal.SIGINT, signal.default_int_handler)
def original_term(signum, frame):
    raise AssertionError("SIGTERM reached the original handler before cleanup")
signal.signal(signal.SIGTERM, original_term)
previous = {sig: signal.getsignal(sig) for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM)}

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
    if background:
        for sig in (signal.SIGHUP, signal.SIGINT):
            assert signal.getsignal(sig) == signal.SIG_IGN
            signal.raise_signal(sig)
    ready = root / 'ready.tmp'
    details = [os.getpid(), child, str(api.data_root.parent), api.base_url]
    ready.write_text(json.dumps(details), encoding='utf-8')
    ready.replace(root / 'ready')
    time.sleep(60)

cli.run_case = pause
result = cli.main(['run', '--out', str(root / 'out')])
assert all(signal.getsignal(sig) == handler for sig, handler in previous.items())
sys.exit(result)
"""


def _has_exited(pid):
    # An orphan may already have exited while still awaiting reaping by the CI container's PID 1.
    status = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
    return not status.stdout.strip() or status.stdout.strip().startswith("Z")


@pytest.mark.parametrize("end", ["SIGTERM", "SIGHUP", "SIGINT", "parent-died", "background"])
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
    command = [sys.executable, "-c", _RUNNING_EVALUATOR, str(tmp_path), end]
    if end == "background":
        # nohup sets SIGHUP to SIG_IGN; the non-interactive shell's '&' ignores SIGINT.
        command = ["/bin/sh", "-c", 'nohup "$@" & wait "$!"', "eval-shell", *command]
    proc = subprocess.Popen(
        command,
        env=env,
        cwd=Path(__file__).resolve().parents[1],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        ready = tmp_path / "ready"
        end_time = time.monotonic() + 30
        while not ready.exists() and time.monotonic() < end_time:
            assert proc.poll() is None, "evaluator exited before the isolated service was ready"
            time.sleep(0.05)
        evaluator, child, work, base_url = json.loads(ready.read_text(encoding="utf-8"))
        assert (Path(work) / "data" / ".config" / "keys.json").is_file()
        if end == "parent-died":
            proc.kill()  # No Python cleanup; the service must observe EOF on its own.
        elif end == "background":
            os.kill(evaluator, signal.SIGTERM)
        else:
            proc.send_signal(getattr(signal, end))
        proc.wait(timeout=15)
        if end != "parent-died":
            assert proc.returncode == 130
        end_time = time.monotonic() + 8
        while (Path(work).exists() or not _has_exited(child)) and time.monotonic() < end_time:
            time.sleep(0.05)
        assert not Path(work).exists()
        assert _has_exited(child)
        with socket.socket() as listener_probe:
            assert listener_probe.connect_ex(("127.0.0.1", urlsplit(base_url).port)) != 0
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
