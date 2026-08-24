"""Project-local Canvas asset and prompt libraries."""
from __future__ import annotations

import hashlib
import secrets
from pathlib import Path
from typing import Literal, TypeVar

from pydantic import ValidationError

from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.canvas_projects import (
    _canvas_lock_path,
    _document_path,
    _project_path,
    _read_canvas_document_unlocked,
    _recover_canvas_transactions_unlocked,
    _now,
    canvas_project_dir,
    read_canvas_project,
)
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import (
    CanvasAudioNode,
    CanvasContentNodeData,
    CanvasDocument,
    CanvasImageNode,
    CanvasLibraryAsset,
    CanvasLibraryAssetPatch,
    CanvasMediaDisplay,
    CanvasPoint,
    CanvasPrompt,
    CanvasPromptPatch,
    CanvasTextNode,
    CanvasTextVersion,
    CanvasUserEditOrigin,
    CanvasVideoNode,
    RevisionedSidecar,
)


SidecarItem = TypeVar("SidecarItem", CanvasLibraryAsset, CanvasPrompt)


class CanvasLibraryStateError(ValueError):
    """The project library sidecar is missing or invalid on disk."""


def _sidecar_path(project_id: str, kind: Literal["assets", "prompts"]) -> Path:
    return canvas_project_dir(project_id) / "library" / f"{kind}.json"


def _read_sidecar(
    project_id: str,
    kind: Literal["assets", "prompts"],
    item_type: type[SidecarItem],
) -> RevisionedSidecar[SidecarItem]:
    path = _sidecar_path(project_id, kind)
    if not path.is_file():
        raise CanvasLibraryStateError(f"canvas {kind} library is missing")
    try:
        return RevisionedSidecar[item_type].model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError) as error:
        raise CanvasLibraryStateError(f"canvas {kind} library is invalid") from error


def read_canvas_assets(project_id: str) -> RevisionedSidecar[CanvasLibraryAsset]:
    with file_lock(_canvas_lock_path(project_id)):
        return _read_sidecar(project_id, "assets", CanvasLibraryAsset)


def read_canvas_prompts(project_id: str) -> RevisionedSidecar[CanvasPrompt]:
    with file_lock(_canvas_lock_path(project_id)):
        return _read_sidecar(project_id, "prompts", CanvasPrompt)


def _check_revision(current: RevisionedSidecar[SidecarItem], expected_revision: int) -> None:
    if current.revision != expected_revision:
        raise RuntimeError(f"revision_conflict:{current.revision}")


