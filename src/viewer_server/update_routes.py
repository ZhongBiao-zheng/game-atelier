"""Local bundle update coordinator and atomic admission of new work."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid

from fastapi import APIRouter, HTTPException, Request
from starlette.responses import JSONResponse

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_json
from character_workflow.lib.file_lock import try_file_lock

WAIT_SECONDS = 600
WORK_READ_SECONDS = 30
CHECK_SECONDS = 3600
router = APIRouter(prefix="/api/update")


def bootstrap():
    path = Path(__file__).resolve().parents[2] / "scripts/bootstrap.py"
    spec = importlib.util.spec_from_file_location("update_bootstrap", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


class Admission:
    def __init__(self, runtime: Path):
        self.runtime = runtime
        self.lock = threading.RLock()
        self.maintenance = False
        self.requests = 0
        self.initializing = False

    def blocked(self) -> bool:
        return self.maintenance or (self.runtime / "maintenance").exists()


_admissions: dict[Path, Admission] = {}
_admissions_lock = threading.Lock()


def admission() -> Admission:
    runtime = data_root.runtime_dir()
    with _admissions_lock:
        return _admissions.setdefault(runtime, Admission(runtime))


def work_request(path: str, method: str) -> bool:
    if method != "POST":
        return False
    if path in {"/api/studio/jobs", "/api/canvas-agent/run", "/gateway/v1/tasks",
                "/gateway/v1/openai/chat/completions", "/gateway/v1/openai/responses"}:
        return True
    if re.fullmatch(r"/api/jobs/[^/]+/confirm", path):
        return True
    if path.startswith("/api/canvas/projects/"):
        return bool(re.search(
            r"/(runs(?:/[^/]+)?|batch-runs/[^/]+/start|agent/sessions(?:/[^/]+/messages)?|"
            r"classify|media-operations)$", path)) or path.endswith("/resume-mj-edit")
    return False


class UpdateAdmissionMiddleware:
    """Register before dispatch, and retain the admission through BackgroundTasks/streaming."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = scope["path"]
        if scope["method"] == "GET" and path == "/api/connection/status":
            await self.app(scope, receive, send)
            return
        gate = admission()
        initialization_routes = {
            ("GET", "/api/connection/status"), ("POST", "/api/connection/local-session"),
            ("POST", "/api/connection/editor-lease"), ("DELETE", "/api/connection/editor-lease"),
            ("GET", "/api/update/state"), ("GET", "/api/update/result"),
        }
        if (gate.initializing and path.startswith("/api/")
                and (scope["method"], path) not in initialization_routes):
            await JSONResponse({"detail": "正在更新，请稍后"}, status_code=503)(scope, receive, send)
            return
        if not work_request(path, scope["method"]):
            await self.app(scope, receive, send)
            return
        with gate.lock:
            blocked = gate.blocked()
            if not blocked:
                gate.requests += 1
        if blocked:
            await JSONResponse({"detail": "正在更新，请稍后", "reason": "正在更新，请稍后"},
                               status_code=503)(scope, receive, send)
            return
        try:
            await self.app(scope, receive, send)
        finally:
            with gate.lock:
                gate.requests -= 1


def active_work() -> dict[str, int]:
    from character_workflow.lib.jobs import list_jobs
    from character_workflow.lib import gateway_tasks, gateway_live
    from character_workflow.lib.canvas_projects import list_canvas_projects
    from character_workflow.lib.canvas_agent_sessions import list_canvas_agent_sessions
    # Read producers before their jobs: an agent may schedule a job and become idle
    # between reads. The inverse order can miss both sides of that handoff.
    sessions = [s for p in list_canvas_projects()
                for s in list_canvas_agent_sessions(p.project_id).sessions]
    with gateway_tasks._lock:
        gateway = sum(t.status not in gateway_tasks.TERMINAL for t in gateway_tasks._all_tasks())
    live_gateway = len(gateway_live.active())
    jobs = sum(j.status.value in {"pending", "running"} for j in list_jobs())
    return {"jobs": jobs, "agents": sum(s.status == "running" for s in sessions),
            "approvals": sum(s.status == "awaiting_approval" for s in sessions),
            "gateway": gateway + live_gateway}


