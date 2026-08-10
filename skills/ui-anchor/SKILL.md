---
name: ui-anchor
version: 1.0.0
description: |
  游戏 UI 设计的策划锚阶段：对话式生成项目三锚文档（gdd / prd / interaction），
  交叉检查一致后停在批准门。三文档 approved 是 UI 页面生图的正式门禁。
  用户要写策划文档 / PRD / 交互逻辑、为 UI 生成做准备，或调用
  /game-atelier:ui-anchor 时使用；已有外部 GDD 时只补缺不重写。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
triggers:
  - /game-atelier:ui-anchor
  - 写策划文档
  - 写 PRD
  - 写交互逻辑
  - UI 策划锚
---

## 定位

三锚文档是全部 UI 视觉决策的锚：页面清单从玩家旅程推导，不凭空堆页面。本 skill 只产文档，不出图、不启 viewer-server。产出全部落 `<data_root>/projects/<slug>/design/`：

| 文件 | 内容 | 模板 |
|---|---|---|
| `design/gdd.md` | 定位 / 核心循环 / 系统清单 / 世界观最小集 | `docs/references/gdd-template.md` |
| `design/prd.md` | P0/P1 需求 / 信息架构 / 页面范围 / 边界异常 | `docs/references/prd-template.md` |
| `design/interaction.md` | 全局导航 / 分页面主流程 / 状态机 / 跨页链路 | `docs/references/interaction-template.md` |

**正式门禁**：三文档 `status: approved` 前，ui-page 不生图；确需跳过必须显式记录（见「豁免阀」）。

## 运行模式（CLI 前缀判断）

与 character 主 Skill 同一套三选一规则（详见其「启动自检」节）：

- `${CLAUDE_PLUGIN_ROOT}` 非空 → Installed Plugin mode：CLI 一律 `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --run -m character_workflow <subcmd>`（Windows 用 `python`）。
- 为空且运行于 Codex → 解析 `$BOOT` 后 `python "$BOOT" --run -m character_workflow <subcmd>`，绝不 `uv run`。
- 为空且在仓库内开发 → `uv run python -m character_workflow <subcmd>`。

本 skill 不出图，无需启动 viewer-server、无需 API Key。

## 工作流

### 1. 定项目

```bash
uv run python -m character_workflow turn-start
```

只取 `has_projects` / `projects` / `project_id·slug·name`（active 角色归属项目）：

- 有归属项目 → AskUserQuestion 确认「就是给 <项目名> 做 UI 锚文档吗」，画师可换选其他项目。
- 多项目无归属 → 列项目让画师选。
- `has_projects == false` → 先走 character skill 的建项目流程（`create-project`），或让画师一句话说清项目定位后代建。

### 2. 摸现状（增量优先，不重写）

Read `projects/<slug>/design/` 三文件与 `worldview.md` / `style.md`：

- 三文档全 `approved` → 告知锚已就绪，问是否要修订（修订 approved 文档须画师确认，改完 status 回 `draft` 重走批准门）。
- **gdd.md 已存在**（如 game-concept skill 产出、画师手写）→ 不重写；对照模板列出缺节，经画师确认后只补缺节，已有内容原样保留。
- 部分存在 → 从缺的文档继续，已有的只做交叉检查。

### 3. 对话式生成（顺序 gdd → prd → interaction）

- **所有提问用 AskUserQuestion**（单次 ≤4 问、每问 ≤4 选项；更多拆两级：先大方向后细节）。工具不可用时输出文本确认卡并就地停下（格式同 character skill 降级协议）。
- 每份文档 1-2 轮问答问清，按模板落盘，`status: draft` 起步。**零占位**：不写 `?` / TBD / 待定；没问清的字段整行省略。
- worldview.md 已有的定位 / 调性 / 用语直接引用不重复问。
- prd 的页面范围从 gdd 核心循环的「主要界面」列推导，摆给画师增删确认，不凭空造页面。
- interaction 只为 prd 页面范围里 must-have 页面写分页节；状态名一经批准即是契约（后续 screen brief / prompt 必须沿用）。

### 4. 交叉检查（硬门，不过不进批准门）

逐条核对并把结果亮给画师：

1. gdd 核心循环每个「主要界面」都出现在 prd 页面范围。
2. prd 每条 P0 需求的「对应页面」都在页面范围表里。
3. prd 页面范围的每个 must-have `screen-id` 在 interaction 有对应 `## screen.<id>` 节，且 id 拼写一致。

不一致 → 列出差异，回到对应文档修，改完重查。

### 5. 批准门（停）

三文档齐 + 交叉检查过 → 输出摘要（每文档 3 行内）+ 文件路径，请画师审阅。**就地停下等画师表态**：

- 画师明确说「批准 / approved / 定了」→ 把三文档 frontmatter 改 `status: approved` + 刷新 `updated`，报完成。
- 画师提修改 → 改完重走交叉检查再进批准门。
- 沉默 / 模糊 → 不推进，不把沉默当批准。

### 豁免阀（预期不常用）

画师明确说「跳过策划门禁」→ 写 `projects/<slug>/design/waiver.md`（日期 + 画师原话 + 跳过范围），告知：后续 ui-page 凭 waiver 放行，但风格漂移 / 页面范围失控的风险自担。不主动提议跳过。

## Turn 收尾报告（七件套）

每轮有实质产物（文档落盘 / status 变更）时，以固定七件套收尾：

```text
当前步骤：
完成状态：
本步产物：
需要你检查：
可选操作：
进入下一步的条件：
下一步可直接说的话：
```

## Guardrails

- 三文档 approved 前不得宣称锚已就绪；不得用空模板或只改标题冒充已批准文档。
- 修改 approved 文档必须先经画师确认。
- 交叉检查三条全过才能进批准门；批准门必须停，沉默 / 模糊不当批准。
- 已有 gdd 只补缺不重写；补哪些节先经画师确认。
- 跳过门禁必须落 waiver.md，不接受口头豁免。
- 零占位；所有提问走 AskUserQuestion，降级用文本确认卡。

## 跳过条件

git / 代码 / 纯问答；画师在做角色资产（走 character / promo / turnaround）；画师只想直接出一张 UI 图且明确说跳过门禁（走豁免阀后转 ui 总控）。
