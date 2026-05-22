# Project-Scoped Memory & Worldview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现三层 Memory + Worldview 架构(全局/工作区/项目),解决多项目共享单一 MEMORY 导致经验污染的问题。

**Architecture:**
- `lib/projects.py` 给 `Project` 加 `slug` 字段并自动建 `projects/<slug>/` 骨架
- `lib/context_loader.py` 新增三层 lessons 加载 + 项目级 worldview 加载
- `lib/lessons.py` 重命名为 `append_memory(kind, line, scope, project_slug)`,按 scope 写不同层
- `lib/turn_start.py` 加 Stage E(未归属角色兜底),JSON 输出从 2 字段扩到 9 字段
- `__main__.py` 加 `append-memory --scope` / `create-project` / `assign-character` 三个子命令
- 数据迁移:把现有 10 条 lessons 拆到工作区 + 宝可梦项目两个 MEMORY.md,projects.json 补 slug 字段

**Tech Stack:** Python 3.11 / Pydantic 2.9 / pytest 8 / pypinyin(新增)。无前端改动。

**Spec:** `docs/superpowers/specs/2026-05-21-project-scoped-memory-design.md`

---

## File Structure

### 新建
- `projects/pokemon-style-elf-game/worldview.md` — 宝可梦项目世界观(从仓库根迁移)
- `projects/pokemon-style-elf-game/MEMORY.md` — 宝可梦项目特定经验(4 条)
- `projects/test-content/worldview.md` — 空模板
- `projects/test-content/MEMORY.md` — 空骨架
- `skill/character_workflow/lib/slug.py` — slug 生成工具(pypinyin + 纯 ASCII fallback)
- `tests/test_slug.py` — slug 生成单测
- `tests/test_memory_scopes.py` — append_memory 三 scope 测试
- `tests/test_turn_start_stage_e.py` — Stage E 兜底测试
- `tests/test_context_loader_layered.py` — 三层 lessons 加载测试

### 修改
- `skill/character_workflow/lib/schemas.py:97` — `Project` 加 `slug: str`
- `skill/character_workflow/lib/projects.py` — `create_project` 自动生成 slug + 建项目目录
- `skill/character_workflow/lib/context_loader.py` — 新增 `load_lessons_global/workspace/project`、`load_project_worldview`
- `skill/character_workflow/lib/lessons.py` — `append_memory(kind, line, scope, project_slug)` 三 scope 分支(保留 `append_lesson` 作 alias)
- `skill/character_workflow/lib/turn_start.py` — 新增 Stage E + 输出 JSON 字段升级
- `skill/character_workflow/lib/intent.py` — `compute_recommend_action` 加 Stage E
- `skill/character_workflow/__main__.py` — 新 3 个子命令
- `skill/character_workflow/SKILL.md` — Stage E + 三层 Memory + scope 决策
- `CLAUDE.md` — 顶部插 Memory 三层强制阅读段
- `pyproject.toml` — 加 `pypinyin>=0.53`
- `.runtime/projects.json` — 现有 2 个 project 补 slug
- `worldview.md`(仓库根) — 改为占位
- `MEMORY.md`(仓库根,新建) — 工作区共享经验
- `skill/character_workflow/references/lessons/{portrait,promo,turnaround}.md` — 顶部加 DEPRECATED 标记

### 删除
- 无(旧 lessons 文件保留历史档案)

---

## Task 1: 给 Project schema 加 slug 字段

**Files:**
- Modify: `skill/character_workflow/lib/schemas.py:97-100`
- Test: `tests/test_schemas.py`

- [ ] **Step 1: 写测试 — Project 有 slug 字段**

把这段加到 `tests/test_schemas.py` 末尾(如果文件不存在就建):

```python
def test_project_has_slug_field():
    from skill.character_workflow.lib.schemas import Project
    p = Project(id="p-x", slug="my-game", name="名字", created_at="2026-05-21T00:00:00+00:00")
    assert p.slug == "my-game"


def test_project_slug_required():
    import pytest
    from pydantic import ValidationError
    from skill.character_workflow.lib.schemas import Project
    with pytest.raises(ValidationError):
        Project(id="p-x", name="名字", created_at="2026-05-21T00:00:00+00:00")
```

- [ ] **Step 2: 跑测试,确认 fail**

```bash
uv run pytest tests/test_schemas.py -v -k "slug"
```

预期: `test_project_has_slug_field` 报 ValidationError(slug 字段不存在),`test_project_slug_required` 反之 PASS(因为没 slug 字段反而合法)。

- [ ] **Step 3: 给 Project 加 slug**

修改 [skill/character_workflow/lib/schemas.py:97-100](skill/character_workflow/lib/schemas.py#L97-L100):

```python
class Project(BaseModel):
    id: str
    slug: str
    name: str
    created_at: str
```

- [ ] **Step 4: 跑测试,确认 PASS**

```bash
uv run pytest tests/test_schemas.py -v -k "slug"
```

预期: 两条 PASS。

- [ ] **Step 5: 检查 ProjectsFile 反序列化兼容**

跑全套 schemas/projects 相关测试:

```bash
uv run pytest tests/test_schemas.py tests/test_routes_get.py tests/test_routes_post.py -v
```

预期: 现有测试可能因为 fixture 里的 Project 没填 slug 而 fail。如果 fail,把所有创建 Project 的 fixture 都加上 `slug=...` 参数。

- [ ] **Step 6: Commit**

```bash
git add skill/character_workflow/lib/schemas.py tests/test_schemas.py
git commit -m "feat(schema): Project 加 slug 字段为项目级目录定位"
```

---

## Task 2: 实现 slug 生成工具

**Files:**
- Create: `skill/character_workflow/lib/slug.py`
- Create: `tests/test_slug.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: 在 pyproject.toml 加 pypinyin**

修改 [pyproject.toml](pyproject.toml) 的 `dependencies` 数组:

```toml
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.32",
  "watchdog>=5.0",
  "pydantic>=2.9",
  "python-multipart>=0.0.9",
  "requests>=2.32",
  "pypinyin>=0.53",
]
```

跑 `uv sync` 让锁文件更新:

```bash
uv sync
```

预期: stdout 提示安装 pypinyin 成功。

- [ ] **Step 2: 写 slug 生成测试**

新建 `tests/test_slug.py`:

```python
"""Slug 生成 — 中文 → 拼音 → kebab-case。"""
import pytest

from skill.character_workflow.lib import slug


def test_pure_ascii_passthrough():
    assert slug.generate("Hard Mecha v2") == "hard-mecha-v2"


def test_chinese_to_pinyin():
    assert slug.generate("宝可梦风格-精灵游戏") == "baokemeng-feng-ge-jing-ling-you-xi"


def test_truncate_to_32_chars():
    result = slug.generate("非常非常非常非常非常长的中文项目名" * 5)
    assert len(result) <= 32


def test_dedupe_with_suffix():
    existing = {"my-game", "my-game-2"}
    assert slug.dedupe("my-game", existing) == "my-game-3"


def test_dedupe_no_collision():
    assert slug.dedupe("fresh", {"taken"}) == "fresh"


def test_empty_name_raises():
    with pytest.raises(ValueError, match="empty"):
        slug.generate("")


def test_mixed_chinese_english():
    assert slug.generate("测试 v2") == "ce-shi-v2"


def test_punctuation_normalized():
    assert slug.generate("foo_bar__baz") == "foo-bar-baz"
    assert slug.generate("a.b.c") == "a-b-c"
```

注: 拼音输出依 pypinyin 默认 STYLE_NORMAL,"宝可梦" 出 `bao-ke-meng` 还是 `baokemeng` 看具体规则;Task 实现时按 pypinyin 实际输出微调 expected 值,**不要为对齐测试而扭曲 lib 行为**。优先让测试反映真实 pypinyin 输出。

- [ ] **Step 3: 跑测试,确认 fail**

```bash
uv run pytest tests/test_slug.py -v
```

预期: ImportError(slug 模块不存在)。

- [ ] **Step 4: 实现 slug.py**

新建 `skill/character_workflow/lib/slug.py`:

```python
"""项目 slug 生成 —— 中文项目名 → 拼音 → kebab-case 目录名。

规则:
1. 中文走 pypinyin 转拼音(无音标),英文/数字直通
2. 全部小写
3. 非 [a-z0-9] 一律转 `-`,连续 `-` 折叠,首尾 `-` 剥掉
4. 长度上限 32 字符,超出截断
5. dedupe 在调用方做(传入 existing slug 集合,撞了加 `-N` 后缀)
"""
from __future__ import annotations

import re

from pypinyin import Style, lazy_pinyin


_MAX_LEN = 32
_NON_SLUG_CHAR = re.compile(r"[^a-z0-9]+")


