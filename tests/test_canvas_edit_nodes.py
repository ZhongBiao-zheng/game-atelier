"""Saved image edits own their configuration, not a mutable source node or a provider order."""
import io

import pytest
from PIL import Image
from pydantic import ValidationError

from character_workflow.lib import callers, keys
from character_workflow.lib.canvas_image_edits import save_image_edit, editing_source, preview_regional_edit
from character_workflow.lib.canvas_projects import (
    read_canvas_document, replace_canvas_node_media, save_canvas_document, canvas_output_dir,
)
from character_workflow.lib.canvas_runs import (
    submit_image_edit_run, submit_canvas_run, finalize_canvas_run, run_canvas_job,
    request_canvas_run_cancel,
    CanvasRunCommandError,
)
from character_workflow.lib.jobs import list_jobs, save_job, read_job
from character_workflow.lib.schemas import (
    CanvasDocument, CanvasImageEditSave, CanvasImageEditEditorState, CanvasImageEditOptions, JobStatus,
)
from tests.test_canvas_image_edits import setup_source
from tests.test_generation_recipe import png


def selection(value=0):
    body = io.BytesIO()
    Image.new("L", (1024, 1024), value).save(body, format="PNG")
    return body.getvalue()


def save_edit(pid, document, version, *, node_id=None, mask=None, **changes):
    source = next((n for n in document.nodes if n.id == "source"), None)
    values = dict(expected_revision=document.revision, node_id=node_id,
                  source_node_id="source" if not node_id else None,
                  source_version_id=version.version_id,
                  generation_draft=source.data.generation_draft if source else None)
    values.update(changes)
    return save_image_edit(pid, CanvasImageEditSave(**values), mask)


def node(document, node_id):
    return next(n for n in document.nodes if n.id == node_id)


def complete(pid, job):
    path = canvas_output_dir(pid, job.job_id) / "result.png"
    Image.new("RGB", (1024, 1024), "blue").save(path)
    job.status = JobStatus.DONE
    job.output_paths = [str(path)]
    save_job(job)
    return finalize_canvas_run(pid, job.job_id)


def test_save_empty_draft_is_local_and_restores_editor_state(monkeypatch):
    pid, source, document = setup_source()
    def forbidden(*args, **kwargs):
        raise AssertionError("saving must not resolve credentials or call providers")
    monkeypatch.setattr(keys, "read_keys_db", forbidden)
    monkeypatch.setattr(callers, "dispatch", forbidden)
    draft = node(document, "source").data.generation_draft.model_copy(update={
        "model": "", "alias": None, "prompt": "later",
    })
    editor = {"native": False, "strokes": [{"tool": "brush", "size": 12,
              "points": [{"x": 40, "y": 50}]}],
              "frame": {"width": 1024, "height": 1024, "x": 0, "y": 0}, "frame_ratio": "1:1"}
    saved, edit_id = save_edit(pid, document, source, generation_draft=draft, editor_state=editor)
    data = node(read_canvas_document(pid), edit_id).data
    assert data.generation_draft.prompt == "later"
    assert data.generation_draft.model == ""
    assert data.editor_state.model_dump() == editor
    assert data.mask_version_id is None
    assert list_jobs() == []
    assert saved.connections[0].role == "material"


def test_save_mask_reuses_identical_version_and_omission_clears_without_deleting_history():
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source, mask=selection())
    mask_id = node(saved, edit_id).data.mask_version_id
    saved, _ = save_edit(pid, saved, source, node_id=edit_id, mask=selection())
    assert node(saved, edit_id).data.mask_version_id == mask_id
    assert len(saved.content_versions) == 2
    saved, _ = save_edit(pid, saved, source, node_id=edit_id)
    assert node(saved, edit_id).data.mask_version_id is None
    assert mask_id in saved.content_versions
    assert list_jobs() == []


