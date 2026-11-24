"""Exercise failed startup using a real child and an isolated synthetic key."""

import sys
from textwrap import dedent
from urllib.parse import quote

import pytest

from scripts.agent_eval import host

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="评测隔离服务的启动测试只支持 macOS 与 Linux"
)

TOKEN = "synthetic / startup+credential"


def _failed_start(tmp_path, monkeypatch, child):
    module = tmp_path / "src" / "viewer_server" / "server_app.py"
    module.parent.mkdir(parents=True)
    module.touch()
    popen = host.subprocess.Popen

    def run_child(command, **kwargs):
        return popen([sys.executable, "-c", dedent(child)], **kwargs)

    monkeypatch.setattr(host.subprocess, "Popen", run_child)
    keys = {"keys": [{"base_url": "http://127.0.0.1:1", "access_key": TOKEN}]}
    with pytest.raises(host.StartupError) as exc:
        with host.serve(tmp_path, keys_from=None, providers=[], fake_keys=keys):
            pytest.fail("child should not become ready")
    return str(exc.value)


def test_early_exit_captures_only_a_bounded_redacted_stderr_tail(tmp_path, monkeypatch):
    message = _failed_start(
        tmp_path,
        monkeypatch,
        """
        import json, os, sys
        from pathlib import Path
        from urllib.parse import quote
        data = Path(os.environ["GAME_ATELIER_DATA_ROOT"])
        token = json.loads((data / ".config/keys.json").read_text())["keys"][0]["access_key"]
        print("stdout-private", flush=True)
        print("start-private", file=sys.stderr)
        # This URL line spans a pipe buffer and the entire retained tail. Its final
        # fragment must not escape just because the URL scheme fell out of the buffer.
        print("https://unreported.invalid/" + "private-segment" * 50000, file=sys.stderr)
        print("Authorization: Bearer unknown-value", file=sys.stderr)
        print("password=unreported-value", file=sys.stderr)
        print("https://hidden.invalid/v1?access=hidden-value", file=sys.stderr)
        print("config " + str(data), file=sys.stderr)
        print("checkout " + os.getcwd(), file=sys.stderr)
        print("sample " + token + " " + quote(token, safe=""), file=sys.stderr)
        print("MissingDependencyError: offline_fixture", file=sys.stderr)
        sys.exit(37)
        """,
    )
    assert "退出码 37" in message and "前文已截断" in message
    assert message.endswith("MissingDependencyError: offline_fixture")
    assert len(message) < 3300
    for private in (
        "stdout-private",
        "start-private",
        "private-segment",
        "unknown-value",
        "unreported-value",
        "hidden.invalid",
        "hidden-value",
        "atelier-agent-eval-",
        str(tmp_path),
        TOKEN,
        quote(TOKEN, safe=""),
    ):
        assert private not in message


def test_timeout_before_port_shows_final_stderr(tmp_path, monkeypatch):
    monkeypatch.setattr(host, "_STARTUP_TIMEOUT", 1)
    message = _failed_start(
        tmp_path,
        monkeypatch,
        """
        import sys, time
        print("Startup stalled while loading fixture", file=sys.stderr, flush=True)
        print("X-Api-Key: transient-secret", file=sys.stderr, flush=True)
        time.sleep(60)
        """,
    )
    assert "1 秒内启动" in message
    assert "Startup stalled while loading fixture" in message
    assert "transient-secret" not in message


def test_short_log_shows_only_last_twelve_lines(tmp_path, monkeypatch):
    message = _failed_start(
        tmp_path,
        monkeypatch,
        """
        import sys
        for index in range(20):
            print(f"startup-step-{index:02}", file=sys.stderr)
        """,
    )
    assert "前文已截断" in message
    assert "startup-step-07" not in message
    assert "startup-step-08" in message and message.endswith("startup-step-19")
