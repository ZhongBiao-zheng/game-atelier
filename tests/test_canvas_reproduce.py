"""画布复刻：从生成资产建输入节点 + 生成配置节点 + 连线，不自动 Run。"""
from __future__ import annotations

import io

import pytest
from PIL import Image

from character_workflow.lib.canvas_projects import (
    canvas_project_dir,
    create_canvas_project,
    read_canvas_document,
    save_canvas_document,
)
from character_workflow.lib.canvas_reproduce import reproduce_generation_asset_into_canvas
from character_workflow.lib.canvas_runs import canvas_input_sources
from character_workflow.lib.keys import KeySpec, KeysDB, ModelSpec, write_keys_db
from character_workflow.lib import canvas_reproduce
from character_workflow.lib.canvas_runs import prepare_canvas_generation
from character_workflow.lib.creation_assets import (
    CreationAssetStateError,
    blob_path_for,
    create_generation_asset,
    create_media_asset_from_bytes,
    get_creation_asset,
    store_media_blob,
)
from character_workflow.lib.schemas import (
    CanvasPoint,
    CanvasReproduceResponse,
    CreationMediaAssetContent,
    GenerationRecipe,
    RecipeInput,
)


def _png(color: tuple[int, int, int], size: tuple[int, int] = (4, 2)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


_OUTPUT = _png((200, 10, 10))
_REF_A = _png((10, 200, 10))
_REF_B = _png((10, 10, 200), (2, 4))
_MASK = _png((255, 255, 255))
_SREF = _png((90, 90, 90))


def _input(content: CreationMediaAssetContent, order: int, role: str = "reference") -> RecipeInput:
    return RecipeInput(
        order=order,
        role=role,
        kind=content.mime_type.split("/", 1)[0],
        sha256=content.sha256,
        mime_type=content.mime_type,
    )


def _asset(bodies_roles: list[tuple[bytes, str]], **recipe_overrides):
    media = store_media_blob(_OUTPUT, "out.png", "image/png")
    inputs = [
        _input(store_media_blob(body, f"ref-{order}.png", "image/png"), order, role)
        for order, (body, role) in enumerate(bodies_roles)
    ]
    fields = {
        "mode": "image",
        "model": "gpt-image-2",
        "provider": "tuzi",
        "alias": "tuzi-main",
        "final_prompt": "一只红色的猫",
        "draft_prompt": None,
        "params": {"size": "1024x1024", "quality": "high", "steps": 30},
        "inputs": inputs,
        "cost_cny": 0.21,
        "cost_basis": "actual",
        "submitted_at": "2026-09-23T00:00:00Z",
    }
    snapshot = GenerationRecipe(**{**fields, **recipe_overrides})
    return create_generation_asset(title="红猫", tags=[], media=media, snapshot=snapshot)


def _reproduce(project_id: str, asset_id: str, **overrides) -> CanvasReproduceResponse:
    arguments = {
        "project_id": project_id,
        "asset_id": asset_id,
        "position": CanvasPoint(x=100, y=200),
        "alias": "tuzi-main",
        "model": "gpt-image-2",
        "document_revision": read_canvas_document(project_id).revision,
    }
    return reproduce_generation_asset_into_canvas(**{**arguments, **overrides})


def _config(document):
    return next(node for node in document.nodes if node.type == "config")


def test_image_recipe_builds_inputs_config_and_ordered_connections():
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference"), (_REF_B, "reference")])

    document = _reproduce(project.project_id, asset.asset_id)

    assert isinstance(document, CanvasReproduceResponse)
    assert document.warnings == []
    assert document.revision == 1
    images = [node for node in document.nodes if node.type == "image"]
    config = _config(document)
    assert len(images) == 2 and len(document.nodes) == 3
    assert [(edge.source_node_id, edge.target_node_id, edge.slot) for edge in document.connections] == [
        (images[0].id, config.id, None),
        (images[1].id, config.id, None),
    ]
    for node, body in zip(images, (_REF_A, _REF_B), strict=True):
        version = document.content_versions[node.data.current_version_id]
        assert version.origin.kind == "creation_asset_snapshot"
        assert version.origin.title == "红猫"
        assert version.path.startswith("uploads/")
        assert (canvas_project_dir(project.project_id) / version.path).read_bytes() == body
    widths = [document.content_versions[node.data.current_version_id].width for node in images]
    assert widths == [4, 2]

    draft = config.data.draft
    assert draft.mode == "image"
    assert draft.prompt == "一只红色的猫"
    assert draft.model == "gpt-image-2" and draft.alias == "tuzi-main"
    params = draft.params.model_dump(exclude_none=True)
    assert params == {
        "size": "1024x1024", "quality": "high", "creation_asset_source_title": "红猫",
    }

    sources = canvas_input_sources(document, config, draft)
    assert [node_id for _, node_id in sources] == [images[0].id, images[1].id]

    # 输入节点在配置节点左侧纵向排开，互不重叠
    assert all(node.position.x < config.position.x for node in images)
    assert images[0].position.x == images[1].position.x
    assert images[0].position.y < images[1].position.y
    assert config.position.y == 200


def test_reproduce_marks_asset_used_in_the_canvas_project():
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference")])

    _reproduce(project.project_id, asset.asset_id)

    used = get_creation_asset(asset.asset_id)
    assert used.last_used_at is not None
    assert project.project_id in used.project_ids


def test_reproduce_survives_asset_deleted_before_marking_used(monkeypatch):
    from character_workflow.lib.creation_assets import delete_creation_asset

    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference")])
    real_mark = canvas_reproduce.mark_creation_asset_used

    def delete_then_mark(asset_id, project_id=None):
        delete_creation_asset(asset_id)
        return real_mark(asset_id, project_id)

    monkeypatch.setattr(canvas_reproduce, "mark_creation_asset_used", delete_then_mark)

    document = _reproduce(project.project_id, asset.asset_id)

    assert read_canvas_document(project.project_id).revision == document.revision == 1
    assert _config(document) is not None


def test_video_firstlast_recipe_connects_first_and_last_frame_slots():
    project = create_canvas_project("复刻")
    asset = _asset(
        [(_REF_A, "reference"), (_REF_B, "reference")],
        mode="video",
        model="doubao-seedance-1-0-pro",
        params={"duration": 5, "ratio": "16:9", "frame_mode": "firstlast", "size": "1280x720"},
    )

    document = _reproduce(project.project_id, asset.asset_id, model="doubao-seedance-1-0-pro")

    images = [node for node in document.nodes if node.type == "image"]
    config = _config(document)
    assert [(edge.source_node_id, edge.slot) for edge in document.connections] == [
        (images[0].id, "first_frame"),
        (images[1].id, "last_frame"),
    ]
    draft = config.data.draft
    assert draft.mode == "video"
    assert draft.params.model_dump(exclude_none=True) == {
        "duration": 5, "ratio": "16:9", "frame_mode": "firstlast",
        "creation_asset_source_title": "红猫",
    }
    assert canvas_input_sources(document, config, draft) == [
        ("first_frame", images[0].id),
        ("last_frame", images[1].id),
    ]


def test_video_last_frame_recipe_uses_the_last_frame_slot():
    project = create_canvas_project("复刻")
    asset = _asset(
        [(_REF_A, "reference")],
        mode="video", model="doubao-seedance-1-0-pro", params={"frame_mode": "last"},
    )

    document = _reproduce(project.project_id, asset.asset_id)

    assert [edge.slot for edge in document.connections] == ["last_frame"]


def test_video_recipe_without_frame_mode_uses_plain_input_connections():
    project = create_canvas_project("复刻")
    asset = _asset(
        [(_REF_A, "reference")],
        mode="video", model="doubao-seedance-1-0-pro", params={"frame_mode": "auto"},
    )

    document = _reproduce(project.project_id, asset.asset_id)

    assert [edge.slot for edge in document.connections] == [None]


def test_video_recipe_missing_frame_mode_writes_auto_for_omni_references():
    project = create_canvas_project("复刻")
    asset = _asset(
        [(_REF_A, "reference")],
        mode="video", model="doubao-seedance-1-0-pro", params={"duration": 5},
    )

    document = _reproduce(project.project_id, asset.asset_id, model="doubao-seedance-1-0-pro")

    assert _config(document).data.draft.params.frame_mode == "auto"
    assert [edge.slot for edge in document.connections] == [None]


def test_video_recipe_without_inputs_keeps_frame_mode_unset():
    project = create_canvas_project("复刻")
    asset = _asset([], mode="video", model="doubao-seedance-1-0-pro", params={"duration": 5})

    document = _reproduce(project.project_id, asset.asset_id, model="doubao-seedance-1-0-pro")

    assert _config(document).data.draft.params.frame_mode is None
    assert document.connections == []


def test_firstlast_recipe_truncates_extra_references_with_warning():
    project = create_canvas_project("复刻")
    asset = _asset(
        [(_REF_A, "reference"), (_REF_B, "reference"), (_SREF, "reference")],
        mode="video", model="doubao-seedance-1-0-pro", params={"frame_mode": "firstlast"},
    )

    document = _reproduce(project.project_id, asset.asset_id, model="doubao-seedance-1-0-pro")

    assert [edge.slot for edge in document.connections] == ["first_frame", "last_frame"]
    assert len([node for node in document.nodes if node.type == "image"]) == 2
    assert len(document.warnings) == 1 and "首尾帧" in document.warnings[0]


def test_mask_and_mj_inputs_are_skipped_with_warnings():
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference"), (_MASK, "mask"), (_SREF, "mj_sref")])

    document = _reproduce(project.project_id, asset.asset_id)

    assert len([node for node in document.nodes if node.type == "image"]) == 1
    assert len(document.connections) == 1
    assert len(document.warnings) == 2
    assert any("蒙版" in warning for warning in document.warnings)
    assert any("Midjourney" in warning for warning in document.warnings)
    assert len(document.content_versions) == 1


def test_missing_local_model_leaves_the_config_model_empty():
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference")])

    document = _reproduce(project.project_id, asset.asset_id, model=None, alias=None)

    draft = _config(document).data.draft
    assert draft.model == ""
    assert draft.alias is None


def test_final_prompt_is_written_verbatim():
    project = create_canvas_project("复刻")
    prompt = "参考素材编号：图片1。请按这些编号理解提示词中的引用。\n\n图片1 里的猫"
    asset = _asset([(_REF_A, "reference")], final_prompt=prompt)

    document = _reproduce(project.project_id, asset.asset_id)

    assert _config(document).data.draft.prompt == prompt


def test_revision_mismatch_is_a_conflict_and_writes_nothing():
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference")])

    with pytest.raises(RuntimeError, match="revision_conflict:0"):
        _reproduce(project.project_id, asset.asset_id, document_revision=3)

    assert read_canvas_document(project.project_id).nodes == []
    assert list((canvas_project_dir(project.project_id) / "uploads").iterdir()) == []


def test_non_generation_asset_is_rejected():
    project = create_canvas_project("复刻")
    media = create_media_asset_from_bytes(
        title="图", body=_REF_A, filename="a.png", mime_type="image/png", tags=[],
    )

    with pytest.raises(ValueError):
        _reproduce(project.project_id, media.asset_id)


def test_stored_document_has_no_warnings_and_round_trips_through_save():
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference"), (_MASK, "mask")])
    reproduced = _reproduce(project.project_id, asset.asset_id)

    stored = read_canvas_document(project.project_id)
    assert "warnings" not in stored.model_dump()
    assert stored.model_dump() == reproduced.model_dump(exclude={"warnings"})

    saved = save_canvas_document(project.project_id, stored, stored.revision)
    assert saved.model_dump(exclude={"updated_at"}) == stored.model_dump(exclude={"updated_at"})


def test_failed_commit_removes_written_bytes_and_keeps_canvas_json(monkeypatch):
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference"), (_REF_B, "reference")])
    project_dir = canvas_project_dir(project.project_id)
    before = (project_dir / "canvas.json").read_bytes()
    real_write_json = canvas_reproduce.atomic_write_json

    def failing_write_json(path, payload):
        if path.name == "canvas.json":
            raise OSError("disk full")
        real_write_json(path, payload)

    monkeypatch.setattr(canvas_reproduce, "atomic_write_json", failing_write_json)

    with pytest.raises(OSError, match="disk full"):
        _reproduce(project.project_id, asset.asset_id)

    assert list((project_dir / "uploads").iterdir()) == []
    assert (project_dir / "canvas.json").read_bytes() == before
    assert get_creation_asset(asset.asset_id).last_used_at is None


def test_missing_reference_blob_is_a_state_error():
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference")])
    row = asset.content.snapshot.inputs[0]
    blob_path_for(row.sha256, row.mime_type).unlink()

    with pytest.raises(CreationAssetStateError):
        _reproduce(project.project_id, asset.asset_id)

    assert read_canvas_document(project.project_id).nodes == []


_NOW = "2026-09-24T00:00:00Z"


def _configure_keys() -> None:
    write_keys_db(KeysDB(default_alias="tuzi-main", keys=[
        KeySpec(
            alias="tuzi-main", provider="openai", access_key="sk-test", created_at=_NOW,
            models=[
                ModelSpec(name="图片", id="gpt-image-2", modality="image"),
                ModelSpec(
                    name="视频", id="doubao-seedance-1-0-pro", modality="video",
                    protocol="seedance",
                ),
            ],
        ),
    ]))


def test_reproduced_image_config_prepares_for_a_run():
    _configure_keys()
    project = create_canvas_project("复刻")
    asset = _asset([(_REF_A, "reference"), (_REF_B, "reference")])
    _reproduce(project.project_id, asset.asset_id)
    stored = read_canvas_document(project.project_id)
    images = [node.id for node in stored.nodes if node.type == "image"]

    prepared = prepare_canvas_generation(project.project_id, stored, _config(stored))

    assert [item.node_id for item in prepared.inputs] == images
    assert "一只红色的猫" in prepared.final_prompt


def test_reproduced_firstlast_video_config_prepares_for_a_run():
    _configure_keys()
    project = create_canvas_project("复刻")
    asset = _asset(
        [(_REF_A, "reference"), (_REF_B, "reference")],
        mode="video", model="doubao-seedance-1-0-pro",
        params={"duration": 5, "frame_mode": "firstlast"},
    )
    _reproduce(project.project_id, asset.asset_id, model="doubao-seedance-1-0-pro")
    stored = read_canvas_document(project.project_id)

    prepared = prepare_canvas_generation(project.project_id, stored, _config(stored))

    assert [item.source for item in prepared.inputs] == ["first_frame", "last_frame"]
    assert prepared.normalized["frame_mode"] == "firstlast"
