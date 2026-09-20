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
