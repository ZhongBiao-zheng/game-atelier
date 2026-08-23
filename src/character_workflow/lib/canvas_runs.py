"""Canvas generation runs: freeze drafts, transact jobs, and commit durable results."""
from __future__ import annotations

import hashlib
import json
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.canvas_projects import canvas_project_dir, read_canvas_project
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.job_runner import image_dimensions, run_job
from character_workflow.lib.jobs import (
    job_lock,
    list_jobs,
    new_job_id,
    read_job,
    update_job_status,
    write_job_under_lock,
)
from character_workflow.lib.keys import KeySpec, ModelSpec, read_keys_db
from character_workflow.lib.schemas import (
    AssetSlot,
    CanvasActor,
    CanvasContentVersion,
    CanvasDerivationConnection,
    CanvasDocument,
    CanvasGenerationDraft,
    CanvasGenerationRunOrigin,
    CanvasGenerationSnapshot,
    CanvasImageNode,
    CanvasJobContext,
    CanvasJobOutputOrigin,
    CanvasMediaDisplay,
    CanvasMediaNodeData,
    CanvasMediaVersion,
    CanvasNode,
    CanvasResultCandidate,
    CanvasSnapshotInput,
    CanvasVideoNode,
    Job,
    JobKind,
    JobParams,
    JobStatus,
)


_MENTION = re.compile(r"@\[node:([^\]]+)\]")
_OUTPUT_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _document_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / "canvas.json"


def _project_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / "project.json"


def _lock_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / ".canvas.lock"


def _transactions_dir(project_id: str) -> Path:
    target = canvas_project_dir(project_id) / ".runtime" / "transactions"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _read_document_unlocked(project_id: str) -> CanvasDocument:
    document = CanvasDocument.model_validate_json(
        _document_path(project_id).read_text(encoding="utf-8")
    )
    if document.project_id != project_id:
        raise ValueError("canvas document project_id does not match its directory")
    return document


