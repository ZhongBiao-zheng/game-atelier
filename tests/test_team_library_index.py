from __future__ import annotations

import base64
import json

from character_workflow.lib import team_library as tl
from character_workflow.lib import team_library_index as idx

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
    assert (idx.cache_dir(mount.library_id) / "thumbs" / f"{entry.id}-256.webp").is_file()
    assert sorted(p.name for p in folder.iterdir()) == [tl.MANIFEST_NAME, "a.png"]
