"""The sole writer of ComfyUI workflows and their model catalog entries."""
from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote
from uuid import uuid4

import requests
from pydantic import BaseModel, ConfigDict, Field

from character_workflow.lib import data_root, keys
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.comfyui_client import ComfyUIClient, ComfyUIUnavailableError
from character_workflow.lib.comfyui_schema import WorkflowInput


class Workflow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^comfyui-[a-z0-9-]{1,100}$")
    alias: str
    name: str = Field(min_length=1, max_length=160)
    source_filename: str = Field(max_length=255)
    imported_at: str
    api_workflow: dict[str, Any]
    inputs: list[WorkflowInput] = Field(max_length=100)
    timeout_seconds: int = Field(default=1800, ge=1, le=86400)


def _path(identifier: str):
    if not re.fullmatch(r"comfyui-[a-z0-9-]{1,100}", identifier):
        raise ValueError("工作流 ID 无效")
    return data_root.resolve_data_root() / "comfyui" / "workflows" / f"{identifier}.json"


def provider(alias: str):
    key = keys.find_by_alias(alias)
    if key is None or key.provider != "comfyui":
        raise ValueError("找不到 ComfyUI 供应商")
    return key


def _read(alias: str, identifier: str) -> Workflow:
    path = _path(identifier)
    if not path.exists():
        raise ValueError("工作流不存在，请重新导入")
    workflow = Workflow.model_validate_json(path.read_text(encoding="utf-8"))
    if workflow.alias != alias:
        raise ValueError("工作流不属于此供应商")
    return workflow


def read_workflow(alias: str, identifier: str) -> Workflow:
    with keys.keys_lock():
        key = provider(alias)
        if not any(model.id == identifier for model in key.models):
            raise ValueError("工作流不存在，请重新导入")
        return _read(alias, identifier)


def list_workflows(alias: str) -> list[Workflow]:
    with keys.keys_lock():
        return [_read(alias, model.id) for model in provider(alias).models]


def validate_api(workflow: dict) -> None:
    if isinstance(workflow.get("nodes"), list) or isinstance(workflow.get("links"), list):
        raise ValueError("请在 ComfyUI 用 Export (API) 导出")
    if not workflow or len(workflow) > 2000 or any(
        not isinstance(node, dict) or not isinstance(node.get("class_type"), str)
        or not isinstance(node.get("inputs"), dict) for node in workflow.values()
    ):
        raise ValueError("不是有效的 ComfyUI API 工作流")
    classes = [node["class_type"] for node in workflow.values()]
    if any(re.search(r"(save.*(video|audio)|video.*combine|videocombine|saveanimated)",
                     name, re.I) for name in classes):
        raise ValueError("暂不支持视频或音频输出的工作流")
    if "SaveImage" not in classes:
        if "PreviewImage" in classes:
            raise ValueError("请改用 SaveImage")
        raise ValueError("工作流至少需要一个 SaveImage 输出节点；暂不支持其他输出")


def validate_mappings(workflow: dict, inputs: list[WorkflowInput]) -> None:
    validate_api(workflow)
    seen_ids, seen_fields = set(), set()
    for item in inputs:
        node = workflow.get(item.node_id)
        if (not node or node["class_type"] != item.class_type
                or item.field not in node["inputs"]
                or isinstance(node["inputs"][item.field], (list, dict))):
            raise ValueError(f"工作流已变更，请重新导入：{item.label}")
        if item.id in seen_ids or (item.node_id, item.field) in seen_fields:
            raise ValueError("输入 ID 和映射字段不能重复")
        seen_ids.add(item.id)
        seen_fields.add((item.node_id, item.field))
        if item.type not in {"image", "mask"} and item.default is not None:
            validate_value(item, item.default)
    for kind in ("prompt", "mask"):
        if sum(item.type == kind for item in inputs) > 1:
            raise ValueError(f"{kind} 输入最多一个")


