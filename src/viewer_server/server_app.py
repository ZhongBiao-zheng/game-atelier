"""FastAPI app factory — REST routes + SSE + filesystem watchers."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from character_workflow.lib import host_lifecycle
from character_workflow.lib.jobs import fail_orphan_studio_jobs, read_job, resumable_studio_jobs
from character_workflow.lib.secret_filter import SecretRedactionFilter
from viewer_server.connection_status import (
    STATUS_PATH, LocalConnectionStatus, create_connection_status,
)
from viewer_server.connection_auth import ConnectionError, ConnectionStore
from viewer_server.connection_middleware import ConnectionMiddleware, connection_error
from viewer_server.connection_routes import connection_router
from viewer_server.gateway_app import gateway_server
from viewer_server.collab_app import start_collab, stop_collab
from viewer_server.gateway_routes import gateway_router
from viewer_server.model_route_status import member_status_router
from viewer_server.usage_routes import usage_router
from viewer_server.routes import router
from viewer_server.request_boundary import LocalRequestBoundary, development_origin
from viewer_server.sse import hub, sse_router
from viewer_server.team_library_routes import team_library_router
from viewer_server.watcher import start_watchers, stop_watchers


_CANVAS_DOCUMENT_MAX_BYTES = 25 * 1024 * 1024


class CanvasDocumentBodyLimitMiddleware:
    """Reject oversized canvas PUT bodies before JSON/Pydantic parsing allocates them."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not _is_canvas_document_put(scope):
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers", []))
        raw_length = headers.get(b"content-length")
        if raw_length is not None:
            try:
                if int(raw_length) > _CANVAS_DOCUMENT_MAX_BYTES:
                    await _canvas_body_too_large(scope, receive, send)
                    return
            except ValueError:
                pass
        buffered: list[Message] = []
        total = 0
        while True:
            message = await receive()
            buffered.append(message)
            if message["type"] != "http.request":
                break
            total += len(message.get("body", b""))
            if total > _CANVAS_DOCUMENT_MAX_BYTES:
                await _canvas_body_too_large(scope, receive, send)
                return
            if not message.get("more_body", False):
                break
        index = 0

        async def replay_receive() -> Message:
            nonlocal index
            if index < len(buffered):
                message = buffered[index]
                index += 1
                return message
            return {"type": "http.disconnect"}

        await self.app(scope, replay_receive, send)


def _is_canvas_document_put(scope: Scope) -> bool:
    path = str(scope.get("path", ""))
    return (
        scope.get("type") == "http"
        and scope.get("method") == "PUT"
        and path.startswith("/api/canvas/projects/")
        and path.endswith("/document")
    )


async def _canvas_body_too_large(scope: Scope, receive: Receive, send: Send) -> None:
    response = JSONResponse({"detail": "画布文档请求体不能超过 25 MiB"}, status_code=413)
    await response(scope, receive, send)


def _install_secret_filter() -> None:
    flt = SecretRedactionFilter()
    for name in ("", "uvicorn", "uvicorn.access", "uvicorn.error"):
        logger = logging.getLogger(name)
        for handler in logger.handlers:
            handler.addFilter(flt)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from viewer_server import bundle_update
    from viewer_server.update_routes import read_json

    service = app.state.update_controller
    booting_update = os.environ.get("GAME_ATELIER_UPDATE_ID")
    service.gate.initializing = bool(booting_update)

    @asynccontextmanager
    async def initialize():
        async with normal_lifespan(app):
            service.gate.initializing = False
            yield

    # A candidate serves only connection/update status until the executor confirms it.
    # Existing migration/recovery routines must not run against user data before that point.
    async def candidate_lifecycle():
        nonlocal checker
        from character_workflow.lib.atomic_io import atomic_write_text
        runtime = service.gate.runtime
        # The executor first verifies the read-only listener, then permits initialization.
        # last-good is committed only after the full lifespan has entered successfully.
        while not (runtime / f"update-activate-{booting_update}").exists():
            await asyncio.sleep(0.1)
        try:
            async with normal_lifespan(app):
                atomic_write_text(runtime / f"update-ready-{booting_update}",
                                  app.state.connection_status.instance_id)
                while True:
                    result = read_json(runtime / "update-result.json")
                    if result.get("update_id") == booting_update:
                        if result.get("status") != "succeeded":
                            return
                        break
                    await asyncio.sleep(0.1)
                service.gate.initializing = False
                checker = asyncio.create_task(service.auto_check())
                await asyncio.Event().wait()
        except Exception:
            logging.getLogger(__name__).exception("candidate initialization failed")
            atomic_write_text(runtime / f"update-start-failed-{booting_update}", "初始化失败")

    checker = None
    candidate = None
    try:
        if booting_update:
            bundle_update.report_started(app.state.connection_status.instance_id)
            candidate = asyncio.create_task(candidate_lifecycle())
            yield
        else:
            if service.root:
                await asyncio.to_thread(bundle_update.recover_pending, service.root, service.gate.runtime)
            async with initialize():
                if service.downloader:
                    checker = asyncio.create_task(service.auto_check())
                yield
    finally:
        for task in (checker, candidate):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        await service.close()


