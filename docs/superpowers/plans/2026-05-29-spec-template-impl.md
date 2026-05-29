# Spec Template 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立仓库级 spec 模板，清理现有 spec.md 中的日志/prompt/皮肤内容，废除 worldview.md，将项目级世界观并入项目 MEMORY.md，重命名 turn-start 返回字段。

**Architecture:** 纯文件内容变更 + 少量 Python 函数重命名。spec-template.md 作为仓库级规范文档，所有 Skills 引用；context_loader.py 新增 `load_project_memory` 替换 `load_project_worldview`；现有角色 spec.md 按新格式重写，日志段删除；worldview.md 内容迁入项目 MEMORY.md 后 trash。

**Tech Stack:** Python 3.11, pytest, markdown 文件编辑

---

## 文件映射

| 操作 | 路径 |
|---|---|
| 新建 | `docs/references/spec-template.md` |
| 修改 | `skills/character-workflow/SKILL.md` |
| 修改 | `skills/character-promo/SKILL.md` |
| 修改 | `skills/character-turnaround/SKILL.md` |
| 修改 | `CLAUDE.md`（仓库根，Memory 三层描述） |
| 修改 | `src/character_workflow/lib/context_loader.py` |
| 修改 | `src/character_workflow/lib/turn_start.py` |
| 新建/修改 | `tests/test_turn_start_spec_template.py` |
| 数据迁移 | `projects/*/worldview.md` → `projects/*/MEMORY.md` |
| 数据迁移 | `characters/*/spec.md`（所有有内容的角色） |

---

## Task 1：新建 `docs/references/spec-template.md`

**Files:**
- Create: `docs/references/spec-template.md`

- [ ] **Step 1: 写入模板文件**

```markdown
# Character Spec 模板

> 所有 `characters/<id>/spec.md` 必须遵循此格式。
> spec 是 agent 读的机器可读文档，不是人读的说明书。
> 禁止写占位词（?、TBD、待定）；没问清的字段整行省略，不写空值。

---

## 格式规范

### YAML frontmatter（必填元数据）

\`\`\`yaml
---
id: <character-id>
name: <显示名>
project: <project-slug>
created: YYYY-MM-DD
---
\`\`\`

### identity（角色身份）

\`\`\`markdown
## identity
- role: <职业 / 类型>
- archetype: <原型描述>
- temperament: <气质关键词>
\`\`\`

### visual_dna（视觉 DNA，跨资产共享）

\`\`\`markdown
## visual_dna
- style: <风格档（画风 + 线条 + 上色工艺）>
- palette: <主色（用途）/ 辅色（用途）/ 点缀色（用途，限定部位）>
- body: <体型特征>
- head: <头部特征>
- props: <核心道具>（无则省略此字段）
\`\`\`

### anchors（视觉锚点）

跨所有资产类型必须保留的视觉元素，编号排列，最强记忆点在第 1 条。

\`\`\`markdown
## anchors
1. <锚点——最强记忆点>
2. <锚点>
3. <锚点>
4. <锚点>
\`\`\`

### asset.* 节（按资产类型，按需存在）

第一次出某类资产时由 Skill 追加对应节；没出过该类型则无该节。
新增资产类型直接追加 `## asset.<type>` 节，不改模板结构。

