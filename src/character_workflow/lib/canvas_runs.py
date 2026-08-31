"""Canvas generation runs: freeze drafts, transact jobs, and commit durable results."""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from contextlib import nullcontext
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import BoundedSemaphore, Lock
from typing import Any, Literal

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json
from character_workflow.lib.canvas_projects import (
    canvas_project_dir,
    canvas_project_lock_path,
    read_canvas_project,
)
from character_workflow.lib.canvas_ui import (
    CanvasUiPreferencesError,
    read_canvas_ui_preferences,
)
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.job_runner import (
    JobExecutionBusy,
    image_dimensions,
    is_valid_audio,
    run_job,
)
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
    CanvasBatchJobOrigin,
    CanvasContentVersion,
    CanvasConfigNode,
    CanvasConfigNodeData,
    CanvasDerivationConnection,
    CanvasDocument,
    CanvasGenerationDraft,
    CanvasGenerationRunOrigin,
    CanvasGenerationSnapshot,
    CanvasAudioNode,
    CanvasContentNodeData,
    CanvasImageNode,
    CanvasInputConnection,
    CanvasJobContext,
    CanvasJobOutputOrigin,
    CanvasMediaDisplay,
    CanvasMediaNodeData,
    CanvasMediaVersion,
    CanvasNode,
    CanvasResultCandidate,
    CanvasSnapshotInput,
    CanvasTextNode,
    CanvasTextNodeData,
    CanvasTextVersion,
    CanvasUserMaskOrigin,
    CanvasVideoNode,
    Job,
    JobKind,
    JobParams,
    JobStatus,
    canvas_allowed_draft_params,
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
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".opus": "audio/ogg",
    ".aac": "audio/aac",
    ".pcm": "audio/pcm",
}
_RUN_GLOBAL_GATE = BoundedSemaphore(4)
_RUN_VIDEO_GATE = BoundedSemaphore(1)
_RUN_ALIAS_GATES: dict[str, BoundedSemaphore] = {}
_RUN_ALIAS_GATES_LOCK = Lock()
_REVERSE_PROMPT_PRESET_ID = "canvas.reverse_prompt"
_REVERSE_PROMPT_PRESET_VERSION = 1
_ANGLE_PROMPT_PRESET_ID = "canvas.angle_edit"
_ANGLE_PROMPT_PRESET_VERSION = 1
_REVERSE_PROMPT = (
    "分析唯一附带的图片，写出一段可以直接用于图像生成模型的中文提示词。"
    "准确描述主体、动作或状态、构图、场景、光线、色彩、材质、镜头视角与画面风格；"
    "只写图中能够判断的内容，不虚构品牌、人物身份或文字含义。"
    "不要解释分析过程，不要使用标题、列表、Markdown，也不要提到‘这张图’或‘参考图’。"
)


