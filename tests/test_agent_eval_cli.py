import json
from pathlib import Path

import pytest

from scripts.agent_eval import cli


def test_real_requires_budget_before_accessing_source(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "serve", lambda *a, **kw: pytest.fail("启动了服务"))
    with pytest.raises(SystemExit) as stopped:
        cli.main(["run", "--keys-from", str(tmp_path / "missing"), "--providers", "demo"])
    assert stopped.value.code == 2
    assert "--budget-cny" in capsys.readouterr().err


def test_matrix_stops_at_exact_threshold_and_on_unobservable_spend(tmp_path, monkeypatch):
    from contextlib import nullcontext
    from types import SimpleNamespace

    monkeypatch.setattr(
        cli, "serve", lambda *a, **kw: nullcontext(SimpleNamespace(scrub=lambda r: r))
    )
    monkeypatch.setattr(cli, "FakeProvider", lambda _: nullcontext(SimpleNamespace(keys={})))
    monkeypatch.setattr(cli, "write_report", lambda *args: None)
    for i, (cost, complete, status) in enumerate(
        [(0.9, True, "completed"), (1.1, True, "stopped"), (0.01, False, "not_applicable")]
    ):
        calls = []

        def run_case(*args):
            calls.append(args)
            return {"usage": {"total_cost_cny": cost, "cost_complete": complete}, "status": status}

        monkeypatch.setattr(cli, "run_case", run_case)
        assert cli.main(["run", "--budget-cny", "1", "--out", str(tmp_path / str(i))]) == 0
        assert len(calls) == 1


def test_sample_cases_have_valid_attachments_and_distinct_ids():
    cases = cli.load_cases(cli.HERE / "examples.yaml", None, cli.HERE / "fixtures")
    assert len(cases) == len({c["id"] for c in cases}) == 3
    assert [c["id"][:2] for c in cases] == ["01", "04", "11"]
    assert Path(cli.HERE / "fixtures" / "hero-a.png").is_file()


def test_installer_payload_excludes_eval_but_keeps_runtime_scripts(tmp_path, monkeypatch):
    import os

    from scripts import build_release

    # Exercise the real bundle copy and archive with a miniature checkout and interpreter.
    repo = tmp_path / "checkout"
    for directory in [
        "src",
        "web/dist",
        "skills",
        ".claude-plugin",
        "plugins",
        "scripts/agent_eval",
    ]:
        (repo / directory).mkdir(parents=True)
    (repo / ".claude-plugin/plugin.json").write_text('{"version":"1.0.0"}')
    (repo / "scripts/bootstrap.py").write_text("# runtime")
    (repo / "scripts/agent_eval/__main__.py").write_text("# offline harness")
    for filename in ("pyproject.toml", "uv.lock", ".python-version"):
        (repo / filename).touch()
    interpreter = tmp_path / "runtime" / ("python.exe" if os.name == "nt" else "bin/python3")
    interpreter.parent.mkdir(parents=True)
    interpreter.touch()
    monkeypatch.setattr(build_release, "REPO", repo)

    def fake_uv(args, **kwargs):
        if "--output-file" in args:
            Path(args[args.index("--output-file") + 1]).touch()

    monkeypatch.setattr(build_release.subprocess, "run", fake_uv)
    monkeypatch.setattr(
        build_release.subprocess, "check_output", lambda *args, **kwargs: str(interpreter)
    )
    out = tmp_path / "out"
    build_release.build(out, "fixture")
    scripts = out / "GameAtelier/versions/1.0.0/app/scripts"
    assert (scripts / "bootstrap.py").is_file()
    assert not (scripts / "agent_eval").exists()


@pytest.mark.parametrize(
    ("section", "field"),
    [
        ("top", "surfaec"),
        ("limits", "max_generations"),
        ("turn", "speek"),
        ("turn_expect", "oritentation"),
        ("node", "filename"),
    ],
)
def test_unknown_field_names_the_case_and_nested_location(tmp_path, section, field):
    case = {
        "id": "field-diagnostic",
        "surface": "canvas",
        "title": "检查字段",
        "turns": [{"say": "作画", "expect": {}}],
        "canvas": {
            "nodes": [{"id": "hero", "title": "角色", "file": "hero-a.png", "type": "image"}],
            "selected": ["hero"],
        },
        "limits": {"max_results": 2},
    }
    target, parent = {
        "top": (case, ""),
        "limits": (case["limits"], "limits."),
        "turn": (case["turns"][0], "turns.0."),
        "turn_expect": (case["turns"][0]["expect"], "turns.0.expect."),
        "node": (case["canvas"]["nodes"][0], "canvas.nodes.0."),
    }[section]
    target[field] = True
    file = tmp_path / "input.yaml"
    file.write_text(json.dumps(case))
    with pytest.raises(ValueError) as blocked:
        cli.load_cases(file, None, cli.HERE / "fixtures")
    assert "field-diagnostic" in str(blocked.value) and parent + field in str(blocked.value)
