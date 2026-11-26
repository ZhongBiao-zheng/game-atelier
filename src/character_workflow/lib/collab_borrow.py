"""Host-approved direct providers available inside one shared canvas."""
from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

from character_workflow.lib import collab_config
from character_workflow.lib.provider_presets import PRESET_DOMAINS, PRESET_LABELS
from character_workflow.lib.collab_sanitize import public_params, public_text
from character_workflow.lib.generation_pricing import estimate_submission, estimate_text_cost_cny
from character_workflow.lib.keys import KeySpec, ModelSpec, model_modality, read_keys_db
from character_workflow.lib.schemas import (
    CANVAS_DRAFT_PARAM_FIELDS, CanvasGenerationDraft, CanvasLayerStackNode, JobParams,
)


_DIRECT_DOMAINS = {
    "openai": "api.openai.com", "seedream": "ark.cn-beijing.volces.com", "tokendance": "tokendance.space",
    "openrouter": "openrouter.ai", "evolink": "api.evolink.ai",
}
_CUSTOM_ENDPOINTS = {host: preset for host, preset in PRESET_DOMAINS.items()
                     if preset not in {"tuzi", "openai-hk"}}
_CUSTOM_ENDPOINTS.update({"api.tu-zi.com": "tuzi", "api.openai-hk.com": "openai-hk"})
_MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?")


def _direct_preset(key: KeySpec) -> str | None:
    if not key.base_url:
        return key.provider if key.provider in {*_DIRECT_DOMAINS, "chatgpt"} else None
    try:
        url = urlsplit(key.base_url)
        if url.scheme != "https" or url.username or url.password or url.port not in (None, 443):
            return None
        host = url.hostname or ""
    except ValueError:
        return None
    if key.provider == "custom":
        return _CUSTOM_ENDPOINTS.get(host)
    domain = _DIRECT_DOMAINS.get(key.provider)
    return key.provider if domain == host else None


def channel_id(key: KeySpec) -> str:
    identity = [_direct_preset(key) or key.provider, key.alias, (key.base_url or "").rstrip("/")]
    return hashlib.sha256("\0".join(identity).encode()).hexdigest()[:32]


def _safe_label(value: str, key: KeySpec) -> bool:
    return (len(value) <= 200 and public_text(value) == value and "://" not in value
            and not any(secret and secret in value for secret in (key.access_key, key.secret_key))
            and not any(ord(char) < 32 for char in value))


def eligible(key: KeySpec, model: ModelSpec) -> bool:
    return (key.enabled and _direct_preset(key) is not None and _safe_label(model.id, key)
            and bool(_MODEL_ID.fullmatch(model.id)) and ".." not in model.id.split("/")
            and model.protocol not in {"declarative", "comfyui", "atelier_gateway"}
            and (model.protocol is None or (_safe_label(model.protocol, key)
                 and bool(re.fullmatch("[a-zA-Z0-9_-]{1,64}", model.protocol))))
            and not model.declarative_id and model.workflow_inputs is None and not model.via
            and model.declared_snapshot is None)


def _price(key, model, kind):
    if kind == "text":
        return {"cost_unit": "million_tokens", "cost_cny": None,
                "input_cny_per_m": estimate_text_cost_cny(model.id, 1_000_000, 0, key=key),
                "output_cny_per_m": estimate_text_cost_cny(model.id, 0, 1_000_000, key=key)}
    if kind == "audio":
        from character_workflow.lib.audio_caps import audio_caps
        caps = audio_caps(key, model)
        synced = estimate_submission(key, model.id, kind, {}, manual=False)
        if synced is not None and caps:
            if caps.family == "speech":
                return {"cost_unit": "1000_chars", "unit_cost_cny": synced, "cost_cny": None}
            return {"cost_unit": "song", "cost_cny": synced}
    options = {"duration": 5, "resolution": "720p", "ratio": "16:9"} if kind == "video" else {}
    return {"cost_unit": "request", "cost_cny": estimate_submission(key, model.id, kind, options)}


OPERATION_ERRORS = {
    "inpaint": ("canvas_inpaint_model_invalid", "当前模型不支持局部修改，请选择兼容模型。"),
    "outpaint": ("canvas_outpaint_model_invalid", "当前模型不支持扩图，请选择兼容模型。"),
    "layer_decomposition": ("canvas_layer_decomposition_model_invalid", "当前模型不支持图层拆分，请选择兼容模型。"),
}


