"""配方来源：Studio job 与画布结果两种来源给出同一形状的 RecipeSource；保存为生成资产共用它。"""
from __future__ import annotations

import hashlib
import io
from pathlib import Path

import pytest
from PIL import Image

from character_workflow.lib import canvas_runs
from character_workflow.lib.canvas_projects import (
    canvas_output_dir,
    canvas_project_dir,
    create_canvas_project,
    read_canvas_document,
    replace_canvas_node_media,
    save_canvas_document,
)
from character_workflow.lib.canvas_runs import finalize_canvas_run, submit_canvas_run
from character_workflow.lib.creation_assets import creation_asset_input_path, get_creation_asset
from character_workflow.lib.generation_recipe import (
    RECIPE_PARAM_ALLOW,
    RecipeSource,
    RecipeSourceError,
    RecipeSourceNotFound,
    recipe_from_canvas_result,
    recipe_from_job_output,
    save_generation_asset,
)
from character_workflow.lib.jobs import new_job_id, save_job
from character_workflow.lib.keys import KeysDB, KeySpec, ModelSpec, write_keys_db
from character_workflow.lib.schemas import (
    CanvasDocument,
    CanvasGenerationDraft,
    Job,
    JobKind,
    JobParams,
    JobStatus,
)
from character_workflow.lib.studio_jobs import studio_output_dir

NOW = "2026-09-24T00:00:00+00:00"


def png(color: tuple[int, int, int], size: tuple[int, int] = (4, 4), fmt: str = "PNG") -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format=fmt)
    return buffer.getvalue()


