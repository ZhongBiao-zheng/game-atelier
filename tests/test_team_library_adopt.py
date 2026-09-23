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


def test_adopt_rejects_incomplete(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
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
                "snapshot": {
                    "mode": "image",
                    "model": "seedream",
                    "final_prompt": "董卓",
                    "submitted_at": "2026-09-20T00:00:00Z",
                },
            },
            ensure_ascii=False,
        ),
        "utf-8",
    )
    with pytest.raises(TeamAssetAdoptError):
        adopt_team_asset(mount=mount, entry=_entry(), project_id="p1")


def _raw_entry(relative_path="concept/castle.png"):
    return _entry(
        id="raw_abc",
        kind="raw",
        title="castle.png",
        author=None,
        tags=[],
        relative_path=relative_path,
        sha256=None,
    )


def test_adopt_raw_after_content_change_creates_new_copy(isolated_data_root, tmp_path):
    """原始文件的 id 只由路径得来：SVN update 改了内容，重新采用必须拿到新内容。"""
    from io import BytesIO

    from PIL import Image

    folder, mount = _mount(tmp_path)
    (folder / "concept").mkdir()
    target = folder / "concept" / "castle.png"
    target.write_bytes(_PNG)
    first, created = adopt_team_asset(mount=mount, entry=_raw_entry(), project_id="p1")
    assert created
    buffer = BytesIO()
    Image.new("RGB", (2, 2), (10, 20, 30)).save(buffer, format="PNG")
    changed = buffer.getvalue()
    target.write_bytes(changed)
    second, created_again = adopt_team_asset(mount=mount, entry=_raw_entry(), project_id="p1")
    assert created_again and second.asset_id != first.asset_id
    assert second.content.sha256 == hashlib.sha256(changed).hexdigest()


def test_adopt_raw_duplicate_joins_the_new_project(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    (folder / "concept").mkdir()
    (folder / "concept" / "castle.png").write_bytes(_PNG)
    first, _ = adopt_team_asset(mount=mount, entry=_raw_entry(), project_id="p1")
    again, created = adopt_team_asset(mount=mount, entry=_raw_entry(), project_id="p2")
    assert not created and again.asset_id == first.asset_id
    assert again.project_ids == ["p1", "p2"]
    assert [a.project_ids for a in list_creation_assets().assets] == [["p1", "p2"]]


# ---- 生成资产 ----

def _png(color) -> bytes:
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (2, 2), color).save(buffer, format="PNG")
    return buffer.getvalue()


_REF_A = _png((200, 10, 10))
_REF_B = _png((10, 200, 10))


