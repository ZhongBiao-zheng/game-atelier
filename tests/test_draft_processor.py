import threading
import time

import pytest

from skill.character_workflow.lib.draft_processor import process_drafts


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    runtime = tmp_path / ".runtime"
    (runtime / "draft").mkdir(parents=True)
    (runtime / "processing").mkdir()
    (runtime / "draft-processed").mkdir()
    monkeypatch.setenv("RUNTIME_DIR", str(runtime))
    return runtime


def test_empty_draft_returns_empty_list(runtime):
    assert process_drafts() == []


def test_drafts_processed_in_filename_order(runtime):
    (runtime / "draft" / "20260518-100000.md").write_text("first")
    (runtime / "draft" / "20260518-100001.md").write_text("second")
    results = process_drafts()
    assert [r["content"] for r in results] == ["first", "second"]
    assert not list((runtime / "draft").glob("*.md"))
    assert len(list((runtime / "draft-processed").glob("*.md"))) == 2


def test_no_draft_lost_under_concurrent_write(runtime):
    """While process_drafts runs, simulate Web writing a new draft.
    The new draft must NOT be silently moved—it should remain in draft/ for next turn.
    """
    (runtime / "draft" / "20260518-100000.md").write_text("existing")

    def web_writer():
        time.sleep(0.05)
        (runtime / "draft" / "20260518-100100.md").write_text("late")

    t = threading.Thread(target=web_writer)
    t.start()
    results = process_drafts()
    t.join()

    assert [r["content"] for r in results] == ["existing"]
    remaining = list((runtime / "draft").glob("*.md"))
    assert len(remaining) == 1
    assert remaining[0].read_text() == "late"