def _canonical_sha(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _write_project_state_unlocked(project_id: str, document: CanvasDocument) -> None:
    project = read_canvas_project(project_id)
    touched = project.model_copy(update={"updated_at": document.updated_at})
    atomic_write_json(_project_path(project_id), touched.model_dump(mode="json"))
    # canvas.json is the command commit point and must be written last.
    atomic_write_json(_document_path(project_id), document.model_dump(mode="json"))


def _transaction_path(project_id: str, run_id: str) -> Path:
    return _transactions_dir(project_id) / f"{run_id}.json"


def _prepare_transaction(
    project_id: str,
    run_id: str,
    kind: str,
    before_revision: int,
    job: Job,
    document: CanvasDocument,
) -> Path:
    job_payload = job.model_dump(mode="json")
    document_payload = document.model_dump(mode="json")
    transaction = {
        "schema_version": 1,
        "state": "prepared",
        "kind": kind,
        "project_id": project_id,
        "run_id": run_id,
        "job_id": job.job_id,
        "before_revision": before_revision,
        "target_revision": document.revision,
        "job": job_payload,
        "job_sha256": _canonical_sha(job_payload),
        "document": document_payload,
        "document_sha256": _canonical_sha(document_payload),
    }
    path = _transaction_path(project_id, run_id)
    atomic_write_json(path, transaction)
    return path


def _commit_transaction_unlocked(
    project_id: str,
    run_id: str,
    kind: str,
    before_revision: int,
    job: Job,
    document: CanvasDocument,
    *,
    job_locked: bool = False,
) -> None:
    def commit() -> None:
        path = _prepare_transaction(
            project_id,
            run_id,
            kind,
            before_revision,
            job,
            document,
        )
        write_job_under_lock(job)
        _write_project_state_unlocked(project_id, document)
        atomic_write_json(
            path,
            {
                "schema_version": 1,
                "state": "committed",
                "project_id": project_id,
                "run_id": run_id,
                "job_id": job.job_id,
            },
        )
        path.unlink(missing_ok=True)

    if job_locked:
        commit()
        return
    with job_lock(job.job_id):
        commit()


def _document_has_run(document: CanvasDocument, run_id: str) -> bool:
    for node in document.nodes:
        if node.type in {"text", "image", "video", "audio"}:
            if node.data.active_run_id == run_id:
                return True
    return any(
        edge.role == "derivation"
        and edge.origin.kind == "generation_run"
        and edge.origin.run_id == run_id
        for edge in document.connections
    )


def _failed_recovered_submit(job: Job) -> Job:
    context = job.canvas_run
    if context is None or job.status not in {JobStatus.PENDING, JobStatus.PENDING_CONFIRM}:
        return job
    error = "生成提交在事务完成前中断；未自动重试以避免重复扣费"
    candidates = [
        candidate.model_copy(update={"status": "failed", "error": error})
        if candidate.status == "pending" else candidate
        for candidate in context.candidates
    ]
    return job.model_copy(update={
        "status": JobStatus.FAILED,
        "error": error,
        "completed_at": _now(),
        "progress_phase": None,
        "canvas_run": context.model_copy(update={"candidates": candidates}),
    })


def recover_canvas_transactions(project_id: str) -> None:
    """Finish a prepared job/document pair before any later canvas command."""
    with file_lock(_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)


def recover_canvas_transactions_unlocked(project_id: str) -> None:
    transactions = _transactions_dir(project_id)
    for path in sorted(transactions.glob("*.json")):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if raw.get("state") == "committed":
                if raw.get("project_id") != project_id:
                    raise ValueError("canvas transaction project mismatch")
                job_id = str(raw["job_id"])
                with job_lock(job_id):
                    try:
                        committed_job = read_job(job_id)
                    except FileNotFoundError:
                        committed_job = None
                    if committed_job is not None:
                        context = committed_job.canvas_run
                        if (
                            committed_job.namespace != "canvas"
                            or committed_job.canvas_project_id != project_id
                            or context is None
                            or context.run_id != raw.get("run_id")
                        ):
                            raise ValueError("canvas transaction job ownership mismatch")
                        recovered_job = _failed_recovered_submit(committed_job)
                        if recovered_job != committed_job:
                            write_job_under_lock(recovered_job)
                path.unlink(missing_ok=True)
                continue
            job_payload = raw["job"]
            document_payload = raw["document"]
            if _canonical_sha(job_payload) != raw["job_sha256"]:
                raise ValueError("canvas transaction job fingerprint mismatch")
            if _canonical_sha(document_payload) != raw["document_sha256"]:
                raise ValueError("canvas transaction document fingerprint mismatch")
            job = Job.model_validate(job_payload)
            recovered_job = (
                _failed_recovered_submit(job) if raw.get("kind") == "submit" else job
            )
            target = CanvasDocument.model_validate(document_payload)
            if job.canvas_project_id != project_id or target.project_id != project_id:
                raise ValueError("canvas transaction project mismatch")
            current = _read_document_unlocked(project_id)
            with job_lock(job.job_id):
                try:
                    existing_job = read_job(job.job_id)
                except FileNotFoundError:
                    existing_job = None
                job_matches = (
                    existing_job is not None
                    and _canonical_sha(existing_job.model_dump(mode="json"))
                    == raw["job_sha256"]
                )

                if (
                    existing_job is None
                    and raw.get("kind") == "submit"
                    and current.revision == raw["before_revision"]
                ):
                    # Only the prepared journal exists; neither source of truth was committed.
                    path.unlink(missing_ok=True)
                    continue
                if current.revision == raw["before_revision"]:
                    if not job_matches or recovered_job != job:
                        write_job_under_lock(recovered_job)
                    _write_project_state_unlocked(project_id, target)
                    path.unlink(missing_ok=True)
                    continue
                if (
                    current.revision >= raw["target_revision"]
                    or _document_has_run(current, raw["run_id"])
                ):
                    if not job_matches or recovered_job != job:
                        write_job_under_lock(recovered_job)
                    path.unlink(missing_ok=True)
                    continue
                raise RuntimeError(f"canvas transaction {path.name} cannot be recovered safely")
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeError(f"invalid canvas transaction {path.name}") from error


def _model_is_video(model: ModelSpec, key: KeySpec) -> bool:
    if model.modality is not None:
        return model.modality == "video"
    return "video" in key.modalities and "image" not in key.modalities


def _resolve_key_and_model(
    draft: CanvasGenerationDraft,
) -> tuple[KeySpec, ModelSpec, JobKind]:
    if draft.mode not in {"image", "video"}:
        raise ValueError("当前纵切只开放图片与视频生成")
    database = read_keys_db()
    alias = draft.alias or database.default_alias
    if not alias:
        raise ValueError("请先选择生成密钥")
    key = next((item for item in database.keys if item.alias == alias), None)
    if key is None:
        raise ValueError(f"找不到生成密钥 {alias}")
    model = next((item for item in key.models if item.id == draft.model), None)
    if model is None:
        raise ValueError("所选模型不属于当前密钥")
    kind = JobKind.VIDEO if _model_is_video(model, key) else JobKind.IMAGE
    if kind.value != draft.mode:
        raise ValueError("所选模型与节点生成类型不匹配")
    return key, model, kind


def _draft_for_node(node: CanvasNode) -> CanvasGenerationDraft | None:
    if node.type == "config":
        return node.data.draft
    if node.type in {"text", "image", "video", "audio"}:
        return node.data.generation_draft
    return None


def _current_version_id(node: CanvasNode) -> str | None:
    if node.type in {"text", "image", "video", "audio"}:
        return node.data.current_version_id
    return None


def _resolve_inputs(
    document: CanvasDocument,
    surface: CanvasNode,
    draft: CanvasGenerationDraft,
) -> list[CanvasSnapshotInput]:
    candidates: list[tuple[str, str]] = []
    self_version_id = _current_version_id(surface)
    if self_version_id is not None:
        candidates.append(("implicit_self", surface.id))

    incoming = [
        edge for edge in document.connections
        if edge.role == "input" and edge.target_node_id == surface.id
    ]
    connected_ids = list(dict.fromkeys(edge.source_node_id for edge in incoming))
    mentioned_ids = list(dict.fromkeys(_MENTION.findall(draft.prompt)))
    unknown_mentions = [node_id for node_id in mentioned_ids if node_id not in connected_ids]
    if unknown_mentions:
        raise ValueError("提示词引用了未连接到当前节点的内容")
    selected_ids = mentioned_ids
    if draft.input_policy == "all_connected":
        selected_ids.extend(node_id for node_id in connected_ids if node_id not in mentioned_ids)
    candidates.extend(("input_connection", node_id) for node_id in selected_ids)

    nodes = {node.id: node for node in document.nodes}
    resolved: list[CanvasSnapshotInput] = []
    for source, node_id in candidates:
        node = nodes.get(node_id)
        version_id = _current_version_id(node) if node is not None else None
        version = document.content_versions.get(version_id) if version_id else None
        if node is None or version is None:
            raise ValueError("生成输入缺少可用的内容版本")
        resolved.append(CanvasSnapshotInput(
            order=len(resolved),
            source=source,
            node_id=node_id,
            version_id=version.version_id,
            kind=version.kind,
        ))
    return resolved


def _render_final_prompt(
    document: CanvasDocument,
    draft: CanvasGenerationDraft,
    inputs: list[CanvasSnapshotInput],
) -> str:
    prompt = draft.prompt.strip()
    appended_text: list[str] = []
    for item in inputs:
        version = document.content_versions[item.version_id]
        marker = f"@[node:{item.node_id}]"
        if version.kind == "text":
            if marker in prompt:
                prompt = prompt.replace(marker, version.text)
            elif item.source == "input_connection":
                appended_text.append(version.text)
        elif marker in prompt:
            prompt = prompt.replace(marker, f"[{version.kind} reference {item.order + 1}]")
    if appended_text:
        prompt = f"{prompt}\n\n参考文本：\n" + "\n\n".join(appended_text)
    if not prompt.strip():
        raise ValueError("生成提示词不能为空")
    return prompt


def _input_paths(
    project_id: str,
    document: CanvasDocument,
    inputs: list[CanvasSnapshotInput],
) -> dict[str, list[str]]:
    paths: dict[str, list[str]] = {"image": [], "video": [], "audio": []}
    root = canvas_project_dir(project_id).resolve()
    for item in inputs:
        version = document.content_versions[item.version_id]
        if version.kind == "text":
            continue
        target = (root / version.path).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            raise ValueError("生成输入媒体不存在或不属于当前画布")
        paths[version.kind].append(str(target))
    return paths


def _validate_input_capabilities(
    model: ModelSpec,
    kind: JobKind,
    inputs: list[CanvasSnapshotInput],
    params: JobParams,
) -> None:
    counts = {
        media_kind: sum(item.kind == media_kind for item in inputs)
        for media_kind in ("image", "video", "audio")
    }
    if kind == JobKind.IMAGE:
        if counts["video"] or counts["audio"]:
            raise ValueError("图片生成当前只支持文本与图片输入")
        from character_workflow.lib.callers.openai_image import max_reference_images

        limit = max_reference_images(model.id)
        if counts["image"] > limit:
            raise ValueError(f"当前图片模型最多支持 {limit} 张参考图")
        return

    protocol = model.protocol
    if protocol == "seedance":
        from character_workflow.lib.video_caps import seedance_limits

        limits = seedance_limits(model.id)
        if (
            counts["image"] > limits.max_images
            or counts["video"] > limits.max_videos
            or counts["audio"] > limits.max_audios
        ):
            raise ValueError(
                f"当前 Seedance 模型最多支持 {limits.max_images} 张图、"
                f"{limits.max_videos} 个视频、{limits.max_audios} 个音频"
            )
        if (
            limits.max_mixed_references is not None
            and counts["image"] + counts["video"] + counts["audio"]
            > limits.max_mixed_references
        ):
            raise ValueError(
                f"当前 Seedance 模型混合参考素材总数不能超过 "
                f"{limits.max_mixed_references} 个"
            )
        return
    if counts["video"] or counts["audio"]:
        raise ValueError("当前视频模型只支持文本与图片输入")
    if protocol == "kling":
        limit = 2 if params.frame_mode == "firstlast" else 1
    elif protocol == "dashscope":
        normalized = model.id.lower()
        if "video-edit" in normalized:
            raise ValueError("当前画布暂不支持 HappyHorse 视频编辑输入")
        if "r2v" in normalized:
            limit = 9
            if counts["image"] == 0:
                raise ValueError("HappyHorse r2v 至少需要 1 张参考图")
        elif "i2v" in normalized:
            limit = 1
            if counts["image"] == 0:
                raise ValueError("HappyHorse i2v 需要 1 张首帧图")
        else:
            limit = 0
    elif protocol == "openrouter":
        if params.frame_mode == "firstlast":
            limit = 2
        elif params.frame_mode in {"first", "last"}:
            limit = 1
        else:
            limit = None
    else:
        raise ValueError("当前视频模型没有可用的生成协议")
    if limit is not None and counts["image"] > limit:
        raise ValueError(f"当前视频模型最多支持 {limit} 张参考图")


def _normalized_params(
    draft: CanvasGenerationDraft,
    requested_count: int,
) -> tuple[dict[str, Any], JobParams]:
    normalized = draft.params.model_dump(mode="json", exclude_none=True)
    for key in (
        "actual_size",
        "warnings",
        "requested_size",
        "reference_images",
        "reference_videos",
        "reference_audios",
    ):
        normalized.pop(key, None)
    if draft.mode == "image":
        normalized["n"] = requested_count
    else:
        if requested_count != 1:
            raise ValueError("视频生成一次只允许一个结果")
        normalized.pop("n", None)
    return normalized, JobParams(**normalized)


def _with_active_run(node: CanvasNode, run_id: str) -> CanvasNode:
    if node.type not in {"text", "image", "video", "audio"}:
        return node
    return node.model_copy(update={
        "data": node.data.model_copy(update={"active_run_id": run_id})
    })


def _new_result_node(
    surface: CanvasNode,
    draft: CanvasGenerationDraft,
    run_id: str,
    result_id: str,
) -> CanvasNode:
    width = surface.size.width if surface.size is not None else 320
    position = surface.position.model_copy(update={"x": surface.position.x + width + 120})
    common = {
        "id": result_id,
        "title": "生成图片" if draft.mode == "image" else "生成视频",
        "position": position,
        "z_index": surface.z_index,
    }
    data = CanvasMediaNodeData(
        current_version_id=None,
        generation_draft=draft,
        active_run_id=run_id,
        display=CanvasMediaDisplay(),
    )
    if draft.mode == "image":
        return CanvasImageNode(**common, data=data)
    return CanvasVideoNode(**common, data=data)


def submit_canvas_run(
    project_id: str,
    surface_node_id: str,
    expected_revision: int,
    requested_count: int = 1,
) -> tuple[Job, CanvasDocument]:
    """Atomically freeze one persisted draft into a Job and visible result surface."""
    with file_lock(_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        current = _read_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        surface = next((node for node in current.nodes if node.id == surface_node_id), None)
        if surface is None:
            raise KeyError(surface_node_id)
        draft = _draft_for_node(surface)
        if draft is None:
            raise ValueError("当前节点没有可提交的生成设置")
        key, model, kind = _resolve_key_and_model(draft)
        normalized, job_params = _normalized_params(draft, requested_count)
        inputs = _resolve_inputs(current, surface, draft)
        _validate_input_capabilities(model, kind, inputs, job_params)
        final_prompt = _render_final_prompt(current, draft, inputs)
        media_paths = _input_paths(project_id, current, inputs)
        job_params.reference_images = media_paths["image"] or None
        job_params.reference_videos = media_paths["video"] or None
        job_params.reference_audios = media_paths["audio"] or None

        timestamp = _now()
        job_id = new_job_id()
        run_id = f"run-{secrets.token_hex(12)}"
        use_surface = (
            surface.type in {"image", "video"}
            and surface.type == draft.mode
            and _current_version_id(surface) is None
        )
        result_id = surface.id if use_surface else f"{draft.mode}-{secrets.token_hex(12)}"
        snapshot_payload = {
            "snapshot_version": 1,
            "surface_node_id": surface.id,
            "result_node_id": result_id,
            "mode": draft.mode,
            "final_prompt": final_prompt,
            "input_policy": draft.input_policy,
            "model": draft.model,
            "provider": key.provider,
            "alias": key.alias,
            "normalized_params": normalized,
            "inputs": [item.model_dump(mode="json") for item in inputs],
            "mask_version_id": None,
            "submitted_at": timestamp,
            "submitted_by": CanvasActor(kind="user").model_dump(mode="json"),
        }
        snapshot = CanvasGenerationSnapshot(
            **snapshot_payload,
            request_fingerprint=_canonical_sha(snapshot_payload),
        )
        candidates = [
            CanvasResultCandidate(
                candidate_id=f"candidate-{secrets.token_hex(10)}",
                index=index,
                status="pending",
            )
            for index in range(requested_count)
        ]
        context = CanvasJobContext(
            run_id=run_id,
            snapshot=snapshot,
            result_node_id=result_id,
            candidates=candidates,
        )
        job = Job(
            job_id=job_id,
            character_id=key.alias,
            prompt=final_prompt,
            submitted_at=timestamp,
            model=draft.model,
            params=job_params,
            output_paths=[],
            status=JobStatus.PENDING,
            error=None,
            asset_slot=AssetSlot.PORTRAIT,
            kind=kind,
            namespace="canvas",
            canvas_project_id=project_id,
            canvas_run=context,
            alias=key.alias,
            provider=key.provider,
        )

        nodes = [
            _with_active_run(node, run_id) if node.id == result_id else node
            for node in current.nodes
        ]
        connections = list(current.connections)
        if result_id != surface.id:
            nodes.append(_new_result_node(surface, draft, run_id, result_id))
            connections.append(CanvasDerivationConnection(
                id=f"connection-{secrets.token_hex(12)}",
                role="derivation",
                source_node_id=surface.id,
                target_node_id=result_id,
                origin=CanvasGenerationRunOrigin(kind="generation_run", run_id=run_id),
            ))
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "nodes": nodes,
            "connections": connections,
        })
        _commit_transaction_unlocked(
            project_id,
            run_id,
            "submit",
            current.revision,
            job,
            updated,
        )
        return job, updated


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _output_version(
    project_id: str,
    job: Job,
    candidate: CanvasResultCandidate,
    output_path: str,
) -> CanvasMediaVersion:
    root = canvas_project_dir(project_id).resolve()
    raw = Path(output_path)
    target = (
        raw if raw.is_absolute() else data_root.resolve_data_root() / raw
    ).resolve()
    owned = (root / "outputs" / job.job_id).resolve()
    if not target.is_relative_to(owned) or not target.is_file():
        raise ValueError("Canvas Job 产物不属于当前 Run")
    mime_type = _OUTPUT_MIME.get(target.suffix.lower())
    if mime_type is None:
        raise ValueError("Canvas Job 返回了不支持的媒体格式")
    width: int | None = None
    height: int | None = None
    if job.kind == JobKind.IMAGE:
        dimensions = image_dimensions(target)
        if dimensions is None:
            raise ValueError("Canvas Job 返回了无效图片")
        width, height = dimensions
    return CanvasMediaVersion(
        version_id=f"version-{secrets.token_hex(12)}",
        created_at=_now(),
        sha256=_sha256_file(target),
        origin=CanvasJobOutputOrigin(
            kind="job_output",
            job_id=job.job_id,
            candidate_id=candidate.candidate_id,
        ),
        kind=job.kind.value,
        path=target.relative_to(root).as_posix(),
        mime_type=mime_type,
        bytes=target.stat().st_size,
        width=width,
        height=height,
    )