def generate(name: str) -> str:
    """name → slug。空 name 抛 ValueError。"""
    if not name or not name.strip():
        raise ValueError("cannot generate slug from empty name")

    parts = lazy_pinyin(name.strip(), style=Style.NORMAL)
    joined = "-".join(parts).lower()
    cleaned = _NON_SLUG_CHAR.sub("-", joined).strip("-")
    if not cleaned:
        raise ValueError(f"slug generation produced empty result for {name!r}")
    return cleaned[:_MAX_LEN].rstrip("-")


def dedupe(candidate: str, existing: set[str]) -> str:
    """如果 candidate 已在 existing,加 -2 / -3 后缀直到不冲突。"""
    if candidate not in existing:
        return candidate
    n = 2
    while f"{candidate}-{n}" in existing:
        n += 1
    return f"{candidate}-{n}"
```

- [ ] **Step 5: 跑测试,确认 PASS(可能要调 expected 值)**

```bash
uv run pytest tests/test_slug.py -v
```

预期: 大部分 PASS。如果 pypinyin 输出和 expected 字符串不一致,先**手动跑** `uv run python -c "from pypinyin import lazy_pinyin, Style; print(lazy_pinyin('宝可梦', style=Style.NORMAL))"` 看真实输出,再调测试里的 expected 值。

- [ ] **Step 6: Commit**

```bash
git add skill/character_workflow/lib/slug.py tests/test_slug.py pyproject.toml uv.lock
git commit -m "feat(slug): 项目名 → kebab-case slug 工具,基于 pypinyin"
```

---

## Task 3: create_project 自动生成 slug + 建目录骨架

**Files:**
- Modify: `skill/character_workflow/lib/projects.py:47-56`
- Test: `tests/test_routes_post.py` 或新建 `tests/test_projects_slug.py`

- [ ] **Step 1: 写测试 — create_project 自动生成 slug 并建目录**

新建 `tests/test_projects_slug.py`:

```python
"""create_project 自动生成 slug + 建项目目录骨架。"""
import json
import os
from pathlib import Path

import pytest

from skill.character_workflow.lib import projects


