import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from starlette.websockets import WebSocketDisconnect

from character_workflow.lib import collab_config as config
from character_workflow.lib.canvas_projects import create_canvas_project, read_canvas_document
from viewer_server.collab_app import create_collab_app


def event(socket, expected):
    for _ in range(32):
        value = socket.receive_json()
        if value["type"] == expected:
            return value
    pytest.fail(f"no {expected} event")


def token(client, base, name, proof=None):
    payload = {"display_name": name, **({"client_proof": proof} if proof else {})}
    res = client.post(base + "/auth", json=payload)
    assert res.status_code == 200
    return res.json()


def test_guest_room_presence_operations_upload_and_immediate_revocation():
    project_id = create_canvas_project("新建").project_id
    base = f"/collab/v1/projects/{project_id}"
    config.enable_share(project_id, config.ShareSettings())
    app = create_collab_app()
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 4321)) as client:
        first = token(client, base, "Kai", "0" * 64)
        assert token(client, base, "Kai", "0" * 64)["client_id"] == first["client_id"]
        second = token(client, base, "Kai", "1" * 64)
        assert second["client_id"] != first["client_id"]
        headers = {"Authorization": "Bearer " + first["collab_token"]}
        with (client.websocket_connect("ws://127.0.0.1" + base + "/ws", headers=headers) as one,
              client.websocket_connect("ws://127.0.0.1" + base + "/ws", headers={"Authorization": "Bearer " + second["collab_token"]}) as two):
            initial = event(one, "hello_snapshot")
            event(two, "hello_snapshot")
            one.send_json({"type": "presence_update", "selected_node_ids": ["selected"]})
            while True:
                presence = event(two, "presence_state")
                if any(row["selected_node_ids"] == ["selected"] for row in presence["members"]):
                    break
            op = {"kind": "node_add", "base_revision": initial["revision"], "op_id": "abc",
                  "node": {"id": "fresh-node", "title": "文字", "position": {"x": 1, "y": 2},
                           "type": "text", "data": {}}}
            one.send_json({"type": "submit_op", "op": op})
            for socket in (one, two):
                applied = event(socket, "op_applied")
                assert applied["delta"]["nodes"][0]["created_by_client"] == first["client_id"]
                assert applied["revision"] == 1
            image = io.BytesIO()
            Image.new("RGB", (2, 2)).save(image, format="PNG")
            upload = client.post(base + "/uploads", headers=headers,
                                 files={"file": ("file.png", image.getvalue(), "image/png")})
            assert upload.status_code == 200
            synced = event(two, "document_sync")
            assert synced["revision"] == 2
            assert len(synced["document"]["nodes"]) == 2
            import json
            payload = {"expected_revision": 2, "source_node_id": upload.json()["node_id"],
                       "source_version_id": upload.json()["version_id"]}
            mask = io.BytesIO()
            Image.new("RGBA", (2, 2), (0, 0, 0, 0)).save(mask, format="PNG")
            edit = client.post(base + "/image-edits", headers=headers,
                               files={"payload": (None, json.dumps(payload)),
                                      "mask_file": ("mask.png", mask.getvalue(), "image/png")})
            assert edit.status_code == 200, edit.text
            amended = event(two, "document_sync")["document"]
            node = next(n for n in amended["nodes"] if n["type"] == "image_edit")
            assert node["created_by_client"] == first["client_id"]
            assert amended["content_versions"][node["data"]["mask_version_id"]]["origin"]["kind"] == "user_mask"
            config.enable_share(project_id, config.ShareSettings(mode="view"))
            assert event(two, "room_policy_changed")["mode"] == "view"
            two.send_json({"type": "submit_op", "op": {**op, "op_id": "2"}})
            assert "仅可查看" in event(two, "op_rejected")["detail"]
            config.enable_share(project_id, config.ShareSettings(passcode="new"))
            assert event(one, "room_closed")["reason"]
            assert event(two, "room_closed")["reason"]
        assert len(read_canvas_document(project_id).nodes) == 3
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("ws://127.0.0.1" + base + "/ws", headers=headers):
                pass