def _sha(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def _ref_path(order: int, body: bytes) -> str:
    return f"refs/{order + 1:02d}-{_sha(body)[:12]}.png"


def _write_generation(folder, refs=(_REF_A, _REF_B), updated_at="2026-09-20T00:00:00Z"):
    """按契约布局手写一条生成资产：成片 + thumb + refs/NN-<sha12>.<ext> + asset.json。"""
    asset_dir = folder / "shared" / "老王" / _ID
    (asset_dir / "refs").mkdir(parents=True)
    (asset_dir / "dz.png").write_bytes(_PNG)
    inputs = []
    for order, body in enumerate(refs):
        path = _ref_path(order, body)
        (asset_dir / path).write_bytes(body)
        inputs.append({
            "order": order, "role": "reference", "kind": "image", "sha256": _sha(body),
            "mime_type": "image/png", "path": path,
        })
    body = {
        "team_asset_version": 1,
        "asset_id": _ID,
        "kind": "generation",
        "title": "董卓",
        "tags": ["皮肤"],
        "author": {"display_name": "老王"},
        "shared_at": "2026-09-20T00:00:00Z",
        "updated_at": updated_at,
        "media": {
            "filename": "dz.png", "mime_type": "image/png", "bytes": len(_PNG),
            "sha256": _sha(_PNG),
        },
        "snapshot": {
            "mode": "image",
            "model": "doubao-seedream-4-0",
            "provider": "volces",
            "alias": "seedream",
            "final_prompt": "董卓 待机",
            "params": {"size": "2048x2048"},
            "inputs": inputs,
            "cost_cny": 0.21,
            "cost_basis": "actual",
            "submitted_at": "2026-09-19T00:00:00Z",
        },
    }
    (asset_dir / "asset.json").write_text(json.dumps(body, ensure_ascii=False), "utf-8")
    return asset_dir


def _generation_entry(**overrides):
    return _entry(kind="generation", reproducible=True, **overrides)


def _rewrite_asset_json(asset_dir, mutate):
    data = json.loads((asset_dir / "asset.json").read_text("utf-8"))
    mutate(data)
    (asset_dir / "asset.json").write_text(json.dumps(data, ensure_ascii=False), "utf-8")


def test_adopt_generation_copies_media_and_refs_into_blobs(isolated_data_root, tmp_path):
    from character_workflow.lib.creation_assets import (
        creation_asset_input_path,
        creation_asset_media_path,
    )

    folder, mount = _mount(tmp_path)
    _write_generation(folder)
    asset, created = adopt_team_asset(mount=mount, entry=_generation_entry(), project_id="p1")
    assert created and asset.kind == "generation" and asset.content.kind == "generation"
    assert asset.title == "董卓" and asset.tags == ["皮肤"] and asset.project_ids == ["p1"]
    assert asset.adopted_from.asset_id == _ID
    assert asset.adopted_from.source_updated_at == "2026-09-20T00:00:00Z"
    snapshot = asset.content.snapshot
    assert snapshot.model == "doubao-seedream-4-0" and snapshot.cost_cny == 0.21
    assert [row.sha256 for row in snapshot.inputs] == [_sha(_REF_A), _sha(_REF_B)]
    assert "path" not in snapshot.inputs[0].model_dump()
    assert creation_asset_media_path(asset.asset_id).read_bytes() == _PNG
    for order, body in enumerate((_REF_A, _REF_B)):
        path, mime = creation_asset_input_path(asset.asset_id, order)
        assert path.read_bytes() == body and mime == "image/png"
    again, created_again = adopt_team_asset(mount=mount, entry=_generation_entry(), project_id="p1")
    assert not created_again and again.asset_id == asset.asset_id
    assert len(list_creation_assets().assets) == 1


def test_adopt_generation_without_refs(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    _write_generation(folder, refs=())
    asset, created = adopt_team_asset(mount=mount, entry=_generation_entry(), project_id=None)
    assert created and asset.content.snapshot.inputs == []


def test_adopt_generation_rejects_ref_hash_mismatch(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = _write_generation(folder)
    (asset_dir / _ref_path(1, _REF_B)).write_bytes(_REF_A)
    with pytest.raises(TeamAssetAdoptError):
        adopt_team_asset(mount=mount, entry=_generation_entry(), project_id=None)
    assert list_creation_assets().assets == []


def test_adopt_generation_rejects_media_hash_mismatch(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = _write_generation(folder)
    (asset_dir / "dz.png").write_bytes(_REF_A)
    with pytest.raises(TeamAssetAdoptError):
        adopt_team_asset(mount=mount, entry=_generation_entry(), project_id=None)


def test_adopt_generation_rejects_missing_ref(isolated_data_root, tmp_path):
    folder, mount = _mount(tmp_path)
    asset_dir = _write_generation(folder)
    (asset_dir / _ref_path(0, _REF_A)).unlink()
    with pytest.raises(TeamAssetAdoptError):
        adopt_team_asset(mount=mount, entry=_generation_entry(), project_id=None)


def test_adopt_generation_rejects_ref_symlink_outside_library(isolated_data_root, tmp_path):
    """内容与 sha256 都对得上也不行：refs 必须真在资产目录里，不能借 symlink 读库外文件。"""
    folder, mount = _mount(tmp_path)
    asset_dir = _write_generation(folder)
    outside = tmp_path / "outside.png"
    outside.write_bytes(_REF_A)
    ref = asset_dir / _ref_path(0, _REF_A)
    ref.unlink()
    ref.symlink_to(outside)
    with pytest.raises(TeamAssetAdoptError):
        adopt_team_asset(mount=mount, entry=_generation_entry(), project_id=None)
    assert list_creation_assets().assets == []


def test_adopt_rejects_media_filename_escaping_asset_dir(isolated_data_root, tmp_path):
    """成片文件名越出资产目录（哪怕仍在库内）一律拒绝。"""
    folder, mount = _mount(tmp_path)
    asset_dir = _write_generation(folder)
    (folder / "shared" / "dz.png").write_bytes(_PNG)
    _rewrite_asset_json(asset_dir, lambda data: data["media"].update(filename="../../dz.png"))
    with pytest.raises(TeamAssetAdoptError):
        adopt_team_asset(mount=mount, entry=_generation_entry(), project_id=None)


def test_adopt_rejects_asset_id_mismatch_between_index_and_asset_json(
    isolated_data_root, tmp_path
):
    folder, mount = _mount(tmp_path)
    asset_dir = _write_generation(folder)
    _rewrite_asset_json(
        asset_dir, lambda data: data.update(asset_id="ta_01ARZ3NDEKTSV4RRFFQ69G5FAW")
    )
    with pytest.raises(TeamAssetAdoptError):
        adopt_team_asset(mount=mount, entry=_generation_entry(), project_id=None)


@pytest.mark.parametrize("kind", ["media", "prompt", "generation"])
def test_readopt_shared_asset_joins_the_new_project(isolated_data_root, tmp_path, kind):
    folder, mount = _mount(tmp_path)
    if kind == "generation":
        _write_generation(folder)
        entry = _generation_entry()
    elif kind == "prompt":
        _write_shared(
            folder, kind="prompt",
            prompt={"kind": "prompt", "segments": [{"kind": "text", "text": "像素猫"}]},
        )
        entry = _entry(kind="prompt", mime_type="text/plain", bytes=0, sha256=None)
    else:
        _write_shared(folder)
        entry = _entry()
    first, _ = adopt_team_asset(mount=mount, entry=entry, project_id="p1")
    again, created = adopt_team_asset(mount=mount, entry=entry, project_id="p2")
    assert not created and again.asset_id == first.asset_id
    assert again.project_ids == ["p1", "p2"]
    assert [a.project_ids for a in list_creation_assets().assets] == [["p1", "p2"]]
    same, _ = adopt_team_asset(mount=mount, entry=entry, project_id=None)
    assert same.project_ids == ["p1", "p2"]


# ---- 过时判定 ----

def _registered_mount(tmp_path):
    from character_workflow.lib import team_library as tl

    folder = tmp_path / "lib"
    folder.mkdir()
    return folder, tl.mount_library(project_id="p1", path=str(folder), name=None, created_by="我")


def _adopt_from_index(mount, entry_id):
    from character_workflow.lib import team_library_index as idx

    entry = idx.get_entry(idx.scan_library(mount), entry_id)
    asset, _ = adopt_team_asset(mount=mount, entry=entry, project_id="p1")
    return asset


def test_staleness_unknown_for_local_asset(isolated_data_root):
    from character_workflow.lib.creation_assets import create_prompt_asset
    from character_workflow.lib.team_library_adopt import adoption_staleness

    asset = create_prompt_asset("猫", [{"kind": "text", "text": "像素猫"}], [])
    assert adoption_staleness(asset) == "unknown"


def test_staleness_unknown_when_library_not_mounted(isolated_data_root, tmp_path):
    from character_workflow.lib.team_library_adopt import adoption_staleness

    folder, mount = _mount(tmp_path)  # 只构造挂载记录，没登记进 team-libraries.json
    _write_shared(folder)
    asset, _ = adopt_team_asset(mount=mount, entry=_entry(), project_id="p1")
    assert adoption_staleness(asset) == "unknown"


def test_staleness_unknown_when_unreachable_or_no_index(isolated_data_root, tmp_path):
    import shutil

    from character_workflow.lib import team_library as tl
    from character_workflow.lib import team_library_index as idx
    from character_workflow.lib.team_library_adopt import adoption_staleness

    folder, mount = _registered_mount(tmp_path)
    _write_shared(folder)
    asset = _adopt_from_index(mount, _ID)
    assert adoption_staleness(asset) == "fresh"
    shutil.rmtree(idx.cache_dir(mount.library_id))
    assert adoption_staleness(asset) == "unknown"
    idx.scan_library(mount)
    (folder / tl.MANIFEST_NAME).unlink()
    assert adoption_staleness(asset) == "unknown"


def test_staleness_stale_then_withdrawn(isolated_data_root, tmp_path):
    import shutil

    from character_workflow.lib import team_library_index as idx
    from character_workflow.lib.team_library_adopt import adoption_staleness

    folder, mount = _registered_mount(tmp_path)
    asset_dir = _write_generation(folder)
    asset = _adopt_from_index(mount, _ID)
    assert adoption_staleness(asset) == "fresh"
    _rewrite_asset_json(asset_dir, lambda data: data.update(updated_at="2026-09-21T00:00:00Z"))
    idx.scan_library(mount)
    assert adoption_staleness(asset) == "stale"
    shutil.rmtree(asset_dir)
    idx.scan_library(mount)
    assert adoption_staleness(asset) == "withdrawn"


def test_staleness_compares_instants_not_strings(isolated_data_root, tmp_path):
    """Z 与 +00:00 是同一时刻：按字符串比会把新鲜副本误报成过时。"""
    from character_workflow.lib import team_library_index as idx
    from character_workflow.lib.team_library_adopt import adoption_staleness

    folder, mount = _registered_mount(tmp_path)
    _write_shared(folder)
    asset_dir = folder / "shared" / "老王" / _ID
    asset = _adopt_from_index(mount, _ID)
    _rewrite_asset_json(
        asset_dir, lambda data: data.update(updated_at="2026-09-20T08:00:00+08:00")
    )
    idx.scan_library(mount)
    assert adoption_staleness(asset) == "fresh"


def test_staleness_raw_entry_follows_raw_path(isolated_data_root, tmp_path):
    import os

    from character_workflow.lib import team_library_index as idx
    from character_workflow.lib.team_library_adopt import adoption_staleness

    folder, mount = _registered_mount(tmp_path)
    (folder / "concept").mkdir()
    target = folder / "concept" / "castle.png"
    target.write_bytes(_PNG)
    os.utime(target, (1_700_000_000, 1_700_000_000))
    asset = _adopt_from_index(mount, idx.raw_entry_id("concept/castle.png"))
    assert asset.adopted_from.raw_path == "concept/castle.png"
    assert adoption_staleness(asset) == "fresh"
    os.utime(target, (1_800_000_000, 1_800_000_000))
    idx.scan_library(mount)
    assert adoption_staleness(asset) == "stale"
    target.rename(folder / "concept" / "castle-v2.png")
    idx.scan_library(mount)
    assert adoption_staleness(asset) == "withdrawn"
