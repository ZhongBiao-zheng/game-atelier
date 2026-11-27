"""共享画布可公开的创作参数。供应商请求配置和参考文件路径始终留在产生任务的机器。"""
from __future__ import annotations

import math
import re
from collections.abc import Iterable
from functools import cache

from character_workflow.lib.comfyui_schema import WorkflowInput


_PUBLIC_FIELDS = frozenset("""
    size size_mode custom_size steps cfg_scale n seed ratio resolution quality background
    complexity output_format frame_count frame_duration_ms duration mode frame_mode generate_audio
    watermark temperature max_tokens reasoning_effort voice speed response_format instructions
    lyrics instrumental angle_horizontal angle_pitch angle_distance angle_wide
    requested_size actual_size layer_decomposition layer_max_images bot_type mj_version
    mj_stylize mj_chaos mj_weird mj_seed mj_no mj_tile mj_style_raw mj_iw mj_sref_code mj_profile
    mj_sw mj_cw mj_ow
""".split())
_PRIVATE_VALUE = re.compile(r"(?:^|\s)(?:/[^\s]|[A-Za-z]:[\\/]|\\\\|~/)|(?:file|https?)://", re.I)


def frozen_params(params: dict) -> dict:
    """Validate a portable snapshot, including on machines without its source workflow."""
    if not isinstance(params, dict):
        raise ValueError("生成参数必须是对象")
    result = {
        key: value for key, value in params.items()
        if key in _PUBLIC_FIELDS and isinstance(value, (str, int, float))
        and not (isinstance(value, float) and not math.isfinite(value))
        and not (isinstance(value, str) and _PRIVATE_VALUE.search(value))
    }
    controls = params.get("workflow_inputs")
    if isinstance(controls, dict):
        values = {
            key: value for key, value in controls.items()
            if isinstance(key, str) and re.fullmatch(r"[\w-]{1,80}", key)
            and not _PRIVATE_FIELD.search(key.replace("-", "_"))
            and (value is None or isinstance(value, (str, int, float)))
            and not (isinstance(value, float) and not math.isfinite(value))
            and not (isinstance(value, str) and _SENSITIVE_TEXT.search(value))
        }
        if values:
            result["workflow_inputs"] = values
    return result


def public_params(params: dict, workflow_inputs: Iterable[WorkflowInput] | None = None) -> dict:
    """Project raw job/draft controls against the source model's public declarations."""
    values = params.get("workflow_inputs")
    controls = {}
    if workflow_inputs and isinstance(values, dict):
        from character_workflow.lib.comfyui_workflows import validate_value

        for item in workflow_inputs:
            if (item.id not in values or item.type in {"image", "mask", "prompt"}
                    or any(_PRIVATE_FIELD.search(name.replace("-", "_"))
                           for name in (item.id, item.field, item.label))):
                continue
            value = values[item.id]
            try:
                controls[item.id] = None if item.type == "seed" and value is None else validate_value(item, value)
            except ValueError:
                continue
    return frozen_params({**params, "workflow_inputs": controls})


def _workflow_inputs(alias: str, model_id: str):
    from character_workflow.lib.keys import find_by_alias

    key = find_by_alias(alias)
    model = next((item for item in key.models if item.id == model_id), None) if key else None
    return model.workflow_inputs if model else None


def draft_public_params(params: dict, alias: str | None, model_id: str, lookup=_workflow_inputs) -> dict:
    declarations = lookup(alias, model_id) if alias and params.get("workflow_inputs") else None
    return public_params(params, declarations)


_NODE_FIELDS = frozenset("""
    id type title position size z_index hidden created_by created_by_client collab_run
""".split())
_NODE_DATA_FIELDS = frozenset("""
    current_version_id display annotation result_stack source_node_id source_version_id
    reference_node_id reference_version_id mask_version_id options editor_state member_node_ids
    model prompt resolution max_images base_version_id base_z_index base_visible base_material_node_id
    layout_size layers plugin_id node_type plugin_version package_digest data_schema_version
""".split())
_STORYBOARD_FIELDS = frozenset("""
    ratio style_prefix entities shots script_node_ids id kind name description reference_node_id
    scene shot_size camera duration_s visual dialogue entity_ids image_prompt video_prompt
    image_node_id video_node_id
""".split())


def _storyboard_value(value):
    if isinstance(value, dict):
        return {key: _storyboard_value(item) for key, item in value.items() if key in _STORYBOARD_FIELDS}
    if isinstance(value, list):
        return [_storyboard_value(item) for item in value]
    return value


_PRIVATE_FIELD = re.compile(
    r"password|passcode|authorization|credential|secret|token|api_?key|access_?key|private_?key|"
    r"base_?url|headers?|local_?path", re.I,
)


def _declared_payload(value, fields):
    """Only explicitly named scalar leaves may cross the host boundary."""
    if isinstance(value, list):
        return [_declared_payload(item, fields) for item in value]
    if isinstance(value, dict):
        return {
            key: _declared_payload(item, [path[1:] for path in fields if path and path[0] == key])
            for key, item in value.items()
            if not _PRIVATE_FIELD.search(key) and any(path and path[0] == key for path in fields)
        }
    return value if () in fields else None


