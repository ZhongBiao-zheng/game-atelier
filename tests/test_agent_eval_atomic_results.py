import json

import pytest

from scripts.agent_eval import report
from tests.test_agent_eval_report import _row


def test_interrupted_write_preserves_previous_results_for_compare(tmp_path, monkeypatch):
    target = tmp_path / "run"
    prior = _row() | {"generations": []}
    report.write_report(target, [prior])
    results = target / "results.jsonl"
    original = results.read_bytes()
    first = prior | {"case_id": "first"}
    second = prior | {"case_id": "second"}
    serialize = json.dumps

    def interrupt(value, **kwargs):
        if value is second:
            assert results.read_bytes() == original
            raise KeyboardInterrupt
        return serialize(value, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(report.json, "dumps", interrupt)
        with pytest.raises(KeyboardInterrupt):
            report.write_report(target, [first, second])
    assert results.read_bytes() == original
    assert not list(target.glob(".results-*"))
    assert "共同运行 1 组" in report.compare(target, target, tmp_path / "compare.html")
    report.write_report(target, [first, second])
    assert [json.loads(line)["case_id"] for line in results.read_text().splitlines()] == [
        "first",
        "second",
    ]