class CanvasRunCommandError(Exception):
    """Stable, user-facing rejection from a specialized Canvas Run command."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _document_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / "canvas.json"


def _project_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / "project.json"


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
    artifacts: list[dict[str, Any]] | None = None,
) -> Path:
    job_payload = job.model_dump(mode="json")
    document_payload = document.model_dump(mode="json")
    transaction = {
        "schema_version": 2,
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
        "artifacts": artifacts or [],
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
    artifacts: list[dict[str, Any]] | None = None,
) -> None:
    if kind in {"submit", "reverse_prompt", "mask_edit", "angle"} and job.canvas_run \
            and job.canvas_run.batch is None:
        from character_workflow.lib.canvas_batches import assert_node_not_batch_running

        assert_node_not_batch_running(project_id, job.canvas_run.snapshot.surface_node_id)
    def commit() -> None:
        path = _prepare_transaction(
            project_id,
            run_id,
            kind,
            before_revision,
            job,
            document,
            artifacts,
        )
        _install_transaction_artifacts(project_id, artifacts or [])
        write_job_under_lock(job)
        _write_project_state_unlocked(project_id, document)
        atomic_write_json(
            path,
            {
                "schema_version": 2,
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


def _artifact_path(project_id: str, raw: str) -> Path:
    root = canvas_project_dir(project_id).resolve()
    target = (root / raw).resolve()
    if not target.is_relative_to(root) or target == root:
        raise ValueError("canvas transaction artifact path is outside project")
    return target


def _validate_transaction_artifact(project_id: str, raw: dict[str, Any]) -> tuple[Path, Path]:
    staged = _artifact_path(project_id, str(raw["staged_path"]))
    final = _artifact_path(project_id, str(raw["final_path"]))
    expected_sha = str(raw["sha256"])
    expected_bytes = int(raw["bytes"])
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha) or expected_bytes < 0:
        raise ValueError("canvas transaction artifact fingerprint is invalid")
    return staged, final


def _artifact_matches(path: Path, raw: dict[str, Any]) -> bool:
    return (
        path.is_file()
        and path.stat().st_size == int(raw["bytes"])
        and _sha256_file(path) == raw["sha256"]
    )


def _install_transaction_artifacts(project_id: str, artifacts: list[dict[str, Any]]) -> None:
    for raw in artifacts:
        staged, final = _validate_transaction_artifact(project_id, raw)
        if _artifact_matches(final, raw):
            staged.unlink(missing_ok=True)
            continue
        if not _artifact_matches(staged, raw):
            raise ValueError("canvas transaction artifact is missing or changed")
        final.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staged, final)
        if not _artifact_matches(final, raw):
            raise ValueError("canvas transaction artifact could not be installed")


def _remove_transaction_artifacts(
    project_id: str,
    artifacts: list[dict[str, Any]],
    *,
    include_final: bool,
) -> None:
    for raw in artifacts:
        staged, final = _validate_transaction_artifact(project_id, raw)
        staged.unlink(missing_ok=True)
        if include_final and _artifact_matches(final, raw):
            final.unlink(missing_ok=True)


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
    with file_lock(canvas_project_lock_path(project_id)):
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
            artifacts = raw.get("artifacts", [])
            if not isinstance(artifacts, list) or not all(
                isinstance(item, dict) for item in artifacts
            ):
                raise ValueError("canvas transaction artifacts are invalid")
            for artifact in artifacts:
                _validate_transaction_artifact(project_id, artifact)
            if _canonical_sha(job_payload) != raw["job_sha256"]:
                raise ValueError("canvas transaction job fingerprint mismatch")
            if _canonical_sha(document_payload) != raw["document_sha256"]:
                raise ValueError("canvas transaction document fingerprint mismatch")
            job = Job.model_validate(job_payload)
            creates_run = raw.get("kind") in {
                "submit", "reverse_prompt", "mask_edit", "angle"
            }
            recovered_job = _failed_recovered_submit(job) if creates_run else job
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
                    and creates_run
                    and current.revision == raw["before_revision"]
                ):
                    # Only the prepared journal exists; neither source of truth was committed.
                    _remove_transaction_artifacts(
                        project_id,
                        artifacts,
                        include_final=True,
                    )
                    path.unlink(missing_ok=True)
                    continue
                if current.revision == raw["before_revision"]:
                    _install_transaction_artifacts(project_id, artifacts)
                    if not job_matches or recovered_job != job:
                        write_job_under_lock(recovered_job)
                    _write_project_state_unlocked(project_id, target)
                    path.unlink(missing_ok=True)
                    continue
                if (
                    current.revision >= raw["target_revision"]
                    or _document_has_run(current, raw["run_id"])
                ):
                    _install_transaction_artifacts(project_id, artifacts)
                    if not job_matches or recovered_job != job:
                        write_job_under_lock(recovered_job)
                    path.unlink(missing_ok=True)
                    continue
                raise RuntimeError(f"canvas transaction {path.name} cannot be recovered safely")
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeError(f"invalid canvas transaction {path.name}") from error


def _model_modality(model: ModelSpec, key: KeySpec) -> str:
    if model.modality is not None:
        return model.modality
    modalities = set(key.modalities)
    if modalities == {"video"}:
        return "video"
    if modalities == {"audio"}:
        return "audio"
    if modalities == {"llm"}:
        return "text"
    return "image"


def _keys_default_first() -> list[KeySpec]:
    database = read_keys_db()
    return sorted(
        database.keys,
        key=lambda key: 0 if key.alias == database.default_alias else 1,
    )


def _supports_openai_text(key: KeySpec, model: ModelSpec) -> bool:
    from character_workflow.lib.callers.openai_text import supports_model

    return supports_model(key, model)


def _supports_openai_speech(key: KeySpec, model: ModelSpec) -> bool:
    from character_workflow.lib.callers.openai_audio import supports_model

    return supports_model(key, model)


def _resolve_reverse_prompt_model() -> tuple[KeySpec, ModelSpec]:
    for key in _keys_default_first():
        for model in key.models:
            if (
                _model_modality(model, key) == "text"
                and "image" in model.input_modalities
                and _supports_openai_text(key, model)
            ):
                return key, model
    raise CanvasRunCommandError(
        "canvas_reverse_prompt_model_missing",
        "未配置支持图片输入的文本模型。请在设置中为兼容模型开启“支持图片输入”。",
    )


def _supports_canvas_image_generation(key: KeySpec, model: ModelSpec) -> bool:
    from character_workflow.lib.callers.openai_image import image_family, resolve_image_protocol

    if _model_modality(model, key) != "image" or key.provider == "nano_banana":
        return False
    if image_family(model.id) == "midjourney" or key.provider == "openrouter":
        return True
    if key.provider not in {"openai", "midjourney", "seedream", "tokendance", "custom"}:
        return False
    protocol = model.protocol or resolve_image_protocol(key.provider, key.base_url, model.id)
    return protocol in {None, "openai", "ark"}


def _normalized_image_preference_params(
    key: KeySpec,
    model: ModelSpec,
    params: dict[str, Any],
) -> JobParams:
    from character_workflow.lib.callers.openai_image import (
        image_family,
        normalize_image_pixel_size,
        normalized_model_id,
        resolve_image_protocol,
    )

    family = image_family(model.id)
    ratios = {
        "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3",
        *(("21:9",) if family != "nano-banana" else ()),
    }
    ratio = str(params.get("ratio") or "1:1")
    if ratio not in ratios:
        ratio = "1:1"
    count = 4 if family == "midjourney" else max(1, min(4, int(params.get("n") or 1)))
    normalized: dict[str, Any] = {"n": count, "ratio": ratio}

    quality = params.get("quality")
    if family in {"gpt-image", "nano-banana"} and quality in {
        "low", "medium", "high", "auto",
    }:
        normalized["quality"] = quality
    if family == "midjourney":
        return JobParams.model_validate(normalized)
    if key.provider == "openrouter" or family == "nano-banana":
        normalized["size"] = ratio
        return JobParams.model_validate(normalized)

    size = params.get("size")
    if isinstance(size, str) and re.fullmatch(r"\d+x\d+", size):
        normalized["size"] = normalize_image_pixel_size(model.id, size)
    if family in {"seedream", "standard"}:
        resolutions = {"2K", "4K"}
        if "seedream-5-0-pro" in normalized_model_id(model.id):
            resolutions = {"2K"}
        resolution = str(params.get("resolution") or "2K").upper()
        normalized["resolution"] = resolution if resolution in resolutions else "2K"
    if family == "gpt-image":
        protocol = model.protocol or resolve_image_protocol(
            key.provider,
            key.base_url,
            model.id,
        )
        background = params.get("background")
        if protocol in {None, "openai"} and background in {
            "auto", "opaque", "transparent",
        }:
            normalized["background"] = background
    return JobParams.model_validate(normalized)


def _resolve_default_image_model() -> tuple[KeySpec, ModelSpec, JobParams]:
    keys = _keys_default_first()
    try:
        preference = read_canvas_ui_preferences().generation_defaults.image
    except CanvasUiPreferencesError as error:
        raise CanvasRunCommandError(
            "canvas_ui_preferences_invalid",
            "画布生成偏好文件损坏，请先在画布中重新保存生成偏好。",
        ) from error
    if preference.selection is not None:
        for key in keys:
            if key.alias != preference.selection.alias:
                continue
            for model in key.models:
                if (
                    model.id == preference.selection.model
                    and _supports_canvas_image_generation(key, model)
                ):
                    return key, model, _normalized_image_preference_params(
                        key,
                        model,
                        preference.params,
                    )
    for key in keys:
        for model in key.models:
            if _supports_canvas_image_generation(key, model):
                params = preference.params if preference.selection is None else {}
                return key, model, _normalized_image_preference_params(key, model, params)
    raise CanvasRunCommandError(
        "canvas_image_default_missing",
        "未配置可用的图片生成模型；反推文本已保留，请先在设置中接入图片模型。",
    )


def _resolve_default_image_edit_model() -> tuple[KeySpec, ModelSpec]:
    from character_workflow.lib.callers.openai_image import max_reference_images

    for key in _keys_default_first():
        for model in key.models:
            if (
                _model_modality(model, key) == "image"
                and max_reference_images(model.id) >= 1
            ):
                return key, model
    raise CanvasRunCommandError(
        "canvas_angle_model_missing",
        "未配置支持参考图片的生成模型。请先在设置中接入可进行图片编辑的模型。",
    )


def _resolve_key_and_model(
    draft: CanvasGenerationDraft,
) -> tuple[KeySpec, ModelSpec, JobKind]:
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
    kind = JobKind(_model_modality(model, key))
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


def _uses_video_frame_slots(draft: CanvasGenerationDraft) -> bool:
    return draft.mode == "video" and draft.params.frame_mode in {"first", "last", "firstlast"}


def canvas_input_sources(
    document: CanvasDocument,
    surface: CanvasNode,
    draft: CanvasGenerationDraft,
) -> list[tuple[str, str]]:
    """Select source nodes once, shared by batch dependency planning and input freezing."""
    candidates: list[tuple[str, str]] = []
    self_version_id = _current_version_id(surface)
    if self_version_id is not None and draft.mode != "audio":
        candidates.append(("implicit_self", surface.id))

    editing_existing_video = (
        surface.type == "video"
        and draft.mode == "video"
        and self_version_id is not None
    )
    if editing_existing_video and _uses_video_frame_slots(draft):
        raise ValueError("已有视频的再次编辑只支持全能参考模式")
    if editing_existing_video and _MENTION.search(draft.prompt):
        raise ValueError("视频编辑只使用当前视频，不接受其它节点引用")

    incoming = [
        edge for edge in document.connections
        if edge.role == "input" and edge.target_node_id == surface.id
    ]
    if editing_existing_video:
        incoming = []
    uses_video_frame_slots = _uses_video_frame_slots(draft)
    if uses_video_frame_slots:
        if _MENTION.search(draft.prompt):
            raise ValueError("首尾帧模式不支持 @ 引用，请删除引用后再生成")
        for slot in ("first_frame", "last_frame"):
            edges = [edge for edge in incoming if edge.slot == slot]
            if len(edges) > 1:
                raise ValueError("首帧或尾帧只能连接一个图片素材")
            if edges:
                candidates.append((slot, edges[0].source_node_id))
    else:
        # Slot connections belong exclusively to first/last-frame mode. A stale slot left by an
        # interrupted client update must never silently change an omni-reference request.
        incoming = [edge for edge in incoming if edge.slot is None]
        connected_ids = list(dict.fromkeys(edge.source_node_id for edge in incoming))
        mentioned_ids = list(dict.fromkeys(_MENTION.findall(draft.prompt)))
        unknown_mentions = [node_id for node_id in mentioned_ids if node_id not in connected_ids]
        if unknown_mentions:
            raise ValueError("提示词引用了未连接到当前节点的内容")
        selected_ids = mentioned_ids
        if draft.input_policy == "all_connected":
            selected_ids.extend(node_id for node_id in connected_ids if node_id not in mentioned_ids)
        candidates.extend(("input_connection", node_id) for node_id in selected_ids)

    return candidates


def _resolve_inputs(
    document: CanvasDocument,
    surface: CanvasNode,
    draft: CanvasGenerationDraft,
    version_bindings: dict[str, list[str]] | None = None,
) -> list[CanvasSnapshotInput]:
    candidates = canvas_input_sources(document, surface, draft)

    nodes = {node.id: node for node in document.nodes}
    resolved: list[CanvasSnapshotInput] = []
    for source, node_id in candidates:
        node = nodes.get(node_id)
        if node is not None and node.type == "batch_material" and version_bindings is None:
            raise ValueError("批量素材需要通过批量执行提交")
        version_id = _current_version_id(node) if node is not None else None
        version_ids = (version_bindings or {}).get(node_id, [version_id] if version_id else [])
        if node is None or not version_ids or any(
            item not in document.content_versions for item in version_ids
        ):
            # 「先连线，后逐个生成」是画布上最自然的用法，所以这条错误是常态而不是异常路径：
            # 不指名是哪个节点，用户既不知道要先生成谁，也不知道要断开哪条连线。
            title = node.title if node is not None else node_id
            if source in {"first_frame", "last_frame"}:
                slot_label = "首帧" if source == "first_frame" else "尾帧"
                raise ValueError(f"{slot_label}连接的「{title}」还没有内容，先把它生成出来再提交")
            raise ValueError(f"已连接的「{title}」还没有内容，先把它生成出来，或断开这条连接")
        if source in {"first_frame", "last_frame"} and len(version_ids) != 1:
            raise ValueError("首帧或尾帧只能使用一张图片")
        for selected_id in version_ids:
            version = document.content_versions[selected_id]
            if source in {"first_frame", "last_frame"} and version.kind != "image":
                raise ValueError("首帧和尾帧只能选择图片素材")
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
    media_labels: list[str] = []
    kind_counts = {"text": 0, "image": 0, "video": 0, "audio": 0}
    replacements: dict[str, list[str]] = {}
    # Draft tokens are stable node IDs. Labels are rebuilt only after the current graph and
    # concrete versions have been frozen, so reconnecting or reordering cannot misaddress media.
    for item in inputs:
        version = document.content_versions[item.version_id]
        kind_counts[version.kind] += 1
        label = _input_label(version.kind, kind_counts[version.kind])
        marker = f"@[node:{item.node_id}]"
        if version.kind == "text":
            replacements.setdefault(marker, []).append(f"【{label}】")
            appended_text.append(f"【{label}】\n{version.text}")
        else:
            media_labels.append(label)
            replacements.setdefault(marker, []).append(label)
    for marker, labels in replacements.items():
        prompt = prompt.replace(marker, "、".join(labels))
    semantic_video_frames = any(
        item.source in {"first_frame", "last_frame"}
        for item in inputs
    )
    if media_labels and not semantic_video_frames:
        prompt = (
            f"参考素材编号：{'、'.join(media_labels)}。请按这些编号理解提示词中的引用。"
            f"\n\n{prompt}"
        )
    if appended_text:
        prompt = f"{prompt}\n\n参考文本：\n" + "\n\n".join(appended_text)
    if not prompt.strip():
        raise ValueError("生成提示词不能为空")
    return prompt


def _input_label(kind: str, index: int) -> str:
    return {
        "text": "文本",
        "image": "图片",
        "video": "视频",
        "audio": "音频",
    }[kind] + str(index)


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
    provider: str | None = None,
) -> None:
    counts = {
        media_kind: sum(item.kind == media_kind for item in inputs)
        for media_kind in ("image", "video", "audio")
    }
    if kind == JobKind.TEXT:
        unsupported = [
            media_kind
            for media_kind in ("image", "video", "audio")
            if counts[media_kind] and media_kind not in model.input_modalities
        ]
        if unsupported:
            labels = {"image": "图片", "video": "视频", "audio": "音频"}
            raise ValueError(f"当前模型不支持{'、'.join(labels[item] for item in unsupported)}输入")
        if provider is not None:
            from character_workflow.lib.callers.openai_text import supports_input_modality

            unsupported_transport = [
                media_kind
                for media_kind in ("image", "video", "audio")
                if counts[media_kind]
                and not supports_input_modality(provider, model.protocol, media_kind)
            ]
            if unsupported_transport:
                labels = {"image": "图片", "video": "视频", "audio": "音频"}
                raise ValueError(
                    "当前模型接口不支持"
                    f"{'、'.join(labels[item] for item in unsupported_transport)}输入"
                )
        return
    if kind == JobKind.AUDIO:
        if any(counts.values()):
            raise ValueError("当前音频生成只支持文本输入")
        return
    if kind == JobKind.IMAGE:
        if counts["video"] or counts["audio"]:
            raise ValueError("图片生成当前只支持文本与图片输入")
        from character_workflow.lib.callers.openai_image import max_reference_images

        limit = max_reference_images(model.id)
        if counts["image"] > limit:
            raise ValueError(f"当前图片模型最多支持 {limit} 张参考图")
        return

    if params.frame_mode in {"first", "last", "firstlast"}:
        if counts["video"] or counts["audio"]:
            raise ValueError("首尾帧模式只支持图片输入")
        expected_images = 2 if params.frame_mode == "firstlast" else 1
        if counts["image"] != expected_images:
            raise ValueError(f"当前首尾帧设置需要 {expected_images} 张图片")
        if model.protocol == "seedance" and params.frame_mode == "last":
            raise ValueError("当前 Seedance 模型不能只设置尾帧，请先选择首帧")

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
    key: KeySpec,
    model: ModelSpec,
) -> tuple[dict[str, Any], JobParams, int]:
    from character_workflow.lib.callers.openai_image import image_family, resolve_image_protocol

    # 白名单重组，不是黑名单剔除：见 schemas.CANVAS_DRAFT_PARAM_FIELDS。
    normalized = canvas_allowed_draft_params(draft.mode, draft.params)
    # 这两个只在模型确实支持时由下面各分支重新放回。
    normalized.pop("background", None)
    normalized.pop("watermark", None)
    effective_count = requested_count
    if draft.mode == "image":
        family = image_family(model.id)
        if family == "midjourney":
            effective_count = 4
        protocol = model.protocol or resolve_image_protocol(
            key.provider,
            key.base_url,
            model.id,
        )
        if (
            family == "gpt-image"
            and key.provider != "openrouter"
            and protocol in {None, "openai"}
            and draft.params.background is not None
        ):
            normalized["background"] = draft.params.background
        normalized["n"] = effective_count
    elif draft.mode == "text":
        if not _supports_openai_text(key, model):
            raise ValueError("当前文本模型没有可用的生成协议")
        text_params: dict[str, Any] = {"n": effective_count}
        if draft.params.temperature is not None and model.protocol != "openai-responses":
            text_params["temperature"] = draft.params.temperature
        if draft.params.max_tokens is not None:
            text_params["max_tokens"] = draft.params.max_tokens
        if (
            model.protocol == "openai-responses"
            and draft.params.reasoning_effort is not None
            and draft.params.reasoning_effort != "auto"
        ):
            text_params["reasoning_effort"] = draft.params.reasoning_effort
        normalized = text_params
    elif draft.mode == "audio":
        if requested_count != 1:
            raise ValueError("视频与音频生成一次只允许一个结果")
        if not _supports_openai_speech(key, model):
            raise ValueError("当前音频模型没有可用的语音生成协议")
        from character_workflow.lib.callers.openai_audio import (
            AUDIO_FORMATS,
            AUDIO_VOICES,
        )

        voice = str(draft.params.voice or "alloy").lower()
        response_format = str(draft.params.response_format or "mp3").lower()
        raw_speed = draft.params.speed if draft.params.speed is not None else 1
        speed = round(max(0.25, min(4.0, float(raw_speed))), 2)
        normalized = {
            "voice": voice if voice in AUDIO_VOICES else "alloy",
            "response_format": response_format if response_format in AUDIO_FORMATS else "mp3",
            "speed": speed,
        }
        instructions = str(draft.params.instructions or "").strip()
        if instructions:
            normalized["instructions"] = instructions
    else:
        if requested_count != 1:
            raise ValueError("视频与音频生成一次只允许一个结果")
        normalized.pop("n", None)
        if (
            draft.mode == "video"
            and model.protocol in {"seedance", "dashscope"}
            and draft.params.watermark is not None
        ):
            normalized["watermark"] = draft.params.watermark
    return normalized, JobParams(**normalized), effective_count


def _with_active_run(node: CanvasNode, run_id: str) -> CanvasNode:
    if node.type not in {"text", "image", "video", "audio"}:
        return node
    return node.model_copy(update={
        "data": node.data.model_copy(update={"active_run_id": run_id})
    })


def _new_result_node(
    surface: CanvasNode,
    existing_nodes: list[CanvasNode],
    mode: str,
    draft: CanvasGenerationDraft | None,
    run_id: str,
    result_id: str,
    title: str,
) -> CanvasNode:
    width = surface.size.width if surface.size is not None else 320
    position = surface.position.model_copy(update={"x": surface.position.x + width + 120})
    candidate_width = 320
    candidate_height = 240
    occupied = sorted(
        (
            node.position.y,
            node.position.y + (node.size.height if node.size is not None else 240),
        )
        for node in existing_nodes
        if not (
            position.x + candidate_width <= node.position.x
            or node.position.x + (node.size.width if node.size is not None else 320) <= position.x
        )
    )
    candidate_y = position.y
    for top, bottom in occupied:
        if candidate_y + candidate_height <= top:
            break
        if candidate_y < bottom and candidate_y + candidate_height > top:
            candidate_y = bottom + 80
    position = position.model_copy(update={"y": candidate_y})
    common = {
        "id": result_id,
        "title": title,
        "position": position,
        "z_index": surface.z_index,
    }
    if mode == "text":
        return CanvasTextNode(
            **common,
            type="text",
            data=CanvasTextNodeData(
                current_version_id=None,
                generation_draft=draft,
                active_run_id=run_id,
            ),
        )
    if mode == "audio":
        return CanvasAudioNode(
            **common,
            type="audio",
            data=CanvasContentNodeData(
                current_version_id=None,
                generation_draft=draft,
                active_run_id=run_id,
            ),
        )
    data = CanvasMediaNodeData(
        current_version_id=None,
        generation_draft=draft,
        active_run_id=run_id,
        display=CanvasMediaDisplay(),
    )
    if mode == "image":
        return CanvasImageNode(**common, type="image", data=data)
    return CanvasVideoNode(**common, type="video", data=data)


def _commit_frozen_run(
    project_id: str,
    current: CanvasDocument,
    surface: CanvasNode,
    key: KeySpec,
    model: ModelSpec,
    kind: JobKind,
    *,
    mode: str,
    final_prompt: str,
    input_policy: str,
    normalized: dict[str, Any],
    job_params: JobParams,
    inputs: list[CanvasSnapshotInput],
    requested_count: int,
    result_title: str,
    result_draft: CanvasGenerationDraft | None,
    allow_surface_reuse: bool,
    transaction_kind: str,
    mask_version_id: str | None = None,
    run_id: str | None = None,
    additional_versions: list[CanvasContentVersion] | None = None,
    artifacts: list[dict[str, Any]] | None = None,
    batch_origin: CanvasBatchJobOrigin | None = None,
    job_id: str | None = None,
) -> tuple[Job, CanvasDocument]:
    timestamp = _now()
    job_id = job_id or new_job_id()
    run_id = run_id or f"run-{secrets.token_hex(12)}"
    use_surface = (
        allow_surface_reuse
        and surface.type in {"text", "image", "video", "audio"}
        and surface.type == mode
        and (batch_origin is not None or mode == "text" or _current_version_id(surface) is None)
    )
    result_id = surface.id if use_surface else f"{mode}-{secrets.token_hex(12)}"
    snapshot_payload = {
        "snapshot_version": 1,
        "surface_node_id": surface.id,
        "result_node_id": result_id,
        "mode": mode,
        "final_prompt": final_prompt,
        "input_policy": input_policy,
        "model": model.id,
        "provider": key.provider,
        "alias": key.alias,
        "normalized_params": normalized,
        "inputs": [item.model_dump(mode="json") for item in inputs],
        "mask_version_id": mask_version_id,
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
        batch=batch_origin,
    )
    job = Job(
        job_id=job_id,
        character_id=key.alias,
        prompt=final_prompt,
        submitted_at=timestamp,
        model=model.id,
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
        nodes.append(_new_result_node(
            surface,
            nodes,
            mode,
            result_draft,
            run_id,
            result_id,
            result_title,
        ))
        connections.append(CanvasDerivationConnection(
            id=f"connection-{secrets.token_hex(12)}",
            role="derivation",
            source_node_id=surface.id,
            target_node_id=result_id,
            origin=CanvasGenerationRunOrigin(kind="generation_run", run_id=run_id),
        ))
    content_versions = dict(current.content_versions)
    for version in additional_versions or []:
        if version.version_id in content_versions:
            raise ValueError("canvas content version already exists")
        content_versions[version.version_id] = version
    updated = current.model_copy(update={
        "revision": current.revision + 1,
        "updated_at": timestamp,
        "nodes": nodes,
        "connections": connections,
        "content_versions": content_versions,
    })
    _commit_transaction_unlocked(
        project_id,
        run_id,
        transaction_kind,
        current.revision,
        job,
        updated,
        artifacts=artifacts,
    )
    return job, updated


@dataclass
class PreparedCanvasGeneration:
    key: KeySpec
    model: ModelSpec
    kind: JobKind
    draft: CanvasGenerationDraft
    normalized: dict[str, Any]
    job_params: JobParams
    inputs: list[CanvasSnapshotInput]
    requested_count: int
    final_prompt: str


def prepare_canvas_generation(
    project_id: str,
    document: CanvasDocument,
    surface: CanvasNode,
    requested_count: int = 1,
    *,
    version_bindings: dict[str, list[str]] | None = None,
    resolve_media_paths: bool = True,
) -> PreparedCanvasGeneration:
    """Resolve one draft without writing a Job or making a provider request."""
    draft = _draft_for_node(surface)
    if draft is None:
        raise ValueError("当前节点没有可提交的生成设置")
    if surface.type == "config" and draft.mode == "text":
        raise CanvasRunCommandError(
            "canvas_text_config_removed",
            "文本生成已合并到文本节点，请使用文本节点。",
        )
    key, model, kind = _resolve_key_and_model(draft)
    normalized, job_params, effective_count = _normalized_params(draft, requested_count, key, model)
    inputs = _resolve_inputs(document, surface, draft, version_bindings)
    if _uses_video_frame_slots(draft) or any(
        item.source in {"first_frame", "last_frame"} for item in inputs
    ):
        frame_sources = {item.source for item in inputs}
        if {"first_frame", "last_frame"}.issubset(frame_sources):
            effective_frame_mode = "firstlast"
        elif "first_frame" in frame_sources:
            effective_frame_mode = "first"
        elif "last_frame" in frame_sources:
            effective_frame_mode = "last"
        else:
            effective_frame_mode = None
        job_params.frame_mode = effective_frame_mode
        if effective_frame_mode is None:
            normalized.pop("frame_mode", None)
        else:
            normalized["frame_mode"] = effective_frame_mode
    _validate_input_capabilities(model, kind, inputs, job_params, key.provider)
    final_prompt = _render_final_prompt(document, draft, inputs)
    if resolve_media_paths:
        media_paths = _input_paths(project_id, document, inputs)
        job_params.reference_images = media_paths["image"] or None
        job_params.reference_videos = media_paths["video"] or None
        job_params.reference_audios = media_paths["audio"] or None
    return PreparedCanvasGeneration(
        key, model, kind, draft, normalized, job_params, inputs, effective_count, final_prompt,
    )


def commit_canvas_generation_under_lock(
    project_id: str,
    current: CanvasDocument,
    surface: CanvasNode,
    prepared: PreparedCanvasGeneration,
    *,
    batch_origin: CanvasBatchJobOrigin | None = None,
    job_id: str | None = None,
    run_id: str | None = None,
) -> tuple[Job, CanvasDocument]:
    """Caller holds the project lock; all generation modes share this transaction boundary."""
    return _commit_frozen_run(
        project_id, current, surface, prepared.key, prepared.model, prepared.kind,
        mode=prepared.draft.mode,
        final_prompt=prepared.final_prompt,
        input_policy=prepared.draft.input_policy,
        normalized=prepared.normalized,
        job_params=prepared.job_params,
        inputs=prepared.inputs,
        requested_count=prepared.requested_count,
        result_title={
            "text": "生成文本", "image": "生成图片", "video": "生成视频", "audio": "生成音频",
        }[prepared.draft.mode],
        result_draft=prepared.draft,
        allow_surface_reuse=True,
        transaction_kind="submit",
        batch_origin=batch_origin,
        job_id=job_id,
        run_id=run_id,
    )


def submit_canvas_run(
    project_id: str,
    surface_node_id: str,
    expected_revision: int,
    requested_count: int = 1,
) -> tuple[Job, CanvasDocument]:
    """Atomically freeze one persisted draft into a Job and visible result surface."""
    with file_lock(canvas_project_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        current = _read_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        surface = next((node for node in current.nodes if node.id == surface_node_id), None)
        if surface is None:
            raise KeyError(surface_node_id)
        prepared = prepare_canvas_generation(project_id, current, surface, requested_count)
        return commit_canvas_generation_under_lock(project_id, current, surface, prepared)


def submit_reverse_prompt_run(
    project_id: str,
    surface_node_id: str,
    expected_revision: int,
) -> tuple[Job, CanvasDocument]:
    """Freeze one owned image into the versioned reverse-prompt preset and a text Run."""
    with file_lock(canvas_project_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        current = _read_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        surface = next((node for node in current.nodes if node.id == surface_node_id), None)
        if not isinstance(surface, CanvasImageNode) or not surface.data.current_version_id:
            raise CanvasRunCommandError(
                "canvas_reverse_prompt_source_missing",
                "请选择一个已有内容的图片节点再反推提示词。",
            )
        version = current.content_versions.get(surface.data.current_version_id)
        if not isinstance(version, CanvasMediaVersion) or version.kind != "image":
            raise CanvasRunCommandError(
                "canvas_reverse_prompt_source_missing",
                "图片节点当前没有可读取的项目内版本。",
            )
        key, model = _resolve_reverse_prompt_model()
        inputs = [CanvasSnapshotInput(
            order=0,
            source="implicit_self",
            node_id=surface.id,
            version_id=version.version_id,
            kind="image",
        )]
        paths = _input_paths(project_id, current, inputs)
        normalized = {
            "n": 1,
            "temperature": 0.2,
            "max_tokens": 1200,
            "preset_id": _REVERSE_PROMPT_PRESET_ID,
            "preset_version": _REVERSE_PROMPT_PRESET_VERSION,
        }
        job_params = JobParams(**normalized)
        job_params.reference_images = paths["image"]
        return _commit_frozen_run(
            project_id,
            current,
            surface,
            key,
            model,
            JobKind.TEXT,
            mode="text",
            final_prompt=_REVERSE_PROMPT,
            input_policy="mentions_only",
            normalized=normalized,
            job_params=job_params,
            inputs=inputs,
            requested_count=1,
            result_title="反推提示词",
            result_draft=None,
            allow_surface_reuse=False,
            transaction_kind="reverse_prompt",
        )


def submit_mask_edit_run(
    project_id: str,
    surface_node_id: str,
    expected_revision: int,
    requested_count: int,
    mask_body: bytes,
) -> tuple[Job, CanvasDocument]:
    """Freeze a user mask and its persisted image Draft into one recoverable Run."""
    from character_workflow.lib.callers.openai_image import supports_image_mask
    from character_workflow.lib.canvas_masks import normalize_canvas_mask

    if requested_count < 1 or requested_count > 4:
        raise CanvasRunCommandError(
            "canvas_mask_count_invalid",
            "局部编辑一次只能生成 1–4 张候选图。",
        )
    run_id = f"run-{secrets.token_hex(12)}"
    staged_path: Path | None = None
    try:
        with file_lock(canvas_project_lock_path(project_id)):
            recover_canvas_transactions_unlocked(project_id)
            current = _read_document_unlocked(project_id)
            if current.revision != expected_revision:
                raise RuntimeError(f"revision_conflict:{current.revision}")
            surface = next(
                (node for node in current.nodes if node.id == surface_node_id),
                None,
            )
            if not isinstance(surface, CanvasImageNode) or not surface.data.current_version_id:
                raise CanvasRunCommandError(
                    "canvas_mask_source_missing",
                    "请选择一个已有内容的图片节点再进行局部编辑。",
                )
            source = current.content_versions.get(surface.data.current_version_id)
            if not isinstance(source, CanvasMediaVersion) or source.kind != "image":
                raise CanvasRunCommandError(
                    "canvas_mask_source_missing",
                    "图片节点当前没有可读取的项目内版本。",
                )
            draft = _draft_for_node(surface)
            if draft is None or draft.mode != "image":
                raise CanvasRunCommandError(
                    "canvas_mask_draft_missing",
                    "请先填写局部编辑提示词并选择图片模型。",
                )
            key, model, kind = _resolve_key_and_model(draft)
            if not supports_image_mask(key.provider, model.id, model.protocol):
                raise CanvasRunCommandError(
                    "canvas_media_capability_missing",
                    "当前模型不支持局部蒙版编辑，请选择 GPT Image 兼容模型。",
                )
            normalized, job_params, effective_count = _normalized_params(
                draft,
                requested_count,
                key,
                model,
            )
            unsupported_mentions = [
                node_id for node_id in _MENTION.findall(draft.prompt)
                if node_id != surface.id
            ]
            if unsupported_mentions:
                raise CanvasRunCommandError(
                    "canvas_mask_prompt_invalid",
                    "局部编辑提示词不能引用其它节点；本次输入只冻结当前源图。",
                )
            inputs = [CanvasSnapshotInput(
                order=0,
                source="implicit_self",
                node_id=surface.id,
                version_id=source.version_id,
                kind="image",
            )]
            _validate_input_capabilities(model, kind, inputs, job_params, key.provider)
            final_prompt = _render_final_prompt(current, draft, inputs)
            media_paths = _input_paths(project_id, current, inputs)
            if not media_paths["image"]:
                raise CanvasRunCommandError(
                    "canvas_mask_source_missing",
                    "源图片文件不存在，无法创建局部编辑。",
                )
            normalized_mask = normalize_canvas_mask(
                Path(media_paths["image"][0]),
                source,
                mask_body,
            )
            mask_id = f"mask-{secrets.token_hex(12)}"
            version_id = f"version-{secrets.token_hex(12)}"
            staged_path = canvas_project_dir(project_id) / ".runtime" / "run-inputs" / f"{run_id}.png"
            final_path = canvas_project_dir(project_id) / "uploads" / f"{mask_id}.png"
            atomic_write_bytes(staged_path, normalized_mask.body)
            mask_version = CanvasMediaVersion(
                version_id=version_id,
                created_at=_now(),
                sha256=normalized_mask.sha256,
                origin=CanvasUserMaskOrigin(
                    kind="user_mask",
                    source_version_id=source.version_id,
                ),
                kind="image",
                path=final_path.relative_to(canvas_project_dir(project_id)).as_posix(),
                mime_type="image/png",
                bytes=len(normalized_mask.body),
                width=normalized_mask.width,
                height=normalized_mask.height,
            )
            job_params.reference_images = media_paths["image"]
            job_params.reference_videos = None
            job_params.reference_audios = None
            job_params.mask_image = str(final_path.resolve())
            artifact = {
                "staged_path": staged_path.relative_to(canvas_project_dir(project_id)).as_posix(),
                "final_path": final_path.relative_to(canvas_project_dir(project_id)).as_posix(),
                "bytes": len(normalized_mask.body),
                "sha256": normalized_mask.sha256,
            }
            return _commit_frozen_run(
                project_id,
                current,
                surface,
                key,
                model,
                kind,
                mode="image",
                final_prompt=final_prompt,
                input_policy="mentions_only",
                normalized=normalized,
                job_params=job_params,
                inputs=inputs,
                requested_count=effective_count,
                result_title="局部编辑",
                result_draft=draft,
                allow_surface_reuse=False,
                transaction_kind="mask_edit",
                mask_version_id=version_id,
                run_id=run_id,
                additional_versions=[mask_version],
                artifacts=[artifact],
            )
    except BaseException:
        if staged_path is not None and not _transaction_path(project_id, run_id).exists():
            staged_path.unlink(missing_ok=True)
        raise


def _angle_label(
    horizontal_angle: int,
    pitch_angle: int,
    camera_distance: float,
    wide_angle: bool,
) -> str:
    horizontal = (
        "正面"
        if horizontal_angle == 0
        else f"向右旋转 {horizontal_angle}°"
        if horizontal_angle > 0
        else f"向左旋转 {abs(horizontal_angle)}°"
    )
    pitch = (
        "平视"
        if pitch_angle == 0
        else f"俯视 {pitch_angle}°"
        if pitch_angle > 0
        else f"仰视 {abs(pitch_angle)}°"
    )
    lens = "广角镜头" if wide_angle else "标准镜头"
    return f"{horizontal}，{pitch}，相机距离 {camera_distance:.1f}，{lens}"


def _angle_prompt(
    horizontal_angle: int,
    pitch_angle: int,
    camera_distance: float,
    wide_angle: bool,
) -> str:
    label = _angle_label(horizontal_angle, pitch_angle, camera_distance, wide_angle)
    return (
        "基于唯一附带的参考图片，生成同一主体在新摄影机视角下的完整图像。"
        f"相机设置：{label}。"
        "只改变摄影机方位、俯仰、距离与镜头透视；严格保持主体身份、造型结构、服饰、材质、"
        "色彩、背景内容、光线方向和原画风格，不增加新主体，不重设计现有元素。"
    )


def _angle_result_title(
    horizontal_angle: int,
    pitch_angle: int,
    wide_angle: bool,
) -> str:
    horizontal = (
        "正面"
        if horizontal_angle == 0
        else f"右{horizontal_angle}°"
        if horizontal_angle > 0
        else f"左{abs(horizontal_angle)}°"
    )
    pitch = (
        "平视"
        if pitch_angle == 0
        else f"俯{pitch_angle}°"
        if pitch_angle > 0
        else f"仰{abs(pitch_angle)}°"
    )
    lens = " · 广角" if wide_angle else ""
    return f"新角度 · {horizontal} · {pitch}{lens}"


def submit_angle_run(
    project_id: str,
    surface_node_id: str,
    expected_revision: int,
    requested_count: int,
    horizontal_angle: int,
    pitch_angle: int,
    camera_distance: float,
    wide_angle: bool,
) -> tuple[Job, CanvasDocument]:
    """Freeze one owned image and structured camera controls into an Image Run."""
    if requested_count < 1 or requested_count > 4:
        raise CanvasRunCommandError(
            "canvas_angle_count_invalid",
            "多角度生成一次只能创建 1–4 张候选图。",
        )
    with file_lock(canvas_project_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        current = _read_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        surface = next((node for node in current.nodes if node.id == surface_node_id), None)
        if not isinstance(surface, CanvasImageNode) or not surface.data.current_version_id:
            raise CanvasRunCommandError(
                "canvas_angle_source_missing",
                "请选择一个已有内容的图片节点再生成新角度。",
            )
        source = current.content_versions.get(surface.data.current_version_id)
        if not isinstance(source, CanvasMediaVersion) or source.kind != "image":
            raise CanvasRunCommandError(
                "canvas_angle_source_missing",
                "图片节点当前没有可读取的项目内版本。",
            )
        key, model = _resolve_default_image_edit_model()
        inputs = [CanvasSnapshotInput(
            order=0,
            source="implicit_self",
            node_id=surface.id,
            version_id=source.version_id,
            kind="image",
        )]
        job_params = JobParams(
            n=requested_count,
            angle_horizontal=horizontal_angle,
            angle_pitch=pitch_angle,
            angle_distance=camera_distance,
            angle_wide=wide_angle,
        )
        _validate_input_capabilities(model, JobKind.IMAGE, inputs, job_params)
        paths = _input_paths(project_id, current, inputs)
        job_params.reference_images = paths["image"]
        normalized = job_params.model_dump(mode="json", exclude_none=True)
        normalized.pop("reference_images", None)
        normalized.update({
            "preset_id": _ANGLE_PROMPT_PRESET_ID,
            "preset_version": _ANGLE_PROMPT_PRESET_VERSION,
        })
        final_prompt = _angle_prompt(
            horizontal_angle,
            pitch_angle,
            camera_distance,
            wide_angle,
        )
        result_draft = CanvasGenerationDraft(
            mode="image",
            prompt=final_prompt,
            input_policy="mentions_only",
            model=model.id,
            alias=key.alias,
            params=job_params.model_copy(update={"reference_images": None}),
            updated_at=_now(),
        )
        return _commit_frozen_run(
            project_id,
            current,
            surface,
            key,
            model,
            JobKind.IMAGE,
            mode="image",
            final_prompt=final_prompt,
            input_policy="mentions_only",
            normalized=normalized,
            job_params=job_params,
            inputs=inputs,
            requested_count=requested_count,
            result_title=_angle_result_title(
                horizontal_angle,
                pitch_angle,
                wide_angle,
            ),
            result_draft=result_draft,
            allow_surface_reuse=False,
            transaction_kind="angle",
        )


def _is_reverse_prompt_snapshot(snapshot: CanvasGenerationSnapshot) -> bool:
    return (
        snapshot.mode == "text"
        and snapshot.normalized_params.get("preset_id") == _REVERSE_PROMPT_PRESET_ID
        and snapshot.normalized_params.get("preset_version") == _REVERSE_PROMPT_PRESET_VERSION
    )


def _reverse_prompt_config_ids(result_node_id: str) -> tuple[str, str]:
    return f"config-reverse-{result_node_id}", f"connection-reverse-{result_node_id}"


def create_reverse_prompt_config(
    project_id: str,
    run_id: str,
    expected_revision: int,
) -> CanvasDocument:
    """Idempotently connect a successful reverse-prompt text result to an image config node."""
    with file_lock(canvas_project_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        current = _read_document_unlocked(project_id)
        job = _job_for_run(project_id, run_id)
        context = job.canvas_run
        if context is None or not _is_reverse_prompt_snapshot(context.snapshot):
            raise CanvasRunCommandError(
                "canvas_reverse_prompt_run_invalid",
                "这个生成记录不是图片反推提示词任务。",
            )
        if job.status not in {JobStatus.DONE, JobStatus.PARTIAL} or not any(
            candidate.status == "succeeded" for candidate in context.candidates
        ):
            raise CanvasRunCommandError(
                "canvas_reverse_prompt_not_ready",
                "反推提示词尚未成功完成，暂时不能创建图片配置。",
            )
        result = next(
            (node for node in current.nodes if node.id == context.result_node_id),
            None,
        )
        version_id = result.data.current_version_id if isinstance(result, CanvasTextNode) else None
        version = current.content_versions.get(version_id) if version_id else None
        if not isinstance(result, CanvasTextNode) or not isinstance(version, CanvasTextVersion):
            raise CanvasRunCommandError(
                "canvas_reverse_prompt_result_missing",
                "反推生成的文本节点或内容版本已经不存在。",
            )

        config_id, connection_id = _reverse_prompt_config_ids(result.id)
        existing_config = next((node for node in current.nodes if node.id == config_id), None)
        existing_connection = next(
            (
                connection for connection in current.connections
                if connection.role == "input"
                and connection.source_node_id == result.id
                and connection.target_node_id == config_id
            ),
            None,
        )
        if existing_config is not None and not isinstance(existing_config, CanvasConfigNode):
            raise CanvasRunCommandError(
                "canvas_reverse_prompt_config_conflict",
                "画布中已有同标识但类型不兼容的节点，无法恢复图片配置。",
            )
        if existing_config is not None and existing_connection is not None:
            return current
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")

        timestamp = _now()
        nodes = list(current.nodes)
        if existing_config is None:
            key, model, params = _resolve_default_image_model()
            width = result.size.width if result.size is not None else 320
            nodes.append(CanvasConfigNode(
                id=config_id,
                type="config",
                title="图片生成配置",
                position=result.position.model_copy(update={"x": result.position.x + width + 120}),
                z_index=result.z_index,
                data=CanvasConfigNodeData(draft=CanvasGenerationDraft(
                    mode="image",
                    prompt=f"@[node:{result.id}]",
                    input_policy="mentions_only",
                    model=model.id,
                    alias=key.alias,
                    params=params,
                    updated_at=timestamp,
                )),
            ))
        connections = list(current.connections)
        if existing_connection is None:
            if any(connection.id == connection_id for connection in connections):
                raise CanvasRunCommandError(
                    "canvas_reverse_prompt_config_conflict",
                    "画布中已有同标识但指向不同节点的连接。",
                )
            connections.append(CanvasInputConnection(
                id=connection_id,
                role="input",
                source_node_id=result.id,
                target_node_id=config_id,
            ))
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "nodes": nodes,
            "connections": connections,
        })
        _write_project_state_unlocked(project_id, updated)
        return updated


def _job_for_run(project_id: str, run_id: str) -> Job:
    job = next(
        (
            item for item in list_jobs()
            if item.namespace == "canvas"
            and item.canvas_project_id == project_id
            and item.canvas_run is not None
            and item.canvas_run.run_id == run_id
        ),
        None,
    )
    if job is None:
        raise KeyError(run_id)
    return job


def retry_canvas_run(
    project_id: str,
    run_id: str,
    expected_revision: int,
) -> tuple[Job, CanvasDocument]:
    """Submit the result node's current Draft again as a brand-new Run."""
    original = _job_for_run(project_id, run_id)
    context = original.canvas_run
    if context is None:
        raise ValueError("Canvas Run 缺少 Snapshot")
    with job_lock(original.job_id):
        original = read_job(original.job_id)
    if original.status in {JobStatus.PENDING, JobStatus.PENDING_CONFIRM}:
        raise RuntimeError("run_not_terminal")
    current = _read_document_unlocked(project_id)
    result = next(
        (node for node in current.nodes if node.id == context.result_node_id),
        None,
    )
    draft = _draft_for_node(result) if result is not None else None
    if draft is None:
        raise RuntimeError("result_node_missing")
    requested_count = (
        max(1, min(4, int(draft.params.n or 1)))
        if draft.mode in {"text", "image"} else 1
    )
    return submit_canvas_run(
        project_id,
        context.result_node_id,
        expected_revision,
        requested_count,
    )


