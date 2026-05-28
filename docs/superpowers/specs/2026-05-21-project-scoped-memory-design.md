# Project-Scoped Memory & Worldview Architecture

Status: APPROVED
Generated: 2026-05-21
Branch: lovart-runner-reliability-20260520
Repo: game-ui-ai-workflow
Supersedes: `docs/superpowers/plans/2026-05-21-skill-memory-two-tier.md` (旧 plan 尚未执行,本设计直接覆盖)

---

## Problem Statement

旧 plan (`2026-05-21-skill-memory-two-tier.md`) 把"项目级 MEMORY"等同于"git 仓库级 MEMORY"。这在本仓库站不住:

`game-ui-ai-workflow` 一个 git 仓库通过 `.runtime/projects.json` 容纳多个游戏项目:

```
projects.json:
  projects: [
    { id: "p-957bf5ce16", name: "测试内容" },
    { id: "p-6b71d3a9e0", name: "宝可梦风格-精灵游戏" }
  ]
  assignments: {
    "holy-spirit-priestess":  "p-957bf5ce16",
    "young-emperor-monkey":   "p-6b71d3a9e0",
    "blazefist-monkey":       "p-6b71d3a9e0"
  }
```

旧 plan 下两个游戏共享一个 `MEMORY.md`,后果:

1. "精灵类首轮避免直呼现有 IP"(宝可梦风格特有) 会污染未来"硬核机甲游戏"项目的上下文
2. `worldview.md` 单文件,实际内容是宝可梦风格特定的,但又位于仓库根像是公共物
3. 跨项目通用经验(Lovart 重试、prompt 三模式协议)和项目风格特定经验混在一起,后期想清理无从下手

需要的是**项目级隔离 + 工作区共享 + 全局通用**三层,而不是旧 plan 的两层。

---

## Premises

1. **一个 git 仓库容纳多个游戏项目**,项目通过 `projects.json` 区分,这是既成事实不重构
2. **三层 Memory**: 全局(`~/.claude`) / 工作区(仓库根) / 项目(`projects/<slug>/`),三种粒度并存
3. **项目是一等公民**: worldview + Memory 都项目级,顺势把现在的不对称(worldview 仓库级 / Memory 仓库级)修掉
4. **`characters/` 保持平铺**,不重构。角色 → 项目的归属继续走 `projects.json::assignments`,不下放到 `spec.md` 避免双写源
5. **CLAUDE.md 不强制 = Claude 不主动读 MEMORY**,必须置顶写死

---

## Architecture

### 目录结构

```
~/.claude/MEMORY.md                          ← Tier 1: 全局 (跨工作区)
  └── ## Skills Memory > ### character-workflow

game-ui-ai-workflow/                         ← Tier 2: 工作区
├── CLAUDE.md                                ← 置顶 Memory 三层强制阅读
├── MEMORY.md                                ← 工作区共享 (跨项目通用)
│   └── ## character-workflow > ### Portrait/Promo/Turnaround
├── worldview.md                             ← 工作区兜底 worldview
├── characters/                              ← 不动, 平铺
│   ├── young-emperor-monkey/spec.md
│   ├── blazefist-monkey/spec.md
│   ├── holy-spirit-priestess/spec.md
│   └── char-1779358169/spec.md              ← 未归属, 会触发 Stage E
├── projects/                                ← 新建
│   ├── pokemon-style-elf-game/              ← slug 目录, 一等公民
│   │   ├── MEMORY.md                        ← Tier 3: 项目级经验
│   │   │   └── ## character-workflow > ### Portrait/Promo/Turnaround
│   │   └── worldview.md                     ← 项目级世界观
│   └── test-content/
│       ├── MEMORY.md
│       └── worldview.md
└── .runtime/projects.json                   ← schema 升级 (+slug 字段)
```

### 读取拼装顺序 (Skill turn-start 输出后由 SKILL.md 拼到专家 prompt 前缀)

```
worldview = project_worldview ?? workspace_worldview
lessons   = global ++ workspace ++ project    # 字面拼接, 不去重
```

`??` 表示项目级覆盖工作区级。未归属角色在 Stage E 拦下,理论上 worldview 永远走 project_worldview。`workspace_worldview` 留作历史性兜底,仓库根放一段"未归属角色临时占位"说明文,不留实际世界观内容。

### projects.json schema 升级

```json
{
  "projects": [
    {
      "id":         "p-6b71d3a9e0",
      "slug":       "pokemon-style-elf-game",
      "name":       "宝可梦风格-精灵游戏",
      "created_at": "2026-05-21T05:55:07+00:00"
    }
  ],
  "assignments": { "young-emperor-monkey": "p-6b71d3a9e0" }
}
```

