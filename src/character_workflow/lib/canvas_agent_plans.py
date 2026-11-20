"""画布 Agent 的待办（update_plan）：每个会话一份，存会话旁的 sidecar 文件，面板顶部显示。

存在 `canvases/<project_id>/agent/plans/<session_id>.json`，整份替换。不加 CanvasAgentSession 字段：
会话模型是 extra=forbid，加字段会让回滚后的旧版本读不出会话（ADR-0030）。项目导出包只收
agent/sessions 与 agent/lessons.md，待办不随项目导出。读不出的文件按没有待办处理。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from character_workflow.lib.atomic_io import atomic_write_json, read_text_with_retry
from character_workflow.lib.canvas_agent_sessions import canvas_agent_plan_path
from character_workflow.lib.schemas import CanvasAgentPlan

logger = logging.getLogger(__name__)


def plan_path(project_id: str, session_id: str) -> Path:
    return canvas_agent_plan_path(project_id, session_id)


def read_plan(project_id: str, session_id: str) -> CanvasAgentPlan | None:
    path = plan_path(project_id, session_id)
    try:
        return CanvasAgentPlan.model_validate_json(read_text_with_retry(path))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, ValidationError):
        logger.warning("canvas agent plan unreadable: %s", path.name, exc_info=True)
        return None


def write_plan(project_id: str, session_id: str, items: list) -> CanvasAgentPlan:
    """整份替换；items 不合规时抛 ValidationError（调用方回给模型去改）。"""
    plan = CanvasAgentPlan(items=items, updated_at=datetime.now(timezone.utc).isoformat())
    path = plan_path(project_id, session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(path, plan.model_dump(mode="json"))
    return plan