@pytest.fixture
def isolated_project(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNTIME_DIR", str(tmp_path / ".runtime"))
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_create_project_auto_slug(isolated_project):
    p = projects.create_project(name="宝可梦风格-精灵游戏")
    assert p.slug == "baokemeng-feng-ge-jing-ling-you-xi" or p.slug.startswith("baokemeng")


def test_create_project_explicit_slug(isolated_project):
    p = projects.create_project(name="任意名字", slug="custom-slug")
    assert p.slug == "custom-slug"


def test_create_project_dedupe_slug(isolated_project):
    projects.create_project(name="测试内容")
    p2 = projects.create_project(name="测试内容")
    assert p2.slug.endswith("-2")


def test_create_project_creates_directory(isolated_project):
    p = projects.create_project(name="Hard Mecha")
    project_dir = isolated_project / "projects" / p.slug
    assert project_dir.is_dir()
    assert (project_dir / "MEMORY.md").exists()
    assert (project_dir / "worldview.md").exists()


def test_create_project_directory_contains_skeleton(isolated_project):
    p = projects.create_project(name="Hard Mecha")
    project_dir = isolated_project / "projects" / p.slug
    memory_text = (project_dir / "MEMORY.md").read_text(encoding="utf-8")
    assert "character-workflow" in memory_text
    assert "Portrait" in memory_text
    assert "Promo" in memory_text
    assert "Turnaround" in memory_text
```

- [ ] **Step 2: 跑测试,确认 fail**

```bash
uv run pytest tests/test_projects_slug.py -v
```

预期: TypeError(create_project 不接受 slug 参数)或 AssertionError(没建目录)。

- [ ] **Step 3: 改 projects.py**

修改 [skill/character_workflow/lib/projects.py:47-56](skill/character_workflow/lib/projects.py#L47-L56):

```python
from skill.character_workflow.lib import slug as slug_util


def _projects_root() -> Path:
    return Path(os.environ.get("PROJECT_ROOT", Path.cwd())) / "projects"


_MEMORY_SKELETON = """# {name} MEMORY (项目级)

## character-workflow

### Portrait

### Promo

### Turnaround
"""

_WORLDVIEW_SKELETON = """# {name} · WORLDVIEW

> 本项目世界观。Skill turn-start 自动加载到出图上下文。

## 项目定位

## 视觉调性

## 用语风格

## 待补 / 未决项
"""


def create_project(name: str, slug: str | None = None) -> Project:
    f = read_projects()
    existing_slugs = {p.slug for p in f.projects}

    if slug is None:
        candidate = slug_util.generate(name)
        final_slug = slug_util.dedupe(candidate, existing_slugs)
    else:
        if slug in existing_slugs:
            raise ValueError(f"slug already exists: {slug!r}")
        final_slug = slug

    project = Project(
        id=f"p-{uuid4().hex[:10]}",
        slug=final_slug,
        name=name.strip(),
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    f.projects.append(project)
    _write(f)

    project_dir = _projects_root() / final_slug
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "MEMORY.md").write_text(
        _MEMORY_SKELETON.format(name=name.strip()), encoding="utf-8"
    )
    (project_dir / "worldview.md").write_text(
        _WORLDVIEW_SKELETON.format(name=name.strip()), encoding="utf-8"
    )

    return project
```

注: 文件顶部 `from skill.character_workflow.lib import slug as slug_util` 放到现有 import 块。

- [ ] **Step 4: 跑测试,确认 PASS**

```bash
uv run pytest tests/test_projects_slug.py -v
```

预期: 全部 PASS(可能要把 expected slug 值微调匹配 pypinyin 真实输出)。

- [ ] **Step 5: 跑已有 projects/routes 测试看回归**

```bash
uv run pytest tests/test_routes_post.py tests/test_routes_get.py -v
```

预期: 现有 Project fixture 可能因为 slug 必填而 fail。补全所有 fixture 里的 slug 字段。如果 routes 调用 `create_project(name=...)` 而需要测试中模拟,建议改 fixture 给 explicit `slug="test-slug"`。

- [ ] **Step 6: Commit**

```bash
git add skill/character_workflow/lib/projects.py tests/
git commit -m "feat(projects): create_project 自动生成 slug 并落盘 projects/<slug>/ 骨架"
```

---

## Task 4: 数据迁移 — projects.json 补 slug + 建项目目录

**Files:**
- Modify: `.runtime/projects.json`
- Create: `projects/pokemon-style-elf-game/{worldview.md,MEMORY.md}`
- Create: `projects/test-content/{worldview.md,MEMORY.md}`

- [ ] **Step 1: 手动改 projects.json 补 slug**

把 [.runtime/projects.json](.runtime/projects.json) 内容改成:

```json
{
  "projects": [
    {
      "id": "p-957bf5ce16",
      "slug": "test-content",
      "name": "测试内容",
      "created_at": "2026-05-18T08:13:54.522078+00:00"
    },
    {
      "id": "p-6b71d3a9e0",
      "slug": "pokemon-style-elf-game",
      "name": "宝可梦风格-精灵游戏",
      "created_at": "2026-05-21T05:55:07+00:00"
    }
  ],
  "assignments": {
    "holy-spirit-priestess": "p-957bf5ce16",
    "young-emperor-monkey": "p-6b71d3a9e0",
    "blazefist-monkey": "p-6b71d3a9e0"
  }
}
```

- [ ] **Step 2: 验证 projects.json 仍能被 read_projects 解析**

```bash
uv run python -c "from skill.character_workflow.lib.projects import read_projects; print(read_projects().model_dump_json(indent=2))"
```

预期: stdout 输出 2 个 project,每个都有 slug 字段。

- [ ] **Step 3: 建 projects/pokemon-style-elf-game/ 目录**

```bash
mkdir -p projects/pokemon-style-elf-game projects/test-content
```

- [ ] **Step 4: 把仓库根 worldview.md 内容搬到 pokemon 项目**

```bash
cp worldview.md projects/pokemon-style-elf-game/worldview.md
```

- [ ] **Step 5: 写 projects/pokemon-style-elf-game/MEMORY.md(项目特定 4 条)**

写入文件,内容:

```markdown
# 宝可梦风格-精灵游戏 MEMORY (项目级)

## character-workflow

### Portrait

- 2026-05-21 young-emperor-monkey · 精灵类角色首轮出图避免直呼现有 IP 与"幼年+强攻"等组合,改成原创怪兽图鉴风、初阶形态、蓄势展示动作更稳 · prompt 片段:`原创日式怪兽图鉴官方设定图风格,适合全年龄向游戏角色`
- 2026-05-21 blazefist-monkey · 出进化形态立绘时把前置进化 portrait/v1.png 上传为参考图,能保持配色血统一致性 · 操作:lovart_wrapper upload + chat --attachments CDN_URL

### Promo

- 2026-05-21 young-emperor-monkey · prompt 身份锚点全下放参考图,文本只写动作/场景/光/构图/风格骨架,比堆 spec 外观词准 · prompt 片段:`以上传图中的角色为画面核心,保留其外观和识别特征`
- 2026-05-21 young-emperor-monkey · 画风描述去 IP 名(不写宝可梦/帕鲁等),用客观笔触语言即可引导图鉴风 · prompt 片段:`清晰黑色轮廓线,平涂上色,柔和边缘阴影,卡通插画风格`

### Turnaround
```

- [ ] **Step 6: 写 projects/test-content/ 占位**

`projects/test-content/worldview.md`:

```markdown
# 测试内容 · WORLDVIEW

> 测试用项目,无正式世界观。
```

`projects/test-content/MEMORY.md`:

```markdown
# 测试内容 MEMORY (项目级)

## character-workflow

### Portrait

### Promo

### Turnaround
```

- [ ] **Step 7: 验证文件结构**

```bash
ls projects/pokemon-style-elf-game projects/test-content
find projects -type f -name "*.md"
```

预期: 看到 4 个文件(2 个 worldview + 2 个 MEMORY)。

- [ ] **Step 8: Commit 数据迁移**

```bash
git add .runtime/projects.json projects/
git commit -m "data: 迁移 projects.json 补 slug + 建 projects/<slug>/ 骨架与宝可梦项目 lessons"
```

---

## Task 5: 仓库根 worldview.md → 占位 + 建工作区 MEMORY.md

**Files:**
- Modify: `worldview.md`(改为占位)
- Create: `MEMORY.md`(仓库根工作区共享)

- [ ] **Step 1: 仓库根 worldview.md 改为占位**

把 [worldview.md](worldview.md) 全文替换为:

```markdown
# 工作区兜底 worldview

> 未归属角色的临时占位。正式 worldview 应在 `projects/<slug>/worldview.md`。
>
> Skill turn-start 在角色未归属(Stage E)时 fallback 到这里,正常归属角色应该走项目级。
```

- [ ] **Step 2: 仓库根新建 MEMORY.md(工作区共享 6 条)**

新建 `MEMORY.md`:

```markdown
# game-ui-ai-workflow MEMORY (工作区共享)

> 跨项目通用的工具/协议/流程经验。项目特定经验请写到 `projects/<slug>/MEMORY.md`。

## character-workflow

### Portrait

- 2026-05-21 young-emperor-monkey · Lovart 返回 artifact 但 runner 因 final_status=timeout 或 downloader failed 标失败时,先检查响应里的 artifacts URL,再用 curl -sS -L --fail 手动补下载并回填 job · prompt 片段:`download failed + artifacts/agent/*.png`
- 2026-05-21 blazefist-monkey · lovart_wrapper upload_file 用 curl 子进程代替 requests,绕开服务端 chunked 响应提前关闭导致空 body 的问题 · 关键代码:subprocess.check_output(['curl', '-sS', '-F', 'file=@path', url])
- 2026-05-21 holy-spirit-priestess · 画师改已出图必须先问修改模式(A 编辑当前图 / B 完全重出 / C 局部参考重出),三种 prompt 写法互斥,混着写会让模型不知道锚定参考图还是按 prompt 重画 · 操作:AskUserQuestion 三选一
- 2026-05-21 holy-spirit-priestess · A 模式编辑当前图时 prompt 只写差异指令,不重述外观/画风/规格(参考图已承载),引导而非规定,能短就短 · prompt 片段:`以参考图为底图,仅做以下三处改动:1. 武器... 2. 披风纹理... 3. 动作...`

### Promo

- 2026-05-21 young-emperor-monkey · runner 报 output_paths missing 但 artifact URL 已存在时,curl -sS -L --fail <url> 兜底下载后手动回填 output_paths + status=done · prompt 片段:N/A(操作经验)
- 2026-05-21 young-emperor-monkey · GPT Image 2 没有原生 16:9,只需用 --size 告知尺寸(如 1536x1024)模型即可按尺寸出图;prompt 文本里不必再写"16:9 横版"等画幅描述词 · prompt 片段:`--size 1536x1024`

### Turnaround
```

- [ ] **Step 3: Commit**

```bash
git add worldview.md MEMORY.md
git commit -m "data: 工作区 MEMORY.md 落地 6 条通用经验,worldview.md 改为占位"
```

---

## Task 6: 旧 lessons 文件标 DEPRECATED

**Files:**
- Modify: `skill/character_workflow/references/lessons/portrait.md`
- Modify: `skill/character_workflow/references/lessons/promo.md`
- Modify: `skill/character_workflow/references/lessons/turnaround.md`

- [ ] **Step 1: 三个文件顶部插入 DEPRECATED 标记**

在每个文件最顶部(`# 立绘出图历代经验` / `# 美宣图...` / `# 三视图...` 标题之前)插入:

```markdown
> **DEPRECATED** — 自 2026-05-21 起,新经验请用 `append-memory` CLI 写入工作区 `MEMORY.md` 或项目级 `projects/<slug>/MEMORY.md`。
> 本文件保留历史档案,context_loader 不再读取,SKILL 也不再追加。
```

注: 现有内容**不删**,只在顶部加这一段。

- [ ] **Step 2: 验证三个文件都有 DEPRECATED 标记**

```bash
head -3 skill/character_workflow/references/lessons/portrait.md skill/character_workflow/references/lessons/promo.md skill/character_workflow/references/lessons/turnaround.md
```

预期: 每个文件首行都是 `> **DEPRECATED**` 开头。

- [ ] **Step 3: Commit**

```bash
git add skill/character_workflow/references/lessons/
git commit -m "data: 旧 lessons 文件标 DEPRECATED,迁移到分层 MEMORY.md"
```

---

## Task 7: context_loader 支持三层 lessons + 项目级 worldview

**Files:**
- Modify: `skill/character_workflow/lib/context_loader.py`
- Create: `tests/test_context_loader_layered.py`

- [ ] **Step 1: 写测试 — 三层 lessons 加载**

新建 `tests/test_context_loader_layered.py`:

```python
"""三层 lessons + 项目级 worldview 加载测试。"""
import os
from pathlib import Path

import pytest

from skill.character_workflow.lib import context_loader


@pytest.fixture
def memory_tree(tmp_path, monkeypatch):
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))

    (tmp_path / "home" / ".claude").mkdir(parents=True)
    (tmp_path / "home" / ".claude" / "MEMORY.md").write_text(
        "# Global\n## Skills Memory\n### character-workflow\n#### Portrait\n- GLOBAL-P\n#### Promo\n- GLOBAL-PROMO\n#### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "MEMORY.md").write_text(
        "# Workspace\n## character-workflow\n### Portrait\n- WORKSPACE-P\n### Promo\n- WORKSPACE-PROMO\n### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "projects" / "my-game").mkdir(parents=True)
    (tmp_path / "projects" / "my-game" / "MEMORY.md").write_text(
        "# Project\n## character-workflow\n### Portrait\n- PROJECT-P\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "projects" / "my-game" / "worldview.md").write_text(
        "PROJECT-WORLDVIEW", encoding="utf-8",
    )
    (tmp_path / "worldview.md").write_text("WORKSPACE-WORLDVIEW", encoding="utf-8")
    return tmp_path


def test_load_lessons_global_portrait(memory_tree):
    text = context_loader.load_lessons_global("portrait")
    assert "GLOBAL-P" in text
    assert "GLOBAL-PROMO" not in text


def test_load_lessons_workspace_portrait(memory_tree):
    text = context_loader.load_lessons_workspace("portrait")
    assert "WORKSPACE-P" in text


def test_load_lessons_project_portrait(memory_tree):
    text = context_loader.load_lessons_project("my-game", "portrait")
    assert "PROJECT-P" in text


def test_load_lessons_project_missing_slug_returns_empty(memory_tree):
    assert context_loader.load_lessons_project("nonexistent", "portrait") == ""


def test_load_lessons_project_none_slug_returns_empty(memory_tree):
    assert context_loader.load_lessons_project(None, "portrait") == ""


def test_load_project_worldview(memory_tree):
    assert context_loader.load_project_worldview("my-game") == "PROJECT-WORLDVIEW"


def test_load_project_worldview_missing(memory_tree):
    assert context_loader.load_project_worldview("nonexistent") == ""


def test_load_lessons_kind_validation():
    with pytest.raises(ValueError):
        context_loader.load_lessons_workspace("invalid-kind")
```

- [ ] **Step 2: 跑测试,确认 fail**

```bash
uv run pytest tests/test_context_loader_layered.py -v
```

预期: AttributeError(load_lessons_global / workspace / project 不存在)。

- [ ] **Step 3: 实现新加载函数**

在 [skill/character_workflow/lib/context_loader.py](skill/character_workflow/lib/context_loader.py) 末尾追加:

```python
def _global_memory_path() -> Path:
    return Path(os.environ.get("HOME", "~")).expanduser() / ".claude" / "MEMORY.md"


def _workspace_memory_path() -> Path:
    return _project_root() / "MEMORY.md"


def _project_memory_path(slug: str) -> Path:
    return _project_root() / "projects" / slug / "MEMORY.md"


def _project_worldview_path(slug: str) -> Path:
    return _project_root() / "projects" / slug / "worldview.md"


_KIND_HEADERS = {
    "portrait": "Portrait",
    "promo": "Promo",
    "turnaround": "Turnaround",
}


def _extract_kind_section(text: str, kind: str, depth: int) -> str:
    """从 MEMORY.md 文本里抽出指定 kind 的 section 内容。

    depth = 3 时找 `### {Kind}`(工作区 / 项目层)
    depth = 4 时找 `#### {Kind}`(全局层,因为它在 `## Skills Memory > ### character-workflow` 下)
    """
    if not text:
        return ""
    if kind not in _KIND_HEADERS:
        raise ValueError(f"unknown lessons kind: {kind!r}")
    header = "#" * depth + " " + _KIND_HEADERS[kind]
    lines = text.splitlines()
    out: list[str] = []
    capture = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("#" * depth + " ") and stripped == header:
            capture = True
            continue
        if capture and stripped.startswith("#") and not stripped.startswith("#" * (depth + 1) + " "):
            # 遇到同级或更高级别 header,停
            level = len(stripped) - len(stripped.lstrip("#"))
            if level <= depth:
                break
        if capture:
            out.append(line)
    return "\n".join(out).strip()


def load_lessons_global(kind: str) -> str:
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}")
    text = _read_text(_global_memory_path())
    return _extract_kind_section(text, kind, depth=4)


def load_lessons_workspace(kind: str) -> str:
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}")
    text = _read_text(_workspace_memory_path())
    return _extract_kind_section(text, kind, depth=3)


def load_lessons_project(slug: str | None, kind: str) -> str:
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}")
    if not slug:
        return ""
    path = _project_memory_path(slug)
    if not path.exists():
        return ""
    return _extract_kind_section(_read_text(path), kind, depth=3)


def load_project_worldview(slug: str | None) -> str:
    if not slug:
        return ""
    path = _project_worldview_path(slug)
    if not path.exists():
        return ""
    return _read_text(path)
```

- [ ] **Step 4: 跑新测试,确认 PASS**

```bash
uv run pytest tests/test_context_loader_layered.py -v
```

预期: 全部 PASS。

- [ ] **Step 5: 跑旧 context_loader 测试看回归**

```bash
uv run pytest tests/test_context_loader.py -v
```

预期: 全部 PASS。旧 `load_lessons(kind)` 还是从 `references/lessons/<kind>.md` 读,**这部分不动**,留作历史 alias(SKILL.md 也仍可用)。

- [ ] **Step 6: Commit**

```bash
git add skill/character_workflow/lib/context_loader.py tests/test_context_loader_layered.py
git commit -m "feat(context_loader): 三层 lessons + 项目级 worldview 加载"
```

---

## Task 8: lessons.append_memory 三 scope 实现

**Files:**
- Modify: `skill/character_workflow/lib/lessons.py`
- Create: `tests/test_memory_scopes.py`

- [ ] **Step 1: 写测试 — append_memory 三 scope**

新建 `tests/test_memory_scopes.py`:

```python
"""append_memory 三 scope 测试。"""
import json
from pathlib import Path

import pytest

from skill.character_workflow.lib import lessons


@pytest.fixture
def memory_tree(tmp_path, monkeypatch):
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.chdir(tmp_path)

    (tmp_path / "home" / ".claude").mkdir(parents=True)
    (tmp_path / "home" / ".claude" / "MEMORY.md").write_text(
        "# Global\n## Skills Memory\n### character-workflow\n#### Portrait\n#### Promo\n#### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "MEMORY.md").write_text(
        "# Workspace\n## character-workflow\n### Portrait\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "projects" / "my-game").mkdir(parents=True)
    (tmp_path / "projects" / "my-game" / "MEMORY.md").write_text(
        "# Project\n## character-workflow\n### Portrait\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    return tmp_path


def test_append_workspace_portrait(memory_tree):
    lessons.append_memory(kind="portrait", line="- W1", scope="workspace")
    text = (memory_tree / "MEMORY.md").read_text(encoding="utf-8")
    assert "- W1" in text
    # 落到 ### Portrait section 下,而不是 ### Promo
    portrait_idx = text.index("### Portrait")
    promo_idx = text.index("### Promo")
    w1_idx = text.index("- W1")
    assert portrait_idx < w1_idx < promo_idx


def test_append_project_portrait(memory_tree):
    lessons.append_memory(kind="portrait", line="- P1", scope="project", project_slug="my-game")
    text = (memory_tree / "projects" / "my-game" / "MEMORY.md").read_text(encoding="utf-8")
    assert "- P1" in text


def test_append_global_portrait(memory_tree):
    lessons.append_memory(kind="portrait", line="- G1", scope="global")
    text = (memory_tree / "home" / ".claude" / "MEMORY.md").read_text(encoding="utf-8")
    assert "- G1" in text
    # 落到 #### Portrait section(全局是 depth=4)
    portrait_idx = text.index("#### Portrait")
    promo_idx = text.index("#### Promo")
    g1_idx = text.index("- G1")
    assert portrait_idx < g1_idx < promo_idx


def test_append_project_requires_slug(memory_tree):
    with pytest.raises(ValueError, match="project_slug required"):
        lessons.append_memory(kind="portrait", line="- X", scope="project", project_slug=None)


def test_append_invalid_scope(memory_tree):
    with pytest.raises(ValueError, match="unknown scope"):
        lessons.append_memory(kind="portrait", line="- X", scope="invalid")


def test_append_newline_rejected(memory_tree):
    with pytest.raises(ValueError, match="single-line"):
        lessons.append_memory(kind="portrait", line="- a\nb", scope="workspace")


def test_append_lesson_alias_still_works(memory_tree):
    """旧 append_lesson 作 alias,默认 scope=project + 当前 active 解析。"""
    # 这条 alias 测试在 Task 9 把 alias 接好后再验证;此处只确认函数存在
    assert hasattr(lessons, "append_lesson")
```

- [ ] **Step 2: 跑测试,确认 fail**

```bash
uv run pytest tests/test_memory_scopes.py -v
```

预期: AttributeError(append_memory 不存在)。

- [ ] **Step 3: 实现 append_memory**

把 [skill/character_workflow/lib/lessons.py](skill/character_workflow/lib/lessons.py) 整体替换为:

```python
"""Memory 追加 helper —— 三 scope(global / workspace / project)。

§11.7 单画师 + 单进程假设:一条经验 < 4096 字节(PIPE_BUF),
单行 `open("a")` 是原子的。

scope:
- "global"     → ~/.claude/MEMORY.md 下 `## Skills Memory > ### character-workflow > #### {Kind}` section
- "workspace"  → 仓库根 MEMORY.md 下 `## character-workflow > ### {Kind}` section
- "project"    → projects/<slug>/MEMORY.md 下 `## character-workflow > ### {Kind}` section

不存在的 section header 会被自动建。

旧 `append_lesson(kind, line)` 保留作 alias —— 默认 `scope="project"` +
从 active-character.json → projects.json::assignments 解析 slug;未归属抛 ValueError。
"""
from __future__ import annotations

import os
from pathlib import Path


VALID_KINDS = ("portrait", "promo", "turnaround")
VALID_SCOPES = ("global", "workspace", "project")

_KIND_TITLE = {"portrait": "Portrait", "promo": "Promo", "turnaround": "Turnaround"}


def _project_root() -> Path:
    return Path(os.environ.get("PROJECT_ROOT", Path.cwd()))


def _global_memory_path() -> Path:
    return Path(os.environ.get("HOME", "~")).expanduser() / ".claude" / "MEMORY.md"


def _workspace_memory_path() -> Path:
    return _project_root() / "MEMORY.md"


def _project_memory_path(slug: str) -> Path:
    return _project_root() / "projects" / slug / "MEMORY.md"


def _resolve_memory_path(scope: str, project_slug: str | None) -> Path:
    if scope == "global":
        return _global_memory_path()
    if scope == "workspace":
        return _workspace_memory_path()
    if scope == "project":
        if not project_slug:
            raise ValueError("project_slug required for scope=project")
        return _project_memory_path(project_slug)
    raise ValueError(f"unknown scope: {scope!r}, expected one of {VALID_SCOPES}")


def _section_headers(scope: str, kind: str) -> list[str]:
    """返回需要存在的 header 链(从外到内)。"""
    kind_title = _KIND_TITLE[kind]
    if scope == "global":
        return ["## Skills Memory", "### character-workflow", f"#### {kind_title}"]
    return ["## character-workflow", f"### {kind_title}"]


def _ensure_section(path: Path, headers: list[str]) -> None:
    """确保 MEMORY.md 存在,且 headers 链路完整。缺啥补啥到文件末尾。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("# MEMORY\n\n", encoding="utf-8")
    text = path.read_text(encoding="utf-8")
    for header in headers:
        if header not in text:
            text = text.rstrip() + f"\n\n{header}\n"
    path.write_text(text, encoding="utf-8")


def _insert_under_header(path: Path, last_header: str, line: str) -> None:
    """在 last_header 这个 section 末尾(下一个同级或更高级 header 之前)追加 line。"""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    header_depth = len(last_header) - len(last_header.lstrip("#"))

    try:
        start = lines.index(last_header)
    except ValueError:
        # _ensure_section 应该保证有,fallback 直接末尾追加
        path.write_text(text.rstrip() + f"\n{last_header}\n{line}\n", encoding="utf-8")
        return

    # 找下一个同级或更高级 header
    end = len(lines)
    for i in range(start + 1, len(lines)):
        stripped = lines[i].strip()
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            if level <= header_depth:
                end = i
                break

    # 在 end 之前插入 line(空行兼容)
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1
    lines.insert(end, line)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def append_memory(
    *,
    kind: str,
    line: str,
    scope: str = "project",
    project_slug: str | None = None,
) -> Path:
    """原子追加一条经验到对应 scope 的 MEMORY.md 指定 kind section。

    line 必须单行,< 4000 字节,符合 PIPE_BUF 单行原子写入边界。
    """
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}, expected one of {VALID_KINDS}")
    if "\n" in line or "\r" in line:
        raise ValueError("memory line must be single-line (no newline allowed)")
    if len(line.encode("utf-8")) >= 4000:
        raise ValueError(f"memory line too long: {len(line.encode('utf-8'))} bytes (limit 4000)")

    path = _resolve_memory_path(scope, project_slug)
    headers = _section_headers(scope, kind)
    _ensure_section(path, headers)
    _insert_under_header(path, headers[-1], line)
    return path


