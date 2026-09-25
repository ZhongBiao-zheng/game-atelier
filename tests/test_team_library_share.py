"""分享 lib：Studio 结果与创作资产写进团队库作者目录；编辑 / 撤回只动作者自己的资产。"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
from pathlib import Path

import pytest
from PIL import Image

from tests.team_library_helpers import scan_and_cache
from character_workflow.lib import generation_recipe
from character_workflow.lib import team_library_share as share
from character_workflow.lib.creation_assets import (
    blob_path_for,
    create_generation_asset,
    create_media_asset_from_bytes,
    create_prompt_asset,
    creation_asset_input_path,
    store_media_blob,
)
from character_workflow.lib.generation_recipe import RECIPE_PARAM_ALLOW, RECIPE_PARAM_EXCLUDE
from character_workflow.lib.jobs import new_job_id, save_job
from character_workflow.lib.schemas import (
    TEAM_RECIPE_INPUT_PATH_PATTERN,
    GenerationRecipe,
    Job,
    JobKind,
    JobParams,
    JobStatus,
    RecipeInput,
    TeamAssetFile,
    TeamLibraryMount,
)
from character_workflow.lib.studio_jobs import studio_output_dir
from character_workflow.lib.team_library_adopt import adopt_team_asset
from character_workflow.lib.team_library_share import (
    TeamShareError,
    TeamShareForbidden,
    TeamShareNotFound,
    TeamShareTooLarge,
    author_dir_name,
    share_canvas_result,
    share_creation_asset,
    share_job_output,
    update_shared_asset,
    withdraw_shared_asset,
)

_AUTHOR = "老王"
_FAKE_MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
_FAKE_MP3 = b"ID3" + b"\x00" * 64


def _png(color: tuple[int, int, int], size: tuple[int, int] = (4, 4)) -> bytes:
    return _image(color, "PNG", size)


def _image(color: tuple[int, int, int], fmt: str, size: tuple[int, int] = (4, 4)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format=fmt)
    return buffer.getvalue()


def _sha(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


@pytest.fixture
def mount(tmp_path) -> TeamLibraryMount:
    folder = tmp_path / "team-lib"
    folder.mkdir()
    return TeamLibraryMount(
        library_id="lib_" + "a" * 16,
        project_id="canvas-p1",
        mount_path=str(folder),
        name="角色参考",
        mounted_at="2026-09-23T00:00:00Z",
    )


def _write_upload(root: Path, name: str, body: bytes) -> Path:
    path = root / ".runtime" / "uploads" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


def _studio_job(
    *,
    outputs: list[tuple[str, bytes]],
    params: dict | None = None,
    kind: JobKind = JobKind.IMAGE,
    status: JobStatus = JobStatus.DONE,
    namespace: str = "studio",
) -> Job:
    job_id = new_job_id()
    paths: list[str] = []
    if namespace == "studio":
        out_dir = studio_output_dir(job_id)
        for name, body in outputs:
            target = out_dir / name
            target.write_bytes(body)
            paths.append(str(target))
    job = Job(
        job_id=job_id,
        character_id="c1" if namespace == "character" else "",
        prompt="一只红色的猫，站在城墙上",
        submitted_at="2026-09-23T01:00:00Z",
        model="gpt-image-2" if kind is JobKind.IMAGE else "seedance-pro",
        params=JobParams(**(params or {})),
        output_paths=paths,
        status=status,
        error=None,
        kind=kind,
        namespace=namespace,
        provider="tuzi",
        alias="tuzi-main",
    )
    return save_job(job)


def _asset_dir(mount: TeamLibraryMount, asset_id: str) -> Path:
    return Path(mount.mount_path) / "shared" / author_dir_name(_AUTHOR) / asset_id


def _read_asset(mount: TeamLibraryMount, asset_id: str) -> TeamAssetFile:
    text = (_asset_dir(mount, asset_id) / "asset.json").read_text(encoding="utf-8")
    return TeamAssetFile.model_validate_json(text)


# ---------------------------------------------------------------- job_output


def test_share_image_job_writes_layout_refs_and_thumbnail(isolated_data_root, mount):
    ref_a, ref_b = _png((0, 200, 0)), _image((0, 0, 200), "JPEG")
    sref = _image((50, 50, 50), "WEBP")
    path_a = _write_upload(isolated_data_root, "a.png", ref_a)
    _write_upload(isolated_data_root, "b.jpg", ref_b)
    path_s = _write_upload(isolated_data_root, "s.webp", sref)
    output = _png((200, 0, 0), size=(1024, 600))
    job = _studio_job(
        outputs=[("1.png", _png((1, 1, 1))), ("2.png", output)],
        params={
            "size": "1024x600",
            "quality": "high",
            "frame_mode": "first",
            # 一条绝对路径、一条数据根相对路径：两种登记方式都要能解析。
            "reference_images": [str(path_a), ".runtime/uploads/b.jpg"],
            "mj_sref": [str(path_s)],
            "estimated_cost_cny": 0.3,
            "actual_cost_cny": 0.21,
            "warnings": ["尺寸已归一"],
            "requested_size": "1024x600",
            "actual_size": "1024x600",
            "provider_task_ids": ["t1"],
            "provider_task_protocol": "tuzi_images",
            "mj_flags": "--ar 16:9",
            "creation_asset_source_title": "旧提示词",
            "archived_from_job_id": "job-x",
            "archived_from_path": "/tmp/x.png",
        },
    )

    written = share_job_output(
        mount, job_id=job.job_id, output_index=1, title=" 城墙红猫 ", tags=["猫", "猫", " 红 "],
        author=_AUTHOR,
    )

    folder = _asset_dir(mount, written.asset_id)
    assert re.fullmatch(r"ta_[0-9A-HJKMNP-TV-Z]{26}", written.asset_id)
    parsed = _read_asset(mount, written.asset_id)
    assert parsed == written
    assert parsed.kind == "generation" and parsed.title == "城墙红猫" and parsed.tags == ["猫", "红"]
    assert parsed.author.display_name == _AUTHOR
    assert parsed.origin is not None and parsed.origin.job_id == job.job_id

    assert parsed.media is not None and parsed.media.filename == "2.png"
    assert (folder / "2.png").read_bytes() == output
    assert parsed.media.sha256 == _sha(output) and parsed.media.bytes == len(output)

    snapshot = parsed.snapshot
    assert snapshot is not None
    assert snapshot.mode == "image" and snapshot.model == "gpt-image-2"
    assert snapshot.provider == "tuzi" and snapshot.alias == "tuzi-main"
    assert snapshot.final_prompt == job.prompt and snapshot.submitted_at == job.submitted_at
    assert [row.order for row in snapshot.inputs] == [0, 1, 2]
    assert [row.role for row in snapshot.inputs] == ["reference", "reference", "mj_sref"]
    assert [row.mime_type for row in snapshot.inputs] == ["image/png", "image/jpeg", "image/webp"]
    for row, body in zip(snapshot.inputs, [ref_a, ref_b, sref]):
        assert re.fullmatch(TEAM_RECIPE_INPUT_PATH_PATTERN, row.path)
        assert row.path.startswith(f"refs/{row.order + 1:02d}-{_sha(body)[:12]}.")
        assert row.sha256 == _sha(body)
        assert _sha((folder / row.path).read_bytes()) == row.sha256
    assert snapshot.inputs[1].path.endswith(".jpg")

    assert snapshot.params == {"size": "1024x600", "quality": "high", "frame_mode": "first"}
    assert not RECIPE_PARAM_EXCLUDE & set(snapshot.params)
    assert snapshot.cost_cny == 0.21 and snapshot.cost_basis == "actual"

    with Image.open(folder / "thumb.webp") as thumb:
        assert thumb.format == "WEBP" and max(thumb.size) <= 512
    assert sorted(p.name for p in folder.iterdir()) == ["2.png", "asset.json", "refs", "thumb.webp"]
    assert not [p for p in folder.parent.iterdir() if p.name.startswith(".")]

    raw = json.loads((folder / "asset.json").read_text(encoding="utf-8"))
    assert raw["team_asset_version"] == 1 and "prompt" not in raw


@pytest.mark.parametrize(
    ("params", "cost", "basis"),
    [
        ({"estimated_cost_cny": 0.3, "actual_cost_cny": 0.2}, 0.2, "actual"),
        ({"estimated_cost_cny": 0.3}, 0.3, "estimated"),
        ({}, None, None),
    ],
)
def test_share_job_cost_basis(isolated_data_root, mount, params, cost, basis):
    job = _studio_job(outputs=[("1.png", _png((9, 9, 9)))], params=params)
    written = share_job_output(
        mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
    )
    assert written.snapshot.cost_cny == cost and written.snapshot.cost_basis == basis


def test_share_video_job_packs_video_and_audio_refs_without_thumbnail(isolated_data_root, mount):
    first = _png((10, 10, 10))
    img = _write_upload(isolated_data_root, "first.png", first)
    vid = _write_upload(isolated_data_root, "motion.mp4", _FAKE_MP4)
    aud = _write_upload(isolated_data_root, "voice.mp3", _FAKE_MP3)
    job = _studio_job(
        kind=JobKind.VIDEO,
        outputs=[("clip.mp4", _FAKE_MP4 + b"out")],
        params={
            "duration": 5,
            "frame_mode": "first",
            "reference_images": [str(img)],
            "reference_videos": [str(vid)],
            "reference_audios": [str(aud)],
        },
    )

    written = share_job_output(
        mount, job_id=job.job_id, output_index=0, title="片段", tags=[], author=_AUTHOR
    )

    folder = _asset_dir(mount, written.asset_id)
    assert written.snapshot.mode == "video"
    assert [(r.kind, r.mime_type) for r in written.snapshot.inputs] == [
        ("image", "image/png"), ("video", "video/mp4"), ("audio", "audio/mpeg"),
    ]
    assert [r.path.rsplit(".", 1)[1] for r in written.snapshot.inputs] == ["png", "mp4", "mp3"]
    assert written.media.mime_type == "video/mp4" and (folder / "clip.mp4").is_file()
    assert not (folder / "thumb.webp").exists()
    assert written.snapshot.params == {"duration": 5, "frame_mode": "first"}




@pytest.mark.parametrize(
    "setup",
    ["character_namespace", "pending", "failed", "index_out_of_range", "text_kind", "audio_kind"],
)
def test_share_job_rejects_unshareable(isolated_data_root, mount, setup):
    output = [("1.png", _png((5, 5, 5)))]
    output_index = 0
    if setup == "character_namespace":
        job = _studio_job(outputs=output, namespace="character")
    elif setup == "pending":
        job = _studio_job(outputs=output, status=JobStatus.PENDING)
    elif setup == "failed":
        job = _studio_job(outputs=output, status=JobStatus.FAILED)
    elif setup == "index_out_of_range":
        job = _studio_job(outputs=output)
        output_index = 1
    elif setup == "text_kind":
        job = _studio_job(outputs=[("1.txt", b"hello")], kind=JobKind.TEXT)
    else:
        job = _studio_job(outputs=[("1.mp3", _FAKE_MP3)], kind=JobKind.AUDIO)

    with pytest.raises(TeamShareError) as caught:
        share_job_output(
            mount, job_id=job.job_id, output_index=output_index, title="t", tags=[],
            author=_AUTHOR,
        )
    assert caught.value.code == "not_shareable"
    assert not (Path(mount.mount_path) / "shared").exists()


def test_share_job_partial_is_allowed(isolated_data_root, mount):
    job = _studio_job(outputs=[("1.png", _png((6, 6, 6)))], status=JobStatus.PARTIAL)
    written = share_job_output(
        mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
    )
    assert written.kind == "generation"


def test_share_job_missing_reference_is_source_missing(isolated_data_root, mount):
    ref = _write_upload(isolated_data_root, "gone.png", _png((7, 7, 7)))
    job = _studio_job(outputs=[("1.png", _png((8, 8, 8)))], params={"reference_images": [str(ref)]})
    ref.unlink()
    with pytest.raises(TeamShareError) as caught:
        share_job_output(
            mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
        )
    assert caught.value.code == "source_missing"


def test_share_job_missing_output_is_source_missing(isolated_data_root, mount):
    job = _studio_job(outputs=[("1.png", _png((8, 8, 8)))])
    Path(job.output_paths[0]).unlink()
    with pytest.raises(TeamShareError) as caught:
        share_job_output(
            mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
        )
    assert caught.value.code == "source_missing"


@pytest.mark.parametrize("job_id", ["job-does-not-exist", "../jobs/evil"])
def test_share_job_unknown_job_is_not_found(isolated_data_root, mount, job_id):
    with pytest.raises(TeamShareNotFound):
        share_job_output(mount, job_id=job_id, output_index=0, title="t", tags=[], author=_AUTHOR)


def test_share_job_refs_over_limit_needs_allow_large(isolated_data_root, mount, monkeypatch):
    ref_body = _png((11, 11, 11))
    ref = _write_upload(isolated_data_root, "big.png", ref_body)
    job = _studio_job(outputs=[("1.png", _png((12, 12, 12)))], params={"reference_images": [str(ref)]})
    monkeypatch.setattr(share, "LARGE_REFS_BYTES", 10)

    with pytest.raises(TeamShareTooLarge) as caught:
        share_job_output(
            mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
        )
    assert caught.value.bytes == len(ref_body)
    assert not (Path(mount.mount_path) / "shared").exists()

    written = share_job_output(
        mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR,
        allow_large=True,
    )
    assert len(written.snapshot.inputs) == 1


def test_failed_final_rename_leaves_no_directories(isolated_data_root, mount, monkeypatch):
    job = _studio_job(outputs=[("1.png", _png((13, 13, 13)))])
    real_replace = os.replace

    def fail_final(src, dst):
        if Path(dst).name.startswith("ta_"):
            raise OSError("disk full")
        return real_replace(src, dst)

    monkeypatch.setattr(share.os, "replace", fail_final)
    with pytest.raises(OSError, match="disk full"):
        share_job_output(
            mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
        )
    author_root = Path(mount.mount_path) / "shared" / author_dir_name(_AUTHOR)
    assert list(author_root.iterdir()) == []


# ------------------------------------------------------------ creation_asset


def test_share_media_creation_asset(isolated_data_root, mount):
    body = _png((20, 20, 20), size=(900, 900))
    asset = create_media_asset_from_bytes(
        title="董卓", body=body, filename="dongzhuo.png", mime_type="image/png", tags=["皮肤"]
    )
    written = share_creation_asset(
        mount, asset_id=asset.asset_id, title="董卓 绿", tags=["皮肤"], author=_AUTHOR
    )
    folder = _asset_dir(mount, written.asset_id)
    assert _read_asset(mount, written.asset_id) == written
    assert written.kind == "media" and written.snapshot is None and written.prompt is None
    assert written.media.filename == "dongzhuo.png" and written.media.sha256 == _sha(body)
    assert (folder / "dongzhuo.png").read_bytes() == body
    with Image.open(folder / "thumb.webp") as thumb:
        assert max(thumb.size) <= 512


def test_share_media_named_like_reserved_file_keeps_both(isolated_data_root, mount):
    buffer = io.BytesIO()
    Image.new("RGB", (4, 4), (1, 2, 3)).save(buffer, format="WEBP")
    body = buffer.getvalue()
    asset = create_media_asset_from_bytes(
        title="x", body=body, filename="thumb.webp", mime_type="image/webp", tags=[]
    )
    written = share_creation_asset(mount, asset_id=asset.asset_id, title="x", tags=[], author=_AUTHOR)
    folder = _asset_dir(mount, written.asset_id)
    assert written.media.filename != "thumb.webp"
    assert (folder / written.media.filename).read_bytes() == body
    assert (folder / "thumb.webp").is_file()


def test_share_prompt_creation_asset(isolated_data_root, mount):
    asset = create_prompt_asset(
        "城墙",
        [
            {"kind": "text", "text": "一只"},
            {"kind": "variable", "name": "颜色", "default_value": "红色"},
            {"kind": "text", "text": "的猫"},
        ],
        ["猫"],
    )
    written = share_creation_asset(
        mount, asset_id=asset.asset_id, title="城墙", tags=["猫"], author=_AUTHOR
    )
    folder = _asset_dir(mount, written.asset_id)
    assert _read_asset(mount, written.asset_id) == written
    assert written.kind == "prompt" and written.media is None
    assert [s.kind for s in written.prompt.segments] == ["text", "variable", "text"]
    assert sorted(p.name for p in folder.iterdir()) == ["asset.json"]


def test_share_generation_creation_asset_copies_refs_from_blobs(isolated_data_root, mount):
    ref_body, mask_body = _png((30, 30, 30)), _png((255, 255, 255))
    output = store_media_blob(_png((40, 40, 40)), "cat.png", "image/png")
    ref = store_media_blob(ref_body, "ref.png", "image/png")
    mask = store_media_blob(mask_body, "mask.png", "image/png")
    snapshot = GenerationRecipe(
        mode="image", model="gpt-image-2", provider="tuzi", alias=None,
        final_prompt="猫", draft_prompt="猫草稿", params={"size": "1024x1024", "warnings": ["x"]},
        inputs=[
            RecipeInput(order=0, role="reference", kind="image", sha256=ref.sha256,
                        mime_type="image/png"),
            RecipeInput(order=1, role="mask", kind="image", sha256=mask.sha256,
                        mime_type="image/png"),
        ],
        cost_cny=0.5, cost_basis="estimated", submitted_at="2026-09-23T00:00:00Z",
    )
    asset = create_generation_asset(title="猫", tags=[], media=output, snapshot=snapshot)

    written = share_creation_asset(mount, asset_id=asset.asset_id, title="猫", tags=[], author=_AUTHOR)

    folder = _asset_dir(mount, written.asset_id)
    assert _read_asset(mount, written.asset_id) == written
    assert written.kind == "generation" and written.origin is None
    assert written.snapshot.draft_prompt == "猫草稿"
    assert written.snapshot.params == {"size": "1024x1024"}
    assert written.snapshot.cost_cny == 0.5 and written.snapshot.cost_basis == "estimated"
    assert [r.role for r in written.snapshot.inputs] == ["reference", "mask"]
    for row, body in zip(written.snapshot.inputs, [ref_body, mask_body]):
        assert re.fullmatch(TEAM_RECIPE_INPUT_PATH_PATTERN, row.path)
        assert (folder / row.path).read_bytes() == body
    assert (folder / "cat.png").is_file() and (folder / "thumb.webp").is_file()


def test_share_unknown_creation_asset_is_not_found(isolated_data_root, mount):
    with pytest.raises(TeamShareNotFound):
        share_creation_asset(mount, asset_id="creation-asset-nope", title="t", tags=[], author=_AUTHOR)


# ---------------------------------------------------------- update / withdraw


def _shared(mount) -> TeamAssetFile:
    asset = create_prompt_asset("t", [{"kind": "text", "text": "x"}], [])
    return share_creation_asset(mount, asset_id=asset.asset_id, title="旧名", tags=["a"], author=_AUTHOR)


def test_author_updates_title_and_tags(isolated_data_root, mount):
    original = _shared(mount)
    updated = update_shared_asset(
        mount, asset_id=original.asset_id, title=" 新名 ", tags=["b", "b"], author=_AUTHOR
    )
    assert updated.title == "新名" and updated.tags == ["b"]
    assert updated.updated_at > original.updated_at and updated.shared_at == original.shared_at
    assert _read_asset(mount, original.asset_id) == updated
    assert updated.prompt == original.prompt


def test_update_by_other_author_is_forbidden(isolated_data_root, mount):
    original = _shared(mount)
    with pytest.raises(TeamShareForbidden):
        update_shared_asset(mount, asset_id=original.asset_id, title="x", tags=[], author="小李")
    assert _read_asset(mount, original.asset_id).title == "旧名"


@pytest.mark.parametrize("asset_id", ["ta_01ARZ3NDEKTSV4RRFFQ69G5FAV", "../../etc"])
def test_update_and_withdraw_unknown_asset_is_not_found(isolated_data_root, mount, asset_id):
    _shared(mount)
    with pytest.raises(TeamShareNotFound):
        update_shared_asset(mount, asset_id=asset_id, title="x", tags=[], author=_AUTHOR)
    with pytest.raises(TeamShareNotFound):
        withdraw_shared_asset(mount, asset_id=asset_id, author=_AUTHOR)


def test_author_withdraws_asset(isolated_data_root, mount):
    original = _shared(mount)
    withdraw_shared_asset(mount, asset_id=original.asset_id, author=_AUTHOR)
    author_root = _asset_dir(mount, original.asset_id).parent
    assert list(author_root.iterdir()) == []


def test_withdraw_by_other_author_is_forbidden(isolated_data_root, mount):
    original = _shared(mount)
    with pytest.raises(TeamShareForbidden):
        withdraw_shared_asset(mount, asset_id=original.asset_id, author="小李")
    assert _asset_dir(mount, original.asset_id).is_dir()


# -------------------------------------------------------------- author_dir_name


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("老王", "老王"),
        ("a/b\\c:*", "a-b-c"),
        ("", "author"),
        ("///", "author"),
        ("x" * 80, "x" * 60),
        ("Ｌao wang", "Ｌao-wang"),
    ],
)
def test_author_dir_name(name, expected):
    assert author_dir_name(name) == expected


def test_author_dir_name_has_no_separators():
    assert not set(author_dir_name("a/b\\c:*")) & {"/", "\\", ":", "*"}


def test_author_dir_name_normalizes_to_nfc():
    decomposed = "é"
    assert author_dir_name(decomposed) == "é"


# ================================================================ fix round 1


def _index_entry(mount, asset_id):
    return next(e for e in scan_and_cache(mount).entries if e.id == asset_id)


# ---------------------------------------------------- C1 参考路径的最后一道闸


@pytest.mark.parametrize(
    "where", ["outside", "relative_escape", "config", "runtime_jobs", "runtime_root", "symlink_out"]
)
def test_share_job_rejects_reference_outside_allowed_dirs(
    isolated_data_root, mount, tmp_path, where
):
    body = _png((60, 60, 60))
    outside = tmp_path / "outside.png"
    outside.write_bytes(body)
    if where == "outside":
        value = str(outside)
    elif where == "relative_escape":
        value = "../outside.png"
    elif where == "config":
        ref = isolated_data_root / ".config" / "secret.png"
        ref.write_bytes(body)
        value = str(ref)
    elif where == "runtime_jobs":
        ref = isolated_data_root / ".runtime" / "jobs" / "x.png"
        ref.parent.mkdir(parents=True, exist_ok=True)
        ref.write_bytes(body)
        value = str(ref)
    elif where == "runtime_root":
        ref = isolated_data_root / ".runtime" / "x.png"
        ref.write_bytes(body)
        value = ".runtime/x.png"
    else:
        link = isolated_data_root / ".runtime" / "uploads" / "link.png"
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(outside)
        value = str(link)
    job = _studio_job(outputs=[("1.png", _png((61, 61, 61)))], params={"reference_images": [value]})

    with pytest.raises(TeamShareError) as caught:
        share_job_output(
            mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
        )
    assert caught.value.code == "not_shareable"
    assert not (Path(mount.mount_path) / "shared").exists()


def test_share_job_accepts_reference_from_uploads_and_studio_outputs(isolated_data_root, mount):
    upload_body, studio_body = _png((62, 62, 62)), _png((63, 63, 63))
    upload = _write_upload(isolated_data_root, "u.png", upload_body)
    earlier = studio_output_dir(new_job_id()) / "1.png"
    earlier.write_bytes(studio_body)
    job = _studio_job(
        outputs=[("1.png", _png((64, 64, 64)))],
        params={"reference_images": [str(upload), str(earlier)]},
    )
    written = share_job_output(
        mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
    )
    assert [r.sha256 for r in written.snapshot.inputs] == [_sha(upload_body), _sha(studio_body)]


# ------------------------------------------------ I1 分享 → 索引 → 采用 端到端


def test_shared_job_output_round_trips_through_index_and_adoption(isolated_data_root, mount):
    ref_a, ref_b = _png((70, 0, 0)), _png((0, 70, 0))
    path_a = _write_upload(isolated_data_root, "ra.png", ref_a)
    path_b = _write_upload(isolated_data_root, "rb.png", ref_b)
    job = _studio_job(
        outputs=[("1.png", _png((71, 71, 71)))],
        params={"reference_images": [str(path_a)], "mask_image": str(path_b),
                "actual_cost_cny": 0.21},
    )
    written = share_job_output(
        mount, job_id=job.job_id, output_index=0, title="红猫", tags=["猫"], author=_AUTHOR
    )

    entry = _index_entry(mount, written.asset_id)
    assert entry.status == "ready" and entry.kind == "generation" and entry.author == _AUTHOR
    assert entry.model == "gpt-image-2" and entry.cost_cny == 0.21

    adopted, created = adopt_team_asset(mount=mount, entry=entry, project_id="canvas-p1")
    assert created and adopted.kind == "generation"
    for order, body in enumerate([ref_a, ref_b]):
        path, _mime = creation_asset_input_path(adopted.asset_id, order)
        assert path.read_bytes() == body


def test_adopted_generation_asset_can_be_shared_again(isolated_data_root, mount):
    ref_body = _png((80, 0, 80))
    ref = _write_upload(isolated_data_root, "r.png", ref_body)
    job = _studio_job(
        outputs=[("1.png", _png((81, 81, 81)))],
        params={"reference_images": [str(ref)], "estimated_cost_cny": 0.4},
    )
    first = share_job_output(
        mount, job_id=job.job_id, output_index=0, title="紫", tags=[], author=_AUTHOR
    )
    adopted, _ = adopt_team_asset(
        mount=mount, entry=_index_entry(mount, first.asset_id), project_id="canvas-p1"
    )

    again = share_creation_asset(
        mount, asset_id=adopted.asset_id, title="紫 改", tags=[], author="小李"
    )

    entry = _index_entry(mount, again.asset_id)
    assert entry.status == "ready" and entry.author == "小李"
    assert entry.model == "gpt-image-2" and entry.cost_cny == 0.4
    assert again.snapshot.cost_basis == "estimated"
    assert [r.sha256 for r in again.snapshot.inputs] == [r.sha256 for r in first.snapshot.inputs]
    folder = Path(mount.mount_path) / "shared" / "小李" / again.asset_id
    assert (folder / again.snapshot.inputs[0].path).read_bytes() == ref_body
    readopted, created = adopt_team_asset(mount=mount, entry=entry, project_id="canvas-p1")
    assert created
    path, _mime = creation_asset_input_path(readopted.asset_id, 0)
    assert path.read_bytes() == ref_body


# ------------------------------------------- I2 编辑 / 撤回只认本人目录


def _foreign_copy(mount, asset_id: str, author: str = "小李") -> Path:
    folder = Path(mount.mount_path) / "shared" / author / asset_id
    folder.mkdir(parents=True)
    (folder / "asset.json").write_text(json.dumps({
        "team_asset_version": 1, "asset_id": asset_id, "kind": "prompt", "title": "别人的",
        "tags": [], "author": {"display_name": author}, "shared_at": "2026-09-23T00:00:00Z",
        "updated_at": "2026-09-23T00:00:00Z",
        "prompt": {"kind": "prompt", "segments": [{"kind": "text", "text": "x"}]},
    }, ensure_ascii=False), encoding="utf-8")
    return folder


def test_asset_only_in_other_author_dir_is_forbidden(isolated_data_root, mount):
    asset_id = "ta_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    foreign = _foreign_copy(mount, asset_id)
    before = (foreign / "asset.json").read_text(encoding="utf-8")
    with pytest.raises(TeamShareForbidden):
        update_shared_asset(mount, asset_id=asset_id, title="抢", tags=[], author=_AUTHOR)
    with pytest.raises(TeamShareForbidden):
        withdraw_shared_asset(mount, asset_id=asset_id, author=_AUTHOR)
    assert (foreign / "asset.json").read_text(encoding="utf-8") == before


def test_update_and_withdraw_touch_only_own_copy_when_other_dir_has_same_id(
    isolated_data_root, mount
):
    own = _shared(mount)
    foreign = _foreign_copy(mount, own.asset_id)
    before = (foreign / "asset.json").read_text(encoding="utf-8")

    updated = update_shared_asset(mount, asset_id=own.asset_id, title="新", tags=[], author=_AUTHOR)
    assert updated.title == "新" and _read_asset(mount, own.asset_id).title == "新"
    withdraw_shared_asset(mount, asset_id=own.asset_id, author=_AUTHOR)

    assert not _asset_dir(mount, own.asset_id).exists()
    assert (foreign / "asset.json").read_text(encoding="utf-8") == before


def test_symlinked_asset_dir_is_rejected(isolated_data_root, mount, tmp_path):
    asset_id = "ta_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    target = _foreign_copy(
        TeamLibraryMount(**{**mount.model_dump(), "mount_path": str(tmp_path / "elsewhere")}),
        asset_id, author=_AUTHOR,
    )
    own_root = Path(mount.mount_path) / "shared" / author_dir_name(_AUTHOR)
    own_root.mkdir(parents=True)
    (own_root / asset_id).symlink_to(target, target_is_directory=True)
    before = (target / "asset.json").read_text(encoding="utf-8")

    with pytest.raises(TeamShareForbidden):
        update_shared_asset(mount, asset_id=asset_id, title="改", tags=[], author=_AUTHOR)
    with pytest.raises(TeamShareForbidden):
        withdraw_shared_asset(mount, asset_id=asset_id, author=_AUTHOR)
    assert (target / "asset.json").read_text(encoding="utf-8") == before


# ------------------------------------------------------ I3 params 白名单


def test_unknown_param_keys_never_reach_snapshot(isolated_data_root, mount):
    job = _studio_job(
        outputs=[("1.png", _png((90, 90, 90)))],
        params={"size": "1024x1024", "seed": 42, "legacy_ref": "/etc/passwd",
                "mj_sw": 100},
    )
    written = share_job_output(
        mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
    )
    assert written.snapshot.params == {"size": "1024x1024", "seed": 42, "mj_sw": 100}
    assert RECIPE_PARAM_ALLOW.isdisjoint(RECIPE_PARAM_EXCLUDE)


def test_generation_asset_share_drops_unknown_param_keys(isolated_data_root, mount):
    output = store_media_blob(_png((91, 91, 91)), "o.png", "image/png")
    snapshot = GenerationRecipe(
        mode="image", model="m", final_prompt="p", params={"size": "1x1", "legacy_ref": "/x"},
        submitted_at="2026-09-23T00:00:00Z",
    )
    asset = create_generation_asset(title="g", tags=[], media=output, snapshot=snapshot)
    written = share_creation_asset(mount, asset_id=asset.asset_id, title="g", tags=[], author=_AUTHOR)
    assert written.snapshot.params == {"size": "1x1"}


# --------------------------------------------- M1 元数据先校验、不建目录


@pytest.mark.parametrize(
    ("title", "tags", "author"),
    [
        ("   ", [], _AUTHOR),
        ("x" * 121, [], _AUTHOR),
        ("t", [f"t{i}" for i in range(21)], _AUTHOR),
        ("t", ["x" * 41], _AUTHOR),
        ("t", [], ""),
        ("t", [], "   "),
        ("t", [], "x" * 41),
    ],
)
def test_invalid_metadata_fails_before_any_io(
    isolated_data_root, mount, monkeypatch, title, tags, author
):
    ref = _write_upload(isolated_data_root, "r.png", _png((95, 95, 95)))
    job = _studio_job(outputs=[("1.png", _png((96, 96, 96)))], params={"reference_images": [str(ref)]})
    monkeypatch.setattr(share, "LARGE_REFS_BYTES", 1)
    prompt = create_prompt_asset("p", [{"kind": "text", "text": "x"}], [])

    for call in (
        lambda: share_job_output(mount, job_id=job.job_id, output_index=0, title=title,
                                 tags=tags, author=author),
        lambda: share_job_output(mount, job_id="job-missing", output_index=0, title=title,
                                 tags=tags, author=author),
        lambda: share_creation_asset(mount, asset_id=prompt.asset_id, title=title, tags=tags,
                                     author=author),
    ):
        with pytest.raises(ValueError) as caught:
            call()
        assert not isinstance(caught.value, (TeamShareTooLarge, TeamShareError))
    assert not (Path(mount.mount_path) / "shared").exists()


def test_invalid_update_metadata_leaves_file_untouched(isolated_data_root, mount):
    original = _shared(mount)
    before = (_asset_dir(mount, original.asset_id) / "asset.json").read_text(encoding="utf-8")
    with pytest.raises(ValueError):
        update_shared_asset(mount, asset_id=original.asset_id, title="x" * 121, tags=[],
                            author=_AUTHOR)
    after = (_asset_dir(mount, original.asset_id) / "asset.json").read_text(encoding="utf-8")
    assert after == before


# ------------------------------------------------ M2 编辑保留未知字段


def test_update_preserves_unknown_fields(isolated_data_root, mount):
    original = _shared(mount)
    manifest = _asset_dir(mount, original.asset_id) / "asset.json"
    raw = json.loads(manifest.read_text(encoding="utf-8"))
    raw["future_field"] = {"from": "新版本"}
    raw["prompt"]["future_segment_meta"] = 1
    manifest.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")

    update_shared_asset(mount, asset_id=original.asset_id, title="新", tags=["b"], author=_AUTHOR)

    saved = json.loads(manifest.read_text(encoding="utf-8"))
    assert saved["future_field"] == {"from": "新版本"}
    assert saved["prompt"]["future_segment_meta"] == 1
    assert saved["title"] == "新" and saved["tags"] == ["b"]
    assert saved["updated_at"] != raw["updated_at"] and saved["shared_at"] == raw["shared_at"]


# ------------------------------------------- M3 撤回后清理失败不抛


def test_withdraw_succeeds_when_cleanup_fails(isolated_data_root, mount, monkeypatch, caplog):
    original = _shared(mount)

    def fail_rmtree(path, *args, **kwargs):
        if kwargs.get("ignore_errors"):
            return None
        raise OSError("busy")

    monkeypatch.setattr(share.shutil, "rmtree", fail_rmtree)
    with caplog.at_level("WARNING", logger=share.__name__):
        withdraw_shared_asset(mount, asset_id=original.asset_id, author=_AUTHOR)
    assert not _asset_dir(mount, original.asset_id).exists()
    assert (_asset_dir(mount, original.asset_id).parent / f".tmp-del-{original.asset_id}").is_dir()
    assert any("清理" in record.message for record in caplog.records)
    entries = [e for e in scan_and_cache(mount).entries if e.id == original.asset_id]
    assert entries == []


# ---------------------------------------------------------- M5 补测


def test_all_seven_reference_fields_keep_their_order(isolated_data_root, mount):
    bodies = {name: _png((i * 20, 0, 0)) for i, name in enumerate("abcdefg", start=1)}
    paths = {name: _write_upload(isolated_data_root, f"{name}.png", body)
             for name, body in bodies.items()}
    video = _write_upload(isolated_data_root, "v.mp4", _FAKE_MP4)
    audio = _write_upload(isolated_data_root, "a.mp3", _FAKE_MP3)
    job = _studio_job(
        outputs=[("1.png", _png((1, 2, 3)))],
        params={
            "mj_oref": [str(paths["g"])],
            "mj_cref": [str(paths["f"])],
            "mj_sref": [str(paths["e"])],
            "mask_image": str(paths["d"]),
            "reference_audios": [str(audio)],
            "reference_videos": [str(video)],
            "reference_images": [str(paths["a"]), str(paths["b"])],
        },
    )
    written = share_job_output(
        mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
    )
    inputs = written.snapshot.inputs
    assert [r.order for r in inputs] == list(range(8))
    assert [(r.role, r.kind) for r in inputs] == [
        ("reference", "image"), ("reference", "image"), ("reference", "video"),
        ("reference", "audio"), ("mask", "image"), ("mj_sref", "image"),
        ("mj_cref", "image"), ("mj_oref", "image"),
    ]
    expected = [bodies["a"], bodies["b"], _FAKE_MP4, _FAKE_MP3,
                bodies["d"], bodies["e"], bodies["f"], bodies["g"]]
    assert [r.sha256 for r in inputs] == [_sha(body) for body in expected]


def test_media_asset_blob_missing_is_source_missing(isolated_data_root, mount):
    asset = create_media_asset_from_bytes(
        title="m", body=_png((100, 1, 1)), filename="m.png", mime_type="image/png", tags=[]
    )
    blob_path_for(asset.content.sha256, asset.content.mime_type).unlink()
    with pytest.raises(TeamShareError) as caught:
        share_creation_asset(mount, asset_id=asset.asset_id, title="m", tags=[], author=_AUTHOR)
    assert caught.value.code == "source_missing"
    assert not (Path(mount.mount_path) / "shared").exists()


@pytest.mark.parametrize("missing", ["output", "reference"])
def test_generation_asset_blob_missing_is_source_missing(isolated_data_root, mount, missing):
    output = store_media_blob(_png((101, 1, 1)), "o.png", "image/png")
    ref = store_media_blob(_png((102, 1, 1)), "r.png", "image/png")
    snapshot = GenerationRecipe(
        mode="image", model="m", final_prompt="p", submitted_at="2026-09-23T00:00:00Z",
        inputs=[RecipeInput(order=0, role="reference", kind="image", sha256=ref.sha256,
                            mime_type="image/png")],
    )
    asset = create_generation_asset(title="g", tags=[], media=output, snapshot=snapshot)
    gone = output if missing == "output" else ref
    blob_path_for(gone.sha256, gone.mime_type).unlink()
    with pytest.raises(TeamShareError) as caught:
        share_creation_asset(mount, asset_id=asset.asset_id, title="g", tags=[], author=_AUTHOR)
    assert caught.value.code == "source_missing"
    assert not (Path(mount.mount_path) / "shared").exists()


def test_copy_failure_mid_stage_cleans_tmp(isolated_data_root, mount, monkeypatch):
    refs = [_write_upload(isolated_data_root, f"r{i}.png", _png((110 + i, 0, 0))) for i in range(3)]
    job = _studio_job(
        outputs=[("1.png", _png((120, 0, 0)))],
        params={"reference_images": [str(path) for path in refs]},
    )
    real_copy = share._copy_hashed
    calls = {"n": 0}

    def flaky_copy(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 3:
            raise OSError("io error")
        return real_copy(*args, **kwargs)

    monkeypatch.setattr(share, "_copy_hashed", flaky_copy)
    with pytest.raises(OSError, match="io error"):
        share_job_output(
            mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
        )
    author_root = Path(mount.mount_path) / "shared" / author_dir_name(_AUTHOR)
    assert list(author_root.iterdir()) == []


# ------------------------------------------------------ M6 成片文件名


@pytest.mark.parametrize(
    "name", ["CON.png", "nul", "com1.tar.png", "Aux .png", "LPT9.JPG", "prn"],
)
def test_media_filename_avoids_windows_reserved_names(name):
    cleaned = share._media_filename(name)
    stem = cleaned.split(".", 1)[0].rstrip(" ").upper()
    assert stem not in {"CON", "PRN", "AUX", "NUL", "COM1", "LPT9"}
    assert cleaned.endswith(Path(name).suffix)


def test_media_filename_keeps_ordinary_names():
    assert share._media_filename("console.png") == "console.png"
    assert share._media_filename("董卓.png") == "董卓.png"


def test_media_filename_truncates_to_255_utf8_bytes_keeping_extension():
    cleaned = share._media_filename("猫" * 100 + ".png")
    assert len(cleaned.encode("utf-8")) <= 255
    assert cleaned.endswith(".png") and cleaned.startswith("猫")


def test_share_media_with_long_name_writes_truncated_file(isolated_data_root, mount):
    body = _png((130, 0, 0))
    asset = create_media_asset_from_bytes(
        title="长", body=body, filename="猫" * 100 + ".png", mime_type="image/png", tags=[]
    )
    written = share_creation_asset(mount, asset_id=asset.asset_id, title="长", tags=[], author=_AUTHOR)
    assert len(written.media.filename.encode("utf-8")) <= 255
    assert (_asset_dir(mount, written.asset_id) / written.media.filename).read_bytes() == body


# ------------------------------------------- 终审 M1 按内容定类型（后缀会撒谎）


def test_jpeg_bytes_named_png_share_with_real_type_and_round_trip(isolated_data_root, mount):
    """本机大量 .png 实为 JPEG：分享按内容写 mime 与后缀，别人才采用 / 复刻得了。"""
    output, ref = _image((90, 10, 10), "JPEG"), _image((10, 90, 10), "JPEG")
    ref_path = _write_upload(isolated_data_root, "ref.png", ref)
    job = _studio_job(outputs=[("v1.png", output)], params={"reference_images": [str(ref_path)]})

    written = share_job_output(
        mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
    )

    folder = _asset_dir(mount, written.asset_id)
    parsed = _read_asset(mount, written.asset_id)
    assert parsed.media.mime_type == "image/jpeg" and parsed.media.filename == "v1.jpg"
    assert (folder / "v1.jpg").read_bytes() == output and not (folder / "v1.png").exists()
    [row] = parsed.snapshot.inputs
    assert row.mime_type == "image/jpeg" and row.path.endswith(".jpg")
    assert (folder / row.path).read_bytes() == ref

    entry = _index_entry(mount, written.asset_id)
    assert entry.status == "ready" and entry.mime_type == "image/jpeg"
    adopted, created = adopt_team_asset(mount=mount, entry=entry, project_id="canvas-p1")
    assert created
    path, mime = creation_asset_input_path(adopted.asset_id, 0)
    assert path.read_bytes() == ref and mime == "image/jpeg"
    assert adopted.content.media.mime_type == "image/jpeg"
    assert (isolated_data_root / adopted.content.media.path).read_bytes() == output


def test_jpeg_bytes_named_png_media_asset_shares_as_jpeg(isolated_data_root, mount):
    body = _image((91, 11, 11), "JPEG")
    asset = create_media_asset_from_bytes(
        title="x", body=body, filename="skin.png", mime_type=None, tags=[]
    )
    written = share_creation_asset(mount, asset_id=asset.asset_id, title="x", tags=[], author=_AUTHOR)
    assert written.media.mime_type == "image/jpeg" and written.media.filename == "skin.jpg"
    entry = _index_entry(mount, written.asset_id)
    assert entry.status == "ready"
    adopted, created = adopt_team_asset(mount=mount, entry=entry, project_id=None)
    assert created and (isolated_data_root / adopted.content.path).read_bytes() == body


@pytest.mark.parametrize(
    ("name", "body", "expected"),
    [
        ("a.png", _image((1, 1, 1), "JPEG"), "image/jpeg"),
        ("a.jpeg", _image((1, 1, 1), "JPEG"), "image/jpeg"),
        ("a.webp", _image((1, 1, 1), "PNG"), "image/png"),
        ("a.png", b"not-an-image", "image/png"),  # 嗅不出：信后缀
        ("voice.m4a", _FAKE_MP4, "audio/mp4"),  # ftyp 普通 brand：信 .m4a 声明
        ("clip.mp4", _FAKE_MP4, "video/mp4"),
    ],
    ids=["jpeg-as-png", "jpeg-ext", "png-as-webp", "unsniffable", "m4a-mp42", "mp4"],
)
def test_mime_for_sniffs_content_before_suffix(tmp_path, name, body, expected):
    path = tmp_path / name
    path.write_bytes(body)
    assert share._mime_for(path) == expected


@pytest.mark.parametrize("name", ["notes.txt", "noext"])
def test_mime_for_unsniffable_unknown_suffix_is_not_shareable(tmp_path, name):
    path = tmp_path / name
    path.write_bytes(b"plain text")
    with pytest.raises(TeamShareError) as caught:
        share._mime_for(path)
    assert caught.value.code == "not_shareable"


def test_mime_for_rejects_sniffed_type_outside_media_suffixes(tmp_path, monkeypatch):
    path = tmp_path / "a.png"
    path.write_bytes(_png((2, 2, 2)))
    monkeypatch.setattr(
        generation_recipe, "sniff_media_mime", lambda _head, _declared=None: "image/bmp"
    )
    with pytest.raises(TeamShareError) as caught:
        share._mime_for(path)
    assert caught.value.code == "not_shareable"


def test_mime_for_real_type_ignores_misleading_suffix_even_when_unsupported(tmp_path):
    path = tmp_path / "shot.bmp"
    path.write_bytes(_image((3, 3, 3), "JPEG"))
    assert share._mime_for(path) == "image/jpeg"


@pytest.mark.parametrize(
    ("name", "mime", "expected"),
    [
        ("v1.png", "image/jpeg", "v1.jpg"),
        ("v1.jpeg", "image/jpeg", "v1.jpeg"),
        ("v1.PNG", "image/png", "v1.PNG"),
        ("clip", "video/mp4", "clip.mp4"),
        ("a.b.png", "image/webp", "a.b.webp"),
    ],
)
def test_typed_filename_keeps_stem_and_follows_real_type(name, mime, expected):
    assert share._typed_filename(name, mime) == expected


# ------------------------------------------------------------ canvas_result


def test_share_canvas_result_writes_p2_layout_with_canvas_origin(isolated_data_root, mount):
    from tests.test_generation_recipe import canvas_run_with_inputs, result_version

    ref_a, ref_b, output = _png((5, 0, 0)), _image((0, 5, 0), "JPEG"), _png((0, 0, 5))
    pid, job, _document = canvas_run_with_inputs(ref_a, ref_b, output)
    node_id, version_id = result_version(job)

    written = share_canvas_result(
        mount, canvas_project_id=pid, node_id=node_id, version_id=version_id,
        title=" 纸雕狐狸 ", tags=["狐"], author=_AUTHOR,
    )

    folder = _asset_dir(mount, written.asset_id)
    parsed = _read_asset(mount, written.asset_id)
    assert parsed == written
    assert parsed.kind == "generation" and parsed.title == "纸雕狐狸"
    assert parsed.origin is not None
    assert parsed.origin.canvas_project_id == pid and parsed.origin.job_id == job.job_id
    assert parsed.media is not None and parsed.media.sha256 == _sha(output)
    assert (folder / parsed.media.filename).read_bytes() == output
    snapshot = parsed.snapshot
    assert snapshot is not None and snapshot.model == "gpt-image-1"
    assert snapshot.final_prompt.startswith("一只纸雕狐狸")
    assert "参考素材编号" not in snapshot.final_prompt
    assert "creation_asset_source_title" not in snapshot.params
    assert [(r.order, r.role, r.sha256) for r in snapshot.inputs] == [
        (0, "reference", _sha(ref_a)), (1, "reference", _sha(ref_b)),
    ]
    for row in snapshot.inputs:
        assert re.fullmatch(TEAM_RECIPE_INPUT_PATH_PATTERN, row.path)
        assert _sha((folder / row.path).read_bytes()) == row.sha256
    assert sorted(p.name for p in folder.iterdir()) == sorted(
        [parsed.media.filename, "asset.json", "refs", "thumb.webp"]
    )
    raw = json.loads((folder / "asset.json").read_text(encoding="utf-8"))
    assert raw["origin"] == {"job_id": job.job_id, "canvas_project_id": pid}

    entry = _index_entry(mount, written.asset_id)
    assert entry.status == "ready" and entry.kind == "generation"


def test_share_canvas_result_maps_recipe_errors(isolated_data_root, mount):
    from tests.test_generation_recipe import canvas_run_with_inputs, result_version

    pid, job, document = canvas_run_with_inputs(_png((6, 0, 0)), _png((0, 6, 0)), _png((0, 0, 6)))
    node_id, version_id = result_version(job)
    upload_version = next(n for n in document.nodes if n.id == "image-a").data.current_version_id

    with pytest.raises(TeamShareError) as caught:
        share_canvas_result(
            mount, canvas_project_id=pid, node_id="image-a", version_id=upload_version,
            title="t", tags=[], author=_AUTHOR,
        )
    assert caught.value.code == "not_shareable"
    with pytest.raises(TeamShareNotFound):
        share_canvas_result(
            mount, canvas_project_id=pid, node_id="image-a", version_id=version_id,
            title="t", tags=[], author=_AUTHOR,
        )
    with pytest.raises(ValueError):
        share_canvas_result(
            mount, canvas_project_id=pid, node_id=node_id, version_id=version_id,
            title="  ", tags=[], author=_AUTHOR,
        )
    assert not (Path(mount.mount_path) / "shared").exists()


def test_share_canvas_result_large_refs_need_allow_large(isolated_data_root, mount, monkeypatch):
    from tests.test_generation_recipe import canvas_run_with_inputs, result_version

    pid, job, _document = canvas_run_with_inputs(_png((7, 0, 0)), _png((0, 7, 0)), _png((0, 0, 7)))
    node_id, version_id = result_version(job)
    monkeypatch.setattr(share, "LARGE_REFS_BYTES", 1)
    with pytest.raises(TeamShareTooLarge):
        share_canvas_result(
            mount, canvas_project_id=pid, node_id=node_id, version_id=version_id,
            title="t", tags=[], author=_AUTHOR,
        )
    written = share_canvas_result(
        mount, canvas_project_id=pid, node_id=node_id, version_id=version_id,
        title="t", tags=[], author=_AUTHOR, allow_large=True,
    )
    assert len(written.snapshot.inputs) == 2
