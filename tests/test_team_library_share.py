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

from character_workflow.lib import team_library_share as share
from character_workflow.lib.creation_assets import (
    create_generation_asset,
    create_media_asset_from_bytes,
    create_prompt_asset,
    store_media_blob,
)
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
from character_workflow.lib.team_library_index import scan_library
from character_workflow.lib.team_library_share import (
    RECIPE_PARAM_EXCLUDE,
    TeamShareError,
    TeamShareForbidden,
    TeamShareNotFound,
    TeamShareTooLarge,
    author_dir_name,
    share_creation_asset,
    share_job_output,
    update_shared_asset,
    withdraw_shared_asset,
)

_AUTHOR = "老王"
_FAKE_MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
_FAKE_MP3 = b"ID3" + b"\x00" * 64


def _png(color: tuple[int, int, int], size: tuple[int, int] = (4, 4)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
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
    ref_a, ref_b, sref = _png((0, 200, 0)), _png((0, 0, 200)), _png((50, 50, 50))
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


def test_shared_job_output_is_indexed_ready(isolated_data_root, mount):
    job = _studio_job(outputs=[("1.png", _png((3, 3, 3)))])
    written = share_job_output(
        mount, job_id=job.job_id, output_index=0, title="t", tags=[], author=_AUTHOR
    )
    entry = next(e for e in scan_library(mount).entries if e.id == written.asset_id)
    assert entry.status == "ready" and entry.kind == "generation" and entry.author == _AUTHOR


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