**立绘：**
\`\`\`markdown
## asset.portrait
- size: <宽×高>
- angle: <镜头角度>
- background: <背景>
- pose: <姿势>
- expression: <表情>
\`\`\`

**美宣：**
\`\`\`markdown
## asset.promo
- size: <宽×高>
- format: <横版 KV / 竖版单卡 / ...>
\`\`\`

**三视图：**
\`\`\`markdown
## asset.turnaround
- size: 1536×1024
- views: <正/侧/背 + 可选追加项>
- extras: <武器拆解 / 表情包 / 无>
- background: <背景>
\`\`\`

### prohibit（生成禁止项）

\`\`\`markdown
## prohibit
- <禁止项>
- <禁止项>
\`\`\`

---

## 完整示例

\`\`\`yaml
---
id: huo-li-hu
name: 火栗狐
project: pokemon-style-elf-game
created: 2026-05-21
---

## identity
- role: 火属性精灵 / 初阶进化形态
- archetype: 幼年小狐狸（四足兽形，非人形化）
- temperament: 顽皮灵巧、少年感

## visual_dna
- style: 宝可梦官方图鉴卡通（清晰黑轮廓线 + 水彩平涂 + 柔和边缘阴影）
- palette: 栗红（主毛）/ 暖橙（尾/腹/额毛）/ 蓬松白（胸领）/ 翠绿（眼瞳，唯一冷色）
- body: 四足幼狐、大头身比、四肢短粗
- head: 大圆耳、圆脸颊、额头火焰形毛束

## anchors
1. 胸前蓬松外撑白色毛领——最强记忆点
2. 大尾巴橙红双色环纹、尾尖橙色、长度接近体长
3. 额头向上翘起的火焰形毛束
4. 翠绿眼瞳与红橙皮毛强对比

## asset.portrait
- size: 1024×1536
- angle: 3/4 侧身
- background: 纯白简约 + 接地阴影
- pose: 四足站立微前倾、左前爪轻抬、尾巴 S 形上翘
- expression: 机灵带笑意、嘴角微翘露小巧獠牙

## asset.promo
- size: 1536×1024
- format: 横版 KV

## prohibit
- 明火/火苗/烟雾
- 人类服装/饰品/武器
- 双足人型化
- 写实/厚涂质感
\`\`\`
```

- [ ] **Step 2: 验证文件存在**

```bash
ls docs/references/spec-template.md
```

Expected: 文件存在

- [ ] **Step 3: Commit**

```bash
git add docs/references/spec-template.md
git commit -m "docs: add repo-level spec-template.md for character spec format"
```

---

## Task 2：更新三个 SKILL.md 中 spec 引用

**Files:**
- Modify: `skills/character-workflow/SKILL.md`
- Modify: `skills/character-promo/SKILL.md`
- Modify: `skills/character-turnaround/SKILL.md`

- [ ] **Step 1: 更新 character-workflow/SKILL.md 的"写出图 prompt"节**

在 `## 写出图 prompt` 节的三行引用前加一行：

```
**spec 格式** → `docs/references/spec-template.md`
创建新 spec 时严格按模板 YAML 字段写；`asset.*` 节按需追加，问清才写，不写占位。
```

同时，更新 Turn 起始返回字段表，将 `worldview_project/workspace` 行改为：

```markdown
| `project_memory` | 项目 MEMORY.md 全文（含世界观、项目规则、角色名册、经验） |
```

- [ ] **Step 2: 更新 character-promo/SKILL.md 的"写 prompt"节**

在 `## 写 prompt` 节的底层规则引用前加一行：

```
**spec 格式** → `docs/references/spec-template.md`
从 `visual_dna` + `anchors` 提取角色视觉信息；从 `asset.promo` 读美宣固定参数。
```

- [ ] **Step 3: 更新 character-turnaround/SKILL.md 的"写 prompt"节**

在 `## 写 prompt` 节的底层规则引用前加一行：

```
**spec 格式** → `docs/references/spec-template.md`
从 `visual_dna` + `anchors` 提取角色视觉信息；从 `asset.turnaround` 读三视图固定参数。
```

- [ ] **Step 4: Commit**

```bash
git add skills/character-workflow/SKILL.md skills/character-promo/SKILL.md skills/character-turnaround/SKILL.md
git commit -m "docs: add spec-template reference to all three skill SKILL.md files"
```

---

## Task 3：更新 CLAUDE.md — 移除 worldview.md 引用

**Files:**
- Modify: `CLAUDE.md`（仓库根）

- [ ] **Step 1: 找到 Memory 三层描述段**

当前内容（在"如果对话涉及具体角色"下方）：

```markdown
   - Read `<data_root>/projects/<slug>/MEMORY.md` + `worldview.md`
```

改为：

```markdown
   - Read `<data_root>/projects/<slug>/MEMORY.md`
```

- [ ] **Step 2: 验证修改正确**

```bash
grep -n "worldview" CLAUDE.md
```

