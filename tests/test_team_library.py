from __future__ import annotations

import json

import pytest

from character_workflow.lib import team_library as tl
from character_workflow.lib.schemas import TeamLibraryManifest


def test_profile_round_trip(isolated_data_root):
    assert tl.read_profile() is None
    assert tl.write_profile(" 老王 ").display_name == "老王"
    assert tl.read_profile().display_name == "老王"
    assert (isolated_data_root / ".config" / "profile.json").is_file()


def test_mount_creates_manifest_once_and_reuses_id(isolated_data_root, tmp_path):
    folder = tmp_path / "svn-lib"
    folder.mkdir()
    first = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="老王")
    manifest = TeamLibraryManifest.model_validate_json((folder / tl.MANIFEST_NAME).read_text("utf-8"))
    assert manifest.library_id == first.library_id and manifest.created_by == "老王"
    assert first.name == "svn-lib"
    second = tl.mount_library(project_id="p2", path=str(folder), name="改名无效", created_by="小李")
    assert second.library_id == first.library_id and second.name == "svn-lib"
    assert sorted(m.project_id for m in tl.list_mounts()) == ["p1", "p2"]
    assert [m.project_id for m in tl.list_mounts("p1")] == ["p1"]
    assert sorted(folder.iterdir()) == [folder / tl.MANIFEST_NAME]  # 目录内只多了清单


def test_mount_conflicting_local_record_follows_manifest(isolated_data_root, tmp_path):
    folder = tmp_path / "lib"
    folder.mkdir()
    mount = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="老王")
    manifest_path = folder / tl.MANIFEST_NAME
    data = json.loads(manifest_path.read_text("utf-8"))
    data["library_id"] = "lib_" + "f" * 16
    manifest_path.write_text(json.dumps(data), "utf-8")
    remounted = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="老王")
    assert remounted.library_id == "lib_" + "f" * 16
    assert [m.library_id for m in tl.list_mounts("p1")] == [remounted.library_id]
    assert mount.library_id != remounted.library_id


def test_unmount_only_removes_local_record(isolated_data_root, tmp_path):
    folder = tmp_path / "lib"
    folder.mkdir()
    mount = tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="老王")
    tl.unmount_library(mount.library_id, "p1")
    assert tl.list_mounts() == []
    assert (folder / tl.MANIFEST_NAME).is_file()
    with pytest.raises(KeyError):
        tl.unmount_library(mount.library_id, "p1")


def test_mount_rejects_missing_dir(isolated_data_root, tmp_path):
    with pytest.raises(FileNotFoundError):
        tl.mount_library(project_id="p1", path=str(tmp_path / "nope"), name=None, created_by="老王")


def test_new_ulid_shape():
    value = tl.new_ulid()
    assert len(value) == 26 and set(value) <= set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")


def test_same_library_twice_in_one_project_keeps_latest(isolated_data_root, tmp_path):
    """同一个库 checkout 两份挂进同一项目：去重按 (project_id, library_id)，get_mount 唯一。"""
    first_dir = tmp_path / "co-a"
    first_dir.mkdir()
    first = tl.mount_library(project_id="p1", path=str(first_dir), name=None, created_by="老王")
    second_dir = tmp_path / "co-b"
    second_dir.mkdir()
    (second_dir / tl.MANIFEST_NAME).write_text(
        (first_dir / tl.MANIFEST_NAME).read_text("utf-8"), "utf-8"
    )
    second = tl.mount_library(project_id="p1", path=str(second_dir), name=None, created_by="老王")
    assert second.library_id == first.library_id
    rows = tl.list_mounts("p1")
    assert len(rows) == 1 and rows[0].mount_path == str(second_dir.resolve())
    assert tl.get_mount(first.library_id).mount_path == str(second_dir.resolve())


def test_broken_mount_file_fails_loud(isolated_data_root):
    path = isolated_data_root / ".config" / "team-libraries.json"
    path.write_text(json.dumps({"mounts": [{"library_id": "nope"}]}), "utf-8")
    with pytest.raises(ValueError, match="team-libraries.json"):
        tl.list_mounts()


def _write_mounts(isolated_data_root, rows):
    path = isolated_data_root / ".config" / "team-libraries.json"
    path.write_text(json.dumps({"schema_version": 1, "mounts": rows}), "utf-8")


def _library_dir(tmp_path, name, library_id):
    folder = tmp_path / name
    folder.mkdir()
    manifest = TeamLibraryManifest(
        library_id=library_id, name="lib", created_at="2026-09-20T00:00:00Z", created_by="老王"
    )
    (folder / tl.MANIFEST_NAME).write_text(manifest.model_dump_json(), "utf-8")
    return folder


def _row(library_id, project_id, folder, mounted_at):
    return {
        "library_id": library_id,
        "project_id": project_id,
        "mount_path": str(folder),
        "name": "lib",
        "mounted_at": mounted_at,
    }


def test_get_mount_prefers_reachable_then_latest(isolated_data_root, tmp_path):
    """同一个库挂在多个画布上：不可达的记录不能挡住可达的，可达里取最近挂载的。"""
    lib = "lib_" + "a" * 16
    old = _library_dir(tmp_path, "old", lib)
    new = _library_dir(tmp_path, "new", lib)
    gone = tmp_path / "gone"
    _write_mounts(isolated_data_root, [
        _row(lib, "canvas-1", gone, "2026-09-22T00:00:00+00:00"),
        _row(lib, "canvas-2", new, "2026-09-21T00:00:00+00:00"),
        _row(lib, "canvas-3", old, "2026-09-20T00:00:00+00:00"),
    ])
    assert tl.get_mount(lib).mount_path == str(new)
    _write_mounts(isolated_data_root, [
        _row(lib, "canvas-1", tmp_path / "gone-a", "2026-09-20T00:00:00+00:00"),
        _row(lib, "canvas-2", tmp_path / "gone-b", "2026-09-21T00:00:00+00:00"),
    ])
    assert tl.get_mount(lib).project_id == "canvas-2"
    with pytest.raises(KeyError):
        tl.get_mount("lib_" + "b" * 16)


def test_remove_project_mounts_returns_orphaned_libraries(isolated_data_root, tmp_path):
    shared = "lib_" + "a" * 16
    only = "lib_" + "b" * 16
    folder = tmp_path / "x"
    _write_mounts(isolated_data_root, [
        _row(shared, "canvas-1", folder, "2026-09-20T00:00:00+00:00"),
        _row(shared, "canvas-2", folder, "2026-09-20T00:00:00+00:00"),
        _row(only, "canvas-1", folder, "2026-09-20T00:00:00+00:00"),
    ])
    assert tl.remove_project_mounts("canvas-1") == [only]
    assert [(m.library_id, m.project_id) for m in tl.list_mounts()] == [(shared, "canvas-2")]
    assert tl.remove_project_mounts("canvas-9") == []


def test_write_profile_rejects_blank_name(isolated_data_root):
    with pytest.raises(ValueError):
        tl.write_profile("   ")
    assert tl.read_profile() is None
