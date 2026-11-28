"""画布 Agent 发起生成前的估价，以及「超过多少元要先确认」的阈值。

估价与界面模型菜单用同一套（`estimate_submission`；「自动」取路由排序后的第一家），
所以确认卡上的数和用户在界面上看到的预计费用一致。估价为 None = 未计价：不拦，卡片上标明。
阈值存 `<data_root>/.config/canvas-agent.json`，对 Agent 的所有生成生效（2026-11-19 飙哥定，
更新 10-09「Auto 一律不确认」：Auto 下单次估价超过阈值也先确认）。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from character_workflow.lib import data_root
from character_workflow.lib.atomic_io import atomic_write_text

DEFAULT_CONFIRM_ABOVE_CNY = 10.0
MAX_CONFIRM_ABOVE_CNY = 10_000.0


def settings_file() -> Path:
    return data_root.config_dir() / "canvas-agent.json"


def confirm_above_cny() -> float:
    try:
        value = json.loads(settings_file().read_text(encoding="utf-8")).get("confirm_above_cny")
    except (OSError, ValueError, AttributeError):
        return DEFAULT_CONFIRM_ABOVE_CNY
    if isinstance(value, (int, float)) and not isinstance(value, bool) \
            and 0 <= value <= MAX_CONFIRM_ABOVE_CNY:
        return float(value)
    return DEFAULT_CONFIRM_ABOVE_CNY


def write_confirm_above_cny(value: float) -> float:
    if not 0 <= value <= MAX_CONFIRM_ABOVE_CNY:
        raise ValueError(f"金额需在 0 到 {MAX_CONFIRM_ABOVE_CNY:g} 元之间")
    settings_file().parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(settings_file(), json.dumps({"confirm_above_cny": value}) + "\n")
    return value


def _draft_from_changes(node_id: str, changes: list[dict]) -> dict | None:
    """同一批待确认里还没执行的 set_draft：审查模式下它和 run_generation 会一起等确认。"""
    found = None
    for change in changes:
        if isinstance(change, dict) and change.get("op") == "set_draft" \
                and change.get("node_id") == node_id:
            found = {"mode": change.get("mode"), "model": change.get("model"),
                     "alias": change.get("alias"), "params": dict(change.get("params") or {})}
    return found


def _draft_from_document(project_id: str, node_id: str) -> dict | None:
    from character_workflow.lib.canvas_projects import read_canvas_document
    from character_workflow.lib.schemas import canvas_allowed_draft_params

    node = next((n for n in read_canvas_document(project_id).nodes if n.id == node_id), None)
    draft = getattr(getattr(node, "data", None), "generation_draft", None)
    if draft is None:
        return None
    return {"mode": draft.mode, "model": draft.model, "alias": draft.alias,
            "params": canvas_allowed_draft_params(draft.mode, draft.params)}


def _estimate(kind: str, alias: str | None, model: str, params: dict, calls: int = 1) -> float | None:
    from character_workflow.lib.generation_pricing import estimate_submission
    from character_workflow.lib.keys import find_by_alias

    # Routing uses the requested batch size. The canvas image runner sends one
    # request per slot, so price each request with its actual n, including manual prices.
    billed_params = {**params, "n": 1} if calls > 1 else params
    if alias is None:
        from character_workflow.lib.model_routes import find_route, member_estimate, ordered_members
        try:
            members = ordered_members(find_route(kind, model), params=params)
        except LookupError:
            return None
        unit = member_estimate(members[0], kind, billed_params) if members else None
    else:
        key = find_by_alias(alias)
        unit = estimate_submission(key, model, kind, billed_params) if key is not None else None
    return None if unit is None else unit * calls


def generation_estimate(project_id: str, node_id: str, count: int,
                        pending_changes: list[dict] | None = None, *,
                        individual_image_calls: bool = False) -> dict[str, Any]:
    """{model, alias, count, estimate_cny}；读不到 draft 或没有价格时 estimate_cny 为 None。"""
    draft = _draft_from_changes(node_id, pending_changes or []) \
        or _draft_from_document(project_id, node_id)
    if draft is None or not draft.get("model"):
        return {"model": None, "alias": None, "count": count, "estimate_cny": None}
    if draft.get("mode") not in {"image", "video"}:
        # 音频的 estimate_submission 返回的是每千字单价，不是这次的总价；按未计价处理。
        return {"model": draft["model"], "alias": draft.get("alias"), "count": count,
                "estimate_cny": None}
    params = dict(draft["params"])
    if draft["mode"] == "image":
        params["n"] = count
    try:
        if individual_image_calls and count > 1:
            estimate = _estimate(draft["mode"], draft["alias"], draft["model"], params, count)
        else:
            estimate = _estimate(draft["mode"], draft["alias"], draft["model"], params)
    except (ValueError, LookupError):
        estimate = None
    return {"model": draft["model"], "alias": draft["alias"], "count": count,
            "estimate_cny": estimate}


def needs_cost_confirmation(estimate_cny: float | None) -> bool:
    """未计价不拦：拦了 Agent 在大量未定价渠道上就没法用；确认卡与面板标「未计价」。"""
    return estimate_cny is not None and estimate_cny > confirm_above_cny()


GENERATION_TOOLS = {"run_generation", "run_generations"}


class TurnSpend:
    """Amounts are estimates. Reservations cover sibling calls checked before either executes."""

    def __init__(self, history=()):
        self.submitted = 0.0
        self.reserved = {}
        generation_ids = set()
        counted = set()
        for item in history:
            if item.get("role") == "user":
                self.submitted = 0.0
                generation_ids.clear()
                counted.clear()
            call_id = item.get("call_id")
            if item.get("type") == "function_call" and item.get("name") in GENERATION_TOOLS | {"run_group"}:
                generation_ids.add(call_id)
            if item.get("type") == "function_call_output" and call_id in generation_ids - counted:
                self.submitted += submitted_estimate(item.get("output"))
                counted.add(call_id)

    def requires_approval(self, call_id, prices):
        amount = sum(value for value in prices if value is not None)
        self.reserved.pop(call_id, None)
        pending = sum(self.reserved.values())
        if amount and needs_cost_confirmation(round(self.submitted + pending + amount, 6)):
            return True
        self.reserved[call_id] = amount
        return False

    def finish(self, call_id, output):
        self.reserved.pop(call_id, None)
        self.submitted += submitted_estimate(output)


def submitted_estimate(output):
    try:
        result = json.loads(output)
    except (TypeError, ValueError):
        return 0.0
    return result.get("submitted_estimate_cny", 0.0) if isinstance(result, dict) else 0.0


def with_submitted_estimate(output, prices):
    """Only include accepted items. Errors and entirely unpriced calls retain their output."""
    try:
        result = json.loads(output)
    except ValueError:
        return output
    if "items" in result:
        indexes = [row["index"] for row in result["items"] if row.get("status") == "submitted"]
    else:
        indexes = [0] if result.get("run_id") or result.get("job_id") else []
    amount = sum(prices[i] or 0 for i in indexes if i < len(prices))
    if amount:
        result["submitted_estimate_cny"] = round(amount, 6)
        return json.dumps(result, ensure_ascii=False)
    return output