新增 `slug` 字段,作为 `projects/<slug>/` 目录名。

### Slug 生成规则

- 输入: 项目 name (中文/英文混合)
- 处理: 中文 → 拼音(无音标) → 全部小写 → 非 ASCII 字符剔除 → 空格/下划线/标点统一转 `-` → 连续 `-` 折叠
- 长度上限 32 字符,截断
- **slug 撞已存在 slug** 加 `-2 / -3` 后缀去重(不是 name 撞,只看 slug 字段是否已被占用)
- 画师可在创建项目时手动覆盖(`--slug` 参数)
- **一旦定就不再改**: rename 项目名只改 `name` 字段,路径不变,git history 干净

依赖: `pypinyin` 库(纯 Python,加到 `pyproject.toml`)。如果不想引入外部依赖,fallback 是中文 name 直接拒绝并要求画师手动给 `--slug`,英文/ASCII name 仍自动推导。

例子:
- "宝可梦风格-精灵游戏" → `pokemon-style-elf-game`
- "测试内容" → `test-content`
- "硬核机甲 v2" → `hard-mecha-v2`

依赖: `pypinyin` 库(已是 pure Python,加到 `pyproject.toml`)。

---

## Skill 行为变更

### turn-start 解析链

```
active-character.json:active_id
  ↓
projects.json:assignments[active_id]  → project_id
  ↓ (不存在 → Stage E)
projects.json:projects[id].slug       → slug
  ↓
projects/<slug>/MEMORY.md + projects/<slug>/worldview.md
```

每步失败的兜底:
- `active-character.json` 无效 → Stage C (现有逻辑)
- `assignments[active_id]` 缺失 → **Stage E (新增)**
- `projects[id]` 缺失 或 `slug` 缺失 → 报错(数据损坏)
- `projects/<slug>/MEMORY.md` 不存在 → 视为 lessons_project = "",不报错
- `projects/<slug>/worldview.md` 不存在 → worldview = workspace fallback

### turn-start JSON 输出字段升级

旧 plan:
```json
{ "lessons": "...", "worldview": "..." }
```

新设计:
```json
{
  "stage": "A" | "B" | "C" | "D" | "E",
  "recommend_action": "ask" | "render_card" | "switch" | "noop",
  "active_id": "young-emperor-monkey",
  "project_id":   "p-6b71d3a9e0" | null,
  "project_slug": "pokemon-style-elf-game" | null,
  "project_name": "宝可梦风格-精灵游戏" | null,
  "lessons_global":      "...",
  "lessons_workspace":   "...",
  "lessons_project":     "...",
  "worldview_workspace": "...",
  "worldview_project":   "..."
}
```

SKILL.md 拼装时按 `worldview_project ?? worldview_workspace` 取一个,lessons 三层全拼。

### 新增 Stage E (未归属兜底)

进入条件: `active_id` 存在但 `assignments[active_id]` 缺失。

`recommend_action = "ask"`,Skill 端用 AskUserQuestion 列:

```
1. 归到 宝可梦风格-精灵游戏 (3 个角色)
2. 归到 测试内容 (1 个角色)
3. 新开项目
4. 跳过本轮 (不归属, 不出图)
```

画师选 1/2 → CLI `assign-character <char_id> --project <project_id>` → 写 `assignments` → 重新 turn-start
画师选 3 → 走 Stage A-like 子流程(项目名 + 一句话世界观),建 `projects/<slug>/{worldview.md, MEMORY.md}` + 写 assignments → 重新 turn-start
画师选 4 → 退出 turn

### 已有 Stage A/B/C/D 改造

| Stage | 改造前 | 改造后 |
|---|---|---|
| **A 首启 (空仓库)** | 问"项目名 + 一句话世界观 + 第一个角色",建仓库根 `worldview.md` + 第一个角色 spec | 同样三问,但落盘改为 `projects/<slug>/{worldview.md, MEMORY.md}` + `assignments[char] = project_id` + 仓库根 `worldview.md` 占位文 + 仓库根 `MEMORY.md` 骨架(空 sections) |
| **B 有项目无角色** | 问"角色名 + 定位" | 多项目场景: 先问"归到哪个已有项目"(默认推荐数量最多的),再问"角色名 + 定位" |
| **C active 失效** | 平铺列已有角色 | 按项目分组列:`### 宝可梦风格-精灵游戏` 下挂 3 个,`### 测试内容` 下挂 1 个,加"新建角色"和"跳过" |
| **D "新建另一个角色"** | 直接走 Stage B 流程 | 先问归属: ① 跟当前 active 同项目(默认推荐,保上下文) ② 别的已有项目 ③ 新开项目。然后才进角色名+定位 |
| **E (新)** | — | 见上 |