def test_reference_is_frozen_without_adding_a_reference_edge():
    pid, source, document = setup_source()
    reference = node(document, "source").model_copy(update={"id": "reference"})
    document = save_canvas_document(pid, document.model_copy(update={
        "nodes": [*document.nodes, reference],
    }), document.revision)
    saved, edit_id = save_edit(pid, document, source, mask=selection(),
                              reference_node_id="reference", reference_version_id=source.version_id)
    assert node(saved, edit_id).data.reference_node_id == "reference"
    assert node(saved, edit_id).data.reference_version_id == source.version_id
    assert [(edge.source_node_id, edge.target_node_id) for edge in saved.connections] == [
        ("source", edit_id),
    ]
    job, generated = submit_image_edit_run(pid, edit_id, saved.revision, 1)
    assert [item.node_id for item in job.canvas_run.snapshot.inputs] == ["source", "reference"]
    assert [(edge.source_node_id, edge.target_node_id) for edge in generated.connections] == [
        ("source", edit_id), (edit_id, job.canvas_run.result_node_id),
    ]


def test_new_edit_nodes_avoid_existing_nodes_and_saved_nodes_keep_their_position():
    from character_workflow.lib.schemas import CanvasPoint, CanvasSize
    pid, source, document = setup_source()
    source_node = node(document, "source")
    right = source_node.position.x + (source_node.size.width if source_node.size else 320) + 120
    blocker = source_node.model_copy(update={
        "id": "blocker", "position": CanvasPoint(x=right, y=source_node.position.y),
        "size": CanvasSize(width=320, height=300),
    })
    document = save_canvas_document(pid, document.model_copy(update={
        "nodes": [*document.nodes, blocker],
    }), document.revision)
    first_document, first_id = save_edit(pid, document, source)
    second_document, second_id = save_edit(pid, first_document, source)
    first, second = node(second_document, first_id), node(second_document, second_id)
    assert first.position.x == second.position.x == right
    assert first.position.y >= blocker.position.y + blocker.size.height + 32
    assert second.position.y >= first.position.y + first.size.height + 32
    updated, _ = save_edit(pid, second_document, source, node_id=first_id)
    assert node(updated, first_id).position == first.position
    assert node(updated, "blocker").position == blocker.position


@pytest.mark.parametrize("explicit_editor", [False, True])
def test_save_wide_source_preserves_source_sized_editor_frame(explicit_editor):
    pid, _source, document = setup_source()
    source, document, _ = replace_canvas_node_media(pid, "source", "wide.png", ".png",
        png((0, 255, 0), (20000, 1000)), "image", document.revision)
    options = {}
    if explicit_editor:
        options["editor_state"] = {
            "frame": {"width": 20000, "height": 1000, "x": 0, "y": 0},
            "strokes": [{"tool": "brush", "size": 20, "points": [{"x": 19999, "y": 500}]}],
        }
    saved, edit_id = save_edit(pid, document, source, **options)
    assert node(saved, edit_id).data.editor_state.frame.width == 20000
    assert node(read_canvas_document(pid), edit_id).data.editor_state.frame.height == 1000
    assert list_jobs() == []


def test_editor_coordinates_support_legal_source_axes_without_relaxing_execution_settings():
    editor = CanvasImageEditEditorState(
        frame={"width": 64_000_000, "height": 1, "x": 0, "y": 0},
        strokes=[{"tool": "brush", "size": 20000, "points": [{"x": 63_999_999, "y": 0}]}],
    )
    assert editor.strokes[0].points[0].x == 63_999_999
    with pytest.raises(ValidationError):
        CanvasImageEditOptions(mode="outpaint", width=20000, height=1000)


def test_empty_mask_can_save_but_not_generate():
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source, mask=selection(255))
    with pytest.raises(ValueError, match="没有需要编辑"):
        submit_image_edit_run(pid, edit_id, saved.revision, 1)
    assert list_jobs() == []


def test_source_reference_versions_survive_replacement_and_source_deletion():
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source, mask=selection(),
                              reference_node_id="source", reference_version_id=source.version_id)
    newer, replaced, _ = replace_canvas_node_media(pid, "source", "new.png", ".png",
        png((0, 255, 0), (1024, 1024)), "image", saved.revision)
    assert newer.version_id != source.version_id
    assert editing_source(pid, edit_id)["source_version_id"] == source.version_id
    without = replaced.model_copy(update={
        "nodes": [n for n in replaced.nodes if n.id != "source"], "connections": [],
    })
    deleted = save_canvas_document(pid, CanvasDocument.model_validate(without.model_dump()), replaced.revision)
    assert node(deleted, edit_id).data.source_node_id is None
    assert node(deleted, edit_id).data.reference_node_id is None
    deleted, _ = save_edit(pid, deleted, source, node_id=edit_id, mask=selection(),
                          generation_draft=node(saved, edit_id).data.generation_draft,
                          reference_version_id=source.version_id)
    job, saved = submit_image_edit_run(pid, edit_id, deleted.revision, 1)
    assert [i.version_id for i in job.canvas_run.snapshot.inputs] == [source.version_id] * 2
    assert job.canvas_run.snapshot.mask_version_id == node(deleted, edit_id).data.mask_version_id
    assert [(e.source_node_id, e.target_node_id) for e in saved.connections] == [
        (edit_id, job.canvas_run.result_node_id)]