async def _repeat_forever(interval_seconds: float, work, label: str) -> None:
    """每隔 interval 在线程池里跑一次 work；一轮抛错只记日志，循环继续（否则一次失败就永久停掉）。"""
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            await asyncio.to_thread(work)
        except Exception:  # noqa: BLE001
            logging.getLogger(__name__).exception("%s失败", label)


async def _record_host_lifecycle(app: FastAPI) -> None:
    """记一条主机启动，然后每 5 分钟刷新心跳；记录失败只告警，不挡服务。"""
    from viewer_server.connection_status import app_version

    log = logging.getLogger(__name__)
    try:
        row = await asyncio.to_thread(
            host_lifecycle.record_start, version=app_version(),
            service_mode=os.environ.get("GAME_ATELIER_SERVICE") == "1", pid=os.getpid(),
            instance_id=app.state.connection_status.instance_id,
        )
        log.info("主机启动 版本=%s 服务模式=%s 上次=%s", row["version"], row["service_mode"],
                 row["previous"])
    except Exception:  # noqa: BLE001 —— 启停记录失败不挡服务，也不能让心跳循环起不来
        log.exception("host lifecycle start not recorded")
    while True:
        await asyncio.sleep(host_lifecycle.HEARTBEAT_SECONDS)
        try:
            await asyncio.to_thread(host_lifecycle.heartbeat)
        except Exception:  # noqa: BLE001 —— 单次失败继续下一次心跳
            log.exception("host lifecycle heartbeat failed")


def _refresh_agent_clients(app: FastAPI) -> None:
    """开关打开时把各客户端配置里我们那一条改写成本次启动的解释器：更新后旧版本目录会被删掉。"""
    import sys

    from viewer_server.agent_clients import refresh_all
    try:
        if app.state.connection_store.agent_status()["enabled"]:
            for client in refresh_all(sys.executable):
                logging.getLogger(__name__).info("%s mcp entry now points at %s", client, sys.executable)
    except (ConnectionError, OSError) as error:
        # 只影响外部客户端里的 Atelier 工具；不能因此挡住服务启动。
        logging.getLogger(__name__).warning("agent client entries not refreshed: %s", error)


