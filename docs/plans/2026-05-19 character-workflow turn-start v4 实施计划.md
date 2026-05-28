# Character Workflow `turn-start` v4.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 `character_workflow` Skill 的 `turn-start` 协议从 v3.0.0 到 v4.0.0，引入"file system stage + painter intent"两层分叉，解决冷启动盲区 / active_id 缺失兜底薄 / 无意图根问题三类结构性缺陷。

**Architecture:** 新增 `skill/character_workflow/lib/turn_start.py` 承载两个纯函数（`detect_stage()` 判 A/B/C/D，`infer_intent()` 在 stage D 推断画师意图）；`turn_start()` 编排器组装 v4 schema；CLI 加 `--message` 参数把画师消息原文传入做意图推断；SKILL.md 重写 turn-start 章节明确 4 stage 分支行为。Skill 端（Claude 读 SKILL.md 后执行）负责 AskUserQuestion 与文件落盘，CLI 不动 file system。

**Tech Stack:** Python 3.11 / Pydantic 2.9 / pytest 8 / ruff / FastAPI 0.115 / TS 5.6 / shadcn / Vite 5（本计划只动 Python + SKILL.md，Web 不动）。

---

## Spec Source

实施计划严格对应设计稿：`docs/plans/2026-05-19 character-workflow turn-start v4 设计.md`。
本计划 = 设计稿 §4 / §5 / §6 / §7 / §8（验收）的落地拆解。

## Plan-Time Decisions

设计稿 §11 留了 4 个 Open Questions。本计划按以下默认值落地（执行时不再问画师）：

| Q | 默认决策 | 理由 |
|---|---|---|
| Q1 1 AskUserQuestion 含 3 question vs 3 个连续 | **1 个，含 3 question** | AskUserQuestion 支持 1-4 question per call，少打扰画师 |
| Q2 Skill 怎么传 `--message` | **SKILL.md 写明"调 turn-start 时把画师本轮最近一条消息原文用 `--message` 传进去"** | 文档约束即可，不引新协议 |
| Q3 intent 关键词是否可配置 | **写死在 Python 里** | 设计稿 §11 推荐；后续扩展时再抽 |
| Q4 多画师协作 active-character.json 冲突 | **不处理（单画师假设）** | 设计稿 §9 NOT in scope |

## File Structure

**新建：**
- `skill/character_workflow/lib/turn_start.py` — 4 个函数：`detect_stage()` / `infer_intent()` / `list_recent_chars()` / `turn_start()`。纯函数 + 文件 I/O 走 `os.environ`，方便 monkeypatch。
- `tests/test_turn_start_v4.py` — 覆盖设计稿 §8 全部 10 个验收场景 + intent 推断 5 条规则 + recent_chars helper。

**修改：**
- `skill/character_workflow/lib/schemas.py` — 新增 `TurnStage` enum / `IntentKind` enum / `TurnStartResult` Pydantic 模型 / `RecentCharacter` 小模型。
- `skill/character_workflow/__main__.py` — `turn-start` subcommand 加 `--message` 可选参数，`turn_start()` 函数迁移到 `lib/turn_start.py`，`__main__.py` 只做 argparse + JSON 序列化。
- `skill/character_workflow/SKILL.md` — 重写 `## Turn 起始` 章节，新增 `## Painter Intent 推断` + `## Related Discovery` 段；version 字段 3.0.0 → 4.0.0。

**不改：**
- `web/src/schema/jobs.ts` — turn-start 输出是 CLI → Skill（Claude）的 JSON，Web 不消费，无需 TS 同步。Task 7 仅做"确认无需改动"的核对。

---

## Task 1: Schema 字段 —— `TurnStartResult` + enums

**Files:**
- Modify: `skill/character_workflow/lib/schemas.py`（在文件末尾追加）
- Test: `tests/test_schemas.py`（追加 v4 schema 用例）

- [ ] **Step 1: 写失败测试 —— TurnStage / IntentKind 枚举值**

在 `tests/test_schemas.py` 末尾追加：

```python
def test_turn_stage_enum_values():
    from skill.character_workflow.lib.schemas import TurnStage
    assert TurnStage.A.value == "A"
    assert TurnStage.B.value == "B"
    assert TurnStage.C.value == "C"
    assert TurnStage.D.value == "D"


def test_intent_kind_enum_values():
    from skill.character_workflow.lib.schemas import IntentKind
    assert IntentKind.NEW.value == "new"
    assert IntentKind.REVISE.value == "revise"
    assert IntentKind.CREATE.value == "create"
    assert IntentKind.SWITCH.value == "switch"


def test_turn_start_result_minimal():
    from skill.character_workflow.lib.schemas import TurnStartResult, TurnStage
    r = TurnStartResult(
        stage=TurnStage.A,
        stage_reason="characters/ 目录不存在",
        intent=None,
        intent_signal="default",
        intent_conflict=False,
        recent_chars=[],
        drafts=[],
        active_id=None,
        active_updated_at="",
        spec=None,
        worldview="",
        lessons="",
        lessons_kind="portrait",
    )
    assert r.stage == TurnStage.A
    assert r.intent is None


def test_turn_start_result_full_stage_d():
    from skill.character_workflow.lib.schemas import (
        TurnStartResult, TurnStage, IntentKind, RecentCharacter,
    )
    r = TurnStartResult(
        stage=TurnStage.D,
        stage_reason="active 存在",
        intent=IntentKind.REVISE,
        intent_signal="drafts_present",
        intent_conflict=False,
        recent_chars=[RecentCharacter(id="holy", tagline="治愈系祭祀")],
        drafts=[{"path": "holy-1.md", "text": "调色"}],
        active_id="holy",
        active_updated_at="2026-05-19T08:00:00+00:00",
        spec="# 圣灵祭祀\n",
        worldview="光明大陆",
        lessons="- 2026-05-19 holy",
        lessons_kind="portrait",
    )
    assert r.intent == IntentKind.REVISE
    assert r.recent_chars[0].id == "holy"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_schemas.py -v -k "turn_stage or intent_kind or turn_start_result"`
