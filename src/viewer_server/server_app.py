"""FastAPI app factory — REST routes + SSE + filesystem watchers."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from character_workflow.lib.jobs import fail_orphan_studio_jobs, read_job, resumable_studio_jobs
from character_workflow.lib.secret_filter import SecretRedactionFilter
from viewer_server.routes import router
from viewer_server.sse import hub, sse_router
from viewer_server.watcher import start_watchers


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
    hub.set_loop(asyncio.get_running_loop())
    from viewer_server.routes import _reset_studio_recovery_workers

    _reset_studio_recovery_workers()
    # 插件升级入口：旧项目只在 server 启动阶段一次性改成 V1；正常 GET/Skill 读路径不做迁移。
    from character_workflow.lib.ui_schemes import migrate_legacy_projects

    migrated = migrate_legacy_projects()
    if migrated:
        logging.getLogger(__name__).info(
            "migrated %d project(s) to UI schemes: %s", len(migrated), ", ".join(migrated)
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
        run_canvas_job_scheduled,
    )

    maintain_canvas_package_lifecycle()
    canvas_projects = list_canvas_projects()
    for project in canvas_projects:
        recover_canvas_transactions(project.project_id)

    reconciled = reconcile_canvas_jobs(fail_pending=True)
    resumable = [
        job_id for job_id in reconciled
        if (
            (job := read_job(job_id)).status.value in {"pending", "pending_confirm"}
            and job.runner_started_at is None
        )
    ]
    if reconciled:
        logging.getLogger(__name__).warning(
            "reconciled %d canvas job(s): %s", len(reconciled), ", ".join(reconciled)
        )
    observer = start_watchers()
    resume_tasks: set[asyncio.Task[None]] = set()

    async def maintain_canvas_lifecycle() -> None:
        while True:
            await asyncio.sleep(6 * 60 * 60)
            await asyncio.to_thread(maintain_canvas_package_lifecycle)

    maintenance_task = asyncio.create_task(maintain_canvas_lifecycle())

    async def resume_canvas_job(job_id: str) -> None:
        try:
            await asyncio.to_thread(run_canvas_job_scheduled, job_id)
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
    try:
        yield
    finally:
        from viewer_server.routes import _stop_studio_recovery_workers

        _stop_studio_recovery_workers()
        maintenance_task.cancel()
        for task in resume_tasks:
            task.cancel()
        observer.stop()
        observer.join(timeout=2)


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


def _revalidated_file(path: Path) -> FileResponse:
    return FileResponse(path, headers={"Cache-Control": _STATIC_CACHE_CONTROL})


def build_app(dist_dir: Path | None = None) -> FastAPI:
    _install_secret_filter()
    app = FastAPI(title="Game Atelier viewer-server", lifespan=lifespan)
    app.add_middleware(CanvasDocumentBodyLimitMiddleware)
    app.include_router(router)
    app.include_router(sse_router)

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