def test_undo_source_deletion_after_replacement_keeps_fixed_edit_version():
    pid, original, document = setup_source()
    saved, edit_id = save_edit(pid, document, original, mask=selection())
    replacement, replaced, _ = replace_canvas_node_media(pid, "source", "new.png", ".png",
        png((0, 255, 0), (500, 500)), "image", saved.revision)
    deleted = save_canvas_document(pid, replaced.model_copy(update={
        "nodes": [n for n in replaced.nodes if n.id != "source"], "connections": [],
    }), replaced.revision)
    assert node(deleted, edit_id).data.source_node_id is None

    restored = save_canvas_document(pid, deleted.model_copy(update={
        "nodes": replaced.nodes, "connections": replaced.connections,
    }), deleted.revision)
    assert node(restored, "source").data.current_version_id == replacement.version_id
    assert node(restored, edit_id).data.source_node_id == "source"
    assert node(restored, edit_id).data.source_version_id == original.version_id
    forged = restored.model_copy(deep=True)
    node(forged, edit_id).data.source_version_id = replacement.version_id
    with pytest.raises(ValueError, match="源图版本不可更换"):
        save_canvas_document(pid, forged, restored.revision)

    job, _ = submit_image_edit_run(pid, edit_id, restored.revision, 1)
    assert job.canvas_run.snapshot.inputs[0].version_id == original.version_id
    assert job.params.image_edit["source_width"] == 1024
    assert job.params.image_edit["source_height"] == 1024


def test_inflight_snapshot_and_new_draft_are_independent_and_each_run_creates_new_result():
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source, mask=selection())
    first, running = submit_image_edit_run(pid, edit_id, saved.revision, 1)
    frozen = first.canvas_run.snapshot.model_dump(mode="json")
    with pytest.raises(CanvasRunCommandError, match="正在生成"):
        submit_image_edit_run(pid, edit_id, running.revision, 1)
    draft = node(running, edit_id).data.generation_draft.model_copy(update={"prompt": "new prompt"})
    changed, _ = save_edit(pid, running, source, node_id=edit_id, mask=selection(128),
                          generation_draft=draft, options={"feather": 4})
    assert node(changed, edit_id).data.active_run_id == first.canvas_run.run_id
    assert read_job(first.job_id).canvas_run.snapshot.model_dump(mode="json") == frozen
    first_done, finished = complete(pid, first)
    assert node(finished, edit_id).data.active_run_id is None
    assert node(finished, edit_id).data.generation_draft.prompt == "new prompt"
    old_result = node(finished, first.canvas_run.result_node_id).model_dump()
    second, repeated = submit_image_edit_run(pid, edit_id, finished.revision, 1)
    assert first_done.canvas_run.result_node_id != second.canvas_run.result_node_id
    assert node(repeated, first.canvas_run.result_node_id).model_dump() == old_result
    assert second.canvas_run.snapshot.mask_version_id != frozen["mask_version_id"]
    assert second.canvas_run.snapshot.draft_prompt == "new prompt"
    assert second.canvas_run.snapshot.final_prompt.endswith("new prompt")
    assert all(e.role == "material" for e in repeated.connections)


@pytest.mark.parametrize("value", ["forged", None])
def test_document_put_cannot_forge_or_clear_active_edit_run(value):
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source, mask=selection())
    _job, running = submit_image_edit_run(pid, edit_id, saved.revision, 1)
    forged = running.model_copy(deep=True)
    node(forged, edit_id).data.active_run_id = value
    with pytest.raises(ValueError, match="运行状态"):
        save_canvas_document(pid, forged, running.revision)


