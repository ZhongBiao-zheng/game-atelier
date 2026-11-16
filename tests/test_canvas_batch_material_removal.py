"""删除批量素材节点后，旧画布、旧 job 与旧项目包照常可读（形状取自真实数据的只读统计）。"""
import io
import json

from PIL import Image

from character_workflow.lib import jobs
from character_workflow.lib.canvas_agent_tools import _media_node
from character_workflow.lib.canvas_packages import (
    commit_canvas_package, export_canvas_projects, inspect_canvas_package,
)
from character_workflow.lib.canvas_projects import (
    _document_path, create_canvas_project, list_canvas_projects, read_canvas_document,
    save_canvas_document, save_canvas_upload,
)
from character_workflow.lib.schemas import CanvasDocument
from tests.test_canvas_candidates import _job

BATCH_ID = "batch-material-72b9e012"


def _png(color: tuple[int, int, int]) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (64, 64), color).save(buffer, "PNG")
    return buffer.getvalue()


def _legacy_project(*, grouped: bool = False) -> tuple[str, list[str]]:
    """磁盘上写一份删除前的画布：批量节点 2 项、4 条连出的线、内容节点全带 `batch_result`。"""
    project_id = create_canvas_project("批量旧画布").project_id
    version_ids = []
    for index, color in enumerate([(200, 0, 0), (0, 200, 0)]):
        document = read_canvas_document(project_id)
        save_canvas_upload(
            project_id, f"{index}.png", ".png", _png(color), "image", document.revision,
            node_factory=lambda version, index=index: _media_node(
                "image", f"upload-{index}", f"上传 {index}", {"x": index * 400, "y": 0}, version.version_id),
        )
        version_ids.append(read_canvas_document(project_id).nodes[-1].data.current_version_id)
    raw = json.loads(_document_path(project_id).read_text(encoding="utf-8"))
    for node in raw["nodes"]:
        node["data"]["batch_result"] = None
    raw["nodes"].append({
        "id": BATCH_ID, "type": "batch_material", "title": "批量素材",
        "position": {"x": 1651.98, "y": -770.49}, "size": {"width": 374.0, "height": 241.0},
        "z_index": 3, "hidden": True,
        "data": {"items": [{"id": "item-a", "image_version_ids": [version_ids[0]]},
                           {"id": "item-b", "image_version_ids": [version_ids[1]]}]},
    })
    for index in range(4):
        raw["nodes"].append({
            "id": f"result-{index}", "type": "text", "title": f"结果 {index}",
            "position": {"x": 2200, "y": index * 200}, "z_index": 0,
            "data": {"current_version_id": None, "generation_draft": None, "active_run_id": None,
                     "display": {"scale": "sm"},
                     "batch_result": {"batch_id": "batch-" + "a" * 24, "template_node_id": "result-0",
                                      "source_node_id": BATCH_ID, "item_id": "item-a",
                                      "image_version_ids": [version_ids[0]], "round_index": 0}},
        })
        raw["connections"].append({"id": f"batch-edge-{index}", "role": "input",
                                   "source_node_id": BATCH_ID, "target_node_id": f"result-{index}"})
    if grouped:
        raw["nodes"].append({"id": "outer-group", "type": "group", "title": "外层",
                             "position": {"x": 0, "y": 0}, "z_index": 0,
                             "data": {"member_node_ids": ["upload-0", BATCH_ID]}})
    _document_path(project_id).write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    return project_id, version_ids


def test_legacy_batch_canvas_lists_and_opens_as_image_nodes_in_a_group():
    project_id, version_ids = _legacy_project()

    assert project_id in {item.project_id for item in list_canvas_projects()}
    document = read_canvas_document(project_id)
    nodes = {node.id: node for node in document.nodes}
    group = nodes[BATCH_ID]
    assert group.type == "group" and group.title == "批量素材"
    assert group.data.member_node_ids == [f"{BATCH_ID}-1", f"{BATCH_ID}-2"]
    members = [nodes[member_id] for member_id in group.data.member_node_ids]
    assert [member.type for member in members] == ["image", "image"]
    assert [member.data.current_version_id for member in members] == version_ids
    assert [(member.position.x, member.position.y) for member in members] == [
        (1651.98, -770.49), (1651.98 + 360, -770.49)]
    # 64×64 的图：节点 320×320，两列间隔 40；分组框按前端「编组」的留白包住成员。
    assert all(member.hidden and member.z_index == 3 for member in members)
    assert [(member.size.width, member.size.height) for member in members] == [(320, 320), (320, 320)]
    assert (group.position.x, group.position.y) == (1651.98 - 24, -770.49 - 40)
    assert (group.size.width, group.size.height) == (320 * 2 + 40 + 48, 320 + 64)
    assert not [edge for edge in document.connections if edge.id.startswith("batch-edge")]
    assert "batch_result" not in document.model_dump_json()


