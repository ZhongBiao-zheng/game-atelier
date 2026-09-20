from __future__ import annotations

import base64
import hashlib
import json

import pytest

from character_workflow.lib.creation_assets import list_creation_assets
from character_workflow.lib.schemas import TeamLibraryIndexEntry, TeamLibraryMount
from character_workflow.lib.team_library_adopt import TeamAssetAdoptError, adopt_team_asset

_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
_ID = "ta_01ARZ3NDEKTSV4RRFFQ69G5FAV"


def _mount(tmp_path):
    folder = tmp_path / "lib"
    folder.mkdir()
    return folder, TeamLibraryMount(
        library_id="lib_" + "1" * 16,
        project_id="p1",
        mount_path=str(folder),
        name="lib",
        mounted_at="2026-09-20T00:00:00Z",
    )


def _entry(**overrides):
    base = dict(
        id=_ID,
        kind="media",
        title="董卓",
        author="老王",
        tags=["皮肤"],
        mime_type="image/png",
        bytes=len(_PNG),
        relative_path=f"shared/老王/{_ID}",
        sha256=hashlib.sha256(_PNG).hexdigest(),
        updated_at="2026-09-20T00:00:00Z",
        reproducible=False,
        status="ready",
    )
    return TeamLibraryIndexEntry(**{**base, **overrides})


def _write_shared(folder, kind="media", prompt=None):
    asset_dir = folder / "shared" / "老王" / _ID
    asset_dir.mkdir(parents=True)
    body = {
        "team_asset_version": 1,
        "asset_id": _ID,
        "kind": kind,
        "title": "董卓",
        "tags": ["皮肤"],
        "author": {"display_name": "老王"},
        "shared_at": "2026-09-20T00:00:00Z",
        "updated_at": "2026-09-20T00:00:00Z",
    }
    if kind == "media":
        (asset_dir / "dz.png").write_bytes(_PNG)
        body["media"] = {
            "filename": "dz.png",
            "mime_type": "image/png",
            "bytes": len(_PNG),
            "sha256": hashlib.sha256(_PNG).hexdigest(),
        }
    else:
        body["prompt"] = prompt
    (asset_dir / "asset.json").write_text(json.dumps(body, ensure_ascii=False), "utf-8")


def test_adopt_media_copies_into_blobs_and_records_origin(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _write_shared(folder)
    asset, created = adopt_team_asset(mount=mount, entry=_entry(), project_id="p1")
    assert created and asset.kind == "media" and asset.content.kind == "media"
    assert asset.adopted_from.library_id == mount.library_id and asset.adopted_from.asset_id == _ID
    assert asset.adopted_from.source_updated_at == "2026-09-20T00:00:00Z"
    assert asset.project_ids == ["p1"] and asset.tags == ["皮肤"]
    assert (isolated_data_root / asset.content.path).read_bytes() == _PNG
    again, created_again = adopt_team_asset(mount=mount, entry=_entry(), project_id="p1")
    assert not created_again and again.asset_id == asset.asset_id
    assert len(list_creation_assets().assets) == 1


def test_adopt_prompt(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _write_shared(
        folder,
        kind="prompt",
        prompt={"kind": "prompt", "segments": [{"kind": "text", "text": "像素猫"}]},
    )
    asset, _ = adopt_team_asset(
        mount=mount,
        entry=_entry(kind="prompt", mime_type="text/plain", bytes=0, sha256=None),
        project_id=None,
    )
    assert asset.kind == "prompt" and asset.content.segments[0].text == "像素猫"


def test_adopt_raw_file_dedupes_by_sha256_and_keeps_path(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    (folder / "concept").mkdir()
    (folder / "concept" / "castle.png").write_bytes(_PNG)
    entry = _entry(
        id="raw_abc",
        kind="raw",
        title="castle.png",
        author=None,
        tags=[],
        relative_path="concept/castle.png",
        sha256=None,
    )
    asset, created = adopt_team_asset(mount=mount, entry=entry, project_id="p1")
    assert created and asset.title == "castle.png"
    assert asset.adopted_from.raw_path == "concept/castle.png"
    assert asset.adopted_from.asset_id == "raw_abc"
    _, created_again = adopt_team_asset(mount=mount, entry=entry, project_id="p1")
    assert not created_again


def test_adopt_rejects_generation_and_incomplete(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    with pytest.raises(TeamAssetAdoptError):
        adopt_team_asset(mount=mount, entry=_entry(kind="generation"), project_id=None)
    with pytest.raises(TeamAssetAdoptError):
        adopt_team_asset(mount=mount, entry=_entry(status="incomplete"), project_id=None)


def test_adopt_rejects_path_escaping_mount(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    (tmp_path / "outside.png").write_bytes(_PNG)
    entry = _entry(
        id="raw_escape",
        kind="raw",
        title="outside.png",
        author=None,
        tags=[],
        relative_path="../outside.png",
        sha256=None,
    )
    with pytest.raises(TeamAssetAdoptError):
        adopt_team_asset(mount=mount, entry=entry, project_id="p1")


def test_adopt_rejects_kind_mismatch_between_index_and_asset_json(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = folder / "shared" / "老王" / _ID
    asset_dir.mkdir(parents=True)
    (asset_dir / "dz.png").write_bytes(_PNG)
    (asset_dir / "asset.json").write_text(
        json.dumps(
            {
                "team_asset_version": 1,
                "asset_id": _ID,
                "kind": "generation",
                "title": "董卓",
                "tags": ["皮肤"],
                "author": {"display_name": "老王"},
                "shared_at": "2026-09-20T00:00:00Z",
                "updated_at": "2026-09-20T00:00:00Z",
                "media": {
                    "filename": "dz.png",
                    "mime_type": "image/png",
                    "bytes": len(_PNG),
                    "sha256": hashlib.sha256(_PNG).hexdigest(),
                },
                "snapshot": {"model": "seedream"},
            },
            ensure_ascii=False,
        ),
        "utf-8",
    )
    with pytest.raises(TeamAssetAdoptError):
        adopt_team_asset(mount=mount, entry=_entry(), project_id="p1")
