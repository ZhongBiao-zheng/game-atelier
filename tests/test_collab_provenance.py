"""Studio 投送、连续跨画布粘贴和分享读取都使用可独立保存的参数与参考素材。"""
from pathlib import Path

import pytest

from character_workflow.lib.canvas_paste import paste_nodes_into_canvas
from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, resolve_canvas_media,
)
from character_workflow.lib.collab_provenance import hydrate_document_provenance, studio_output_snapshot
from character_workflow.lib.jobs import save_job
from character_workflow.lib.keys import KeysDB, KeySpec, ModelSpec, write_keys_db
from character_workflow.lib.studio_jobs import add_job_output_to_canvas
from tests.test_generation_recipe import NOW, _studio_job, _upload, canvas_run_with_inputs, png


def _copy(project_id, node):
    target = create_canvas_project("目标")
    saved = paste_nodes_into_canvas(
        project_id=target.project_id, source_project_id=project_id,
        nodes=[node], connections=[], document_revision=0,
    )
    return target.project_id, saved


def test_studio_transfer_survives_deleted_originals_and_second_copy(isolated_data_root):
    media = png((1, 2, 3))
    first = _upload(isolated_data_root, "first.png", media)
    job = _studio_job(png((4, 5, 6)), {
        "reference_images": [str(first)], "mj_sref": [str(first)], "ratio": "16:9",
        "seed": 0, "actual_cost_cny": 0, "estimated_cost_cny": 1.5,
        "gateway_idempotency_key": "do-not-share", "edit_inputs": [{"role": "source", "path": str(first)}],
        "workflow_inputs": {"authorization": "do-not-share"}, "access_key": "do-not-share",
    })
    job = save_job(job.model_copy(update={"alias": "团队渠道", "provider": "custom",
                                          "completed_at": "2026-09-24T00:00:07+00:00"}))
    write_keys_db(KeysDB(keys=[KeySpec(
        alias=job.alias, provider="custom", created_at=NOW, access_key="do-not-share",
        base_url="https://private-user:private-pass@api.tu-zi.com/v1",
        models=[ModelSpec(id=job.model, name="图像模型")], icon="file:" + "a" * 64,
    )]))
    target = create_canvas_project("第一张画布")
    result = add_job_output_to_canvas(job.job_id, 0, target.project_id)
    document = read_canvas_document(target.project_id)
    node = document.nodes[0]
    version = document.content_versions[node.data.current_version_id]
    frozen = version.frozen_generation
    assert result["revision"] == document.revision == 1
    assert frozen.prompt == job.prompt and frozen.model_name == "图像模型"
    assert frozen.provider_label == "Tuzi" and frozen.provider_icon is None
    assert frozen.cost_cny == 0 and frozen.duration_s == 7
    assert frozen.params == {"ratio": "16:9", "seed": 0}
    assert [row.role for row in frozen.inputs] == ["reference", "mj_sref"]
    assert frozen.inputs[0].version_id == frozen.inputs[1].version_id
    assert all(v not in frozen.model_dump_json() for v in (
        str(isolated_data_root), "do-not-share", "private-pass", "file:", "api.tu-zi.com",
    ))
    first.unlink()
    Path(job.output_paths[0]).unlink()
    target_id, copied = _copy(target.project_id, node)
    second = copied.content_versions[copied.nodes[0].data.current_version_id].frozen_generation
    assert second.model_dump(exclude={"inputs"}) == frozen.model_dump(exclude={"inputs"})
    assert second.inputs[0].version_id != frozen.inputs[0].version_id
    assert resolve_canvas_media(target_id, second.inputs[0].version_id)[0].read_bytes() == media


def test_canvas_result_hydrates_text_media_and_preserves_candidates(isolated_data_root):
    source_id, job, before = canvas_run_with_inputs(png((4, 5, 6)), png((8, 9, 7)), png((3, 2, 1)))
    document = hydrate_document_provenance(source_id, before)
    result_id = job.canvas_run.candidates[0].version_id
    frozen = document.content_versions[result_id].frozen_generation
    assert frozen.source_kind == "canvas" and "一只纸雕狐狸" in frozen.prompt
    assert frozen.model_id == "gpt-image-1" and frozen.model_name == "GPT"
    assert frozen.params["quality"] == "high" and frozen.cost_cny == 0.3
    assert [row.text for row in frozen.inputs if row.kind == "text"] == ["雨夜"]
    assert sum(row.kind == "image" for row in frozen.inputs) == 2
    assert read_canvas_document(source_id).content_versions[result_id].frozen_generation is None
    node = next(n for n in before.nodes if n.id == job.canvas_run.result_node_id)
    target_id, copied = _copy(source_id, node)
    second = copied.content_versions[copied.nodes[0].data.current_version_id].frozen_generation
    for original, ref in zip(frozen.inputs, second.inputs, strict=True):
        if original.version_id:
            assert ref.version_id != original.version_id
            assert resolve_canvas_media(target_id, ref.version_id)[0].read_bytes() == resolve_canvas_media(
                source_id, original.version_id)[0].read_bytes()


def test_private_reference_rejected_without_partial_canvas_write(isolated_data_root):
    secret = isolated_data_root / ".config" / "private.png"
    secret.parent.mkdir(exist_ok=True)
    secret.write_bytes(png((1, 2, 3)))
    job = _studio_job(png((4, 5, 6)), {"reference_images": [str(secret)]})
    target = create_canvas_project("空白")
    with pytest.raises(ValueError, match="受保护"):
        add_job_output_to_canvas(job.job_id, 0, target.project_id)
    assert read_canvas_document(target.project_id).revision == 0
    with pytest.raises(ValueError, match="受保护"):
        studio_output_snapshot(job, 0)
