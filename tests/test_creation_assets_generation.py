"""生成资产（成片 + 自包含冻结快照）、团队侧快照读模型、参考内容端点、recommendation 已删除。"""
from __future__ import annotations

import io

import pytest
from PIL import Image
from pydantic import ValidationError
from tests.local_client import LocalTestClient as TestClient

from character_workflow.lib import data_root
from character_workflow.lib.canvas_projects import create_canvas_project, read_canvas_document
from character_workflow.lib.creation_assets import (
    blob_path_for,
    create_generation_asset,
    create_media_asset_from_bytes,
    create_prompt_asset,
    creation_asset_input_path,
    creation_asset_media_path,
    delete_creation_asset,
    get_creation_asset,
    insert_creation_asset_into_canvas,
    list_creation_assets,
    store_media_blob,
)
from character_workflow.lib.schemas import (
    CanvasPoint,
    CreationMediaAssetContent,
    GenerationRecipe,
    RecipeInput,
    TeamAssetFile,
)
from viewer_server.server_app import build_app


def _png(color: tuple[int, int, int]) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), color).save(buffer, format="PNG")
    return buffer.getvalue()


_OUTPUT = _png((200, 10, 10))
_REF_A = _png((10, 200, 10))
_REF_B = _png((10, 10, 200))


@pytest.fixture
def client(isolated_data_root):
    return TestClient(base_url="http://127.0.0.1", app=build_app(dist_dir=isolated_data_root / "dist"))


def _input(content: CreationMediaAssetContent, order: int, role: str = "reference") -> RecipeInput:
    return RecipeInput(
        order=order,
        role=role,
        kind=content.mime_type.split("/", 1)[0],
        sha256=content.sha256,
        mime_type=content.mime_type,
    )


def _recipe(inputs: list[RecipeInput] | None = None, **overrides) -> GenerationRecipe:
    fields = {
        "mode": "image",
        "model": "gpt-image-2",
        "provider": "tuzi",
        "alias": "tuzi-main",
        "final_prompt": "一只红色的猫",
        "draft_prompt": None,
        "params": {"size": "1024x1024"},
        "inputs": inputs or [],
        "cost_cny": 0.21,
        "cost_basis": "actual",
        "submitted_at": "2026-09-23T00:00:00Z",
    }
    return GenerationRecipe(**{**fields, **overrides})


def _generation_asset(project_id: str | None = None):
    media = store_media_blob(_OUTPUT, "out.png", "image/png")
    ref_a = store_media_blob(_REF_A, "a.png", "image/png")
    ref_b = store_media_blob(_REF_B, "b.png", "image/png")
    snapshot = _recipe([_input(ref_a, 0), _input(ref_b, 1, "mj_sref")])
    asset = create_generation_asset(
        title="红猫", tags=["猫", "猫"], media=media, snapshot=snapshot, project_id=project_id,
    )
    return asset, media, ref_a, ref_b


def test_recipe_cost_and_basis_are_set_together():
    assert _recipe(cost_cny=None, cost_basis=None).cost_basis is None
    with pytest.raises(ValidationError):
        _recipe(cost_cny=0.5, cost_basis=None)
    with pytest.raises(ValidationError):
        _recipe(cost_cny=None, cost_basis="estimated")


def test_recipe_input_orders_must_run_from_zero_in_order():
    ref = store_media_blob(_REF_A, "a.png", "image/png")
    assert [row.order for row in _recipe([_input(ref, 0), _input(ref, 1)]).inputs] == [0, 1]
    with pytest.raises(ValidationError):
        _recipe([_input(ref, 0), _input(ref, 2)])
    with pytest.raises(ValidationError):
        _recipe([_input(ref, 1), _input(ref, 0)])
    with pytest.raises(ValidationError):
        _recipe([_input(ref, 1)])


def test_recipe_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        GenerationRecipe.model_validate({**_recipe().model_dump(), "estimated_cost_cny": 1})


def test_generation_asset_resolves_output_and_each_input():
    asset, media, ref_a, ref_b = _generation_asset(project_id="canvas-abc")

    assert asset.kind == "generation" and asset.content.kind == "generation"
    assert asset.tags == ["猫"] and asset.project_ids == ["canvas-abc"]
    assert get_creation_asset(asset.asset_id) == asset
    assert [row.asset_id for row in list_creation_assets(kind="generation").assets] == [asset.asset_id]
    assert list_creation_assets(kind="media").assets == []

    assert creation_asset_media_path(asset.asset_id).read_bytes() == _OUTPUT
    path, mime = creation_asset_input_path(asset.asset_id, 1)
    assert path.read_bytes() == _REF_B and mime == "image/png"
    assert path == blob_path_for(ref_b.sha256, "image/png")
    assert creation_asset_input_path(asset.asset_id, 0)[0].read_bytes() == _REF_A
    with pytest.raises(KeyError):
        creation_asset_input_path(asset.asset_id, 2)


