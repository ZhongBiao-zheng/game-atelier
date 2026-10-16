"""Resolve image editing from the exact Canvas content version, never from a title."""
from __future__ import annotations

from .schemas import CanvasMediaVersion


def fixed_edit_source(document, node_id):
    """Resolve a configuration's frozen version, or an image's current version."""
    from .schemas import CanvasImageEditNode, CanvasImageNode

    node = next((item for item in document.nodes if item.id == node_id), None)
    if isinstance(node, CanvasImageEditNode):
        version_id = node.data.source_version_id
    elif isinstance(node, CanvasImageNode):
        version_id = node.data.current_version_id
    else:
        raise ValueError("请选择图片或图片编辑节点")
    version = document.content_versions.get(version_id)
    if not isinstance(version, CanvasMediaVersion) or version.kind != "image":
        raise ValueError("请选择已有图片")
    return node, version


def save_image_edit(project_id, payload, mask_body=None):
    """Save a local configuration and immutable mask; never resolve a provider or create a Job."""
    import hashlib
    import io
    import secrets
    from .atomic_io import atomic_write_json
    from .file_lock import file_lock
    from .canvas_masks import _decode_mask, _source_display_size, CanvasMaskError, _MAX_MASK_BYTES
    from .canvas_media_operations import _placement_shift
    from .canvas_projects import (
        canvas_project_lock_path, canvas_project_dir, read_canvas_project,
        _recover_canvas_transactions_unlocked, _read_canvas_document_unlocked,
        _commit_canvas_upload, _document_path, _project_path, _now, _draft_sanitized_nodes,
    )
    from .schemas import (
        CanvasDocument, CanvasImageNode, CanvasImageEditNode, CanvasImageEditNodeData,
        CanvasImageEditEditorState, CanvasImageEditFrame, CanvasMaterialConnection,
        CanvasUserMaskOrigin, CanvasSize,
    )

    with file_lock(canvas_project_lock_path(project_id)):
        _recover_canvas_transactions_unlocked(project_id)
        current = _read_canvas_document_unlocked(project_id)
        if current.revision != payload.expected_revision:
            raise RuntimeError(f"revision_conflict:{current.revision}")
        existing = next((n for n in current.nodes if n.id == payload.node_id), None)
        if payload.node_id and not isinstance(existing, CanvasImageEditNode):
            raise ValueError("找不到这个图片编辑节点")
        if existing:
            source_id = existing.data.source_node_id
            source_version_id = existing.data.source_version_id
            if ((payload.source_version_id and payload.source_version_id != source_version_id)
                    or (payload.source_node_id and payload.source_node_id != source_id)):
                raise ValueError("编辑节点的源图版本不可更换，请新建编辑节点")
            source = current.content_versions[source_version_id]
            source_node = next((n for n in current.nodes if n.id == source_id), None)
        else:
            source_node, source = fixed_edit_source(current, payload.source_node_id)
            if (not isinstance(source_node, CanvasImageNode)
                    or source.version_id != payload.source_version_id):
                raise ValueError("源图版本已经变化，请重新打开编辑器")
            source_id, source_version_id = source_node.id, source.version_id
        width, height = _source_display_size(canvas_project_dir(project_id) / source.path, source)
        reference_id, reference_version_id = payload.reference_node_id, payload.reference_version_id
        if bool(reference_id) != bool(reference_version_id) and reference_id:
            raise ValueError("参考素材需要固定版本")
        if reference_version_id:
            reference = current.content_versions.get(reference_version_id)
            if not isinstance(reference, CanvasMediaVersion) or reference.kind != "image":
                raise ValueError("参考素材版本不可用")
            unchanged = (existing and reference_id == existing.data.reference_node_id
                         and reference_version_id == existing.data.reference_version_id)
            if reference_id and not unchanged:
                reference_node = next((n for n in current.nodes if n.id == reference_id), None)
                if (not isinstance(reference_node, CanvasImageNode)
                        or reference_node.data.current_version_id != reference_version_id):
                    raise ValueError("参考素材版本已经变化，请重新选择")
        versions = dict(current.content_versions)
        mask_version_id = None
        target = None
        normalized_body = None
        timestamp = _now()
        if mask_body is not None:
            if not mask_body or len(mask_body) > _MAX_MASK_BYTES:
                raise CanvasMaskError("canvas_mask_invalid", "蒙版文件为空或超过 25 MiB")
            mask = _decode_mask(mask_body)
            try:
                if mask.size != (width, height):
                    raise CanvasMaskError("canvas_mask_size_mismatch", "蒙版必须与源图保持同尺寸")
                output = io.BytesIO()
                mask.save(output, format="PNG", optimize=True)
                normalized_body = output.getvalue()
            finally:
                mask.close()
            sha = hashlib.sha256(normalized_body).hexdigest()
            previous = versions.get(existing.data.mask_version_id) if existing else None
            if previous and previous.sha256 == sha:
                mask_version_id = previous.version_id
            else:
                mask_version_id = f"version-{secrets.token_hex(12)}"
                target = canvas_project_dir(project_id) / "uploads" / f"mask-{secrets.token_hex(12)}.png"
                versions[mask_version_id] = CanvasMediaVersion(
                    version_id=mask_version_id, created_at=timestamp, sha256=sha,
                    origin=CanvasUserMaskOrigin(kind="user_mask", source_version_id=source_version_id),
                    kind="image", path=target.relative_to(canvas_project_dir(project_id)).as_posix(),
                    mime_type="image/png", bytes=len(normalized_body), width=width, height=height,
                )
        editor = payload.editor_state
        if "editor_state" not in payload.model_fields_set:
            editor = CanvasImageEditEditorState(frame=CanvasImageEditFrame(width=width, height=height))
        node_id = existing.id if existing else f"image-edit-{secrets.token_hex(12)}"
        data = CanvasImageEditNodeData(
            source_node_id=source_id if source_node else None, source_version_id=source_version_id,
            reference_node_id=reference_id, reference_version_id=reference_version_id,
            mask_version_id=mask_version_id, generation_draft=payload.generation_draft,
            options=payload.options, editor_state=editor,
            active_run_id=existing.data.active_run_id if existing else None,
        )
        if existing:
            node = existing.model_copy(update={"data": data})
        else:
            size = CanvasSize(width=320, height=240)
            position = source_node.position.model_copy(update={
                "x": source_node.position.x + (source_node.size.width if source_node.size else 320) + 120,
            })
            shift = _placement_shift([position], [size], current.nodes)
            node = CanvasImageEditNode(
                id=node_id, type="image_edit",
                title="扩图" if data.options.mode == "outpaint" else "局部修改",
                position=position.model_copy(update={"y": position.y + shift}), size=size, data=data,
            )
        nodes = [node if n.id == node_id else n for n in current.nodes]
        if not existing:
            nodes.append(node)
        connections = [edge for edge in current.connections
                       if not (edge.role == "material" and edge.target_node_id == node_id)]
        node_ids = {n.id for n in nodes}
        if data.source_node_id and data.source_node_id in node_ids:
            connections.append(CanvasMaterialConnection(
                id=f"connection-{secrets.token_hex(12)}", role="material",
                source_node_id=data.source_node_id, target_node_id=node_id,
            ))
        updated = CanvasDocument.model_validate(current.model_copy(update={
            "revision": current.revision + 1, "updated_at": timestamp,
            "nodes": _draft_sanitized_nodes(nodes), "connections": connections,
            "content_versions": versions,
        }).model_dump(mode="json"))
        project = read_canvas_project(project_id)
        if target:
            _commit_canvas_upload(project_id, project, updated, target, normalized_body, timestamp)
        else:
            atomic_write_json(_project_path(project_id), project.model_copy(update={
                "updated_at": timestamp,
            }).model_dump(mode="json"))
            atomic_write_json(_document_path(project_id), updated.model_dump(mode="json"))
        return updated, node_id


