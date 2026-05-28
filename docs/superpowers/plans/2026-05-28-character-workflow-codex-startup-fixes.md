# Character Workflow Codex Startup Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/character-workflow` start cleanly in Codex and Claude Code after the recent large refactors, with no broken bootstrap path, no manual `PYTHONPATH`, no JSON serialization crash, no polluted character choices, and explicit Codex user-choice instructions.

**Architecture:** Treat startup as a contract across three layers: Python CLI/runtime, filesystem stage detection, and Skill documentation. First make the Python module invocable through the project environment, then fix concrete `turn-start` data bugs, then update Skill docs and doc-smoke tests so Claude Code and Codex have separate but equivalent interaction paths.

**Tech Stack:** Python 3.11+, uv, pytest, Pydantic v2, Markdown Skill docs.

---

## Scope Check

This plan touches one workflow surface (`character-workflow`) but spans three implementation layers. Keep it as one plan because all tasks are required for a single testable outcome: invoking `/character-workflow` in Codex reaches the correct ask/render decision without command failures or schema crashes.

Do not advance any character generation flow while implementing this plan. The success criterion is startup readiness and correct ask protocol, not image generation.

## File Structure

- Modify `pyproject.toml`
  - Responsibility: package the `src/` modules so `uv run python -m character_workflow ...` works without manual `PYTHONPATH=src`.
- Modify `src/character_workflow/lib/keys.py`
  - Responsibility: expose secret-free, JSON-serializable key metadata to `turn-start`.
- Modify `src/character_workflow/lib/turn_start.py`
  - Responsibility: filter non-character directories and expose placeholder-spec state to the decision layer.
- Modify `src/character_workflow/lib/intent.py`
  - Responsibility: account for placeholder specs before recommending render.
- Modify `src/character_workflow/lib/schemas.py`
  - Responsibility: keep the `TurnStartResult` contract synchronized with new `spec_status`.
- Modify `src/character_workflow/__main__.py`
  - Responsibility: serialize Pydantic objects safely at CLI boundaries.
- Modify `skills/character-workflow/SKILL.md`
  - Responsibility: document dev/installed command selection, current viewer-server path, and Claude/Codex user-choice protocols.
- Modify `skills/character-promo/SKILL.md`, `skills/character-turnaround/SKILL.md`, `skills/viewer-server/SKILL.md`
  - Responsibility: remove stale bootstrap/viewer-server command assumptions that affect adjacent workflow startup.
- Create `tests/test_cli_startup_contract.py`
  - Responsibility: subprocess-level startup checks that catch missing package metadata and JSON serialization failures.
- Modify `tests/test_turn_start_keys.py`
  - Responsibility: verify `available_keys.models` is plain JSON data and secrets stay hidden.
- Modify `tests/test_turn_start_v4.py`
  - Responsibility: verify dot directories are excluded from recent characters and placeholder specs are surfaced.
- Create `tests/test_skill_docs_startup_contract.py`
  - Responsibility: static smoke tests that prevent stale command paths and require Codex choice documentation.

## Task 1: Make CLI Importable Without Manual PYTHONPATH

**Files:**
- Modify: `pyproject.toml`
- Create: `tests/test_cli_startup_contract.py`

- [ ] **Step 1: Write the failing subprocess test**

Create `tests/test_cli_startup_contract.py`:

```python
import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def _base_env(data_root: Path) -> dict[str, str]:
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env["CHARACTER_WORKFLOW_DATA_ROOT"] = str(data_root)
    return env


def test_turn_start_cli_runs_without_manual_pythonpath(isolated_data_root):
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "character_workflow",
            "turn-start",
            "--message",
            "/character-workflow",
        ],
        cwd=REPO_ROOT,
        env=_base_env(isolated_data_root),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["stage"] == "A"
    assert payload["recommend_action"] == "ask"
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
uv run pytest -q tests/test_cli_startup_contract.py::test_turn_start_cli_runs_without_manual_pythonpath
```

Expected: FAIL with a subprocess stderr containing `No module named character_workflow`.

- [ ] **Step 3: Add package metadata for the src layout**