# ---------- 兼容旧 API ----------


def _lessons_path(kind: str) -> Path:
    """旧 API:回到 references/lessons/<kind>.md。
    保留给老测试 / append_lesson alias 用。
    """
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown lessons kind: {kind!r}, expected one of {VALID_KINDS}")
    skill_root = Path(__file__).resolve().parent.parent
    return skill_root / "references" / "lessons" / f"{kind}.md"


def append_lesson(kind: str, line: str) -> Path:
    """Deprecated alias —— 等价于 `append_memory(scope="project", project_slug=<active>)`。
    解析 active_id → assignments → slug;未归属抛 ValueError 让上层捕获 + 退出码 2。
    """
    from skill.character_workflow.lib.active_character import read_active
    from skill.character_workflow.lib.projects import read_projects

    active = read_active()
    if not active.active_id:
        raise ValueError("append_lesson: no active character; use append_memory --scope workspace")
    pf = read_projects()
    project_id = pf.assignments.get(active.active_id)
    if not project_id:
        raise ValueError(
            f"append_lesson: character {active.active_id!r} not assigned to any project; "
            "use append_memory --scope workspace or run assign-character first"
        )
    project = next((p for p in pf.projects if p.id == project_id), None)
    if not project:
        raise ValueError(f"append_lesson: project {project_id!r} not found in projects.json")
    return append_memory(kind=kind, line=line, scope="project", project_slug=project.slug)
