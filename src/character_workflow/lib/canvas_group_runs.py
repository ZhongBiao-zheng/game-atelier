"""Durable serial orchestration on top of the ordinary canvas Job queue."""
import json
import logging
import re
import secrets
import threading
from datetime import datetime, timezone

from character_workflow.lib import canvas_projects as projects
from character_workflow.lib import canvas_run_queue, canvas_runs
from character_workflow.lib.atomic_io import atomic_write_json, read_text_with_retry
from character_workflow.lib.canvas_group_plan import group_plan
from character_workflow.lib.file_lock import file_lock
from character_workflow.lib.jobs import JobStatus, new_job_id, read_job

STALE = "组的内容变了，请重新确认"
BUSY = "这个组正在执行"
_PENDING = {JobStatus.PENDING, JobStatus.PENDING_CONFIRM}
_WAIT_SECONDS = 0.35


def _now():
    return datetime.now(timezone.utc).isoformat()


def _folder(project_id):
    return projects.canvas_project_dir(project_id) / "group-runs"


def _path(project_id, run_id):
    if not re.fullmatch(r"grun_[0-9a-f]{24}", run_id):
        raise KeyError(run_id)
    return _folder(project_id) / f"{run_id}.json"


def list_runs(project_id):
    return sorted((json.loads(read_text_with_retry(path))
                   for path in _folder(project_id).glob("grun_*.json")),
                  key=lambda run: run["created_at"], reverse=True)


def active_step_jobs():
    """Include the interval before the next Job exists when draining for a restart or move."""
    jobs = []
    for path in projects.canvas_projects_root().glob("*/group-runs/grun_*.json"):
        try:
            run = json.loads(read_text_with_retry(path))
        except FileNotFoundError:
            continue  # Project removed during the snapshot.
        if run["status"] == "running":
            jobs.append(next((s["job_id"] for s in run["steps"] if s["status"] != "done"), None))
    return jobs


def _save(project_id, run):
    run["updated_at"] = _now()
    run["revision"] += 1
    atomic_write_json(_path(project_id, run["run_id"]), run)


def _check_idle(project_id, group_id):
    if any(run["group_id"] == group_id and run["status"] == "running"
           for run in list_runs(project_id)):
        raise RuntimeError(BUSY)


def start(project_id, group_id, order, total_cny):
    with file_lock(projects.canvas_project_lock_path(project_id)):
        _check_idle(project_id, group_id)
        canvas_runs.recover_canvas_transactions_unlocked(project_id)
        doc = projects._read_canvas_document_unlocked(project_id)
        plan = group_plan(project_id, group_id, doc)
        if order != plan["order"] or total_cny != plan["total_cny"]:
            raise RuntimeError(STALE)
        if plan["cycle"] or plan["blocked"] or not order:
            raise ValueError("组里的连线有循环" if plan["cycle"] else "组里有未完成的草稿或没有可生成的节点")
        run = {"run_id": "grun_" + secrets.token_hex(12), "group_id": group_id,
               "order": order, "estimate_cny": total_cny, "unpriced": plan["unpriced"],
               "created_at": _now(), "revision": 0, "status": "running",
               "steps": [{**row, "status": "pending", "job_id": None, "error": None}
                         for row in plan["steps"]]}
        _save(project_id, run)
    _launch(project_id, run["run_id"])
    return run


def _load(project_id, run_id):
    return json.loads(read_text_with_retry(_path(project_id, run_id)))


def resume(project_id, run_id):
    with file_lock(projects.canvas_project_lock_path(project_id)):
        run = _load(project_id, run_id)
        _check_idle(project_id, run["group_id"])
        if run["status"] not in {"failed", "interrupted"}:
            raise RuntimeError("这次执行不能继续")
        for step in run["steps"]:
            if step["status"] == "done":
                continue
            if step["job_id"]:
                try:
                    job = read_job(step["job_id"])
                except FileNotFoundError:
                    job = None
                if job and job.status not in _PENDING | {JobStatus.DONE}:
                    step["job_id"] = None
            step.update(status="pending", error=None)
            break
        run["status"] = "running"
        _save(project_id, run)
    _launch(project_id, run_id)
    return run


def cancel(project_id, run_id):
    with file_lock(projects.canvas_project_lock_path(project_id)):
        run = _load(project_id, run_id)
        if run["status"] not in {"done", "cancelled"}:
            run["status"] = "cancelled"
            _save(project_id, run)
        return run