### CLI 变更

#### `turn-start` (改)
- 输出字段扩展(见上)
- 内部完成 char → project 解析

#### `append-memory --scope` (替换旧 `append-lesson`)
```bash
uv run python -m skill.character_workflow append-memory \
  --kind portrait \
  --line "- 2026-05-21 ..." \
  [--scope project|workspace|global]
```

- 默认 `--scope project`: 写 `projects/<slug>/MEMORY.md`。从 `active_id → assignments → slug` 解析;**未归属时返回码 2 + stderr 输出**`未归属角色不能写项目级 Memory,先走 Stage E 或显式传 --scope workspace`
- `--scope workspace`: 写仓库根 `MEMORY.md`
- `--scope global`: 写 `~/.claude/MEMORY.md > ## Skills Memory > ### character-workflow`

旧 `append-lesson` 保留作 alias,默认行为等同 `append-memory --scope project`。

#### `create-project` (新增)
```bash
uv run python -m skill.character_workflow create-project \
  --name "宝可梦风格-精灵游戏" \
  [--slug pokemon-style-elf-game]
```
推 slug、写 projects.json(追加一个 project)、建 `projects/<slug>/` 目录 + `worldview.md` 模板 + 空 `MEMORY.md` 骨架。stdout 返 project_id。

#### `assign-character` (新增,或复用 `lib/projects.py::assign_character` 已存在的逻辑)
```bash
uv run python -m skill.character_workflow assign-character \
  <char_id> --project <project_id>
```
仅改 `assignments` 字段。无 `--project` 等价于取消归属。

### Skill 自主沉淀 (画师授权 Skill 判断时) 的 scope 决策

画师明确说"你自行判断"时,Skill 决定经验性质:
- 包含具体角色 ID / 风格关键词 / 配色 / 类目术语 → `--scope project`
- 通用工具行为 / prompt 协议 / runner 兜底 → `--scope workspace`
- 跨工作区都成立的(画师明确说"这是通用规律") → `--scope global`

默认 fallback: `--scope project`。SKILL.md 收尾段落更新此约定。

---

## CLAUDE.md 强制声明 (Skill 外保险)

仓库根 `CLAUDE.md` 顶部插入(在现有 `# CLAUDE.md` 标题正下方,优先级高过所有现存 section):

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
```

放最顶的原因: CLAUDE.md 现有 100+ 行,Claude 边读边消耗 attention,越靠后越易被压缩。"What this project is / 核心架构原则 / 常用命令"都往后挪。

---

## 迁移计划

### 数据迁移

1. **新建 `projects/pokemon-style-elf-game/`**:
   - `worldview.md` ← 当前仓库根 `worldview.md` 全文内容(本来就是这个项目特定的)
   - `MEMORY.md` ← 骨架(`# 宝可梦风格-精灵游戏 MEMORY` + 4 个 sub-section)

2. **新建 `projects/test-content/`**:
   - `worldview.md` ← 空模板
   - `MEMORY.md` ← 骨架

3. **仓库根 `worldview.md` 改为占位**:
   ```markdown
   # 工作区兜底 worldview
   > 未归属角色的临时占位。正式 worldview 应在 `projects/<slug>/worldview.md`。
   ```

4. **仓库根 `MEMORY.md` 骨架**:
   ```markdown
   # game-ui-ai-workflow MEMORY (工作区共享)
   ## character-workflow
   ### Portrait
   ### Promo
   ### Turnaround
   ```

5. **现有 6 条 portrait + 4 条 promo lessons 拆分** (人工分类):

   工作区共享(跨项目通用,搬到仓库根 `MEMORY.md`):
   - "Lovart 返回 artifact 但 runner 因 final_status=timeout..."
   - "lovart_wrapper upload_file 用 curl 子进程..."
   - "画师改已出图必须先问修改模式..."
   - "A 模式编辑当前图时 prompt 只写差异指令..."
   - "runner 报 output_paths missing 但 artifact URL 已存在时..."
   - "GPT Image 2 没有原生 16:9,只需用 --size 告知尺寸..."

   宝可梦项目特定(搬到 `projects/pokemon-style-elf-game/MEMORY.md`):
   - "精灵类角色首轮出图避免直呼现有 IP..."
   - "出进化形态立绘时把前置进化 portrait/v1.png 上传为参考图..."
   - "prompt 身份锚点全下放参考图,文本只写动作/场景/光/构图/风格骨架..."
   - "画风描述去 IP 名(不写宝可梦/帕鲁等),用客观笔触语言..."

