"""Deterministic interleavings for all writers of the project assignment registry."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event, current_thread

import pytest

from character_workflow.lib import projects


@pytest.mark.parametrize("operation", ["create", "rename", "delete", "reorder", "assign", "identity"])
def test_project_mutations_share_one_read_modify_write_lock(isolated_data_root, monkeypatch, operation):
    first = projects.create_project("First", "first")
    second = projects.create_project("Second", "second")
    projects.assign_character("old-bird", first.id)
    original_read = projects.read_projects
    original_lock = projects.file_lock
    first_snapshot = Event()
    release_first = Event()
    second_lock_attempt = Event()
    second_read = Event()

    def controlled_read():
        result = original_read()
        if current_thread().name == "registry-first" and not first_snapshot.is_set():
            first_snapshot.set()
            assert release_first.wait(5), "test did not release the first registry transaction"
        elif current_thread().name == "registry-second":
            second_read.set()
        return result

    @contextmanager
    def observed_lock(path):
        if current_thread().name == "registry-second":
            second_lock_attempt.set()
        with original_lock(path):
            yield

    def invoke(name, callback):
        current_thread().name = name
        return callback()

    actions = {
        "create": lambda: projects.create_project("Third", "third"),
        "rename": lambda: projects.rename_project(first.id, "Renamed"),
        "delete": lambda: projects.delete_project(second.id),
        "reorder": lambda: projects.reorder_projects([first.id, second.id]),
        "assign": lambda: projects.assign_characters(["second-bird"], second.id),
        "identity": lambda: projects.rename_character_assignment("old-bird", "renamed-bird"),
    }
    monkeypatch.setattr(projects, "read_projects", controlled_read)
    monkeypatch.setattr(projects, "file_lock", observed_lock)
    with ThreadPoolExecutor(max_workers=2) as pool:
        writer = pool.submit(invoke, "registry-first", lambda: projects.assign_character("new-bird", first.id))
        try:
            assert first_snapshot.wait(5)
            follower = pool.submit(invoke, "registry-second", actions[operation])
            assert second_lock_attempt.wait(5), "writer did not enter the common registry lock"
            assert not second_read.is_set(), "second writer read a stale snapshot before the first commit"
        finally:
            release_first.set()
        writer.result(timeout=5)
        follower.result(timeout=5)

    result = original_read()
    assert result.assignments["new-bird"] == first.id
    if operation == "create":
        assert {item.slug for item in result.projects} == {"first", "second", "third"}
    elif operation == "rename":
        assert next(item for item in result.projects if item.id == first.id).name == "Renamed"
    elif operation == "delete":
        assert [item.id for item in result.projects] == [first.id]
    elif operation == "reorder":
        assert [item.id for item in result.projects] == [first.id, second.id]
    elif operation == "assign":
        assert result.assignments["second-bird"] == second.id
    else:
        assert "old-bird" not in result.assignments
        assert result.assignments["renamed-bird"] == first.id
