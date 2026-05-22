# Skill Memory Two-Tier Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragmented `references/lessons/*.md` with a two-tier MEMORY.md: project-level `{project_root}/MEMORY.md` (per-project lessons) and global `~/.claude/MEMORY.md` (cross-project lessons).

**Architecture:** `MEMORY.md` at repo root holds `## character-workflow > ### Portrait/Promo/Turnaround`. `context_loader.load_lessons()` reads via new `read_memory_section()`. `lessons.py` gains `append_memory()` (read-modify-write); `append_lesson()` becomes an alias. Old `references/lessons/*.md` are deprecated-in-place (not deleted).

**Tech Stack:** Python 3.11, pytest, pathlib, subprocess (`git rev-parse`)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `MEMORY.md` | Create | Project-level lessons store, `## character-workflow` root section |
| `skill/character_workflow/lib/context_loader.py` | Modify | Add `read_memory_section()`, git-aware `_project_root()`, redirect `load_lessons()` |
| `skill/character_workflow/lib/lessons.py` | Modify | Add `append_memory()`, make `append_lesson()` an alias |
| `skill/character_workflow/__main__.py` | Modify | Wire `append-memory` subcommand |
| `skill/character_workflow/SKILL.md` | Modify | Update CLI examples + prose to reference MEMORY.md |
| `skill/character_workflow/references/lessons/portrait.md` | Modify | Prepend `> **DEPRECATED**` header |
| `skill/character_workflow/references/lessons/promo.md` | Modify | Prepend `> **DEPRECATED**` header |
| `skill/character_workflow/references/lessons/turnaround.md` | Modify | Prepend `> **DEPRECATED**` header |
| `tests/test_context_loader.py` | Modify | Update `load_lessons` tests to write MEMORY.md instead of lesson files |
| `tests/test_lessons.py` | Modify | Rewrite to test `append_memory` against MEMORY.md |
| `tests/test_memory.py` | Create | Tests for `read_memory_section()` and `append_memory()` |

---

### Task 1: Create project MEMORY.md and migrate lesson content

**Files:**
- Create: `MEMORY.md`
- Modify: `skill/character_workflow/references/lessons/portrait.md`
- Modify: `skill/character_workflow/references/lessons/promo.md`
- Modify: `skill/character_workflow/references/lessons/turnaround.md`

- [ ] **Step 1: Create `MEMORY.md` at project root**

