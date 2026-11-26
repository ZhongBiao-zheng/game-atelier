"""Authenticated loopback-to-peer proxy. No local cookies, redirects, DNS or inherited proxies."""
from __future__ import annotations

import json
import re
import threading
from collections import OrderedDict
from contextlib import contextmanager
from urllib.parse import quote

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from character_workflow.lib import data_root
from character_workflow.lib.collab_discovery import discovery, lan_endpoint

_tokens: OrderedDict[tuple[str, str, str, str], tuple[str, int]] = OrderedDict()
_lock = threading.Lock()
MAX_DOCUMENT = 64 * 1024 * 1024
_MEDIA_MIMES = frozenset({
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
    "video/mp4", "video/quicktime", "video/webm", "audio/wav", "audio/mpeg",
    "audio/ogg", "audio/mp4", "audio/flac", "audio/webm", "audio/x-wav", "audio/aac",
})


def clear_tokens():
    with _lock:
        _tokens.clear()
    from viewer_server.collab_offline import reset
    reset()


def _key(request, peer_key, project_id):
    return str(data_root.resolve_data_root()), request.state.connection_principal.session_id, peer_key, project_id


def has_token(request, peer_key, project_id, *, access_epoch=None):
    with _lock:
        entry = _tokens.get(_key(request, peer_key, project_id))
        return bool(entry and (access_epoch is None or entry[1] == access_epoch))


def _component(value: str) -> str:
    if not value or value in {".", ".."} or any(c in value for c in "/\\%?#") or len(value) > 160:
        raise HTTPException(422, "共享对象编号无效")
    return quote(value, safe="")


def _base(peer_key: str, project_id: str) -> str:
    try:
        peer = discovery.get(peer_key)
        address = lan_endpoint(peer.address)
    except KeyError:
        raise HTTPException(503, "房主已离线") from None
    except ValueError:
        raise HTTPException(409, "共享主机地址或协议不兼容") from None
    if not any(row.project_id == project_id for row in peer.manifest.shares):
        raise HTTPException(404, "这张画布未共享")
    return f"http://{address}/collab/v1/projects/{_component(project_id)}"


@contextmanager
def _upstream(request, peer_key, project_id, suffix, method="GET", *, anonymous=False,
              range_value=None, **kwargs):
    url = _base(peer_key, project_id) + "/" + suffix
    headers = {"Accept-Encoding": "identity"}
    if not anonymous:
        with _lock:
            entry = _tokens.get(_key(request, peer_key, project_id))
        if not entry:
            raise HTTPException(403, "请先进入共享画布")
        headers["Authorization"] = f"Bearer {entry[0]}"
    if range_value:
        if not re.fullmatch(r"bytes=(?:[0-9]+-[0-9]*|-[0-9]+)", range_value):
            raise HTTPException(416, "媒体读取范围无效")
        headers["Range"] = range_value
    try:
        with httpx.Client(trust_env=False, follow_redirects=False, timeout=httpx.Timeout(30, connect=5)) as client:
            with client.stream(method, url, headers=headers, **kwargs) as response:
                if response.status_code not in {200, 201, 202, 204, 206}:
                    status = response.status_code
                    if status in {401, 404} and suffix == "document":
                        from viewer_server.collab_offline import forget
                        forget(request, peer_key, project_id)
                    if status == 401:
                        with _lock:
                            _tokens.pop(_key(request, peer_key, project_id), None)
                    if status == 422 and suffix == "runs/borrowed":
                        detail = _borrowed_operation_error(response)
                        if detail:
                            raise HTTPException(422, detail)
                    detail = {401: "请重新输入访问口令", 403: "共享画布拒绝了这项操作",
                              404: "画布或媒体已下线", 409: "画布已更新，请刷新",
                              413: "共享内容过大", 416: "媒体读取范围无效", 422: "共享请求格式有误"}
                    raise HTTPException(403 if status == 401 else status if status in detail else 502, detail.get(status, "共享主机响应异常"))
                if response.headers.get("content-encoding", "identity") != "identity":
                    raise HTTPException(502, "共享主机返回了无效编码")
                yield response
    except httpx.HTTPError:
        raise HTTPException(503, "无法连接共享主机") from None


def _chunks(response, limit):
    length = response.headers.get("content-length")
    if length and (not length.isascii() or not length.isdigit() or len(length) > 16 or int(length) > limit):
        raise HTTPException(413, "共享内容过大")
    size = 0
    for chunk in response.iter_raw(65536):
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, "共享内容过大")
        yield chunk


