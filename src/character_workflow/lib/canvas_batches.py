"""User-confirmed batch plans; every paid step remains an ordinary Canvas Job."""
from __future__ import annotations

import hashlib
import json
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.canvas_projects import (
    CanvasStorageError, canvas_project_dir, canvas_project_lock_path,
)
from character_workflow.lib.canvas_runs import (
    _current_version_id,
    _draft_for_node,
    _input_paths,
    _MENTION,
    _read_document_unlocked,
    PreparedCanvasGeneration,
    canvas_input_sources,
    commit_canvas_generation_under_lock,
    prepare_canvas_generation,
    recover_canvas_transactions_unlocked,
    request_canvas_run_cancel,
    run_canvas_job_scheduled,
)
from character_workflow.lib.file_lock import file_lock, try_file_lock
from character_workflow.lib.jobs import new_job_id, read_job
from character_workflow.lib.schemas import (
    CanvasBatchJobOrigin,
    CanvasBatchResultBinding,
    CanvasDocument,
    CanvasMediaVersion,
    CanvasInputConnection,
    CanvasNode,
    CanvasSnapshotInput,
    CanvasTextVersion,
    CanvasUserEditOrigin,
    JobStatus,
)

ACTIVE = {"running", "stopping"}
CONTENT_TYPES = {"text", "image", "video", "audio"}


class BatchModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CanvasBatchItem(BatchModel):
    id: str
    image_version_ids: list[str] = Field(default_factory=list)


class CanvasBatchStep(BatchModel):
    node_id: str
    title: str
    mode: Literal["text", "image", "video", "audio"]
    model: str


class CanvasBatchExecution(BatchModel):
    item_index: int
    round_index: int
    step_index: int
    job_id: str
    run_id: str
    result_node_id: str | None = None
    status: Literal["queued", "running", "succeeded", "failed", "canceled"] = "queued"
    version_id: str | None = None
    error: str | None = None


class CanvasBatchRun(BatchModel):
    batch_id: str = Field(pattern=r"^batch-[a-f0-9]{24}$")
    project_id: str
    scope_node_id: str
    title: str
    source_node_id: str | None = None
    expected_revision: int
    repeat_count: int
    items: list[CanvasBatchItem]
    steps: list[CanvasBatchStep]
    executions: list[CanvasBatchExecution]
    status: Literal["ready", "running", "stopping", "completed", "failed", "canceled", "interrupted"]
    created_at: str
    updated_at: str
    error: str | None = None


class CanvasBatchPlan(BatchModel):
    document: CanvasDocument
    model_signatures: dict[str, str]


class CanvasBatchCreate(BatchModel):
    scope_node_id: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)
    repeat_count: int = Field(default=1, ge=1, le=20)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _path(project_id: str, batch_id: str, *, plan: bool = False) -> Path:
    if not re.fullmatch(r"batch-[a-f0-9]{24}", batch_id):
        raise KeyError(batch_id)
    directory = "batch-plans" if plan else "batches"
    return canvas_project_dir(project_id) / ".runtime" / directory / f"{batch_id}.json"


def _save(run: CanvasBatchRun) -> None:
    run.updated_at = _now()
    atomic_write_json(_path(run.project_id, run.batch_id), run.model_dump(mode="json"))


def read_canvas_batch(project_id: str, batch_id: str) -> CanvasBatchRun:
    run = CanvasBatchRun.model_validate_json(_path(project_id, batch_id).read_text(encoding="utf-8"))
    if run.project_id != project_id or run.batch_id != batch_id:
        raise CanvasStorageError("canvas_batch_ownership_mismatch", "批量记录与项目不匹配，请检查存档")
    if run.status not in ACTIVE:
        # Job/Candidate remains authoritative if a paid result arrived after plan interruption.
        for entry in run.executions:
            if entry.status in {"running", "failed"} and entry.version_id is None:
                try:
                    _capture_result(entry)
                except FileNotFoundError:
                    pass
    return run


