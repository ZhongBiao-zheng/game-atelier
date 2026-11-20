"""Text admission and settlement share the image-task quota lock and usage journal."""
import math
import uuid
from datetime import datetime

from character_workflow.lib import gateway_live, gateway_quota, gateway_tasks, generation_pricing


# 准入时一张内嵌图片按这么多输入 token 预扣。出处：Anthropic 视觉文档，约 1.15MP 以内的图片约
# 宽×高÷750 token，上限约 1600；Atelier 给模型附的图长边不超过 1024，落在这个范围内。同尺寸的图按
# OpenAI 的分块计法约 765，所以对 OpenAI 偏高、对 Claude 接近上限。偏低的后果：这一次调用的预扣
# 少于实际结算，成员可能在这一次里略超额度，下一次准入时被拦下。只影响预扣，结算照旧按上游用量。
IMAGE_INPUT_TOKENS_ESTIMATE = 1600
IMAGE_URL_KEYS = ("url", "image_url")


def _inline_images(value) -> tuple[int, int]:
    """(图片 data URL 的个数, 它们占的字节数)；只看 url / image_url 字段，不看提示词和工具参数。"""
    count = size = 0
    if isinstance(value, dict):
        for key, item in value.items():
            if key in IMAGE_URL_KEYS and isinstance(item, str) and item.startswith("data:image/"):
                count, size = count + 1, size + len(item.encode("utf-8"))
            else:
                more, extra = _inline_images(item)
                count, size = count + more, size + extra
    elif isinstance(value, list):
        for item in value:
            more, extra = _inline_images(item)
            count, size = count + more, size + extra
    return count, size


def input_tokens_estimate(payload: dict, body_size: int) -> int:
    """准入用的输入 token 估算：文字按请求体字节 / 3；内嵌图片按张数 × IMAGE_INPUT_TOKENS_ESTIMATE。
    以前图片也按 base64 字节 / 3 算，一张 1024px 的 JPEG 会被估成几万 token，额度紧的成员被误拦。"""
    count, size = _inline_images(payload)
    return max(0, body_size - size) // 3 + count * IMAGE_INPUT_TOKENS_ESTIMATE


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
    def __init__(self, owner, route_id, picked, input_tokens: int, stream: bool, *, route_order=None):
        """input_tokens：准入用的输入 token 估算（input_tokens_estimate）。"""
        key, model = picked
        now = gateway_tasks._now().isoformat()
        with gateway_tasks._lock:
            estimate = generation_pricing.estimate_text_cost_cny(
                model.id, input_tokens, average_output_tokens(owner.id), key=key,
            )
            gateway_quota.admit(owner, estimate or 0)
            self.task = gateway_tasks.GatewayTask(
                task_id=uuid.uuid4().hex, idempotency_key="", key_id=owner.id, key_name=owner.name,
                kind="text", route_id=route_id, route_order=route_order, prompt="", n=0, status="running",
                created_at=now, started_at=now, sent_at=now, updated_at=now, estimated_cny=estimate, reserved_cny=estimate or 0,
            )
            gateway_quota._inflight[self.task.task_id] = (owner.id, estimate or 0)
        self.stream = stream
        self.finished = False
        # 上游返回了 2xx（之后才可能计费）；用来区分「没回用量」与「根本没执行」。
        self.accepted = False
        self.cached_tokens = 0
        self.upstream_cost_usd: float | None = None
        self.member(key, model)

    def member(self, key, model):
        self.key = key
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
        # chat/completions 用 prompt/completion；有的上游（Tuzi 转 Claude）同时回 output_tokens=0，
        # 账单按 completion_tokens 扣（2026-11-18 付费小测）。responses 接口只有 input/output。
        chat = "prompt_tokens" in usage or "completion_tokens" in usage
        names = ("prompt_tokens", "completion_tokens") if chat else ("input_tokens", "output_tokens")
        for field, name in zip(("input_tokens", "output_tokens"), names):
            value = usage.get(name)
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                setattr(self.task, field, value)
        details = usage.get("prompt_tokens_details" if chat else "input_tokens_details")
        cached = details.get("cached_tokens") if isinstance(details, dict) else None
        if isinstance(cached, int) and not isinstance(cached, bool) and cached >= 0:
            self.cached_tokens = cached
        # OpenRouter 的 usage.cost 是上游确认的实付（美元）；其他上游的同名字段含义未核实，不用。
        cost = usage.get("cost")
        if (self.key.provider == "openrouter" and isinstance(cost, int | float)
                and not isinstance(cost, bool) and math.isfinite(cost) and cost >= 0):
            self.upstream_cost_usd = float(cost)

    def finish(self, status):
        with gateway_tasks._lock:
            if self.finished:
                return
            self.task.status = status
            self._settle()
            self.task.updated_at = datetime.now().astimezone().isoformat()
            try:
                gateway_tasks._append_usage(self.task)
            finally:
                gateway_quota._inflight.pop(self.task.task_id, None)
                self.finished = True
                gateway_live.finish(self.task.task_id, status)

    def _settle(self):
        """结算（飙哥定：失败只扣能确认上游已收费的；拿不到用量的扣 0，由主机承担）。

        - 上游回了实付（OpenRouter usage.cost）：成功、失败都按它扣。
        - 有用量：按 token 同步价算出金额（价格表来源），只在成功时扣。
        - 上游接受了请求却没回用量：记 usage_missing，扣 0。
        """
        task = self.task
        has_usage = task.input_tokens is not None or task.output_tokens is not None
        if self.upstream_cost_usd is not None:
            from character_workflow.lib.job_runner import USD_TO_CNY

            task.actual_cost_cny = round(self.upstream_cost_usd * USD_TO_CNY, 6)
            task.actual_cost_source = "upstream"
        elif has_usage:
            priced = generation_pricing.estimate_text_cost_cny(
                task.member_model_id, task.input_tokens or 0, task.output_tokens or 0,
                key=self.key, cached_tokens=self.cached_tokens,
            )
            if priced is not None:
                task.actual_cost_cny = priced
                task.actual_cost_source = "price_table"
        task.usage_missing = True if self.accepted and not has_usage else None
        confirmed = task.actual_cost_source == "upstream" or (
            task.status == "done" and task.actual_cost_source == "price_table")
        task.charged_cny = (task.actual_cost_cny or 0) if confirmed else 0