@pytest.mark.parametrize("value", ["forged", None])
def test_document_put_cannot_forge_or_clear_edit_result_status_even_without_edges(value):
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source, mask=selection())
    job, running = submit_image_edit_run(pid, edit_id, saved.revision, 1)
    disconnected = running.model_copy(update={"connections": []})
    disconnected = save_canvas_document(pid, disconnected, running.revision)
    forged = disconnected.model_copy(deep=True)
    node(forged, job.canvas_run.result_node_id).data.active_run_id = value
    with pytest.raises(ValueError, match="运行状态"):
        save_canvas_document(pid, forged, disconnected.revision)


@pytest.mark.parametrize("terminal", [False, True])
def test_delete_and_undo_restores_only_server_owned_run_state(terminal):
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source, mask=selection())
    job, running = submit_image_edit_run(pid, edit_id, saved.revision, 1)
    removed_ids = {edit_id, job.canvas_run.result_node_id}
    removed_nodes = [n for n in running.nodes if n.id in removed_ids]
    removed = save_canvas_document(pid, running.model_copy(update={
        "nodes": [n for n in running.nodes if n.id not in removed_ids], "connections": [],
    }), running.revision)
    if terminal:
        _job, removed = complete(pid, job)
    restored = removed.model_copy(update={"nodes": [*removed.nodes, *removed_nodes]})
    restored = save_canvas_document(pid, restored, removed.revision)
    expected = None if terminal else job.canvas_run.run_id
    assert node(restored, edit_id).data.active_run_id == expected
    assert node(restored, job.canvas_run.result_node_id).data.active_run_id == expected
    assert node(restored, edit_id).data.source_version_id == source.version_id
    if terminal:
        assert node(restored, job.canvas_run.result_node_id).data.current_version_id == (
            read_job(job.job_id).canvas_run.candidates[0].version_id
        )


def test_new_edit_node_cannot_claim_a_fake_run():
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source)
    forged = saved.model_copy(deep=True)
    node(forged, edit_id).id = "new-edit"
    node(forged, "new-edit").data.active_run_id = "invented-run"
    forged.connections = []
    with pytest.raises(ValueError, match="运行状态"):
        save_canvas_document(pid, forged, saved.revision)


def test_new_material_result_cannot_claim_a_fake_run():
    from character_workflow.lib.schemas import CanvasMaterialConnection
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source)
    result = node(saved, "source").model_copy(deep=True)
    result.id = "fake-result"
    result.data.current_version_id = None
    result.data.active_run_id = "invented-run"
    forged = saved.model_copy(update={"nodes": [*saved.nodes, result], "connections": [
        *saved.connections, CanvasMaterialConnection(id="fake", role="material",
            source_node_id=edit_id, target_node_id=result.id),
    ]})
    with pytest.raises(ValueError, match="运行状态"):
        save_canvas_document(pid, forged, saved.revision)


def test_existing_run_result_cannot_be_converted_to_configuration():
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source, mask=selection())
    job, running = submit_image_edit_run(pid, edit_id, saved.revision, 1)
    impostor = node(running, edit_id).model_copy(update={"id": job.canvas_run.result_node_id})
    forged = running.model_copy(update={
        "nodes": [impostor if n.id == impostor.id else n for n in running.nodes], "connections": [],
    })
    with pytest.raises(ValueError, match="运行节点不能更换类型"):
        save_canvas_document(pid, forged, running.revision)


def test_cancel_before_execution_clears_edit_and_result_status(monkeypatch):
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source, mask=selection())
    job, _ = submit_image_edit_run(pid, edit_id, saved.revision, 1)
    request_canvas_run_cancel(pid, job.canvas_run.run_id)
    monkeypatch.setattr(callers, "dispatch", lambda **kw: pytest.fail("canceled run called provider"))
    assert run_canvas_job(job.job_id).status == JobStatus.CANCELED
    latest = read_canvas_document(pid)
    assert node(latest, edit_id).data.active_run_id is None
    assert node(latest, job.canvas_run.result_node_id).data.active_run_id is None


def test_startup_reconciliation_clears_canceled_edit_status():
    from character_workflow.lib.canvas_runs import reconcile_canvas_jobs
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source, mask=selection())
    job, _ = submit_image_edit_run(pid, edit_id, saved.revision, 1)
    request_canvas_run_cancel(pid, job.canvas_run.run_id)
    reconcile_canvas_jobs(fail_pending=True, project_id=pid)
    latest = read_canvas_document(pid)
    assert node(latest, edit_id).data.active_run_id is None
    assert node(latest, job.canvas_run.result_node_id).data.active_run_id is None