def test_blob_path_for_points_into_the_blob_store():
    content = store_media_blob(_REF_A, "a.png", "image/png")
    assert blob_path_for(content.sha256, "image/png") == (
        data_root.resolve_data_root() / content.path
    )
    with pytest.raises(ValueError):
        blob_path_for("../../etc/passwd", "image/png")
    with pytest.raises(ValueError):
        blob_path_for(content.sha256, "image/bmp")


def test_missing_input_blob_raises_file_not_found():
    asset, _, ref_a, _ = _generation_asset()
    blob_path_for(ref_a.sha256, ref_a.mime_type).unlink()
    with pytest.raises(FileNotFoundError):
        creation_asset_input_path(asset.asset_id, 0)


def test_generation_asset_refuses_missing_blobs():
    media = store_media_blob(_OUTPUT, "out.png", "image/png")
    ghost = RecipeInput(order=0, role="reference", kind="image", sha256="e" * 64, mime_type="image/png")
    with pytest.raises(FileNotFoundError):
        create_generation_asset(title="缺参考", tags=[], media=media, snapshot=_recipe([ghost]))
    assert list_creation_assets().assets == []


def test_input_path_is_only_for_generation_assets():
    media_asset = create_media_asset_from_bytes(
        title="图", body=_REF_A, filename="a.png", mime_type="image/png", tags=[],
    )
    prompt = create_prompt_asset("提示词", [{"kind": "text", "text": "猫"}], [])
    for asset_id in (media_asset.asset_id, prompt.asset_id):
        with pytest.raises(KeyError):
            creation_asset_input_path(asset_id, 0)


def test_deleting_generation_asset_keeps_blobs_other_assets_still_use():
    asset, media, ref_a, ref_b = _generation_asset()
    shared = create_media_asset_from_bytes(
        title="同一张参考", body=_REF_A, filename="a.png", mime_type="image/png", tags=[],
    )

    delete_creation_asset(asset.asset_id)

    assert not blob_path_for(media.sha256, media.mime_type).exists()
    assert not blob_path_for(ref_b.sha256, ref_b.mime_type).exists()
    assert blob_path_for(ref_a.sha256, ref_a.mime_type).is_file()
    assert [row.asset_id for row in list_creation_assets().assets] == [shared.asset_id]


def test_deleting_media_asset_keeps_blob_a_generation_input_uses():
    media_asset = create_media_asset_from_bytes(
        title="参考", body=_REF_A, filename="a.png", mime_type="image/png", tags=[],
    )
    _, _, ref_a, _ = _generation_asset()

    delete_creation_asset(media_asset.asset_id)

    assert blob_path_for(ref_a.sha256, ref_a.mime_type).is_file()


def test_generation_asset_inserts_into_canvas_as_its_output_image():
    project = create_canvas_project("生成资产画布")
    asset, *_ = _generation_asset()

    document = insert_creation_asset_into_canvas(
        project_id=project.project_id,
        asset_id=asset.asset_id,
        position=CanvasPoint(x=0, y=0),
        expected_revision=read_canvas_document(project.project_id).revision,
    )

    version = next(iter(document.content_versions.values()))
    assert version.kind == "image" and version.sha256 == asset.content.media.sha256


def test_inputs_endpoint_serves_reference_bytes(client: TestClient):
    asset, *_ = _generation_asset()

    served = client.get(f"/api/creation-assets/{asset.asset_id}/inputs/1")
    assert served.status_code == 200
    assert served.content == _REF_B
    assert served.headers["content-type"] == "image/png"
    assert client.get(f"/api/creation-assets/{asset.asset_id}/content").content == _OUTPUT
    assert client.get(f"/api/creation-assets/{asset.asset_id}/inputs/2").status_code == 404
    assert client.get("/api/creation-assets/creation-asset-missing/inputs/0").status_code == 404


def test_inputs_endpoint_is_404_for_prompt_and_media_assets(client: TestClient):
    media_asset = create_media_asset_from_bytes(
        title="图", body=_REF_A, filename="a.png", mime_type="image/png", tags=[],
    )
    prompt = create_prompt_asset("提示词", [{"kind": "text", "text": "猫"}], [])
    for asset_id in (media_asset.asset_id, prompt.asset_id):
        assert client.get(f"/api/creation-assets/{asset_id}/inputs/0").status_code == 404


