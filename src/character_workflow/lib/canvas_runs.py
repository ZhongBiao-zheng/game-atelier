"""Canvas generation runs: freeze drafts, transact jobs, and commit durable results."""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
from threading import BoundedSemaphore, Lock
from typing import Any, Literal

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_bytes, atomic_write_json
from character_workflow.lib.canvas_projects import canvas_project_dir, read_canvas_project
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.job_runner import image_dimensions, is_valid_audio, run_job
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
                "submit", "retry", "reverse_prompt", "mask_edit", "angle"
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


def _resolve_default_image_model() -> tuple[KeySpec, ModelSpec]:
    for key in _keys_default_first():
        for model in key.models:
            if _model_modality(model, key) == "image":
                return key, model
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


def _resolve_inputs(
    document: CanvasDocument,
    surface: CanvasNode,
    draft: CanvasGenerationDraft,
) -> list[CanvasSnapshotInput]:
    candidates: list[tuple[str, str]] = []
    self_version_id = _current_version_id(surface)
    if self_version_id is not None and draft.mode != "audio":
        candidates.append(("implicit_self", surface.id))

    editing_existing_video = (
        surface.type == "video"
        and draft.mode == "video"
        and self_version_id is not None
    )
    if editing_existing_video and _MENTION.search(draft.prompt):
        raise ValueError("视频编辑只使用当前视频，不接受其它节点引用")

    incoming = [
        edge for edge in document.connections
        if edge.role == "input" and edge.target_node_id == surface.id
    ]
    if editing_existing_video:
        incoming = []
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
    media_labels: list[str] = []
    kind_counts = {"text": 0, "image": 0, "video": 0, "audio": 0}
    # Draft tokens are stable node IDs. Labels are rebuilt only after the current graph and
    # concrete versions have been frozen, so reconnecting or reordering cannot misaddress media.
    for item in inputs:
        version = document.content_versions[item.version_id]
        kind_counts[version.kind] += 1
        label = _input_label(version.kind, kind_counts[version.kind])
        marker = f"@[node:{item.node_id}]"
        if version.kind == "text":
            if marker in prompt:
                prompt = prompt.replace(marker, f"【{label}】")
                appended_text.append(f"【{label}】\n{version.text}")
            else:
                appended_text.append(f"【{label}】\n{version.text}")
        else:
            media_labels.append(label)
            if marker in prompt:
                prompt = prompt.replace(marker, label)
    if media_labels:
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
) -> None:
    counts = {
        media_kind: sum(item.kind == media_kind for item in inputs)
        for media_kind in ("image", "video", "audio")
    }
    if kind in {JobKind.TEXT, JobKind.AUDIO}:
        if any(counts.values()):
            label = "文本" if kind == JobKind.TEXT else "音频"
            raise ValueError(f"当前{label}生成只支持文本输入")
        return
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
    key: KeySpec,
    model: ModelSpec,
) -> tuple[dict[str, Any], JobParams, int]:
    from character_workflow.lib.callers.openai_image import image_family, resolve_image_protocol

    normalized = draft.params.model_dump(mode="json", exclude_none=True)
    for field in (
        "actual_size",
        "warnings",
        "requested_size",
        "reference_images",
        "reference_videos",
        "reference_audios",
    ):
        normalized.pop(field, None)
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
) -> tuple[Job, CanvasDocument]:
    timestamp = _now()
    job_id = new_job_id()
    run_id = run_id or f"run-{secrets.token_hex(12)}"
    use_surface = (
        allow_surface_reuse
        and surface.type in {"text", "image", "video", "audio"}
        and surface.type == mode
        and _current_version_id(surface) is None
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
        normalized, job_params, effective_count = _normalized_params(
            draft,
            requested_count,
            key,
            model,
        )
        inputs = _resolve_inputs(current, surface, draft)
        _validate_input_capabilities(model, kind, inputs, job_params)
        final_prompt = _render_final_prompt(current, draft, inputs)
        media_paths = _input_paths(project_id, current, inputs)
        job_params.reference_images = media_paths["image"] or None
        job_params.reference_videos = media_paths["video"] or None
        job_params.reference_audios = media_paths["audio"] or None
        return _commit_frozen_run(
            project_id,
            current,
            surface,
            key,
            model,
            kind,
            mode=draft.mode,
            final_prompt=final_prompt,
            input_policy=draft.input_policy,
            normalized=normalized,
            job_params=job_params,
            inputs=inputs,
            requested_count=effective_count,
            result_title={
                "text": "生成文本",
                "image": "生成图片",
                "video": "生成视频",
                "audio": "生成音频",
            }[draft.mode],
            result_draft=draft,
            allow_surface_reuse=True,
            transaction_kind="submit",
        )


def submit_reverse_prompt_run(
    project_id: str,
    surface_node_id: str,
    expected_revision: int,
) -> tuple[Job, CanvasDocument]:
    """Freeze one owned image into the versioned reverse-prompt preset and a text Run."""
    with file_lock(_lock_path(project_id)):
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
        with file_lock(_lock_path(project_id)):
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
            _validate_input_capabilities(model, kind, inputs, job_params)
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
    with file_lock(_lock_path(project_id)):
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
    with file_lock(_lock_path(project_id)):
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
            key, model = _resolve_default_image_model()
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
                    params=JobParams(n=1, ratio="1:1"),
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


def _validate_retry_snapshot(
    project_id: str,
    document: CanvasDocument,
    snapshot: CanvasGenerationSnapshot,
) -> dict[str, list[str]]:
    for item in snapshot.inputs:
        version = document.content_versions.get(item.version_id)
        if version is None or version.kind != item.kind:
            raise RuntimeError("snapshot_input_missing")
        if version.kind == "text":
            digest = hashlib.sha256(version.text.encode("utf-8")).hexdigest()
            if digest != version.sha256:
                raise RuntimeError("snapshot_input_changed")
    try:
        paths = _input_paths(project_id, document, snapshot.inputs)
    except ValueError as error:
        raise RuntimeError("snapshot_input_missing") from error
    for item in snapshot.inputs:
        version = document.content_versions[item.version_id]
        if version.kind == "text":
            continue
        target = canvas_project_dir(project_id) / version.path
        if _sha256_file(target) != version.sha256:
            raise RuntimeError("snapshot_input_changed")
    paths["mask"] = []
    if snapshot.mask_version_id is not None:
        mask = document.content_versions.get(snapshot.mask_version_id)
        source_ids = {item.version_id for item in snapshot.inputs if item.kind == "image"}
        if (
            not isinstance(mask, CanvasMediaVersion)
            or mask.kind != "image"
            or mask.origin.kind != "user_mask"
            or mask.origin.source_version_id not in source_ids
        ):
            raise RuntimeError("snapshot_mask_missing")
        root = canvas_project_dir(project_id).resolve()
        target = (root / mask.path).resolve()
        if (
            not target.is_relative_to(root)
            or not target.is_file()
            or _sha256_file(target) != mask.sha256
        ):
            raise RuntimeError("snapshot_mask_changed")
        paths["mask"] = [str(target)]
    return paths


def _retry_job_params(
    snapshot: CanvasGenerationSnapshot,
    media_paths: dict[str, list[str]],
    requested_count: int,
) -> JobParams:
    normalized = dict(snapshot.normalized_params)
    if snapshot.mode in {"text", "image"}:
        normalized["n"] = requested_count
    else:
        normalized.pop("n", None)
    params = JobParams(**normalized)
    params.reference_images = media_paths["image"] or None
    params.reference_videos = media_paths["video"] or None
    params.reference_audios = media_paths["audio"] or None
    params.mask_image = (media_paths.get("mask") or [None])[0]
    return params


def retry_canvas_run(
    project_id: str,
    run_id: str,
    mode: str,
    expected_revision: int,
    candidate_id: str | None = None,
) -> tuple[Job, CanvasDocument]:
    """Retry an immutable Snapshot, or submit the result node's current Draft."""
    original = _job_for_run(project_id, run_id)
    context = original.canvas_run
    if context is None:
        raise ValueError("Canvas Run 缺少 Snapshot")
    if mode == "current":
        if candidate_id is not None:
            raise ValueError("按当前设置再次生成不能指定历史候选")
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
    if mode != "original":
        raise ValueError("未知的重试模式")

    with file_lock(_lock_path(project_id)):
        recover_canvas_transactions_unlocked(project_id)
        current = _read_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        with job_lock(original.job_id):
            original = read_job(original.job_id)
        if original.status in {JobStatus.PENDING, JobStatus.PENDING_CONFIRM}:
            raise RuntimeError("run_not_terminal")
        context = original.canvas_run
        if context is None:
            raise ValueError("Canvas Run 缺少 Snapshot")
        result = next(
            (node for node in current.nodes if node.id == context.result_node_id),
            None,
        )
        if result is None or result.type not in {"text", "image", "video", "audio"}:
            raise RuntimeError("result_node_missing")
        replaced: CanvasResultCandidate | None = None
        if candidate_id is not None:
            replaced = next(
                (item for item in context.candidates if item.candidate_id == candidate_id),
                None,
            )
            if replaced is None:
                raise KeyError(candidate_id)
            if replaced.status not in {"failed", "canceled"}:
                raise ValueError("只能单独重试失败或已停止的候选")
            candidate_indices = [replaced.index]
        else:
            candidate_indices = [item.index for item in context.candidates]
        if context.snapshot.mode not in {"text", "image"} and len(candidate_indices) != 1:
            raise ValueError("视频与音频生成一次只允许一个结果")

        media_paths = _validate_retry_snapshot(project_id, current, context.snapshot)
        database = read_keys_db()
        key = next((item for item in database.keys if item.alias == context.snapshot.alias), None)
        model = next(
            (item for item in key.models if item.id == context.snapshot.model),
            None,
        ) if key is not None else None
        if key is None or model is None or key.provider != context.snapshot.provider:
            raise RuntimeError("snapshot_model_missing")

        timestamp = _now()
        new_run_id = f"run-{secrets.token_hex(12)}"
        retry_job_id = new_job_id()
        retry_normalized = dict(context.snapshot.normalized_params)
        if context.snapshot.mode in {"text", "image"}:
            retry_normalized["n"] = len(candidate_indices)
        retry_snapshot_payload = context.snapshot.model_dump(
            mode="json",
            exclude={"request_fingerprint"},
        )
        retry_snapshot_payload.update({
            "normalized_params": retry_normalized,
            "submitted_at": timestamp,
            "submitted_by": CanvasActor(kind="user").model_dump(mode="json"),
        })
        retry_snapshot = CanvasGenerationSnapshot(
            **retry_snapshot_payload,
            request_fingerprint=_canonical_sha(retry_snapshot_payload),
        )
        candidates = [
            CanvasResultCandidate(
                candidate_id=f"candidate-{secrets.token_hex(10)}",
                index=index,
                status="pending",
                replaces_candidate_id=replaced.candidate_id if replaced is not None else None,
            )
            for index in candidate_indices
        ]
        new_context = CanvasJobContext(
            run_id=new_run_id,
            snapshot=retry_snapshot,
            result_node_id=context.result_node_id,
            candidates=candidates,
        )
        job = Job(
            job_id=retry_job_id,
            character_id=key.alias,
            prompt=retry_snapshot.final_prompt,
            submitted_at=timestamp,
            model=model.id,
            params=_retry_job_params(retry_snapshot, media_paths, len(candidates)),
            output_paths=[],
            status=JobStatus.PENDING,
            error=None,
            asset_slot=AssetSlot.PORTRAIT,
            kind=JobKind(retry_snapshot.mode),
            namespace="canvas",
            canvas_project_id=project_id,
            canvas_run=new_context,
            alias=key.alias,
            provider=key.provider,
            retry_of=original.job_id,
        )
        nodes = [
            _with_active_run(node, new_run_id)
            if node.id == context.result_node_id else node
            for node in current.nodes
        ]
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "nodes": nodes,
        })
        _commit_transaction_unlocked(
            project_id,
            new_run_id,
            "retry",
            current.revision,
            job,
            updated,
        )
        return job, updated


