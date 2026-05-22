"""turn-start v4 — file system stage probe + intent inference.

公共 API：
- detect_stage() → (stage, reason)：探测 file system 走 A/B/C/D 哪条路
- list_recent_chars() → [{"id","tagline"}, ...]：列已有角色 + tagline
- infer_intent(message, drafts, active_id) → (intent, signal, conflict)：stage D 意图推断
- turn_start(kind, message) → dict：编排器，组装 v4 JSON

文件路径全部走 data_root 抽象（CHARACTER_WORKFLOW_DATA_ROOT 环境变量驱动），方便测试 monkeypatch。
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from character_workflow.lib import data_root, keys

# 设计稿 §4.4 关键词清单。本轮写死，后续扩展时再抽到 YAML。
_NEW_KEYWORDS = ("新建", "新角色", "另一个角色")
_SLASH_CMD_RE = re.compile(r"/character-workflow\s+([\w\-]+)")


def _runtime_dir() -> Path:
    return data_root.runtime_dir()


def _characters_dir() -> Path:
    return data_root.characters_dir()


def detect_stage() -> tuple[str, str]:
    """Return (stage, human-readable reason). Stage values: A/B/C/D/E."""
    chars = _characters_dir()
    if not chars.exists():
        return "A", "characters/ 目录不存在"
    subs = [p for p in chars.iterdir() if p.is_dir()]
    if not subs:
        return "B", "characters/ 为空"

    active_file = _runtime_dir() / "active-character.json"
    if not active_file.exists():
        return "C", "active-character.json 不存在"

    try:
        data = json.loads(active_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        return "C", f"active-character.json 损坏: {e}"

    active_id = data.get("active_id")
    if not active_id:
        return "C", "active_id 为空"

    char_dir = chars / active_id
    if not char_dir.is_dir():
        return "C", f"active_id={active_id!r} 对应目录不存在"
    if not (char_dir / "spec.md").exists():
        return "C", f"{active_id}/spec.md 不存在"

    # Stage E: active 完整但 assignments 里缺失
    from character_workflow.lib.projects import read_projects
    pf = read_projects()
    if active_id not in pf.assignments:
        return "E", f"active_id={active_id!r} 未归属任何项目"

    return "D", "active 完整且已归属"


def list_recent_chars(limit: int = 10) -> list[dict]:
    """List existing characters with taglines, sorted alphabetically by id.

    tagline = spec.md 首行非空、非标题 markdown 内容，截断到 30 字。
    spec.md 不存在 → tagline = ""。
    """
    chars = _characters_dir()
    if not chars.exists():
        return []
    out: list[dict] = []
    for sub in sorted(chars.iterdir()):
        if not sub.is_dir():
            continue
        spec = sub / "spec.md"
        tagline = ""
        if spec.exists():
            try:
                text = spec.read_text(encoding="utf-8")
            except OSError:
                text = ""
            for line in text.splitlines():
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith("#"):
                    continue
                tagline = stripped[:30]
                break
        out.append({"id": sub.name, "tagline": tagline})
    return out[:limit]


def infer_intent(
    message: str | None,
    drafts: list[dict],
    active_id: str | None,
) -> tuple[str | None, str, bool]:
    """Return (intent, signal, conflict).

    设计稿 §4.4 规则：
    - drafts 非空 → revise
    - message 含 "新建/新角色/另一个角色" → create
    - message 含 "/character-workflow <name>" 且 name != active_id → switch
    - 都不匹配 → new（default）

    多信号同时命中 → conflict=True, intent=None。
    """
    signals: list[tuple[str, str]] = []

    if drafts:
        signals.append(("revise", "drafts_present"))

    if message:
        if any(kw in message for kw in _NEW_KEYWORDS):
            signals.append(("create", "new_keyword"))
        m = _SLASH_CMD_RE.search(message)
        if m and m.group(1) != active_id:
            signals.append(("switch", "switch_keyword"))

    if len(signals) > 1:
        return None, "conflict", True
    if signals:
        intent, signal = signals[0]
        return intent, signal, False
    return "new", "default", False


def _read_active_spec(active_id: str | None) -> str | None:
    if not active_id:
        return None
    p = _characters_dir() / active_id / "spec.md"
    if not p.exists():
        return None
    try:
        return p.read_text(encoding="utf-8")
    except OSError:
        return None


def _active_age_minutes(updated_at: str) -> int | None:
    """返回 active 更新到现在的分钟数（向下取整）。无效或空 → None。"""
    if not updated_at:
        return None
    try:
        ts = datetime.fromisoformat(updated_at)
    except ValueError:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - ts
    return max(0, int(delta.total_seconds() // 60))


def _last_job_status(active_id: str | None) -> str | None:
    """读 .runtime/jobs/*.json，返回当前 active 最近一条 job 的 status。

    没 active / 没 job 文件 → None。读取失败的单个 job 跳过。
    """
    if not active_id:
        return None
    jobs_dir = _runtime_dir() / "jobs"
    if not jobs_dir.exists():
        return None
    latest_ts = ""
    latest_status: str | None = None
    for p in jobs_dir.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("character_id") != active_id:
            continue
        ts = data.get("submitted_at", "")
        if ts > latest_ts:
            latest_ts = ts
            latest_status = data.get("status")
    return latest_status


def turn_start(kind: str = "portrait", message: str | None = None) -> dict:
    """v5 编排器：file system 探 stage + 解析项目 + 推 intent + 拉三层上下文。

    返回 dict（JSON 序列化用）；调用方需要时可用 TurnStartResult.model_validate 校验。
    """
    from character_workflow.lib.active_character import read_active
    from character_workflow.lib.context_loader import (
        load_lessons_global,
        load_lessons_project,
        load_lessons_workspace,
        load_project_worldview,
        load_worldview,
    )
    from character_workflow.lib.draft_processor import process_drafts
    from character_workflow.lib.intent import compute_recommend_action
    from character_workflow.lib.projects import read_projects

    stage, reason = detect_stage()
    active = read_active() if stage in ("C", "D", "E") else None
    active_id = active.active_id if active else None
    active_updated_at = active.updated_at if active else ""

    # 解析项目(只在 stage D 有归属)
    pf = read_projects()
    project_id: str | None = None
    project_slug: str | None = None
    project_name: str | None = None
    if stage == "D" and active_id:
        project_id = pf.assignments.get(active_id)
        if project_id:
            proj = next((p for p in pf.projects if p.id == project_id), None)
            if proj:
                project_slug = proj.slug
                project_name = proj.name

    drafts = process_drafts() if stage == "D" else []
    spec = _read_active_spec(active_id) if stage in ("D", "E") else None
    recent = list_recent_chars() if stage in ("C", "D", "E") else []

    if stage == "D":
        intent, signal, conflict = infer_intent(message, drafts, active_id)
        age_min = _active_age_minutes(active_updated_at)
        last_status = _last_job_status(active_id)
    else:
        intent, signal, conflict = None, "none", False
        age_min = None
        last_status = None

    action, action_reason = compute_recommend_action(
        stage=stage,
        message=message,
        drafts=drafts,
        active_age_minutes=age_min,
        last_job_status=last_status,
        active_id=active_id,
    )

    return {
        "stage": stage,
        "stage_reason": reason,
        "intent": intent,
        "intent_signal": signal,
        "intent_conflict": conflict,
        "recommend_action": action,
        "recommend_reason": action_reason,
        "active_age_minutes": age_min,
        "recent_chars": recent,
        "drafts": drafts,
        "active_id": active_id,
        "active_updated_at": active_updated_at,
        "spec": spec,
        "project_id": project_id,
        "project_slug": project_slug,
        "project_name": project_name,
        "worldview_workspace": load_worldview(),
        "worldview_project": load_project_worldview(project_slug),
        "lessons_global": load_lessons_global(kind),
        "lessons_workspace": load_lessons_workspace(kind),
        "lessons_project": load_lessons_project(project_slug, kind),
        "lessons_kind": kind,
        "available_keys": keys.keys_for_turn_start(),
        "preferred_alias": keys.preferred_alias_for_kind(kind) if kind in ("portrait", "promo", "turnaround") else None,
    }
