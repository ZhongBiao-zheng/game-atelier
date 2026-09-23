from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from character_workflow.lib import team_library as tl
from character_workflow.lib import team_library_index as idx
from character_workflow.lib.schemas import TeamLibraryIndexEntry

_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
_ASSET_ID = "ta_01ARZ3NDEKTSV4RRFFQ69G5FAV"


def _shared_asset(folder, author="老王", title="董卓 待机", kind="media"):
    asset_dir = folder / "shared" / author / _ASSET_ID
    asset_dir.mkdir(parents=True)
    (asset_dir / "dz.png").write_bytes(_PNG)
    body = {
        "team_asset_version": 1, "asset_id": _ASSET_ID, "kind": kind, "title": title, "tags": ["皮肤"],
        "author": {"display_name": author}, "shared_at": "2026-09-20T00:00:00Z",
        "updated_at": "2026-09-20T00:00:00Z",
        "media": {"filename": "dz.png", "mime_type": "image/png", "bytes": len(_PNG),
                  "sha256": __import__("hashlib").sha256(_PNG).hexdigest()},
    }
    (asset_dir / "asset.json").write_text(json.dumps(body, ensure_ascii=False), "utf-8")
    return asset_dir


def _version(entry) -> str:
    return __import__("hashlib").sha1(entry.updated_at.encode("utf-8")).hexdigest()[:10]


def _mount(tmp_path):
    folder = tmp_path / "lib"
    folder.mkdir()
    return folder, tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我")