Expected: 4 个 FAIL, `ImportError: cannot import name 'TurnStage'` 等。

- [ ] **Step 3: 写最小实现**

在 `skill/character_workflow/lib/schemas.py` 末尾追加：

```python
class TurnStage(str, Enum):
    # turn-start v4：file system 探测结果
    # A = characters/ 不存在；B = 空 characters/；C = active 缺失/失效；D = 正常回流。
    A = "A"
    B = "B"
    C = "C"
    D = "D"


class IntentKind(str, Enum):
    # 仅 stage D 时有值。null = 不在 stage D。
    NEW = "new"        # 给 active 出新图（默认）
    REVISE = "revise"  # 根据 drafts 改 active 的图
    CREATE = "create"  # 新建另一个角色（消息含"新建"关键词）
    SWITCH = "switch"  # 切换到已有角色（消息含 /character-workflow <name>）


class RecentCharacter(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    tagline: str  # 从 spec.md 首行非标题内容截取，≤30 字


class TurnStartResult(BaseModel):
    # v4.0.0 CLI 输出契约。Skill 端按 stage 字段分支。
    model_config = ConfigDict(extra="forbid")
    stage: TurnStage
    stage_reason: str
    intent: IntentKind | None
    intent_signal: str  # "drafts_present" | "new_keyword" | "switch_keyword" | "default" | "none"
    intent_conflict: bool
    recent_chars: list[RecentCharacter]
    # 沿用 v3.0.0
    drafts: list[dict]
    active_id: str | None
    active_updated_at: str
    spec: str | None
    worldview: str
    lessons: str
    lessons_kind: str
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_schemas.py -v -k "turn_stage or intent_kind or turn_start_result"`
Expected: 4 PASS.

- [ ] **Step 5: ruff 检查 + commit**

```bash
uv run ruff check skill/character_workflow/lib/schemas.py tests/test_schemas.py
git add skill/character_workflow/lib/schemas.py tests/test_schemas.py
git commit -m "feat(schemas): add TurnStartResult v4 schema (stage/intent/recent_chars)"
```

---

## Task 2: file system stage probe —— `detect_stage()`

**Files:**
- Create: `skill/character_workflow/lib/turn_start.py`
- Test: `tests/test_turn_start_v4.py`

- [ ] **Step 1: 写失败测试 —— 4 个 stage**

新建 `tests/test_turn_start_v4.py`：

```python
"""turn-start v4 tests — 覆盖设计稿 §8 全部 10 个验收场景。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def project(tmp_path, monkeypatch):
    """搭一个干净的项目根 + .runtime + characters。"""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("RUNTIME_DIR", str(tmp_path / ".runtime"))
    monkeypatch.setenv("CHARACTERS_DIR", str(tmp_path / "characters"))
    return tmp_path


def test_stage_a_no_characters_dir(project):
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, reason = detect_stage()
    assert stage == "A"
    assert "characters" in reason


def test_stage_b_empty_characters_dir(project):
    (project / "characters").mkdir()
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, reason = detect_stage()
    assert stage == "B"
    assert "空" in reason or "empty" in reason.lower()


def test_stage_c_active_missing(project):
    (project / "characters" / "holy").mkdir(parents=True)
    (project / "characters" / "holy" / "spec.md").write_text("# 圣灵\n治愈系\n")
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, reason = detect_stage()
    assert stage == "C"


def test_stage_c_active_invalid_id(project):
    (project / "characters" / "holy").mkdir(parents=True)
    (project / "characters" / "holy" / "spec.md").write_text("# 圣灵\n")
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "ghost-not-exists", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, _ = detect_stage()
    assert stage == "C"


def test_stage_c_active_spec_missing(project):
    """active 指向的角色目录在，但 spec.md 不存在 → 视为失效。"""
    (project / "characters" / "holy").mkdir(parents=True)
    # 没有 spec.md
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, _ = detect_stage()
    assert stage == "C"


def test_stage_d_active_ok(project):
    (project / "characters" / "holy").mkdir(parents=True)
    (project / "characters" / "holy" / "spec.md").write_text("# 圣灵\n")
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    from skill.character_workflow.lib.turn_start import detect_stage
    stage, _ = detect_stage()
    assert stage == "D"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_turn_start_v4.py -v`
Expected: `ModuleNotFoundError: No module named 'skill.character_workflow.lib.turn_start'`。

- [ ] **Step 3: 写最小实现**

新建 `skill/character_workflow/lib/turn_start.py`：

