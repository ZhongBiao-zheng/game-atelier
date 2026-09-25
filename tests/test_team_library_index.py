from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from character_workflow.lib import team_library as tl
from character_workflow.lib import team_library_index as idx
from character_workflow.lib.schemas import TeamLibraryIndex, TeamLibraryIndexEntry

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


def scan_and_cache(mount) -> TeamLibraryIndex:
    """扫描并写本机索引缓存（refresh_team_library 去掉广播与并发票号的那部分），供各团队库测试共用。"""
    index = idx.build_index(mount)
    idx.write_index(index)
    return index


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
    index = scan_and_cache(mount)
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
    entry = scan_and_cache(mount).entries[0]
    assert entry.status == "incomplete"


def test_diff_reports_added_updated_removed(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    before = scan_and_cache(mount)
    asset_dir = _shared_asset(folder)
    after = scan_and_cache(mount)
    assert idx.diff_index(before, after) == [{
        "asset_id": _ASSET_ID, "kind": "media", "author": "老王", "change": "added",
        "title": "董卓 待机", "status": "ready", "mime_type": "image/png",
    }]
    data = json.loads((asset_dir / "asset.json").read_text("utf-8"))
    data["updated_at"] = "2026-09-21T00:00:00Z"
    data["title"] = "董卓 攻击"
    (asset_dir / "asset.json").write_text(json.dumps(data), "utf-8")
    updated = scan_and_cache(mount)
    assert idx.diff_index(after, updated) == [{
        "asset_id": _ASSET_ID, "kind": "media", "author": "老王", "change": "updated",
        "title": "董卓 攻击", "status": "ready", "mime_type": "image/png",
    }]
    import shutil
    shutil.rmtree(asset_dir)
    assert idx.diff_index(updated, scan_and_cache(mount)) == [{
        "asset_id": _ASSET_ID, "kind": "media", "author": "老王", "change": "removed",
        "title": None, "status": None, "mime_type": None,
    }]


def test_diff_incomplete_becoming_ready_is_added(isolated_data_root, tmp_path):
    """网盘同步分批落地：asset.json 先到、成片后到，补全那一刻才是「首次可用」。"""
    folder, mount = _mount(tmp_path)
    asset_dir = _shared_asset(folder)
    (asset_dir / "dz.png").unlink()
    before = scan_and_cache(mount)
    assert before.entries[0].status == "incomplete"
    (asset_dir / "dz.png").write_bytes(_PNG)
    (change,) = idx.diff_index(before, scan_and_cache(mount))
    assert (change["change"], change["status"]) == ("added", "ready")


def test_diff_ready_title_change_is_updated(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = _shared_asset(folder)
    before = scan_and_cache(mount)
    data = json.loads((asset_dir / "asset.json").read_text("utf-8"))
    data.update(title="董卓 攻击", updated_at="2026-09-21T00:00:00Z")
    (asset_dir / "asset.json").write_text(json.dumps(data), "utf-8")
    (change,) = idx.diff_index(before, scan_and_cache(mount))
    assert (change["change"], change["title"]) == ("updated", "董卓 攻击")


def test_diff_ready_becoming_incomplete_is_updated(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = _shared_asset(folder)
    before = scan_and_cache(mount)
    (asset_dir / "dz.png").unlink()
    (change,) = idx.diff_index(before, scan_and_cache(mount))
    assert (change["change"], change["status"]) == ("updated", "incomplete")


def test_build_index_does_not_write_cache(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _shared_asset(folder)
    index = idx.build_index(mount)
    assert idx.read_index(mount.library_id) is None
    idx.write_index(index)
    assert idx.read_index(mount.library_id).entries == index.entries


def test_diff_payload_validates_as_change_event(isolated_data_root, tmp_path):
    from character_workflow.lib.schemas import TeamLibraryChangeEvent

    folder, mount = _mount(tmp_path)
    before = scan_and_cache(mount)
    _shared_asset(folder)
    (change,) = idx.diff_index(before, scan_and_cache(mount))
    event = TeamLibraryChangeEvent(library_id=mount.library_id, **change)
    assert event.model_dump(mode="json") == {"library_id": mount.library_id, **change}


def test_diff_without_prior_index_is_silent(isolated_data_root, tmp_path):
    """首扫 / 索引缓存丢失：整库都会算成 added，不能对每条都弹提醒。"""
    folder, mount = _mount(tmp_path)
    _shared_asset(folder)
    (folder / "castle.png").write_bytes(_PNG)
    assert idx.diff_index(None, scan_and_cache(mount)) == []


def test_query_filters_and_pages(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _shared_asset(folder)
    for i in range(3):
        (folder / f"r{i}.png").write_bytes(_PNG)
    index = scan_and_cache(mount)
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
    index = scan_and_cache(mount)
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
    entry = scan_and_cache(mount).entries[0]
    assert idx.thumbnail_bytes(mount, entry, 256)
    newer = entry.model_copy(update={"updated_at": "2030-01-01T00:00:00+00:00"})
    assert idx.thumbnail_bytes(mount, newer, 256)
    thumbs = sorted(p.name for p in (idx.cache_dir(mount.library_id) / "thumbs").iterdir())
    assert len(thumbs) == 2 and all(name.startswith(f"{entry.id}-256-") for name in thumbs)


def test_thumbnail_returns_none_on_decompression_bomb(isolated_data_root, tmp_path, monkeypatch):
    folder, mount = _mount(tmp_path)
    (folder / "a.png").write_bytes(_PNG)
    entry = scan_and_cache(mount).entries[0]

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
    entry = scan_and_cache(mount).entries[0]
    with pytest.raises(FileNotFoundError):
        idx.entry_content_path(mount, entry)


def test_scan_skips_symlink_pointing_outside_library(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    (folder / "inside.png").write_bytes(_PNG)
    outside = tmp_path / "outside.png"
    outside.write_bytes(_PNG)
    (folder / "linked.png").symlink_to(outside)
    entries = scan_and_cache(mount).entries
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
    entries = scan_and_cache(mount).entries
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
    entries = scan_and_cache(mount).entries
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
    entries = {e.kind: e for e in scan_and_cache(mount).entries}
    generation = entries["generation"]
    assert generation.status == "ready" and generation.reproducible
    assert generation.model == "doubao-seedream-4-0" and generation.cost_cny == 0.21
    assert entries["raw"].model is None and entries["raw"].cost_cny is None


def test_media_entry_has_no_model(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _shared_asset(folder)
    entry = scan_and_cache(mount).entries[0]
    assert entry.model is None and entry.cost_cny is None


def test_unknown_fields_from_newer_writer_stay_ready(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = _generation_asset(folder, extra={"license": "CC0"})
    data = json.loads((asset_dir / "asset.json").read_text("utf-8"))
    data["snapshot"]["seed_policy"] = "fixed"
    data["snapshot"]["inputs"][0]["weight"] = 0.5
    data["author"]["avatar"] = "x.png"
    (asset_dir / "asset.json").write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    entry = scan_and_cache(mount).entries[0]
    assert entry.kind == "generation" and entry.status == "ready"


def test_future_asset_version_is_incomplete(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _generation_asset(folder, extra={"team_asset_version": 2})
    entry = scan_and_cache(mount).entries[0]
    assert entry.status == "incomplete" and not entry.reproducible


def test_generation_with_missing_ref_is_incomplete(isolated_data_root, tmp_path):
    """refs 还没同步到：采用必失败，索引不能标 ready。"""
    folder, mount = _mount(tmp_path)
    _generation_asset(folder, ref=False)
    entry = scan_and_cache(mount).entries[0]
    assert entry.kind == "generation" and entry.status == "incomplete"


def test_generation_with_ref_symlink_outside_is_incomplete(isolated_data_root, tmp_path):
    import hashlib

    folder, mount = _mount(tmp_path)
    asset_dir = _generation_asset(folder, ref=False)
    outside = tmp_path / "outside.png"
    outside.write_bytes(_PNG)
    sha = hashlib.sha256(_PNG).hexdigest()
    (asset_dir / f"refs/01-{sha[:12]}.png").symlink_to(outside)
    entry = scan_and_cache(mount).entries[0]
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
    entry = scan_and_cache(mount).entries[0]
    assert entry.id == idx.raw_entry_id("concept/castle.png")


def test_entry_content_path_refuses_entries_that_are_not_ready(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _shared_asset(folder)
    entry = scan_and_cache(mount).entries[0].model_copy(update={"status": "incomplete"})
    with pytest.raises(FileNotFoundError):
        idx.entry_content_path(mount, entry)
    assert idx.thumbnail_bytes(mount, entry, 256) is None


def test_entry_content_path_keeps_media_inside_its_asset_dir(isolated_data_root, tmp_path):
    """文件名指到库内别的目录也不行：分享资产只能读它自己的资产目录。"""
    folder, mount = _mount(tmp_path)
    asset_dir = _shared_asset(folder)
    (folder / "shared" / "老王" / "dz.png").write_bytes(_PNG)
    data = json.loads((asset_dir / "asset.json").read_text("utf-8"))
    data["media"]["filename"] = "../dz.png"
    (asset_dir / "asset.json").write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    entry = scan_and_cache(mount).entries[0]
    assert entry.status == "incomplete"
    with pytest.raises(FileNotFoundError):
        idx.entry_content_path(mount, entry.model_copy(update={"status": "ready"}))
    assert idx.thumbnail_bytes(mount, entry.model_copy(update={"status": "ready"}), 256) is None


def test_entry_content_path_rejects_media_symlink_out_of_asset_dir(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = _shared_asset(folder)
    other = folder / "concept"
    other.mkdir()
    (other / "dz.png").write_bytes(_PNG)
    (asset_dir / "dz.png").unlink()
    (asset_dir / "dz.png").symlink_to(other / "dz.png")
    entry = scan_and_cache(mount).entries
    shared = next(e for e in entry if e.kind == "media")
    assert shared.status == "incomplete"
    with pytest.raises(FileNotFoundError):
        idx.entry_content_path(mount, shared.model_copy(update={"status": "ready"}))


def test_scan_skips_shared_dirs_symlinked_outside_library(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    outside = tmp_path / "elsewhere"
    _shared_asset(outside)  # elsewhere/shared/老王/<id>/ 是一份完整资产
    (folder / "shared").mkdir()
    (folder / "shared" / "老王").symlink_to(outside / "shared" / "老王")
    (folder / "shared" / "小李").mkdir()
    (folder / "shared" / "小李" / _ASSET_ID).symlink_to(outside / "shared" / "老王" / _ASSET_ID)
    assert scan_and_cache(mount).entries == []


def test_asset_dir_name_must_match_asset_id(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = _shared_asset(folder)
    asset_dir.rename(asset_dir.parent / "ta_01ARZ3NDEKTSV4RRFFQ69G5FAW")
    entry = scan_and_cache(mount).entries[0]
    assert entry.status == "incomplete" and entry.id == "ta_01ARZ3NDEKTSV4RRFFQ69G5FAW"


def test_related_entries_sort_by_instant_not_string():
    from character_workflow.lib.schemas import TeamLibraryIndex

    index = TeamLibraryIndex(
        library_id="lib_" + "1" * 16,
        scanned_at="2026-09-23T00:00:00Z",
        entries=[
            _index_entry("g_east", updated_at="2026-09-20T08:00:00+08:00"),  # = 00:00Z
            _index_entry("g_utc", updated_at="2026-09-20T01:00:00Z"),
        ],
    )
    assert [e.id for e in idx.related_entries(index)] == ["g_utc", "g_east"]


def _two_ref_generation(folder):
    import hashlib
    from io import BytesIO

    from PIL import Image

    def png(color):
        buffer = BytesIO()
        Image.new("RGB", (2, 2), color).save(buffer, format="PNG")
        return buffer.getvalue()

    refs = [png((200, 0, 0)), png((0, 200, 0))]
    asset_dir = _generation_asset(folder, ref=False)
    data = json.loads((asset_dir / "asset.json").read_text("utf-8"))
    inputs = []
    for order, body in enumerate(refs):
        sha = hashlib.sha256(body).hexdigest()
        path = f"refs/{order + 1:02d}-{sha[:12]}.png"
        (asset_dir / path).write_bytes(body)
        inputs.append({"order": order, "role": "reference", "kind": "image", "sha256": sha,
                       "mime_type": "image/png", "path": path})
    data["snapshot"]["inputs"] = inputs
    (asset_dir / "asset.json").write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    return [row["sha256"] for row in inputs]


def test_generation_entry_lists_input_sha256_in_order(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    shas = _two_ref_generation(folder)
    (folder / "castle.png").write_bytes(_PNG)
    entries = {e.kind: e for e in scan_and_cache(mount).entries}
    assert entries["generation"].status == "ready"
    assert entries["generation"].input_sha256 == shas
    assert entries["raw"].input_sha256 == []


def test_media_entry_has_no_input_sha256(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _shared_asset(folder)
    assert scan_and_cache(mount).entries[0].input_sha256 == []


def test_related_by_input_sha_hits_ready_generations_newest_first():
    from character_workflow.lib.schemas import TeamLibraryIndex

    hit, other = "a" * 64, "b" * 64

    def entry(entry_id, *, shas, **kwargs):
        return _index_entry(entry_id, **kwargs).model_copy(update={"input_sha256": shas})

    index = TeamLibraryIndex(
        library_id="lib_" + "1" * 16,
        scanned_at="2026-09-23T00:00:00Z",
        entries=[
            entry("g_old", shas=[other, hit], updated_at="2026-09-01T00:00:00Z"),
            entry("g_new", shas=[hit], updated_at="2026-09-22T08:00:00+08:00"),
            entry("g_mid", shas=[hit], updated_at="2026-09-10T00:00:00Z"),
            entry("g_miss", shas=[other], updated_at="2026-09-23T00:00:00Z"),
            entry("g_broken", shas=[hit], status="incomplete", updated_at="2026-09-23T00:00:00Z"),
            entry("m_hit", shas=[hit], kind="media", updated_at="2026-09-23T00:00:00Z"),
        ],
    )
    assert [e.id for e in idx.related_by_input_sha(index, hit)] == ["g_new", "g_mid", "g_old"]
    assert [e.id for e in idx.related_by_input_sha(index, hit, limit=1)] == ["g_new"]
    assert idx.related_by_input_sha(index, hit, limit=0) == []
    assert idx.related_by_input_sha(index, "c" * 64) == []
