"""recommend_action 决策表测试 —— 决策从 LLM 收回，CLI 算好后 SKILL.md 按字段分叉。

覆盖：
- stage A/B/C → ask
- switch 信号 → switch
- drafts 非空 → render_card（revise）
- "新建/新角色/另一个角色" 关键词 → ask（让画师走 stage B 流程）
- 出图动词白名单每个关键词 → render_card
- default + active_age_minutes > 30 → ask（冷启动）
- default + last job DONE → ask（已闭环）
- default + last job FAILED → ask
- 兜底（其他 default）→ ask
"""
from __future__ import annotations

import pytest


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("RUNTIME_DIR", str(tmp_path / ".runtime"))
    monkeypatch.setenv("CHARACTERS_DIR", str(tmp_path / "characters"))
    return tmp_path


def test_stage_a_returns_ask(env):
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, reason = compute_recommend_action(
        stage="A", message=None, drafts=[], active_age_minutes=None, last_job_status=None,
    )
    assert action == "ask"
    assert "stage" in reason.lower() or "A" in reason


def test_stage_b_returns_ask(env):
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, _ = compute_recommend_action(
        stage="B", message=None, drafts=[], active_age_minutes=None, last_job_status=None,
    )
    assert action == "ask"


def test_stage_c_returns_ask(env):
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, _ = compute_recommend_action(
        stage="C", message=None, drafts=[], active_age_minutes=None, last_job_status=None,
    )
    assert action == "ask"


def test_switch_signal_wins(env):
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, reason = compute_recommend_action(
        stage="D",
        message="/character-workflow another-char 切换",
        drafts=[],
        active_age_minutes=1,
        last_job_status=None,
        active_id="current",
    )
    assert action == "switch"
    assert "switch" in reason.lower() or "切换" in reason


def test_drafts_non_empty_renders_card(env):
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, reason = compute_recommend_action(
        stage="D", message=None,
        drafts=[{"path": "/tmp/a.md", "content": "再红一点"}],
        active_age_minutes=1, last_job_status=None,
    )
    assert action == "render_card"
    assert "draft" in reason.lower() or "revise" in reason.lower() or "反馈" in reason


def test_create_keyword_returns_ask(env):
    from skill.character_workflow.lib.intent import compute_recommend_action
    for kw in ("新建", "新角色", "另一个角色"):
        action, _ = compute_recommend_action(
            stage="D", message=f"我要{kw}做点东西",
            drafts=[], active_age_minutes=1, last_job_status=None,
        )
        assert action == "ask", f"关键词 {kw!r} 应该走 ask"


@pytest.mark.parametrize("verb", [
    "出图", "出一张", "出一版", "再出", "重出",
    "再来一张", "来一张", "换张", "换一张",
    "v1", "v2", "v3", "v4",
])
def test_render_verb_whitelist(env, verb):
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, _ = compute_recommend_action(
        stage="D", message=f"帮我{verb}", drafts=[],
        active_age_minutes=1, last_job_status=None,
    )
    assert action == "render_card", f"动词 {verb!r} 应该走 render_card"


def test_render_verb_case_insensitive(env):
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, _ = compute_recommend_action(
        stage="D", message="V2 看下", drafts=[],
        active_age_minutes=1, last_job_status=None,
    )
    assert action == "render_card"


def test_default_with_cold_start_asks(env):
    """default signal + active_age > 30 分钟 → ask"""
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, reason = compute_recommend_action(
        stage="D", message=None, drafts=[],
        active_age_minutes=60, last_job_status=None,
    )
    assert action == "ask"
    assert "冷" in reason or "age" in reason.lower() or "30" in reason


def test_default_with_last_done_asks(env):
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, reason = compute_recommend_action(
        stage="D", message=None, drafts=[],
        active_age_minutes=1, last_job_status="done",
    )
    assert action == "ask"
    assert "闭环" in reason or "done" in reason.lower()


def test_default_with_last_failed_asks(env):
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, _ = compute_recommend_action(
        stage="D", message=None, drafts=[],
        active_age_minutes=1, last_job_status="failed",
    )
    assert action == "ask"


def test_default_no_signals_asks(env):
    """完全无信号兜底 → ask（不出图，宁可多问）"""
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, _ = compute_recommend_action(
        stage="D", message=None, drafts=[],
        active_age_minutes=1, last_job_status="pending_confirm",
    )
    assert action == "ask"


def test_default_with_empty_message_asks(env):
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, _ = compute_recommend_action(
        stage="D", message="", drafts=[],
        active_age_minutes=1, last_job_status=None,
    )
    assert action == "ask"


def test_switch_to_same_active_falls_through(env):
    """/character-workflow X 但 X 已经是 active → 不算 switch"""
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, _ = compute_recommend_action(
        stage="D", message="/character-workflow current",
        drafts=[], active_age_minutes=1, last_job_status=None,
        active_id="current",
    )
    # 没 switch、没 draft、没 verb、没 create kw → 走兜底 ask
    assert action == "ask"


def test_drafts_short_circuits_create_keyword(env):
    """drafts 非空 比 '新建' 关键词高，因为 drafts 是更具体的信号"""
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, _ = compute_recommend_action(
        stage="D", message="新建一个",
        drafts=[{"path": "/tmp/a.md", "content": "改红"}],
        active_age_minutes=1, last_job_status=None,
    )
    assert action == "render_card"


def test_turn_start_includes_recommend_fields(env):
    """turn-start 返回 JSON 必须含 recommend_action / recommend_reason / active_age_minutes。"""
    from skill.character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", message=None)
    assert "recommend_action" in result
    assert "recommend_reason" in result
    assert "active_age_minutes" in result
    # Stage A 时 → ask + age None
    assert result["recommend_action"] == "ask"
    assert result["active_age_minutes"] is None


def test_turn_start_stage_d_age_calc(env):
    """Stage D 时 active_age_minutes 是 int >= 0。"""
    import json
    from datetime import datetime, timezone

    (env / "characters" / "holy").mkdir(parents=True)
    (env / "characters" / "holy" / "spec.md").write_text("# 圣灵\n治愈系", encoding="utf-8")
    (env / ".runtime").mkdir()
    # 10 分钟前
    import datetime as dt
    past = datetime.now(timezone.utc) - dt.timedelta(minutes=10)
    (env / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": past.isoformat()}),
        encoding="utf-8",
    )
    (env / ".runtime" / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-proj", "name": "Test", "created_at": "2026-05-19T00:00:00+00:00"}],
            "assignments": {"holy": "p-1"},
        }),
        encoding="utf-8",
    )

    from skill.character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", message=None)
    assert result["stage"] == "D"
    assert isinstance(result["active_age_minutes"], int)
    assert 9 <= result["active_age_minutes"] <= 11


def test_stage_e_returns_ask_with_未归属_reason():
    from skill.character_workflow.lib.intent import compute_recommend_action
    action, reason = compute_recommend_action(
        stage="E",
        message="出图",
        drafts=[],
        active_age_minutes=5,
        last_job_status="done",
        active_id="orphan-char",
    )
    assert action == "ask"
    assert "未归属" in reason
    assert "前置未齐" not in reason
