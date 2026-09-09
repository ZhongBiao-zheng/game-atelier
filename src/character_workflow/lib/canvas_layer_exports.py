"""Download every registered layer without re-encoding the original media."""
from __future__ import annotations

import re
import tempfile
from pathlib import Path
from zipfile import ZipFile, ZIP_STORED

from character_workflow.lib.canvas_projects import (
    _read_canvas_document_unlocked,
    _resolve_canvas_media_version,
    canvas_media_response_metadata,
    canvas_project_lock_path,
)
from character_workflow.lib.file_lock import file_lock


def _filename_stem(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", name).strip(" .")[:80] or "图层"


def export_canvas_layers(project_id: str, node_id: str) -> tuple[Path, str]:
    # Hold the project lock through packaging so deletion cannot remove media halfway through.
    with file_lock(canvas_project_lock_path(project_id)):
        document = _read_canvas_document_unlocked(project_id)
        node = next((item for item in document.nodes if item.id == node_id), None)
        if node is None or node.type != "layer_stack":
            raise KeyError(node_id)
        if not node.data.base_version_id or node.data.active_run_id:
            raise ValueError("图层尚未拆分完成")
        layers = [("背景", node.data.base_version_id), *[
            (layer.name or f"图层 {layer.z_index}", layer.version_id)
            for layer in node.data.layers
        ]]
        files: list[tuple[Path, str]] = []
        for index, (name, version_id) in enumerate(layers):
            version = document.content_versions.get(version_id)
            if version is None or version.kind != "image":
                raise FileNotFoundError("图层图片不可用")
            path, version = _resolve_canvas_media_version(project_id, version)
            canvas_media_response_metadata(version)
            # Sequence prefixes preserve panel order and avoid duplicate/case-insensitive names.
            files.append((path, f"{index + 1:03d}-{_filename_stem(name)}{path.suffix.lower()}"))
        with tempfile.NamedTemporaryFile(prefix="atelier-layers-", suffix=".zip", delete=False) as temp:
            target = Path(temp.name)
        try:
            with ZipFile(target, "w", compression=ZIP_STORED) as archive:
                for path, filename in files:
                    archive.write(path, filename)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
    return target, f"{_filename_stem(node.title)}-全部图层.zip"