def _normalize_tags(tags: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw_tag in tags:
        tag = raw_tag.strip()
        key = tag.casefold()
        if not tag or key in seen:
            continue
        if len(tag) > 40:
            raise ValueError("标签不能超过 40 个字符")
        seen.add(key)
        normalized.append(tag)
    return normalized


def _required_text(value: str, label: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{label}不能为空")
    return normalized


def _write_sidecar(
    project_id: str,
    kind: Literal["assets", "prompts"],
    current: RevisionedSidecar[SidecarItem],
    items: list[SidecarItem],
) -> RevisionedSidecar[SidecarItem]:
    timestamp = _now()
    updated = current.model_copy(update={
        "revision": current.revision + 1,
        "updated_at": timestamp,
        "items": items,
    })
    project = read_canvas_project(project_id).model_copy(update={"updated_at": timestamp})
    atomic_write_json(_project_path(project_id), project.model_dump(mode="json"))
    atomic_write_json(_sidecar_path(project_id, kind), updated.model_dump(mode="json"))
    return updated


def save_canvas_asset(
    project_id: str,
    version_id: str,
    title: str,
    tags: list[str],
    expected_revision: int,
) -> RevisionedSidecar[CanvasLibraryAsset]:
    with file_lock(_canvas_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_sidecar(project_id, "assets", CanvasLibraryAsset)
        _check_revision(current, expected_revision)
        document = _read_canvas_document_unlocked(project_id)
        if version_id not in document.content_versions:
            raise KeyError(version_id)
        if any(item.version_id == version_id for item in current.items):
            return current
        asset = CanvasLibraryAsset(
            asset_id=f"asset-{secrets.token_hex(8)}",
            version_id=version_id,
            title=_required_text(title, "资产标题"),
            tags=_normalize_tags(tags),
        )
        return _write_sidecar(project_id, "assets", current, [asset, *current.items])


def patch_canvas_asset(
    project_id: str,
    asset_id: str,
    patch: CanvasLibraryAssetPatch,
    expected_revision: int,
) -> RevisionedSidecar[CanvasLibraryAsset]:
    with file_lock(_canvas_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_sidecar(project_id, "assets", CanvasLibraryAsset)
        _check_revision(current, expected_revision)
        item = next((candidate for candidate in current.items if candidate.asset_id == asset_id), None)
        if item is None:
            raise KeyError(asset_id)
        changes: dict[str, object] = {}
        if patch.title is not None:
            changes["title"] = _required_text(patch.title, "资产标题")
        if patch.tags is not None:
            changes["tags"] = _normalize_tags(patch.tags)
        if not changes:
            return current
        updated_item = CanvasLibraryAsset.model_validate({**item.model_dump(), **changes})
        items = [updated_item if candidate.asset_id == asset_id else candidate for candidate in current.items]
        return _write_sidecar(project_id, "assets", current, items)


def delete_canvas_asset(
    project_id: str,
    asset_id: str,
    expected_revision: int,
) -> RevisionedSidecar[CanvasLibraryAsset]:
    with file_lock(_canvas_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_sidecar(project_id, "assets", CanvasLibraryAsset)
        _check_revision(current, expected_revision)
        items = [item for item in current.items if item.asset_id != asset_id]
        if len(items) == len(current.items):
            raise KeyError(asset_id)
        return _write_sidecar(project_id, "assets", current, items)


def create_canvas_prompt(
    project_id: str,
    title: str,
    content: str,
    tags: list[str],
    expected_revision: int,
) -> RevisionedSidecar[CanvasPrompt]:
    with file_lock(_canvas_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_sidecar(project_id, "prompts", CanvasPrompt)
        _check_revision(current, expected_revision)
        prompt = CanvasPrompt(
            prompt_id=f"prompt-{secrets.token_hex(8)}",
            title=_required_text(title, "提示词标题"),
            content=_required_text(content, "提示词内容"),
            tags=_normalize_tags(tags),
            source="local",
        )
        return _write_sidecar(project_id, "prompts", current, [prompt, *current.items])


def patch_canvas_prompt(
    project_id: str,
    prompt_id: str,
    patch: CanvasPromptPatch,
    expected_revision: int,
) -> RevisionedSidecar[CanvasPrompt]:
    with file_lock(_canvas_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_sidecar(project_id, "prompts", CanvasPrompt)
        _check_revision(current, expected_revision)
        item = next((candidate for candidate in current.items if candidate.prompt_id == prompt_id), None)
        if item is None:
            raise KeyError(prompt_id)
        if item.source != "local":
            raise PermissionError("公开提示词不能在项目内修改")
        changes: dict[str, object] = {}
        if patch.title is not None:
            changes["title"] = _required_text(patch.title, "提示词标题")
        if patch.content is not None:
            changes["content"] = _required_text(patch.content, "提示词内容")
        if patch.tags is not None:
            changes["tags"] = _normalize_tags(patch.tags)
        if not changes:
            return current
        updated_item = CanvasPrompt.model_validate({**item.model_dump(), **changes})
        items = [updated_item if candidate.prompt_id == prompt_id else candidate for candidate in current.items]
        return _write_sidecar(project_id, "prompts", current, items)


def delete_canvas_prompt(
    project_id: str,
    prompt_id: str,
    expected_revision: int,
) -> RevisionedSidecar[CanvasPrompt]:
    with file_lock(_canvas_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_sidecar(project_id, "prompts", CanvasPrompt)
        _check_revision(current, expected_revision)
        prompt = next((item for item in current.items if item.prompt_id == prompt_id), None)
        if prompt is None:
            raise KeyError(prompt_id)
        if prompt.source != "local":
            raise PermissionError("公开提示词不能从项目内删除")
        return _write_sidecar(
            project_id,
            "prompts",
            current,
            [item for item in current.items if item.prompt_id != prompt_id],
        )


def _content_node(version_id: str, title: str, position: CanvasPoint, kind: str):
    base = {
        "id": f"{kind}-{secrets.token_hex(8)}",
        "title": title,
        "position": position,
        "z_index": 0,
    }
    data = CanvasContentNodeData(current_version_id=version_id)
    if kind == "text":
        return CanvasTextNode(**base, type="text", data=data)
    if kind == "audio":
        return CanvasAudioNode(**base, type="audio", data=data)
    media_data = data.model_dump()
    media_data["display"] = CanvasMediaDisplay().model_dump()
    if kind == "image":
        return CanvasImageNode(**base, type="image", data=media_data)
    return CanvasVideoNode(**base, type="video", data=media_data)


def insert_canvas_asset(
    project_id: str,
    asset_id: str,
    position: CanvasPoint,
    expected_revision: int,
) -> CanvasDocument:
    with file_lock(_canvas_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        assets = _read_sidecar(project_id, "assets", CanvasLibraryAsset)
        asset = next((item for item in assets.items if item.asset_id == asset_id), None)
        if asset is None:
            raise KeyError(asset_id)
        current = _read_canvas_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        version = current.content_versions.get(asset.version_id)
        if version is None:
            raise ValueError("资产引用的内容版本不存在")
        timestamp = _now()
        node = _content_node(version.version_id, asset.title, position, version.kind)
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "nodes": [*current.nodes, node],
        })
        project = read_canvas_project(project_id).model_copy(update={"updated_at": timestamp})
        atomic_write_json(_project_path(project_id), project.model_dump(mode="json"))
        atomic_write_json(_document_path(project_id), updated.model_dump(mode="json"))
        return updated


def insert_canvas_prompt(
    project_id: str,
    prompt_id: str,
    position: CanvasPoint,
    expected_revision: int,
) -> CanvasDocument:
    with file_lock(_canvas_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        prompts = _read_sidecar(project_id, "prompts", CanvasPrompt)
        prompt = next((item for item in prompts.items if item.prompt_id == prompt_id), None)
        if prompt is None:
            raise KeyError(prompt_id)
        current = _read_canvas_document_unlocked(project_id)
        if current.revision != expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        timestamp = _now()
        version_id = f"version-{secrets.token_hex(12)}"
        version = CanvasTextVersion(
            version_id=version_id,
            created_at=timestamp,
            sha256=hashlib.sha256(prompt.content.encode("utf-8")).hexdigest(),
            origin=CanvasUserEditOrigin(kind="user_edit"),
            kind="text",
            text=prompt.content,
        )
        node = _content_node(version_id, prompt.title, position, "text")
        updated = current.model_copy(update={
            "revision": current.revision + 1,
            "updated_at": timestamp,
            "nodes": [*current.nodes, node],
            "content_versions": {**current.content_versions, version_id: version},
        })
        project = read_canvas_project(project_id).model_copy(update={"updated_at": timestamp})
        atomic_write_json(_project_path(project_id), project.model_dump(mode="json"))
        atomic_write_json(_document_path(project_id), updated.model_dump(mode="json"))
        return updated