Modify `pyproject.toml` by adding a build backend and package list:

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = [
  "src/character_workflow",
  "src/character_promo",
  "src/character_turnaround",
  "src/viewer_server",
]
```

Keep the existing `[project]`, `[dependency-groups]`, `[tool.ruff]`, and `[tool.pytest.ini_options]` sections unchanged.

- [ ] **Step 4: Refresh the uv environment**

Run:

```bash
uv sync
```

Expected: command exits 0 and installs the local project into `.venv`.

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
uv run pytest -q tests/test_cli_startup_contract.py::test_turn_start_cli_runs_without_manual_pythonpath
```

Expected:

```text
1 passed
```

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml tests/test_cli_startup_contract.py
git commit -m "fix: package character workflow cli"
```

## Task 2: Keep turn-start Key Metadata JSON-Serializable

**Files:**
- Modify: `src/character_workflow/lib/keys.py`
- Modify: `tests/test_turn_start_keys.py`
- Modify: `tests/test_cli_startup_contract.py`

- [ ] **Step 1: Add failing assertions for structured model metadata**

Update `tests/test_turn_start_keys.py`:

```python
def test_turn_start_includes_available_keys_without_secrets(isolated_data_root):
    _seed_keys()
    out = turn_start(kind="portrait")
    assert "available_keys" in out
    assert len(out["available_keys"]) == 2
    for k in out["available_keys"]:
        assert "access_key" not in k
        assert "secret_key" not in k
    assert out["preferred_alias"] == "lov"
    assert out["available_keys"][0]["models"] == [
        {"name": "gpt_image_2", "id": "gpt_image_2"}
    ]