def request_canvas_run_cancel(project_id: str, run_id: str) -> Job:
    """Persist an idempotent stop request without pretending the provider already stopped."""
    original = _job_for_run(project_id, run_id)
    with file_lock(_lock_path(project_id)):
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
    with file_lock(_lock_path(project_id)):
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
    with file_lock(_lock_path(project_id)):
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

            single_candidate_retry = (
                len(candidates) == 1
                and candidates[0].replaces_candidate_id is not None
            )
            nodes: list[CanvasNode] = []
            for node in current.nodes:
                if (
                    node.id == context.result_node_id
                    and node.type in {"text", "image", "video", "audio"}
                    and node.data.active_run_id == context.run_id
                    and not had_success
                    and (not single_candidate_retry or node.data.current_version_id is None)
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
    with file_lock(_lock_path(project_id)):
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
    single_candidate_retry = (
        len(candidates) == 1
        and candidates[0].replaces_candidate_id is not None
    )
    nodes: list[CanvasNode] = []
    for node in current.nodes:
        if (
            node.id == context.result_node_id
            and node.type in {"text", "image", "video", "audio"}
            and node.data.active_run_id == context.run_id
        ):
            # A repaired slot joins the batch but never steals an already-successful primary.
            # Full retries and first successes still become the displayed result.
            if not single_candidate_retry or node.data.current_version_id is None:
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