def list_canvas_batches(project_id: str) -> list[CanvasBatchRun]:
    directory = canvas_project_dir(project_id) / ".runtime" / "batches"
    paths = sorted(directory.glob("batch-*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    return [read_canvas_batch(project_id, path.stem) for path in paths[:20]]


def active_canvas_batch(project_id: str) -> CanvasBatchRun | None:
    pointer = canvas_project_dir(project_id) / ".runtime" / "batch-active.json"
    if not pointer.exists():
        return None
    try:
        batch_id = json.loads(pointer.read_text(encoding="utf-8"))["batch_id"]
        run = read_canvas_batch(project_id, batch_id)
    except (ValueError, KeyError, TypeError, FileNotFoundError) as error:
        raise CanvasStorageError("canvas_batch_active_corrupt", "活动批量记录损坏或缺失，请检查存档") from error
    return run if run.status in ACTIVE else None


def assert_node_not_batch_running(project_id: str, node_id: str) -> None:
    active = active_canvas_batch(project_id)
    if active and (node_id in {step.node_id for step in active.steps}
                   or node_id in {_result_node_id(active, entry) for entry in active.executions}):
        raise ValueError("这个节点正在批量执行，请先停止或等待完成")


def assert_batch_document_change(current: CanvasDocument, submitted: CanvasDocument) -> None:
    active = active_canvas_batch(current.project_id)
    if active is None:
        return
    nodes = {node.id: node for node in submitted.nodes}
    protected = {step.node_id for step in active.steps} | {active.scope_node_id}
    protected.update(_result_node_id(active, entry) for entry in active.executions)
    if active.source_node_id:
        protected.add(active.source_node_id)
    for node in current.nodes:
        if node.id not in protected:
            continue
        candidate = nodes.get(node.id)
        if candidate is None or candidate.type != node.type or candidate.data != node.data:
            raise ValueError("批量执行中的节点不能删除或修改内容，请先停止或等待完成")


def _sources(document: CanvasDocument, node: CanvasNode) -> list[str]:
    draft = _draft_for_node(node)
    if draft is None:
        return []
    return list(dict.fromkeys(source for role, source in canvas_input_sources(document, node, draft)
                             if role != "implicit_self"))


def _executable(document: CanvasDocument, node: CanvasNode) -> bool:
    if node.type not in CONTENT_TYPES:
        return False
    draft = _draft_for_node(node)
    if draft is None:
        return False
    version = document.content_versions.get(_current_version_id(node) or "")
    if node.type == "image" and version and version.origin.kind == "upload":
        return False
    return bool(draft.prompt.strip() or _sources(document, node))


def _ordered_nodes(document: CanvasDocument, scope: CanvasNode) -> list[CanvasNode]:
    member_ids = scope.data.member_node_ids if scope.type == "group" else [scope.id]
    selected = []
    for node in document.nodes:
        if node.id not in member_ids:
            continue
        binding = getattr(node.data, "batch_result", None)
        if scope.type == "group" and binding and binding.template_node_id != node.id \
                and binding.template_node_id in member_ids:
            continue
        node = node.model_copy(deep=True)
        version = document.content_versions.get(_current_version_id(node) or "")
        # Plan from the authored configuration, not an old video-edit implicit input.
        # Only selected steps are replaced in the plan; excluded references stay intact.
        if version and version.origin.kind == "job_output":
            node.data.current_version_id = None
            node.data.active_run_id = None
        if _executable(document, node):
            selected.append(node)
    if not selected:
        raise ValueError("范围内没有可执行节点，请先填写生成设置并连接输入")
    if len(selected) > 20:
        raise ValueError("一次批量执行最多包含20个生成节点")
    pending = {node.id: node for node in selected}
    result: list[CanvasNode] = []
    while pending:
        ready = [node for node in pending.values()
                 if not any(source in pending for source in _sources(document, node))]
        if not ready:
            raise ValueError("分组内存在循环连接，请断开循环后再执行")
        for node in ready:
            result.append(node)
            del pending[node.id]
    return result


def _model_signature(prepared: PreparedCanvasGeneration) -> str:
    value = {"alias": prepared.key.alias, "provider": prepared.key.provider,
             "base_url": prepared.key.base_url,
             "model": prepared.model.model_dump(mode="json")}
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def _result_node_id(run: CanvasBatchRun, entry: CanvasBatchExecution) -> str:
    if entry.item_index == 0 and entry.round_index == 0:
        return run.steps[entry.step_index].node_id
    return f"batch-result-{entry.run_id.removeprefix('run-')}"


def _row_node_ids(run: CanvasBatchRun, entry: CanvasBatchExecution) -> dict[str, str]:
    return {run.steps[other.step_index].node_id: _result_node_id(run, other)
            for other in run.executions if other.item_index == entry.item_index
            and other.round_index == entry.round_index}


def _layout_height(node: CanvasNode, document: CanvasDocument) -> float:
    height = node.size.height if node.size else (144 if node.type == "text" else 176)
    if node.type != "image" or node.data.display.free_resize:
        return height
    # Match the image surface's aspect-locked sizing in canvasNodeRenderedSize.
    width = min(4000, max(240, node.size.width if node.size else 320))
    dimensions = []
    version = document.content_versions.get(node.data.current_version_id or "")
    if isinstance(version, CanvasMediaVersion) and version.width and version.height:
        dimensions.append((version.width, version.height))
    draft = _draft_for_node(node)
    if draft:
        for value in (draft.params.size, draft.params.ratio):
            match = re.fullmatch(r"(\d+(?:\.\d+)?)[x:](\d+(?:\.\d+)?)", str(value or ""))
            if match and float(match[1]) > 0 and float(match[2]) > 0:
                dimensions.append((float(match[1]), float(match[2])))
    return max(height, *(min(4000, max(150, width * h / w))
                         for w, h in dimensions or [(1.0, 1.0)]))


def _expanded_document(
    current: CanvasDocument, run: CanvasBatchRun, plan: CanvasBatchPlan,
) -> CanvasDocument:
    """Create real result branches inside the first Job's existing document transaction."""
    templates = {node.id: node for node in plan.document.nodes
                 if node.id in {step.node_id for step in run.steps}}
    top = min(node.position.y for node in templates.values())
    bottom = max(node.position.y + _layout_height(node, plan.document)
                 for node in templates.values())
    row_height = bottom - top + 120
    nodes = list(current.nodes)
    connections = list(current.connections)
    versions = dict(current.content_versions)
    existing = {node.id: index for index, node in enumerate(nodes)}
    # Additional rows go below existing content; the configured chain remains row one.
    next_row_top = max((node.position.y + _layout_height(node, current)
                        for node in nodes if node.type != "group"), default=bottom) + 120
    for entry in run.executions:
        result_id = _result_node_id(run, entry)
        index = existing.get(result_id)
        if index is not None and getattr(nodes[index].data, "active_run_id", None) == entry.run_id:
            continue
        template = templates[run.steps[entry.step_index].node_id]
        row_ids = _row_node_ids(run, entry)
        draft = _draft_for_node(template).model_copy(deep=True)
        draft.prompt = _MENTION.sub(lambda match: f"@[node:{row_ids.get(match[1], match[1])}]",
                                   draft.prompt)
        row = entry.round_index * len(run.items) + entry.item_index
        offset_y = next_row_top - top + (row - 1) * row_height if row else 0
        item = run.items[entry.item_index]
        binding = CanvasBatchResultBinding(
            batch_id=run.batch_id, template_node_id=template.id,
            source_node_id=run.source_node_id, item_id=item.id,
            image_version_ids=item.image_version_ids, round_index=entry.round_index,
        )
        display_version = (_current_version_id(nodes[index])
                           if index is not None else _current_version_id(template))
        if template.type == "text" and display_version is None:
            # Empty text is real document content, not a client-created unsaved edit.
            display_version = f"version-{secrets.token_hex(12)}"
            versions[display_version] = CanvasTextVersion(
                version_id=display_version, kind="text", text="", created_at=_now(),
                sha256=hashlib.sha256(b"").hexdigest(),
                origin=CanvasUserEditOrigin(kind="user_edit"),
            )
        result = template.model_copy(update={
            "id": result_id,
            "position": template.position.model_copy(update={"y": template.position.y + offset_y}),
            "data": template.data.model_copy(update={
                "current_version_id": display_version,
                "active_run_id": None,
                "generation_draft": draft, "batch_result": binding,
            }),
        })
        if index is None:
            nodes.append(result)
        else:
            nodes[index] = result
        entry.result_node_id = result_id
        for edge in plan.document.connections:
            if edge.role != "input" or edge.target_node_id != template.id:
                continue
            source_id = row_ids.get(edge.source_node_id, edge.source_node_id)
            if any(other.source_node_id == source_id and other.target_node_id == result_id
                   and other.role == "input" and other.slot == edge.slot for other in connections):
                continue
            connections.append(CanvasInputConnection(
                id=f"connection-{secrets.token_hex(12)}", role="input",
                source_node_id=source_id, target_node_id=result_id, slot=edge.slot,
            ))
    added_ids = [_result_node_id(run, entry) for entry in run.executions]
    for index, node in enumerate(nodes):
        if node.type == "group" and node.id == run.scope_node_id:
            nodes[index] = node.model_copy(update={"data": node.data.model_copy(update={
                "member_node_ids": list(dict.fromkeys([*node.data.member_node_ids, *added_ids])),
            })})
    return CanvasDocument.model_validate(current.model_copy(
        update={"nodes": nodes, "connections": connections,
                "content_versions": versions}).model_dump(mode="json"))


def _preview_document(
    document: CanvasDocument, steps: list[CanvasNode],
) -> tuple[CanvasDocument, dict[str, list[str]]]:
    versions = dict(document.content_versions)
    bindings: dict[str, list[str]] = {}
    for node in steps:
        version_id = f"batch-preview-{node.id}"
        common = {"version_id": version_id, "created_at": _now(), "sha256": "0" * 64,
                  "origin": CanvasUserEditOrigin(kind="user_edit")}
        if node.type == "text":
            version = CanvasTextVersion(**common, kind="text", text="本项上游文本")
        else:
            version = CanvasMediaVersion(**common, kind=node.type, path="uploads/batch-preview",
                                         mime_type={"image": "image/png", "video": "video/mp4",
                                                    "audio": "audio/mpeg"}[node.type], bytes=1)
        versions[version_id] = version
        bindings[node.id] = [version_id]
    return document.model_copy(update={"content_versions": versions}), bindings


def prepare_canvas_batch(project_id: str, payload: CanvasBatchCreate) -> CanvasBatchRun:
    with file_lock(canvas_project_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        current = _read_document_unlocked(project_id)
        if current.revision != payload.expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        if active_canvas_batch(project_id):
            raise ValueError("此画布已有批量执行，请先停止或等待完成")
        scope = next((node for node in current.nodes if node.id == payload.scope_node_id), None)
        if scope is None:
            raise KeyError(payload.scope_node_id)
        steps = _ordered_nodes(current, scope)
        steps_by_id = {node.id: node for node in steps}
        step_ids = set(steps_by_id)
        planning = current.model_copy(update={"nodes": [steps_by_id.get(node.id, node)
                                                       for node in current.nodes]})
        required = step_ids | {source for node in steps for source in _sources(planning, node)}
        sources = [node for node in current.nodes
                   if node.id in required and node.type == "batch_material"]
        if len(sources) > 1:
            raise ValueError("一个执行范围只能使用一个批量素材节点")
        source = sources[0] if sources else None
        if source and not source.data.items:
            raise ValueError("批量素材还没有图片")
        items = ([CanvasBatchItem.model_validate(item.model_dump()) for item in source.data.items]
                 if source else [CanvasBatchItem(id="fixed")])
        if len(items) * payload.repeat_count * len(steps) > 2000:
            raise ValueError("一次批量执行最多2000次生成，请减少素材、轮数或节点")
        frozen_nodes = [node for node in planning.nodes if node.id in required]
        version_ids = {_current_version_id(node) for node in frozen_nodes}
        version_ids.update(version_id for item in items for version_id in item.image_version_ids)
        version_ids.update(version_id for node in frozen_nodes
                           if getattr(node.data, "batch_result", None)
                           for version_id in node.data.batch_result.image_version_ids)
        frozen = CanvasDocument.model_validate(current.model_copy(update={
            "nodes": frozen_nodes,
            "connections": [edge for edge in current.connections if edge.role == "input"
                            and edge.target_node_id in step_ids and edge.source_node_id in required],
            "content_versions": {key: value for key, value in current.content_versions.items()
                                 if key in version_ids},
        }).model_dump(mode="json"))
        frozen_by_id = {node.id: node for node in frozen.nodes}
        steps = [frozen_by_id[node.id] for node in steps]
        # Resolve all existing files before any paid step; downstream placeholders never leave preflight.
        _input_paths(project_id, frozen, [CanvasSnapshotInput(
            order=index, source="input_connection", node_id="preflight", version_id=key,
            kind=version.kind,
        ) for index, (key, version) in enumerate(frozen.content_versions.items())])
        preview, possible_bindings = _preview_document(frozen, steps)
        signatures: dict[str, str] = {}
        for item in items:
            completed: dict[str, list[str]] = {}
            if source:
                completed[source.id] = item.image_version_ids
            for node in steps:
                draft = _draft_for_node(node)
                if draft.params.n not in (None, 1):
                    raise ValueError(f"「{node.title}」请设为每项1个产物，多候选暂不参与批量执行")
                prepared = prepare_canvas_generation(project_id, preview, node,
                    version_bindings=completed, resolve_media_paths=False)
                if prepared.requested_count != 1:
                    raise ValueError(f"「{node.title}」模型固定返回多个候选，暂不支持批量链路")
                signatures[node.id] = _model_signature(prepared)
                draft.alias = prepared.key.alias
                draft.model = prepared.model.id
                completed[node.id] = possible_bindings[node.id]
        timestamp = _now()
        batch_id = f"batch-{secrets.token_hex(12)}"
        run = CanvasBatchRun(
            batch_id=batch_id, project_id=project_id, scope_node_id=scope.id, title=scope.title,
            source_node_id=source.id if source else None, expected_revision=current.revision,
            repeat_count=payload.repeat_count, items=items,
            steps=[CanvasBatchStep(node_id=node.id, title=node.title,
                                   mode=node.type, model=_draft_for_node(node).model) for node in steps],
            executions=[CanvasBatchExecution(item_index=item_index, round_index=round_index,
                         step_index=step_index, job_id=new_job_id(),
                         run_id=f"run-{secrets.token_hex(12)}")
                        for round_index in range(payload.repeat_count)
                        for item_index in range(len(items)) for step_index in range(len(steps))],
            status="ready", created_at=timestamp, updated_at=timestamp,
        )
        plan = CanvasBatchPlan(document=frozen, model_signatures=signatures)
        atomic_write_json(_path(project_id, batch_id, plan=True), plan.model_dump(mode="json"))
        _save(run)
        return run


def start_canvas_batch(project_id: str, batch_id: str) -> tuple[CanvasBatchRun, bool]:
    with file_lock(canvas_project_lock_path(project_id)):
        run = read_canvas_batch(project_id, batch_id)
        if run.status != "ready":
            return run, False
        current = _read_document_unlocked(project_id)
        if current.revision != run.expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        if active_canvas_batch(project_id):
            raise ValueError("此画布已有批量执行，请先停止或等待完成")
        active_nodes = [node for node in current.nodes
                        if node.id in {step.node_id for step in run.steps}]
        for node in active_nodes:
            active_run = getattr(node.data, "active_run_id", None)
            if active_run:
                from character_workflow.lib.canvas_runs import _job_for_run

                if _job_for_run(project_id, active_run).status == JobStatus.PENDING:
                    raise ValueError(f"「{node.title}」仍在生成，请等待完成")
        atomic_write_json(canvas_project_dir(project_id) / ".runtime" / "batch-active.json",
                          {"batch_id": batch_id})
        run.status = "running"
        _save(run)
        return run, True


def cancel_canvas_batch(project_id: str, batch_id: str) -> CanvasBatchRun:
    with file_lock(canvas_project_lock_path(project_id)):
        run = read_canvas_batch(project_id, batch_id)
        if run.status not in ACTIVE | {"ready"}:
            return run
        running = next((entry for entry in run.executions if entry.status == "running"), None)
        run.status = "stopping" if running else "canceled"
        for entry in run.executions:
            if entry.status == "queued":
                entry.status = "canceled"
        _save(run)
    if running:
        request_canvas_run_cancel(project_id, running.run_id)
    return run


def _capture_result(entry: CanvasBatchExecution) -> None:
    job = read_job(entry.job_id)
    if job.status in {JobStatus.PENDING, JobStatus.PENDING_CONFIRM}:
        entry.status = "running"
        return
    candidates = job.canvas_run.candidates if job.canvas_run else []
    succeeded = [candidate for candidate in candidates
                 if candidate.status == "succeeded" and candidate.version_id]
    if job.status == JobStatus.DONE and len(succeeded) == 1:
        entry.status = "succeeded"
        entry.version_id = succeeded[0].version_id
        entry.error = None
    else:
        entry.status = "canceled" if job.status == JobStatus.CANCELED else "failed"
        entry.error = job.error or "这一步未取得可确认的结果，后续步骤未执行"


def run_canvas_batch(project_id: str, batch_id: str) -> None:
    try:
        _run_canvas_batch(project_id, batch_id)
    except Exception as error:
        # A malformed frozen plan or a filesystem failure must not leave a plan apparently
        # running forever. Never replay a step whose submission outcome is uncertain.
        with file_lock(canvas_project_lock_path(project_id)):
            run = read_canvas_batch(project_id, batch_id)
            if run.status in ACTIVE:
                _fail_remaining(run, f"批量执行中断，请核对已有结果：{error}")


def _run_canvas_batch(project_id: str, batch_id: str) -> None:
    lock_path = data_root.runtime_dir() / "locks" / f"canvas-batch-worker-{project_id}.lock"
    with try_file_lock(lock_path) as acquired:
        if not acquired:
            return
        plan = CanvasBatchPlan.model_validate_json(
            _path(project_id, batch_id, plan=True).read_text(encoding="utf-8"))
        while True:
            with file_lock(canvas_project_lock_path(project_id)):
                run = read_canvas_batch(project_id, batch_id)
                if run.status != "running":
                    return
                entry = next((candidate for candidate in run.executions
                              if candidate.status == "queued"), None)
                if entry is None:
                    run.status = "completed"
                    _save(run)
                    return
                try:
                    recover_canvas_transactions_unlocked(project_id)
                    current = _read_document_unlocked(project_id)
                    if entry == run.executions[0]:
                        current = _expanded_document(current, run, plan)
                    row_ids = _row_node_ids(run, entry)
                    bindings = {row_ids[run.steps[previous.step_index].node_id]: [previous.version_id]
                                for previous in run.executions
                                if previous.round_index == entry.round_index
                                and previous.item_index == entry.item_index
                                and previous.status == "succeeded"}
                    item = run.items[entry.item_index]
                    if run.source_node_id:
                        bindings[run.source_node_id] = item.image_version_ids
                    # Planning already removes old generated outputs; genuine authored
                    # source content must remain the same implicit input for every row.
                    frozen_self_versions = {row_ids[node.id]: _current_version_id(node)
                                            for node in plan.document.nodes if node.id in row_ids}
                    virtual = plan.document.model_copy(update={
                        "nodes": [node for node in plan.document.nodes if node.id not in row_ids]
                        + [node.model_copy(update={"data": node.data.model_copy(update={
                            "current_version_id": frozen_self_versions[node.id],
                        })}) for node in current.nodes if node.id in row_ids.values()],
                        "connections": [edge.model_copy(update={
                            "source_node_id": row_ids.get(edge.source_node_id, edge.source_node_id),
                            "target_node_id": row_ids.get(edge.target_node_id, edge.target_node_id),
                        }) for edge in plan.document.connections],
                        "content_versions": {**plan.document.content_versions,
                                             **current.content_versions},
                    })
                    node = next(node for node in virtual.nodes
                                if node.id == _result_node_id(run, entry))
                    if not any(candidate.id == node.id for candidate in current.nodes):
                        raise ValueError("执行节点已不存在，批量执行停止")
                    prepared = prepare_canvas_generation(project_id, virtual, node,
                                                         version_bindings=bindings)
                    if _model_signature(prepared) != plan.model_signatures[run.steps[entry.step_index].node_id]:
                        raise ValueError("模型配置已改变，请重新确认后执行")
                    try:
                        read_job(entry.job_id)
                    except FileNotFoundError:
                        pass
                    else:
                        raise ValueError("这一步已有提交记录，已停止以避免重复计费，请核对生成历史")
                    commit_canvas_generation_under_lock(project_id, current, node, prepared,
                        job_id=entry.job_id, run_id=entry.run_id,
                        batch_origin=CanvasBatchJobOrigin(batch_id=batch_id, item_id=item.id,
                            round_index=entry.round_index, step_index=entry.step_index))
                    entry.status = "running"
                    _save(run)
                except Exception as error:
                    entry.status = "failed"
                    entry.error = str(error)
                    _fail_remaining(run, str(error))
                    return
            try:
                run_canvas_job_scheduled(entry.job_id)
            except Exception:
                # The existing runner records its own failure and any paid output; never resubmit.
                pass
            with file_lock(canvas_project_lock_path(project_id)):
                run = read_canvas_batch(project_id, batch_id)
                entry = next(candidate for candidate in run.executions if candidate.job_id == entry.job_id)
                _capture_result(entry)
                if run.status == "stopping":
                    run.status = "canceled"
                    _save(run)
                    return
                if entry.status != "succeeded":
                    _fail_remaining(run, entry.error or "批量执行已停止")
                    return
                _save(run)


def _fail_remaining(run: CanvasBatchRun, error: str) -> None:
    run.status = "failed"
    run.error = error
    for entry in run.executions:
        if entry.status == "queued":
            entry.status = "canceled"
    _save(run)


def interrupt_canvas_batch_after_restart(project_id: str) -> None:
    """Never resume unsubmitted paid steps after a process restart."""
    with file_lock(canvas_project_lock_path(project_id)):
        run = active_canvas_batch(project_id)
        if run is None:
            return
        for entry in run.executions:
            if entry.status in {"queued", "running"}:
                try:
                    _capture_result(entry)
                except FileNotFoundError:
                    entry.status = "canceled"
        run.status = "interrupted"
        run.error = "服务已重启，未提交的步骤没有自动继续；请先核对已有结果"
        _save(run)


def assert_no_active_canvas_batch(project_id: str) -> None:
    if active_canvas_batch(project_id):
        raise ValueError("画布仍有批量执行，请停止或等待完成后重试")