def test_lifting_is_deterministic_and_saving_settles_it():
    project_id, _ = _legacy_project()
    first = read_canvas_document(project_id).model_dump_json()
    second = read_canvas_document(project_id).model_dump_json()
    assert first == second

    document = read_canvas_document(project_id)
    saved = save_canvas_document(project_id, document, document.revision)
    on_disk = _document_path(project_id).read_text(encoding="utf-8")
    assert '"batch_material"' not in on_disk and "batch_result" not in on_disk
    assert [node.id for node in saved.nodes] == [node.id for node in document.nodes]
    assert read_canvas_document(project_id).model_dump(exclude={"revision", "updated_at"}) \
        == document.model_dump(exclude={"revision", "updated_at"})


def test_batch_node_inside_a_group_is_replaced_by_its_images_without_nesting():
    project_id, _ = _legacy_project(grouped=True)
    document = read_canvas_document(project_id)
    nodes = {node.id: node for node in document.nodes}
    assert BATCH_ID not in nodes
    assert nodes["outer-group"].data.member_node_ids == ["upload-0", f"{BATCH_ID}-1", f"{BATCH_ID}-2"]
    assert [node.id for node in document.nodes if node.type == "group"] == ["outer-group"]


def test_member_ids_do_not_collide_with_existing_nodes():
    project_id, version_ids = _legacy_project()
    raw = json.loads(_document_path(project_id).read_text(encoding="utf-8"))
    raw["nodes"].insert(0, {"id": f"{BATCH_ID}-1", "type": "text", "title": "已有",
                            "position": {"x": 0, "y": 0}, "data": {"display": {"scale": "sm"}}})
    document = CanvasDocument.model_validate(raw)
    group = next(node for node in document.nodes if node.id == BATCH_ID)
    assert group.data.member_node_ids == [f"{BATCH_ID}-1-b", f"{BATCH_ID}-2"]


def test_legacy_project_package_exports_and_imports():
    project_id, _ = _legacy_project()
    archive, _ = export_canvas_projects([project_id])
    imported = commit_canvas_package(inspect_canvas_package(archive).token)[0]
    document = read_canvas_document(imported.project_id)
    assert [node.type for node in document.nodes].count("group") == 1


def _write_legacy_job(job_id: str, *, status: str, started: bool) -> None:
    raw = json.loads(_job("canvas-legacy", job_id, []).model_dump_json())
    raw.update(job_id=job_id, status=status,
               runner_started_at="2026-10-11T13:07:14Z" if started else None)
    raw["canvas_run"]["batch"] = {"batch_id": "batch-" + "a" * 24, "item_id": "item-a",
                                  "round_index": 0, "step_index": 0}
    path = jobs._path(job_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")


def test_legacy_batch_jobs_list_and_unstarted_steps_are_cancelled_not_resubmitted():
    _write_legacy_job("job-batch-done", status="done", started=True)
    _write_legacy_job("job-batch-waiting", status="pending", started=False)

    listed = {job.job_id: job for job in jobs.list_jobs()}
    assert listed["job-batch-done"].cancel_requested_at is None
    waiting = listed["job-batch-waiting"]
    assert waiting.cancel_requested_at == waiting.submitted_at
    assert "batch" not in waiting.canvas_run.model_dump()


def _startup_resumable(job_ids: list[str]) -> list[str]:
    """与 server_app 启动时的续跑判据一致：仍是 pending 且还没交给 runner 的 job 会被重新提交。"""
    return [job_id for job_id in job_ids
            if (job := jobs.read_job(job_id)).status.value in {"pending", "pending_confirm"}
            and job.runner_started_at is None]


def test_restart_cancels_unstarted_batch_step_instead_of_resubmitting_it():
    from character_workflow.lib.canvas_runs import reconcile_canvas_jobs
    from character_workflow.lib.schemas import CanvasResultCandidate, JobStatus
    from tests.test_canvas_candidates import _project_with_result_node

    def pending_job(run_id: str, *, batch: bool) -> str:
        project, _document, _primary = _project_with_result_node(primary_version_id=None, active_run_id=run_id)
        job = _job(project.project_id, run_id,
                   [CanvasResultCandidate(candidate_id="candidate-0", index=0, status="pending")])
        raw = json.loads(job.model_dump_json())
        if batch:
            raw["canvas_run"]["batch"] = {"batch_id": "batch-" + "b" * 24, "item_id": "item-a",
                                          "round_index": 0, "step_index": 1}
        path = jobs._path(job.job_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        return job.job_id

    batch_step = pending_job("run-batch-step", batch=True)
    plain = pending_job("run-plain", batch=False)

    reconciled = reconcile_canvas_jobs(fail_pending=True)

    assert {batch_step, plain} <= set(reconciled)
    assert jobs.read_job(batch_step).status == JobStatus.CANCELED
    assert [candidate.status for candidate in jobs.read_job(batch_step).canvas_run.candidates] == ["canceled"]
    # 对照：没有批量来源的未开始 job 照旧在续跑名单里，说明差别来自批量来源的处理。
    assert _startup_resumable(reconciled) == [plain]