def interrupt_running(project_id):
    with file_lock(projects.canvas_project_lock_path(project_id)):
        for run in list_runs(project_id):
            if run["status"] == "running":
                run["status"] = "interrupted"
                _save(project_id, run)


def _submit_step(project_id, run, step):
    canvas_runs.recover_canvas_transactions_unlocked(project_id)
    doc = projects._read_canvas_document_unlocked(project_id)
    plan = group_plan(project_id, run["group_id"], doc)
    row = next((row for row in plan["steps"] if row["node_id"] == step["node_id"]), None)
    fields = ("model", "mode", "alias", "count", "estimate_cny")
    if row is None or any(row[k] != step[k] for k in fields):
        raise ValueError(STALE)
    finished = {s["node_id"]: s["version_id"] for s in run["steps"] if s["status"] == "done"}
    surface = next(n for n in doc.nodes if n.id == step["node_id"])
    sources = canvas_runs.canvas_input_sources(doc, surface, surface.data.generation_draft)
    if any(src in run["order"] and src not in finished for _, src, _ in sources):
        raise ValueError(STALE)
    # A populated surface can produce a new result node. Resolve draft mentions against
    # the original IDs but freeze the versions produced by this run. Never edit live edges.
    nodes = [n.model_copy(update={"data": n.data.model_copy(update={
        "current_version_id": finished[n.id]})}) if n.id in finished else n for n in doc.nodes]
    prepared = canvas_runs.prepare_canvas_generation(
        project_id, doc.model_copy(update={"nodes": nodes}), surface, step["count"], consume_route=True)
    # When generation created a separate surface, its ID also belongs on snapshot
    # references and any new result edges. Keep the user's original draft intact.
    live_ids = {n.id for n in doc.nodes}
    result_ids = {s["node_id"]: s["result_node_id"] for s in run["steps"]
                  if s.get("result_node_id") in live_ids and s["result_node_id"] != s["node_id"]}
    if result_ids:
        prompt = prepared.draft.prompt
        inputs = []
        for item in prepared.inputs:
            source = result_ids.get(item.node_id, item.node_id)
            prompt = prompt.replace(f"@[node:{item.node_id}]", f"@[node:{source}]")
            inputs.append(item.model_copy(update={"node_id": source}))
        prepared.inputs = inputs
        prepared.draft = prepared.draft.model_copy(update={"prompt": prompt})
    job, _ = canvas_runs.commit_canvas_generation_under_lock(
        project_id, doc, surface, prepared, job_id=step["job_id"])
    return job


def _advance(project_id, run_id):
    """Hold the same lock as cancel through submission. Return stop, wait or advance."""
    with file_lock(projects.canvas_project_lock_path(project_id)):
        run = _load(project_id, run_id)
        if run["status"] != "running":
            return "stop"
        step = next((s for s in run["steps"] if s["status"] != "done"), None)
        if step is None:
            run["status"] = "done"
            _save(project_id, run)
            return "stop"
        try:
            job = None
            if step["job_id"]:
                try:
                    job = read_job(step["job_id"])
                except FileNotFoundError:
                    pass  # Previous process reserved the ID before committing the job.
            if job is None:
                step["job_id"] = step["job_id"] or new_job_id()
                _save(project_id, run)
                job = _submit_step(project_id, run, step)
                canvas_run_queue.submit(job.job_id)
                return "wait"
            if job.status in _PENDING:
                return "wait"
            if job.status != JobStatus.DONE:
                raise ValueError(job.error or "节点生成失败")
            version = next((c.version_id for c in job.canvas_run.candidates if c.version_id), None)
            if not version:
                return "wait"  # Runner finished; canvas finalization is committing the versions.
            step.update(status="done", version_id=version, result_node_id=job.canvas_run.result_node_id)
        except Exception as error:
            step.update(status="failed", error=str(error))
            run["status"] = "failed"
        _save(project_id, run)
        return "advance" if run["status"] == "running" else "stop"


def _work(project_id, run_id):
    wait = threading.Event()
    try:
        while True:
            action = _advance(project_id, run_id)
            if action == "stop":
                return
            if action == "wait":
                wait.wait(_WAIT_SECONDS)
    except (FileNotFoundError, KeyError):
        return  # Project removed.
    except Exception:
        logging.getLogger(__name__).exception("group runner failed: %s", run_id)


def _launch(project_id, run_id):
    threading.Thread(target=_work, args=(project_id, run_id), name=f"canvas-{run_id}",
                     daemon=True).start()
