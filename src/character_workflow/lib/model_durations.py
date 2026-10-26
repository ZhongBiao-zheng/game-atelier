"""Local completed-job medians for model menus, refreshed at most once a minute."""
from datetime import datetime, timezone
from statistics import median
from threading import Lock
from time import monotonic

from character_workflow.lib import data_root, jobs, model_routes

_lock = Lock()
_cache: dict = {}


def _timestamp(value: str) -> float:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).timestamp()


def model_durations() -> dict[str, float]:
    root = str(data_root.runtime_dir())
    with _lock:
        if _cache.get("root") == root and monotonic() < _cache.get("expires", 0):
            return dict(_cache["values"])
        samples: dict[tuple[str, str], list[tuple[float, float]]] = {}
        for job in jobs.list_jobs():
            start = job.runner_started_at if job.namespace == "canvas" else job.submitted_at
            if job.status != "done" or not job.alias or not job.completed_at or not start:
                continue
            try:
                end = _timestamp(job.completed_at)
                seconds = end - _timestamp(start)
            except (ValueError, OverflowError):
                continue
            if seconds > 0:
                samples.setdefault((job.alias, job.model), []).append((end, seconds))
        values = {f"{alias}:{model}": rows for (alias, model), rows in samples.items()}
        for route in model_routes.list_routes():
            values[f"@auto:{route.id}"] = [
                row for member in route.members
                for row in samples.get((member.alias, member.model_id), [])
            ]
        result = {key: median(row[1] for row in sorted(rows, reverse=True)[:50])
                  for key, rows in values.items() if len(rows) >= 3}
        _cache.update(root=root, expires=monotonic() + 60, values=result)
        return dict(result)
