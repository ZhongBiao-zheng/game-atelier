"""Real stdio adapter + isolated HTTP seam; domain approval is tested in Workshop tests."""
from __future__ import annotations

import asyncio
import base64
import io
import json
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import requests
import uvicorn
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters
from pydantic import ValidationError
from PIL import Image

from character_workflow.lib.private_json import write_private_json
from character_workflow.lib.workshop_schema import ListProjectsInput
from character_workflow.mcp.server import ALL_TOOL_INPUT_MODELS as TOOL_INPUT_MODELS, tool_name
from character_workflow.mcp.client import (
    AdapterError, Credentials, MAX_RESPONSE_BYTES, WorkshopClient, load_credentials,
)
from viewer_server.server_app import build_app


SOURCE = Path(__file__).resolve().parents[1] / "src"
TARGET = {"type": "character", "project_id": "project-a", "character_id": "bird",
          "asset_slot": "portrait"}


def expires(hours=1):
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


@pytest.fixture
def runtime(tmp_path):
    state = {
        "instance_id": "instance-one", "sessions": 0, "calls": [], "behavior": None,
        "grant_token": "test-grant-secret-" + "a" * 32,
        "session_token": "test-session-secret-" + "b" * 32,
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def send_json(self, payload, status=200, headers=None):
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            assert self.path == "/api/connection/status"
            self.send_json({"service": state.get("service", "game-atelier"),
                            "instance_id": state["instance_id"], "app_version": "test",
                            "protocol": state.get("protocol", "atelier-local/1")})

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/api/connection/agent-sessions":
                assert self.headers.get("Origin") is None
                assert payload == {"grant_id": "grant-test", "grant_token": state["grant_token"],
                                   "instance_id": state["instance_id"]}
                state["sessions"] += 1
                self.send_json({"session_id": f"session-{state['sessions']}",
                                "session_token": state["session_token"], "expires_at": expires(),
                                "instance_id": state["instance_id"], "capabilities": ["read"],
                                "project_ids": ["project-a"]})
                return
            assert self.path.startswith(("/api/workshop/", "/api/canvas-agent/"))
            assert self.headers.get("Authorization") == f"Bearer {state['session_token']}"
            assert self.headers.get("Origin") is None
            state["calls"].append((self.path, payload))
            behavior = state["behavior"]
            if behavior == "expire-once":
                state["behavior"] = None
                self.send_json({"error": {"code": "SESSION_EXPIRED"}}, 401)
            elif behavior == "revoked":
                self.send_json({"error": {"code": "SESSION_REVOKED",
                                         "message": state["grant_token"]}}, 403)
            elif behavior == "unknown-error":
                self.send_json({"error": {"code": {"malformed": True},
                                         "message": "/private/secret " + state["grant_token"]}}, 500)
            elif behavior == "domain-error":
                self.send_json({"error": {"code": state["domain_error"],
                                         "message": "/private/secret " + state["grant_token"]}}, 422)
            elif behavior == "redirect":
                self.send_json({}, 302, {"Location": "https://must-not-follow.invalid/"})
            elif behavior == "large":
                self.send_json({"text": "x" * MAX_RESPONSE_BYTES})
            elif behavior == "secret":
                self.send_json({"result": {"session_token": state["session_token"]}})
            elif behavior == "disconnect":
                self.close_connection = True
            elif self.path.endswith("read-media"):
                buffer = io.BytesIO()
                Image.new("RGB", (4, 4), "white").save(buffer, format="JPEG")
                self.send_json({"media_id": "media-one", "kind": "image", "width": 4, "height": 4,
                                "preview": {"mime_type": "image/jpeg",
                                            "data_base64": base64.b64encode(buffer.getvalue()).decode()}})
            elif self.path.endswith("list-projects"):
                self.send_json({"items": [{"id": "project-a", "name": "测试项目"}], "page": 1})
            else:
                self.send_json({"accepted": self.path.rsplit("/", 1)[1],
                                "state": "awaiting_approval", "request_id": "request-test"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    credentials = tmp_path.resolve() / "grant.json"
    write_private_json(credentials, {
        "service": "game-atelier", "base_url": f"http://127.0.0.1:{server.server_port}",
        "grant_id": "grant-test", "grant_token": state["grant_token"], "expires_at": expires(24),
    })
    state["credentials"] = credentials
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def parameters(runtime, tmp_path):
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "character_workflow.mcp", "--credentials", str(runtime["credentials"])],
        cwd=tmp_path, env={"PYTHONPATH": str(SOURCE),
                           "GAME_ATELIER_DATA_ROOT": str(tmp_path / "unused-data")},
    )


def tool_payload(operation):
    if operation.startswith("canvas-"):
        canvas = {"project_id": "canvas-project-a"}
        return {
            "canvas-list-projects": {},
            "canvas-get-document": canvas,
            "canvas-list-models": {**canvas, "mode": "image"},
            "canvas-apply-changes": {**canvas, "expected_revision": 3, "changes": [
                {"op": "add_text", "title": "提示", "text": "雨夜", "position": {"x": 0, "y": 0}}]},
            "canvas-import-media": {**canvas, "expected_revision": 3, "path": "/tmp/example.png"},
            "canvas-run": {**canvas, "surface_node_id": "image-one", "expected_revision": 3},
            "canvas-get-run": {**canvas, "run_id": "run-1"},
            "canvas-read-media": {**canvas, "version_id": "media-one"},
        }[operation]
    if operation == "list-targets":
        return {"project_id": TARGET["project_id"], "page_size": 50}
    if operation == "list-projects":
        return {"page": 1, "page_size": 2}
    if operation == "create-target":
        return {"project_id": "project-a", "type": "character", "name": "鸟",
                "idempotency_key": "create-bird-001"}
    if operation == "get-generation":
        return {"request_id": "request-test"}
    if operation == "list-prompt-assets":
        return {"tags": ["高清"], "limit": 5}
    if operation == "read-prompt-asset":
        return {"asset_id": "creation-asset-0001"}
    if operation in {"withdraw-generation", "approve-generation"}:
        return {"request_id": "request-test", "expected_revision": 1}
    payload = {"target": TARGET}
    if operation in {"read-document", "write-document"}:
        payload["kind"] = "character_spec"
    if operation == "write-document":
        payload.update(content="一只中文小鸟", expected_revision="a" * 64,
                       idempotency_key="write-bird-001")
    if operation == "append-lesson":
        payload.update(scope="project", line="经验一条", idempotency_key="lesson-bird-001")
    if operation == "acknowledge-feedback":
        payload.update(feedback_ids=["feedback-one"], idempotency_key="feedback-bird-001")
    if operation == "read-media":
        payload["media_id"] = "media-one"
    if operation == "prepare-generation":
        payload.update(prompt="一只鸟", alias="local-test", model="test-image",
                       params={"type": "image", "n": 1}, media_ids=[],
                       idempotency_key="prepare-bird-001")
    return payload


@pytest.mark.parametrize("mode", ["auto", "legacy"])
async def test_stdio_exposes_and_calls_all_typed_workshop_tools(runtime, tmp_path, mode):
    async with asyncio.timeout(30):
        async with Client(parameters(runtime, tmp_path), mode=mode,
                          read_timeout_seconds=10) as client:
            listing = await client.list_tools()
            names = {tool_name(name) for name in TOOL_INPUT_MODELS}
            assert {tool.name for tool in listing.tools} == names
            for tool in listing.tools:
                assert tool.input_schema["additionalProperties"] is False
                assert tool.annotations.open_world_hint is False
            for operation in TOOL_INPUT_MODELS:
                result = await client.call_tool(tool_name(operation), {
                    "payload": tool_payload(operation),
                })
                assert not result.is_error
                assert result.structured_content is not None
                if operation.endswith("list-projects"):
                    assert result.structured_content["items"][0]["name"] == "测试项目"
                elif operation.endswith("read-media"):
                    assert result.structured_content["media_id"] == "media-one"
                    assert "preview" not in result.structured_content
                    assert result.content[1].type == "image"
                    assert result.content[1].mime_type == "image/jpeg"
                else:
                    assert result.structured_content["accepted"] == operation.removeprefix("canvas-")
            assert (await client.list_resources()).resources == []
            assert (await client.list_resource_templates()).resource_templates == []
    assert runtime["sessions"] == 1
    assert len(runtime["calls"]) == len(TOOL_INPUT_MODELS)
    assert not (tmp_path / "unused-data").exists()


async def test_stdio_rejects_extra_fields_types_paths_approval_and_unbounded_arguments(runtime, tmp_path):
    async with asyncio.timeout(30):
        async with Client(parameters(runtime, tmp_path), read_timeout_seconds=10) as client:
            bad = [
                {"payload": {}, "confirmed": True},
                {"payload": {"page_size": "3"}},
                {"payload": {"page_size": 10000}},
                {"payload": {"page": True}},
                {"payload": '{"page":1}'},
                {"payload": {"base_url": "https://evil.invalid"}},
            ]
            for arguments in bad:
                result = await client.call_tool("workshop_list_projects", arguments)
                assert result.is_error
                assert result.structured_content["error"]["code"] == "INVALID_TOOL_INPUT"
            for addition in (
                {"confirmed": True}, {"source_image": "/private/secret.png"},
                {"media_ids": ["https://evil.invalid/image.png"]},
                {"params": {"type": "image", "n": 1, "confirmed": True}},
            ):
                result = await client.call_tool("workshop_prepare_generation", {
                    "payload": {**tool_payload("prepare-generation"), **addition},
                })
                assert result.is_error
            for name in ("workshop_approve_generation", "execute_command", "read_file"):
                result = await client.call_tool(name, {"payload": {}})
                assert result.is_error
    assert runtime["sessions"] == 1
    assert runtime["calls"] == []


async def test_stdio_returns_structured_permission_error_without_secret_details(runtime, tmp_path):
    runtime["behavior"] = "revoked"
    async with asyncio.timeout(20):
        async with Client(parameters(runtime, tmp_path), read_timeout_seconds=10) as client:
            result = await client.call_tool("workshop_list_projects", {"payload": {}})
            assert result.is_error
            assert result.structured_content["error"]["code"] == "SESSION_REVOKED"
            assert runtime["grant_token"] not in str(result)
    assert runtime["sessions"] == 1
    assert len(runtime["calls"]) == 1


def test_client_reauthenticates_only_explicit_expiry_and_instance_restart(runtime):
    client = WorkshopClient(load_credentials(runtime["credentials"]))
    try:
        runtime["behavior"] = "expire-once"
        client.call("list-projects", ListProjectsInput())
        assert runtime["sessions"] == 2
        assert len(runtime["calls"]) == 2
        runtime["instance_id"] = "instance-two"
        client.call("list-projects", ListProjectsInput())
        assert runtime["sessions"] == 3
        assert len(runtime["calls"]) == 3
    finally:
        client.close()


@pytest.mark.parametrize("code", ["INVALID_PARAMETERS", "INVALID_TARGET", "DOCUMENT_NOT_ALLOWED",
                                 "CONTENT_TOO_LARGE", "SESSION_REQUIRED", "QUEUE_FULL"])
def test_domain_error_codes_remain_actionable_without_forwarding_raw_details(runtime, code):
    runtime.update(behavior="domain-error", domain_error=code)
    client = WorkshopClient(load_credentials(runtime["credentials"]))
    try:
        with pytest.raises(AdapterError) as caught:
            client.call("list-projects", ListProjectsInput())
        assert caught.value.code == code
        assert runtime["grant_token"] not in str(caught.value)
        assert "/private/secret" not in str(caught.value)
        assert len(runtime["calls"]) == 1
    finally:
        client.close()


@pytest.mark.parametrize("behavior,code", [
    ("redirect", "RESPONSE_INVALID"), ("large", "RESPONSE_TOO_LARGE"),
    ("secret", "RESPONSE_INVALID"), ("unknown-error", "WORKSHOP_REQUEST_FAILED"),
    ("disconnect", "LOCAL_SERVICE_UNAVAILABLE"), ("revoked", "SESSION_REVOKED"),
])
def test_transport_bounds_errors_and_does_not_replay_ambiguous_operations(runtime, behavior, code):
    client = WorkshopClient(load_credentials(runtime["credentials"]))
    runtime["behavior"] = behavior
    try:
        with pytest.raises(AdapterError) as caught:
            client.call("prepare-generation", TOOL_INPUT_MODELS["prepare-generation"](
                **tool_payload("prepare-generation"),
            ))
        assert caught.value.code == code
        assert runtime["grant_token"] not in str(caught.value)
        assert runtime["sessions"] == 1
        assert len(runtime["calls"]) == 1
    finally:
        client.close()


@pytest.mark.parametrize("field,value", [("service", "wrong-app"), ("protocol", None),
                                        ("protocol", "atelier-local/2")])
def test_transport_fails_closed_before_grant_exchange_for_wrong_service(runtime, field, value):
    runtime[field] = value
    client = WorkshopClient(load_credentials(runtime["credentials"]))
    try:
        with pytest.raises(AdapterError, match="协议不匹配"):
            client.call("list-projects", ListProjectsInput())
    finally:
        client.close()
    assert runtime["sessions"] == 0
    assert runtime["calls"] == []


def test_transport_bypasses_environment_proxy_and_does_not_offer_generic_route(runtime, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("NO_PROXY", "")
    client = WorkshopClient(load_credentials(runtime["credentials"]))
    try:
        assert client.call("list-projects", ListProjectsInput())["items"]
        with pytest.raises(AdapterError) as caught:
            client.call("../../keys", ListProjectsInput())
        assert caught.value.code == "TOOL_NOT_ALLOWED"
    finally:
        client.close()


@pytest.mark.parametrize("url", [
    "http://localhost:5174", "https://127.0.0.1:5174", "http://127.0.0.1:5174/",
    "http://127.0.0.1:5174@evil.invalid", "http://127.0.0.1:5174?x=1",
    "http://2130706433:5174", "http://127.0.0.1:05174", "http://127.0.0.1:65536",
])
def test_credentials_accept_only_literal_exact_loopback_url(url):
    with pytest.raises(ValidationError):
        Credentials(service="game-atelier", base_url=url, grant_id="test",
                    grant_token="x" * 32, expires_at=expires())


def test_invalid_credential_entrypoint_never_logs_path_or_writes_stdout(tmp_path):
    missing = tmp_path / "private-credential-location.json"
    result = subprocess.run(
        [sys.executable, "-m", "character_workflow.mcp", "--credentials", str(missing)],
        capture_output=True, text=True, encoding="utf-8", timeout=10,
    )
    assert result.returncode == 2
    assert result.stdout == ""
    assert "CREDENTIALS_INVALID" in result.stderr
    assert str(missing) not in result.stderr


@pytest.fixture
def actual_runtime(tmp_path):
    """A real local app, authenticated exactly as the browser, never a TestClient bypass."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    base_url = f"http://127.0.0.1:{listener.getsockname()[1]}"
    app = build_app(dist_dir=tmp_path / "missing-dist")
    server = uvicorn.Server(uvicorn.Config(
        app, loop="asyncio", log_level="critical", access_log=False,
        timeout_graceful_shutdown=1,
    ))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    browser = requests.Session()
    browser.trust_env = False
    browser.headers.update({"Origin": base_url, "Sec-Fetch-Site": "same-origin",
                            "X-Atelier-Client": "mcp-integration-browser"})
    try:
        deadline = time.monotonic() + 10
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.started
        response = browser.post(base_url + "/api/connection/local-session", json={}, timeout=5)
        assert response.status_code == 200, response.text
        lease = browser.post(base_url + "/api/connection/editor-lease",
                             json={"client_id": "mcp-integration-browser"}, timeout=5)
        assert lease.status_code == 200, lease.text
        project_ids = []
        for name in ("MCP授权项目", "MCP未授权项目"):
            created = browser.post(base_url + "/api/projects", json={"name": name}, timeout=5)
            assert created.status_code == 200, created.text
            project_ids.append(next(p["id"] for p in created.json()["projects"] if p["name"] == name))
        grant = browser.post(base_url + "/api/connection/agent-grants", json={
            "name": "SDK业务回归", "project_ids": [project_ids[0]],
            "capabilities": ["read", "edit_documents", "create_targets", "prepare_generation"],
            "days": 1,
        }, timeout=5)
        assert grant.status_code == 201, grant.text
        yield {"credentials": Path(grant.json()["credential_path"]),
               "grant_id": grant.json()["grant_id"], "browser": browser,
               "base_url": base_url, "project_ids": project_ids}
    finally:
        browser.close()
        server.should_exit = True
        thread.join(timeout=5)
        if thread.is_alive():
            server.force_exit = True
            thread.join(timeout=3)
        listener.close()
        assert not thread.is_alive()


async def test_stdio_real_auth_project_scope_document_edit_conflict_and_revoke(
    actual_runtime, tmp_path, isolated_data_root,
):
    runtime = actual_runtime
    async with asyncio.timeout(30):
        async with Client(parameters(runtime, tmp_path), read_timeout_seconds=10) as client:
            result = await client.call_tool("workshop_list_projects", {"payload": {}})
            assert not result.is_error
            assert result.structured_content["projects"] == [
                {"project_id": runtime["project_ids"][0], "name": "MCP授权项目"},
            ]
            project_target = {"type": "project", "project_id": runtime["project_ids"][0]}
            gdd = await client.call_tool("workshop_read_document", {"payload": {
                "target": project_target, "kind": "gdd",
            }})
            assert not gdd.is_error
            saved_gdd = await client.call_tool("workshop_write_document", {"payload": {
                "target": project_target, "kind": "gdd",
                "expected_revision": gdd.structured_content["revision"],
                "content": "# 项目策划\n\n先写需求，不创建占位角色或页面。\n",
                "idempotency_key": "write-real-project-gdd-001",
            }})
            assert not saved_gdd.is_error
            scheme = await client.call_tool("workshop_create_target", {"payload": {
                "project_id": runtime["project_ids"][0], "type": "ui_scheme", "name": "空方案",
                "idempotency_key": "create-real-empty-scheme-001",
            }})
            assert not scheme.is_error
            scheme_target = scheme.structured_content["target"]
            schemes = await client.call_tool("workshop_list_targets", {"payload": {
                "project_id": runtime["project_ids"][0], "type": "ui",
            }})
            assert not schemes.is_error
            assert {entry["target"]["type"] for entry in schemes.structured_content["targets"]} == {
                "ui_scheme",
            }
            assert scheme_target in [entry["target"] for entry in schemes.structured_content["targets"]]
            style = await client.call_tool("workshop_read_document", {"payload": {
                "target": scheme_target, "kind": "ui_style",
            }})
            assert not style.is_error
            saved_style = await client.call_tool("workshop_write_document", {"payload": {
                "target": scheme_target, "kind": "ui_style",
                "expected_revision": style.structured_content["revision"],
                "content": "# UI 规范\n\n暖色、清晰的主次操作。\n",
                "idempotency_key": "write-real-scheme-style-001",
            }})
            assert not saved_style.is_error
            invalid = await client.call_tool("workshop_prepare_generation", {"payload": {
                **tool_payload("prepare-generation"), "target": project_target,
            }})
            assert invalid.is_error
            assert invalid.structured_content["error"]["code"] == "INVALID_TOOL_INPUT"
            created = await client.call_tool("workshop_create_target", {"payload": {
                "project_id": runtime["project_ids"][0], "type": "character", "name": "真实小鸟",
                "idempotency_key": "create-real-bird-001",
            }})
            assert not created.is_error
            target = created.structured_content["target"]
            found = await client.call_tool("workshop_list_targets", {"payload": {
                "project_id": runtime["project_ids"][0], "type": "character",
            }})
            assert not found.is_error
            assert found.structured_content["targets"] == [{"target": target, "name": "真实小鸟"}]
            denied = await client.call_tool("workshop_get_context", {"payload": {
                "target": {**target, "project_id": runtime["project_ids"][1]},
            }})
            assert denied.is_error
            assert denied.structured_content["error"]["code"] == "TARGET_NOT_AUTHORIZED"
            read = await client.call_tool("workshop_read_document", {"payload": {
                "target": target, "kind": "character_spec",
            }})
            assert not read.is_error
            payload = {"target": target, "kind": "character_spec",
                       "expected_revision": read.structured_content["revision"],
                       "content": "# 真实小鸟\n\n暖黄色羽毛，蓝色翅膀。\n",
                       "idempotency_key": "write-real-bird-001"}
            written = await client.call_tool("workshop_write_document", {"payload": payload})
            assert not written.is_error
            spec = isolated_data_root / "characters" / target["character_id"] / "spec.md"
            assert spec.read_text(encoding="utf-8") == payload["content"]
            replayed = await client.call_tool("workshop_write_document", {"payload": payload})
            assert not replayed.is_error
            assert replayed.structured_content == written.structured_content
            conflicted = await client.call_tool("workshop_write_document", {"payload": {
                **payload, "content": "不应覆盖", "idempotency_key": "write-real-bird-002",
            }})
            assert conflicted.is_error
            assert conflicted.structured_content["error"]["code"] == "DOCUMENT_CONFLICT"
            assert spec.read_text(encoding="utf-8") == payload["content"]
            revoked = runtime["browser"].delete(
                runtime["base_url"] + "/api/connection/agent-grants/" + runtime["grant_id"],
                json={}, timeout=5,
            )
            assert revoked.status_code == 204
            denied = await client.call_tool("workshop_read_document", {"payload": {
                "target": target, "kind": "character_spec",
            }})
            assert denied.is_error
            assert denied.structured_content["error"]["code"] == "SESSION_REVOKED"
    assert not (tmp_path / "unused-data").exists()