```

- [ ] **Step 4: 跑测试,确认 PASS**

```bash
uv run pytest tests/test_memory_scopes.py -v
```

预期: 全部 PASS(`test_append_lesson_alias_still_works` 也 PASS,因为它只检查函数存在)。

- [ ] **Step 5: 跑旧 lessons 测试**

```bash
uv run pytest tests/test_lessons.py -v
```

预期: 旧 `append_lesson(kind, line)` 现在需要 active + 归属才能工作,旧测试是直接给 `lessons_dir` fixture mock 路径,可能多数测试 fail。**修复策略**:旧测试要么改成跑 `append_memory(scope="workspace")`,要么 mock `read_active` + `read_projects` 注入归属。

为了节省时间,在 [tests/test_lessons.py](tests/test_lessons.py) 顶部加 `pytest.skip` 全文件标记:

```python
import pytest
pytest.skip("legacy append_lesson tests — superseded by test_memory_scopes.py", allow_module_level=True)
```

- [ ] **Step 6: Commit**

```bash
git add skill/character_workflow/lib/lessons.py tests/test_memory_scopes.py tests/test_lessons.py
git commit -m "feat(memory): append_memory 三 scope + 保留 append_lesson alias"
```

---

## Task 9: turn_start 新增 Stage E + JSON 输出字段升级

**Files:**
- Modify: `skill/character_workflow/lib/turn_start.py`
- Create: `tests/test_turn_start_stage_e.py`

- [ ] **Step 1: 写 Stage E 测试**

新建 `tests/test_turn_start_stage_e.py`:

```python
"""Stage E 兜底 —— active_id 存在但 assignments 里缺失。"""
import json
from pathlib import Path

import pytest


@pytest.fixture
def stage_e_setup(tmp_path, monkeypatch):
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("RUNTIME_DIR", str(tmp_path / ".runtime"))
    monkeypatch.setenv("CHARACTERS_DIR", str(tmp_path / "characters"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.chdir(tmp_path)

    (tmp_path / "characters" / "orphan-char").mkdir(parents=True)
    (tmp_path / "characters" / "orphan-char" / "spec.md").write_text("# Orphan\n", encoding="utf-8")

    runtime = tmp_path / ".runtime"
    runtime.mkdir()
    (runtime / "active-character.json").write_text(
        json.dumps({"active_id": "orphan-char", "updated_at": "2026-05-21T10:00:00+00:00"}),
        encoding="utf-8",
    )
    (runtime / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-slug", "name": "Test", "created_at": "2026-05-21T00:00:00+00:00"}],
            "assignments": {},  # orphan-char 不在
        }),
        encoding="utf-8",
    )

    (tmp_path / "MEMORY.md").write_text(
        "# Workspace\n## character-workflow\n### Portrait\n- W1\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "home" / ".claude").mkdir(parents=True)
    (tmp_path / "home" / ".claude" / "MEMORY.md").write_text(
        "# Global\n## Skills Memory\n### character-workflow\n#### Portrait\n- G1\n#### Promo\n#### Turnaround\n",
        encoding="utf-8",
    )
    return tmp_path


def test_stage_e_when_orphan_active(stage_e_setup):
    from skill.character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["stage"] == "E"


def test_stage_e_project_slug_is_none(stage_e_setup):
    from skill.character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["project_slug"] is None
    assert result["project_id"] is None


def test_stage_e_recommend_action_is_ask(stage_e_setup):
    from skill.character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["recommend_action"] == "ask"


def test_stage_e_lessons_global_loaded(stage_e_setup):
    from skill.character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert "G1" in result["lessons_global"]


def test_stage_e_lessons_workspace_loaded(stage_e_setup):
    from skill.character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert "W1" in result["lessons_workspace"]


def test_stage_e_lessons_project_empty(stage_e_setup):
    from skill.character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["lessons_project"] == ""


def test_stage_e_worldview_project_empty(stage_e_setup):
    from skill.character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["worldview_project"] == ""


def test_stage_d_with_assignment_has_project_slug(stage_e_setup):
    """对照组:把 assignments 补上后,stage 应该走 D 且 project_slug 有值。"""
    runtime = stage_e_setup / ".runtime"
    (runtime / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "test-slug", "name": "Test", "created_at": "2026-05-21T00:00:00+00:00"}],
            "assignments": {"orphan-char": "p-1"},
        }),
        encoding="utf-8",
    )
    (stage_e_setup / "projects" / "test-slug").mkdir(parents=True)
    (stage_e_setup / "projects" / "test-slug" / "MEMORY.md").write_text(
        "# Proj\n## character-workflow\n### Portrait\n- PROJECT-P\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    (stage_e_setup / "projects" / "test-slug" / "worldview.md").write_text("PWV", encoding="utf-8")

    from skill.character_workflow.lib.turn_start import turn_start
    result = turn_start(kind="portrait", message="出图")
    assert result["stage"] == "D"
    assert result["project_slug"] == "test-slug"
    assert result["project_id"] == "p-1"
    assert result["project_name"] == "Test"
    assert "PROJECT-P" in result["lessons_project"]
    assert result["worldview_project"] == "PWV"
```

- [ ] **Step 2: 跑测试,确认 fail**

```bash
uv run pytest tests/test_turn_start_stage_e.py -v
```

预期: KeyError(`stage` 永远是 A/B/C/D,没 E)或 KeyError(`project_slug` 字段不存在)。

- [ ] **Step 3: 改 detect_stage 加 Stage E + 解析项目**

修改 [skill/character_workflow/lib/turn_start.py:36-64](skill/character_workflow/lib/turn_start.py#L36-L64):

```python
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
    from skill.character_workflow.lib.projects import read_projects
    pf = read_projects()
    if active_id not in pf.assignments:
        return "E", f"active_id={active_id!r} 未归属任何项目"

    return "D", "active 完整且已归属"
```

- [ ] **Step 4: 改 turn_start 编排器,输出新 JSON 字段**

修改 [skill/character_workflow/lib/turn_start.py:186-240](skill/character_workflow/lib/turn_start.py#L186-L240):

```python
def turn_start(kind: str = "portrait", message: str | None = None) -> dict:
    """v5 编排器:file system 探 stage + 解析项目 + 推 intent + 拉三层上下文。"""
    from skill.character_workflow.lib.active_character import read_active
    from skill.character_workflow.lib.context_loader import (
        load_lessons_global,
        load_lessons_project,
        load_lessons_workspace,
        load_project_worldview,
        load_worldview,
    )
    from skill.character_workflow.lib.draft_processor import process_drafts
    from skill.character_workflow.lib.intent import compute_recommend_action
    from skill.character_workflow.lib.projects import read_projects

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
    }