def test_generation_assets_list_through_http(client: TestClient):
    asset, *_ = _generation_asset()
    listed = client.get("/api/creation-assets", params={"kind": "generation"})
    assert listed.status_code == 200
    body = listed.json()["assets"]
    assert [row["asset_id"] for row in body] == [asset.asset_id]
    assert body[0]["content"]["snapshot"]["inputs"][1]["role"] == "mj_sref"
    assert "recommendation" not in body[0]


def test_prompt_asset_requests_reject_recommendation(client: TestClient):
    recommendation = {"mode": "image", "model": "gpt-image-2", "params": {}}
    segments = [{"kind": "text", "text": "猫"}]
    created = client.post("/api/creation-assets/prompts", json={
        "title": "猫", "segments": segments, "tags": [], "recommendation": recommendation,
    })
    assert created.status_code == 422

    prompt = create_prompt_asset("猫", segments, [])
    assert "recommendation" not in prompt.model_dump()
    updated = client.put(f"/api/creation-assets/{prompt.asset_id}/prompt", json={
        "title": "猫", "segments": segments, "tags": [], "recommendation": recommendation,
    })
    assert updated.status_code == 422


def _team_asset_payload(**overrides) -> dict:
    payload = {
        "team_asset_version": 1,
        "asset_id": "ta_01JZ9KHVTPQRSXYZABCDEFGHJK",
        "kind": "generation",
        "title": "董卓",
        "tags": ["皮肤"],
        "author": {"display_name": "老王", "avatar": "future-field"},
        "shared_at": "2026-09-23T00:00:00Z",
        "updated_at": "2026-09-23T00:00:00Z",
        "media": {
            "filename": "dz.png", "mime_type": "image/png", "bytes": 10, "sha256": "a" * 64,
            "width": 1024,
        },
        "snapshot": {
            "mode": "image", "model": "gpt-image-2", "provider": "tuzi", "alias": None,
            "final_prompt": "董卓", "draft_prompt": "董卓", "params": {"size": "1024x1024"},
            "inputs": [{
                "order": 0, "role": "reference", "kind": "image", "sha256": "b" * 64,
                "mime_type": "image/png", "path": "refs/01-bbbbbbbbbbbb.png", "note": "future",
            }],
            "cost_cny": 0.21, "cost_basis": "actual", "submitted_at": "2026-09-23T00:00:00Z",
            "seed_hint": "future-field",
        },
        "origin": {"job_id": "job-1", "canvas_project_id": None, "machine": "future"},
        "future_top_level": {"anything": True},
    }
    return {**payload, **overrides}


def test_team_asset_file_ignores_fields_from_newer_machines():
    team_asset = TeamAssetFile.model_validate(_team_asset_payload())

    assert team_asset.snapshot is not None and team_asset.origin is not None
    assert team_asset.snapshot.inputs[0].path == "refs/01-bbbbbbbbbbbb.png"
    assert team_asset.origin.job_id == "job-1"
    dumped = team_asset.model_dump(mode="json", exclude_none=True)
    assert "future_top_level" not in dumped and "seed_hint" not in dumped["snapshot"]

    recipe = GenerationRecipe.model_validate(
        team_asset.snapshot.model_dump(exclude={"inputs": {"__all__": {"path"}}})
    )
    assert recipe.inputs[0].sha256 == "b" * 64
    assert "path" not in recipe.model_dump()["inputs"][0]


def test_team_asset_file_rejects_unknown_version():
    with pytest.raises(ValidationError):
        TeamAssetFile.model_validate(_team_asset_payload(team_asset_version=2))


def test_team_generation_snapshot_inputs_must_carry_a_path():
    payload = _team_asset_payload()
    del payload["snapshot"]["inputs"][0]["path"]
    with pytest.raises(ValidationError):
        TeamAssetFile.model_validate(payload)


def test_team_generation_snapshot_input_path_stays_inside_the_asset():
    for bad in ("/etc/passwd", "../other/a.png", "refs\\a.png"):
        payload = _team_asset_payload()
        payload["snapshot"]["inputs"][0]["path"] = bad
        with pytest.raises(ValidationError):
            TeamAssetFile.model_validate(payload)


def test_team_asset_media_sha256_must_be_hex():
    payload = _team_asset_payload()
    payload["media"]["sha256"] = "not-a-digest"
    with pytest.raises(ValidationError):
        TeamAssetFile.model_validate(payload)