Expected: 无匹配（worldview 已完全移除）

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: remove worldview.md from CLAUDE.md memory reading instructions"
```

---

## Task 4：Python — 新增 `load_project_memory`，重命名 turn-start 字段

**Files:**
- Modify: `src/character_workflow/lib/context_loader.py`
- Modify: `src/character_workflow/lib/turn_start.py`
- Create: `tests/test_turn_start_spec_template.py`

- [ ] **Step 1: 先写失败测试**

创建 `tests/test_turn_start_spec_template.py`：

```python
"""Tests for spec-template related turn-start field changes.

Verifies:
- turn_start returns 'project_memory' (not 'worldview_project')
- 'worldview_workspace' is removed from return
- project_memory content comes from project MEMORY.md full text
"""
from __future__ import annotations

import json
import pytest


@pytest.fixture
def project(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    return tmp_path


def _setup_stage_d(project, memory_content: str = "") -> None:
    """Set up minimal Stage D environment with optional project MEMORY.md content."""
    (project / "characters" / "hero").mkdir(parents=True)
    (project / "characters" / "hero" / "spec.md").write_text(
        "---\nid: hero\nname: 英雄\n---\n\n## identity\n- role: 测试角色\n"
    )
    (project / ".runtime").mkdir()
    (project / ".runtime" / "active-character.json").write_text(
        json.dumps({"active_id": "hero", "updated_at": "2026-05-29T00:00:00+00:00"})
    )
    (project / ".runtime" / "projects.json").write_text(
        json.dumps({
            "projects": [{"id": "p1", "name": "测试项目", "slug": "test-proj"}],
            "assignments": {"hero": "p1"},
        })
    )
    (project / "projects" / "test-proj").mkdir(parents=True)
    if memory_content:
        (project / "projects" / "test-proj" / "MEMORY.md").write_text(memory_content)


def test_turn_start_returns_project_memory_field(project):
    """turn_start must return 'project_memory', not 'worldview_project'."""
    memory = "# 项目记忆\n\n## 世界观与设计语言\n三国麻将游戏\n"
    _setup_stage_d(project, memory)

    from character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", None)

    assert "project_memory" in result, "'project_memory' key must be present"
    assert "worldview_project" not in result, "'worldview_project' must be removed"


def test_project_memory_reads_full_memory_md(project):
    """project_memory should contain the full text of project MEMORY.md."""
    memory = "# 项目记忆\n\n## 世界观与设计语言\n精灵收集游戏\n\n## 项目规则\n品质皮肤系统规则\n"
    _setup_stage_d(project, memory)

    from character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", None)

    assert "精灵收集游戏" in result["project_memory"]
    assert "品质皮肤系统规则" in result["project_memory"]


def test_project_memory_empty_when_no_memory_file(project):
    """project_memory should be empty string when project MEMORY.md doesn't exist."""
    _setup_stage_d(project, memory_content="")  # no MEMORY.md written

    from character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", None)

    assert result["project_memory"] == ""


def test_worldview_workspace_removed(project):
    """worldview_workspace field must be removed from turn_start return."""
    _setup_stage_d(project)

    from character_workflow.lib.turn_start import turn_start
    result = turn_start("portrait", None)

    assert "worldview_workspace" not in result
```

- [ ] **Step 2: 运行测试确认失败**

```bash
uv run pytest tests/test_turn_start_spec_template.py -v
```

Expected: 3-4 个 FAILED（字段还没改）

- [ ] **Step 3: 在 context_loader.py 新增 `load_project_memory` 函数**

在 `load_project_worldview` 函数（第 188 行）**之后**追加：

```python
def load_project_memory(slug: str | None) -> str:
    """读 projects/<slug>/MEMORY.md 全文，作为 worldview_project 的替代。

    与 load_lessons_project 不同：这里返回全文，不抽取 kind 分节。
    Agent 从完整文本中自行读取世界观、项目规则、角色名册等。
    """
    if not slug:
        return ""
    path = _project_memory_path(slug)
    if not path.exists():
        return ""
    return _read_text(path)
```

- [ ] **Step 4: 在 turn_start.py 替换字段**

在 `turn_start.py` 的 import 块（第 217-226 行），修改 import：

```python
from character_workflow.lib.context_loader import (
    load_lessons_global,
    load_lessons_project,
    load_lessons_workspace,
    load_project_memory,          # 替换 load_project_worldview
)
```

（删除 `load_project_worldview` 和 `load_worldview` 两行的导入）

在 `turn_start` 函数返回 dict（第 286-315 行），替换两行：

旧：
```python
"worldview_workspace": load_worldview(),
"worldview_project": load_project_worldview(project_slug),
```

新：
```python
"project_memory": load_project_memory(project_slug),
```

- [ ] **Step 5: 运行测试确认通过**

```bash
uv run pytest tests/test_turn_start_spec_template.py -v
```

Expected: 全部 PASS

- [ ] **Step 6: 运行全套测试确认无回归**

```bash
uv run pytest tests/ -v --tb=short -q 2>&1 | tail -20
```

Expected: 存量测试全部通过（worldview_project / worldview_workspace 引用的旧测试若存在需一并更新）

- [ ] **Step 7: 如有旧测试引用 worldview_project，修复它们**

```bash
grep -rn "worldview_project\|worldview_workspace\|load_project_worldview\|load_worldview" tests/
```

对每个匹配：将 `worldview_project` 改为 `project_memory`，将 `worldview_workspace` 引用删除或改为检查该 key 不存在。

- [ ] **Step 8: Commit**

```bash
git add src/character_workflow/lib/context_loader.py \
        src/character_workflow/lib/turn_start.py \
        tests/test_turn_start_spec_template.py
git commit -m "feat: replace worldview_project with project_memory in turn_start return"
```

---

## Task 5：数据迁移 — worldview.md → 项目 MEMORY.md

**Files:**
- Modify: `projects/pokemon-style-elf-game/MEMORY.md`（追加世界观内容）
- Delete: `projects/pokemon-style-elf-game/worldview.md`
- Delete: `projects/test-content/worldview.md`（内容未知，先读再判断）
- Delete: `projects/1/worldview.md`
- Delete: `projects/2/worldview.md`

- [ ] **Step 1: 读取 pokemon-style-elf-game 的 worldview.md**

```bash
cat projects/pokemon-style-elf-game/worldview.md
cat projects/pokemon-style-elf-game/MEMORY.md 2>/dev/null || echo "(no MEMORY.md)"
```

- [ ] **Step 2: 将 worldview 内容整合进 MEMORY.md**

如果 `MEMORY.md` 不存在，新建；存在则追加。最终 `projects/pokemon-style-elf-game/MEMORY.md` 结构：

```markdown
# 项目记忆 — 精灵收集游戏

## 世界观与设计语言

一款精灵收集/养成/战斗游戏，整体参考宝可梦式明亮图鉴风，精灵角色设计参考幻兽帕鲁与宝可梦的可爱高识别度路线。

- 角色轮廓：精灵设计优先清晰剪影、夸张但易读的属性标志
- 画风：卡通插画，清晰黑色轮廓线，水彩平涂或干净赛璐璐阴影，明亮饱和但不过曝
- 首轮示意：优先官方图鉴白底全身立绘，便于快速判断形态、属性与进化潜力

## 项目规则

（暂无）

## 角色名册

- huo-li-hu（火栗狐）：火属性幼年小狐狸精灵，初阶进化形态
- young-emperor-monkey（幼皇猴）：土属性幼年猴子精灵，初阶进化形态
- blazefist-monkey（烈拳猴）：土属性岩猿武者，中级进化形态，幼皇猴进化
- holy-spirit-priestess（圣灵祭祀）：西幻见习女祭祀，治愈系冒险者

## 工作经验

### Portrait

### Promo

### Turnaround
```

（注：如原 MEMORY.md 已有工作经验，保留并归入对应节）

- [ ] **Step 3: trash 原 worldview.md**

```bash
trash projects/pokemon-style-elf-game/worldview.md
```

- [ ] **Step 4: 处理 test-content、1、2 目录的 worldview.md**

```bash
cat projects/test-content/worldview.md
cat projects/1/worldview.md
cat projects/2/worldview.md
```

若内容为空或无实质内容，直接 trash：

```bash
trash projects/test-content/worldview.md
trash projects/1/worldview.md
trash projects/2/worldview.md
```

若有内容，先整合进对应 MEMORY.md 再 trash。

- [ ] **Step 5: 更新 ma-jiang-you-xi/MEMORY.md — 添加分节结构 + 曹操皮肤设计**

当前 `projects/ma-jiang-you-xi/MEMORY.md` 只有经验内容，需重新组织并添加项目规则节：

```markdown
# 项目记忆 — 麻将游戏

## 世界观与设计语言

三国主题麻将游戏，角色为三国历史人物的拟人兽形（狼/虎/凤等）设计，卡通三国武将立绘风格（粗轮廓线 + 色块清晰，适合游戏角色头像和半身展示）。

## 项目规则

### 品质皮肤系统

适用于所有麻将游戏角色的皮肤品质规则：

- **绿色品质**：只做服装整体换色，或改变局部服装样式；不改变武器、不增加待机特效、不改动作
- **蓝色品质**：改变整体服装样式和饰品样式
- **紫色品质**：在蓝色品质基础上修改武器样式，并增强待机特效
- **橙色品质**：在蓝色品质基础上修改技能表现动画动作和 MVP 动画动作

### 曹操皮肤设计档案

#### 绿色品质：青袍谋主
- 定位：早期谋主皮肤，克制的青袍谋士气质，比默认皮肤轻一档
- 主色变化：深紫外袍 → 沉青/墨青/暗绿青；金边 → 旧金/暗金
- 新增记忆点：袍角或袖口小青羽纹暗纹（克制点缀，不铺满）
- 保留锚点：灰蓝狼头、黄色竖瞳、黑色眉斑、红色系带、黑色毛领、胸前红金核心饰件、右侧短剑/令牌
- 已生成：`portrait/v3.png`（修正版，以 portrait/v1.png 作参考图，GPT Image 2）

#### 蓝色品质：玄甲魏主
- 定位：进阶统帅皮肤，从"紫袍权臣"升级为"披甲魏主"，强化军权感
- 服装变化：半甲半袍结构，分片式黑玄胸甲和肩甲，外层暗紫披袍与袍摆层次
- 饰品变化：魏主冠形、魏纹令牌式胸饰、小型金属扣饰，低调魏纹（不发光）
- 保留锚点：灰蓝狼头、黄色竖瞳、黑色眉斑、红色系带、黑色毛领、前伸掌控姿态、短剑/令牌轮廓
- 已生成：`portrait/v4.png`（以 portrait/v1.png 作参考图，GPT Image 2）

## 角色名册

- cao-cao（曹操）：狼形拟人武将，魏主，紫袍权臣造型
- dong-zhuo（董卓）：待开档
- lv-bu（吕布）：待开档
- sun-ce（孙策）：待开档
- sun-shang-xiang（孙尚香）：待开档

## 工作经验

### Portrait

### Promo
- 2026-05-29 cao-cao · 美宣 prompt 有主体参考图时，仍须在 prompt 首段明确声明目标风格与立绘一致（卡通三国武将、粗轮廓线、色块清晰），否则模型会把 GPT Image 2 默认走向的写实/欧美原画风作为参考基底；构图和氛围描述无误也救不了风格跑偏 · prompt 片段：`游戏卡通风格三国武将立绘质感，粗轮廓线，色块清晰，与参考图角色立绘保持相同画风`

### Turnaround
```

- [ ] **Step 6: Commit**

```bash
git add projects/
git commit -m "chore: migrate worldview.md content to project MEMORY.md, trash worldview files"
```

---

## Task 6：数据迁移 — 角色 spec.md 转换为新 YAML 格式

将现有 spec.md 从旧格式（prose bullets + 日志段）转换为新格式（YAML frontmatter + 结构化字段），并删除所有日志段和 prompt 文本段。

**Files:**
- Modify: `characters/huo-li-hu/spec.md`
- Modify: `characters/young-emperor-monkey/spec.md`
- Modify: `characters/blazefist-monkey/spec.md`
- Modify: `characters/holy-spirit-priestess/spec.md`
- Modify: `characters/cao-cao/spec.md`
- Modify: `characters/dong-zhuo/spec.md`
- Modify: `characters/lv-bu/spec.md`
- Modify: `characters/sun-ce/spec.md`
- Modify: `characters/sun-shang-xiang/spec.md`

### 6a: huo-li-hu/spec.md

- [ ] **Step 1: 用新内容完整替换 huo-li-hu/spec.md**

```yaml
---
id: huo-li-hu
name: 火栗狐
project: pokemon-style-elf-game
created: 2026-05-21
---

## identity
- role: 火属性精灵 / 初阶进化形态
- archetype: 幼年小狐狸（四足兽形，非人形化）
- temperament: 顽皮灵巧、少年感

## visual_dna
- style: 宝可梦官方图鉴卡通（清晰黑轮廓线 + 水彩平涂 + 柔和边缘阴影）
- palette: 栗红（主毛）/ 暖橙（尾/腹/额毛）/ 蓬松白（胸领）/ 翠绿（眼瞳，唯一冷色）
- body: 四足幼狐、大头身比、四肢短粗
- head: 大圆耳、圆脸颊、额头火焰形毛束

## anchors
1. 胸前蓬松外撑白色毛领——最强记忆点
2. 大尾巴橙红双色环纹、尾尖橙色、长度接近体长
3. 额头向上翘起的火焰形毛束
4. 翠绿眼瞳与红橙皮毛强对比

## asset.portrait
- size: 1024×1536
- angle: 3/4 侧身
- background: 纯白简约 + 接地阴影
- pose: 四足站立微前倾、左前爪轻抬、尾巴 S 形上翘
- expression: 机灵带笑意、嘴角微翘露小巧獠牙

## asset.promo
- size: 1536×1024
- format: 横版 KV

## prohibit
- 明火/火苗/烟雾
- 人类服装/饰品/武器
- 双足人型化
- 写实/厚涂质感
```

### 6b: young-emperor-monkey/spec.md

- [ ] **Step 1: 用新内容完整替换 young-emperor-monkey/spec.md**

```yaml
---
id: young-emperor-monkey
name: 幼皇猴
project: pokemon-style-elf-game
created: 2026-05-21
evolves_to: blazefist-monkey
---

## identity
- role: 土属性精灵 / 初级进化形态
- archetype: 幼年猴子
- temperament: 年幼但不服输，有小王者气场，动作莽撞、爆发力强

## visual_dna
- style: 宝可梦官方图鉴卡通（清晰黑轮廓线 + 明亮平涂 + 柔和阴影）
- palette: 赤土橙（皮毛主）/ 浅砂色（胸腹/脸颊）/ 岩灰（岩石部件）/ 墨棕（耳缘/尾末/肢端）
- body: 小型幼猴、大头身比可爱、四肢短前臂粗壮
- head: 大圆耳、圆脸颊、头顶稚嫩小岩冠（像稚嫩王冠，轮廓圆钝）
- props: 双拳超大石拳套（圆钝岩块组成，边缘有裂纹和土尘感）

## anchors
1. 头顶稚嫩小岩冠——王者身份标志
2. 双拳超大石拳套——属性与战斗感核心
3. 眉眼坚定、嘴角自信小龇牙——年幼王者气场
4. 赤土橙皮毛 + 岩灰石拳套配色对比

## asset.portrait
- size: 1024×1536
- angle: 3/4 正面
- background: 纯白简约 + 接地阴影
- pose: 双脚分开踩稳、身体微前倾、双拳一前一后抬起呈冲刺挥拳姿
- expression: 眉眼坚定、嘴角自信龇牙、不凶恶但有冲劲

## asset.promo
- size: 1536×1024
- format: 横版 KV

## asset.turnaround
- size: 1536×1024
- views: 正/侧/背（标准三视图）
- extras: 无
- background: 浅灰网格

## prohibit
- 写实猴子/恐怖怪物
- 人类服装/金属盔甲（岩石只能是岩石质感）
- 复杂背景/厚涂质感
- 额外尾巴或多余手指
```

### 6c: blazefist-monkey/spec.md

- [ ] **Step 1: 用新内容完整替换 blazefist-monkey/spec.md**

```yaml
---
id: blazefist-monkey
name: 烈拳猴
project: pokemon-style-elf-game
created: 2026-05-21
evolves_from: young-emperor-monkey
---

## identity
- role: 土属性精灵 / 中级进化形态
- archetype: 岩猿武者（由四足进化为双足直立）
- temperament: 昂扬烁战、继承幼皇猴王者气质并放大、眼神锐利有压制感

## visual_dna
- style: 宝可梦官方图鉴卡通（清晰黑轮廓线 + 明亮平涂 + 柔和阴影）
- palette: 赤土橙（皮毛主）/ 浅砂色（胸腹/脸颊）/ 岩灰（岩石部件，面积比前一形态更大）/ 墨棕（耳缘/尾末/肢端）
- body: 中型双足直立、体态接近人形武者、保留圆耳和长尾
- head: 头顶岩冠升级为显眼岩石王冠轮廓、昂头姿态
- props: 双前臂厚重岩甲护臂（从肘部到拳面，边缘有裂纹和土尘感，不出现金属光泽）

## anchors
1. 双前臂厚重岩甲护臂——最强记忆点
2. 头顶显眼岩石王冠轮廓——进化标志
3. 嘴巴张开咆哮/呼啸、露出锋利犬齿——强攻气场
4. 赤土橙皮毛 + 岩灰岩甲（面积更大的岩石覆盖）

## asset.portrait
- size: 1024×1536
- angle: 3/4 正面
- background: 纯白简约 + 接地阴影
- pose: 双足扎稳站立、身体微前倾、双臂岩甲前抬、一拳蓄势一拳前击、尾巴向上猛甩
- expression: 昂头咆哮、嘴张开露锋利犬齿、眼神锐利前视

## asset.promo
- size: 1536×1024
- format: 横版 KV

## prohibit
- 写实猴子/恐怖怪物
- 金属盔甲（岩石只能是岩石质感，不出现金属光泽）
- 人类服装/复杂背景/厚涂质感
- 直接参考现有宝可梦 IP 角色
```

### 6d: holy-spirit-priestess/spec.md

- [ ] **Step 1: 用新内容完整替换 holy-spirit-priestess/spec.md**

```yaml
---
id: holy-spirit-priestess
name: 圣灵祭祀（女）
project: pokemon-style-elf-game
created: 2026-05-18
---

## identity
- role: 见习圣职者 / 治愈系冒险者
- archetype: 西幻见习女祭祀（约 17 岁，娇小匀称）
- temperament: 温柔治愈、亲切活泼、宝可梦主角团成员感

## visual_dna
- style: 卡通插画（类宝可梦杉森建图鉴风，清晰黑轮廓线 + 水彩平涂 + 柔和边缘阴影）
- palette: 象牙白（主袍/斗篷）/ 浅金+金纹（边饰/腰带/圣徽扣/法杖）/ 银白偏浅金（发色）
- body: 娇小匀称少女体型
- head: 柔软中长微卷银白偏浅金发、刘海温柔垂落；宽兜帽自然垂至肩背不遮脸；五官清秀温和，双眸圆润有神
- props: 金色法杖（约 120cm，浅金圣纹杖身，顶端金色星形+小金羽+淡金光珠）

## anchors
1. 白色短斗篷+自然垂落宽兜帽——最强整体轮廓
2. 斗篷下摆 1/4 高度金色藤蔓+圣纹刺绣边带（与腰带金线呼应）
3. 高举法杖至头顶上方施法——标志性姿势
4. 银白偏浅金卷发+圆润温柔双眸

## asset.portrait
- size: 1024×1536
- angle: 3/4 侧身
- background: 纯白简约 + 接地阴影
- pose: 侧身 3/4、右手高举法杖至头顶上方、左手掌心向上聚拢光粒、斗篷下摆发丝向后扬起
- expression: 眼神坚定温柔、嘴角抿出柔和弧度、施法咏唱中的专注神情

## asset.promo
- size: 2048×1152
- format: 16:9 横版 KV

## asset.turnaround
- size: 1536×1024
- views: 正/侧/背 + 2 张头部表情包
- extras: 小型金边圣典拆解（闭合正面/打开内页/侧面书脊厚度）
- background: 浅灰网格

## prohibit
- 写实风格/厚涂质感
- 遮脸的兜帽/不垂落的斗篷
- 兜帽打开遮住脸部
```

### 6e: cao-cao/spec.md

- [ ] **Step 1: 用新内容完整替换 cao-cao/spec.md**（皮肤设计段已迁移到 ma-jiang-you-xi MEMORY.md）

```yaml
---
id: cao-cao
name: 曹操
project: ma-jiang-you-xi
created: 2026-05-28
---

## identity
- role: 三国武将 / 狼形拟人角色
- archetype: 魏主曹操（枭雄，偏谋略型）
- temperament: 狡黠强势、阴沉危险、掌控感强

## visual_dna
- style: 卡通三国武将立绘（粗轮廓线 + 色块清晰，适合游戏角色头像和半身展示）
- palette: 深紫（外袍主）/ 黑色（大面积毛领）/ 金色（冠饰/边饰）/ 红色（系带/胸饰核心）/ 白色（内摆）
- body: 狼形拟人武将
- head: 灰蓝狼头、黑色眉斑压低、黄色竖瞳、露齿凶狠表情；头顶金色冠饰、红色系带沿脸侧垂下
- props: 右侧短剑/令牌式道具（武将身份辅助锚点）

## anchors
1. 灰蓝狼头+黄色竖瞳+黑色眉斑——物种身份不可改变
2. 深紫外袍+大面积黑色毛领——权臣气场核心
3. 金色冠饰+红色系带——贵气与危险并存
4. 手部前伸的掌控姿态——枭雄特质标志

## asset.portrait
- size: 1024×1024
- angle: 半身正面
- background: 纯白简约
- pose: 手部前伸掌控姿态

## asset.promo
- size: 1536×1024
- format: 横版 KV

## prohibit
- 写实风格
- 改变狼形特征（灰蓝狼头、黄色竖瞳不可改变）
- 改变掌控姿态
```

### 6f: 存根角色（dong-zhuo / lv-bu / sun-ce / sun-shang-xiang）

- [ ] **Step 1: 替换为统一的最小有效 spec 格式**

**dong-zhuo/spec.md：**
```yaml
---
id: dong-zhuo
name: 董卓
project: ma-jiang-you-xi
created: 2026-05-21
---
```

**lv-bu/spec.md：**
```yaml
---
id: lv-bu
name: 吕布
project: ma-jiang-you-xi
created: 2026-05-21
---
```

**sun-ce/spec.md：**
```yaml
---
id: sun-ce
name: 孙策
project: ma-jiang-you-xi
created: 2026-05-21
---
```

**sun-shang-xiang/spec.md：**
```yaml
---
id: sun-shang-xiang
name: 孙尚香
project: ma-jiang-you-xi
created: 2026-05-21
---
```

- [ ] **Step 2: 验证所有 spec.md 无旧格式内容**

```bash
grep -rn "出图记录\|美宣记录\|三视图记录\|当前 spec(出图用)\|已确定要点\|角色定位" characters/
```

Expected: 无匹配（旧格式节名已全部消除）

- [ ] **Step 3: 验证所有 spec.md 有正确 frontmatter**

```bash
for f in characters/*/spec.md; do
  echo "=== $f ==="
  head -5 "$f"
done
```

Expected: 每个文件前 3 行都是 `---\nid: ...\nname: ...`

- [ ] **Step 4: Commit**

```bash
git add characters/
git commit -m "chore: migrate all character spec.md to YAML frontmatter format, remove logs and prompts"
```

---

## 自检清单

完成所有 Task 后验证：

```bash
# 1. 无旧字段引用
grep -rn "worldview_project\|worldview_workspace\|load_project_worldview" \
  src/ skills/ tests/ CLAUDE.md

# 2. 无 worldview.md 残留
find projects/ -name "worldview.md"

# 3. spec 格式检查
grep -rn "出图记录\|美宣记录\|三视图记录\|当前 spec\|已确定要点" characters/

# 4. 全套测试通过
uv run pytest tests/ -q 2>&1 | tail -5
```

Expected：
- Step 1: 无匹配
- Step 2: 无输出
- Step 3: 无匹配
- Step 4: all passed
