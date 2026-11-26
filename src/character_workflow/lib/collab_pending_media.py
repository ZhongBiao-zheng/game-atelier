"""Local receipts for restoring missing originals after a disconnected canvas copy."""
from __future__ import annotations

import hashlib
import re
import secrets
from uuid import UUID

from character_workflow.lib import data_root
from character_workflow.lib.canvas_thumbnails import canvas_thumbnails_dir
from character_workflow.lib.schemas import CanvasMediaVersion


def receipts(host_id: str, project_id: str):
    if str(UUID(host_id)) != host_id or not re.fullmatch(r"canvas-[a-z0-9-]{8,64}", project_id):
        raise ValueError("原件的来源画布标识无效")
    return data_root.runtime_dir() / "collab-repairs" / host_id / project_id


def blob_path(sha: str, host_id: str, project_id: str, *, preview=False):
    if not re.fullmatch(r"[a-f0-9]{64}", sha):
        raise ValueError("原件摘要无效")
    namespace = hashlib.sha256(f"{host_id}/{project_id}".encode()).hexdigest()
    filename = f"{namespace}-{sha}" + (".preview.webp" if preview else ".media")
    return data_root.runtime_dir() / "collab-cache" / filename


def preview_path(project_id, version):
    if isinstance(version, CanvasMediaVersion) and version.pending_shared_original:
        path = canvas_thumbnails_dir(project_id) / (version.sha256 + "-pending.webp")
        if path.is_file():
            return path
    return None


def pending_writes(project_id, versions):
    sources = set()
    writes = []
    for version in versions:
        if not isinstance(version, CanvasMediaVersion) or not version.pending_shared_original:
            continue
        source = version.pending_shared_original
        sources.add((source.host_id, source.project_id))
        preview = blob_path(version.sha256, source.host_id, source.project_id, preview=True)
        try:
            body = preview.read_bytes()
        except FileNotFoundError:
            continue
        target = canvas_thumbnails_dir(project_id) / (version.sha256 + "-pending.webp")
        if not target.exists():
            writes.append((target, body))
    writes.extend((receipts(host, project) / (secrets.token_hex(12) + ".txt"), project_id.encode())
                  for host, project in sources)
    return writes