```python
"""turn-start v4 — file system stage probe + intent inference.

公共 API：
- detect_stage() → (stage, reason)：探测 file system 走 A/B/C/D 哪条路
- list_recent_chars() → [RecentCharacter, ...]：列已有角色 + tagline
- infer_intent(message, drafts, active_id) → (intent, signal, conflict)：stage D 意图推断
- turn_start(kind, message) → TurnStartResult：编排器，组装 v4 JSON

文件路径走 PROJECT_ROOT / RUNTIME_DIR / CHARACTERS_DIR 三个环境变量，方便测试 monkeypatch。
"""
from __future__ import annotations

import os
from pathlib import Path


def _project_root() -> Path:
    return Path(os.environ.get("PROJECT_ROOT", Path.cwd()))


def _runtime_dir() -> Path:
    return Path(os.environ.get("RUNTIME_DIR", ".runtime"))


def _characters_dir() -> Path:
    return Path(os.environ.get("CHARACTERS_DIR", "characters"))


def detect_stage() -> tuple[str, str]:
    """Return (stage, human-readable reason). Stage values: A/B/C/D."""
    chars = _characters_dir()
    if not chars.exists():
        return "A", "characters/ 目录不存在"
    subs = [p for p in chars.iterdir() if p.is_dir()]
    if not subs:
        return "B", "characters/ 为空"

    active_file = _runtime_dir() / "active-character.json"
    if not active_file.exists():
        return "C", "active-character.json 不存在"

    import json
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

    return "D", "active 完整"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_turn_start_v4.py -v`
Expected: 6 PASS。

- [ ] **Step 5: ruff 检查 + commit**

```bash
uv run ruff check skill/character_workflow/lib/turn_start.py tests/test_turn_start_v4.py
git add skill/character_workflow/lib/turn_start.py tests/test_turn_start_v4.py
git commit -m "feat(turn-start): add detect_stage() for v4 file-system probe"
```

---

## Task 3: `list_recent_chars()` —— Related Discovery helper

**Files:**
- Modify: `skill/character_workflow/lib/turn_start.py`
- Modify: `tests/test_turn_start_v4.py`

- [ ] **Step 1: 写失败测试 —— tagline 抽取**

在 `tests/test_turn_start_v4.py` 追加：

```python
def test_list_recent_chars_empty(project):
    from skill.character_workflow.lib.turn_start import list_recent_chars
    assert list_recent_chars() == []


def test_list_recent_chars_skips_non_dirs(project):
    chars = project / "characters"
    chars.mkdir()
    (chars / "a-file.txt").write_text("noise")
    from skill.character_workflow.lib.turn_start import list_recent_chars
    assert list_recent_chars() == []


def test_list_recent_chars_extracts_tagline(project):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text(
        "# 圣灵祭祀\n\n治愈系女性祭祀，金白配色，兜帽低垂遮眼\n## 风格\n..."
    )
    from skill.character_workflow.lib.turn_start import list_recent_chars
    result = list_recent_chars()
    assert len(result) == 1
    assert result[0]["id"] == "holy"
    assert "治愈系" in result[0]["tagline"]
    assert len(result[0]["tagline"]) <= 30


def test_list_recent_chars_no_spec(project):
    chars = project / "characters"
    (chars / "ghost").mkdir(parents=True)
    # no spec.md
    from skill.character_workflow.lib.turn_start import list_recent_chars
    result = list_recent_chars()
    assert result == [{"id": "ghost", "tagline": ""}]


def test_list_recent_chars_sorted(project):
    chars = project / "characters"
    for name in ("zelda", "alex", "mira"):
        (chars / name).mkdir(parents=True)
        (chars / name / "spec.md").write_text(f"# {name}\n短描述-{name}\n")
    from skill.character_workflow.lib.turn_start import list_recent_chars
    result = list_recent_chars()
    assert [r["id"] for r in result] == ["alex", "mira", "zelda"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_turn_start_v4.py -v -k "recent_chars"`
Expected: 5 FAIL, `ImportError: cannot import name 'list_recent_chars'`。

- [ ] **Step 3: 写最小实现**

在 `skill/character_workflow/lib/turn_start.py` 末尾追加：

```python
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_turn_start_v4.py -v -k "recent_chars"`
Expected: 5 PASS。

- [ ] **Step 5: ruff + commit**

```bash
uv run ruff check skill/character_workflow/lib/turn_start.py tests/test_turn_start_v4.py
git add skill/character_workflow/lib/turn_start.py tests/test_turn_start_v4.py
git commit -m "feat(turn-start): list_recent_chars() for stage C/D related discovery"
```

---

## Task 4: `infer_intent()` —— stage D 意图推断

**Files:**
- Modify: `skill/character_workflow/lib/turn_start.py`
- Modify: `tests/test_turn_start_v4.py`

- [ ] **Step 1: 写失败测试 —— 5 条规则**

在 `tests/test_turn_start_v4.py` 追加：