def _borrowed_operation_error(response) -> dict | None:
    from character_workflow.lib.collab_borrow import OPERATION_ERRORS

    try:
        payload = json.loads(b"".join(_chunks(response, 8192)))
    except (UnicodeError, ValueError, HTTPException):
        return None
    detail = payload.get("detail") if isinstance(payload, dict) else None
    if isinstance(detail, dict):
        for code, message in OPERATION_ERRORS.values():
            if detail.get("code") == code:
                return {"code": code, "message": message}
    return None


def remote_json(request: Request, peer_key: str, project_id: str, suffix: str,
                *, method="GET", **kwargs):
    try:
        return _read_json(request, peer_key, project_id, suffix, method, kwargs)
    except HTTPException as error:
        if method != "GET" or suffix != "document" or error.status_code != 403:
            raise
        from viewer_server.collab_offline import renew
        if not renew(request, peer_key, project_id):
            raise
        return _read_json(request, peer_key, project_id, suffix, method, kwargs)


def _read_json(request, peer_key, project_id, suffix, method, kwargs):
    with _upstream(request, peer_key, project_id, suffix, method,
                   anonymous=suffix == "auth", **kwargs) as response:
        try:
            value = json.loads(b"".join(_chunks(response, MAX_DOCUMENT)))
        except (ValueError, UnicodeError):
            raise HTTPException(502, "共享主机返回了无效内容") from None
        if not isinstance(value, dict):
            raise HTTPException(502, "共享主机返回了无效内容")
        if suffix == "document":
            from viewer_server.collab_offline import remember, schedule
            try:
                remember(request, peer_key, project_id, value["document"])
            except (ValueError, KeyError):
                raise HTTPException(502, "房主返回的画布文档无效") from None
            schedule(request, peer_key, project_id)
        return value


def authenticate_remote(request, peer_key, project_id, display_name, passcode, *, resume_proof=None):
    from character_workflow.lib.collab_config import identity_hash
    try:
        peer = discovery.get(peer_key)
    except (KeyError, ValueError):
        raise HTTPException(503, "共享主机不可用") from None
    proof = identity_hash(f"proof/{peer.manifest.host_id}/{project_id}")
    result = remote_json(request, peer_key, project_id, "auth", method="POST",
                         json={"display_name": display_name, "passcode": passcode, "client_proof": proof,
                               "resume_proof": resume_proof})
    token = result.get("collab_token")
    client_id = result.get("client_id")
    if (not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", token)
            or not isinstance(client_id, str) or type(result.get("access_epoch")) is not int
            or not isinstance(result.get("resume_proof"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", result["resume_proof"])):
        raise HTTPException(502, "共享主机返回了无效会话")
    key = _key(request, peer_key, project_id)
    with _lock:
        _tokens[key] = (token, result["access_epoch"])
        _tokens.move_to_end(key)
        if len(_tokens) > 4096:
            _tokens.popitem(last=False)
    from viewer_server.collab_offline import register_grant
    register_grant(request, peer_key, project_id, display_name, result["resume_proof"])
    return {"client_id": client_id, "display_name": display_name}


def ws_credentials(request, peer_key, project_id):
    url = _base(peer_key, project_id)
    with _lock:
        entry = _tokens.get(_key(request, peer_key, project_id))
    if not entry:
        raise HTTPException(403, "请先进入共享画布")
    return url.replace("http://", "ws://", 1) + "/ws", entry[0]


def remote_bytes(request, peer_key, project_id, version_id, *, max_bytes: int) -> bytes:
    suffix = f"versions/{_component(version_id)}/media"
    with _upstream(request, peer_key, project_id, suffix) as response:
        return b"".join(_chunks(response, max_bytes))


def stream_media(request, peer_key, project_id, version_id=None, *, thumb=False):
    suffix = f"versions/{_component(version_id)}/media" if version_id is not None else "cover"
    stream = _upstream(request, peer_key, project_id, suffix, anonymous=version_id is None,
                       range_value=request.headers.get("range"), params={"thumb": int(thumb)})
    response = stream.__enter__()
    try:
        mime = response.headers.get("content-type", "").partition(";")[0].lower()
        if mime not in _MEDIA_MIMES:
            raise HTTPException(502, "共享媒体类型不受支持")
        headers = {key: response.headers[key] for key in ("content-length", "content-range", "accept-ranges")
                   if key in response.headers}
        headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                        "Content-Security-Policy": "sandbox; default-src 'none'"})
        chunks = _chunks(response, 512 * 1024 * 1024)
        if version_id is not None and response.status_code == 200:
            from viewer_server.collab_offline import cache_stream
            chunks = cache_stream(request, peer_key, project_id, version_id, chunks, thumbnail=thumb, mime=mime)
        return StreamingResponse(chunks, media_type=mime, headers=headers,
                                 status_code=response.status_code,
                                 background=BackgroundTask(stream.__exit__, None, None, None))
    except BaseException:
        stream.__exit__(None, None, None)
        raise