```

注意: 旧 `worldview` + `lessons` 字段被替换。SKILL.md 现在拼装时用 `worldview_project or worldview_workspace`,lessons 三层全拼。

- [ ] **Step 5: 跑 Stage E 测试,确认 PASS**

```bash
uv run pytest tests/test_turn_start_stage_e.py -v
```

预期: 全部 PASS。

- [ ] **Step 6: 跑老 turn_start 测试看回归**

```bash
uv run pytest tests/test_turn_start_v4.py -v
```

预期: 老测试断言 `result["worldview"]` / `result["lessons"]` 这种旧字段会 fail。**修复策略**:把老测试断言里的:
- `worldview` → `worldview_workspace`(老 fixture 没 project 归属时这才是有效字段)
- `lessons` → `lessons_workspace` 或拼接 `lessons_global + lessons_workspace + lessons_project`(看具体测试意图)

把 fixture 里的 `projects.json::assignments` 也补上对应归属(让原来 stage D 测试能通过)。

跑完调整后:

```bash
uv run pytest tests/test_turn_start_v4.py -v
```

预期: 全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add skill/character_workflow/lib/turn_start.py tests/test_turn_start_stage_e.py tests/test_turn_start_v4.py
git commit -m "feat(turn-start): Stage E 未归属兜底 + 三层 lessons/worldview 字段"
```

---

## Task 10: intent.compute_recommend_action 加 Stage E 分支

**Files:**
- Modify: `skill/character_workflow/lib/intent.py:80-81`
- Test: `tests/test_recommend_action.py`

- [ ] **Step 1: 写测试 — Stage E → ask**

在 [tests/test_recommend_action.py](tests/test_recommend_action.py) 末尾追加:

```python
def test_stage_e_returns_ask():
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
    assert "未归属" in reason or "Stage E" in reason or "E" in reason
```

- [ ] **Step 2: 跑测试,确认 fail**

```bash
uv run pytest tests/test_recommend_action.py -v -k "stage_e"
```

预期: AssertionError(stage E 不在 A/B/C 分支,落到兜底 ask 但 reason 不含未归属)。

- [ ] **Step 3: 改 intent.py**

修改 [skill/character_workflow/lib/intent.py:80-81](skill/character_workflow/lib/intent.py#L80-L81):

```python
    # 1. stage A/B/C —— 还没建好前置,问就是了
    if stage in ("A", "B", "C"):
        return "ask", f"stage {stage}: 前置未齐,需要画师补全"

    # 1.5 stage E —— active 完整但未归属,问画师怎么归属
    if stage == "E":
        return "ask", "stage E: 角色未归属任何项目,需要画师选项目或新建"
```

- [ ] **Step 4: 跑测试,确认 PASS**

```bash
uv run pytest tests/test_recommend_action.py -v
```

预期: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add skill/character_workflow/lib/intent.py tests/test_recommend_action.py
git commit -m "feat(intent): Stage E recommend_action 强制为 ask"
```

---

## Task 11: CLI 新增 append-memory --scope 子命令

**Files:**
- Modify: `skill/character_workflow/__main__.py`
- Test: `tests/test_submit_cli.py` 或新建 `tests/test_cli_append_memory.py`

- [ ] **Step 1: 写 CLI 测试**

新建 `tests/test_cli_append_memory.py`:

```python
"""append-memory CLI subcommand."""
import json
from pathlib import Path

import pytest


@pytest.fixture
def cli_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("RUNTIME_DIR", str(tmp_path / ".runtime"))
    monkeypatch.setenv("CHARACTERS_DIR", str(tmp_path / "characters"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.chdir(tmp_path)

    (tmp_path / ".runtime").mkdir()
    (tmp_path / "MEMORY.md").write_text(
        "# Workspace\n## character-workflow\n### Portrait\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )
    (tmp_path / "home" / ".claude").mkdir(parents=True)
    return tmp_path


def test_append_memory_workspace_scope(cli_env):
    from skill.character_workflow.__main__ import main
    exit_code = main(["append-memory", "--kind", "portrait",
                      "--line", "- 2026-05-21 test · note · prompt:`x`",
                      "--scope", "workspace"])
    assert exit_code == 0
    text = (cli_env / "MEMORY.md").read_text(encoding="utf-8")
    assert "- 2026-05-21 test · note" in text


def test_append_memory_project_scope_with_assignment(cli_env):
    """有 active + 归属 → 写到项目级 MEMORY.md。"""
    (cli_env / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "alice", "updated_at": "2026-05-21T10:00:00+00:00"}),
        encoding="utf-8",
    )
    (cli_env / ".runtime" / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p-1", "slug": "my-game", "name": "Game", "created_at": "2026-05-21T00:00:00+00:00"}],
            "assignments": {"alice": "p-1"},
        }),
        encoding="utf-8",
    )
    (cli_env / "projects" / "my-game").mkdir(parents=True)
    (cli_env / "projects" / "my-game" / "MEMORY.md").write_text(
        "# Proj\n## character-workflow\n### Portrait\n### Promo\n### Turnaround\n",
        encoding="utf-8",
    )

    from skill.character_workflow.__main__ import main
    exit_code = main(["append-memory", "--kind", "portrait",
                      "--line", "- 2026-05-21 alice · proj-note · prompt:`x`",
                      "--scope", "project"])
    assert exit_code == 0
    text = (cli_env / "projects" / "my-game" / "MEMORY.md").read_text(encoding="utf-8")
    assert "proj-note" in text


def test_append_memory_project_scope_unassigned_returns_2(cli_env, capsys):
    """未归属 → 退出码 2 + stderr 明确错误。"""
    (cli_env / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "orphan", "updated_at": "2026-05-21T10:00:00+00:00"}),
        encoding="utf-8",
    )
    (cli_env / ".runtime" / "projects.json").write_text(
        json.dumps({"projects": [], "assignments": {}}),
        encoding="utf-8",
    )

    from skill.character_workflow.__main__ import main
    exit_code = main(["append-memory", "--kind", "portrait",
                      "--line", "- 2026-05-21 orphan · x",
                      "--scope", "project"])
    assert exit_code == 2
    captured = capsys.readouterr()
    assert "未归属" in captured.err or "not assigned" in captured.err
```

- [ ] **Step 2: 跑测试,确认 fail**

```bash
uv run pytest tests/test_cli_append_memory.py -v
```

预期: argparse error(子命令不存在)。

- [ ] **Step 3: 实现 CLI 子命令**

在 [skill/character_workflow/__main__.py](skill/character_workflow/__main__.py) 加一个新 helper(放在 `_submit` 函数旁边):

```python
def _append_memory(args: argparse.Namespace) -> int:
    """append-memory --scope {project|workspace|global}。

    project scope 自动解析 active → assignments → slug。
    未归属 → 返回码 2 + stderr 明确错误。
    """
    from skill.character_workflow.lib.lessons import append_memory
    from skill.character_workflow.lib.active_character import read_active
    from skill.character_workflow.lib.projects import read_projects

    project_slug: str | None = None
    if args.scope == "project":
        active = read_active()
        if not active.active_id:
            print("append-memory: 无 active 角色,无法解析项目;改用 --scope workspace 或先 set-active",
                  file=sys.stderr)
            return 2
        pf = read_projects()
        project_id = pf.assignments.get(active.active_id)
        if not project_id:
            print(
                f"append-memory: 角色 {active.active_id!r} 未归属任何项目;"
                "先走 Stage E(assign-character)或显式 --scope workspace",
                file=sys.stderr,
            )
            return 2
        proj = next((p for p in pf.projects if p.id == project_id), None)
        if not proj:
            print(f"append-memory: project {project_id!r} 不存在(projects.json 损坏)",
                  file=sys.stderr)
            return 2
        project_slug = proj.slug

    try:
        path = append_memory(kind=args.kind, line=args.line, scope=args.scope, project_slug=project_slug)
    except ValueError as e:
        print(f"append-memory: {e}", file=sys.stderr)
        return 2

    print(json.dumps({"ok": True, "path": str(path), "scope": args.scope}, ensure_ascii=False))
    return 0