```python
def test_intent_default_no_drafts_no_message():
    from skill.character_workflow.lib.turn_start import infer_intent
    intent, signal, conflict = infer_intent(message=None, drafts=[], active_id="holy")
    assert intent == "new"
    assert signal == "default"
    assert conflict is False


def test_intent_revise_when_drafts_nonempty():
    from skill.character_workflow.lib.turn_start import infer_intent
    intent, signal, conflict = infer_intent(
        message=None,
        drafts=[{"path": "x.md", "text": "调色"}],
        active_id="holy",
    )
    assert intent == "revise"
    assert signal == "drafts_present"
    assert conflict is False


def test_intent_create_when_keyword_in_message():
    from skill.character_workflow.lib.turn_start import infer_intent
    for msg in ("新建一个角色叫光辉骑士", "我想做个新角色", "另一个角色"):
        intent, signal, _ = infer_intent(message=msg, drafts=[], active_id="holy")
        assert intent == "create", f"msg={msg!r}"
        assert signal == "new_keyword"


def test_intent_switch_when_slash_command_different_id():
    from skill.character_workflow.lib.turn_start import infer_intent
    intent, signal, _ = infer_intent(
        message="/character-workflow ghost-knight 继续",
        drafts=[],
        active_id="holy",
    )
    assert intent == "switch"
    assert signal == "switch_keyword"


def test_intent_switch_same_id_falls_back_to_new():
    """/character-workflow holy 但 active 已经是 holy → 不算 switch。"""
    from skill.character_workflow.lib.turn_start import infer_intent
    intent, signal, _ = infer_intent(
        message="/character-workflow holy",
        drafts=[],
        active_id="holy",
    )
    assert intent == "new"
    assert signal == "default"


def test_intent_conflict_drafts_plus_new_keyword():
    from skill.character_workflow.lib.turn_start import infer_intent
    intent, signal, conflict = infer_intent(
        message="新建一个角色",
        drafts=[{"path": "x.md", "text": "改 holy 的色"}],
        active_id="holy",
    )
    assert conflict is True
    # 冲突时 intent 设为 None 让 Skill 必走 AskUserQuestion
    assert intent is None
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_turn_start_v4.py -v -k "intent"`
Expected: 6 FAIL, `ImportError: cannot import name 'infer_intent'`。

- [ ] **Step 3: 写最小实现**

在 `skill/character_workflow/lib/turn_start.py` 末尾追加：

```python
import re

# 设计稿 §4.4 关键词清单。本轮写死，后续扩展时再抽到 YAML。
_NEW_KEYWORDS = ("新建", "新角色", "另一个角色")
_SLASH_CMD_RE = re.compile(r"/character-workflow\s+([\w\-]+)")


def infer_intent(
    message: str | None,
    drafts: list[dict],
    active_id: str | None,
) -> tuple[str | None, str, bool]:
    """Return (intent, signal, conflict).

    设计稿 §4.4 4 条规则：
    - drafts 非空 → revise
    - 消息含 "新建/新角色/另一个角色" → create
    - 消息含 "/character-workflow <name>" 且 name != active_id → switch
    - 都不匹配 → new（default）

    多信号同时命中（drafts 非空 + new_keyword 或 switch_keyword）→ conflict=True, intent=None。
    """
    signals: list[tuple[str, str]] = []  # (intent, signal)

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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_turn_start_v4.py -v -k "intent"`
Expected: 6 PASS。

- [ ] **Step 5: ruff + commit**

```bash
uv run ruff check skill/character_workflow/lib/turn_start.py tests/test_turn_start_v4.py
git add skill/character_workflow/lib/turn_start.py tests/test_turn_start_v4.py
git commit -m "feat(turn-start): infer_intent() for stage D smart-skip"
```

---

## Task 5: `turn_start()` 编排器 —— 组装 TurnStartResult

**Files:**
- Modify: `skill/character_workflow/lib/turn_start.py`
- Modify: `tests/test_turn_start_v4.py`

- [ ] **Step 1: 写失败测试 —— 端到端 4 个 stage**

在 `tests/test_turn_start_v4.py` 追加：

```python
def test_turn_start_stage_a_payload(project):
    from skill.character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    assert r["stage"] == "A"
    assert r["intent"] is None
    assert r["active_id"] is None
    assert r["spec"] is None
    assert r["recent_chars"] == []


def test_turn_start_stage_b_payload(project):
    (project / "characters").mkdir()
    from skill.character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    assert r["stage"] == "B"
    assert r["intent"] is None
    assert r["active_id"] is None
    assert r["recent_chars"] == []


def test_turn_start_stage_c_payload(project):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n治愈系祭祀\n")
    (chars / "alex").mkdir()
    (chars / "alex" / "spec.md").write_text("# 亚历克斯\n剑士定位\n")
    # 不写 active-character.json → stage C
    from skill.character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    assert r["stage"] == "C"
    assert r["intent"] is None
    assert len(r["recent_chars"]) == 2
    ids = sorted(c["id"] for c in r["recent_chars"])
    assert ids == ["alex", "holy"]


def test_turn_start_stage_d_default_new(project):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n治愈系\n")
    runtime = project / ".runtime"
    runtime.mkdir()
    import json
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    from skill.character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    assert r["stage"] == "D"
    assert r["intent"] == "new"
    assert r["intent_signal"] == "default"
    assert r["intent_conflict"] is False
    assert r["active_id"] == "holy"
    assert "圣灵" in r["spec"]


def test_turn_start_stage_d_with_drafts(project, monkeypatch):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n")
    runtime = project / ".runtime"
    runtime.mkdir()
    import json
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    draft_dir = runtime / "draft"
    draft_dir.mkdir()
    (draft_dir / "holy-2026.md").write_text("color: more golden\n")
    monkeypatch.setenv("DRAFT_DIR", str(draft_dir))
    from skill.character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    assert r["stage"] == "D"
    assert r["intent"] == "revise"
    assert r["intent_signal"] == "drafts_present"


def test_turn_start_stage_d_conflict(project, monkeypatch):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n")
    runtime = project / ".runtime"
    runtime.mkdir()
    import json
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    draft_dir = runtime / "draft"
    draft_dir.mkdir()
    (draft_dir / "holy-2026.md").write_text("调色\n")
    monkeypatch.setenv("DRAFT_DIR", str(draft_dir))
    from skill.character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message="新建一个光辉骑士")
    assert r["stage"] == "D"
    assert r["intent"] is None
    assert r["intent_conflict"] is True


def test_turn_start_schema_validates(project):
    """编排器返回的 dict 必须能通过 TurnStartResult Pydantic 校验。"""
    from skill.character_workflow.lib.schemas import TurnStartResult
    from skill.character_workflow.lib.turn_start import turn_start
    r = turn_start(kind="portrait", message=None)
    parsed = TurnStartResult.model_validate(r)
    assert parsed.stage.value == "A"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_turn_start_v4.py -v -k "turn_start_stage or turn_start_schema"`