def supported_operations(key: KeySpec, model: ModelSpec) -> list[str]:
    from character_workflow.lib.callers.image_edit import edit_transport_for_key
    from character_workflow.lib.callers.openai_image import supports_layer_decomposition

    if not key.enabled or model_modality(model, key) != "image":
        return []
    operations = [mode for mode in ("inpaint", "outpaint") if edit_transport_for_key(key, model.id, mode)]
    if supports_layer_decomposition(key, model.id):
        operations.append("layer_decomposition")
    return operations


def require_surface_model(surface, key: KeySpec | None, model_id: str) -> None:
    from character_workflow.lib.canvas_runs import CanvasRunCommandError

    if surface.type not in {"image_edit", "layer_stack"}:
        return
    operation = surface.data.options.mode if surface.type == "image_edit" else "layer_decomposition"
    model = next((item for item in key.models if item.id == model_id), None) if key else None
    if model is None or operation not in supported_operations(key, model):
        raise CanvasRunCommandError(*OPERATION_ERRORS[operation])


def borrowable_models() -> list[dict]:
    from character_workflow.lib.provider_icons import brand_icon

    models = []
    for key in read_keys_db().keys:
        for model in key.models:
            if not eligible(key, model):
                continue
            kind = model_modality(model, key)
            preset = _direct_preset(key)
            models.append({
                "channel_id": channel_id(key), "model": model.id,
                "name": model.name if _safe_label(model.name, key) else model.id,
                "mode": kind, "provider": preset, "provider_label": PRESET_LABELS[preset],
                "icon": brand_icon(key.icon), "input_modalities": list(model.input_modalities),
                "protocol": model.protocol, "supported_operations": supported_operations(key, model),
                **_price(key, model, kind),
            })
    return models


class BorrowUnavailable(ValueError):
    pass


def is_borrowed(job) -> bool:
    return bool(job.namespace == "canvas" and job.params.collab_guest_name
                and job.params.collab_guest_client and job.params.collab_borrow_channel)


def staged_canvas_name(job) -> str | None:
    if job.namespace == "canvas" and re.fullmatch(r"canvas-collab-[a-f0-9]{24}", job.canvas_project_id or ""):
        return job.params.collab_source_canvas
    return None


@contextmanager
def borrowed_execution(job):
    """Recheck after the queue, pin exactly this key for all caller lookups in this attempt."""
    if not is_borrowed(job):
        yield
        return
    from character_workflow.lib.keys import pin_provider_key
    entry = collab_config.read_config().shares.get(job.canvas_project_id)
    if not entry or not entry.enabled or entry.mode != "edit" or not entry.allow_borrow_provider:
        raise BorrowUnavailable("房主已关闭供应商借用")
    try:
        key, _ = resolve_channel(job.params.collab_borrow_channel, job.model)
    except ValueError:
        raise BorrowUnavailable("房主供应商设置已变化") from None
    if key.alias != job.alias or key.provider != job.provider:
        raise BorrowUnavailable("房主供应商设置已变化")
    with pin_provider_key(key):
        yield


def resolve_channel(identifier: str, model_id: str):
    for key in read_keys_db().keys:
        if channel_id(key) == identifier:
            for model in key.models:
                if model.id == model_id and eligible(key, model):
                    return key, model
    raise ValueError("房主未开放这个供应商模型")


@dataclass(frozen=True)
class BorrowedGeneration:
    channel: str
    model: str
    prompt: str | None
    params: dict | None
    guest_name: str
    client_id: str
    authorize: Callable[[], None]

    def surface(self, node):
        self.authorize()
        key, model = resolve_channel(self.channel, self.model)
        require_surface_model(node, key, model.id)
        if isinstance(node, CanvasLayerStackNode):
            data = {"alias": key.alias, "model": model.id}
            if self.prompt is not None:
                data["prompt"] = self.prompt
        else:
            if node.type not in {"text", "image", "video", "audio", "image_edit"}:
                raise ValueError("这个节点无法生成")
            existing = node.data.generation_draft
            mode = existing.mode if existing else ("image" if node.type == "image_edit" else node.type)
            params = public_params(existing.params.model_dump(exclude_none=True)) if existing else {}
            if self.params is not None:
                params.update(public_params(self.params))
            draft = CanvasGenerationDraft(mode=mode, model=model.id, alias=key.alias,
                    prompt=self.prompt if self.prompt is not None else (existing.prompt if existing else ""),
                    params=JobParams(**{k: v for k, v in params.items() if k in CANVAS_DRAFT_PARAM_FIELDS[mode]}),
                    updated_at=datetime.now(timezone.utc).isoformat())
            data = {"generation_draft": draft}
        return node.model_copy(update={"data": node.data.model_copy(update=data)})

    def attribute(self, key, model, params):
        # Repeat policy and channel checks at the job transaction boundary.
        self.authorize()
        if not eligible(key, model) or channel_id(key) != self.channel or model.id != self.model:
            raise ValueError("房主供应商设置已变化")
        params.collab_guest_name = self.guest_name
        params.collab_guest_client = self.client_id
        params.collab_borrow_channel = self.channel


