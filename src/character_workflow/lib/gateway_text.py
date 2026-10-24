"""Text admission and settlement share the image-task quota lock and usage journal."""
import uuid
from datetime import datetime

from character_workflow.lib import gateway_live, gateway_quota, gateway_tasks, generation_pricing


def average_output_tokens(key_id: str) -> int:
    rows = []
    for path in sorted((gateway_tasks._root() / "usage").glob("*.jsonl"), reverse=True):
        rows.extend(row for row in reversed(gateway_tasks.read_usage(path.stem))
                    if row.get("key_id") == key_id and row.get("kind") == "text")
        if len(rows) >= 50:
            break
    counts = [row["output_tokens"] for row in rows[:50]
              if isinstance(row.get("output_tokens"), int)]
    return round(sum(counts) / len(counts)) if counts else 1000


class TextCall:
    def __init__(self, owner, route_id, picked, body_size: int, stream: bool):
        key, model = picked
        now = gateway_tasks._now().isoformat()
        with gateway_tasks._lock:
            estimate = generation_pricing.estimate_text_cost_cny(
                model.id, body_size // 3, average_output_tokens(owner.id),
            )
            gateway_quota.admit(owner, estimate or 0)
            self.task = gateway_tasks.GatewayTask(
                task_id=uuid.uuid4().hex, idempotency_key="", key_id=owner.id, key_name=owner.name,
                kind="text", route_id=route_id, prompt="", n=0, status="running",
                created_at=now, updated_at=now, estimated_cny=estimate, reserved_cny=estimate or 0,
            )
            gateway_quota._inflight[self.task.task_id] = (owner.id, estimate or 0)
        self.stream = stream
        self.finished = False
        self.member(key, model)

    def member(self, key, model):
        self.task.member_alias = key.alias
        self.task.member_model_id = model.id
        self.task.member_provider = key.provider
        self.task.member_base_url = key.base_url
        if key.alias not in self.task.route_tried:
            self.task.route_tried.append(key.alias)
        gateway_live.register({
            "call_id": self.task.task_id, "key_name": self.task.key_name,
            "route_id": self.task.route_id, "member_alias": key.alias,
            "started_at": self.task.created_at, "stream": self.stream,
        })

    def usage(self, payload):
        if not isinstance(payload, dict):
            return
        if isinstance(payload.get("response"), dict):
            payload = payload["response"]
        usage = payload.get("usage")
        if not isinstance(usage, dict):
            return
        for field, names in [("input_tokens", ("input_tokens", "prompt_tokens")),
                             ("output_tokens", ("output_tokens", "completion_tokens"))]:
            value = next((usage[name] for name in names if name in usage), None)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                setattr(self.task, field, value)

    def finish(self, status):
        with gateway_tasks._lock:
            if self.finished:
                return
            self.task.status = status
            self.task.charged_cny = generation_pricing.estimate_text_cost_cny(
                self.task.member_model_id, self.task.input_tokens or 0, self.task.output_tokens or 0,
            ) or 0
            self.task.updated_at = datetime.now().astimezone().isoformat()
            try:
                gateway_tasks._append_usage(self.task)
            finally:
                gateway_quota._inflight.pop(self.task.task_id, None)
                self.finished = True
                gateway_live.finish(self.task.task_id, status)