@asynccontextmanager
async def normal_lifespan(app: FastAPI):
    hub.set_loop(asyncio.get_running_loop())
    from character_workflow.lib import data_root
    try:
        app.state.shell_control.issue(data_root.runtime_dir(), app.state.connection_status.instance_id)
    except OSError as error:
        # 只影响桌面外壳退出前的确认；不能因此挡住服务启动。
        logging.getLogger(__name__).warning("desktop shell control token unavailable: %s", error)
    _refresh_agent_clients(app)
    from character_workflow.lib import gateway_live
    def gateway_listener(snapshot):
        hub.broadcast("gateway_task", snapshot)
    gateway_live.listeners.append(gateway_listener)
    from viewer_server.routes import _reset_studio_recovery_workers
    from viewer_server.studio_agent_routes import recover_abandoned_turns

    _reset_studio_recovery_workers()
    await recover_abandoned_turns()
    from character_workflow.lib.creation_assets_migration import (
        migrate_creation_assets_to_v4,
        migrate_creation_assets_to_single_content,
    )

    asset_migration = migrate_creation_assets_to_single_content()
    if asset_migration:
        logging.getLogger(__name__).info(
            "migrated creation assets to single content; backup: %s",
            asset_migration["backup_path"],
        )
    media_migration = migrate_creation_assets_to_v4()
    if media_migration:
        logging.getLogger(__name__).info(
            "migrated creation asset catalog to v4; backup: %s",
            media_migration["backup_path"],
        )
    # 孤儿回收：studio job 只在本进程跑，重启时还 pending 的必然已死（一键启动脚本
    # 每次双击都是 stop→start）。不回收 = Web 永久转圈 + 永久轮询。
    resumable_studio = resumable_studio_jobs()
    reclaimed = fail_orphan_studio_jobs()
    if reclaimed:
        logging.getLogger(__name__).warning(
            "reclaimed %d orphan studio job(s): %s", len(reclaimed), ", ".join(reclaimed)
        )
    from character_workflow.lib.canvas_projects import list_canvas_projects
    from character_workflow.lib.canvas_packages import maintain_canvas_package_lifecycle
    from character_workflow.lib.canvas_runs import (
        reconcile_canvas_jobs,
        recover_canvas_transactions,
    )
    from character_workflow.lib import canvas_run_queue

    maintain_canvas_package_lifecycle()
    from character_workflow.lib.trash import purge_expired

    # 回收站保留 30 天：启动时清一次过期条目；失败只记日志，不挡服务启动。
    try:
        purged = purge_expired()
        if purged:
            logging.getLogger(__name__).info("purged %d expired trash entries", purged)
    except OSError as error:
        logging.getLogger(__name__).warning("trash cleanup failed: %s", error)
    canvas_projects = list_canvas_projects()
    from character_workflow.lib.canvas_group_runs import recover_group_runs
    for project in canvas_projects:
        recover_canvas_transactions(project.project_id)

    reconciled = reconcile_canvas_jobs(fail_pending=True)
    from character_workflow.lib.canvas_image_edits import has_resumable_mj_task
    from character_workflow.lib.jobs import (
        has_resumable_comfyui_task, has_resumable_gateway_task, has_resumable_music_task,
    )
    resumable = [
        job_id for job_id in reconciled
        if (
            (job := read_job(job_id)).status.value in {"pending", "pending_confirm"}
            and (job.runner_started_at is None or has_resumable_mj_task(job)
                 or has_resumable_gateway_task(job) or has_resumable_music_task(job)
                 or has_resumable_comfyui_task(job))
        )
    ]
    for project in canvas_projects:
        recover_group_runs(project.project_id, set(resumable))
    from character_workflow.lib.collab_guest_runs import recover_staged_results
    recover_staged_results()
    if reconciled:
        logging.getLogger(__name__).warning(
            "reconciled %d canvas job(s): %s", len(reconciled), ", ".join(reconciled)
        )
    start_watchers()
    # 局域网共享（ADR-0025）：默认关闭；开着的话随主服务一起起来。配置损坏时网关停在错误状态。
    await asyncio.to_thread(gateway_server.apply_saved)
    await asyncio.to_thread(start_collab)
    heartbeat_task = asyncio.create_task(_record_host_lifecycle(app))
    from viewer_server import loop_watch

    # 主服务事件循环卡住 30 秒就把所有线程的栈写进 server.log（常驻看护约 2 分钟才结束进程，栈先落盘）。
    loop_watch_task = loop_watch.start("主服务")
    # 接入端：网关供应商的模型列表随网关变化，启动时尽力同步一次（连不上就保留旧快照）。
    from character_workflow.lib.callers.atelier_gateway import sync_all_gateway_keys

    gateway_sync = asyncio.create_task(asyncio.to_thread(sync_all_gateway_keys))
    from character_workflow.lib.gateway_share_publisher import run_periodic
    share_sync = asyncio.create_task(run_periodic())
    resume_tasks: set[asyncio.Task[None]] = set()

    maintenance_task = asyncio.create_task(
        _repeat_forever(6 * 60 * 60, maintain_canvas_package_lifecycle, "画布包定期维护"))

    async def resume_canvas_job(job_id: str) -> None:
        try:
            await asyncio.wrap_future(await asyncio.to_thread(canvas_run_queue.submit, job_id))
        except Exception:  # noqa: BLE001
            logging.getLogger(__name__).warning("resumed canvas run failed: %s", job_id)

    async def resume_studio_job(job_id: str) -> None:
        from viewer_server.routes import _run_studio_job_safely

        await _run_studio_job_safely(job_id)

    for job_id in resumable_studio:
        task = asyncio.create_task(resume_studio_job(job_id))
        resume_tasks.add(task)
        task.add_done_callback(resume_tasks.discard)

    for job_id in resumable:
        task = asyncio.create_task(resume_canvas_job(job_id))
        resume_tasks.add(task)
        task.add_done_callback(resume_tasks.discard)
    from character_workflow.lib.tokendance_prices import start_background_sync
    from character_workflow.lib.tuzi_prices import start_background_sync as start_tuzi_sync
    from character_workflow.lib.openai_hk_prices import start_background_sync as start_hk_sync

    from character_workflow.lib.announcement_feed import (
        start_background_sync as start_announcement_sync,
    )

    start_background_sync()
    start_tuzi_sync()
    start_hk_sync()
    start_announcement_sync()
    from character_workflow.lib import gateway_cancel_outbox

    if gateway_cancel_outbox.pending_job_ids():
        gateway_cancel_outbox.wake()  # 上次没送到主机的停止请求，启动后补发
    try:
        yield
    finally:
        from viewer_server.routes import _stop_studio_recovery_workers

        gateway_cancel_outbox.stop()

        heartbeat_task.cancel()
        loop_watch_task.cancel()
        try:
            host_lifecycle.record_stop(reason="normal", pid=os.getpid(), source="server")
        except OSError as error:
            logging.getLogger(__name__).warning("host lifecycle stop not recorded: %s", error)
        _stop_studio_recovery_workers()
        maintenance_task.cancel()
        for task in resume_tasks:
            task.cancel()
        gateway_live.listeners.remove(gateway_listener)
        gateway_sync.cancel()
        share_sync.cancel()
        await asyncio.gather(share_sync, return_exceptions=True)
        await asyncio.to_thread(stop_collab)
        await asyncio.to_thread(gateway_server.stop)
        # 换过数据目录后监听已不是启动时那个 observer：停当前的。
        stop_watchers()


