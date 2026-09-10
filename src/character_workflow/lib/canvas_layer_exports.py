"""Download every registered layer as a ZIP of the original media or as a layered PSD."""
from __future__ import annotations

import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from zipfile import ZipFile, ZIP_STORED

from PIL import Image

from character_workflow.lib.canvas_projects import (
    _read_canvas_document_unlocked,
    _resolve_canvas_media_version,
    canvas_media_response_metadata,
    canvas_project_lock_path,
)
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import CanvasDocument, CanvasLayerStackNode


@dataclass(frozen=True)
class _LayerFile:
    name: str
    path: Path
    # Base layer covers the whole canvas and has no bounding box.
    bounds: tuple[int, int, int, int] | None
    visible: bool


def _filename_stem(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", name).strip(" .")[:80] or "图层"


def _collect_layer_files(
    project_id: str, document: CanvasDocument, node: CanvasLayerStackNode,
) -> list[_LayerFile]:
    """Bottom-to-top stacking order, the same order the Web layer list shows."""
    data = node.data
    if not data.base_version_id or data.active_run_id:
        raise ValueError("图层尚未拆分完成")
    parts = [
        (data.base_z_index, "背景", data.base_version_id, None, data.base_visible),
        *[
            (
                layer.z_index,
                layer.name or f"图层 {layer.z_index}",
                layer.version_id,
                layer.bounding_box.absolute,
                layer.visible,
            )
            for layer in data.layers
        ],
    ]
    parts.sort(key=lambda part: part[0])
    files: list[_LayerFile] = []
    for _, name, version_id, bounds, visible in parts:
        version = document.content_versions.get(version_id)
        if version is None or version.kind != "image":
            raise FileNotFoundError("图层图片不可用")
        path, version = _resolve_canvas_media_version(project_id, version)
        canvas_media_response_metadata(version)
        files.append(_LayerFile(name, path, bounds, visible))
    return files


def _read_layer_stack(project_id: str, node_id: str) -> tuple[CanvasDocument, CanvasLayerStackNode]:
    document = _read_canvas_document_unlocked(project_id)
    node = next((item for item in document.nodes if item.id == node_id), None)
    if node is None or node.type != "layer_stack":
        raise KeyError(node_id)
    return document, node


def _temp_target(suffix: str) -> Path:
    with tempfile.NamedTemporaryFile(prefix="atelier-layers-", suffix=suffix, delete=False) as temp:
        return Path(temp.name)


def export_canvas_layers(project_id: str, node_id: str) -> tuple[Path, str]:
    # Hold the project lock through packaging so deletion cannot remove media halfway through.
    with file_lock(canvas_project_lock_path(project_id)):
        document, node = _read_layer_stack(project_id, node_id)
        files = _collect_layer_files(project_id, document, node)
        target = _temp_target(".zip")
        try:
            with ZipFile(target, "w", compression=ZIP_STORED) as archive:
                for index, file in enumerate(files):
                    # Sequence prefixes preserve panel order and avoid duplicate names.
                    archive.write(
                        file.path,
                        f"{index + 1:03d}-{_filename_stem(file.name)}{file.path.suffix.lower()}",
                    )
        except BaseException:
            target.unlink(missing_ok=True)
            raise
    return target, f"{_filename_stem(node.title)}-全部图层.zip"


def _write_psd(files: list[_LayerFile], target: Path) -> None:
    from psd_tools import PSDImage
    from psd_tools.constants import Tag

    base = next(file for file in files if file.bounds is None)
    with Image.open(base.path) as base_image:
        psd = PSDImage.new("RGBA", base_image.size)
    for index, file in enumerate(files):
        with Image.open(file.path) as image:
            pixels = image.convert("RGBA")
        left, top = 0, 0
        if file.bounds is not None:
            left, top, right, bottom = file.bounds
            # Layers are placed by their bounding box, the same way the Web preview draws them.
            if pixels.size != (right - left, bottom - top):
                pixels = pixels.resize((right - left, bottom - top), Image.Resampling.LANCZOS)
        layer = psd.create_pixel_layer(pixels, name=f"layer{index + 1}", top=top, left=left)
        # The legacy Pascal name field is MacRoman and rejects CJK; Photoshop reads the
        # Unicode name block first, so the real name goes there and the legacy field stays ASCII.
        layer._record.tagged_blocks.set_data(Tag.UNICODE_LAYER_NAME, file.name)
        layer.visible = file.visible
    psd.save(target)


def export_canvas_layers_psd(project_id: str, node_id: str) -> tuple[Path, str]:
    with file_lock(canvas_project_lock_path(project_id)):
        document, node = _read_layer_stack(project_id, node_id)
        files = _collect_layer_files(project_id, document, node)
        target = _temp_target(".psd")
        try:
            _write_psd(files, target)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
    return target, f"{_filename_stem(node.title)}.psd"
