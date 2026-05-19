"""Tests for skill.character_workflow.lib.lovart_caller.

monkeypatch subprocess.run，覆盖 plan §11.4 列的三路径：正常 / 超时 / 错误。
不实际起 lovart-api 进程。
"""
import json
import subprocess
from types import SimpleNamespace

import pytest

from skill.character_workflow.lib import lovart_caller as lc


@pytest.fixture
def out_dir(tmp_path):
    return tmp_path / "portrait"


def _fake_run_factory(stdout: str = "", stderr: str = "", returncode: int = 0):
    def fake_run(cmd, capture_output, text, timeout):
        return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)
    return fake_run


def test_submit_success_returns_paths(monkeypatch, out_dir):
    payload = {"output_paths": ["/abs/v1.png", "/abs/v2.png"], "model": "gpt"}
    monkeypatch.setattr(
        subprocess, "run",
        _fake_run_factory(stdout=json.dumps(payload), returncode=0),
    )
    result = lc.submit_and_wait(prompt="圣灵祭祀", output_dir=out_dir)
    assert result.output_paths == ["/abs/v1.png", "/abs/v2.png"]
    assert result.raw_json["model"] == "gpt"
    assert out_dir.exists(), "submit_and_wait should mkdir output_dir"


def test_submit_falls_back_to_downloaded_paths(monkeypatch, out_dir):
    """部分 lovart 输出用 downloaded_paths 字段，应一并接受。"""
    payload = {"downloaded_paths": ["/abs/v1.png"]}
    monkeypatch.setattr(
        subprocess, "run",
        _fake_run_factory(stdout=json.dumps(payload), returncode=0),
    )
    result = lc.submit_and_wait(prompt="x", output_dir=out_dir)
    assert result.output_paths == ["/abs/v1.png"]


def test_submit_nonzero_exit_raises_lovart_error(monkeypatch, out_dir):
    monkeypatch.setattr(
        subprocess, "run",
        _fake_run_factory(stderr="auth failed", returncode=2),
    )
    with pytest.raises(lc.LovartError, match="exit 2"):
        lc.submit_and_wait(prompt="x", output_dir=out_dir)


def test_submit_timeout_raises_lovart_timeout(monkeypatch, out_dir):
    def raise_timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="lovart", timeout=1.0)
    monkeypatch.setattr(subprocess, "run", raise_timeout)
    with pytest.raises(lc.LovartTimeout, match="timed out"):
        lc.submit_and_wait(prompt="x", output_dir=out_dir, timeout=1.0)


def test_submit_unparseable_output_raises(monkeypatch, out_dir):
    monkeypatch.setattr(
        subprocess, "run",
        _fake_run_factory(stdout="not json output", returncode=0),
    )
    with pytest.raises(lc.LovartError, match="unparseable output"):
        lc.submit_and_wait(prompt="x", output_dir=out_dir)


def test_submit_missing_output_paths_raises(monkeypatch, out_dir):
    monkeypatch.setattr(
        subprocess, "run",
        _fake_run_factory(stdout=json.dumps({"foo": "bar"}), returncode=0),
    )
    with pytest.raises(lc.LovartError, match="missing or malformed"):
        lc.submit_and_wait(prompt="x", output_dir=out_dir)


def test_build_cmd_includes_n_and_refs(out_dir):
    cmd = lc._build_cmd(
        prompt="圣灵", model="generate_image_gpt_image_2",
        output_dir=out_dir, n=2, reference_images=["/refs/a.png", "/refs/b.png"],
    )
    assert "--include-tools" in cmd
    assert "generate_image_gpt_image_2" in cmd
    assert "--n" in cmd and "2" in cmd
    assert cmd.count("--reference-image") == 2
    assert "/refs/a.png" in cmd
    assert "/refs/b.png" in cmd
    assert "--json" in cmd and "--download" in cmd