```

Append this test to `tests/test_cli_startup_contract.py`:

```python
def test_turn_start_cli_serializes_key_models(isolated_data_root):
    config = isolated_data_root / ".config"
    config.mkdir(exist_ok=True)
    (config / "keys.json").write_text(
        json.dumps(
            {
                "version": 1,
                "default_alias": "seedream",
                "keys": [
                    {
                        "alias": "seedream",
                        "provider": "seedream",
                        "access_key": "secret-value",
                        "secret_key": None,
                        "capabilities": ["portrait", "promo", "turnaround"],
                        "models": [
                            {
                                "name": "Doubao-Seedream-4.5",
                                "id": "doubao-seedream-4-5-251128",
                            }
                        ],
                        "notes": "",
                        "created_at": "2026-05-28T00:00:00+08:00",
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "character_workflow",
            "turn-start",
            "--message",
            "/character-workflow",
        ],
        cwd=REPO_ROOT,
        env=_base_env(isolated_data_root),
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["available_keys"][0]["models"] == [
        {"name": "Doubao-Seedream-4.5", "id": "doubao-seedream-4-5-251128"}
    ]
    assert "secret-value" not in result.stdout
```

- [ ] **Step 2: Run tests to verify failure before implementation**

Run:

```bash
uv run pytest -q tests/test_turn_start_keys.py tests/test_cli_startup_contract.py::test_turn_start_cli_serializes_key_models
```

Expected before implementation: FAIL with `TypeError: Object of type ModelSpec is not JSON serializable` or assertion mismatch where `models` contains Pydantic objects.

- [ ] **Step 3: Serialize models as plain dicts**

Modify `src/character_workflow/lib/keys.py`:

```python
def keys_for_turn_start() -> list[dict]:
    db = read_keys_db()
    return [
        {
            "alias": k.alias,
            "provider": k.provider,
            "capabilities": k.capabilities,
            "models": [m.model_dump() for m in k.models],
            "notes": k.notes,
            "is_default": k.alias == db.default_alias,
        }
        for k in db.keys
    ]
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
uv run pytest -q tests/test_turn_start_keys.py tests/test_cli_startup_contract.py::test_turn_start_cli_serializes_key_models
```

Expected:

```text
4 passed
```

- [ ] **Step 5: Commit**

```bash
git add src/character_workflow/lib/keys.py tests/test_turn_start_keys.py tests/test_cli_startup_contract.py
git commit -m "fix: serialize turn start key models"
```

## Task 3: Filter Non-Character Directories From recent_chars

**Files:**
- Modify: `src/character_workflow/lib/turn_start.py`
- Modify: `tests/test_turn_start_v4.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_turn_start_v4.py`:

```python
def test_recent_chars_skips_dot_directories(project):
    chars = project / "characters"
    (chars / ".runtime").mkdir(parents=True)
    (chars / ".runtime" / "spec.md").write_text("# internal\n", encoding="utf-8")
    (chars / "hero").mkdir(parents=True)
    (chars / "hero" / "spec.md").write_text("hero tagline\n", encoding="utf-8")

    from character_workflow.lib.turn_start import list_recent_chars

    out = list_recent_chars()
    assert out == [{"id": "hero", "tagline": "hero tagline"}]
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
uv run pytest -q tests/test_turn_start_v4.py::test_recent_chars_skips_dot_directories
```

Expected: FAIL because `.runtime` appears in the output.

- [ ] **Step 3: Filter dot-prefixed directories**

Modify `src/character_workflow/lib/turn_start.py` inside `list_recent_chars()`:

```python
    for sub in sorted(chars.iterdir()):
        if not sub.is_dir():
            continue
        if sub.name.startswith("."):
            continue
        spec = sub / "spec.md"
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
uv run pytest -q tests/test_turn_start_v4.py::test_recent_chars_skips_dot_directories
```

Expected:

```text
1 passed
```

- [ ] **Step 5: Commit**

```bash
git add src/character_workflow/lib/turn_start.py tests/test_turn_start_v4.py
git commit -m "fix: exclude internal character directories"
```

## Task 4: Surface Placeholder Specs Before Render Decisions

**Files:**
- Modify: `src/character_workflow/lib/turn_start.py`
- Modify: `src/character_workflow/lib/intent.py`
- Modify: `src/character_workflow/lib/schemas.py`
- Modify: `tests/test_turn_start_v4.py`

- [ ] **Step 1: Add failing tests for placeholder spec status**

Append to `tests/test_turn_start_v4.py`:

```python
def test_turn_start_marks_placeholder_spec(project):
    chars = project / "characters"
    (chars / "sun").mkdir(parents=True)
    (chars / "sun" / "spec.md").write_text(
        "# 孙尚香\n\n（尚无档案 — 请在终端 /character-workflow 对话补全）\n",
        encoding="utf-8",
    )
    runtime = project / ".runtime"
    runtime.mkdir()
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "sun", "updated_at": "2026-05-28T00:00:00+00:00"}),
        encoding="utf-8",
    )
    (runtime / "projects.json").write_text(
        json.dumps(
            {
                "projects": [
                    {
                        "id": "p-1",
                        "slug": "mahjong",
                        "name": "麻将游戏",
                        "created_at": "2026-05-28T00:00:00+00:00",
                    }
                ],
                "assignments": {"sun": "p-1"},
            }
        ),
        encoding="utf-8",
    )

    from character_workflow.lib.turn_start import turn_start

    out = turn_start(kind="portrait", message="出图")
    assert out["stage"] == "D"
    assert out["spec_status"] == "placeholder"
    assert out["recommend_action"] == "ask"
    assert "spec 仍是占位档案" in out["recommend_reason"]


def test_turn_start_marks_ready_spec(project):
    chars = project / "characters"
    (chars / "sun").mkdir(parents=True)
    (chars / "sun" / "spec.md").write_text(
        "# 孙尚香\n\n风格档：国风街机麻将角色，红金战袍，半身立绘。\n",
        encoding="utf-8",
    )
    runtime = project / ".runtime"
    runtime.mkdir()
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "sun", "updated_at": "2026-05-28T00:00:00+00:00"}),
        encoding="utf-8",
    )
    (runtime / "projects.json").write_text(
        json.dumps(
            {
                "projects": [
                    {
                        "id": "p-1",
                        "slug": "mahjong",
                        "name": "麻将游戏",
                        "created_at": "2026-05-28T00:00:00+00:00",
                    }
                ],
                "assignments": {"sun": "p-1"},
            }
        ),
        encoding="utf-8",
    )

    from character_workflow.lib.turn_start import turn_start

    out = turn_start(kind="portrait", message="出图")
    assert out["spec_status"] == "ready"
    assert out["recommend_action"] == "render_card"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest -q tests/test_turn_start_v4.py::test_turn_start_marks_placeholder_spec tests/test_turn_start_v4.py::test_turn_start_marks_ready_spec
