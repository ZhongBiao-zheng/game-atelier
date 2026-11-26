"""Session-owned document cache and content-addressed media for disconnected copies."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException

from character_workflow.lib import data_root, data_root_move
from character_workflow.lib.canvas_projects import (
    _now, _read_canvas_document_unlocked, _recover_canvas_transactions_unlocked, canvas_project_dir,
    canvas_project_lock_path, read_canvas_document,
)
from character_workflow.lib.canvas_reproduce import _commit
from character_workflow.lib.collab_discovery import discovery
from character_workflow.lib.collab_pending_media import blob_path, receipts
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.schemas import CanvasDocument, CanvasMediaVersion, CanvasPendingOriginal

logger = logging.getLogger(__name__)
_lock = threading.Lock()
_documents = OrderedDict()
_grants = OrderedDict()
_repairing: set[tuple] = set()
_last_attempt: dict[tuple, float] = {}
MAX_CACHE = 512 * 1024 * 1024
MAX_DOCUMENT_CACHE = 128 * 1024 * 1024


def _key(request, peer_key, project_id):
    from viewer_server.collab_proxy import _key as session_key
    return session_key(request, peer_key, project_id)


def forget(request, peer_key, project_id):
    with _lock:
        _documents.pop(_key(request, peer_key, project_id), None)


def reset():
    with _lock:
        _documents.clear()
        _grants.clear()
        _last_attempt.clear()


def remember(request, peer_key, project_id, doc):
    if not isinstance(doc, dict) or doc.get("project_id") != project_id:
        raise ValueError("共享文档来源不匹配")
    validated = CanvasDocument.model_validate(doc)
    if any(isinstance(row, CanvasMediaVersion) and row.pending_shared_original
           for row in validated.content_versions.values()):
        raise ValueError("共享文档包含本机修复信息")
    peer = discovery.get(peer_key)
    key = _key(request, peer_key, project_id)
    encoded = json.dumps(doc, ensure_ascii=False).encode()
    with _lock:
        previous = _documents.get(key)
        if previous and previous[3] > validated.revision:
            return
        _documents[key] = (str(peer.manifest.host_id), encoded, doc.get("content_versions", {}), validated.revision)
        _documents.move_to_end(key)
        total = sum(len(v[1]) for v in _documents.values())
        while total > MAX_DOCUMENT_CACHE and _documents:
            _, (_, evicted, _, _) = _documents.popitem(last=False)
            total -= len(evicted)


def snapshot(request, peer_key, project_id):
    key = _key(request, peer_key, project_id)
    with _lock:
        entry = _documents.get(key)
        if entry is None:
            raise HTTPException(503, "本次会话尚未加载这张共享画布")
    return entry[0], CanvasDocument.model_validate_json(entry[1])


def observe_event(request, peer_key, project_id, raw):
    event = json.loads(raw)
    if event.get("type") not in {"hello_snapshot", "op_applied", "document_sync"}:
        return
    document = event.get("document")
    if document is None and "delta" in event:
        try:
            _, cached = snapshot(request, peer_key, project_id)
        except HTTPException:
            return
        if event.get("base_revision") != cached.revision:
            return
        document = cached.model_dump(mode="json")
        delta = event["delta"]
        for section in ("nodes", "connections"):
            rows = {row["id"]: row for row in document[section]}
            for key in delta["removed_" + section]:
                rows.pop(key, None)
            rows.update((row["id"], row) for row in delta[section])
            document[section] = list(rows.values())
        document["content_versions"].update(delta["content_versions"])
        document.update(revision=event["revision"], updated_at=delta["updated_at"])
    if document is not None:
        remember(request, peer_key, project_id, document)


def _prune(directory):
    entries = []
    for path in directory.glob("*"):
        if path.suffix not in (".media", ".webp"):
            continue
        try:
            stat = path.stat()
        except FileNotFoundError:
            continue
        entries.append((stat.st_mtime_ns, stat.st_size, path))
    total = sum(size for _, size, _ in entries)
    for _, size, path in sorted(entries):
        if total <= MAX_CACHE:
            break
        path.unlink(missing_ok=True)
        total -= size


def cache_stream(request, peer_key, project_id, version_id, chunks, *, thumbnail, mime):
    try:
        with _lock:
            host_id, _, versions, _ = _documents[_key(request, peer_key, project_id)]
            data = versions[version_id]
        version = CanvasMediaVersion.model_validate(data)
    except (KeyError, ValueError):
        yield from chunks
        return
    if not isinstance(version, CanvasMediaVersion) or version.bytes > MAX_CACHE:
        yield from chunks
        return
    target = blob_path(version.sha256, host_id, project_id)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = tempfile.NamedTemporaryFile(dir=target.parent, prefix=".receive-", delete=False)
    except OSError:
        yield from chunks
        return
    path = Path(temp.name)
    size = 0
    digest = hashlib.sha256()
    try:
        with temp:
            for chunk in chunks:
                size += len(chunk)
                digest.update(chunk)
                try:
                    temp.write(chunk)
                except OSError:
                    temp.close()
                    yield chunk
                    yield from chunks
                    return
                yield chunk
        if size == version.bytes and digest.hexdigest() == version.sha256:
            destination = target
        elif thumbnail and mime == "image/webp" and size <= 10 * 1024 * 1024:
            with path.open("rb") as handle:
                header = handle.read(12)
            if not (header[:4] == b"RIFF" and header[8:] == b"WEBP"):
                return
            destination = blob_path(version.sha256, host_id, project_id, preview=True)
        else:
            return
        os.replace(path, destination)
        with _lock:
            _prune(target.parent)
    except OSError:
        logger.debug("共享媒体缓存写入失败", exc_info=True)
    finally:
        path.unlink(missing_ok=True)


def cached_bytes(version, host_id, project_id):
    target = blob_path(version.sha256, host_id, project_id)
    try:
        if target.stat().st_size != version.bytes:
            return None
        body = target.read_bytes()
        return body if hashlib.sha256(body).hexdigest() == version.sha256 else None
    except OSError:
        return None


def pending_source(host_id, source_project, version_id):
    return CanvasPendingOriginal(host_id=host_id, project_id=source_project, version_id=version_id)


def repair_one(request, peer_key, project_id, host_id, target_id):
    from viewer_server.collab_transfer_routes import _download_media
    try:
        current = read_canvas_document(target_id)
    except (KeyError, FileNotFoundError):
        # A canvas in the recycle bin may return. Keep its small receipt through the restore window.
        return False
    pending = [row for row in current.content_versions.values()
               if isinstance(row, CanvasMediaVersion) and row.pending_shared_original
               and row.pending_shared_original.host_id == host_id
               and row.pending_shared_original.project_id == project_id]
    for version in pending:
        source = version.pending_shared_original
        remote = version.model_copy(update={"version_id": source.version_id})
        body = _download_media(request, peer_key, project_id, remote, min(version.bytes, 256 * 1024 * 1024))
        with file_lock(canvas_project_lock_path(target_id)):
            _recover_canvas_transactions_unlocked(target_id)
            current = _read_canvas_document_unlocked(target_id)
            row = current.content_versions.get(version.version_id)
            if row != version:
                continue
            root = canvas_project_dir(target_id).resolve()
            target = (root / row.path).resolve()
            if not target.is_relative_to(root / "uploads"):
                raise ValueError("待补齐文件位置无效")
            current.content_versions[row.version_id] = row.model_copy(update={"pending_shared_original": None})
            current.revision += 1
            current.updated_at = _now()
            _commit(target_id, current, [(target, body)], current.updated_at)
    return True


def register_grant(request, peer_key, project_id, display_name, resume_proof):
    principal = request.state.connection_principal
    state = SimpleNamespace(connection_principal=principal, connection_session=getattr(request.state, "connection_session", None))
    key = _key(request, peer_key, project_id)
    with _lock:
        _grants[key] = (SimpleNamespace(state=state), peer_key, project_id, display_name, resume_proof)
        _grants.move_to_end(key)
        if len(_grants) > 512:
            _grants.popitem(last=False)


def renew(request, peer_key, project_id):
    from viewer_server.collab_proxy import authenticate_remote
    key = _key(request, peer_key, project_id)
    with _lock:
        grant = _grants.get(key)
    if grant is None:
        return False
    session = grant[0].state.connection_session
    if session and (session.revoked.is_set() or session.expires_at <= time.time()):
        return False
    try:
        authenticate_remote(request, peer_key, project_id, grant[3], "", resume_proof=grant[4])
    except HTTPException as error:
        if error.status_code in {403, 404}:
            with _lock:
                _grants.pop(key, None)
                _documents.pop(key, None)
            return False
        raise
    return True


def repair_online():
    with _lock:
        grants = list(_grants.items())
    for key, grant in grants:
        request, peer_key, project_id, *_ = grant
        session = request.state.connection_session
        if (key[0] != str(data_root.resolve_data_root())
                or (session and (session.revoked.is_set() or session.expires_at <= time.time()))):
            with _lock:
                _grants.pop(key, None)
            continue
        schedule(request, peer_key, project_id)


def schedule(request, peer_key, project_id):
    try:
        host_id = str(discovery.get(peer_key).manifest.host_id)
    except (ValueError, KeyError):
        return
    directory = receipts(host_id, project_id)
    if not next(directory.glob("*.txt"), None):
        return
    key = _key(request, peer_key, project_id)
    root = data_root.resolve_data_root()
    with _lock:
        if key in _repairing or time.monotonic() < _last_attempt.get(key, 0) or len(_repairing) >= 2:
            return
        _repairing.add(key)
        _last_attempt[key] = time.monotonic() + 5

    def repair():
        try:
            from viewer_server.collab_proxy import has_token
            if not has_token(request, peer_key, project_id) and not renew(request, peer_key, project_id):
                return
            for marker in directory.glob("*.txt"):
                if not data_root_move.enter_write():
                    break
                try:
                    if root != data_root.resolve_data_root():
                        break
                    target_id = marker.read_text(encoding="utf-8")
                    complete = repair_one(request, peer_key, project_id, host_id, target_id)
                    if complete or time.time() - marker.stat().st_mtime > 30 * 86400:
                        marker.unlink(missing_ok=True)
                finally:
                    data_root_move.leave_write()
        except (HTTPException, KeyError, ValueError, OSError):
            logger.debug("共享画布原件等待下一次重连", exc_info=True)
        finally:
            with _lock:
                _repairing.discard(key)

    threading.Thread(target=repair, name="collab-media-repair", daemon=True).start()
