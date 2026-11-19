"""The desktop smoke's verdict on one launch's shell log (scripts/smoke_desktop.py)."""
import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("_smoke_desktop", REPO_ROOT / "scripts/smoke_desktop.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

PRINT = '1795017588 launcher ["--print-data-root"] -> 0\n'
STARTED = "1795017605 started { port: 5174, instance: a30f2f3d332546cd9312b8bf115b3060 }\n"
PROBE = "1795017614 security probe: ok\n"


def test_launcher_verified_the_server():
    log = PRINT + '1795017639 launcher ["--desktop-start"] -> 0\n' + STARTED + PROBE
    assert smoke._start_problems(log) == []


def test_slow_start_the_shell_verified_after_the_launcher_gave_up():
    # Desktop run 44340667247 (windows-latest): the first start after a runtime replacement.
    log = (PRINT + '1795017604 launcher ["--desktop-start"] -> 1\n'
           "1795017604 launcher stderr: 工坊启动后尚未通过实例验证，未打开浏览器。"
           "请检查服务启动情况；再次启动不会另开第二个服务。\n" + STARTED + PROBE)
    assert smoke._start_problems(log) == []


def test_the_shell_never_verified_a_server():
    log = (PRINT + '1795017604 launcher ["--desktop-start"] -> 1\n'
           "1795017634 no verified server after the grace period\n")
    assert smoke._start_problems(log) == ["--desktop-start exited 1 and the shell never verified a server"]


def test_the_shell_did_not_use_desktop_start():
    log = PRINT + '1795017600 launcher ["--select-version","--no-browser"] -> 0\n' + STARTED
    assert smoke._start_problems(log) == ["the shell did not start the server through --desktop-start"]


def test_only_a_started_line_after_the_last_call_counts():
    log = (PRINT + '1795017600 launcher ["--desktop-start"] -> 0\n' + STARTED
           + '1795017700 launcher ["--desktop-start"] -> 1\n')
    assert smoke._start_problems(log) == ["--desktop-start exited 1 and the shell never verified a server"]