```

Expected: FAIL because `spec_status` is absent and placeholder specs do not influence `recommend_action`.

- [ ] **Step 3: Add spec status detection**

Modify `src/character_workflow/lib/turn_start.py`:

```python
def _spec_status(spec: str | None) -> str:
    if spec is None:
        return "missing"
    stripped = spec.strip()
    if not stripped:
        return "placeholder"
    placeholder_markers = (
        "尚无档案",
        "请在终端 /character-workflow 对话补全",
    )
    if any(marker in stripped for marker in placeholder_markers):
        return "placeholder"
    meaningful_lines = [
        line.strip()
        for line in stripped.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    return "ready" if meaningful_lines else "placeholder"
```

In `turn_start()`, compute status after reading `spec`:

```python
    spec = _read_active_spec(active_id) if stage in ("D", "E") else None
    spec_status = _spec_status(spec)
```

Pass it to `compute_recommend_action()`:

```python
    action, action_reason = compute_recommend_action(
        stage=stage,
        message=message,
        drafts=drafts,
        active_age_minutes=age_min,
        last_job_status=last_status,
        active_id=active_id,
        spec_status=spec_status,
    )
```

Return it in the result dict:

```python
        "spec_status": spec_status,
```

- [ ] **Step 4: Update recommendation logic**

Modify `src/character_workflow/lib/intent.py` function signature:

```python
def compute_recommend_action(
    *,
    stage: str,
    message: str | None,
    drafts: list[dict],
    active_age_minutes: int | None,
    last_job_status: str | None,
    active_id: str | None,
    spec_status: str = "ready",
) -> tuple[str, str]:
```

Add this branch after the stage A/B/C/E checks and before render-verb checks:

```python
    if stage == "D" and spec_status != "ready":
        return "ask", f"spec 仍是占位档案（{spec_status}），需要先补全角色设定"
```

- [ ] **Step 5: Update schema contract**

Modify `src/character_workflow/lib/schemas.py` in `TurnStartResult`:

```python
    spec_status: str = "missing"
```

Place it next to `spec: str | None` so future readers see the relationship.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
uv run pytest -q tests/test_turn_start_v4.py::test_turn_start_marks_placeholder_spec tests/test_turn_start_v4.py::test_turn_start_marks_ready_spec tests/test_recommend_action.py
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/character_workflow/lib/turn_start.py src/character_workflow/lib/intent.py src/character_workflow/lib/schemas.py tests/test_turn_start_v4.py
git commit -m "fix: detect placeholder character specs"
```

## Task 5: Replace Stale Startup Commands in Skill Docs

**Files:**
- Modify: `skills/character-workflow/SKILL.md`
- Modify: `skills/character-promo/SKILL.md`
- Modify: `skills/character-turnaround/SKILL.md`
- Modify: `skills/viewer-server/SKILL.md`
- Create: `tests/test_skill_docs_startup_contract.py`

- [ ] **Step 1: Write doc smoke tests**

Create `tests/test_skill_docs_startup_contract.py`:

```python
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def _read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_character_workflow_docs_use_current_viewer_server_path():
    text = _read("skills/character-workflow/SKILL.md")
    assert "src/viewer_server/server.py start" in text
    assert "skill/viewer_server/server.py" not in text


def test_skill_docs_do_not_require_bare_python_command():
    for path in [
        "skills/character-workflow/SKILL.md",
        "skills/character-promo/SKILL.md",
        "skills/character-turnaround/SKILL.md",
        "skills/viewer-server/SKILL.md",
    ]:
        text = _read(path)
        assert "python ~/.claude/plugins/game-ui-ai-workflow/scripts/bootstrap.py" not in text


def test_character_workflow_docs_explain_dev_and_installed_bootstrap():
    text = _read("skills/character-workflow/SKILL.md")
    assert "Dev mode" in text
    assert "python3 scripts/bootstrap.py --check" in text
    assert "Installed Plugin mode" in text
    assert "python3 ~/.claude/plugins/game-ui-ai-workflow/scripts/bootstrap.py --check" in text
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest -q tests/test_skill_docs_startup_contract.py
```

Expected: FAIL because docs still contain stale bootstrap and viewer-server commands.

- [ ] **Step 3: Update `skills/character-workflow/SKILL.md` startup section**

Replace the bootstrap block with:

```markdown
## 启动自检（bootstrap）

每次触发本 Skill，第一步先判断当前模式：

- **Dev mode**：当前目录是仓库根，且存在 `pyproject.toml` 与 `scripts/bootstrap.py`
  - 运行：`python3 scripts/bootstrap.py --check`
- **Installed Plugin mode**：不在仓库根，使用已安装插件
  - 运行：`python3 ~/.claude/plugins/game-ui-ai-workflow/scripts/bootstrap.py --check`

不要使用裸 `python` 命令；macOS 上可能不存在。Codex / Claude Code 都优先使用 `python3`。
```

Replace the viewer-server command block with:

```markdown
## viewer-server 启停

每次调用本 Skill 时，Turn 起始之前先执行：

```bash
uv run python src/viewer_server/server.py start
```

当前仓库没有 `skill/viewer_server/server.py`。如果未来恢复 `--background` 参数，必须先补测试再更新这里。
```
```

- [ ] **Step 4: Update sibling Skill docs**

In `skills/character-promo/SKILL.md`, `skills/character-turnaround/SKILL.md`, and `skills/viewer-server/SKILL.md`, replace:

```markdown
python ~/.claude/plugins/game-ui-ai-workflow/scripts/bootstrap.py --check
```

with:

```markdown
Dev mode：`python3 scripts/bootstrap.py --check`
Installed Plugin mode：`python3 ~/.claude/plugins/game-ui-ai-workflow/scripts/bootstrap.py --check`
```

If a file contains `skill/viewer_server/server.py`, replace it with:

```markdown
uv run python src/viewer_server/server.py start
```

- [ ] **Step 5: Run doc smoke tests**

Run:

```bash
uv run pytest -q tests/test_skill_docs_startup_contract.py
```

Expected:

```text
3 passed
```

- [ ] **Step 6: Commit**

```bash
git add skills/character-workflow/SKILL.md skills/character-promo/SKILL.md skills/character-turnaround/SKILL.md skills/viewer-server/SKILL.md tests/test_skill_docs_startup_contract.py
git commit -m "docs: fix workflow startup commands"
```

## Task 6: Document Codex User-Choice Protocol

**Files:**
- Modify: `skills/character-workflow/SKILL.md`
- Modify: `skills/character-workflow/references/spec-protocol.md`
- Modify: `tests/test_skill_docs_startup_contract.py`

- [ ] **Step 1: Add failing docs assertions**

Append to `tests/test_skill_docs_startup_contract.py`:

```python
def test_character_workflow_docs_describe_codex_choice_protocol():
    text = _read("skills/character-workflow/SKILL.md")
    assert "Codex" in text
    assert "request_user_input" in text
    assert "两级选择" in text
    assert "AskUserQuestion" in text


def test_spec_protocol_mentions_cross_runtime_choice_tools():
    text = _read("skills/character-workflow/references/spec-protocol.md")
    assert "Claude Code" in text
    assert "Codex" in text
    assert "request_user_input" in text
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest -q tests/test_skill_docs_startup_contract.py::test_character_workflow_docs_describe_codex_choice_protocol tests/test_skill_docs_startup_contract.py::test_spec_protocol_mentions_cross_runtime_choice_tools
```

Expected: FAIL because Codex-specific user choice protocol is not documented.

- [ ] **Step 3: Add cross-runtime choice section to `SKILL.md`**

Insert this section before `### action = ask：按 stage 分叉问什么`:

```markdown
### 用户选择工具协议（Claude Code / Codex）

当 `recommend_action == "ask"` 时，不要只输出一段普通解释就继续行动；必须等待用户选择。

- **Claude Code**：使用 `AskUserQuestion`。Stage D 可以一次列 4 个选项。
- **Codex**：如果 `request_user_input` 工具可用，使用它展示选择弹窗；如果当前模式没有该工具，则用普通回复列编号选项并等待用户回复。

Codex `request_user_input` 限制：
- 每题最多 2-3 个显式选项，客户端会自动添加 Other。
- `header` 不超过 12 字。
- `id` 使用 snake_case。
- 推荐选项 label 后缀写 `(Recommended)`。

因此 Stage D 在 Codex 上使用两级选择：

第一级：
1. 继续当前角色（Recommended）
2. 新建另一个角色
3. 跳过本轮

如果用户选择“继续当前角色”，第二级再问：
1. 按现 spec 出图（仅当 `spec_status == "ready"` 时推荐）
2. 改 spec

如果 `spec_status != "ready"`，不要提供“按现 spec 出图”作为推荐项；优先让用户补全 spec。
```

- [ ] **Step 4: Update `references/spec-protocol.md`**

Replace the existing single-tool line:

```markdown
- 用 `AskUserQuestion` 工具时给具体选项，"Other" 由工具自动添加。
```

with:

```markdown
- Claude Code 用 `AskUserQuestion` 工具时给具体选项，"Other" 由工具自动添加。
- Codex 用 `request_user_input` 时每题只给 2-3 个显式选项；需要 4 个业务选项时拆成两级选择。若当前模式没有该工具，则用编号列表等待用户回复，不继续行动。
```

- [ ] **Step 5: Run docs tests**

Run:

```bash
uv run pytest -q tests/test_skill_docs_startup_contract.py
```

Expected: all doc smoke tests pass.

- [ ] **Step 6: Commit**

```bash
git add skills/character-workflow/SKILL.md skills/character-workflow/references/spec-protocol.md tests/test_skill_docs_startup_contract.py
git commit -m "docs: add codex choice protocol"
```

## Task 7: Final Startup Smoke Test and Regression Sweep

**Files:**
- No code creation expected.
- Validate: `pyproject.toml`, `src/character_workflow/lib/keys.py`, `src/character_workflow/lib/turn_start.py`, `src/character_workflow/lib/intent.py`, `src/character_workflow/lib/schemas.py`, Skill docs, tests.

- [ ] **Step 1: Run focused Python tests**

Run:

```bash
uv run pytest -q \
  tests/test_cli_startup_contract.py \
  tests/test_turn_start_keys.py \
  tests/test_turn_start_v4.py \
  tests/test_recommend_action.py \
  tests/test_skill_docs_startup_contract.py
```

Expected: all selected tests pass.

- [ ] **Step 2: Run full Python test suite**

Run:

```bash
uv run pytest -q
```

Expected: all tests pass.

- [ ] **Step 3: Run Python lint**

Run:

```bash
uv run ruff check src tests
```

Expected:

```text
All checks passed!
```

- [ ] **Step 4: Manually verify the actual command used by the Skill**

Run:

```bash
uv run python -m character_workflow turn-start --message "/character-workflow"
```

Expected:

```text
{
  "stage": "...",
  ...
  "recommend_action": "ask",
  ...
}
```

The exact `stage` depends on the current data root. The command must exit 0, return valid JSON, include `available_keys`, include `spec_status`, and not print secrets.

- [ ] **Step 5: Check git status for unrelated files**

Run:

```bash
git status --short
```

Expected: only files from this plan are modified. If unrelated files appear, leave them unstaged and mention them in the completion report.

- [ ] **Step 6: Commit final verification notes if any docs changed**

If Task 7 caused no file changes, skip this commit. If a verification note is added to a docs file, run:

```bash
git add <changed-doc-file>
git commit -m "docs: record workflow startup verification"
```

## Self-Review

**Spec coverage:** Covered every observed startup problem: missing plugin bootstrap path, bare `python`, stale viewer-server path, missing package import without `PYTHONPATH`, uv/Codex command reliability via explicit docs and package fix, `ModelSpec` JSON crash, `.runtime` appearing as a character, placeholder specs being treated as normal specs, and Codex user-choice protocol.

**Placeholder scan:** No step asks an engineer to invent missing behavior. Each task names exact files, exact code snippets, exact commands, and expected outcomes.

**Type consistency:** `spec_status` is introduced in `turn_start.py`, passed to `compute_recommend_action()`, returned in the CLI dict, and added to `TurnStartResult`. `available_keys.models` consistently uses `list[dict{name,id}]`.