```markdown
# game-ui-ai-workflow MEMORY

## character-workflow

### Portrait

- 2026-05-21 young-emperor-monkey · 精灵类角色首轮出图避免直呼现有 IP 与"幼年+强攻"等组合，改成原创怪兽图鉴风、初阶形态、蓄势展示动作更稳 · prompt 片段：`原创日式怪兽图鉴官方设定图风格，适合全年龄向游戏角色`
- 2026-05-21 young-emperor-monkey · Lovart 返回 artifact 但 runner 因 final_status=timeout 或 downloader failed 标失败时，先检查响应里的 artifacts URL，再用 curl -sS -L --fail 手动补下载并回填 job · prompt 片段：`download failed + artifacts/agent/*.png`
- 2026-05-21 blazefist-monkey · 出进化形态立绘时把前置进化 portrait/v1.png 上传为参考图，能保持配色血统一致性 · 操作：lovart_wrapper upload + chat --attachments CDN_URL
- 2026-05-21 blazefist-monkey · lovart_wrapper upload_file 用 curl 子进程代替 requests，绕开服务端 chunked 响应提前关闭导致空 body 的问题 · 关键代码：subprocess.check_output(['curl', '-sS', '-F', 'file=@path', url])
- 2026-05-21 holy-spirit-priestess · 画师改已出图必须先问修改模式（A 编辑当前图 / B 完全重出 / C 局部参考重出），三种 prompt 写法互斥，混着写会让模型不知道锚定参考图还是按 prompt 重画 · 操作：AskUserQuestion 三选一
- 2026-05-21 holy-spirit-priestess · A 模式编辑当前图时 prompt 只写差异指令，不重述外观/画风/规格（参考图已承载），引导而非规定，能短就短 · prompt 片段：`以参考图为底图，仅做以下三处改动：1. 武器... 2. 披风纹理... 3. 动作...`

### Promo

- 2026-05-21 young-emperor-monkey · prompt 身份锚点全下放参考图，文本只写动作/场景/光/构图/风格骨架，比堆 spec 外观词准 · prompt 片段：`以上传图中的角色为画面核心，保留其外观和识别特征`
- 2026-05-21 young-emperor-monkey · 画风描述去 IP 名（不写宝可梦/帕鲁等），用客观笔触语言即可引导图鉴风 · prompt 片段：`清晰黑色轮廓线，平涂上色，柔和边缘阴影，卡通插画风格`
- 2026-05-21 young-emperor-monkey · runner 报 output_paths missing 但 artifact URL 已存在时，curl -sS -L --fail <url> 兜底下载后手动回填 output_paths + status=done · prompt 片段：N/A（操作经验）
- 2026-05-21 young-emperor-monkey · GPT Image 2 没有原生 16:9，只需用 --size 告知尺寸（如 1536x1024）模型即可按尺寸出图；prompt 文本里不必再写"16:9 横版"等画幅描述词 · prompt 片段：`--size 1536x1024`

### Turnaround
```

- [ ] **Step 2: Prepend DEPRECATED header to the three old lesson files**

In `skill/character_workflow/references/lessons/portrait.md`, `promo.md`, and `turnaround.md`, add this as the very first line of each file:

```
> **DEPRECATED** — 内容已迁移到项目根 `MEMORY.md > ## character-workflow`。本文件不再更新。
```

- [ ] **Step 3: Verify content matches**

Run:
```bash
grep -c "^- " MEMORY.md
```
Expected output: `10` (6 portrait + 4 promo bullets)

- [ ] **Step 4: Commit**

```bash
git add MEMORY.md skill/character_workflow/references/lessons/
git commit -m "feat(memory): create project MEMORY.md, migrate lessons content, mark old files DEPRECATED"
```

---

### Task 2: Add `read_memory_section()` to `context_loader.py`

**Files:**
- Modify: `skill/character_workflow/lib/context_loader.py`
- Create: `tests/test_memory.py`

- [ ] **Step 1: Write failing tests in `tests/test_memory.py`**

```python
"""Tests for read_memory_section() in context_loader."""
import pytest
from pathlib import Path
from skill.character_workflow.lib import context_loader as cl


@pytest.fixture
def memory_file(tmp_path):
    p = tmp_path / "MEMORY.md"
    p.write_text(
        "# Project MEMORY\n\n"
        "## character-workflow\n\n"
        "### Portrait\n\n"
        "- 2026-05-21 foo · bar · prompt：`baz`\n"
        "- 2026-05-21 qux · quux · prompt：`corge`\n\n"
        "### Promo\n\n"
        "- 2026-05-21 grault · garply · prompt：`waldo`\n\n"
        "### Turnaround\n\n"
        "## other-section\n\n"
        "- unrelated\n",
        encoding="utf-8",
    )
    return p


def test_returns_bullets_for_existing_section(memory_file):
    result = cl.read_memory_section(memory_file, "character-workflow", "Portrait")
    assert "- 2026-05-21 foo · bar" in result
    assert "- 2026-05-21 qux · quux" in result
    assert "grault" not in result  # Promo bullet must not bleed in


def test_case_insensitive_heading_match(memory_file):
    result = cl.read_memory_section(memory_file, "CHARACTER-WORKFLOW", "portrait")
    assert "foo · bar" in result


def test_missing_subsection_returns_empty(memory_file):
    assert cl.read_memory_section(memory_file, "character-workflow", "Turnaround") == ""


def test_missing_section_returns_empty(memory_file):
    assert cl.read_memory_section(memory_file, "nonexistent", "Portrait") == ""


def test_missing_file_returns_empty(tmp_path):
    assert cl.read_memory_section(tmp_path / "MEMORY.md", "character-workflow", "Portrait") == ""


def test_parse_error_returns_empty(tmp_path, capsys):
    p = tmp_path / "MEMORY.md"
    p.write_bytes(b"\xff\xfe bad")  # force a read to succeed but garbled — actually UTF-8 fallback OK
    # Test OSError path by making it a directory instead
    bad = tmp_path / "dir_not_file"
    bad.mkdir()
    result = cl.read_memory_section(bad, "s", "sub")
    assert result == ""
    assert "read_memory_section" in capsys.readouterr().err


def test_promo_bullets_not_in_portrait(memory_file):
    result = cl.read_memory_section(memory_file, "character-workflow", "Promo")
    assert "grault" in result
    assert "foo · bar" not in result


def test_soft_limit_warning(tmp_path, capsys):
    bullets = "\n".join(
        f"- 2026-05-21 c{i} · note · prompt：`x`"
        for i in range(cl.LESSONS_SOFT_LIMIT_ENTRIES + 5)
    )
    p = tmp_path / "MEMORY.md"
    p.write_text(
        f"## character-workflow\n\n### Portrait\n\n{bullets}\n",
        encoding="utf-8",
    )
    cl.read_memory_section(p, "character-workflow", "Portrait")
    assert "exceeds soft limit" in capsys.readouterr().err
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow
uv run pytest tests/test_memory.py -v 2>&1 | head -30
```

Expected: `AttributeError: module 'skill.character_workflow.lib.context_loader' has no attribute 'read_memory_section'`

- [ ] **Step 3: Implement `read_memory_section()` in `context_loader.py`**

Add after the `_read_text()` function (after line 53 in the current file). Also add `import subprocess` at the top.

Replace the current `_project_root()` function (lines 34-35) with:

```python
def _project_root() -> Path:
    if env := os.environ.get("PROJECT_ROOT"):
        return Path(env)
    try:
        import subprocess
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0 and r.stdout.strip():
            return Path(r.stdout.strip())
    except (OSError, subprocess.TimeoutExpired):
        pass
    return Path.cwd()
```

Add this new function after `_read_text()`:

```python
def read_memory_section(path: Path, section: str, subsection: str) -> str:
    """Return bullet lines from ## section > ### subsection in a MEMORY.md file.

    Returns "" when file is missing, section/subsection not found, or read fails.
    Heading matching is case-insensitive.
    """
    if not path.exists():
        return ""
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as e:
        print(f"[context_loader] read_memory_section failed: {path} ({e})", file=sys.stderr)
        return ""

    in_section = False
    in_subsection = False
    bullets: list[str] = []

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            in_section = stripped[3:].strip().lower() == section.lower()
            in_subsection = False
            continue
        if not in_section:
            continue
        if stripped.startswith("### "):
            in_subsection = stripped[4:].strip().lower() == subsection.lower()
            continue
        if not in_subsection:
            continue
        if stripped.startswith("- "):
            bullets.append(line)

    if not bullets:
        return ""

    count = len(bullets)
    print(
        f"[context_loader] MEMORY.md ## {section} > ### {subsection}: {count} entries",
        file=sys.stderr,
    )
    if count > LESSONS_SOFT_LIMIT_ENTRIES:
        print(
            f"[context_loader] WARN ## {section} > ### {subsection} "
            f"{count} entries exceeds soft limit {LESSONS_SOFT_LIMIT_ENTRIES} — 建议人工分卷归档",
            file=sys.stderr,
        )
    return "\n".join(bullets)
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
uv run pytest tests/test_memory.py -v
```

Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add skill/character_workflow/lib/context_loader.py tests/test_memory.py
git commit -m "feat(memory): add read_memory_section() + git-aware _project_root() to context_loader"
```

---

### Task 3: Redirect `load_lessons()` to read from MEMORY.md

**Files:**
- Modify: `skill/character_workflow/lib/context_loader.py`
- Modify: `tests/test_context_loader.py`

- [ ] **Step 1: Update `load_lessons()` tests in `test_context_loader.py`**

The `lessons_dir` fixture is no longer needed for the lessons tests. Replace the three lessons tests (lines 62–85) with these:

```python
def test_load_lessons_unknown_kind_raises(project):
    with pytest.raises(ValueError, match="unknown lessons kind"):
        cl.load_lessons("video")


def test_load_lessons_missing_memory_returns_empty(project):
    # No MEMORY.md in project root → returns ""
    assert cl.load_lessons("portrait") == ""


def test_load_lessons_reads_from_memory_md(project, capsys):
    memory = project / "MEMORY.md"
    memory.write_text(
        "## character-workflow\n\n"
        "### Portrait\n\n"
        "- 2026-05-21 holy · 金白配色 · prompt：`金白祭祀袍`\n"
        "- 2026-05-21 holy · 兜帽阴影 · prompt：`兜帽低垂`\n",
        encoding="utf-8",
    )
    text = cl.load_lessons("portrait")
    assert "金白配色" in text
    err = capsys.readouterr().err
    assert "2 entries" in err


def test_load_lessons_warns_on_entry_overflow(project, capsys):
    lines = "\n".join(
        f"- 2026-05-21 c · note {i} · prompt：`x`"
        for i in range(cl.LESSONS_SOFT_LIMIT_ENTRIES + 5)
    )
    memory = project / "MEMORY.md"
    memory.write_text(
        f"## character-workflow\n\n### Portrait\n\n{lines}\n",
        encoding="utf-8",
    )
    cl.load_lessons("portrait")
    err = capsys.readouterr().err
    assert "exceeds soft limit" in err
```

Also remove the `lessons_dir` fixture from the `test_context_loader.py` file and its usage in the updated tests above (these tests only use `project`). Keep the fixture if `test_load_character_context_combines_three` still uses it — check that test: it writes `(lessons_dir / "portrait.md")`. That test also needs updating:

```python
def test_load_character_context_combines_three(project):
    (project / "worldview.md").write_text("世界观", encoding="utf-8")
    memory = project / "MEMORY.md"
    memory.write_text(
        "## character-workflow\n\n### Portrait\n\n- a · b · `c`\n",
        encoding="utf-8",
    )
    chars = project / "characters" / "holy"
    chars.mkdir(parents=True)
    (chars / "spec.md").write_text("# 圣灵", encoding="utf-8")

    ctx = cl.load_character_context("holy", "portrait")
    assert ctx["worldview"] == "世界观"
    assert "a · b" in ctx["lessons"]
    assert "圣灵" in ctx["spec"]
    assert ctx["character_id"] == "holy"
```

After these changes, the `lessons_dir` fixture can be removed entirely from `test_context_loader.py`.

- [ ] **Step 2: Run updated tests — verify they fail (load_lessons still reads old path)**

```bash
uv run pytest tests/test_context_loader.py -v -k "lessons or context"
```

Expected: `test_load_lessons_reads_from_memory_md` FAILS (reads old path, MEMORY.md ignored)

- [ ] **Step 3: Update `load_lessons()` in `context_loader.py`**

Replace lines 72–87 (the current `load_lessons` function) with:

```python
def load_lessons(kind: str) -> str:
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}, expected one of {VALID_KINDS}")
    memory_path = _project_root() / "MEMORY.md"
    return read_memory_section(memory_path, "character-workflow", kind.capitalize())
```

- [ ] **Step 4: Run tests — all pass**

```bash
uv run pytest tests/test_context_loader.py -v
```

Expected: all tests PASS

- [ ] **Step 5: Run full test suite — no regressions**

```bash
uv run pytest -v --tb=short 2>&1 | tail -20
```

Expected: green. If `test_lessons.py` fails (it monkeypatches `_lessons_path` which `append_lesson` no longer calls), that will be fixed in Task 4.

- [ ] **Step 6: Commit**

```bash
git add skill/character_workflow/lib/context_loader.py tests/test_context_loader.py
git commit -m "feat(memory): redirect load_lessons() to read from project MEMORY.md"
```

---

### Task 4: Add `append_memory()` to `lessons.py`, make `append_lesson()` an alias

**Files:**
- Modify: `skill/character_workflow/lib/lessons.py`
- Modify: `tests/test_lessons.py`
- Modify: `tests/test_memory.py`

- [ ] **Step 1: Add `append_memory` tests to `tests/test_memory.py`**

Append these tests to the existing `tests/test_memory.py`:

```python
from skill.character_workflow.lib import lessons


@pytest.fixture
def project_memory(tmp_path, monkeypatch):
    """Point PROJECT_ROOT to tmp_path; return the MEMORY.md path."""
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    return tmp_path / "MEMORY.md"


def test_append_memory_creates_memory_md(project_memory):
    lessons.append_memory("portrait", "- 2026-05-21 foo · bar · prompt：`x`", project_root=project_memory.parent)
    assert project_memory.exists()
    text = project_memory.read_text(encoding="utf-8")
    assert "## character-workflow" in text
    assert "### Portrait" in text
    assert "- 2026-05-21 foo · bar" in text


def test_append_memory_two_entries_in_order(project_memory):
    root = project_memory.parent
    lessons.append_memory("portrait", "- line-a", project_root=root)
    lessons.append_memory("portrait", "- line-b", project_root=root)
    text = project_memory.read_text(encoding="utf-8")
    assert text.index("line-a") < text.index("line-b")


def test_append_memory_portrait_and_promo_separate(project_memory):
    root = project_memory.parent
    lessons.append_memory("portrait", "- portrait-entry", project_root=root)
    lessons.append_memory("promo", "- promo-entry", project_root=root)
    text = project_memory.read_text(encoding="utf-8")
    portrait_pos = text.index("### Portrait")
    promo_pos = text.index("### Promo")
    portrait_entry_pos = text.index("portrait-entry")
    promo_entry_pos = text.index("promo-entry")
    assert portrait_pos < portrait_entry_pos < promo_pos < promo_entry_pos


def test_append_memory_rejects_newline(project_memory):
    with pytest.raises(ValueError, match="single-line"):
        lessons.append_memory("portrait", "- a\n- b", project_root=project_memory.parent)


def test_append_memory_rejects_oversized(project_memory):
    with pytest.raises(ValueError, match="too long"):
        lessons.append_memory("portrait", "- " + "x" * 5000, project_root=project_memory.parent)


def test_append_memory_rejects_unknown_kind(project_memory):
    with pytest.raises(ValueError, match="unknown"):
        lessons.append_memory("video", "- x", project_root=project_memory.parent)


def test_append_lesson_is_alias_for_append_memory(project_memory, monkeypatch):
    """append_lesson should write to MEMORY.md, not references/lessons/."""
    monkeypatch.setenv("PROJECT_ROOT", str(project_memory.parent))
    lessons.append_lesson("portrait", "- via-alias")
    text = project_memory.read_text(encoding="utf-8")
    assert "via-alias" in text
```

- [ ] **Step 2: Run new tests — verify they fail**

```bash
uv run pytest tests/test_memory.py -v -k "append_memory or append_lesson_is_alias"
```

Expected: `AttributeError: module 'skill.character_workflow.lib.lessons' has no attribute 'append_memory'`

- [ ] **Step 3: Rewrite `lessons.py`**

Replace the entire file content with:

```python
"""Lessons append helper — read-modify-write into project MEMORY.md.

Single-painter, single-process assumption. No file locking needed.
`append_lesson` is kept as an alias that redirects to MEMORY.md (old
references/lessons/*.md files are deprecated and no longer updated).
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path


VALID_KINDS = ("portrait", "promo", "turnaround")


def _resolve_project_root() -> Path:
    if env := os.environ.get("PROJECT_ROOT"):
        return Path(env)
    try:
        import subprocess
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0 and r.stdout.strip():
            return Path(r.stdout.strip())
    except (OSError, subprocess.TimeoutExpired):
        pass
    return Path.cwd()


def _upsert_line(content: str, h2: str, h3: str, line: str) -> str:
    """Append `line` at end of ## h2 > ### h3 block. Creates sections if absent."""
    rows = content.splitlines()

    # Locate ## h2 section bounds
    h2_start = h2_end = None
    for i, r in enumerate(rows):
        if re.match(r"^## ", r):
            name = r[3:].strip()
            if name.lower() == h2.lower():
                h2_start = i
            elif h2_start is not None and h2_end is None:
                h2_end = i
    if h2_start is None:
        tail = "\n".join(rows).rstrip("\n")
        return tail + f"\n\n## {h2}\n\n### {h3}\n\n{line}\n"
    if h2_end is None:
        h2_end = len(rows)

    section = rows[h2_start:h2_end]

    # Locate ### h3 within section
    h3_start = h3_end = None
    for i, r in enumerate(section):
        if re.match(r"^### ", r):
            name = r[4:].strip()
            if name.lower() == h3.lower():
                h3_start = i
            elif h3_start is not None and h3_end is None:
                h3_end = i
    if h3_start is None:
        # Append new subsection before h2_end
        insert = h2_end
        while insert > 0 and not rows[insert - 1].strip():
            insert -= 1
        rows[insert:insert] = ["", f"### {h3}", "", line]
        return "\n".join(rows) + "\n"
    if h3_end is None:
        h3_end = len(section)

    abs_start = h2_start + h3_start
    abs_end = h2_start + h3_end

    # Find last bullet in subsection
    last_bullet = None
    for i in range(abs_start, abs_end):
        if rows[i].startswith("- "):
            last_bullet = i

    if last_bullet is None:
        insert = abs_start + 1
        while insert < abs_end and not rows[insert].strip():
            insert += 1
        rows.insert(insert, line)
    else:
        rows.insert(last_bullet + 1, line)

    return "\n".join(rows) + "\n"


def append_memory(
    kind: str,
    line: str,
    project_root: Path | None = None,
    global_: bool = False,
) -> Path:
    """Read-modify-write one lesson line into the correct MEMORY.md section.

    - Default: writes to `{project_root}/MEMORY.md` under
      `## character-workflow > ### {kind.capitalize()}`
    - With global_=True: writes to `~/.claude/MEMORY.md` under
      `## Skills Memory > ### character-workflow`
    """
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown kind: {kind!r}, expected one of {VALID_KINDS}")
    if "\n" in line or "\r" in line:
        raise ValueError("memory line must be single-line (no newline allowed)")
    encoded = line.encode("utf-8")
    if len(encoded) >= 4000:
        raise ValueError(f"memory line too long: {len(encoded)} bytes (limit 4000)")

    if global_:
        path = Path.home() / ".claude" / "MEMORY.md"
        h2, h3 = "Skills Memory", "character-workflow"
    else:
        root = project_root if project_root is not None else _resolve_project_root()
        path = root / "MEMORY.md"
        h2, h3 = "character-workflow", kind.capitalize()

    content = path.read_text(encoding="utf-8") if path.exists() else ""
    updated = _upsert_line(content, h2, h3, line)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(updated, encoding="utf-8")
    print(f"[lessons] appended to {path} ## {h2} > ### {h3}", file=sys.stderr)
    return path


def append_lesson(kind: str, line: str) -> Path:
    """Alias for append_memory (backward compat). Writes to project MEMORY.md."""
    return append_memory(kind, line)
```

- [ ] **Step 4: Update `tests/test_lessons.py`** to test the new behavior

Replace the entire file content with:

```python
"""Tests for lessons.append_memory / append_lesson."""
import pytest
from skill.character_workflow.lib import lessons


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    return tmp_path


def test_append_creates_memory_md(project_root):
    path = lessons.append_lesson("portrait", "- 2026-05-19 holy · 金白 · prompt：`x`")
    assert path == project_root / "MEMORY.md"
    assert path.exists()
    assert "- 2026-05-19 holy · 金白" in path.read_text(encoding="utf-8")


def test_append_two_lessons_keeps_order(project_root):
    lessons.append_lesson("portrait", "- a")
    lessons.append_lesson("portrait", "- b")
    text = (project_root / "MEMORY.md").read_text(encoding="utf-8")
    assert text.index("- a") < text.index("- b")


def test_append_rejects_newline_in_line(project_root):
    with pytest.raises(ValueError, match="single-line"):
        lessons.append_lesson("portrait", "- a\n- b")


def test_append_rejects_oversized_line(project_root):
    huge = "- " + "x" * 5000
    with pytest.raises(ValueError, match="too long"):
        lessons.append_lesson("portrait", huge)


def test_append_unknown_kind_raises(project_root):
    with pytest.raises(ValueError, match="unknown"):
        lessons.append_lesson("video", "- x")
```

- [ ] **Step 5: Run all affected tests**

```bash
uv run pytest tests/test_lessons.py tests/test_memory.py -v
```

Expected: all PASS

- [ ] **Step 6: Run full suite**

```bash
uv run pytest -v --tb=short 2>&1 | tail -20
```

Expected: all green

- [ ] **Step 7: Commit**

```bash
git add skill/character_workflow/lib/lessons.py tests/test_lessons.py tests/test_memory.py
git commit -m "feat(memory): add append_memory() with read-modify-write to MEMORY.md; append_lesson() becomes alias"
```

---

### Task 5: Wire `append-memory` subcommand in `__main__.py`

**Files:**
- Modify: `skill/character_workflow/__main__.py`
- Modify: `tests/test_submit_cli.py` (or create `tests/test_append_memory_cli.py`)

- [ ] **Step 1: Write failing CLI test**

Create `tests/test_append_memory_cli.py`:

```python
"""CLI integration test for append-memory and append-lesson subcommands."""
import json
import pytest
from skill.character_workflow.__main__ import main


@pytest.fixture
def project_root(tmp_path, monkeypatch):
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    return tmp_path


def test_append_memory_cli_writes_to_memory_md(project_root):
    rc = main([
        "append-memory",
        "--kind", "portrait",
        "--line", "- 2026-05-21 foo · bar · prompt：`x`",
    ])
    assert rc == 0
    text = (project_root / "MEMORY.md").read_text(encoding="utf-8")
    assert "foo · bar" in text


def test_append_memory_cli_returns_json(project_root, capsys):
    main([
        "append-memory",
        "--kind", "promo",
        "--line", "- 2026-05-21 c · d · prompt：`y`",
    ])
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is True
    assert "MEMORY.md" in out["path"]


def test_append_lesson_cli_alias_works(project_root, capsys):
    rc = main([
        "append-lesson",
        "--kind", "portrait",
        "--line", "- via-old-cli",
    ])
    assert rc == 0
    text = (project_root / "MEMORY.md").read_text(encoding="utf-8")
    assert "via-old-cli" in text


def test_append_memory_cli_global_flag(tmp_path, monkeypatch):
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    # Patch Path.home() by setting HOME env var (pathlib respects it)
    rc = main([
        "append-memory",
        "--kind", "portrait",
        "--line", "- global-entry",
        "--global",
    ])
    assert rc == 0
    global_memory = fake_home / ".claude" / "MEMORY.md"
    assert global_memory.exists()
    assert "global-entry" in global_memory.read_text(encoding="utf-8")
```

- [ ] **Step 2: Run — verify failure**

```bash
uv run pytest tests/test_append_memory_cli.py -v
```

Expected: `error: argument cmd: invalid choice: 'append-memory'`

- [ ] **Step 3: Update `__main__.py`**

In `__main__.py`, replace line 22 (`from skill.character_workflow.lib.lessons import append_lesson`) with:

```python
from skill.character_workflow.lib.lessons import append_lesson, append_memory
```

After the `p_lesson` block (after line 99), add the `append-memory` parser:

```python
    p_memory = sub.add_parser("append-memory", help="read-modify-write一条经验到 MEMORY.md")
    p_memory.add_argument("--kind", required=True, choices=("portrait", "promo", "turnaround"))
    p_memory.add_argument("--line", required=True, help="完整一行 markdown，不带换行")
    p_memory.add_argument("--global", dest="global_", action="store_true",
                          help="写入全局 ~/.claude/MEMORY.md 而非项目级")
```

In the dispatch block, replace the `append-lesson` handler (lines 144-147):

```python
    if args.cmd == "append-memory":
        path = append_memory(args.kind, args.line, global_=args.global_)
        print(json.dumps({"ok": True, "path": str(path)}, ensure_ascii=False))
        return 0
    if args.cmd == "append-lesson":
        path = append_memory(args.kind, args.line)
        print(json.dumps({"ok": True, "path": str(path)}, ensure_ascii=False))
        return 0
```

- [ ] **Step 4: Run tests**

```bash
uv run pytest tests/test_append_memory_cli.py -v
```

Expected: all 4 PASS

- [ ] **Step 5: Run full suite**

```bash
uv run pytest -v --tb=short 2>&1 | tail -20
```

Expected: all green

- [ ] **Step 6: Commit**

```bash
git add skill/character_workflow/__main__.py tests/test_append_memory_cli.py
git commit -m "feat(memory): wire append-memory CLI subcommand; append-lesson redirects to MEMORY.md"
```

---

### Task 6: Update SKILL.md

**Files:**
- Modify: `skill/character_workflow/SKILL.md`

- [ ] **Step 1: Update the lessons section prose**

Find the section `### Turn 收尾：经验沉淀（lessons）` (around line 217). Make these changes:

1. Change the prompt text from:
   ```
   > "本轮要不要沉淀一条经验到 `lessons/portrait.md`？想保留就给我一句话，否则跳过。"
   ```
   To:
   ```
   > "本轮要不要沉淀一条经验到 `MEMORY.md`？想保留就给我一句话，否则跳过。"
   ```

2. Replace the CLI call example:
   ```bash
   uv run python -m skill.character_workflow append-lesson --kind portrait --line "- 2026-05-19 holy-spirit-priestess · 金白配色高识别度 · prompt 片段：\`兜帽低垂遮眼\`"
   ```
   With:
   ```bash
   uv run python -m skill.character_workflow append-memory --kind portrait --line "- 2026-05-19 holy-spirit-priestess · 金白配色高识别度 · prompt 片段：\`兜帽低垂遮眼\`"
   ```

3. Update the turn-start comment at the top of SKILL.md (line ~41):
   Change:
   ```
   # 出图 promo/turnaround 时显式加 --kind 切换对应 lessons
   ```
   To:
   ```
   # 出图 promo/turnaround 时显式加 --kind 切换对应 MEMORY.md 子节
   ```

- [ ] **Step 2: Verify the grep is clean**

```bash
grep -n "lessons/" /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow/skill/character_workflow/SKILL.md
```

Expected: only `references/spec-protocol.md`, `references/art-prompt-system.md`, etc. — no `lessons/portrait.md`, `lessons/promo.md`, `lessons/turnaround.md` references.

- [ ] **Step 3: Commit**

```bash
git add skill/character_workflow/SKILL.md
git commit -m "docs(skill): update SKILL.md to reference MEMORY.md instead of lessons/*.md"
```

---

## Verification Checklist

After all tasks complete, run:

```bash
# 1. All tests green
uv run pytest -v --tb=short

# 2. MEMORY.md exists at project root with correct structure
grep -E "^## character-workflow|^### (Portrait|Promo|Turnaround)" MEMORY.md

# 3. turn-start returns lessons from MEMORY.md
uv run python -m skill.character_workflow turn-start --kind portrait 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['lessons']), 'chars in lessons')"

# 4. append-memory roundtrip
uv run python -m skill.character_workflow append-memory --kind turnaround --line "- 2026-05-21 test · smoke · prompt：\`test\`"
grep "smoke" MEMORY.md

# 5. append-lesson alias still works
uv run python -m skill.character_workflow append-lesson --kind turnaround --line "- 2026-05-21 alias-test · alias-smoke · prompt：\`alias\`"
grep "alias-smoke" MEMORY.md
```