Expected: 7 FAIL（`turn_start` 未定义）。

- [ ] **Step 3: 写最小实现**

在 `skill/character_workflow/lib/turn_start.py` 末尾追加：

```python
def turn_start(kind: str = "portrait", message: str | None = None) -> dict:
    """v4 编排器：file system 探 stage + 读 active + 推 intent + 拉上下文。

    返回 dict（JSON 序列化用）；调用方需要时可用 TurnStartResult.model_validate 校验。
    """
    # 延迟导入避免循环依赖（draft_processor / context_loader / active_character）
    from skill.character_workflow.lib.active_character import read_active
    from skill.character_workflow.lib.context_loader import load_lessons, load_worldview
    from skill.character_workflow.lib.draft_processor import process_drafts

    stage, reason = detect_stage()
    active = read_active() if stage in ("C", "D") else None
    active_id = active.active_id if active else None
    active_updated_at = active.updated_at if active else ""

    drafts = process_drafts() if stage == "D" else []
    spec = _read_active_spec(active_id) if stage == "D" else None
    recent = list_recent_chars() if stage in ("C", "D") else []

    if stage == "D":
        intent, signal, conflict = infer_intent(message, drafts, active_id)
    else:
        intent, signal, conflict = None, "none", False

    return {
        "stage": stage,
        "stage_reason": reason,
        "intent": intent,
        "intent_signal": signal,
        "intent_conflict": conflict,
        "recent_chars": recent,
        "drafts": drafts,
        "active_id": active_id,
        "active_updated_at": active_updated_at,
        "spec": spec,
        "worldview": load_worldview(),
        "lessons": load_lessons(kind),
        "lessons_kind": kind,
    }


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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_turn_start_v4.py -v`
Expected: 全部 PASS（Tasks 2-5 累计 ~22 tests）。

- [ ] **Step 5: ruff + commit**

```bash
uv run ruff check skill/character_workflow/lib/turn_start.py tests/test_turn_start_v4.py
git add skill/character_workflow/lib/turn_start.py tests/test_turn_start_v4.py
git commit -m "feat(turn-start): turn_start() orchestrator returns v4 schema"
```

---

## Task 6: CLI 接入 —— `--message` 参数 + 迁移 `turn_start`

**Files:**
- Modify: `skill/character_workflow/__main__.py`
- Test: `tests/test_turn_start_v4.py`（追加 CLI 集成测试）

- [ ] **Step 1: 写失败测试 —— CLI 输出含 stage 字段**

在 `tests/test_turn_start_v4.py` 追加：

```python
def test_cli_turn_start_stage_a(project, capsys):
    from skill.character_workflow.__main__ import main
    rc = main(["turn-start"])
    assert rc == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["stage"] == "A"
    assert payload["intent"] is None


def test_cli_turn_start_with_message(project, capsys, monkeypatch):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n")
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    from skill.character_workflow.__main__ import main
    rc = main(["turn-start", "--message", "新建一个光辉骑士"])
    assert rc == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["stage"] == "D"
    assert payload["intent"] == "create"
    assert payload["intent_signal"] == "new_keyword"


def test_cli_turn_start_no_message_defaults_to_new(project, capsys):
    chars = project / "characters"
    (chars / "holy").mkdir(parents=True)
    (chars / "holy" / "spec.md").write_text("# 圣灵\n")
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "holy", "updated_at": "2026-05-19T00:00:00+00:00"})
    )
    from skill.character_workflow.__main__ import main
    rc = main(["turn-start"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["intent"] == "new"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `uv run pytest tests/test_turn_start_v4.py -v -k "cli_turn_start"`
Expected: 3 FAIL（`--message` 参数不识别 / 返回老 schema 缺 stage 字段）。

- [ ] **Step 3: 修改 `__main__.py` —— 删旧 `turn_start`、加 `--message`**

把 `skill/character_workflow/__main__.py` 改成：

```python
"""character-workflow CLI — turn 起始一步合一，省 Python 冷启。

用法：
  python -m skill.character_workflow turn-start [--kind portrait|promo|turnaround] [--message "..."]
  python -m skill.character_workflow set-active <id>
  python -m skill.character_workflow append-lesson --kind portrait --line "...经验..."
"""
from __future__ import annotations

import argparse
import json
import sys