def test_local_websocket_requires_loopback_origin_cookie_and_editor_lease():
    from fastapi import FastAPI
    from viewer_server.collab_ws import local_ws
    from viewer_server.connection_auth import ConnectionStore, cookie_name
    from viewer_server.request_boundary import LocalRequestBoundary

    project_id = create_canvas_project("原稿").project_id
    config.enable_share(project_id, config.ShareSettings())
    store = ConnectionStore("workspace")
    origin = "http://127.0.0.1:5188"
    session, token = store.local_session(origin, None)
    app = FastAPI()
    app.state.connection_store = store
    app.include_router(local_ws)
    app.add_middleware(LocalRequestBoundary)
    url = f"ws://127.0.0.1:5188/api/collab/shares/{project_id}/ws"
    with TestClient(app, base_url=origin, client=("127.0.0.1", 4411)) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(url, headers={"Origin": origin}):
                pass
        client.cookies.set(cookie_name(5188), token)
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(url, headers={"Origin": "http://example.org"}):
                pass
        with client.websocket_connect(url, headers={"Origin": origin}) as socket:
            socket.send_json({"type": "auth", "client_id": "tab"})
            assert event(socket, "hello_snapshot")["client_id"] == "host"
            op = {"kind": "node_add", "base_revision": 0, "op_id": "typed",
                  "node": {"id": "typed-text", "type": "text", "title": "文字",
                           "position": {"x": 0, "y": 0}, "data": {}}}
            socket.send_json({"type": "submit_op", "op": op})
            assert "编辑权" in event(socket, "op_rejected")["detail"]
            store.editor_lease(session, "tab")
            socket.send_json({"type": "submit_op", "op": op})
            assert event(socket, "op_applied")["delta"]["nodes"][0]["id"] == "typed-text"


def test_real_socket_proxy_forwards_operations_under_local_session(tmp_path):
    import os
    import subprocess
    import sys
    from types import SimpleNamespace
    from fastapi import FastAPI
    from starlette.requests import Request
    from character_workflow.lib.collab_discovery import discovery
    from viewer_server.collab_proxy import authenticate_remote, clear_tokens
    from viewer_server.collab_ws import local_ws
    from viewer_server.connection_auth import ConnectionStore, cookie_name
    from viewer_server.request_boundary import LocalRequestBoundary

    code = """
from character_workflow.lib import collab_config as config
from character_workflow.lib.canvas_projects import create_canvas_project
from character_workflow.lib.team_library import write_profile
from viewer_server.collab_app import CollabServer
project = create_canvas_project("房主画布").project_id
write_profile("Lou")
config.enable_share(project, config.ShareSettings())
server = CollabServer("127.0.0.1")
server.apply_saved()
print(project, server.port, flush=True)
try:
    input()
finally:
    server.stop()
"""
    host = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            env={**os.environ, "GAME_ATELIER_DATA_ROOT": str(tmp_path / "room-host")}, text=True)
    try:
        project, port = host.stdout.readline().split()
        peer = discovery.probe(f"127.0.0.1:{port}")
        store = ConnectionStore("guest-loopback")
        origin = "http://127.0.0.1:5189"
        session, token = store.local_session(origin, None)
        store.editor_lease(session, "tab")
        request = Request({"type": "http", "headers": [], "state": {"connection_principal": SimpleNamespace(
            session_id=session.principal.session_id,
        )}})
        auth = authenticate_remote(request, peer.key, project, "Kai", "")
        app = FastAPI()
        app.state.connection_store = store
        app.include_router(local_ws)
        app.add_middleware(LocalRequestBoundary)
        url = f"ws://127.0.0.1:5189/api/collab/remote/{peer.key}/projects/{project}/ws"
        with TestClient(app, base_url=origin, client=("127.0.0.1", 4321)) as client:
            client.cookies.set(cookie_name(5189), token)
            with client.websocket_connect(url, headers={"Origin": origin}) as socket:
                socket.send_json({"type": "auth", "client_id": "tab"})
                snapshot = event(socket, "hello_snapshot")
                assert snapshot["client_id"] == auth["client_id"]
                socket.send_json({"type": "submit_op", "op": {
                    "kind": "node_add", "base_revision": 0, "op_id": "creating",
                    "node": {"id": "via-proxy", "type": "text", "title": "访客文字",
                             "position": {"x": 90, "y": 20}, "data": {}},
                }})
                applied = event(socket, "op_applied")
                assert applied["delta"]["nodes"][0]["created_by"] == "Kai"
    finally:
        host.communicate("\n", timeout=12)
        discovery.stop()
        clear_tokens()