# 发布产物用固定文件名（去哈希，见 web/vite.config.ts），所以必须显式要求浏览器每次验证。
# 缺了 Cache-Control 时浏览器按 RFC 9111 的启发式新鲜期缓存，约 (now - last-modified) 的 10%：
# dist 构建于一周前 → 约 17 小时内一个请求都不发，画师 git pull 完打开还是旧 UI（2026-08-27
# Windows 实测：更新到 5.31.1 后顶栏仍显示 5.30.3、没有画布，只有 Ctrl+F5 能穿透）。
# no-cache 不是禁用缓存，是「用之前必须条件请求」；etag 命中照样回 304，本机往返可忽略。
_STATIC_CACHE_CONTROL = "no-cache"


class RevalidatedStaticFiles(StaticFiles):
    """固定文件名的发布产物：可以缓存，但每次使用前必须回服务端验证。"""

    def file_response(self, *args, **kwargs) -> Response:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = _STATIC_CACHE_CONTROL
        return response


# 宿主页面不允许任何子框架发起网络加载。插件界面是 srcdoc 沙箱帧（不走网络，不受影响）；
# 没有任何 CSP 指令能阻止沙箱帧把自己导航走，只有父页面的 frame-src 能拦住那次加载，
# 否则恶意插件可以把读到的数据拼进地址带出去（ADR-0037，B2 安全验收 S2）。
HOST_PAGE_CSP = "frame-src 'none'"


def _revalidated_file(path: Path) -> FileResponse:
    headers = {"Cache-Control": _STATIC_CACHE_CONTROL}
    if path.suffix == ".html":
        headers["Content-Security-Policy"] = HOST_PAGE_CSP
    return FileResponse(path, headers=headers)


