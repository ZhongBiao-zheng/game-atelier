"""Deterministic Canvas image operations with recoverable document/file commits."""
from __future__ import annotations

import hashlib
import json
import math
import secrets
import shutil
import time
import warnings
from dataclasses import dataclass
from pathlib import Path
from threading import BoundedSemaphore
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.canvas_projects import (
    canvas_project_dir,
    read_canvas_project,
    resolve_canvas_media,
)
from character_workflow.lib.file_lock import file_lock, try_file_lock
from character_workflow.lib.schemas import (
    CanvasCropMediaOperation,
    CanvasCropOperation,
    CanvasDerivationConnection,
    CanvasDocument,
    CanvasImageNode,
    CanvasLocalToolConnectionOrigin,
    CanvasLocalToolOrigin,
    CanvasMediaDisplay,
    CanvasMediaNodeData,
    CanvasMediaOperationRequest,
    CanvasMediaOperationResponse,
    CanvasMediaVersion,
    CanvasPoint,
    CanvasSize,
    CanvasSplitMediaOperation,
    CanvasSplitOperation,
    CanvasUpscaleMediaOperation,
    CanvasUpscaleOperation,
)


_GLOBAL_OPERATION_GATE = BoundedSemaphore(2)
_MAX_PIXELS = 64_000_000
_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
_MAX_OUTPUT_BYTES = 256 * 1024 * 1024
_OPERATION_TIMEOUT_SECONDS = 60.0
_PNG_MIME = "image/png"
_PIL_FORMAT_MIME = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
    "WEBP": "image/webp",
    "GIF": "image/gif",
}


class CanvasMediaOperationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class _RenderedOutput:
    filename: str
    width: int
    height: int
    byte_count: int
    sha256: str
    row: int = 0
    column: int = 0


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _canvas_lock_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / ".canvas.lock"


def _operation_lock_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / ".media-operation.lock"


def _transactions_root(project_id: str) -> Path:
    root = canvas_project_dir(project_id) / ".runtime" / "media-operations"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _document_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / "canvas.json"


def _project_path(project_id: str) -> Path:
    return canvas_project_dir(project_id) / "project.json"


def _read_document_unlocked(project_id: str) -> CanvasDocument:
    document = CanvasDocument.model_validate_json(
        _document_path(project_id).read_text(encoding="utf-8")
    )
    if document.project_id != project_id:
        raise ValueError("canvas document project_id does not match its directory")
    return document


def _write_project_state_unlocked(project_id: str, document: CanvasDocument) -> None:
    project = read_canvas_project(project_id)
    touched = project.model_copy(update={"updated_at": document.updated_at})
    atomic_write_json(_project_path(project_id), touched.model_dump(mode="json"))
    atomic_write_json(_document_path(project_id), document.model_dump(mode="json"))


