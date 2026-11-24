import os
from pathlib import Path
import subprocess
import sys


def test_windows_module_entry_rejects_before_loading_dependencies():
    # -S simulates calling the development tool without any project packages installed.
    result = subprocess.run(
        [
            sys.executable,
            "-S",
            "-c",
            "import runpy, sys; sys.platform = 'win32'; "
            "runpy.run_module('scripts.agent_eval', run_name='__main__')",
            "--help",
        ],
        cwd=Path(__file__).resolve().parents[1],
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        encoding="utf-8",
    )
    assert result.returncode == 2
    assert result.stderr.strip() == "评测脚本只支持 macOS 与 Linux"
    assert result.stdout == ""


def test_cli_preserves_the_scrubbed_startup_diagnostic(monkeypatch, capsys):
    import pytest

    from scripts.agent_eval import cli

    def fail_startup(args):
        raise cli.StartupError("隔离服务启动失败（退出码 1）\nModuleNotFoundError: sample")

    monkeypatch.setattr(cli, "run", fail_startup)
    with pytest.raises(SystemExit) as stopped:
        cli.main(["preflight"])
    assert stopped.value.code == 2
    assert capsys.readouterr().err.endswith("ModuleNotFoundError: sample\n")