def build_app(dist_dir: Path | None = None, *, instance_id: str | None = None) -> FastAPI:
    _install_secret_filter()
    app = FastAPI(title="Cobrush viewer-server", lifespan=lifespan)
    connection_status = create_connection_status(instance_id)
    connection_store = ConnectionStore(connection_status.instance_id)
    app.state.connection_store = connection_store
    app.state.connection_status = connection_status
    from viewer_server.update_routes import UpdateController, UpdateAdmissionMiddleware, router as update_router
    app.state.update_controller = UpdateController(connection_status.instance_id)
    from viewer_server.shell_control import ShellControl, router as shell_router
    app.state.shell_control = ShellControl()

    @app.exception_handler(ConnectionError)
    async def handle_connection_error(_request, error: ConnectionError) -> JSONResponse:
        return connection_error(error)

    from character_workflow.lib.gateway_keys import GatewayConfigCorruptError, GatewayConfigTooLargeError

    @app.exception_handler(GatewayConfigTooLargeError)
    async def handle_gateway_config_too_large(_request, error: GatewayConfigTooLargeError) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=413)

    @app.exception_handler(GatewayConfigCorruptError)
    async def handle_gateway_config_corrupt(_request, error: GatewayConfigCorruptError) -> JSONResponse:
        # 服务端数据坏了：500，不是让用户刷新重试的 409。
        return JSONResponse({"detail": str(error)}, status_code=500)

    @app.get(STATUS_PATH, response_model=LocalConnectionStatus)
    async def get_connection_status(response: Response) -> LocalConnectionStatus:
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return connection_status

    app.add_middleware(CanvasDocumentBodyLimitMiddleware)
    app.add_middleware(UpdateAdmissionMiddleware)
    app.add_middleware(
        ConnectionMiddleware, store=connection_store, dev_origin=development_origin(),
        shell_control=app.state.shell_control,
    )
    # Added last so untrusted requests are rejected before buffering document/upload bodies.
    app.add_middleware(
        LocalRequestBoundary, dev_origin=development_origin(),
    )
    from viewer_server.collab_routes import router as collab_router
    from viewer_server.collab_transfer_routes import collab_transfer_local_router
    from viewer_server.collab_ws import local_ws
    from viewer_server.collab_uploads import local_uploads
    app.include_router(local_ws)
    app.include_router(local_uploads)
    app.include_router(collab_router)
    from viewer_server.collab_borrow_routes import local_router as borrow_router
    app.include_router(borrow_router)
    from viewer_server.collab_guest_run_routes import collab_guest_local_router
    app.include_router(collab_guest_local_router)
    app.include_router(collab_transfer_local_router)
    from viewer_server.history_routes import router as history_router
    app.include_router(history_router)
    app.include_router(router)
    from viewer_server.canvas_group_routes import router as group_router
    app.include_router(group_router)
    from viewer_server.comfyui_routes import router as comfyui_router
    app.include_router(comfyui_router)
    from viewer_server.http_protocol_routes import router as http_protocol_router
    app.include_router(http_protocol_router)
    from viewer_server.trash_routes import router as trash_router
    app.include_router(trash_router)
    from viewer_server.plugin_routes import grants_router as plugin_grants_router, router as plugin_router
    app.include_router(plugin_router)
    app.include_router(plugin_grants_router)
    app.include_router(update_router)
    app.include_router(shell_router)
    from viewer_server.diagnostics import router as diagnostics_router
    app.include_router(diagnostics_router)
    app.include_router(connection_router(connection_store))
    app.include_router(team_library_router)
    from viewer_server.gateway_library_proxy import router as gateway_library_router
    app.include_router(gateway_library_router)
    from viewer_server.gateway_shares import install_errors
    install_errors(app)
    app.include_router(gateway_router)
    from viewer_server.gateway_admin_proxy import router as gateway_admin_proxy
    app.include_router(gateway_admin_proxy)
    app.include_router(member_status_router)
    app.include_router(usage_router)
    from viewer_server.provider_icon_routes import provider_icon_router
    app.include_router(provider_icon_router)
    app.include_router(sse_router)

    from viewer_server.canvas_agent_routes import handle_canvas_tool_error
    from character_workflow.lib.canvas_tool_common import CanvasToolError
    app.add_exception_handler(CanvasToolError, handle_canvas_tool_error)
    from viewer_server.canvas_agent_routes import register_canvas_agent_routes

    register_canvas_agent_routes(app)
    from viewer_server.canvas_chat_routes import register_canvas_chat_routes

    register_canvas_chat_routes(app)
    from viewer_server.studio_agent_routes import router as studio_agent_router
    app.include_router(studio_agent_router)

    if dist_dir is None:
        dist_dir = Path(__file__).resolve().parents[2] / "web" / "dist"

    if dist_dir.exists():
        assets_dir = dist_dir / "assets"
        if assets_dir.exists():
            app.mount("/assets", RevalidatedStaticFiles(directory=assets_dir), name="assets")

        @app.get("/{path:path}")
        async def spa_fallback(path: str):
            if path.startswith("api/"):
                raise HTTPException(status_code=404)
            file = dist_dir / path
            # Containment check: prevent path traversal via absolute paths
            # (e.g. URL-encoded /%2Fetc%2Fpasswd) or `..` segments.
            try:
                file.resolve().relative_to(dist_dir.resolve())
            except ValueError:
                return _revalidated_file(dist_dir / "index.html")
            if path and file.is_file():
                return _revalidated_file(file)
            return _revalidated_file(dist_dir / "index.html")
    else:
        # 前端未构建：给出可读提示页，而不是裸 404（用户开窗只会看到一行报错）。
        @app.get("/{path:path}")
        async def missing_dist(path: str):
            if path.startswith("api/"):
                raise HTTPException(status_code=404)
            return HTMLResponse(
                "<h1>Web UI 未构建</h1>"
                "<p>未找到 <code>web/dist</code>。开发模式请运行 "
                "<code>make build</code>；插件用户请重装插件（安装包应自带预构建 UI）。</p>",
                status_code=503,
            )

    return app