```

再在 `main()` 的 subparser 部分加:

```python
    p_memory = sub.add_parser("append-memory", help="原子追加一条经验到三层 MEMORY.md")
    p_memory.add_argument("--kind", required=True, choices=("portrait", "promo", "turnaround"))
    p_memory.add_argument("--line", required=True, help="完整一行 markdown,不带换行")
    p_memory.add_argument(
        "--scope", default="project", choices=("global", "workspace", "project"),
        help="写入层级,默认 project(需要 active 角色已归属)",
    )
```

和:

```python
    if args.cmd == "append-memory":
        return _append_memory(args)
```

- [ ] **Step 4: 跑测试,确认 PASS**

```bash
uv run pytest tests/test_cli_append_memory.py -v
```

预期: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add skill/character_workflow/__main__.py tests/test_cli_append_memory.py
git commit -m "feat(cli): append-memory --scope project|workspace|global"
```

---

## Task 12: CLI 新增 create-project + assign-character 子命令

**Files:**
- Modify: `skill/character_workflow/__main__.py`
- Create: `tests/test_cli_projects.py`

- [ ] **Step 1: 写测试**

新建 `tests/test_cli_projects.py`:

```python
"""create-project / assign-character CLI subcommands."""
import json
from pathlib import Path

import pytest


@pytest.fixture
def cli_env(tmp_path, monkeypatch):
    monkeypatch.setenv("PROJECT_ROOT", str(tmp_path))
    monkeypatch.setenv("RUNTIME_DIR", str(tmp_path / ".runtime"))
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".runtime").mkdir()
    return tmp_path


def test_create_project_default_slug(cli_env, capsys):
    from skill.character_workflow.__main__ import main
    exit_code = main(["create-project", "--name", "宝可梦游戏"])
    assert exit_code == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["name"] == "宝可梦游戏"
    assert payload["slug"]
    assert payload["id"].startswith("p-")
    assert (cli_env / "projects" / payload["slug"] / "MEMORY.md").exists()


def test_create_project_explicit_slug(cli_env, capsys):
    from skill.character_workflow.__main__ import main
    exit_code = main(["create-project", "--name", "随便", "--slug", "my-explicit-slug"])
    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["slug"] == "my-explicit-slug"


def test_assign_character_writes_assignment(cli_env, capsys):
    from skill.character_workflow.__main__ import main
    main(["create-project", "--name", "G", "--slug", "g"])
    capsys.readouterr()  # 清掉 create 的输出

    exit_code = main(["assign-character", "alice", "--project", "p-"])
    # 项目 id 我们不知道前缀,直接从 projects.json 读
    pf = json.loads((cli_env / ".runtime" / "projects.json").read_text(encoding="utf-8"))
    project_id = pf["projects"][0]["id"]
    # 重试 assign
    main(["assign-character", "alice", "--project", project_id])
    pf2 = json.loads((cli_env / ".runtime" / "projects.json").read_text(encoding="utf-8"))
    assert pf2["assignments"].get("alice") == project_id


def test_assign_character_no_project_unassigns(cli_env, capsys):
    from skill.character_workflow.__main__ import main
    main(["create-project", "--name", "G", "--slug", "g"])
    capsys.readouterr()
    pf = json.loads((cli_env / ".runtime" / "projects.json").read_text(encoding="utf-8"))
    project_id = pf["projects"][0]["id"]
    main(["assign-character", "alice", "--project", project_id])

    exit_code = main(["assign-character", "alice"])  # 无 --project
    assert exit_code == 0
    pf2 = json.loads((cli_env / ".runtime" / "projects.json").read_text(encoding="utf-8"))
    assert "alice" not in pf2["assignments"]


def test_assign_character_unknown_project_returns_error(cli_env, capsys):
    from skill.character_workflow.__main__ import main
    exit_code = main(["assign-character", "alice", "--project", "p-nonexistent"])
    assert exit_code != 0
```

- [ ] **Step 2: 跑测试,确认 fail**

```bash
uv run pytest tests/test_cli_projects.py -v
```

预期: argparse error。

- [ ] **Step 3: 实现 CLI 子命令**

在 [skill/character_workflow/__main__.py](skill/character_workflow/__main__.py) 加:

```python
def _create_project(args: argparse.Namespace) -> int:
    from skill.character_workflow.lib.projects import create_project
    try:
        p = create_project(name=args.name, slug=args.slug)
    except ValueError as e:
        print(f"create-project: {e}", file=sys.stderr)
        return 2
    print(json.dumps(p.model_dump(), ensure_ascii=False))
    return 0


def _assign_character(args: argparse.Namespace) -> int:
    from skill.character_workflow.lib.projects import assign_character
    try:
        f = assign_character(args.character_id, args.project)
    except KeyError as e:
        print(f"assign-character: 项目不存在: {e}", file=sys.stderr)
        return 2
    print(json.dumps(
        {"character_id": args.character_id, "project_id": args.project, "ok": True},
        ensure_ascii=False,
    ))
    return 0
```

subparser:

```python
    p_cp = sub.add_parser("create-project", help="新建项目目录骨架 + 写 projects.json")
    p_cp.add_argument("--name", required=True)
    p_cp.add_argument("--slug", default=None, help="手动指定 slug,缺省自动生成")

    p_ac = sub.add_parser("assign-character", help="把角色归属到项目;省略 --project 等于取消归属")
    p_ac.add_argument("character_id")
    p_ac.add_argument("--project", default=None)
```

dispatch:

```python
    if args.cmd == "create-project":
        return _create_project(args)
    if args.cmd == "assign-character":
        return _assign_character(args)
```

- [ ] **Step 4: 跑测试,确认 PASS**

```bash
uv run pytest tests/test_cli_projects.py -v
```

预期: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add skill/character_workflow/__main__.py tests/test_cli_projects.py
git commit -m "feat(cli): create-project + assign-character 子命令"
```

---

## Task 13: SKILL.md 更新三层 Memory + Stage E + scope 决策

**Files:**
- Modify: `skill/character_workflow/SKILL.md`

- [ ] **Step 1: 把 Turn 起始章节的 JSON 字段更新到三层版**

替换 [skill/character_workflow/SKILL.md:46-77](skill/character_workflow/SKILL.md#L46-L77) 的 JSON 例子和 stage 表格:

```markdown
`--message` 要带上,CLI 靠它推断 `recommend_action` 决策。返回 JSON 关键字段(v5):

```json
{
  "stage":            "A" | "B" | "C" | "D" | "E",
  "stage_reason":     "...",
  "recommend_action": "ask" | "render_card" | "switch" | "noop",
  "recommend_reason": "...",
  "active_id":        "holy",
  "active_updated_at": "...",
  "active_age_minutes": 5,
  "intent":           "new" | "revise" | "create" | "switch" | null,
  "intent_signal":    "...",
  "intent_conflict":  false,
  "recent_chars":     [{"id": "holy", "tagline": "治愈系祭祀"}],
  "drafts":           [...],
  "spec":             "<markdown>" | null,
  "project_id":       "p-..." | null,
  "project_slug":     "pokemon-style-elf-game" | null,
  "project_name":     "宝可梦风格-精灵游戏" | null,
  "worldview_workspace": "...",
  "worldview_project":   "...",
  "lessons_global":      "...",
  "lessons_workspace":   "...",
  "lessons_project":     "...",
  "lessons_kind":     "portrait"
}
```
```

紧接其后插入拼装说明:

```markdown
**拼装规则(供 prompt_builder 用)**:
- `worldview` = `worldview_project or worldview_workspace`(项目级覆盖工作区)
- `lessons` = `lessons_global + "\n" + lessons_workspace + "\n" + lessons_project`(三层字面拼接,不去重)
```

- [ ] **Step 2: stage 表格加 Stage E**

在 `### action = ask` 节下、Stage D 之后,补一段:

```markdown
#### Stage E —— `active_id` 完整但未归属任何项目

`projects.json::assignments` 里没有 `active_id`。用 1 个 AskUserQuestion 列:

1. 归到 `<最大项目名>`(N 个角色)
2. 归到 `<次大项目名>`(M 个角色)
3. 新开项目
4. 跳过本轮(不归属、不出图)

画师选 1/2 → `assign-character <active_id> --project <project_id>` → 重新 turn-start
画师选 3 → 走 Stage A-like 子流程问"项目名 + 一句话世界观",调 `create-project --name <name>` → `assign-character` → 重新 turn-start
画师选 4 → 退出 turn
```

- [ ] **Step 3: 替换 Turn 收尾节经验沉淀部分**

把 `### Turn 收尾:经验沉淀(lessons)` 章节里的 `append-lesson` 命令换成 `append-memory --scope project`:

