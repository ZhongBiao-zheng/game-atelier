import threading
import time

import pytest

from character_workflow.lib.draft_processor import process_drafts


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(tmp_path))
    runtime = tmp_path / ".runtime"
    (runtime / "draft").mkdir(parents=True)
    (runtime / "processing").mkdir()
    (runtime / "draft-processed").mkdir()
    return runtime


def test_empty_draft_returns_empty_list(runtime):
    assert process_drafts("hero") == []


def test_drafts_processed_in_filename_order(runtime):
    (runtime / "draft" / "20260518-100000.md").write_text(
        "<!-- character: hero -->\nfirst"
    )
    (runtime / "draft" / "20260518-100001.md").write_text(
        "<!-- character: hero -->\nsecond"
    )
    results = process_drafts("hero")
    assert [r["content"] for r in results] == [
        "<!-- character: hero -->\nfirst",
        "<!-- character: hero -->\nsecond",
    ]
    assert not list((runtime / "draft").glob("*.md"))
    assert len(list((runtime / "draft-processed").glob("*.md"))) == 2


def test_no_draft_lost_under_concurrent_write(runtime):
    """While process_drafts runs, simulate Web writing a new draft.
    The new draft must NOT be silently moved—it should remain in draft/ for next turn.
    """
    (runtime / "draft" / "20260518-100000.md").write_text(
        "<!-- character: hero -->\nexisting"
    )

    def web_writer():
        time.sleep(0.05)
        (runtime / "draft" / "20260518-100100.md").write_text(
            "<!-- character: hero -->\nlate"
        )

    t = threading.Thread(target=web_writer)
    t.start()
    results = process_drafts("hero")
    t.join()

    assert [r["content"] for r in results] == ["<!-- character: hero -->\nexisting"]
    remaining = list((runtime / "draft").glob("*.md"))
    assert len(remaining) == 1
    assert remaining[0].read_text() == "<!-- character: hero -->\nlate"


def test_only_matching_character_drafts_are_consumed(runtime):
    (runtime / "draft" / "parent.md").write_text(
        "<!-- character: parent -->\n母角色反馈"
    )
    (runtime / "draft" / "variant.md").write_text(
        "<!-- character: variant -->\n皮肤反馈"
    )

    results = process_drafts("parent")

    assert [item["content"] for item in results] == [
        "<!-- character: parent -->\n母角色反馈"
    ]
    remaining = list((runtime / "draft").glob("*.md"))
    assert [path.name for path in remaining] == ["variant.md"]
