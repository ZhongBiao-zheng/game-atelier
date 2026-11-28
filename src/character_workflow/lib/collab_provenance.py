"""冻结创作参数；画布快照引用已有版本，创作台参考在投送时成为目标画布的版本。"""
from __future__ import annotations

import re
import secrets
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

from character_workflow.lib.canvas_projects import read_canvas_document
from character_workflow.lib.collab_sanitize import public_params
from character_workflow.lib.generation_recipe import _clean_canvas_prompt, _job_output, media_mime
from character_workflow.lib.jobs import read_job
from character_workflow.lib.keys import KeysDB, ModelSpec, read_keys_db
from character_workflow.lib.local_paths import data_root_file
from character_workflow.lib.provider_presets import PRESET_DOMAINS, PRESET_LABELS
from character_workflow.lib.schemas import (
    JOB_PARAM_PATH_FIELDS, CanvasDocument, CanvasFrozenGeneration, CanvasFrozenInput, Job,
)

_ROLES = {"mask_image": "mask", "markup_image": "markup", "mj_sref": "mj_sref",
          "mj_cref": "mj_cref", "mj_oref": "mj_oref"}


def _source_model(job: Job, database: KeysDB) -> tuple[dict, ModelSpec | None]:
    from character_workflow.lib.provider_icons import brand_icon

    key = next((key for key in database.keys if key.alias == job.alias and
                (not job.provider or key.provider == job.provider)), None)
    provider = job.provider or (key.provider if key else "custom")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", provider):
        provider = "custom"
    model = next((model for model in key.models if model.id == job.model), None) if key else None
    if key and provider == "custom":
        try:
            host = urlsplit(key.base_url or "").hostname or ""
        except ValueError:
            host = ""
        provider = next((preset for domain, preset in PRESET_DOMAINS.items()
                         if host == domain or host.endswith("." + domain)), provider)
    return {
        "provider": provider, "provider_label": PRESET_LABELS.get(provider, provider),
        "provider_icon": brand_icon(key.icon) if key else None,
        "model_id": job.model, "model_name": model.name if model else None,
    }, model


def _canvas_inputs(job: Job, document: CanvasDocument) -> list[CanvasFrozenInput]:
    result = []

    def add(version_id: str, role: str) -> None:
        version = document.content_versions.get(version_id)
        if version is None:
            raise ValueError("生成记录引用的输入版本缺失")
        content = {"text": version.text} if version.kind == "text" else {"version_id": version_id}
        result.append(CanvasFrozenInput(role=role, kind=version.kind, order=len(result), **content))

    snapshot = job.canvas_run.snapshot
    for row in sorted(snapshot.inputs, key=lambda item: item.order):
        role = row.source if row.source in {"first_frame", "last_frame", "mj_sref", "mj_cref", "mj_oref"} else (
            "source" if row.source in {"explicit_source", "implicit_self"} else "reference")
        add(row.version_id, role)
        if row.markup_version_id:
            add(row.markup_version_id, "markup")
    if snapshot.mask_version_id:
        add(snapshot.mask_version_id, "mask")
    return result


def build_frozen_from_job(
    job: Job, project_id: str | None, *, document: CanvasDocument | None = None,
    inputs: list[CanvasFrozenInput] | None = None, database: KeysDB | None = None,
) -> CanvasFrozenGeneration:
    if job.namespace not in {"canvas", "studio"}:
        raise ValueError("该任务不属于创作台或画布")
    snapshot = job.canvas_run.snapshot if job.canvas_run else None
    if snapshot:
        if job.canvas_project_id != project_id or (document and document.project_id != project_id):
            raise ValueError("生成记录不属于这张画布")
        document = document or read_canvas_document(project_id)
        inputs = _canvas_inputs(job, document)
    params = {**(snapshot.normalized_params if snapshot else {}),
              **job.params.model_dump(mode="json", exclude_none=True)}
    duration = None
    if job.completed_at:
        try:
            duration = max(0, (datetime.fromisoformat(job.completed_at)
                               - datetime.fromisoformat(job.submitted_at)).total_seconds())
        except (ValueError, TypeError):
            pass
    provider, model = _source_model(job, database or read_keys_db())
    return CanvasFrozenGeneration(
        source_kind=job.namespace, mode=snapshot.mode if snapshot else job.kind.value,
        prompt=(snapshot.draft_prompt if snapshot.draft_prompt is not None else _clean_canvas_prompt(snapshot))
        if snapshot else (job.params.subject_prompt or job.prompt),
        params=public_params(params, model.workflow_inputs if model else ()), inputs=inputs or [], duration_s=duration,
        cost_cny=job.params.actual_cost_cny if job.params.actual_cost_cny is not None
        else job.params.estimated_cost_cny,
        created_by=snapshot.submitted_by.actor_id if snapshot else None,
        submitted_at=job.submitted_at, **provider,
    )


def hydrate_document_provenance(project_id: str, document: CanvasDocument) -> CanvasDocument:
    if document.project_id != project_id:
        raise ValueError("画布归属不匹配")
    versions = dict(document.content_versions)
    snapshots = {}
    database = None
    for version_id, version in versions.items():
        if version.frozen_generation or version.origin.kind not in {"job_output", "layer_decomposition"}:
            continue
        job_id = version.origin.job_id
        if job_id not in snapshots:
            if not re.fullmatch(r"[\w-][\w.-]*", job_id):
                continue
            try:
                job = read_job(job_id)
            except FileNotFoundError:
                continue
            if job.canvas_project_id != project_id:
                continue
            database = database or read_keys_db()
            snapshots[job_id] = build_frozen_from_job(job, project_id, document=document, database=database)
        versions[version_id] = version.model_copy(update={"frozen_generation": snapshots[job_id]})
    return document.model_copy(update={"content_versions": versions})


def studio_output_snapshot(job: Job, output_index: int) -> tuple[Path, CanvasFrozenGeneration, dict[str, Path]]:
    """输出路径、公开快照、将随输出一起复制的输入文件（以临时版本 ID 建索引）。"""
    if not re.fullmatch(r"[\w-][\w.-]*", job.job_id):
        raise ValueError("生成记录标识无效")
    output = data_root_file(str(_job_output(job, output_index)))
    paths = {}
    ids = {}
    rows = []

    def add(raw: str, role: str) -> None:
        path = data_root_file(raw)
        if path not in ids:
            ids[path] = f"version-{secrets.token_hex(12)}"
            paths[ids[path]] = path
        rows.append(CanvasFrozenInput(kind=media_mime(path).split("/")[0], role=role,
                                      version_id=ids[path], order=len(rows)))

    if job.source_image:
        add(job.source_image, "source")
    frame_roles = {"first": ["first_frame"], "last": ["last_frame"],
                   "firstlast": ["first_frame", "last_frame"]}.get(job.params.frame_mode, [])
    for field in JOB_PARAM_PATH_FIELDS:
        values = getattr(job.params, field)
        for index, raw in enumerate([values] if isinstance(values, str) else values or []):
            if field == "reference_images" and raw == job.source_image:
                continue
            role = frame_roles[index] if field == "reference_images" and index < len(frame_roles) else _ROLES.get(field, "reference")
            add(raw, role)
    return output, build_frozen_from_job(job, None, inputs=rows), paths
