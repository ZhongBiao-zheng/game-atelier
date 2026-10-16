"""局域网网关服务（ADR-0025）：独立端口、只挂 /gateway/v1/*、必须带网关密钥。

这是 viewer-server「只绑 127.0.0.1」的唯一例外，所以 app 里只有网关接口：没有静态文件、
没有 /api/*、不认 cookie。服务在 viewer-server 进程里另起一个 uvicorn 线程，设置页开关即时启停。
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import threading
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

from character_workflow.lib import gateway_keys, gateway_tasks, model_routes
from character_workflow.lib.gateway_keys import GatewayKeyRecord
from character_workflow.lib.gateway_tasks import GatewayRequestError

PROTOCOL_VERSION = 1
MAX_BODY_BYTES = 200 * 1024 * 1024
CLEANUP_INTERVAL_SECONDS = 3600


class _Unauthorized(Exception):
    pass


def _require_key(request: Request) -> GatewayKeyRecord:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    record = gateway_keys.authenticate(token.strip()) if scheme.lower() == "bearer" else None
    if record is None:
        raise _Unauthorized()
    return record


def _task_view(task: gateway_tasks.GatewayTask) -> dict[str, Any]:
    return {
        "task_id": task.task_id, "status": task.status, "phase": task.phase,
        "member_alias": task.member_alias, "member_provider": task.member_provider,
        "member_model_id": task.member_model_id, "route_tried": task.route_tried,
        "warnings": task.warnings, "actual_size": task.actual_size,
        "actual_cost_cny": task.actual_cost_cny, "outputs": len(task.outputs),
        "error": task.error, "error_kind": task.error_kind,
    }


def _route_view(route: model_routes.ModelRoute) -> dict[str, Any]:
    members = [m for m in route.members if m.provider != gateway_tasks.GATEWAY_PROVIDER]
    return {
        "id": route.id, "name": members[0].name, "modality": route.modality,
        "members": [{
            "alias": m.alias, "provider": m.provider, "base_url": m.base_url,
            "model_id": m.model_id, "name": m.name, "protocol": m.protocol,
        } for m in members],
    }


def _app_version() -> str:
    from viewer_server.connection_status import create_connection_status
    return create_connection_status().app_version


def create_gateway_app() -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(_Unauthorized)
    async def _unauthorized(_request: Request, _error: _Unauthorized) -> JSONResponse:
        return JSONResponse({"detail": "网关密钥无效或已撤销"}, status_code=401)

    @app.exception_handler(GatewayRequestError)
    async def _rejected(_request: Request, error: GatewayRequestError) -> JSONResponse:
        return JSONResponse({"detail": error.message}, status_code=error.status)

    @app.get("/gateway/v1/info")
    def info(_key: GatewayKeyRecord = Depends(_require_key)) -> dict[str, Any]:
        return {"name": gateway_keys.read_config().name or socket.gethostname(),
                "version": _app_version(), "protocol": PROTOCOL_VERSION}

    @app.get("/gateway/v1/models")
    def models(_key: GatewayKeyRecord = Depends(_require_key)) -> dict[str, Any]:
        routes = [route for route in model_routes.list_routes("image")
                  if any(m.provider != gateway_tasks.GATEWAY_PROVIDER for m in route.members)]
        return {"models": [_route_view(route) for route in routes]}

    @app.post("/gateway/v1/tasks", status_code=202)
    async def submit(request: Request, key: GatewayKeyRecord = Depends(_require_key)) -> dict:
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
            raise GatewayRequestError(413, "请求体过大")
        form = await request.form(
            max_files=gateway_tasks.MAX_REFERENCE_IMAGES, max_fields=4,
            max_part_size=1024 * 1024,
        )
        try:
            payload = json.loads(str(form.get("request") or ""))
        except json.JSONDecodeError as error:
            raise GatewayRequestError(422, "request 字段不是合法 JSON") from error
        if not isinstance(payload, dict) or not isinstance(payload.get("params", {}), dict):
            raise GatewayRequestError(422, "request 字段格式不对")
        references: list[tuple[str, bytes]] = []
        for index in range(gateway_tasks.MAX_REFERENCE_IMAGES + 1):
            upload = form.get(f"ref_{index}")
            if upload is None:
                break
            if isinstance(upload, str):
                raise GatewayRequestError(422, f"ref_{index} 必须是文件")
            data = await upload.read(gateway_tasks.MAX_REFERENCE_BYTES + 1)
            references.append((upload.filename or f"ref-{index}.png", data))
        try:
            n = int(payload.get("n") or 1)
        except (TypeError, ValueError) as error:
            raise GatewayRequestError(422, "张数不对") from error
        size = payload.get("size")
        task = await asyncio.to_thread(
            gateway_tasks.submit, key,
            idempotency_key=request.headers.get("idempotency-key", ""),
            model=str(payload.get("model") or ""), prompt=str(payload.get("prompt") or ""),
            n=n, size=str(size) if size is not None else None,
            params=payload.get("params") or {}, references=references,
        )
        return {"task_id": task.task_id}

    @app.get("/gateway/v1/tasks/{task_id}")
    def task_status(task_id: str, key: GatewayKeyRecord = Depends(_require_key)) -> dict:
        return _task_view(gateway_tasks.get_task(key.id, task_id))

    @app.get("/gateway/v1/tasks/{task_id}/outputs/{index}")
    def task_output(task_id: str, index: int,
                    key: GatewayKeyRecord = Depends(_require_key)) -> FileResponse:
        return FileResponse(gateway_tasks.output_file(key.id, task_id, index))

    @app.post("/gateway/v1/tasks/{task_id}/cancel")
    def task_cancel(task_id: str, key: GatewayKeyRecord = Depends(_require_key)) -> dict:
        return _task_view(gateway_tasks.cancel(key.id, task_id))

    return app


_LAN_NETWORKS = tuple(ipaddress.ip_network(net) for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def lan_addresses() -> list[str]:
    """本机在局域网里的 IPv4 地址，只留 10/8、172.16/12、192.168/16。

    路由表的出口不可靠：开着 Clash TUN 时出口是 198.18.0.1 这类虚拟网卡，同事连不上。
    """
    candidates: list[str] = []
    try:
        candidates += [info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)]
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))  # 不发包，只借路由表选出口
            candidates.append(probe.getsockname()[0])
    except OSError:
        pass
    return [address for address in dict.fromkeys(candidates)
            if any(ipaddress.ip_address(address) in network for network in _LAN_NETWORKS)]


class GatewayServer:
    """在 viewer-server 进程里另起一个 uvicorn；开关即时生效，不需要重启主服务。"""

    def __init__(self, host: str = "0.0.0.0") -> None:
        self.host = host
        self._lock = threading.Lock()
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None
        self._cleanup_stop = threading.Event()
        self.port: int | None = None
        self.error: str | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self, port: int) -> None:
        with self._lock:
            if self.running and self.port == port:
                return
            self._stop_locked()
            self.error = None
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                    probe.bind((self.host, port))
            except OSError:
                self.error = f"端口 {port} 已被占用"
                return
            gateway_tasks.recover_after_restart()
            gateway_tasks.cleanup()
            config = uvicorn.Config(
                create_gateway_app(), host=self.host, port=port, log_level="warning",
                access_log=False, lifespan="off", ws="none",
            )
            server = uvicorn.Server(config)
            # 主线程以外不能装信号处理器；关闭由 should_exit 控制。
            server.install_signal_handlers = lambda: None  # type: ignore[method-assign]
            thread = threading.Thread(target=server.run, daemon=True, name="lan-gateway")
            thread.start()
            self._server, self._thread, self.port = server, thread, port
            self._cleanup_stop = threading.Event()
            threading.Thread(target=self._cleanup_loop, args=(self._cleanup_stop,),
                             daemon=True, name="lan-gateway-cleanup").start()

    def stop(self) -> None:
        with self._lock:
            self._stop_locked()

    def _stop_locked(self) -> None:
        self._cleanup_stop.set()
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout=10)
        self._server, self._thread, self.port = None, None, None

    @staticmethod
    def _cleanup_loop(stop: threading.Event) -> None:
        while not stop.wait(CLEANUP_INTERVAL_SECONDS):
            gateway_tasks.cleanup()

    def apply(self, config: gateway_keys.GatewayConfig) -> None:
        if config.enabled:
            self.start(config.port)
        else:
            self.stop()

    def status(self) -> dict[str, Any]:
        return {"running": self.running, "port": self.port, "error": self.error,
                "addresses": lan_addresses() if self.running else []}


gateway_server = GatewayServer()
