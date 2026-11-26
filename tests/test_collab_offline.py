import hashlib
import io
import time
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from PIL import Image
from starlette.requests import Request

from character_workflow.lib.canvas_library import _content_node
from character_workflow.lib.canvas_projects import (
    create_canvas_project, read_canvas_document, resolve_canvas_media, save_canvas_upload,
)
from character_workflow.lib.collab_discovery import Manifest, Peer, discovery
from character_workflow.lib.collab_pending_media import blob_path, preview_path, receipts
from character_workflow.lib.collab_sanitize import public_document
from character_workflow.lib.schemas import CanvasPoint
from viewer_server import collab_offline, collab_proxy, collab_transfer_routes as transfer

def media(color, fmt):
    stream = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(stream, format=fmt)
    return stream.getvalue()


def test_offline_copy_keeps_cached_original_and_preview_then_repairs_with_authenticated_peer(monkeypatch):
    host = create_canvas_project("房主").project_id
    target = create_canvas_project("访客").project_id
    first, second = media("red", "PNG"), media("blue", "PNG")
    versions = []
    for rev, body in enumerate([first, second]):
        v, _, _ = save_canvas_upload(
            host, "asset.png", ".png", body, "image", rev, lambda v: _content_node(
                v.version_id, "参考", CanvasPoint(x=rev * 400, y=0), "image"))
        versions.append(v)
    request = Request({"type": "http", "headers": [], "state": {
        "connection_principal": SimpleNamespace(session_id="test"),
    }})
    peer = Peer("127.0.0.1:5181", Manifest(protocol_version=1, host_id=uuid4(), display_name="Kai", shares=[]), 0, 0)
    monkeypatch.setattr(discovery, "get", lambda k: peer)
    collab_offline.remember(request, peer.key, host, public_document(host))
    preview = media("blue", "WEBP")
    for v, blob, thumb in [(versions[0], first, False), (versions[1], preview, True)]:
        assert b"".join(collab_offline.cache_stream(request, peer.key, host, v.version_id, iter([blob]),
                        thumbnail=thumb, mime="image/webp" if thumb else "image/png")) == blob
    other_host = str(uuid4())
    assert collab_offline.cached_bytes(versions[0], other_host, host) is None
    assert collab_offline.cached_bytes(versions[0], str(peer.manifest.host_id), target) is None
    def absent(*_):
        raise HTTPException(503, "主机离线")
    monkeypatch.setattr(transfer, "_remote_document", absent)
    doc = read_canvas_document(host)
    command = transfer.CopySelection(target_project_id=target, node_ids=[row.id for row in doc.nodes])
    copied = transfer.copy_to_local(peer.key, host, command, request)
    one, two = [copied.content_versions[node.data.current_version_id] for node in copied.nodes]
    assert resolve_canvas_media(target, one.version_id)[0].read_bytes() == first
    assert two.pending_shared_original.version_id == versions[1].version_id
    assert preview_path(target, two).read_bytes() == preview
    with pytest.raises(FileNotFoundError):
        resolve_canvas_media(target, two.version_id)
    stranger = Request({"type": "http", "headers": [], "state": {
        "connection_principal": SimpleNamespace(session_id="stranger"),
    }})
    with pytest.raises(HTTPException):
        transfer.copy_to_local(peer.key, host, command, stranger)
    collab_offline.register_grant(request, peer.key, host, "Kai", "a" * 64)
    monkeypatch.setattr(collab_proxy, "has_token", lambda *_: True)
    monkeypatch.setattr(collab_proxy, "remote_bytes", lambda *a, **kw: first)
    with pytest.raises(HTTPException) as mismatch:
        collab_offline.repair_one(request, peer.key, host, str(peer.manifest.host_id), target)
    assert mismatch.value.status_code == 502
    assert read_canvas_document(target).revision == copied.revision
    monkeypatch.setattr(collab_proxy, "remote_bytes", lambda *a, **kw: second)
    collab_offline.repair_online()
    deadline = time.monotonic() + 3
    while read_canvas_document(target).revision == copied.revision and time.monotonic() < deadline:
        time.sleep(.02)
    repaired = read_canvas_document(target).content_versions[two.version_id]
    assert repaired.pending_shared_original is None
    assert resolve_canvas_media(target, repaired.version_id)[0].read_bytes() == second
    assert hashlib.sha256(second).hexdigest() == repaired.sha256
    collab_offline.reset()


def test_cache_paths_and_repair_receipts_validate_external_fields():
    host = str(uuid4())
    project = "canvas-ffffffff"
    with pytest.raises(ValueError):
        blob_path("../private", host, project)
    with pytest.raises(ValueError):
        receipts("../private", project)
    with pytest.raises(ValueError):
        receipts(host, "../private")
    assert blob_path("f" * 64, "../private", project).parent.name == "collab-cache"