def request_canvas_run_cancel(project_id: str, run_id: str) -> Job:
    """Persist an idempotent stop request without pretending the provider already stopped."""
    original = _job_for_run(project_id, run_id)
    with file_lock(canvas_project_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        with job_lock(original.job_id):
            job = read_job(original.job_id)
            if job.status in {
                JobStatus.DONE,
                JobStatus.PARTIAL,
                JobStatus.FAILED,
                JobStatus.CANCELED,
            }:
                return job
            if job.cancel_requested_at is not None:
                return job
            updated = job.model_copy(update={"cancel_requested_at": _now()})
            write_job_under_lock(updated)
            return updated


def dismiss_canvas_candidate(
    project_id: str,
    run_id: str,
    candidate_id: str,
    expected_revision: int,
) -> tuple[Job, CanvasDocument]:
    """Hide one failed/canceled slot without deleting its immutable provenance."""
    original = _job_for_run(project_id, run_id)
    with file_lock(canvas_project_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        current = _read_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        with job_lock(original.job_id):
            job = read_job(original.job_id)
            context = job.canvas_run
            if context is None or context.run_id != run_id:
                raise KeyError(run_id)
            candidate = next(
                (item for item in context.candidates if item.candidate_id == candidate_id),
                None,
            )
            if candidate is None:
                raise KeyError(candidate_id)
            if candidate.status not in {"failed", "canceled"}:
                raise ValueError("只能隐藏失败或已停止的候选")
            if candidate.dismissed_at is not None:
                return job, current
            candidates = [
                item.model_copy(update={"dismissed_at": _now()})
                if item.candidate_id == candidate_id else item
                for item in context.candidates
            ]
            updated = job.model_copy(update={
                "canvas_run": context.model_copy(update={"candidates": candidates})
            })
            write_job_under_lock(updated)
            return updated, current


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
) -> CanvasTextVersion | CanvasMediaVersion:
    root = canvas_project_dir(project_id).resolve()
    raw = Path(output_path)
    target = (
        raw if raw.is_absolute() else data_root.resolve_data_root() / raw
    ).resolve()
    owned = (root / "outputs" / job.job_id).resolve()
    if not target.is_relative_to(owned) or not target.is_file():
        raise ValueError("Canvas Job 产物不属于当前 Run")
    if job.kind == JobKind.TEXT:
        if target.suffix.lower() != ".txt":
            raise ValueError("Canvas 文本 Job 返回了不支持的格式")
        text = target.read_text(encoding="utf-8").strip()
        if not text or len(text) > 40_000:
            raise ValueError("Canvas 文本 Job 返回了无效文本")
        return CanvasTextVersion(
            version_id=f"version-{secrets.token_hex(12)}",
            created_at=_now(),
            sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            origin=CanvasJobOutputOrigin(
                kind="job_output",
                job_id=job.job_id,
                candidate_id=candidate.candidate_id,
            ),
            kind="text",
            text=text,
        )
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
    if job.kind == JobKind.AUDIO and not is_valid_audio(target):
        raise ValueError("Canvas Job 返回了无效音频")
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


def _canceled_candidates(job: Job) -> Job:
    context = job.canvas_run
    if context is None:
        return job
    candidates = [
        candidate.model_copy(update={"status": "canceled", "error": job.error})
        if candidate.status == "pending" else candidate
        for candidate in context.candidates
    ]
    return job.model_copy(update={
        "canvas_run": context.model_copy(update={"candidates": candidates})
    })


def _candidate_aggregate(
    candidates: list[CanvasResultCandidate],
) -> tuple[JobStatus, str | None]:
    if any(candidate.status == "pending" for candidate in candidates):
        return JobStatus.PENDING, None
    successful = sum(candidate.status == "succeeded" for candidate in candidates)
    if successful == len(candidates):
        return JobStatus.DONE, None
    if successful:
        return JobStatus.PARTIAL, "部分候选没有生成成功"
    if candidates and all(candidate.status == "canceled" for candidate in candidates):
        return JobStatus.CANCELED, None
    return JobStatus.FAILED, "Canvas Job 没有可登记的结果"


def _uses_incremental_candidates(job: Job) -> bool:
    context = job.canvas_run
    if context is None or len(context.candidates) <= 1 or job.kind != JobKind.IMAGE:
        return False
    from character_workflow.lib.callers.openai_image import image_family

    # Midjourney returns one paid four-image grid from one request.
    return image_family(job.model) != "midjourney"


def _commit_canvas_candidate_attempt(
    project_id: str,
    job_id: str,
    candidate_id: str,
    *,
    original_params: JobParams,
    accumulated_paths: list[str],
    output_path: str | None,
    attempt_error: str | None,
) -> Job:
    """Commit one independently completed slot and expose its Version immediately."""
    with file_lock(canvas_project_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        current = _read_document_unlocked(project_id)
        with job_lock(job_id):
            job = read_job(job_id)
            context = job.canvas_run
            if context is None:
                raise ValueError("canvas job is missing run context")
            target = next(
                (candidate for candidate in context.candidates if candidate.candidate_id == candidate_id),
                None,
            )
            if target is None:
                raise KeyError(candidate_id)
            if target.status != "pending":
                return job

            version: CanvasContentVersion | None = None
            if output_path is not None:
                try:
                    version = _output_version(project_id, job, target, output_path)
                    completed = target.model_copy(update={
                        "status": "succeeded",
                        "version_id": version.version_id,
                        "error": None,
                    })
                except (OSError, ValueError) as error:
                    completed = target.model_copy(update={
                        "status": "failed",
                        "error": str(error),
                    })
            else:
                completed = target.model_copy(update={
                    "status": "failed",
                    "error": attempt_error or "厂商没有返回这个候选结果",
                })
            had_success = any(candidate.status == "succeeded" for candidate in context.candidates)
            candidates = [
                completed if candidate.candidate_id == candidate_id else candidate
                for candidate in context.candidates
            ]
            status, aggregate_error = _candidate_aggregate(candidates)
            output_paths = list(accumulated_paths)
            if version is not None and output_path is not None and output_path not in output_paths:
                output_paths.append(output_path)
            restored_params = original_params.model_copy(update={
                "actual_size": job.params.actual_size or original_params.actual_size,
                "warnings": job.params.warnings or original_params.warnings,
            })
            updated_job = job.model_copy(update={
                "status": status,
                "error": aggregate_error,
                "params": restored_params,
                "output_paths": output_paths,
                "progress_phase": None,
                "completed_at": _now() if status in {
                    JobStatus.DONE,
                    JobStatus.PARTIAL,
                    JobStatus.FAILED,
                    JobStatus.CANCELED,
                } else None,
                "canvas_run": context.model_copy(update={"candidates": candidates}),
            })
            if version is None:
                write_job_under_lock(updated_job)
                return updated_job

            nodes: list[CanvasNode] = []
            for node in current.nodes:
                if (
                    node.id == context.result_node_id
                    and node.type in {"text", "image", "video", "audio"}
                    and node.data.active_run_id == context.run_id
                    and not had_success
                ):
                    node = node.model_copy(update={
                        "data": node.data.model_copy(update={
                            "current_version_id": version.version_id,
                        })
                    })
                nodes.append(node)
            timestamp = _now()
            updated_document = current.model_copy(update={
                "revision": current.revision + 1,
                "updated_at": timestamp,
                "nodes": nodes,
                "content_versions": {
                    **current.content_versions,
                    version.version_id: version,
                },
            })
            _commit_transaction_unlocked(
                project_id,
                context.run_id,
                "candidate_finalize",
                current.revision,
                updated_job,
                updated_document,
                job_locked=True,
            )
            return updated_job


def _settle_pending_canvas_candidates(
    project_id: str,
    job_id: str,
    *,
    candidate_status: Literal["failed", "canceled"],
    error: str | None,
) -> Job:
    with file_lock(canvas_project_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        with job_lock(job_id):
            job = read_job(job_id)
            context = job.canvas_run
            if context is None:
                raise ValueError("canvas job is missing run context")
            candidates = [
                candidate.model_copy(update={"status": candidate_status, "error": error})
                if candidate.status == "pending" else candidate
                for candidate in context.candidates
            ]
            status, aggregate_error = _candidate_aggregate(candidates)
            updated = job.model_copy(update={
                "status": status,
                "error": aggregate_error or error,
                "progress_phase": None,
                "completed_at": _now(),
                "canvas_run": context.model_copy(update={"candidates": candidates}),
            })
            write_job_under_lock(updated)
            return updated


def _cancel_pending_canvas_candidates(project_id: str, job_id: str) -> Job:
    return _settle_pending_canvas_candidates(
        project_id,
        job_id,
        candidate_status="canceled",
        error=None,
    )


def _fail_pending_canvas_candidates(project_id: str, job_id: str, error: str) -> Job:
    return _settle_pending_canvas_candidates(
        project_id,
        job_id,
        candidate_status="failed",
        error=error,
    )


def _run_canvas_candidates_incrementally(job: Job) -> Job:
    context = job.canvas_run
    if context is None or not job.canvas_project_id:
        raise ValueError("canvas job is missing run context")
    original_params = job.params
    while True:
        with job_lock(job.job_id):
            latest = read_job(job.job_id)
            latest_context = latest.canvas_run
            if latest_context is None:
                raise ValueError("canvas job is missing run context")
            pending = next(
                (candidate for candidate in latest_context.candidates if candidate.status == "pending"),
                None,
            )
            if pending is None:
                return latest
            cancel_requested = latest.cancel_requested_at is not None
            accumulated_paths = list(latest.output_paths)
            if not cancel_requested:
                attempt_params = original_params.model_copy(update={"n": 1})
                write_job_under_lock(latest.model_copy(update={
                    "status": JobStatus.PENDING,
                    "error": None,
                    "params": attempt_params,
                    "progress_phase": None,
                    "completed_at": None,
                }))
        if cancel_requested:
            return _cancel_pending_canvas_candidates(job.canvas_project_id, job.job_id)

        output_path: str | None = None
        attempt_error: str | None = None
        try:
            attempt = run_job(job.job_id, defer_terminal=True)
            output_path = next(
                (path for path in attempt.output_paths if path not in accumulated_paths),
                None,
            )
        except JobExecutionBusy:
            # Another process owns this exact paid attempt. Leave the shared Job untouched;
            # the lock owner will commit the candidate when it finishes.
            return read_job(job.job_id)
        except Exception:
            attempt = read_job(job.job_id)
            attempt_error = attempt.error
        committed = _commit_canvas_candidate_attempt(
            job.canvas_project_id,
            job.job_id,
            pending.candidate_id,
            original_params=original_params,
            accumulated_paths=accumulated_paths,
            output_path=output_path,
            attempt_error=attempt_error,
        )
        original_params = committed.params


def finalize_canvas_run(
    project_id: str,
    job_id: str,
) -> tuple[Job, CanvasDocument | None]:
    """Commit runner outputs as immutable versions; safe to call more than once."""
    with file_lock(canvas_project_lock_path(project_id)):
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
    if job.status == JobStatus.CANCELED:
        canceled = _canceled_candidates(job)
        write_job_under_lock(canceled)
        return canceled, None
    if job.status == JobStatus.FAILED:
        terminal = _canceled_candidates(job) if job.cancel_requested_at else _failed_candidates(job)
        terminal_status = JobStatus.CANCELED if job.cancel_requested_at else JobStatus.FAILED
        terminal = terminal.model_copy(update={"status": terminal_status})
        write_job_under_lock(terminal)
        return terminal, None
    if job.status not in {JobStatus.DONE, JobStatus.PARTIAL}:
        return job, None
    if all(candidate.status != "pending" for candidate in context.candidates):
        return job, current

    versions: list[CanvasContentVersion] = []
    candidates: list[CanvasResultCandidate] = []
    for index, candidate in enumerate(context.candidates):
        if index >= len(job.output_paths):
            candidates.append(candidate.model_copy(update={
                "status": "canceled" if job.cancel_requested_at else "failed",
                "error": None if job.cancel_requested_at else "厂商没有返回这个候选结果",
            }))
            continue
        try:
            version = _output_version(project_id, job, candidate, job.output_paths[index])
            versions.append(version)
            candidates.append(candidate.model_copy(update={
                "status": "succeeded",
                "version_id": version.version_id,
                "error": None,
            }))
        except (OSError, ValueError) as error:
            candidates.append(candidate.model_copy(update={
                "status": "failed",
                "error": str(error),
            }))
    successful = [candidate for candidate in candidates if candidate.status == "succeeded"]
    if not successful:
        canceled = all(candidate.status == "canceled" for candidate in candidates)
        terminal = job.model_copy(update={
            "status": JobStatus.CANCELED if canceled else JobStatus.FAILED,
            "error": None if canceled else "Canvas Job 没有可登记的结果",
            "progress_phase": None,
            "completed_at": job.completed_at or _now(),
            "canvas_run": context.model_copy(update={"candidates": candidates}),
        })
        write_job_under_lock(terminal)
        return terminal, None

    partial = any(candidate.status != "succeeded" for candidate in candidates)
    updated_job = job.model_copy(update={
        "status": JobStatus.PARTIAL if partial else JobStatus.DONE,
        "error": "部分候选没有生成成功" if partial else None,
        "progress_phase": None,
        "completed_at": job.completed_at or _now(),
        "canvas_run": context.model_copy(update={"candidates": candidates})
    })
    primary_version_id = successful[0].version_id
    text_primary = next(
        (candidate for candidate in successful if candidate.index == 0),
        None,
    )
    nodes: list[CanvasNode] = []
    result_node: CanvasTextNode | None = None
    for node in current.nodes:
        if (
            node.id == context.result_node_id
            and node.type in {"text", "image", "video", "audio"}
            and node.data.active_run_id == context.run_id
        ):
            # For text batches only candidate 0 owns the anchor node; the other indices
            # get their own nodes.
            should_display_version = (
                job.kind != JobKind.TEXT
                or text_primary is not None
            )
            if should_display_version:
                node = node.model_copy(update={
                    "data": node.data.model_copy(update={
                        "current_version_id": (
                            text_primary.version_id
                            if job.kind == JobKind.TEXT and text_primary is not None
                            else primary_version_id
                        ),
                    })
                })
            if node.type == "text":
                result_node = node
        nodes.append(node)
    connections = list(current.connections)
    if (
        job.kind == JobKind.TEXT
        and result_node is not None
        and len(candidates) > 1
    ):
        node_width = result_node.size.width if result_node.size is not None else 256
        node_height = result_node.size.height if result_node.size is not None else 144
        offsets = {
            1: (node_width + 120, 0),
            2: (0, node_height + 120),
            3: (node_width + 120, node_height + 120),
        }
        source_inputs = [
            connection
            for connection in current.connections
            if connection.role == "input"
            and connection.target_node_id == result_node.id
        ]
        for candidate in successful:
            if candidate.index not in offsets:
                continue
            offset_x, offset_y = offsets[candidate.index]
            slot_key = hashlib.sha256(
                f"{result_node.id}:{candidate.index}".encode("utf-8")
            ).hexdigest()[:20]
            candidate_node_id = f"text-result-{slot_key}"
            candidate_node = CanvasTextNode(
                id=candidate_node_id,
                title=f"{result_node.title[:118]}-{candidate.index + 1}",
                type="text",
                position=result_node.position.model_copy(update={
                    "x": result_node.position.x + offset_x,
                    "y": result_node.position.y + offset_y,
                }),
                size=result_node.size,
                z_index=result_node.z_index,
                data=result_node.data.model_copy(update={
                    "current_version_id": candidate.version_id,
                    "active_run_id": None,
                }),
            )
            existing_index = next(
                (index for index, node in enumerate(nodes) if node.id == candidate_node_id),
                None,
            )
            if existing_index is None:
                nodes.append(candidate_node)
            else:
                nodes[existing_index] = candidate_node
            if not any(
                connection.role == "derivation"
                and connection.source_node_id == result_node.id
                and connection.target_node_id == candidate_node_id
                for connection in connections
            ):
                connections.append(CanvasDerivationConnection(
                    id=f"connection-{secrets.token_hex(12)}",
                    role="derivation",
                    source_node_id=result_node.id,
                    target_node_id=candidate_node_id,
                    origin=CanvasGenerationRunOrigin(
                        kind="generation_run",
                        run_id=context.run_id,
                    ),
                ))
            for connection in source_inputs:
                if any(
                    existing.role == "input"
                    and existing.source_node_id == connection.source_node_id
                    and existing.target_node_id == candidate_node_id
                    for existing in connections
                ):
                    continue
                connections.append(CanvasInputConnection(
                    id=f"connection-{secrets.token_hex(12)}",
                    role="input",
                    source_node_id=connection.source_node_id,
                    target_node_id=candidate_node_id,
                ))
    timestamp = _now()
    updated = current.model_copy(update={
        "revision": current.revision + 1,
        "updated_at": timestamp,
        "nodes": nodes,
        "connections": connections,
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
    with job_lock(job_id):
        job = read_job(job_id)
        if job.namespace != "canvas" or not job.canvas_project_id:
            raise ValueError("job is not a Canvas Run")
        if job.status in {
            JobStatus.DONE,
            JobStatus.PARTIAL,
            JobStatus.FAILED,
            JobStatus.CANCELED,
        }:
            return job
        if job.cancel_requested_at is not None:
            canceled = _canceled_candidates(job).model_copy(update={
                "status": JobStatus.CANCELED,
                "error": None,
                "progress_phase": None,
                "completed_at": _now(),
            })
            write_job_under_lock(canceled)
            return canceled
        job = job.model_copy(update={"runner_started_at": _now()})
        write_job_under_lock(job)
    if _uses_incremental_candidates(job):
        return _run_canvas_candidates_incrementally(job)
    try:
        run_job(job_id)
    except JobExecutionBusy:
        # A duplicate scheduler must never mark the lock owner's in-flight Job as failed.
        return read_job(job_id)
    except Exception as error:
        latest = read_job(job_id)
        if latest.status not in {
            JobStatus.DONE,
            JobStatus.PARTIAL,
            JobStatus.FAILED,
            JobStatus.CANCELED,
        }:
            update_job_status(job_id, status=JobStatus.FAILED, error=str(error))
        finalize_canvas_run(job.canvas_project_id, job_id)
        raise
    finalized, _document = finalize_canvas_run(job.canvas_project_id, job_id)
    return finalized


def run_canvas_job_scheduled(job_id: str) -> Job:
    """Run through the process-wide Canvas limits: global 4, per alias 2, video 1."""
    job = read_job(job_id)
    alias = job.alias or job.character_id
    with _RUN_ALIAS_GATES_LOCK:
        alias_gate = _RUN_ALIAS_GATES.setdefault(alias, BoundedSemaphore(2))
    video_gate = _RUN_VIDEO_GATE if job.kind == JobKind.VIDEO else nullcontext()
    with _RUN_GLOBAL_GATE, alias_gate, video_gate:
        return run_canvas_job(job_id)


def _recover_incremental_candidate_output(job: Job) -> Job:
    """Register a paid slot saved by the runner before a process interruption."""
    context = job.canvas_run
    if context is None or not job.canvas_project_id:
        return job
    successful_count = sum(
        candidate.status == "succeeded" for candidate in context.candidates
    )
    if len(job.output_paths) <= successful_count:
        return job
    pending = next(
        (candidate for candidate in context.candidates if candidate.status == "pending"),
        None,
    )
    if pending is None:
        return job
    original_params = job.params.model_copy(update={"n": len(context.candidates)})
    return _commit_canvas_candidate_attempt(
        job.canvas_project_id,
        job.job_id,
        pending.candidate_id,
        original_params=original_params,
        accumulated_paths=job.output_paths[:successful_count],
        output_path=job.output_paths[successful_count],
        attempt_error=None,
    )


def reconcile_canvas_jobs(
    *,
    fail_pending: bool = False,
    project_id: str | None = None,
    jobs: list[Job] | None = None,
) -> list[str]:
    """Repair terminal Canvas Jobs; optionally fail orphaned in-flight requests on startup.

    jobs 可以传一份已经读好的列表。list_jobs() 会把 `.runtime/jobs/` 下每一个 job 文件读出来
    解析一遍（全仓所有角色、Studio、画布的 job 都在同一个目录），而画布轮询原来一次请求要跑
    两遍：这里一遍，路由拼列表时又一遍。
    """
    reconciled: list[str] = []
    for job in (list_jobs() if jobs is None else jobs):
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
            if job.runner_started_at is not None and _uses_incremental_candidates(job):
                job = _recover_incremental_candidate_output(job)
                context = job.canvas_run
                if context is not None and all(
                    candidate.status != "pending" for candidate in context.candidates
                ):
                    reconciled.append(job.job_id)
                    continue
            if job.cancel_requested_at:
                _cancel_pending_canvas_candidates(job.canvas_project_id, job.job_id)
                reconciled.append(job.job_id)
                continue
            elif job.runner_started_at is None:
                if context is not None and context.batch is not None:
                    # Batch approval is not permission to submit unstarted steps after restart.
                    _cancel_pending_canvas_candidates(job.canvas_project_id, job.job_id)
                    reconciled.append(job.job_id)
                    continue
                # The durable command exists but no provider call was claimed. Startup may resume
                # it without risking a duplicate charge.
                reconciled.append(job.job_id)
                continue
            else:
                _fail_pending_canvas_candidates(
                    job.canvas_project_id,
                    job.job_id,
                    "服务已重启，原生成请求状态未知；未自动重试以避免重复扣费",
                )
        else:
            finalize_canvas_run(job.canvas_project_id, job.job_id)
        reconciled.append(job.job_id)
    return reconciled