def _failed_candidates(job: Job) -> Job:
    context = job.canvas_run
    if context is None:
        return job
    candidates = [
        candidate.model_copy(update={"status": "failed", "error": job.error})
        if candidate.status == "pending" else candidate
        for candidate in context.candidates
    ]
    return job.model_copy(update={
        "canvas_run": context.model_copy(update={"candidates": candidates})
    })


def finalize_canvas_run(
    project_id: str,
    job_id: str,
) -> tuple[Job, CanvasDocument | None]:
    """Commit runner outputs as immutable versions; safe to call more than once."""
    with file_lock(_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        with job_lock(job_id):
            return _finalize_canvas_run_under_locks(project_id, job_id)


def _finalize_canvas_run_under_locks(
    project_id: str,
    job_id: str,
) -> tuple[Job, CanvasDocument | None]:
    current = _read_document_unlocked(project_id)
    job = read_job(job_id)
    if job.namespace != "canvas" or job.canvas_project_id != project_id:
        raise ValueError("job does not belong to this canvas project")
    context = job.canvas_run
    if context is None:
        raise ValueError("canvas job is missing run context")
    if job.status == JobStatus.FAILED:
        failed = _failed_candidates(job)
        write_job_under_lock(failed)
        return failed, None
    if job.status != JobStatus.DONE:
        return job, None
    if all(candidate.status != "pending" for candidate in context.candidates):
        return job, current

    versions: list[CanvasContentVersion] = []
    candidates: list[CanvasResultCandidate] = []
    try:
        for index, candidate in enumerate(context.candidates):
            if index >= len(job.output_paths):
                candidates.append(candidate.model_copy(update={
                    "status": "failed",
                    "error": "厂商没有返回这个候选结果",
                }))
                continue
            version = _output_version(project_id, job, candidate, job.output_paths[index])
            versions.append(version)
            candidates.append(candidate.model_copy(update={
                "status": "succeeded",
                "version_id": version.version_id,
                "error": None,
            }))
    except (OSError, ValueError) as error:
        failed = _failed_candidates(job.model_copy(update={
            "status": JobStatus.FAILED,
            "error": str(error),
        }))
        write_job_under_lock(failed)
        return failed, None
    successful = [candidate for candidate in candidates if candidate.status == "succeeded"]
    if not successful:
        failed = job.model_copy(update={
            "status": JobStatus.FAILED,
            "error": "Canvas Job 没有可登记的结果",
            "canvas_run": context.model_copy(update={"candidates": candidates}),
        })
        write_job_under_lock(failed)
        return failed, None

    updated_job = job.model_copy(update={
        "canvas_run": context.model_copy(update={"candidates": candidates})
    })
    primary_version_id = successful[0].version_id
    nodes: list[CanvasNode] = []
    for node in current.nodes:
        if (
            node.id == context.result_node_id
            and node.type in {"text", "image", "video", "audio"}
            and node.data.active_run_id == context.run_id
        ):
            node = node.model_copy(update={
                "data": node.data.model_copy(update={
                    "current_version_id": primary_version_id,
                })
            })
        nodes.append(node)
    timestamp = _now()
    updated = current.model_copy(update={
        "revision": current.revision + 1,
        "updated_at": timestamp,
        "nodes": nodes,
        "content_versions": {
            **current.content_versions,
            **{version.version_id: version for version in versions},
        },
    })
    _commit_transaction_unlocked(
        project_id,
        context.run_id,
        "finalize",
        current.revision,
        updated_job,
        updated,
        job_locked=True,
    )
    return updated_job, updated


def run_canvas_job(job_id: str) -> Job:
    job = read_job(job_id)
    if job.namespace != "canvas" or not job.canvas_project_id:
        raise ValueError("job is not a Canvas Run")
    try:
        run_job(job_id)
    except Exception as error:
        latest = read_job(job_id)
        if latest.status not in {JobStatus.DONE, JobStatus.FAILED}:
            update_job_status(job_id, status=JobStatus.FAILED, error=str(error))
        finalize_canvas_run(job.canvas_project_id, job_id)
        raise
    finalized, _document = finalize_canvas_run(job.canvas_project_id, job_id)
    return finalized


def reconcile_canvas_jobs(*, fail_pending: bool = False, project_id: str | None = None) -> list[str]:
    """Repair terminal Canvas Jobs; optionally fail orphaned in-flight requests on startup."""
    reconciled: list[str] = []
    for job in list_jobs():
        if job.namespace != "canvas" or not job.canvas_project_id:
            continue
        if project_id is not None and job.canvas_project_id != project_id:
            continue
        context = job.canvas_run
        if context is None or all(candidate.status != "pending" for candidate in context.candidates):
            continue
        if job.status in {JobStatus.PENDING, JobStatus.PENDING_CONFIRM}:
            if not fail_pending:
                continue
            update_job_status(
                job.job_id,
                status=JobStatus.FAILED,
                error="服务已重启，原生成请求状态未知；未自动重试以避免重复扣费",
            )
        finalize_canvas_run(job.canvas_project_id, job.job_id)
        reconciled.append(job.job_id)
    return reconciled
