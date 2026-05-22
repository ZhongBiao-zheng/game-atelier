"""recommend_action 决策表 —— 把"裸触发 default 默认出图"误推从 LLM 收回。

判定不明确一律走 `ask`，宁可多问。"误问"成本：画师多打一个数字；"误出图"
成本：空跑 job + 占位卡片 + 画师还得说取消。

决策表（短路命中，从上到下）：
| 输入信号                                  | action      |
|------------------------------------------|-------------|
| stage A/B/C                              | ask         |
| stage D + switch 信号 (target != active) | switch      |
| stage D + drafts 非空                    | render_card |
| stage D + create 关键词                  | ask         |
| stage D + 出图动词白名单                  | render_card |
| stage D + default + active_age > 30 min  | ask         |
| stage D + default + last job ∈ {DONE, FAILED} | ask    |
| 其他                                     | ask         |
"""
from __future__ import annotations

import re

# 出图动词白名单 —— 要扩词只改这里。
# 正则 \bvN\b 不准（"\b" 在中文边界算法上不可靠），用左右非词符兜
_RENDER_VERBS_LITERAL = (
    "出图", "出一张", "出一版", "再出", "重出",
    "再来一张", "来一张", "换张", "换一张",
)
_RENDER_VERSION_RE = re.compile(r"(?<![A-Za-z])v[1-4](?![0-9A-Za-z])", re.IGNORECASE)

_CREATE_KEYWORDS = ("新建", "新角色", "另一个角色")
_SLASH_CMD_RE = re.compile(r"/character-workflow\s+([\w\-]+)")

_COLD_START_MINUTES = 30


def _has_render_verb(msg: str) -> bool:
    """中文出图动词白名单命中。"""
    if not msg:
        return False
    for v in _RENDER_VERBS_LITERAL:
        if v in msg:
            return True
    return bool(_RENDER_VERSION_RE.search(msg))


def _has_create_keyword(msg: str) -> bool:
    if not msg:
        return False
    return any(kw in msg for kw in _CREATE_KEYWORDS)


def _detect_switch(msg: str, active_id: str | None) -> str | None:
    """返回切换目标 id；非 switch 信号或目标等于 active 时返回 None。"""
    if not msg:
        return None
    m = _SLASH_CMD_RE.search(msg)
    if not m:
        return None
    target = m.group(1)
    if target == active_id:
        return None
    return target


def compute_recommend_action(
    *,
    stage: str,
    message: str | None,
    drafts: list[dict],
    active_age_minutes: int | None,
    last_job_status: str | None,
    active_id: str | None = None,
) -> tuple[str, str]:
    """返回 (action, reason)。action ∈ {render_card, ask, switch, noop}。

    reason 是人类可读字符串，供 SKILL.md 在调用 AskUserQuestion / 出图卡片
    时附在 turn 决策日志里。
    """
    # 1. stage A/B/C/E —— 还没建好前置或 active 未归属项目，问就是了
    if stage in ("A", "B", "C", "E"):
        return "ask", f"stage {stage}: 前置未齐，需要画师补全"

    # 2. switch 信号优先 —— 切角色不能再读旧 spec
    target = _detect_switch(message or "", active_id)
    if target:
        return "switch", f"switch 信号：目标 {target!r} ≠ active {active_id!r}"

    # 3. drafts 非空 —— 画师已经写下反馈，render_card 走 revise
    if drafts:
        return "render_card", f"revise: drafts 中有 {len(drafts)} 条画师反馈"

    # 4. create 关键词 —— 走 stage B 流程问新角色定位
    if _has_create_keyword(message or ""):
        return "ask", "create 信号：消息含'新建/新角色/另一个角色'"

    # 5. 出图动词白名单 —— 画师明确要画
    if _has_render_verb(message or ""):
        return "render_card", "明确出图信号：消息含白名单动词"

    # 6. default：active 冷启动（>30 min 未更新）
    if active_age_minutes is not None and active_age_minutes > _COLD_START_MINUTES:
        return "ask", f"冷启动：active 已 {active_age_minutes} 分钟未更新（>30）"

    # 7. default：上一个 job 已闭环
    if last_job_status in ("done", "failed"):
        return "ask", f"上一轮已闭环（last={last_job_status}），画师意图未明"

    # 8. 兜底：判定不明确
    return "ask", "兜底：default 信号无明确出图意图"