6. **projects.json 现有 2 个项目补 slug**:
   - `p-957bf5ce16` ← `slug: "test-content"`
   - `p-6b71d3a9e0` ← `slug: "pokemon-style-elf-game"`

7. **char-1779358169 (火栗狐)** 当前不在 `assignments`,下次启动 Skill 自动触发 Stage E,由画师手动归属。

8. **旧 `skill/character_workflow/references/lessons/{portrait,promo,turnaround}.md`**: 全部加 `> **DEPRECATED**` 头,内容保留作历史档案。下次大重构再删。

### 代码改造

| 文件 | 改动 |
|---|---|
| `lib/projects.py` | `Project` model 加 `slug` 字段;`create_project` 自动生成 slug 并建目录 |
| `lib/context_loader.py` | `_project_root` 已 git-aware;新增 `load_project_context(slug)` 读项目级 worldview+MEMORY;`load_lessons(kind)` 拆成三个分别读各层 |
| `lib/lessons.py` | `append_memory(kind, line, scope, project_slug)` 三 scope 分支 |
| `lib/turn_start.py` | 解析链改造;新增 Stage E 判断;输出 JSON 字段升级 |
| `lib/intent.py` | `compute_recommend_action` 加 Stage E 分支 |
| `__main__.py` | `append-memory --scope`、`create-project`、`assign-character` 子命令 |
| `SKILL.md` | Memory 拼装顺序、Stage E、新建角色归属流程、收尾 scope 决策 |
| `CLAUDE.md` (仓库根) | 顶部插入 Memory 三层强制阅读段 |
| 测试 | `test_projects.py` 加 slug;`test_memory.py` 三 scope 全覆盖;`test_turn_start.py` 加 Stage E + 已有 Stage 改造 |

### 一次性脚本(可选)

`scripts/migrate_memory_v2.py`: 自动跑迁移 1-6,幂等。手动跑一次即可,跑完进 git commit。

---

## Success Criteria

1. `projects/pokemon-style-elf-game/MEMORY.md` 和 `projects/test-content/MEMORY.md` 存在
2. `projects.json` 每个 project 有 `slug` 字段
3. `turn-start` 返回 JSON 含 `project_slug` + 5 个 lessons/worldview 字段
4. 切换 active character 从 young-emperor-monkey 到 holy-spirit-priestess,`turn-start` 返回的 `lessons_project` 和 `worldview_project` 跟着切
5. char-1779358169 设为 active 后,`turn-start` 返回 `stage: "E"`,SKILL.md 走 Stage E 流程
6. `append-memory --scope project` 写到正确的 `projects/<slug>/MEMORY.md`
7. `append-memory --scope workspace` 写到仓库根 `MEMORY.md`
8. 仓库根 `CLAUDE.md` 顶部有 Memory 三层声明
9. 新建项目通过 `create-project` 自动建目录骨架
10. Stage D 选"新建角色",先问归属再问角色名

---

## Open Questions (留给 writing-plans 再确认)

1. **`scripts/migrate_memory_v2.py` 是必须还是 nice-to-have**? 现在数据规模小(10 条 lessons + 2 个项目),手动迁移也 OK。推荐: 写成幂等脚本,跑一次落到 git。
2. **`assign-character` 是否需要新 CLI 子命令**,还是直接复用 Web API `POST /api/characters/<id>/assign`? Skill 端如果调 Web API 会有 server 依赖,CLI 命令更独立。推荐: 新 CLI 子命令,Skill 独立。

---

## Next Steps

1. ✅ 设计落地到本 spec 文档
2. ⏳ 用户 review 本 spec
3. ⏳ Invoke `writing-plans` skill 生成 implementation plan
4. ⏳ 选 subagent-driven 或 inline 执行 plan

---

## What I noticed about how you think

- 你提出"Web 上能新建文件夹区分项目"时,直觉是"那 file system 里也应该能区分" —— 心智模型是 **物理文件结构和 UI 概念应该对齐**,不接受"Web 是逻辑层,disk 是平铺层"这种割裂。这个直觉是对的,会让未来加新 Skill 时自然倾向把项目作为目录边界。
- 你问"如何保证一个项目的 Memory 是一个"时,顺手提了 CLAUDE.md 强制阅读 —— 说明你区分了**架构正确性**(三层 Memory 设计)和**执行可靠性**(Claude 不读就白搭),并且本能地把后者也当成架构的一部分。这是一个能避免大量"设计完了 Claude 不照做"问题的清醒直觉。
- 你没问"那旧 plan 怎么办" —— 默认就是用新设计取代旧的。决策力强,不被沉没成本拖累。
