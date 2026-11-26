"""Node operations and presence, scoped by the local session and the host share token."""
from __future__ import annotations

import asyncio
import json
import math
from http.cookies import CookieError

import httpx
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, WebSocketException
from starlette.websockets import WebSocketState

from character_workflow.lib.collab_ops import CollabOpError
from viewer_server import collab_access, collab_proxy, collab_room
from viewer_server.collab_app import owner_name
from viewer_server.connection_auth import ConnectionError

lan_ws = APIRouter()
local_ws = APIRouter()
MAX_MESSAGE = 2 * 1024 * 1024


def _decode(raw: str):
    if len(raw) > MAX_MESSAGE:
        raise ValueError("协作消息过大")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("协作消息无效")
    return value


async def _frame(ws):
    return _decode(await ws.receive_text())


async def _session_tasks(*awaitables):
    tasks = [asyncio.create_task(fn) for fn in awaitables]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def _presence(data):
    selected = data.get("selected_node_ids", [])
    positions = data.get("positions", {})
    if not isinstance(selected, list) or len(selected) > 1000 or not isinstance(positions, dict) or len(positions) > 1000:
        raise ValueError("选区过大")
    for node_id in [*selected, *positions]:
        if not isinstance(node_id, str) or len(node_id) > 120:
            raise ValueError("选区节点不合法")
    for point in positions.values():
        if not isinstance(point, dict) or set(point) != {"x", "y"} or not all(
            type(v) in (int, float) and math.isfinite(v) and abs(v) <= 1_000_000 for v in point.values()
        ):
            raise ValueError("选区坐标不合法")
    return selected, positions


async def _room_socket(ws, project_id, member, authorize):
    room = collab_room.join(project_id, member)
    try:
        def snapshot():
            authorize(False)
            doc = room.refresh()
            entry = collab_access.share_entry(project_id)
            return doc, entry
        document, entry = await asyncio.to_thread(snapshot)
        await ws.send_json({"type": "hello_snapshot", "document": document, "revision": document["revision"],
                            "client_id": member.client_id, "members": room.list_members(), "mode": entry.mode,
                            "allow_borrow_provider": entry.allow_borrow_provider})

        async def receive():
            while True:
                data = await _frame(ws)
                event_type = data.get("type")
                if event_type == "submit_op":
                    op = data.get("op")
                    try:
                        if not isinstance(op, dict):
                            raise ValueError
                        await asyncio.to_thread(room.apply, op, member, lambda: authorize(True))
                    except (CollabOpError, HTTPException, ConnectionError, ValueError, KeyError) as exc:
                        message = getattr(exc, "detail", None) or getattr(exc, "message", None) or "协作操作无效"
                        member.offer({"type": "op_rejected", "op_id": op.get("op_id") if isinstance(op, dict) else None,
                                      "detail": message})
                elif event_type == "presence_update":
                    await asyncio.to_thread(authorize, False)
                    room.update_presence(member, *_presence(data))
                elif event_type != "ping":
                    raise ValueError("未知协作事件")

        async def send():
            while True:
                event = await member.queue.get()
                if event["type"] != "room_closed":
                    await asyncio.to_thread(authorize, False)
                await ws.send_json(event)
                if event["type"] == "room_closed":
                    return

        async def observe():
            previous = entry.mode, entry.allow_borrow_provider
            while True:
                await asyncio.sleep(.4)
                _, policy = await asyncio.to_thread(snapshot)
                current = policy.mode, policy.allow_borrow_provider
                if current != previous:
                    previous = current
                    member.offer({"type": "room_policy_changed", "mode": policy.mode,
                                  "allow_borrow_provider": policy.allow_borrow_provider})

        await _session_tasks(receive(), send(), observe())
    finally:
        collab_room.release(room, member)


async def _closed(ws, reason):
    try:
        if ws.application_state == WebSocketState.CONNECTED:
            await ws.send_json({"type": "room_closed", "reason": reason})
        await ws.close(code=1008)
    except (RuntimeError, WebSocketDisconnect):
        pass