def validate_value(item: WorkflowInput, value: Any):
    if value is None or value == "":
        if item.required:
            raise ValueError(f"请填写：{item.label}")
        return value
    kind = item.type
    valid = True
    if kind in {"prompt", "text", "image", "mask"}:
        valid = isinstance(value, str) and len(value) <= 40000
    elif kind in {"int", "seed"}:
        valid = type(value) is int and abs(value) <= 9007199254740991
    elif kind == "float":
        valid = type(value) in {int, float} and math.isfinite(value)
    elif kind == "boolean":
        valid = type(value) is bool
    elif kind == "select":
        valid = any(type(value) is type(option.value) and value == option.value
                    for option in item.options)
    if not valid:
        raise ValueError(f"输入类型或选项无效：{item.label}")
    if kind in {"int", "float", "seed"}:
        if ((item.min is not None and value < item.min)
                or (item.max is not None and value > item.max)
                or (kind == "seed" and value < 0)):
            raise ValueError(f"输入超出范围：{item.label}")
    return value


def validate_values(inputs: list[WorkflowInput], values: dict) -> dict:
    declared = {item.id: item for item in inputs if item.type not in {"image", "mask", "prompt"}}
    if values.keys() - declared.keys():
        raise ValueError("不接受未声明的工作流输入或素材路径")
    result = {}
    for identifier, item in declared.items():
        value = values.get(identifier, None if item.type == "seed" else item.default)
        result[identifier] = (None if item.type == "seed" and value is None
                              else validate_value(item, value))
    return result


def _candidate(node_id: str, node: dict, field: str, value: Any, prompt_seen: bool):
    kind = node["class_type"]
    title = str(node.get("_meta", {}).get("title", ""))
    label = title[3:].strip() if title.startswith("in:") else f"{kind} · {field}"
    inferred = ("boolean" if isinstance(value, bool) else "int" if isinstance(value, int)
                else "float" if isinstance(value, float) else "text")
    if kind in {"LoadImage", "LoadImageMask"} and field == "image":
        inferred = "mask" if kind == "LoadImageMask" or re.search("遮罩|mask", title, re.I) else "image"
    elif kind == "CLIPTextEncode" and field == "text" and not prompt_seen:
        inferred = "prompt"
    elif field in {"seed", "noise_seed"}:
        inferred = "seed"
    identifier = re.sub(r"[^\w-]", "-", label).strip("-")[:55] or "input"
    identifier += "-" + hashlib.sha256(f"{node_id}:{field}".encode()).hexdigest()[:8]
    return WorkflowInput(id=identifier, label=label, type=inferred, node_id=node_id,
                         class_type=kind, field=field,
                         default=None if inferred in {"image", "mask", "seed"} else value)