def _plugin_projection(data, records):
    from character_workflow.lib import plugin_registry
    if data.shared_placeholder:
        return {}, True
    if data.plugin_id == "storyboard" and data.node_type == "board":
        return _storyboard_value(data.payload), False
    if data.plugin_id not in records:
        records[data.plugin_id] = plugin_registry.find(data.plugin_id)
    record = records[data.plugin_id]
    if record and record.lock and record.availability == "ok":
        lock = record.lock
        if lock.version == data.plugin_version and (not data.package_digest or lock.digest == data.package_digest):
            contribution = next((item for item in lock.contributes.nodes if item.type == data.node_type
                                 and item.payload_schema_version == data.data_schema_version), None)
            if contribution and contribution.shared_fields:
                return _declared_payload(data.payload, [tuple(path.split(".")) for path in contribution.shared_fields]), False
    return {}, True


def _node_view(node, records=None, workflow_lookup=_workflow_inputs):
    row = node.model_dump(mode="json")
    data = {key: value for key, value in row["data"].items() if key in _NODE_DATA_FIELDS}
    if draft := row["data"].get("generation_draft"):
        data["generation_draft"] = {key: draft[key] for key in ("mode", "prompt", "input_policy", "model", "updated_at")}
        data["generation_draft"]["params"] = draft_public_params(
            draft["params"], draft.get("alias"), draft["model"], workflow_lookup,
        )
    if node.type == "plugin":
        data["payload"], placeholder = _plugin_projection(node.data, records if records is not None else {})
        if placeholder:
            data["shared_placeholder"] = True
    return {**{key: value for key, value in row.items() if key in _NODE_FIELDS}, "data": data}


def _version_view(version):
    import hashlib
    row = version.model_dump(mode="json")
    view = {key: row[key] for key in (
        "version_id", "kind", "created_at", "sha256", "text", "mime_type", "bytes",
        "width", "height", "duration_ms", "frozen_generation",
    ) if key in row}
    if version.kind == "text":
        view["origin"] = {"kind": "user_edit"}
    else:
        upload = hashlib.sha256(version.version_id.encode()).hexdigest()
        view["path"] = f"uploads/{upload}.bin"
        view["origin"] = (version.origin.model_dump(mode="json") if version.origin.kind == "user_mask"
                          else {"kind": "upload", "upload_id": upload})
    return view


_SENSITIVE_TEXT = re.compile(
    r"(?:^|[\s\x22\x27=:(])(?:/[^/\s]|[A-Za-z]:[\\/]|\\\\|~/)|(?:file|https?)://"
    r"|\bsk-[A-Za-z0-9_-]{8,}|(?:authorization|api[_-]?key|access[_-]?key|password|token)\s*[:=]",
    re.I,
)


def public_text(value: str) -> str:
    if not _SENSITIVE_TEXT.search(value):
        return value
    from character_workflow.lib.job_runner import _redact_local_paths
    return _redact_local_paths(value)


def _public_values(value):
    if isinstance(value, str):
        return public_text(value)
    if isinstance(value, list):
        return [_public_values(item) for item in value]
    if isinstance(value, dict):
        return {key: _public_values(item) for key, item in value.items()}
    return value


def _merge_storyboard_fields(original, before, after):
    result = dict(original)
    for key, value in after.items():
        if key not in _STORYBOARD_FIELDS or (key in before and before[key] == value):
            continue
        raw = original.get(key)
        if raw != _public_values(raw):
            raise ValueError("这个字段含房主的私有内容，请房主编辑")
        result[key] = value
    return result


def _storyboard_rows(rows):
    if (not isinstance(rows, list) or any(not isinstance(row, dict)
            or not isinstance(row.get("id"), str) for row in rows)):
        raise ValueError("分镜条目格式无效")
    by_id = {row["id"]: row for row in rows}
    if len(by_id) != len(rows):
        raise ValueError("分镜条目标识重复")
    return by_id


def merge_storyboard_edit(original, before, after):
    """Apply only the guest's edits to the host payload, matching shots and entities by ID."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise ValueError("请刷新分镜后再编辑")
    if not isinstance(original, dict):
        original = {}
    result = _merge_storyboard_fields(original, before, {
        key: value for key, value in after.items() if key not in {"entities", "shots"}
    })
    for key in ("entities", "shots"):
        if after.get(key) == before.get(key):
            continue
        current = _storyboard_rows(original.get(key, []))
        base = _storyboard_rows(before.get(key, []))
        edited = _storyboard_rows(after.get(key, []))
        # A reorder/add/delete may race another structural edit. Keep both authors' data
        # on disk and ask the later editor to reapply against the new order.
        reordered = list(base) != list(edited)
        if reordered and list(current) != list(base):
            raise ValueError("分镜条目已变化，请刷新后再编辑")
        order = edited if reordered else current
        for row_id, row in edited.items():
            if row == base.get(row_id):
                continue
            if row_id in base and row_id not in current:
                raise ValueError("分镜条目已删除，请刷新后再编辑")
            current[row_id] = _merge_storyboard_fields(current.get(row_id, {}), base.get(row_id, {}), row)
        result[key] = [current[row_id] for row_id in order]
    return result


def public_document(project_id: str) -> dict:
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.collab_provenance import hydrate_document_provenance
    document = hydrate_document_provenance(project_id, read_canvas_document(project_id))
    if any(public_text(key) != key for key in document.content_versions):
        raise ValueError("内容版本编号无效")
    records = {}
    workflow_lookup = cache(_workflow_inputs)
    return {
        "schema_version": document.schema_version, "project_id": document.project_id,
        "revision": document.revision, "updated_at": document.updated_at,
        "viewport": document.viewport.model_dump(), "settings": document.settings.model_dump(),
        "nodes": [_public_values(_node_view(node, records, workflow_lookup)) for node in document.nodes],
        "connections": [_public_values(row.model_dump()) for row in document.connections],
        "content_versions": {key: _public_values(_version_view(version)) for key, version in document.content_versions.items()},
    }