def test_edit_cannot_use_generic_generation_or_input_connections():
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source)
    with pytest.raises(ValueError):
        submit_canvas_run(pid, edit_id, saved.revision, 1)
    with pytest.raises(CanvasRunCommandError, match="先保存"):
        submit_image_edit_run(pid, "source", saved.revision, 1)
    payload = saved.model_dump()
    payload["connections"] = [{"id": "bad", "role": "input", "source_node_id": edit_id,
                               "target_node_id": "source"}]
    with pytest.raises(ValidationError, match="input source"):
        CanvasDocument.model_validate(payload)
    payload["connections"][0].update(source_node_id="source", target_node_id=edit_id)
    with pytest.raises(ValidationError, match="material connections"):
        CanvasDocument.model_validate(payload)


def test_preview_uses_saved_fixed_source():
    pid, source, document = setup_source()
    saved, edit_id = save_edit(pid, document, source, mask=selection())
    replace_canvas_node_media(pid, "source", "new.png", ".png",
        png((0, 255, 0), (500, 500)), "image", saved.revision)
    preview = preview_regional_edit(pid, edit_id, "openai", "gpt-image-1", selection(),
        CanvasImageEditOptions(source_version_id=source.version_id))
    assert preview["regions"]


@pytest.mark.parametrize("point", [{"x": float("nan"), "y": 0}, {"x": 0, "y": float("inf")}])
def test_editor_state_rejects_nonfinite_coordinates(point):
    with pytest.raises(ValidationError):
        CanvasImageEditEditorState(strokes=[{"tool": "brush", "size": 10, "points": [point]}])


def test_save_strips_provider_orders_and_local_paths_from_draft():
    pid, source, document = setup_source()
    draft = node(document, "source").data.generation_draft.model_copy(deep=True)
    draft.params.evolink_state = {"task_id": "not-a-draft-field"}
    draft.params.reference_images = ["/private/should-not-be-persisted.png"]
    draft.params.mask_image = "/private/mask.png"
    saved, edit_id = save_edit(pid, document, source, generation_draft=draft)
    params = node(saved, edit_id).data.generation_draft.params
    assert params.evolink_state is None
    assert params.reference_images is None
    assert params.mask_image is None


@pytest.mark.parametrize("native_available", [True, False])
def test_tuzi_native_edit_keeps_verified_task_affinity_or_rejects_upload(monkeypatch, native_available):
    from character_workflow.lib import canvas_image_edits
    from character_workflow.lib.keys import KeysDB, KeySpec, ModelSpec, write_keys_db
    from tests.test_generation_recipe import NOW

    pid, source, document = setup_source()
    write_keys_db(KeysDB(keys=[KeySpec(alias="tuzi", provider="custom", access_key="test-only",
        base_url="https://api.tu-zi.com/v1", created_at=NOW,
        models=[ModelSpec(id="midjourney", name="MJ", modality="image")])]))
    draft = node(document, "source").data.generation_draft.model_copy(update={
        "alias": "tuzi", "model": "midjourney",
    })
    native = {"alias": "tuzi", "model": "midjourney", "task_id": "original-task",
              "image_index": 1, "single": True, "channel": "verified-affinity"}
    monkeypatch.setattr(canvas_image_edits, "mj_source", lambda _: native if native_available else None)
    saved, edit_id = save_edit(pid, document, source, mask=selection(), generation_draft=draft,
                              options={"mode": "inpaint", "custom_id": "MJ::JOB::inpaint::task"})
    assert "task_id" not in node(saved, edit_id).data.model_dump_json(exclude_none=True)
    if not native_available:
        with pytest.raises(ValueError, match="原任务所属渠道"):
            submit_image_edit_run(pid, edit_id, saved.revision, 4)
        assert list_jobs() == []
        return
    job, _ = submit_image_edit_run(pid, edit_id, saved.revision, 1)
    assert job.params.image_edit["task_id"] == "original-task"
    assert job.params.image_edit["channel"] == "verified-affinity"
    assert job.params.regional_edit is None
    assert job.params.n == 4