@lan_ws.websocket("/collab/v1/projects/{project_id}/ws")
async def guest(ws: WebSocket, project_id: str):
    from character_workflow.lib.collab_discovery import is_lan_ip
    if (not ws.client or not is_lan_ip(ws.client.host) or not is_lan_ip(ws.url.hostname or "")
        or "origin" in ws.headers or "cookie" in ws.headers
        or any(key.startswith("sec-fetch-") for key in ws.headers)):
        await ws.close(code=1008)
        return
    def authorize(edit):
        return collab_access.require_guest(ws, project_id, edit=edit)
    try:
        identity = await asyncio.to_thread(authorize, False)
    except HTTPException:
        await ws.close(code=1008)
        return
    await ws.accept()
    member = collab_room.Member(identity.client_id, identity.display_name, False, asyncio.get_running_loop())
    try:
        await _room_socket(ws, project_id, member, authorize)
        await ws.close()
    except (WebSocketDisconnect, ConnectionClosed, asyncio.CancelledError):
        pass
    except (ValueError, KeyError, HTTPException):
        await _closed(ws, "共享已结束或访问权限已变更")


async def _local_auth(ws):
    from viewer_server.connection_middleware import _cookie
    store = ws.app.state.connection_store
    token = _cookie(ws.scope)
    origin = ws.headers.get("origin")
    if not token or not origin:
        raise ValueError
    session = store.authenticate(token, kind="local", origin=origin)
    await ws.accept()
    frame = await asyncio.wait_for(_frame(ws), 5)
    client = frame.get("client_id")
    if frame.get("type") != "auth" or not isinstance(client, str) or not client or len(client) > 128:
        raise ValueError
    ws.state.connection_principal = session.principal
    def check(edit):
        store.authenticate(token, kind="local", origin=origin)
        if edit:
            store.require_editor(session, client)
    return check


@local_ws.websocket("/api/collab/shares/{project_id}/ws")
async def host(ws: WebSocket, project_id: str):
    try:
        check = await _local_auth(ws)
        def authorize(edit):
            check(edit)
            collab_access.share_entry(project_id)
        await asyncio.to_thread(authorize, False)
        member = collab_room.Member("host", owner_name(), True, asyncio.get_running_loop())
        await _room_socket(ws, project_id, member, authorize)
        await ws.close()
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except (ConnectionError, CookieError, ValueError, KeyError, HTTPException, TimeoutError):
        await _closed(ws, "本机会话或共享已结束")


@local_ws.websocket("/api/collab/remote/{peer_key}/projects/{project_id}/ws")
async def proxy(ws: WebSocket, peer_key: str, project_id: str):
    try:
        check = await _local_auth(ws)
        url, token = collab_proxy.ws_credentials(ws, peer_key, project_id)
        async with connect(url, additional_headers={"Authorization": f"Bearer {token}"},
                           proxy=None, compression=None, open_timeout=5, close_timeout=2,
                           max_size=collab_proxy.MAX_DOCUMENT, max_queue=16) as remote:
            async def upstream():
                while True:
                    raw = await ws.receive_text()
                    message = _decode(raw)
                    await asyncio.to_thread(check, message.get("type") == "submit_op")
                    await remote.send(raw)
            async def downstream():
                while True:
                    data = await remote.recv()
                    if not isinstance(data, str):
                        raise ValueError
                    await asyncio.to_thread(check, False)
                    from viewer_server.collab_offline import observe_event
                    await asyncio.to_thread(observe_event, ws, peer_key, project_id, data)
                    await ws.send_text(data)
            async def validate():
                while True:
                    await asyncio.sleep(3)
                    await asyncio.to_thread(check, False)
            await _session_tasks(upstream(), downstream(), validate())
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except (ConnectionError, CookieError, WebSocketException, OSError, ValueError, HTTPException,
            httpx.HTTPError, TimeoutError):
        await _closed(ws, "房主离线或共享访问已变更")
