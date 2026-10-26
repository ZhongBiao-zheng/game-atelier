"""本机会话代理：路径白名单，凭据只从已保存的 Atelier 渠道读取。"""
import asyncio
from urllib.parse import quote

import requests
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from character_workflow.lib import gateway_audit, keys
from character_workflow.lib.callers import atelier_gateway

router = APIRouter()


@router.get("/api/gateway/audit")
def audit():
    return {"entries": gateway_audit.read()}


ENDPOINTS = [
    ("GET", "/keys"), ("POST", "/keys"), ("PATCH", "/keys/{key_id}"),
    ("POST", "/keys/{key_id}/revoke"), ("GET", "/options"),
    ("GET", "/usage"), ("GET", "/usage/tasks"), ("GET", "/tasks"),
    ("GET", "/live"), ("GET", "/members"),
    ("POST", "/members/{member_alias}/restore"),
    ("GET", "/routes"), ("PUT", "/routes/order"), ("GET", "/audit"),
]


def endpoint(method, template):
    async def proxy(request: Request):
        alias = request.path_params["alias"]
        key = await asyncio.to_thread(keys.find_by_alias, alias)
        if not key or key.provider != "atelier" or not key.enabled or not key.base_url:
            raise HTTPException(404, "中转连接不存在或已停用")
        suffix = template.format(**{name: quote(value, safe="") for name, value in request.path_params.items()})
        body = await request.body()
        if len(body) > 64 * 1024:
            raise HTTPException(413, "管理请求过大")
        # 在线程中建立连接，避免阻塞本机服务的事件循环。
        def connect():
            session = atelier_gateway._session()
            try:
                response = session.request(method, key.base_url.rstrip("/") + "/gateway/v1/admin" + suffix,
                    params=request.query_params, data=body or None,
                    headers={"Authorization": f"Bearer {key.access_key}", "Content-Type": "application/json"},
                    timeout=(3, 10), allow_redirects=False, stream=template == "/live")
                return session, response
            except requests.RequestException:
                session.close()
                raise HTTPException(502, "无法连接中转，请检查网络和中转状态") from None

        session, response = await asyncio.to_thread(connect)
        if template == "/live" and response.status_code == 200:
            def stream():
                try:
                    for line in response.iter_lines(chunk_size=1):
                        yield line + b"\n"
                except requests.RequestException:
                    return
                finally:
                    response.close()
                    session.close()
            return StreamingResponse(stream(), media_type="text/event-stream",
                                     headers={"Cache-Control": "no-cache"})
        try:
            try:
                result = await asyncio.to_thread(response.json)
            except (ValueError, requests.RequestException):
                raise HTTPException(502, "中转返回格式不正确") from None
            if response.status_code >= 300:
                detail = result.get("detail", "中转管理请求失败") if isinstance(result, dict) else "中转管理请求失败"
                # 不回传上游可能包含请求体的 Pydantic 错误结构。
                return JSONResponse({"detail": detail if isinstance(detail, str) else "管理请求参数不合法"},
                                    status_code=response.status_code if response.status_code >= 400 else 502)
            return JSONResponse(result, status_code=response.status_code)
        finally:
            response.close()
            session.close()
    return proxy


for method, path in ENDPOINTS:
    router.add_api_route("/api/gateway/providers/{alias}/admin" + path,
                         endpoint(method, path), methods=[method])
