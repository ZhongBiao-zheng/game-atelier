# tests/test_distill_cli.py
"""CLI: mark-distilled 写 sidecar；pending-distill 解析活跃角色输出 JSON。"""
from __future__ import annotations

import json

from character_workflow import __main__ as cli
from character_workflow.lib import distill


def test_mark_distilled_cli_writes_sidecar(capsys):
    rc = cli.main(["mark-distilled", "characters/c1/portrait/v2.png"])
    assert rc == 0
    assert distill.read_distilled() == ["characters/c1/portrait/v2.png"]
    out = json.loads(capsys.readouterr().out)
    assert out == {"ok": True, "path": "characters/c1/portrait/v2.png"}


def test_pending_distill_cli_for_explicit_character(capsys, tmp_path):
    from character_workflow.lib import data_root
    rt = data_root.runtime_dir()
    rt.mkdir(parents=True, exist_ok=True)
    (rt / "gallery-ratings.json").write_text(
        json.dumps({"ratings": {"characters/c1/portrait/v2.png": 5}}), encoding="utf-8"
    )
    rc = cli.main(["pending-distill", "--character", "c1"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert [x["path"] for x in out["pending"]] == ["characters/c1/portrait/v2.png"]


def test_pending_distill_cli_no_active_returns_empty(capsys):
    rc = cli.main(["pending-distill"])
    assert rc == 0
    assert json.loads(capsys.readouterr().out) == {"pending": []}