def sha(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def _write_keys() -> None:
    write_keys_db(KeysDB(default_alias="openai", keys=[KeySpec(
        alias="openai", provider="openai", access_key="test", created_at=NOW,
        models=[ModelSpec(name="GPT", id="gpt-image-1", modality="image")],
    )]))


def _media_node(node_id: str, draft: dict | None = None) -> dict:
    return {
        "id": node_id, "title": node_id, "type": "image", "position": {"x": 0, "y": 0},
        "z_index": 0,
        "data": {
            "current_version_id": None, "generation_draft": draft, "active_run_id": None,
            "display": {"fit": "contain", "free_resize": False},
        },
    }


def _save_nodes(project_id: str, nodes: list[dict], connections: list[dict],
                versions: dict | None = None) -> CanvasDocument:
    current = read_canvas_document(project_id)
    payload = current.model_dump(mode="json")
    payload.update({"nodes": nodes, "connections": connections, "content_versions": versions or {}})
    return save_canvas_document(project_id, CanvasDocument.model_validate(payload), current.revision)


def _complete_run(project_id: str, job: Job, output: bytes) -> tuple[Job, CanvasDocument]:
    """模拟 runner：产物写进本 run 的输出目录、记实际费用、标 DONE，再走真实的 finalize。"""
    target = canvas_output_dir(project_id, job.job_id) / "candidate.png"
    target.write_bytes(output)
    save_job(job.model_copy(update={
        "status": JobStatus.DONE,
        "output_paths": [str(target)],
        "params": job.params.model_copy(update={"actual_cost_cny": 0.3}),
    }))
    finalized, document = finalize_canvas_run(project_id, job.job_id)
    assert document is not None
    return finalized, document


def canvas_run_with_inputs(ref_a: bytes, ref_b: bytes, output: bytes):
    """两张图片 + 一段文本连到配置节点，跑完一次生成。返回 (project_id, job, document)。"""
    _write_keys()
    project = create_canvas_project("配方来源")
    pid = project.project_id
    text_version = {
        "version_id": "version-text", "kind": "text", "text": "雨夜", "created_at": NOW,
        "sha256": "0" * 64, "origin": {"kind": "user_edit"},
    }
    text_node = {
        "id": "text-a", "title": "文本", "type": "text", "position": {"x": 0, "y": 0},
        "z_index": 0,
        "data": {"current_version_id": "version-text", "generation_draft": None,
                 "active_run_id": None},
    }
    config = {
        "id": "config", "title": "生成", "type": "config", "position": {"x": 0, "y": 0},
        "z_index": 0,
        "data": {"draft": {
            "mode": "image", "prompt": "一只纸雕狐狸", "input_policy": "all_connected",
            "model": "gpt-image-1", "alias": "openai",
            "params": {"ratio": "1:1", "quality": "high", "creation_asset_source_title": "旧"},
            "updated_at": NOW,
        }},
    }
    edges = [
        {"id": f"edge-{source}", "role": "input", "source_node_id": source,
         "target_node_id": "config"}
        for source in ("image-a", "text-a", "image-b")
    ]
    saved = _save_nodes(
        pid, [_media_node("image-a"), text_node, _media_node("image-b"), config], edges,
        {"version-text": text_version},
    )
    _va, saved, _ = replace_canvas_node_media(pid, "image-a", "a.png", ".png", ref_a, "image",
                                              saved.revision)
    ext_b = ".jpg" if ref_b.startswith(b"\xff\xd8") else ".png"
    _vb, saved, _ = replace_canvas_node_media(pid, "image-b", f"b{ext_b}", ext_b, ref_b, "image",
                                              saved.revision)
    job, _submitted = submit_canvas_run(pid, "config", saved.revision)
    finalized, document = _complete_run(pid, job, output)
    return pid, finalized, document


def canvas_mask_run(source: bytes, output: bytes):
    """一张源图 + 用户蒙版的局部编辑，跑完。返回 (project_id, job, document)。"""
    _write_keys()
    project = create_canvas_project("局部编辑")
    pid = project.project_id
    draft = CanvasGenerationDraft(
        mode="image", prompt="只改蒙版区域", model="gpt-image-1", alias="openai",
        params=JobParams(n=1, ratio="1:1"), updated_at=NOW,
    ).model_dump(mode="json")
    saved = _save_nodes(pid, [_media_node("image-src", draft)], [])
    _v, saved, _ = replace_canvas_node_media(pid, "image-src", "s.png", ".png", source, "image",
                                             saved.revision)
    mask = io.BytesIO()
    Image.new("RGBA", Image.open(io.BytesIO(source)).size, (0, 0, 0, 0)).save(mask, format="PNG")
    job, _submitted = canvas_runs.submit_mask_edit_run(pid, "image-src", saved.revision, 1,
                                                       mask.getvalue())
    finalized, document = _complete_run(pid, job, output)
    return pid, finalized, document


def result_version(job: Job) -> tuple[str, str]:
    """(结果节点 id, 该节点当前版本 id)。"""
    context = job.canvas_run
    assert context is not None
    return context.result_node_id, context.candidates[0].version_id


def _studio_job(output: bytes, params: dict) -> Job:
    job_id = new_job_id()
    target = studio_output_dir(job_id) / "1.png"
    target.write_bytes(output)
    return save_job(Job(
        job_id=job_id, character_id="", prompt="城墙上的红猫", submitted_at=NOW,
        model="gpt-image-2", params=JobParams(**params), output_paths=[str(target)],
        status=JobStatus.DONE, error=None, kind=JobKind.IMAGE, namespace="studio",
        provider="tuzi", alias="tuzi-main",
    ))


def _upload(root: Path, name: str, body: bytes) -> Path:
    path = root / ".runtime" / "uploads" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


# ------------------------------------------------------------------ job_output


def test_recipe_from_job_output_carries_filtered_recipe_and_input_paths(isolated_data_root):
    ref, mask = png((0, 90, 0)), png((0, 0, 90), fmt="JPEG")
    ref_path = _upload(isolated_data_root, "r.png", ref)
    mask_path = _upload(isolated_data_root, "m.png", mask)
    output = png((90, 0, 0))
    job = _studio_job(output, {
        "size": "1024x1024", "reference_images": [str(ref_path)],
        "mask_image": str(mask_path), "estimated_cost_cny": 0.4, "warnings": ["x"],
    })

    source = recipe_from_job_output(job.job_id, 0)

    assert isinstance(source, RecipeSource)
    assert source.media_path.read_bytes() == output and source.media_filename == "1.png"
    assert source.origin_job_id == job.job_id and source.origin_canvas_project_id is None
    recipe = source.recipe
    assert recipe.mode == "image" and recipe.model == "gpt-image-2"
    assert recipe.provider == "tuzi" and recipe.alias == "tuzi-main"
    assert recipe.final_prompt == job.prompt and recipe.draft_prompt is None
    assert recipe.params == {"size": "1024x1024"}
    assert recipe.cost_cny == 0.4 and recipe.cost_basis == "estimated"
    assert [(r.order, r.role, r.mime_type, r.sha256) for r in recipe.inputs] == [
        (0, "reference", "image/png", sha(ref)),
        # 后缀是 .png、内容是 JPEG：按内容定类型。
        (1, "mask", "image/jpeg", sha(mask)),
    ]
    assert source.input_paths == [ref_path.resolve(), mask_path.resolve()]


def test_recipe_from_job_output_rejects_missing_non_studio_and_outside_refs(
    isolated_data_root, tmp_path
):
    with pytest.raises(RecipeSourceNotFound):
        recipe_from_job_output("job-missing", 0)
    with pytest.raises(RecipeSourceNotFound):
        recipe_from_job_output("../escape", 0)

    outside = tmp_path / "outside.png"
    outside.write_bytes(png((1, 2, 3)))
    job = _studio_job(png((4, 5, 6)), {"reference_images": [str(outside)]})
    with pytest.raises(RecipeSourceError) as caught:
        recipe_from_job_output(job.job_id, 0)
    assert caught.value.code == "not_shareable"

    with pytest.raises(RecipeSourceError) as caught:
        recipe_from_job_output(job.job_id, 3)
    assert caught.value.code == "not_shareable"


def test_recipe_param_allow_excludes_paths_and_costs():
    assert "reference_images" not in RECIPE_PARAM_ALLOW
    assert "actual_cost_cny" not in RECIPE_PARAM_ALLOW
    assert "creation_asset_source_title" not in RECIPE_PARAM_ALLOW
    assert {"size", "seed", "frame_mode"} <= RECIPE_PARAM_ALLOW


# --------------------------------------------------------------- canvas_result


def test_recipe_from_canvas_result_uses_snapshot_and_skips_text_inputs(isolated_data_root):
    ref_a, ref_b, output = png((10, 0, 0)), png((0, 10, 0), fmt="JPEG"), png((0, 0, 10))
    pid, job, document = canvas_run_with_inputs(ref_a, ref_b, output)
    node_id, version_id = result_version(job)
    snapshot = job.canvas_run.snapshot

    source = recipe_from_canvas_result(pid, node_id, version_id)

    assert source.origin_job_id == job.job_id and source.origin_canvas_project_id == pid
    assert source.media_path.read_bytes() == output
    assert source.media_path.is_relative_to(canvas_project_dir(pid))
    recipe = source.recipe
    assert recipe.mode == "image" and recipe.model == "gpt-image-1"
    assert recipe.provider == "openai" and recipe.alias == "openai"
    # 画布补在开头的编号说明去掉；末尾的参考文本（文本输入的内容）保留。
    assert snapshot.final_prompt.startswith("参考素材编号：图片1、图片2。")
    assert recipe.final_prompt == "一只纸雕狐狸\n\n参考文本：\n【文本1】\n雨夜"
    assert recipe.draft_prompt == snapshot.draft_prompt
    assert recipe.submitted_at == snapshot.submitted_at
    assert recipe.cost_cny == 0.3 and recipe.cost_basis == "actual"
    # 服务端独占 / 本机来源字段不进配方；其余按白名单保留。
    assert snapshot.normalized_params["creation_asset_source_title"] == "旧"
    assert recipe.params == {
        key: value for key, value in snapshot.normalized_params.items()
        if key in RECIPE_PARAM_ALLOW
    }
    assert recipe.params["quality"] == "high" and "creation_asset_source_title" not in recipe.params
    # 文本输入跳过；两张图按 snapshot 顺序、按内容定类型。
    assert [s.kind for s in snapshot.inputs] == ["image", "text", "image"]
    assert [(r.order, r.role, r.kind, r.mime_type, r.sha256) for r in recipe.inputs] == [
        (0, "reference", "image", "image/png", sha(ref_a)),
        (1, "reference", "image", "image/jpeg", sha(ref_b)),
    ]
    assert [path.read_bytes() for path in source.input_paths] == [ref_a, ref_b]
    assert all(path.is_relative_to(canvas_project_dir(pid)) for path in source.input_paths)


def test_recipe_from_canvas_mask_run_adds_mask_role_last(isolated_data_root):
    src, output = png((20, 20, 0)), png((0, 20, 20))
    pid, job, _document = canvas_mask_run(src, output)
    node_id, version_id = result_version(job)
    mask_version_id = job.canvas_run.snapshot.mask_version_id
    assert mask_version_id is not None

    source = recipe_from_canvas_result(pid, node_id, version_id)

    assert [(r.order, r.role) for r in source.recipe.inputs] == [(0, "reference"), (1, "mask")]
    assert job.canvas_run.snapshot.final_prompt.startswith("参考素材编号：图片1。")
    assert source.recipe.final_prompt == "只改蒙版区域"
    assert source.recipe.inputs[0].sha256 == sha(src)
    mask_path = source.input_paths[1]
    assert source.recipe.inputs[1].sha256 == sha(mask_path.read_bytes())
    assert mask_path.parent == canvas_project_dir(pid) / "uploads"


def test_recipe_from_canvas_result_rejects_non_generated_and_mismatched_node(isolated_data_root):
    pid, job, document = canvas_run_with_inputs(png((1, 0, 0)), png((0, 1, 0)), png((0, 0, 1)))
    node_id, version_id = result_version(job)
    upload_version = next(n for n in document.nodes if n.id == "image-a").data.current_version_id

    with pytest.raises(RecipeSourceError) as caught:
        recipe_from_canvas_result(pid, "image-a", upload_version)
    assert caught.value.code == "not_shareable"
    with pytest.raises(RecipeSourceError) as caught:
        recipe_from_canvas_result(pid, "text-a", "version-text")
    assert caught.value.code == "not_shareable"

    # 拿别的节点的版本：节点与版本对不上。
    with pytest.raises(RecipeSourceNotFound):
        recipe_from_canvas_result(pid, "image-a", version_id)
    with pytest.raises(RecipeSourceNotFound):
        recipe_from_canvas_result(pid, "node-missing", version_id)
    with pytest.raises(RecipeSourceNotFound):
        recipe_from_canvas_result(pid, node_id, "version-missing")
    with pytest.raises(RecipeSourceNotFound):
        recipe_from_canvas_result("canvas-missing", node_id, version_id)
    with pytest.raises(RecipeSourceNotFound):
        recipe_from_canvas_result("../x", node_id, version_id)


def test_recipe_from_canvas_result_rejects_input_escaping_project(isolated_data_root, tmp_path):
    """参考输入的闸门是 resolve_canvas_media：resolve 后（symlink 已展开）必须在本画布项目目录内。"""
    pid, job, document = canvas_run_with_inputs(png((3, 0, 0)), png((0, 3, 0)), png((0, 0, 3)))
    node_id, version_id = result_version(job)
    upload_version = next(n for n in document.nodes if n.id == "image-a").data.current_version_id
    upload = canvas_project_dir(pid) / document.content_versions[upload_version].path
    outside = tmp_path / "secret.png"
    outside.write_bytes(png((9, 9, 9)))
    upload.unlink()
    upload.symlink_to(outside)

    with pytest.raises(RecipeSourceError) as caught:
        recipe_from_canvas_result(pid, node_id, version_id)
    assert caught.value.code == "not_shareable"


def test_recipe_from_canvas_result_missing_input_file_is_source_missing(isolated_data_root):
    pid, job, document = canvas_run_with_inputs(png((4, 0, 0)), png((0, 4, 0)), png((0, 0, 4)))
    node_id, version_id = result_version(job)
    upload_version = next(n for n in document.nodes if n.id == "image-b").data.current_version_id
    (canvas_project_dir(pid) / document.content_versions[upload_version].path).unlink()

    with pytest.raises(RecipeSourceError) as caught:
        recipe_from_canvas_result(pid, node_id, version_id)
    assert caught.value.code == "source_missing"


# ------------------------------------------------------ save_generation_asset


def test_save_generation_asset_from_job_output(isolated_data_root):
    ref = png((30, 0, 0))
    ref_path = _upload(isolated_data_root, "r.png", ref)
    output = png((0, 30, 0))
    job = _studio_job(output, {"size": "1x1", "reference_images": [str(ref_path)]})

    asset = save_generation_asset(
        recipe_from_job_output(job.job_id, 0), title=" 红猫 ", tags=["猫"], project_id=None,
    )

    assert asset.kind == "generation" and asset.title == "红猫" and asset.tags == ["猫"]
    assert asset.project_ids == [] and asset.adopted_from is None
    assert get_creation_asset(asset.asset_id) == asset
    content = asset.content
    assert content.media.sha256 == sha(output) and content.media.filename == "1.png"
    assert content.snapshot.params == {"size": "1x1"}
    path, mime = creation_asset_input_path(asset.asset_id, 0)
    assert path.read_bytes() == ref and mime == "image/png"


def test_save_generation_asset_from_canvas_result(isolated_data_root):
    ref_a, ref_b, output = png((40, 0, 0)), png((0, 40, 0), fmt="JPEG"), png((0, 0, 40))
    pid, job, _document = canvas_run_with_inputs(ref_a, ref_b, output)
    node_id, version_id = result_version(job)

    asset = save_generation_asset(
        recipe_from_canvas_result(pid, node_id, version_id), title="狐狸", tags=[], project_id=pid,
    )

    assert asset.kind == "generation" and asset.project_ids == [pid]
    assert asset.content.media.sha256 == sha(output)
    assert asset.content.snapshot.model == "gpt-image-1"
    for order, body in enumerate([ref_a, ref_b]):
        path, _mime = creation_asset_input_path(asset.asset_id, order)
        assert path.read_bytes() == body


def test_save_generation_asset_rejects_blank_title_before_writing_blobs(isolated_data_root):
    job = _studio_job(png((50, 0, 0)), {})
    source = recipe_from_job_output(job.job_id, 0)
    with pytest.raises(ValueError):
        save_generation_asset(source, title="  ", tags=[], project_id=None)
    assert not (isolated_data_root / "creation-assets" / "blobs").exists()


def test_save_generation_asset_missing_file_is_source_missing(isolated_data_root):
    job = _studio_job(png((60, 0, 0)), {})
    source = recipe_from_job_output(job.job_id, 0)
    source.media_path.unlink()
    with pytest.raises(RecipeSourceError) as caught:
        save_generation_asset(source, title="t", tags=[], project_id=None)
    assert caught.value.code == "source_missing"