class UpdateController:
    def __init__(self, instance_id: str):
        boot = bootstrap()
        self.root = boot.bundle_root()
        self.current = boot._current_version() or ""
        self.mode = "bundle" if self.root else "legacy_bundle" if boot.is_bundle() else "source"
        self.instance_id = instance_id
        self.phase = "idle"
        self.update_id = None
        self.restart_started_at = None
        self.waiting = 0
        self.counts: dict[str, int] = {}
        self.task: asyncio.Task | None = None
        self.check_task: asyncio.Task | None = None
        self.cancelled = asyncio.Event()
        self.downloader = None
        if self.root:
            from viewer_server.bundle_download import BundleDownloader
            self.downloader = BundleDownloader(self.root, self.current)

    @property
    def gate(self) -> Admission:
        # Discovery must work even when the user's data-root configuration is broken.
        return admission()

    def state(self) -> dict:
        state = self.downloader.state() if self.downloader else {"status": "idle"}
        if state.get("to") == self.current:
            state = {"status": "idle"}
        return {**state, "runtime_mode": self.mode, "current": self.current,
                "maintenance": self.gate.blocked(), "initializing": self.gate.initializing,
                "waiting": self.waiting,
                "waiting_counts": self.counts, "phase": self.phase,
                "update_id": self.update_id, "restart_started_at": self.restart_started_at,
                "service_mode": os.environ.get("GAME_ATELIER_SERVICE") == "1"}

    async def checking(self, retry: bool = False):
        if not self.downloader:
            return
        if not self.gate.blocked():
            await asyncio.to_thread(self.downloader.check, retry_blocked=retry)

    async def auto_check(self):
        while True:
            self.start_check()
            await asyncio.sleep(CHECK_SECONDS)

    def start_check(self, retry: bool = False):
        if self.downloader and (self.check_task is None or self.check_task.done()):
            self.check_task = asyncio.create_task(self.checking(retry))

    def finish(self, status: str, reason: str = ""):
        atomic_write_json(self.gate.runtime / "update-result.json", {
            "update_id": self.update_id, "status": status, "from": self.current,
            "to": self.state().get("to"), "reason": reason,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })
        if self.root:
            pending = self.root / "updates/pending.json"
            if read_json(pending).get("update_id") == self.update_id:
                pending.unlink(missing_ok=True)
        with self.gate.lock:
            self.gate.maintenance = False
            (self.gate.runtime / "maintenance").unlink(missing_ok=True)
            self.phase = "idle"
            self.waiting = 0

    def begin(self) -> str:
        if not self.downloader:
            raise HTTPException(400, "请通过启动器或下载新安装包更新")
        with self.gate.lock:
            if self.gate.blocked():
                raise HTTPException(409, "正在更新")
            if self.check_task is not None and not self.check_task.done():
                raise HTTPException(409, "正在准备新版，请稍后")
            with try_file_lock(self.gate.runtime / "update.lock") as acquired:
                if not acquired:
                    raise HTTPException(409, "正在更新")
            state = self.downloader.state()
            if state.get("status") != "ready":
                raise HTTPException(409, "新版尚未准备好")
            try:
                newer = tuple(map(int, state["to"].split("."))) > tuple(map(int, self.current.split(".")))
            except (KeyError, ValueError, AttributeError):
                newer = False
            if not newer:
                raise HTTPException(409, "当前已是最新版本")
            self.update_id = uuid.uuid4().hex
            self.cancelled = asyncio.Event()
            self.restart_started_at = None
            atomic_write_json(self.root / "updates/pending.json", {
                "update_id": self.update_id, "from": self.current, "to": state["to"],
                "started_at": time.time(), "phase": "waiting", "from_instance": self.instance_id,
                "service_mode": os.environ.get("GAME_ATELIER_SERVICE") == "1",
            })
            atomic_write_json(self.gate.runtime / "maintenance", {"update_id": self.update_id})
            self.gate.maintenance = True
            self.phase = "waiting"
            self.task = asyncio.create_task(self.wait_and_launch(state["to"]))
            return self.update_id

    async def wait_and_launch(self, version: str):
        deadline = time.monotonic() + WAIT_SECONDS
        try:
            while True:
                if self.cancelled.is_set():
                    self.finish("cancelled")
                    return
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.finish("failed", "等待任务完成超时，已取消更新")
                    return
                snapshot = asyncio.create_task(asyncio.to_thread(self.snapshot_work))
                cancellation = asyncio.create_task(self.cancelled.wait())
                try:
                    done, _ = await asyncio.wait(
                        (snapshot, cancellation), timeout=min(WORK_READ_SECONDS, remaining),
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if self.cancelled.is_set():
                        self.finish("cancelled")
                        return
                    if snapshot not in done:
                        self.finish("failed", "读取任务状态超时，已取消更新")
                        return
                    self.counts, self.waiting = snapshot.result()
                finally:
                    snapshot.cancel()
                    cancellation.cancel()
                if self.cancelled.is_set():
                    self.finish("cancelled")
                    return
                if self.waiting == 0:
                    self.phase = "restarting"
                    self.restart_started_at = time.time()
                    break
                if time.monotonic() >= deadline:
                    self.finish("failed", "等待任务完成超时，已取消更新")
                    return
                await asyncio.sleep(0.5)
            pending = {"update_id": self.update_id, "from": self.current, "to": version,
                       "started_at": self.restart_started_at, "from_instance": self.instance_id,
                       "service_mode": os.environ.get("GAME_ATELIER_SERVICE") == "1"}
            atomic_write_json(self.root / "updates/pending.json", pending)
            log = self.gate.runtime / "update.log"
            command = [sys.executable, str(Path(__file__).resolve().parents[2] / "scripts/bootstrap.py"),
                       "--apply-update", "--to", version, "--update-id", self.update_id]
            options = ({"creationflags": subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
                       if os.name == "nt" else {"start_new_session": True})
            with log.open("ab") as output:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=output,
                                           stderr=output, env=dict(os.environ), **options)
            while True:
                if process.poll() is not None:
                    result = read_json(self.gate.runtime / "update-result.json")
                    if result.get("update_id") != self.update_id:
                        raise RuntimeError("更新执行器未能启动，请重新尝试")
                    self.finish(result["status"], result.get("reason", ""))
                    return
                await asyncio.sleep(0.1)
        except Exception as exc:
            # No provider calls happen here; never include environment/credentials in results.
            self.finish("failed", "无法启动更新，请检查 update.log 后重试")
            import logging
            logging.getLogger(__name__).warning("update coordinator failed: %s", type(exc).__name__)
            if self.root:
                (self.root / "updates/pending.json").unlink(missing_ok=True)

    def snapshot_work(self):
        # Maintenance prevents new admissions. Taking requests first can only overcount
        # requests that finish during the read, never miss work they create afterward.
        # Persistent file locks may block: never hold admission or mutate state here.
        with self.gate.lock:
            requests = self.gate.requests
        counts = active_work()
        return counts, sum(counts.values()) + requests

    async def close(self):
        for task in (self.task, self.check_task):
            if task and not task.done():
                task.cancel()


def controller(request: Request) -> UpdateController:
    return request.app.state.update_controller


@router.get("/state")
def state(request: Request):
    return controller(request).state()


@router.post("/check")
async def check(request: Request):
    service = controller(request)
    if not service.downloader:
        raise HTTPException(400, "请通过启动器或下载新安装包更新")
    if service.gate.blocked():
        raise HTTPException(409, "正在更新")
    service.start_check(retry=True)
    return service.state()


@router.post("/apply", status_code=202)
async def apply(request: Request):
    return {"update_id": controller(request).begin()}


@router.post("/cancel")
async def cancel(request: Request):
    service = controller(request)
    if service.phase != "waiting":
        raise HTTPException(409, "已开始重启，无法取消")
    service.cancelled.set()
    if service.task:
        await service.task
    return {"status": "cancelled"}


@router.get("/result")
def result(request: Request, id: str):
    payload = read_json(controller(request).gate.runtime / "update-result.json")
    return payload if payload.get("update_id") == id else None