def has_resumable_mj_task(job) -> bool:
    if job.provider == "evolink":
        state = job.params.evolink_state or {}
        return bool(state.get("task_id") and not state.get("uncertain")
                    and state.get("terminal") not in {"failed", "rejected"})
    from .callers.openai_image import image_family
    if image_family(job.model) != "midjourney":
        return False
    return bool(job.params.mj_submission_ids and not job.params.mj_submit_uncertain)


def edit_size_params(key, model: str, width: int, height: int) -> dict:
    from .image_size import normalize_image_size_params
    from .image_size_catalog import image_size_options, is_nano_image_size_model

    if key.provider == "openrouter" or is_nano_image_size_model(model):
        ratios = [r for r in image_size_options(key.provider, key.base_url, model)["ratios"]
                  if r != "auto" and ":" in r]
        def value(r):
            a, b = r.split(":")
            return float(a) / float(b)
        if not ratios:
            raise ValueError("当前渠道未声明可用的编辑比例")
        ratio = min(ratios, key=lambda r: abs(value(r) / (width / height) - 1))
        if abs(value(ratio) / (width / height) - 1) > .02:
            raise ValueError("当前模型不支持这个画框比例，请调整画框或切换模型")
        params = {"size_mode": "ratio", "ratio": ratio, "size": ratio}
    else:
        params = {"size_mode": "custom", "size": f"{width}x{height}"}
    normalized = normalize_image_size_params(key, model, params)
    size = normalized.get("size", "")
    if "x" in size:
        a, b = map(int, size.split("x"))
        if abs((a / b) / (width / height) - 1) > .02:
            raise ValueError("当前模型无法匹配编辑画框比例，请调整画框或切换模型")
    return normalized