def _canonical_sha(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _document_has_operation(document: CanvasDocument, operation_id: str) -> bool:
    if any(
        version.origin.kind == "local_tool"
        and version.origin.operation_id == operation_id
        for version in document.content_versions.values()
    ):
        return True
    return any(
        edge.role == "derivation"
        and edge.origin.kind == "local_tool"
        and edge.origin.operation_id == operation_id
        for edge in document.connections
    )


def _validate_manifest(derived: Path, manifest: list[dict[str, Any]]) -> None:
    for entry in manifest:
        target = derived / str(entry["filename"])
        if (
            not target.is_file()
            or target.stat().st_size != int(entry["bytes"])
            or _file_sha256(target) != entry["sha256"]
        ):
            raise RuntimeError("canvas media operation output fingerprint mismatch")


def _recover_transactions_owned(project_id: str) -> None:
    root = _transactions_root(project_id)
    for transaction in sorted(root.iterdir()):
        if not transaction.is_dir():
            continue
        journal_path = transaction / "transaction.json"
        if not journal_path.is_file():
            shutil.rmtree(transaction, ignore_errors=True)
            continue
        try:
            raw = json.loads(journal_path.read_text(encoding="utf-8"))
            if raw.get("project_id") != project_id:
                raise ValueError("canvas media transaction project mismatch")
            state = raw.get("state")
            if state == "staging":
                shutil.rmtree(transaction, ignore_errors=True)
                continue
            if state != "prepared":
                raise ValueError("canvas media transaction state is invalid")
            document_payload = raw["document"]
            if _canonical_sha(document_payload) != raw["document_sha256"]:
                raise ValueError("canvas media transaction document fingerprint mismatch")
            target = CanvasDocument.model_validate(document_payload)
            operation_id = str(raw["operation_id"])
            derived = canvas_project_dir(project_id) / "derived" / operation_id
            current = _read_document_unlocked(project_id)
            if not derived.is_dir():
                if _document_has_operation(current, operation_id):
                    raise RuntimeError("canvas media transaction committed without its outputs")
                shutil.rmtree(transaction, ignore_errors=True)
                continue
            _validate_manifest(derived, list(raw["outputs"]))
            if current.revision == int(raw["before_revision"]):
                _write_project_state_unlocked(project_id, target)
            elif not _document_has_operation(current, operation_id):
                raise RuntimeError("canvas media transaction cannot be recovered safely")
            shutil.rmtree(transaction, ignore_errors=True)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeError(f"invalid canvas media transaction {transaction.name}") from error


def recover_canvas_media_operations_unlocked(project_id: str) -> None:
    """Recover only when no active media operation owns the project operation lock."""
    with try_file_lock(_operation_lock_path(project_id)) as acquired:
        if acquired:
            _recover_transactions_owned(project_id)


def _validate_source(
    document: CanvasDocument,
    request: CanvasMediaOperationRequest,
) -> CanvasImageNode:
    source = next((node for node in document.nodes if node.id == request.source_node_id), None)
    version = document.content_versions.get(request.source_version_id)
    if source is None or source.type != "image" or version is None or version.kind != "image":
        raise CanvasMediaOperationError(
            "canvas_media_source_missing",
            "源图片节点或版本不存在，不会创建空结果。",
        )
    if source.data.current_version_id != request.source_version_id:
        raise CanvasMediaOperationError(
            "canvas_media_source_missing",
            "当前节点已经切换到其他图片，请重新选择后再试。",
        )
    return source


def _decode_source(path: Path, version: CanvasMediaVersion) -> Image.Image:
    if _file_sha256(path) != version.sha256:
        raise CanvasMediaOperationError(
            "canvas_media_source_missing",
            "源图片文件已经变化，不会处理这份不一致的内容。",
        )
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as opened:
                actual_mime = _PIL_FORMAT_MIME.get(opened.format or "")
                if actual_mime is None or actual_mime != version.mime_type:
                    raise CanvasMediaOperationError(
                        "canvas_media_decode_failed",
                        "文件内容与登记格式不一致，不能作为静态图片处理。",
                    )
                if getattr(opened, "is_animated", False) or getattr(opened, "n_frames", 1) != 1:
                    raise CanvasMediaOperationError(
                        "canvas_media_decode_failed",
                        "动图或多帧图片不能使用静态图片工具。",
                    )
                width, height = opened.size
                if width * height > _MAX_PIXELS:
                    raise CanvasMediaOperationError(
                        "canvas_media_too_large",
                        f"图片为 {width} × {height}，超过 6400 万像素上限。",
                    )
                opened.load()
                oriented = ImageOps.exif_transpose(opened)
                width, height = oriented.size
                if width * height > _MAX_PIXELS:
                    raise CanvasMediaOperationError(
                        "canvas_media_too_large",
                        f"图片为 {width} × {height}，超过 6400 万像素上限。",
                    )
                has_alpha = "A" in oriented.getbands() or "transparency" in opened.info
                return oriented.convert("RGBA" if has_alpha else "RGB")
    except CanvasMediaOperationError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise CanvasMediaOperationError(
            "canvas_media_too_large",
            "图片解码规模超过本地工具上限。",
        ) from error
    except (OSError, UnidentifiedImageError, ValueError) as error:
        raise CanvasMediaOperationError(
            "canvas_media_decode_failed",
            "文件不是受支持的静态图片，或图片已经损坏。",
        ) from error


def _validate_output_size(width: int, height: int) -> None:
    if width <= 0 or height <= 0 or width * height > _MAX_PIXELS:
        raise CanvasMediaOperationError(
            "canvas_media_output_too_large",
            "处理结果超过 6400 万像素上限。",
        )


def _save_png(image: Image.Image, stage: Path, filename: str, row: int, column: int) -> _RenderedOutput:
    width, height = image.size
    _validate_output_size(width, height)
    target = stage / filename
    image.save(target, format="PNG")
    byte_count = target.stat().st_size
    return _RenderedOutput(
        filename=filename,
        width=width,
        height=height,
        byte_count=byte_count,
        sha256=_file_sha256(target),
        row=row,
        column=column,
    )


def _crop_box(operation: CanvasCropMediaOperation, width: int, height: int) -> tuple[int, int, int, int]:
    rect = operation.rect
    if rect.x + rect.width > 1 or rect.y + rect.height > 1:
        raise CanvasMediaOperationError(
            "canvas_media_invalid_crop",
            "裁剪选区超出图片边界，请重新选择。",
        )
    left = max(0, math.floor(rect.x * width))
    top = max(0, math.floor(rect.y * height))
    right = min(width, math.ceil((rect.x + rect.width) * width))
    bottom = min(height, math.ceil((rect.y + rect.height) * height))
    if right - left < 2 or bottom - top < 2:
        raise CanvasMediaOperationError(
            "canvas_media_invalid_crop",
            "裁剪结果至少需要 2 × 2 像素。",
        )
    return left, top, right, bottom


def _split_axis(lines: list[float], length: int) -> tuple[list[float], list[int]]:
    normalized = sorted(lines)
    cuts = [0, *(round(line * length) for line in normalized), length]
    if any(right - left < 16 for left, right in zip(cuts, cuts[1:])):
        raise CanvasMediaOperationError(
            "canvas_media_invalid_split",
            "切线重复或相邻区域小于 16 像素，请调整切线。",
        )
    return normalized, cuts


def _render_outputs(
    source: Image.Image,
    operation: CanvasCropMediaOperation | CanvasSplitMediaOperation | CanvasUpscaleMediaOperation,
    stage: Path,
) -> tuple[list[_RenderedOutput], tuple[list[float], list[float]] | None]:
    outputs: list[_RenderedOutput] = []
    split_lines: tuple[list[float], list[float]] | None = None
    if isinstance(operation, CanvasCropMediaOperation):
        with source.crop(_crop_box(operation, *source.size)) as result:
            outputs.append(_save_png(result, stage, "result.png", 0, 0))
    elif isinstance(operation, CanvasSplitMediaOperation):
        horizontal, y_cuts = _split_axis(operation.horizontal_lines, source.height)
        vertical, x_cuts = _split_axis(operation.vertical_lines, source.width)
        if len(y_cuts) - 1 > 12 or len(x_cuts) - 1 > 12:
            raise CanvasMediaOperationError(
                "canvas_media_invalid_split",
                "切图最多支持 12 × 12 块。",
            )
        split_lines = horizontal, vertical
        for row, (top, bottom) in enumerate(zip(y_cuts, y_cuts[1:])):
            for column, (left, right) in enumerate(zip(x_cuts, x_cuts[1:])):
                with source.crop((left, top, right, bottom)) as result:
                    filename = f"piece-r{row + 1:02d}-c{column + 1:02d}.png"
                    outputs.append(_save_png(result, stage, filename, row, column))
    else:
        long_edge = max(source.size)
        if operation.target_long_edge <= long_edge:
            raise CanvasMediaOperationError(
                "canvas_media_upscale_not_needed",
                "目标长边必须大于原图；本地放大不会恢复新的图像细节。",
            )
        scale = operation.target_long_edge / long_edge
        target_size = (
            max(1, round(source.width * scale)),
            max(1, round(source.height * scale)),
        )
        _validate_output_size(*target_size)
        resampling = {
            "nearest": Image.Resampling.NEAREST,
            "bilinear": Image.Resampling.BILINEAR,
            "lanczos": Image.Resampling.LANCZOS,
        }[operation.algorithm]
        with source.resize(target_size, resample=resampling) as result:
            outputs.append(_save_png(result, stage, "result.png", 0, 0))

    uncompressed = sum(item.width * item.height * 4 for item in outputs)
    stored = sum(item.byte_count for item in outputs)
    if uncompressed > _MAX_UNCOMPRESSED_BYTES or stored > _MAX_OUTPUT_BYTES:
        raise CanvasMediaOperationError(
            "canvas_media_output_too_large",
            "本次处理的预计内存或落盘体积超过安全上限。",
        )
    return outputs, split_lines


def _display_size(width: int, height: int, preferred_long_edge: float) -> CanvasSize:
    long_edge = max(width, height)
    short_edge = min(width, height)
    scale = max(preferred_long_edge / long_edge, 80 / short_edge)
    if long_edge * scale > 1600:
        scale = 1600 / long_edge
    return CanvasSize(width=width * scale, height=height * scale)


def _node_display_size(node: Any) -> CanvasSize:
    if node.size is not None:
        return node.size
    if node.type == "text":
        return CanvasSize(width=256, height=144)
    return CanvasSize(width=320, height=176)


def _placement_shift(
    positions: list[CanvasPoint],
    sizes: list[CanvasSize],
    existing_nodes: list[Any],
) -> float:
    """Move a result batch down as one unit until it no longer covers existing nodes."""
    gap = 32.0
    left = min(position.x for position in positions)
    right = max(position.x + size.width for position, size in zip(positions, sizes))
    top = min(position.y for position in positions)
    bottom = max(position.y + size.height for position, size in zip(positions, sizes))
    shift = 0.0
    for _attempt in range(len(existing_nodes) + 1):
        blockers: list[float] = []
        for node in existing_nodes:
            size = _node_display_size(node)
            node_left = node.position.x
            node_right = node_left + size.width
            node_top = node.position.y
            node_bottom = node_top + size.height
            horizontal = left < node_right + gap and right > node_left - gap
            vertical = top + shift < node_bottom + gap and bottom + shift > node_top - gap
            if horizontal and vertical:
                blockers.append(node_bottom + gap)
        if not blockers:
            return shift
        shift = max(shift, max(blockers) - top)
    return shift


def _origin_for_output(
    operation_id: str,
    source_version_id: str,
    operation: CanvasCropMediaOperation | CanvasSplitMediaOperation | CanvasUpscaleMediaOperation,
    output: _RenderedOutput,
    split_lines: tuple[list[float], list[float]] | None,
) -> CanvasLocalToolOrigin:
    if isinstance(operation, CanvasCropMediaOperation):
        detail = CanvasCropOperation(kind="crop", rect=operation.rect)
    elif isinstance(operation, CanvasSplitMediaOperation):
        assert split_lines is not None
        detail = CanvasSplitOperation(
            kind="split",
            horizontal_lines=split_lines[0],
            vertical_lines=split_lines[1],
            row=output.row,
            column=output.column,
        )
    else:
        detail = CanvasUpscaleOperation(
            kind="upscale",
            target_long_edge=operation.target_long_edge,
            algorithm=operation.algorithm,
        )
    return CanvasLocalToolOrigin(
        kind="local_tool",
        operation_id=operation_id,
        source_version_id=source_version_id,
        operation=detail,
    )


def _build_document(
    current: CanvasDocument,
    source: CanvasImageNode,
    request: CanvasMediaOperationRequest,
    operation_id: str,
    outputs: list[_RenderedOutput],
    split_lines: tuple[list[float], list[float]] | None,
) -> tuple[CanvasDocument, list[str], list[str]]:
    timestamp = _now()
    versions = dict(current.content_versions)
    nodes = list(current.nodes)
    connections = list(current.connections)
    created_version_ids: list[str] = []
    created_node_ids: list[str] = []
    preferred = 240 if isinstance(request.operation, CanvasSplitMediaOperation) else 320
    sizes = [_display_size(item.width, item.height, preferred) for item in outputs]
    source_width = source.size.width if source.size is not None else 320
    source_height = source.size.height if source.size is not None else 176
    start_x = source.position.x + source_width + 96

    column_widths: dict[int, float] = {}
    row_heights: dict[int, float] = {}
    for output, size in zip(outputs, sizes):
        column_widths[output.column] = max(column_widths.get(output.column, 0), size.width)
        row_heights[output.row] = max(row_heights.get(output.row, 0), size.height)
    x_offsets = {
        column: sum(column_widths[index] + 16 for index in range(column))
        for column in column_widths
    }
    y_offsets = {
        row: sum(row_heights[index] + 16 for index in range(row))
        for row in row_heights
    }

    positions: list[CanvasPoint] = []
    for output, size in zip(outputs, sizes):
        if isinstance(request.operation, CanvasSplitMediaOperation):
            position = CanvasPoint(
                x=start_x + x_offsets[output.column],
                y=source.position.y + y_offsets[output.row],
            )
        else:
            position = CanvasPoint(
                x=start_x,
                y=source.position.y + (source_height - size.height) / 2,
            )
        positions.append(position)
    shift_y = _placement_shift(positions, sizes, nodes)
    positions = [position.model_copy(update={"y": position.y + shift_y}) for position in positions]

    for output, size, position in zip(outputs, sizes, positions):
        version_id = f"version-{secrets.token_hex(12)}"
        node_id = f"image-{secrets.token_hex(12)}"
        origin = _origin_for_output(
            operation_id,
            request.source_version_id,
            request.operation,
            output,
            split_lines,
        )
        version = CanvasMediaVersion(
            version_id=version_id,
            kind="image",
            created_at=timestamp,
            sha256=output.sha256,
            origin=origin,
            path=f"derived/{operation_id}/{output.filename}",
            mime_type=_PNG_MIME,
            bytes=output.byte_count,
            width=output.width,
            height=output.height,
        )
        if isinstance(request.operation, CanvasSplitMediaOperation):
            title = f"切图 {output.row + 1}-{output.column + 1}"
        else:
            title = "裁剪结果" if isinstance(request.operation, CanvasCropMediaOperation) else "本地放大"
        node = CanvasImageNode(
            id=node_id,
            type="image",
            title=title,
            position=position,
            size=size,
            z_index=source.z_index,
            data=CanvasMediaNodeData(
                current_version_id=version_id,
                generation_draft=None,
                active_run_id=None,
                display=CanvasMediaDisplay(),
            ),
        )
        edge = CanvasDerivationConnection(
            id=f"connection-{secrets.token_hex(12)}",
            role="derivation",
            source_node_id=source.id,
            target_node_id=node_id,
            origin=CanvasLocalToolConnectionOrigin(
                kind="local_tool",
                operation_id=operation_id,
            ),
        )
        versions[version_id] = version
        nodes.append(node)
        connections.append(edge)
        created_version_ids.append(version_id)
        created_node_ids.append(node_id)

    document = current.model_copy(update={
        "revision": current.revision + 1,
        "updated_at": timestamp,
        "nodes": nodes,
        "connections": connections,
        "content_versions": versions,
    })
    return document, created_version_ids, created_node_ids


def execute_canvas_media_operation(
    project_id: str,
    request: CanvasMediaOperationRequest,
) -> CanvasMediaOperationResponse:
    with _GLOBAL_OPERATION_GATE, file_lock(_operation_lock_path(project_id)):
        with file_lock(_canvas_lock_path(project_id)):
            from character_workflow.lib.canvas_runs import recover_canvas_transactions_unlocked

            recover_canvas_transactions_unlocked(project_id)
            _recover_transactions_owned(project_id)
            initial = _read_document_unlocked(project_id)
            if initial.revision != request.expected_revision:
                raise RuntimeError(f"revision_conflict:{initial.revision}")
            _validate_source(initial, request)

        try:
            source_path, source_version = resolve_canvas_media(
                project_id,
                request.source_version_id,
            )
        except FileNotFoundError as error:
            raise CanvasMediaOperationError(
                "canvas_media_source_missing",
                "源图片文件不存在，不会创建空结果。",
            ) from error

        operation_id = f"operation-{secrets.token_hex(12)}"
        transaction = _transactions_root(project_id) / operation_id
        stage = transaction / "staging"
        stage.mkdir(parents=True, exist_ok=False)
        journal_path = transaction / "transaction.json"
        atomic_write_json(journal_path, {
            "schema_version": 1,
            "state": "staging",
            "project_id": project_id,
            "operation_id": operation_id,
        })
        prepared = False
        source_image: Image.Image | None = None
        started = time.monotonic()
        try:
            source_image = _decode_source(source_path, source_version)
            outputs, split_lines = _render_outputs(source_image, request.operation, stage)
            if time.monotonic() - started > _OPERATION_TIMEOUT_SECONDS:
                raise CanvasMediaOperationError(
                    "canvas_media_output_too_large",
                    "本地图片处理超过 60 秒，未提交任何画布变化。",
                )

            with file_lock(_canvas_lock_path(project_id)):
                from character_workflow.lib.canvas_runs import recover_canvas_transactions_unlocked

                recover_canvas_transactions_unlocked(project_id)
                current = _read_document_unlocked(project_id)
                if current.revision != request.expected_revision:
                    raise RuntimeError(f"revision_conflict:{current.revision}")
                source = _validate_source(current, request)
                updated, version_ids, node_ids = _build_document(
                    current,
                    source,
                    request,
                    operation_id,
                    outputs,
                    split_lines,
                )
                document_payload = updated.model_dump(mode="json")
                manifest = [
                    {
                        "filename": item.filename,
                        "bytes": item.byte_count,
                        "sha256": item.sha256,
                    }
                    for item in outputs
                ]
                atomic_write_json(journal_path, {
                    "schema_version": 1,
                    "state": "prepared",
                    "project_id": project_id,
                    "operation_id": operation_id,
                    "before_revision": current.revision,
                    "target_revision": updated.revision,
                    "document": document_payload,
                    "document_sha256": _canonical_sha(document_payload),
                    "outputs": manifest,
                })
                prepared = True
                derived = canvas_project_dir(project_id) / "derived" / operation_id
                if derived.exists():
                    raise RuntimeError("canvas media operation output already exists")
                stage.replace(derived)
                _write_project_state_unlocked(project_id, updated)

            shutil.rmtree(transaction, ignore_errors=True)
            return CanvasMediaOperationResponse(
                operation_id=operation_id,
                document=updated,
                created_version_ids=version_ids,
                created_node_ids=node_ids,
            )
        except (OSError, MemoryError) as error:
            if not prepared:
                shutil.rmtree(transaction, ignore_errors=True)
                raise
            raise RuntimeError("canvas media transaction is pending recovery") from error
        except BaseException:
            if not prepared:
                shutil.rmtree(transaction, ignore_errors=True)
            raise
        finally:
            if source_image is not None:
                source_image.close()
