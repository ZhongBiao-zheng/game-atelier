import os
import socket
import subprocess
import sys
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from character_workflow.lib import collab_config as config
from character_workflow.lib.canvas_projects import create_canvas_project
from character_workflow.lib.collab_discovery import discovery
from character_workflow.lib.team_library import write_profile
from viewer_server import collab_proxy
from viewer_server.collab_app import CollabServer, create_collab_app


def test_manifest_and_document_access_follow_current_share_policy():
    write_profile("房主")
    public = create_canvas_project("共享稿").project_id
    private = create_canvas_project("私有稿").project_id
    config.enable_share(public, config.ShareSettings(passcode="a"))
    with TestClient(create_collab_app(), base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        manifest = client.get("/collab/v1/manifest")
        assert [row["project_id"] for row in manifest.json()["shares"]] == [public]
        assert private not in manifest.text
        assert client.get("/docs").status_code == 404
        assert client.get("/api/keys").status_code == 404
        assert client.get("/collab/v1/manifest", headers={"Origin": "http://example.org"}).status_code == 403
        url = f"/collab/v1/projects/{public}"
        assert client.get(url + "/document").status_code == 401
        assert client.post(url + "/auth", json={"display_name": "访客", "passcode": "b"}).status_code == 401
        token = client.post(url + "/auth", json={"display_name": "访客", "passcode": "a"}).json()["collab_token"]
        headers = {"authorization": "Bearer " + token}
        assert client.get(url + "/document", headers=headers).json()["document"]["project_id"] == public
        assert client.get(url.replace(public, private) + "/document", headers=headers).status_code == 404
        config.enable_share(public, config.ShareSettings(passcode="b"))
        assert client.get(url + "/document", headers=headers).status_code == 401
        config.disable_share(public)
        assert client.get(url + "/document", headers=headers).status_code == 404


def test_listener_uses_next_available_port_and_releases_it():
    server = CollabServer("127.0.0.1")
    server.apply_saved()
    assert not server.running
    project = create_canvas_project("监听测试").project_id
    config.enable_share(project, config.ShareSettings())
    with socket.socket() as occupied:
        try:
            occupied.bind(("127.0.0.1", 5181))
        except OSError:
            pass
        try:
            server.apply_saved()
            assert server.port > 5181
            port = server.port
            response = httpx.get(f"http://127.0.0.1:{port}/collab/v1/manifest", trust_env=False)
            assert response.json()["shares"][0]["project_id"] == project
            config.disable_share(project)
            server.apply_saved()
            assert not server.running
            with pytest.raises(OSError):
                socket.create_connection(("127.0.0.1", port), timeout=1)
        finally:
            server.stop()


def test_two_data_roots_and_proxy_session_isolation(tmp_path):
    # The host and the guest have separate file state, credentials and in-memory sessions.
    host_root = tmp_path / "host-data"
    guest_root = os.environ["GAME_ATELIER_DATA_ROOT"]
    code = """
from character_workflow.lib import collab_config as c
from character_workflow.lib.canvas_projects import create_canvas_project
from character_workflow.lib.team_library import write_profile
from viewer_server.collab_app import CollabServer
write_profile("Lou")
project = create_canvas_project("画布")
c.enable_share(project.project_id, c.ShareSettings(passcode="one"))
s = CollabServer("127.0.0.1")
s.apply_saved()
print(project.project_id, s.port, flush=True)
try:
    input()
finally:
    s.stop()
"""
    env = {**os.environ, "GAME_ATELIER_DATA_ROOT": str(host_root)}
    host = subprocess.Popen([sys.executable, "-c", code], env=env, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        line = host.stdout.readline()
        assert line, host.stderr.read() if host.poll() is not None else "host startup"
        project, port = line.strip().split()
        peer = discovery.probe(f"127.0.0.1:{port}")
        def request(sid):
            return Request({"type": "http", "headers": [], "state": {
                "connection_principal": SimpleNamespace(session_id=sid),
            }})
        visitor = request("visitor")
        with pytest.raises(HTTPException) as denied:
            collab_proxy.authenticate_remote(visitor, peer.key, project, "Kai", "wrong")
        assert denied.value.status_code == 403
        grant = collab_proxy.authenticate_remote(visitor, peer.key, project, "Kai", "one")
        assert set(grant) == {"display_name", "client_id"}
        result = collab_proxy.remote_json(visitor, peer.key, project, "document")
        assert result["owner_display_name"] == "Lou"
        assert str(host_root) not in str(result)
        assert guest_root not in str(result)
        with pytest.raises(HTTPException) as denied:
            collab_proxy.remote_json(request("another-session"), peer.key, project, "document")
        assert denied.value.status_code == 403
    finally:
        host.communicate("\n", timeout=10)
        discovery.stop()
        collab_proxy.clear_tokens()


def test_peer_list_deduplicates_manual_and_broadcast_addresses(monkeypatch):
    from uuid import uuid4
    from character_workflow.lib.collab_discovery import Card, Manifest, Peer
    from viewer_server.collab_routes import peers

    project_id = "canvas-aaaaaaaa"
    listing = Manifest(protocol_version=1, host_id=uuid4(), display_name="共享人", shares=[
        Card(project_id=project_id, name="草稿", node_count=1, updated_at="today",
             mode="edit", requires_passcode=False, allow_borrow_provider=False, online_count=0),
    ])
    auto = Peer("192.168.1.1:5181", listing, 1, 0)
    manual = Peer("127.0.0.1:5181", listing, 1, 0)
    config.set_manual_peer(manual.address, enabled=True)
    monkeypatch.setattr(discovery, "online", lambda: [auto, manual])
    request = Request({"type": "http", "headers": [], "state": {
        "connection_principal": SimpleNamespace(session_id="first"),
    }})
    assert [card["peer_key"] for card in peers(request)["shares"]] == [manual.key]
    monkeypatch.setattr(collab_proxy, "_tokens", {collab_proxy._key(request, auto.key, project_id): "existing"})
    assert [card["peer_key"] for card in peers(request)["shares"]] == [auto.key]


def test_public_document_redacts_private_strings_in_frozen_fields():
    import hashlib
    from character_workflow.lib.canvas_projects import _document_path, read_canvas_document
    from character_workflow.lib.collab_sanitize import public_document
    from character_workflow.lib.schemas import CanvasFrozenGeneration, CanvasTextVersion, CanvasUserEditOrigin
    from character_workflow.lib.atomic_io import atomic_write_json

    project = create_canvas_project("已共享").project_id
    document = read_canvas_document(project)
    version = CanvasTextVersion(
        version_id="version-safe", kind="text", text="作品", created_at=document.updated_at,
        sha256=hashlib.sha256("作品".encode()).hexdigest(),
        origin=CanvasUserEditOrigin(kind="user_edit"), frozen_generation=CanvasFrozenGeneration(
            mode="text", source_kind="studio", model_id="/Users/fixture/private",
            model_name="C:\\Fixture\\private", provider="平台", provider_label="authorization=fixture-secret",
        ),
    )
    document.content_versions[version.version_id] = version
    atomic_write_json(_document_path(project), document.model_dump(mode="json"))
    result = str(public_document(project))
    assert "/Users/fixture" not in result and "Fixture" not in result and "fixture-secret" not in result


def test_revocation_waits_for_project_commit(monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from character_workflow.lib.canvas_projects import canvas_project_lock_path
    from character_workflow.lib.file_lock import file_lock
    from viewer_server import collab_routes

    project = create_canvas_project("共享").project_id
    config.enable_share(project, config.ShareSettings())
    entered = threading.Event()
    def stop():
        entered.set()
        collab_routes._disable_locked(project)
    with ThreadPoolExecutor(1) as pool:
        with file_lock(canvas_project_lock_path(project)):
            stopped = pool.submit(stop)
            assert entered.wait(1)
            assert config.read_config().shares[project].enabled
            assert not stopped.done()
        stopped.result(timeout=2)
    assert project not in config.read_config().shares


def test_guest_token_never_crosses_a_data_root_switch(isolated_data_root, monkeypatch, tmp_path):
    import shutil
    from viewer_server.collab_access import authenticate, require_guest

    project = create_canvas_project("共享").project_id
    config.enable_share(project, config.ShareSettings())
    token = authenticate(project, "", "Kai")["collab_token"]
    clone = tmp_path / "next-root"
    shutil.copytree(isolated_data_root, clone)
    monkeypatch.setenv("GAME_ATELIER_DATA_ROOT", str(clone))
    request = Request({"type": "http", "headers": [(b"authorization", ("Bearer " + token).encode())]})
    with pytest.raises(HTTPException) as revoked:
        require_guest(request, project)
    assert revoked.value.status_code == 401