from skill.character_workflow.lib.active_character import write_active
from skill.character_workflow.lib.lessons import append_lesson
from skill.character_workflow.lib.turn_start import turn_start


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="character-workflow")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_turn = sub.add_parser("turn-start", help="v4: 探 stage + 推 intent + 拉上下文")
    p_turn.add_argument("--kind", default="portrait", choices=("portrait", "promo", "turnaround"))
    p_turn.add_argument(
        "--message",
        default=None,
        help="画师本轮最近一条消息原文，用于 stage D intent 推断",
    )

    p_set = sub.add_parser("set-active", help="切换活跃角色")
    p_set.add_argument("character_id", nargs="?", default=None)

    p_lesson = sub.add_parser("append-lesson", help="原子追加一条历代经验到 lessons/<kind>.md")
    p_lesson.add_argument("--kind", required=True, choices=("portrait", "promo", "turnaround"))
    p_lesson.add_argument("--line", required=True, help="完整一行 markdown，不带换行")

    args = parser.parse_args(argv)
    if args.cmd == "turn-start":
        print(json.dumps(turn_start(args.kind, args.message), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "set-active":
        result = write_active(args.character_id or None)
        print(json.dumps({"active_id": result.active_id, "updated_at": result.updated_at}, ensure_ascii=False))
        return 0
    if args.cmd == "append-lesson":
        path = append_lesson(args.kind, args.line)
        print(json.dumps({"ok": True, "path": str(path)}, ensure_ascii=False))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 跑测试确认通过**

Run: `uv run pytest tests/test_turn_start_v4.py -v`
Expected: 全部 PASS。

- [ ] **Step 5: 跑全量 pytest 确认无回归**

Run: `uv run pytest -v`
Expected: 全部 PASS（v3 旧调用路径 `python -m skill.character_workflow turn-start` 无 `--message` 仍然能跑，因为 `--message` 默认 `None`）。

如果有测试因为依赖老 `turn_start()` 在 `__main__.py` 里而炸，把它们改成 `from skill.character_workflow.lib.turn_start import turn_start`。

- [ ] **Step 6: ruff + commit**

```bash
uv run ruff check skill/character_workflow/__main__.py
git add skill/character_workflow/__main__.py tests/test_turn_start_v4.py
git commit -m "feat(cli): turn-start --message + delegate to lib.turn_start"
```

---

## Task 7: SKILL.md v4 改造

**Files:**
- Modify: `skill/character_workflow/SKILL.md`

- [ ] **Step 1: 改 frontmatter version**

把 SKILL.md 顶部 frontmatter 的 `version: 3.0.0` 改为 `version: 4.0.0`。

- [ ] **Step 2: 重写 `## Turn 起始` 章节**

把现有 `## Turn 起始（每次 turn 必做）` 整段（从 `## Turn 起始` 到下一个 `## ` 之前，含 JSON 示例与"跳过条件"）替换为：

```markdown
## Turn 起始（每次 turn 必做 —— 4 stage 分支）

每轮开头先调一次 CLI：

```bash
uv run python -m skill.character_workflow turn-start --message "<画师本轮原文>"
# 出图 promo/turnaround 时显式加 --kind 切换对应 lessons
```

**`--message` 必传**：把画师本轮最近一条消息原文（含 `/character-workflow X` 之类的命令前缀）整段塞进去。intent 推断靠它。

返回 JSON：

```json
{
  "stage":           "A" | "B" | "C" | "D",
  "stage_reason":    "characters/ 目录不存在",
  "intent":          "new" | "revise" | "create" | "switch" | null,
  "intent_signal":   "drafts_present" | "new_keyword" | "switch_keyword" | "default" | "conflict" | "none",
  "intent_conflict": false,
  "recent_chars":    [{"id": "holy", "tagline": "治愈系祭祀，金白配色"}],
  "drafts":          [...],
  "active_id":       "holy",
  "active_updated_at": "2026-05-19T08:00:00+00:00",
  "spec":            "<markdown>" | null,
  "worldview":       "<markdown>",
  "lessons":         "<markdown>",
  "lessons_kind":    "portrait"
}
```

按 `stage` 分叉，不要自己重新探测 file system：

### Stage A —— `characters/` 目录不存在

**用 1 个 AskUserQuestion 同时问 3 题**（AskUserQuestion 支持 1-4 题 per call）：

1. **项目名**（默认 git basename，画师可改）
2. **一句话世界观**（10-30 字，影响后续 prompt 质量）
3. **第一个角色名 + 一句话定位**（如 `圣灵祭祀 / 治愈系女性祭祀，金白配色`）

画师答完后落盘：
- 写 `worldview.md`（画师输入的世界观）
- 写 `.runtime/projects.json` `{"projects":[{"id":"<proj-id>","name":"<项目名>","created_at":"..."}],"assignments":{"<char-id>":"<proj-id>"}}`
- `characters/<char-id>/spec.md`（spec 模板，定位字段填画师输入）
- `.runtime/active-character.json` `{"active_id":"<char-id>","updated_at":"..."}`

完成后直接进入 stage D 出图对话——**不重新调 turn-start**，沿用已有 worldview / 新建的 spec 继续做。

### Stage B —— 有项目但 `characters/` 为空

**用 1 个 AskUserQuestion 问 1 题：**
> 项目里还没有角色。第一个角色名 + 一句话定位（≤20 字）。
> 示例：`圣灵祭祀 / 治愈系女性祭祀，金白配色`

落盘：
- `characters/<char-id>/spec.md`（spec 模板）
- `.runtime/active-character.json`

完成后进 stage D。

### Stage C —— `active-character.json` 缺失或失效

**用 AskUserQuestion 列 N+2 选项**（参考 `recent_chars` 的 `id` 和 `tagline`）：

- 已有角色 1（tagline 1）
- 已有角色 2（tagline 2）
- ...
- 新建一个角色
- 跳过本轮（不出图）

画师选已有 → 写 `.runtime/active-character.json` → 进 stage D。
画师选新建 → 走 stage B 流程。
画师选跳过 → 退出 turn，不动 file system。

### Stage D —— 正常回流（默认不打扰）

按 `intent` 字段分叉，**不要问画师**（除非 `intent_conflict: true`）：

| intent | 行为 |
|---|---|
| `new` | 默认。走出图 8 段式 prompt → PENDING_CONFIRM 卡片 |
| `revise` | drafts 非空。先读 drafts 内容，融进 prompt 修订，再 PENDING_CONFIRM |
| `create` | 消息含"新建"关键词。即时转 stage B 流程问"新角色名 + 定位" |
| `switch` | 消息含 `/character-workflow Y` 且 Y ≠ active。写 `active-character.json={"active_id":"Y"}` 后**重新调一次** turn-start |
| `null` + `intent_conflict: true` | 信号冲突（如 drafts 非空 + 消息有"新建"）。用 AskUserQuestion 让画师二选一：A "继续改当前角色的图" / B "新建另一个角色" |

把 `worldview` + `lessons` + `spec` 拼成对话前缀（建议走 `lib.prompt_builder.assemble_character_prompt`），它们就是这一轮的专家上下文。

## Painter Intent 推断（仅 stage D —— CLI 已算好，Skill 直接读）

CLI 端 `infer_intent()` 已在 turn-start 时算好结果。Skill 端读 `intent` 和 `intent_conflict` 字段即可，**不要自己重写推断逻辑**。规则（参考）：

1. `drafts` 非空 → `revise`，signal=`drafts_present`
2. message 含"新建 / 新角色 / 另一个角色" → `create`，signal=`new_keyword`
3. message 含 `/character-workflow <name>` 且 name ≠ active_id → `switch`，signal=`switch_keyword`
4. 都不匹配 → `new`，signal=`default`
5. 多信号同时命中 → `intent=null`, `intent_conflict=true`

## Related Discovery（stage C / D 列角色用）

`recent_chars` 数组提供 `id` + `tagline`：tagline 从 `characters/<id>/spec.md` 首行非空、非标题 markdown 内容截取，≤30 字。stage C 列选项时直接用这两个字段拼"角色 id（tagline）"显示，让画师快速分辨。

## 切换处理对象

```bash
uv run python -m skill.character_workflow set-active <character-id>
```

stage D 推断到 `switch` 时 Skill 自动调一次，**然后必须重新 turn-start**（新 active 才能反映到 spec / drafts / recent_chars）。
```

- [ ] **Step 3: 删旧"跳过条件"段落**

原 SKILL.md 末尾的：

```markdown
**跳过条件**：用户消息明显是 git/代码/纯问答 → 跳过。没有 active_id 且没有 draft → 问"想处理哪个角色？"，不要凭空创建文件。
```

替换为：

```markdown
## 何时跳过本 Skill

- 用户消息明显是 git / 代码 / 部署 / 纯问答 → 完全跳过 turn-start
- 不要在用户没有触发 character-workflow 时主动推角色话题
- Stage A/B/C 时画师选"跳过本轮" → 退出 turn，不动 file system
- v3 的兜底逻辑"没有 active_id 且没有 draft → 问'哪个角色？'"已被 4 stage 协议替代，**不再适用**
```

- [ ] **Step 4: 人工验证 SKILL.md 一致性**

打开 `skill/character_workflow/SKILL.md`，从顶到底通读一遍：
- 没有任何"v3" / "三件套上下文" 等老 v3 残留概念？
- `## Painter Intent 推断` 描述的规则和 `lib/turn_start.py` 的 `_NEW_KEYWORDS` / `_SLASH_CMD_RE` 完全一致？
- 4 stage 的"何时落盘哪个文件"和 Tasks 2-5 的 `detect_stage` 判定逻辑完全一致？

发现不一致 → 改 SKILL.md 文字（不改 Python，Python 是 source of truth）。

- [ ] **Step 5: commit**

```bash
git add skill/character_workflow/SKILL.md
git commit -m "docs(skill): turn-start v4 SKILL.md rewrite (4-stage + intent)"
```

---

## Task 8: 全量回归 + Web schema 核对 + ruff

**Files:** 全仓库扫一遍。

- [ ] **Step 1: 跑全量 pytest**

Run: `uv run pytest -v`
Expected: ALL PASS（含 v4 新增 ~25 个 test + v3 老 test 全部不回归）。

如果有 fail：
- 旧 test 调 `from skill.character_workflow.__main__ import turn_start`？→ 改 import 路径到 `from skill.character_workflow.lib.turn_start import turn_start`
- 旧 test 断言 v3 schema 字段（无 `stage`）？→ 改断言成兼容 v4 字段（v4 是 superset，v3 字段全保留），或直接迁移到 v4 schema

- [ ] **Step 2: 跑 ruff**

Run: `uv run ruff check skill tests`
Expected: 0 issues。有 issue 就修。

- [ ] **Step 3: 跑前端 tsc**

```bash
cd web && pnpm lint
```

Expected: 0 issues。

- [ ] **Step 4: 核对 web/src/schema/jobs.ts —— 确认无需同步**

读 `web/src/schema/jobs.ts`，确认：
- 没有 `TurnStartResult` 类型
- 没有任何代码消费 turn-start CLI 输出

确认 turn-start 输出是 CLI → Skill（Claude）的 JSON，**Web 不消费**。在 PR description 里明确写"web schema 无需同步"。

如果未来 Web 真的要读 turn-start 结果（如 viewer-server 加 `GET /api/turn-start`），届时再同步——本轮不做。

- [ ] **Step 5: 手动 smoke —— 触发 4 个 stage**

```bash
# stage A：删 characters/ + .runtime/
trash characters/ .runtime/  # 用 trash 不用 rm，CLAUDE.md 规定
uv run python -m skill.character_workflow turn-start --message "做个新角色"
# Expected: JSON 含 "stage":"A"

# 撤回
git restore characters/ .runtime/  # 或从 trash 复原

# stage D：默认
uv run python -m skill.character_workflow turn-start --message "出张图"
# Expected: stage:D, intent:new, signal:default

# stage D switch
uv run python -m skill.character_workflow turn-start \
  --message "/character-workflow another-char 切换"
# Expected: stage:D, intent:switch（前提是 another-char ≠ 当前 active）

# stage D conflict（需要先 touch 个 draft 文件再跑）
touch .runtime/draft/test.md && echo "调色" > .runtime/draft/test.md
uv run python -m skill.character_workflow turn-start --message "新建一个新角色"
# Expected: stage:D, intent:null, intent_conflict:true
trash .runtime/draft/test.md
```

- [ ] **Step 6: commit + 写 memory**

```bash
git add -A  # 这步前先 git status 确认没有意外
git status  # 检查
git commit -m "test(turn-start): full regression + manual smoke for v4"
```

按 CLAUDE.md MEMORY 协议追加日志：
- 项目日志 `memory/daily/2026-05-19.md` 追加一段
- 全局月志 `~/.claude/memory/monthly/2026-05.md` 追加一行

---

## Self-Review 检查表

写完上面 8 个 task 后自检：

**1. Spec 覆盖检查（设计稿 §8 验收 10 条）**

| # | 设计稿验收 | 落在哪个 Task |
|---|---|---|
| 1 | 冷启动（A） | Task 2 test_stage_a_no_characters_dir + Task 5 test_turn_start_stage_a_payload + Task 8 smoke |
| 2 | 空项目（B） | Task 2 test_stage_b_empty + Task 5 test_turn_start_stage_b_payload |
| 3 | 选角色（C） | Task 2 test_stage_c_active_missing + Task 5 test_turn_start_stage_c_payload |
| 4 | 正常回流（D） | Task 5 test_turn_start_stage_d_default_new + Task 8 smoke |
| 5 | draft 推断 | Task 4 test_intent_revise + Task 5 test_turn_start_stage_d_with_drafts |
| 6 | 新建推断 | Task 4 test_intent_create + Task 6 test_cli_turn_start_with_message |
| 7 | switch 推断 | Task 4 test_intent_switch_when_slash_command_different_id |
| 8 | 冲突 | Task 4 test_intent_conflict + Task 5 test_turn_start_stage_d_conflict + Task 8 smoke |
| 9 | 失效 active | Task 2 test_stage_c_active_invalid_id |
| 10 | 损坏 spec | Task 2 test_stage_c_active_spec_missing |

✅ 10/10 全覆盖。

**2. 占位符扫描**

无 TBD / TODO / "类似 Task N" / "适当错误处理" 等占位符；每个步骤都有具体代码或具体命令。

**3. 类型 / 命名一致性**

- `TurnStage` enum 值 `"A"/"B"/"C"/"D"` 与 `detect_stage()` 返回字符串完全一致 ✅
- `IntentKind` enum 值 `"new"/"revise"/"create"/"switch"` 与 `infer_intent()` 返回字符串完全一致 ✅
- `RecentCharacter` 字段 `id` + `tagline` 与 `list_recent_chars()` 返回 dict key 完全一致 ✅
- `TurnStartResult` 字段集与 `turn_start()` 返回 dict key 完全一致 ✅
- CLI `--message` 参数名与 `infer_intent(message=...)` / `turn_start(message=...)` 完全一致 ✅

**4. NOT in scope 不超纲**

按设计稿 §9，本计划不动：
- ❌ Painter Profile（跨 session 偏好累积）
- ❌ Mandatory alternatives（出图前 3 个 prompt 备选）
- ❌ Tier 系统
- ❌ Phase 2.5 风格搜索
- ❌ 强人设 `personas/character-helper.md`
- ❌ 失败/兜底 worldview 损坏处理（边界条件，单元测试覆盖即可）

确认无任何 task 提到上述项 ✅。

**5. 工作量校核**

| Task | 估时 |
|---|---|
| T1 Schema | 15 min |
| T2 detect_stage | 20 min |
| T3 list_recent_chars | 15 min |
| T4 infer_intent | 20 min |
| T5 turn_start orchestrator | 25 min |
| T6 CLI 接入 | 15 min |
| T7 SKILL.md v4 | 30 min |
| T8 全量回归 + smoke | 25 min |
| **合计** | **~2 小时 45 分** |

与设计稿 §10 估的 2.5 小时基本对齐。

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-05-19 character-workflow turn-start v4 实施计划.md`.

执行选项二选一：

1. **Subagent-Driven**（推荐）—— 每个 Task 派一个 fresh subagent，Task 间 review 一次，快速迭代
2. **Inline Execution** —— 当前 session 顺序跑 8 个 Task，每 2-3 个 Task checkpoint review 一次

哪个？