def test_scan_finds_shared_and_raw_and_skips_hidden(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _shared_asset(folder)
    (folder / "concept").mkdir()
    (folder / "concept" / "castle.png").write_bytes(_PNG)
    (folder / "concept" / "notes.txt").write_text("x")
    (folder / "concept" / "castle.png.mine").write_bytes(_PNG)
    (folder / ".svn").mkdir()
    (folder / ".svn" / "x.png").write_bytes(_PNG)
    index = idx.scan_library(mount)
    kinds = sorted((e.kind, e.relative_path) for e in index.entries)
    assert kinds == [("media", f"shared/老王/{_ASSET_ID}"), ("raw", "concept/castle.png")]
    raw = next(e for e in index.entries if e.kind == "raw")
    assert raw.title == "castle.png" and raw.mime_type == "image/png" and raw.sha256 is None
    assert raw.id.startswith("raw_") and not raw.reproducible
    assert idx.read_index(mount.library_id).entries == index.entries
    assert not any(p.name.startswith("index") for p in folder.rglob("*"))  # 库内零写入


def test_incomplete_asset_is_flagged(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = _shared_asset(folder)
    (asset_dir / "dz.png").unlink()
    entry = idx.scan_library(mount).entries[0]
    assert entry.status == "incomplete"


def test_diff_reports_added_updated_removed(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    before = idx.scan_library(mount)
    asset_dir = _shared_asset(folder)
    after = idx.scan_library(mount)
    assert idx.diff_index(before, after) == [
        {"asset_id": _ASSET_ID, "kind": "media", "author": "老王", "change": "added"}]
    data = json.loads((asset_dir / "asset.json").read_text("utf-8"))
    data["updated_at"] = "2026-09-21T00:00:00Z"
    (asset_dir / "asset.json").write_text(json.dumps(data), "utf-8")
    updated = idx.scan_library(mount)
    assert idx.diff_index(after, updated)[0]["change"] == "updated"
    import shutil
    shutil.rmtree(asset_dir)
    assert idx.diff_index(updated, idx.scan_library(mount))[0]["change"] == "removed"


def test_query_filters_and_pages(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _shared_asset(folder)
    for i in range(3):
        (folder / f"r{i}.png").write_bytes(_PNG)
    index = idx.scan_library(mount)
    assert len(idx.query_index(index, kind="raw").entries) == 3
    assert [e.title for e in idx.query_index(index, author="老王").entries] == ["董卓 待机"]
    assert [e.title for e in idx.query_index(index, q="董").entries] == ["董卓 待机"]
    assert [e.title for e in idx.query_index(index, tag="皮肤").entries] == ["董卓 待机"]
    page = idx.query_index(index, limit=2)
    assert len(page.entries) == 2 and page.next_cursor
    rest = idx.query_index(index, cursor=page.next_cursor, limit=2)
    assert len(rest.entries) == 2 and rest.next_cursor is None


def test_thumbnail_is_cached_outside_library(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    (folder / "a.png").write_bytes(_PNG)
    index = idx.scan_library(mount)
    entry = index.entries[0]
    data = idx.thumbnail_bytes(mount, entry, 256)
    assert data and data[:4] == b"RIFF"
    thumbs = list((idx.cache_dir(mount.library_id) / "thumbs").iterdir())
    assert [p.name for p in thumbs] == [f"{entry.id}-256-{_version(entry)}.webp"]
    assert sorted(p.name for p in folder.iterdir()) == [tl.MANIFEST_NAME, "a.png"]


def test_thumbnail_cache_key_versions_on_updated_at(isolated_data_root, tmp_path):
    """SVN 覆盖同名文件后 updated_at 变化 → 缓存键变化，不会永久命中旧图。"""
    folder, mount = _mount(tmp_path)
    (folder / "a.png").write_bytes(_PNG)
    entry = idx.scan_library(mount).entries[0]
    assert idx.thumbnail_bytes(mount, entry, 256)
    newer = entry.model_copy(update={"updated_at": "2030-01-01T00:00:00+00:00"})
    assert idx.thumbnail_bytes(mount, newer, 256)
    thumbs = sorted(p.name for p in (idx.cache_dir(mount.library_id) / "thumbs").iterdir())
    assert len(thumbs) == 2 and all(name.startswith(f"{entry.id}-256-") for name in thumbs)


def test_thumbnail_returns_none_on_decompression_bomb(isolated_data_root, tmp_path, monkeypatch):
    folder, mount = _mount(tmp_path)
    (folder / "a.png").write_bytes(_PNG)
    entry = idx.scan_library(mount).entries[0]

    def boom(*_args, **_kwargs):
        raise idx.Image.DecompressionBombError("too big")

    monkeypatch.setattr(idx.Image, "open", boom)
    assert idx.thumbnail_bytes(mount, entry, 256) is None


def _raw_entry(relative_path: str) -> TeamLibraryIndexEntry:
    return TeamLibraryIndexEntry(
        id="raw_x", kind="raw", title="x", author=None, tags=[], mime_type="image/png",
        bytes=1, relative_path=relative_path, sha256=None,
        updated_at="2026-09-20T00:00:00+00:00", reproducible=False, status="ready",
    )


def test_entry_content_path_rejects_escaping_relative_path(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    (tmp_path / "outside.png").write_bytes(_PNG)
    with pytest.raises(FileNotFoundError):
        idx.entry_content_path(mount, _raw_entry("../outside.png"))


def test_entry_content_path_rejects_escaping_media_filename(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = _shared_asset(folder)
    data = json.loads((asset_dir / "asset.json").read_text("utf-8"))
    data["media"]["filename"] = "../../../outside.png"
    (asset_dir / "asset.json").write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    (tmp_path.parent / "outside.png").write_bytes(_PNG)
    entry = idx.scan_library(mount).entries[0]
    with pytest.raises(FileNotFoundError):
        idx.entry_content_path(mount, entry)


def test_scan_skips_symlink_pointing_outside_library(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    (folder / "inside.png").write_bytes(_PNG)
    outside = tmp_path / "outside.png"
    outside.write_bytes(_PNG)
    (folder / "linked.png").symlink_to(outside)
    entries = idx.scan_library(mount).entries
    assert [e.relative_path for e in entries] == ["inside.png"]


def test_scan_prunes_hidden_dirs(isolated_data_root, tmp_path, monkeypatch):
    """.svn 工作副本元数据永远不被下潜（os.walk 就地剪枝）。"""
    folder, mount = _mount(tmp_path)
    (folder / "a.png").write_bytes(_PNG)
    pristine = folder / ".svn" / "pristine"
    pristine.mkdir(parents=True)
    for i in range(50):
        (pristine / f"f{i}.png").write_bytes(_PNG)
    visited: list[str] = []
    real_walk = idx.os.walk

    def spy(top, *args, **kwargs):
        for dirpath, dirnames, filenames in real_walk(top, *args, **kwargs):
            visited.append(dirpath)
            yield dirpath, dirnames, filenames

    monkeypatch.setattr(idx.os, "walk", spy)
    entries = idx.scan_library(mount).entries
    assert [e.relative_path for e in entries] == ["a.png"]
    assert visited and not any(".svn" in path for path in visited)


def test_scan_survives_file_vanishing_mid_scan(isolated_data_root, tmp_path, monkeypatch):
    folder, mount = _mount(tmp_path)
    (folder / "a.png").write_bytes(_PNG)
    (folder / "b.png").write_bytes(_PNG)
    real_stat = Path.stat

    def flaky(self, *args, **kwargs):
        if self.name == "b.png":
            raise FileNotFoundError(str(self))
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", flaky)
    entries = idx.scan_library(mount).entries
    assert [e.relative_path for e in entries] == ["a.png"]


def _generation_asset(folder, *, extra=None, ref=True):
    import hashlib

    asset_dir = folder / "shared" / "老王" / _ASSET_ID
    (asset_dir / "refs").mkdir(parents=True)
    (asset_dir / "dz.png").write_bytes(_PNG)
    sha = hashlib.sha256(_PNG).hexdigest()
    ref_path = f"refs/01-{sha[:12]}.png"
    if ref:
        (asset_dir / ref_path).write_bytes(_PNG)
    body = {
        "team_asset_version": 1, "asset_id": _ASSET_ID, "kind": "generation", "title": "董卓",
        "tags": [], "author": {"display_name": "老王"}, "shared_at": "2026-09-20T00:00:00Z",
        "updated_at": "2026-09-20T00:00:00Z",
        "media": {"filename": "dz.png", "mime_type": "image/png", "bytes": len(_PNG),
                  "sha256": sha},
        "snapshot": {
            "mode": "image", "model": "doubao-seedream-4-0", "final_prompt": "董卓",
            "inputs": [{"order": 0, "role": "reference", "kind": "image", "sha256": sha,
                        "mime_type": "image/png", "path": ref_path}],
            "cost_cny": 0.21, "cost_basis": "estimated", "submitted_at": "2026-09-19T00:00:00Z",
        },
        **(extra or {}),
    }
    (asset_dir / "asset.json").write_text(json.dumps(body, ensure_ascii=False), "utf-8")
    return asset_dir


def test_generation_entry_carries_model_and_cost(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _generation_asset(folder)
    (folder / "castle.png").write_bytes(_PNG)
    entries = {e.kind: e for e in idx.scan_library(mount).entries}
    generation = entries["generation"]
    assert generation.status == "ready" and generation.reproducible
    assert generation.model == "doubao-seedream-4-0" and generation.cost_cny == 0.21
    assert entries["raw"].model is None and entries["raw"].cost_cny is None


def test_media_entry_has_no_model(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _shared_asset(folder)
    entry = idx.scan_library(mount).entries[0]
    assert entry.model is None and entry.cost_cny is None


def test_unknown_fields_from_newer_writer_stay_ready(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = _generation_asset(folder, extra={"license": "CC0"})
    data = json.loads((asset_dir / "asset.json").read_text("utf-8"))
    data["snapshot"]["seed_policy"] = "fixed"
    data["snapshot"]["inputs"][0]["weight"] = 0.5
    data["author"]["avatar"] = "x.png"
    (asset_dir / "asset.json").write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    entry = idx.scan_library(mount).entries[0]
    assert entry.kind == "generation" and entry.status == "ready"


def test_future_asset_version_is_incomplete(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _generation_asset(folder, extra={"team_asset_version": 2})
    entry = idx.scan_library(mount).entries[0]
    assert entry.status == "incomplete" and not entry.reproducible


def test_generation_with_missing_ref_is_incomplete(isolated_data_root, tmp_path):
    """refs 还没同步到：采用必失败，索引不能标 ready。"""
    folder, mount = _mount(tmp_path)
    _generation_asset(folder, ref=False)
    entry = idx.scan_library(mount).entries[0]
    assert entry.kind == "generation" and entry.status == "incomplete"


def test_generation_with_ref_symlink_outside_is_incomplete(isolated_data_root, tmp_path):
    import hashlib

    folder, mount = _mount(tmp_path)
    asset_dir = _generation_asset(folder, ref=False)
    outside = tmp_path / "outside.png"
    outside.write_bytes(_PNG)
    sha = hashlib.sha256(_PNG).hexdigest()
    (asset_dir / f"refs/01-{sha[:12]}.png").symlink_to(outside)
    entry = idx.scan_library(mount).entries[0]
    assert entry.status == "incomplete"


def _index_entry(entry_id: str, *, kind="generation", status="ready", updated_at="2026-09-20"):
    return TeamLibraryIndexEntry(
        id=entry_id, kind=kind, title=entry_id, author="老王", tags=[], mime_type="image/png",
        bytes=1, relative_path=f"shared/老王/{entry_id}", sha256=None, updated_at=updated_at,
        reproducible=kind == "generation", status=status,
    )


def test_related_entries_only_ready_generations_newest_first():
    from character_workflow.lib.schemas import TeamLibraryIndex

    index = TeamLibraryIndex(
        library_id="lib_" + "1" * 16,
        scanned_at="2026-09-23T00:00:00Z",
        entries=[
            _index_entry("g_old", updated_at="2026-09-01T00:00:00Z"),
            _index_entry("g_new", updated_at="2026-09-22T00:00:00Z"),
            _index_entry("g_mid", updated_at="2026-09-10T00:00:00Z"),
            _index_entry("g_broken", status="incomplete", updated_at="2026-09-23T00:00:00Z"),
            _index_entry("m_new", kind="media", updated_at="2026-09-23T00:00:00Z"),
            _index_entry("raw_new", kind="raw", updated_at="2026-09-23T00:00:00Z"),
        ],
    )
    assert [e.id for e in idx.related_entries(index)] == ["g_new", "g_mid", "g_old"]
    assert [e.id for e in idx.related_entries(index, limit=2)] == ["g_new", "g_mid"]
    assert idx.related_entries(index, limit=0) == []


def test_raw_entry_id_matches_scanned_id(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    (folder / "concept").mkdir()
    (folder / "concept" / "castle.png").write_bytes(_PNG)
    entry = idx.scan_library(mount).entries[0]
    assert entry.id == idx.raw_entry_id("concept/castle.png")