def inspect_workflow(alias: str, workflow: dict, previous_id: str | None = None) -> dict:
    validate_api(workflow)
    key = provider(alias)
    candidates, suggested, warnings = [], [], []
    prompt_seen = False
    tagged = any(str(node.get("_meta", {}).get("title", "")).startswith("in:")
                 for node in workflow.values())
    defaults = {"CLIPTextEncode": "text", "LoadImage": "image", "LoadImageMask": "image",
                "KSampler": "seed", "KSamplerAdvanced": "noise_seed",
                "LoraLoader": "strength_model"}
    info = {}
    with ComfyUIClient(key.base_url) as client:
        try:
            for kind in dict.fromkeys(node["class_type"] for node in workflow.values()):
                info.update(client.get("/object_info/" + quote(kind, safe="")))
        except (ComfyUIUnavailableError, ValueError, OSError, requests.RequestException):
            warnings.append("ComfyUI 未连接，未检查主机节点和模型文件")
    for node_id, node in workflow.items():
        title = str(node.get("_meta", {}).get("title", ""))
        available = [(field, value) for field, value in node["inputs"].items()
                     if isinstance(value, (str, int, float, bool))]
        numeric = [field for field, value in available if type(value) in {int, float}]
        preferred = defaults.get(node["class_type"], numeric[0] if numeric else
                                 available[0][0] if available else "")
        node_info = info.get(node["class_type"], {})
        if info and not node_info:
            warnings.append(f"主机上缺少节点：{node['class_type']}")
        fields = {**node_info.get("input", {}).get("required", {}),
                  **node_info.get("input", {}).get("optional", {})}
        for field, value in available:
            item = _candidate(node_id, node, field, value, prompt_seen)
            if item.type == "prompt" and (not tagged or title.startswith("in:")):
                prompt_seen = True
            spec = fields.get(field, [])
            if spec and isinstance(spec[0], list) and item.type not in {"image", "mask"}:
                options = [{"value": v, "label": str(v)} for v in spec[0]
                           if type(v) in {str, int, float, bool}]
                if options:
                    item = WorkflowInput(**{**item.model_dump(), "type": "select", "options": options})
                if value not in spec[0]:
                    warnings.append(f"主机上缺少：{value}")
            elif len(spec) > 1 and isinstance(spec[1], dict) and item.type in {"int", "float", "seed"}:
                item = WorkflowInput(**{**item.model_dump(), **{
                    name: spec[1][name] for name in ("min", "max", "step") if name in spec[1]
                }})
            candidates.append(item)
            if ((field == preferred and title.startswith("in:")) if tagged else (
                field == preferred or field in numeric
            )):
                suggested.append(item)
    lost = []
    if previous_id:
        old = read_workflow(alias, previous_id)
        migrated = []
        for item in old.inputs:
            matches = [candidate for candidate in candidates if
                       (candidate.label, candidate.class_type, candidate.field)
                       == (item.label, item.class_type, item.field)]
            if len(matches) == 1:
                migrated.append(item.model_copy(update={"node_id": matches[0].node_id}))
            else:
                lost.append(item.label)
        suggested = migrated
    return {"inputs": [item.model_dump() for item in suggested],
            "candidates": [item.model_dump() for item in candidates],
            "tagged": tagged, "warnings": list(dict.fromkeys(warnings)), "unmapped": lost}


def save_workflow(alias: str, *, name: str, api_workflow: dict, inputs: list[WorkflowInput],
                  source_filename: str = "", identifier: str | None = None,
                  timeout_seconds: int = 1800) -> Workflow:
    validate_mappings(api_workflow, inputs)
    with keys.keys_lock():
        db = keys.read_keys_db()
        key = next((key for key in db.keys if key.alias == alias and key.provider == "comfyui"), None)
        if key is None:
            raise ValueError("找不到 ComfyUI 供应商")
        if identifier:
            _read(alias, identifier)
        elif any(model.name == name.strip() for model in key.models):
            raise ValueError("同名工作流已存在，请选择重新导入")
        identifier = identifier or "comfyui-" + uuid4().hex
        saved = Workflow(id=identifier, alias=alias, name=name.strip(),
                         source_filename=source_filename,
                         imported_at=datetime.now(timezone.utc).isoformat(),
                         api_workflow=api_workflow, inputs=inputs, timeout_seconds=timeout_seconds)
        path = _path(identifier)
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        model = keys.ModelSpec(id=identifier, name=saved.name, modality="image",
                               protocol="comfyui", workflow_inputs=inputs,
                               input_modalities=["text", "image"])
        key.models = [model if item.id == identifier else item for item in key.models]
        if not any(item.id == identifier for item in key.models):
            key.models.append(model)
        atomic_write_json(path, saved.model_dump())
        try:
            keys.write_keys_db(db)
        except BaseException:
            if old is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write_json(path, old)
            raise
        return saved


def delete_workflow(alias: str, identifier: str) -> None:
    with keys.keys_lock():
        _read(alias, identifier)
        db = keys.read_keys_db()
        for key in db.keys:
            if key.alias == alias:
                key.models = [model for model in key.models if model.id != identifier]
        keys.write_keys_db(db)
        _path(identifier).unlink(missing_ok=True)
