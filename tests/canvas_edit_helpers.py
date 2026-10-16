"""Exercise the saved-node boundary in image edit protocol regression tests."""
from character_workflow.lib.canvas_image_edits import save_image_edit
from character_workflow.lib.canvas_projects import read_canvas_document
from character_workflow.lib.canvas_runs import submit_image_edit_run
from character_workflow.lib.schemas import CanvasImageEditOptions, CanvasImageEditSave


def submit_saved_edit(project_id, source_id, revision, count, mask, options=None):
    document = read_canvas_document(project_id)
    source = next(n for n in document.nodes if n.id == source_id)
    options = options or CanvasImageEditOptions()
    reference = next((n for n in document.nodes if n.id == options.reference_node_id), None)
    payload = CanvasImageEditSave(
        expected_revision=revision, source_node_id=source_id,
        source_version_id=options.source_version_id or source.data.current_version_id,
        generation_draft=source.data.generation_draft,
        options=options.model_dump(exclude={"source_version_id", "reference_node_id"}),
        reference_node_id=options.reference_node_id,
        reference_version_id=reference.data.current_version_id if reference else None,
    )
    saved, edit_id = save_image_edit(project_id, payload, mask or None)
    return submit_image_edit_run(project_id, edit_id, saved.revision, count)