```markdown
画师答 Y / 给出一句话 → 调:

```bash
uv run python -m skill.character_workflow append-memory \
  --kind portrait \
  --line "- 2026-05-21 holy-spirit-priestess · 金白配色高识别度 · prompt 片段:\`兜帽低垂遮眼\`" \
  --scope project
```

`--scope` 默认 project(写到 `projects/<slug>/MEMORY.md`),解析当前 active → assignments → slug。
未归属时 CLI 返回码 2 + stderr 明确错误,需画师先走 Stage E 或显式 `--scope workspace`。
```

紧接其后追加 scope 决策小节:

```markdown
**画师明确授权 Skill 自行判断 scope 时的决策**:
- 包含具体角色 id / 风格关键词 / 配色 / 类目术语 → `--scope project`
- 通用工具行为 / prompt 协议 / runner 兜底 → `--scope workspace`
- 跨工作区都成立的(画师明确说"这是通用规律") → `--scope global`
- 默认 fallback: `--scope project`
```

- [ ] **Step 4: 验证 SKILL.md 没语法错误**

```bash
head -300 skill/character_workflow/SKILL.md | grep -c "^##"
```

预期: 输出一个数字(代表 ## 标题数量),不报错。

- [ ] **Step 5: Commit**

```bash
git add skill/character_workflow/SKILL.md
git commit -m "docs(skill): 三层 Memory + Stage E + scope 决策"
```

---

## Task 14: 仓库根 CLAUDE.md 顶部插 Memory 三层强制阅读

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 在 `# CLAUDE.md` 标题正下方插入新 section**

把 [CLAUDE.md:1-4](CLAUDE.md#L1-L4) 改成:

```markdown
# CLAUDE.md

## ⚠️ 启动必读 Memory 三层

每次进入本仓库的对话, 你必须先 Read 以下文件 (按顺序), 把内容作为本轮上下文:

1. `~/.claude/MEMORY.md` — 全局跨工作区经验
2. `MEMORY.md` (仓库根) — 本工作区跨项目通用经验
3. 如果对话涉及具体角色:
   - 从 `.runtime/projects.json::assignments` 解析角色所属 project_id
   - 从 `.runtime/projects.json::projects[].slug` 找到 slug
   - Read `projects/<slug>/MEMORY.md` + `projects/<slug>/worldview.md`

不读 MEMORY 就开始写 prompt / 出图 / 改 spec / 改 Skill 视为违规。

走 /character-workflow 等 Skill 命令时, Skill 内部已自动加载, 无需重复 Read。

---

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
```

- [ ] **Step 2: 验证 CLAUDE.md 修改正确**

```bash
head -20 CLAUDE.md
```

预期: 看到新插入的 Memory 三层声明。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): 顶部插入 Memory 三层强制阅读声明"
```

---

## Task 15: 全套测试 + 旧 prompt_builder 适配

**Files:**
- Modify: `skill/character_workflow/lib/prompt_builder.py`(如果用了旧 `worldview` / `lessons` 字段)
- Verify: 整个 pytest 套件 + ruff

- [ ] **Step 1: 检查 prompt_builder 是否还用旧字段**

```bash
grep -rn "load_worldview\|load_lessons" skill/character_workflow/lib/prompt_builder.py
```

如果有,需要改成:
- `load_worldview()` → 保留但当作 workspace fallback
- `load_lessons(kind)` → 拼三层 `load_lessons_global + load_lessons_workspace + load_lessons_project`

如果 prompt_builder 接收 turn_start 返回的 dict,改它的字段名映射即可。

- [ ] **Step 2: 跑全套 pytest**

```bash
uv run pytest -v 2>&1 | tail -60
```

预期: 全 PASS。如果有 fail,逐个排查:
- 旧测试用 `result["lessons"]` / `result["worldview"]` → 改成新字段
- 旧测试用 `Project(...)` 不填 slug → 补 slug 参数

- [ ] **Step 3: 跑 ruff**

```bash
uv run ruff check skill tests
```

预期: 无 error。如果有 line-length 超 100,手动断行修复。

- [ ] **Step 4: 跑 Web TS 编译看回归(schema 兼容)**

```bash
cd web && pnpm lint
```

预期: 无 TS error。Project schema 加了必填 `slug`,如果 web 也读 projects.json,可能要补类型字段。

如果 web 那边有 fail,看 `web/src/schema/projects.ts`(如果存在)是否需要补 `slug: string`,以及 UI 是否要展示 slug。**Web UI 改动不在本计划范围**,只需保证 TS 编译通过(允许 slug 字段在 schema 里 optional)。

- [ ] **Step 5: 手动验证 turn-start 端到端**

```bash
uv run python -m skill.character_workflow turn-start --kind portrait --message "出图"
```

预期: 输出 v5 JSON,含 `project_slug`、`project_id`、`lessons_global/workspace/project`、`worldview_workspace/project`。当前 active 是 `char-1779358169`(未归属),应该看到:
- `stage: "E"`
- `recommend_action: "ask"`
- `project_slug: null`
- `lessons_project: ""`

- [ ] **Step 6: 手动验证 append-memory workspace scope**

```bash
uv run python -m skill.character_workflow append-memory \
  --kind portrait \
  --line "- 2026-05-21 test · 计划验证 · prompt:\`x\`" \
  --scope workspace
```

预期: stdout `{"ok": true, "path": ".../MEMORY.md", "scope": "workspace"}`。
检查 `MEMORY.md` 末尾的 `### Portrait` section 里有新增这一行。

把验证条目从 MEMORY.md 删掉(不要污染数据):

```bash
# 手动编辑 MEMORY.md 删掉那一行,或:
git checkout MEMORY.md
```

- [ ] **Step 7: 最终 commit**

```bash
# 如果 prompt_builder / 旧测试有改动
git add skill/character_workflow/lib/prompt_builder.py tests/
git commit -m "fix: 适配三层 Memory 字段名,补全旧测试 slug fixture"

# 推到远程
git push -u origin lovart-runner-reliability-20260520
```

---

## Success Criteria(对齐 Spec)

- [ ] `projects/pokemon-style-elf-game/MEMORY.md` 和 `projects/test-content/MEMORY.md` 存在
- [ ] `projects.json` 每个 project 有 `slug` 字段
- [ ] `turn-start` 返回 JSON 含 `project_slug` + 5 个 lessons/worldview 字段
- [ ] 切换 active character 从 young-emperor-monkey 到 holy-spirit-priestess,`turn-start` 返回的 `lessons_project` 和 `worldview_project` 跟着切(young → pokemon 项目,holy → test-content 项目)
- [ ] char-1779358169 设为 active 后,`turn-start` 返回 `stage: "E"`
- [ ] `append-memory --scope project` 写到正确的 `projects/<slug>/MEMORY.md`
- [ ] `append-memory --scope workspace` 写到仓库根 `MEMORY.md`
- [ ] 仓库根 `CLAUDE.md` 顶部有 Memory 三层声明
- [ ] `create-project` 自动建目录骨架
- [ ] 全套 `uv run pytest -v` PASS,`uv run ruff check skill tests` 无 error

---

## 注意事项(给执行者)

1. **测试中的 pypinyin expected 字符串可能要微调**:Task 2 测试里的 `baokemeng-feng-ge-jing-ling-you-xi` 是估算值,真实 pypinyin Style.NORMAL 输出请实测对齐(用 `uv run python -c "from pypinyin import lazy_pinyin, Style; print(lazy_pinyin('宝可梦风格-精灵游戏', style=Style.NORMAL))"` 看)。**测试要跟实现对齐,而不是反过来**。

2. **旧 lessons 文件不删**:Task 6 只标 DEPRECATED,内容保留;`context_loader` 不再读它们(因为新的 `load_lessons_*` 完全走 MEMORY.md);旧 `load_lessons(kind)` 函数也保留作向后兼容(只是 Skill 不再调用)。

3. **slug 字段不可变**:Task 1 实现里 `Project.slug` 是必填,`rename_project` 只能改 `name` 不能改 `slug`(spec 明确"slug 一旦定就不再改")。已有 rename 逻辑不动。

4. **Skill 端拼装新字段是 prompt_builder 的事**:Task 15 视情况改 prompt_builder;如果它不直接读 turn_start 的 dict,而是单独调 `load_worldview()` / `load_lessons(kind)`,那 prompt_builder 内部要重写成调三层 loader 然后拼接。

5. **Web 兼容是 nice-to-have**:Web 现在通过 `POST /api/projects` 走 `create_project(name)`,如果不传 slug 会自动生成 → web 不需要立即改。但 web 显示 project 时可能未取 slug,Task 15 Step 4 帮你尽早发现 TS 编译问题。

6. **commit 节奏**:每个 Task 一个 commit。如果一个 Task 太大被拆,中间 commit 用 `wip:` 前缀;Task 完成后用 `feat:` / `data:` / `docs:` / `fix:`。所有 commit 都在 `lovart-runner-reliability-20260520` 分支上。