def mark_borrowed_result(job, document):
    from character_workflow.lib.collab_run_state import CanvasCollabRun
    context = job.canvas_run
    if not context or not is_borrowed(job):
        return
    status = {"failed": "failed", "canceled": "interrupted", "done": "done",
              "partial": "done"}.get(job.status.value, "pending")
    result = next((node for node in document.nodes if node.id == context.result_node_id), None)
    if not result:
        return
    if status == "done" and result.type == "image":
        _materialize_image_candidates(document, result, job)
    # Keep the original author when a previously populated surface is reused.
    if result.created_by_client is None and context.result_node_id != context.snapshot.surface_node_id:
        result.created_by = job.params.collab_guest_name
        result.created_by_client = job.params.collab_guest_client
    result.collab_run = CanvasCollabRun(
        run_id=context.run_id, source_node_id=context.snapshot.surface_node_id, status=status,
        execution_mode="borrowed", initiated_by=job.params.collab_guest_name, model=job.model,
        mode=context.snapshot.mode, started_at=job.submitted_at,
        error="生成失败，请检查房主的任务记录" if status == "failed" else None,
    )


def _materialize_image_candidates(document, cover, job):
    from character_workflow.lib.canvas_library import _content_node
    from character_workflow.lib.schemas import CanvasPoint, CanvasResultStack

    context = job.canvas_run
    if len(context.candidates) <= 1 or (cover.data.result_stack and cover.data.result_stack.run_id == context.run_id):
        return
    members = []
    width = cover.size.width if cover.size else 320
    for candidate in context.candidates:
        version_id = candidate.version_id
        if (candidate.status != "succeeded" or not version_id or version_id == cover.data.current_version_id
                or version_id not in document.content_versions):
            continue
        position = CanvasPoint(x=cover.position.x + (width + 16) * (len(members) + 1), y=cover.position.y)
        member = _content_node(version_id, f"{cover.title[:110]} · {candidate.index + 1}", position, "image")
        member.size = cover.size
        member.z_index = cover.z_index
        member.created_by, member.created_by_client = job.params.collab_guest_name, job.params.collab_guest_client
        members.append(member.id)
        document.nodes.append(member)
    cover.data.result_stack = CanvasResultStack(run_id=context.run_id, member_node_ids=members)


def record_text_cost(job, params, key, usage):
    """Persist every confirmed text response, including candidates followed by a failed call."""
    import math

    from character_workflow.lib.job_runner import USD_TO_CNY
    from character_workflow.lib.jobs import update_job_params
    from character_workflow.lib.llm_protocols.usage import from_openai

    if not isinstance(usage, dict):
        return
    usd = usage.get("cost")
    if (key.provider == "openrouter" and type(usd) in {int, float}
            and math.isfinite(usd) and usd >= 0):
        amount = usd * USD_TO_CNY
    else:
        tokens = from_openai(usage)
        if tokens is None:
            return
        amount = estimate_text_cost_cny(
            job.model, tokens.input_total, tokens.output_total, key=key,
            cached_tokens=tokens.cache_read, cache_write_tokens=tokens.cache_write)
    if amount is not None:
        params["actual_cost_cny"] = round((params.get("actual_cost_cny") or 0) + amount, 6)
        update_job_params(job.job_id, params)


def candidate_costs(candidates):
    charged = [item for item in candidates if item.status == "succeeded" or item.actual_cost_cny is not None]
    if not charged:
        return {"estimated_cost_cny": None, "actual_cost_cny": None}
    actual = [item.actual_cost_cny for item in charged]
    estimates = [cost if cost is not None else item.estimated_cost_cny for item, cost in zip(charged, actual)]
    return {
        "actual_cost_cny": round(sum(actual), 6) if None not in actual else None,
        "estimated_cost_cny": round(sum(estimates), 6) if None not in estimates else None,
    }
