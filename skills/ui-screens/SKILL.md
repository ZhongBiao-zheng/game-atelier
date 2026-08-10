---
name: ui-screens
version: 1.0.0
description: |
  游戏 UI 页面延展：读锚三文档，按玩家旅程 8 步审计推带优先级的页面清单，
  画师批准范围后写 screens/screen-map.md（清单表 + 每页契约）。
  本 skill 只产 screen-map，不生图——逐页生成交给 ui-page 从 map 取契约基础。
  前置门：三锚文档 approved（或 waiver）+ style.md ui.* approved（风格已定稿）。
  用户要页面清单 / 屏幕地图 / 批量延展页面 / 审计缺页，或调用 /game-atelier:ui-screens 时使用。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
triggers:
  - /game-atelier:ui-screens
  - 页面清单
  - 屏幕地图
  - 延展页面
  - 审计缺页
---

## 定位

从玩法和玩家旅程**推导**页面清单，不默认堆满所有常见系统——宁缺毋滥。产物是
`projects/<slug>/screens/screen-map.md`（页面清单表 + 每页一节契约），它是项目页面全景的
事实源；单页结构细化仍归各页 brief（`ui-page` 从 map 的对应节取基础）。本 skill 不生图。

## 运行模式（CLI 前缀判断）

与 character 主 Skill 同一套三选一规则（详见其「启动自检」节）：`${CLAUDE_PLUGIN_ROOT}` 非空 →
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --run -m character_workflow <subcmd>`
（Windows 用 `python`）；Codex → `python "$BOOT" --run ...`，绝不 `uv run`；
仓库内开发 → `uv run python -m character_workflow <subcmd>`。

## 工作流

### 1. 定项目

`turn-start` 取 `has_projects` / `projects` / active 归属项目（同 ui-anchor 协议）；
多项目用 AskUserQuestion 选定，拿到 `project_slug`。

### 2. 门禁检查（硬门，不过不延展）

Read `projects/<slug>/design/{gdd,prd,interaction}.md` 与 `projects/<slug>/style.md`：

- 三锚文档任一缺失或 `status` 非 `approved`，且无 `design/waiver.md` → **停**，指回 `ui-anchor`。
- `style.md` 缺失、无 `ui.*` 节、或 `status` 非 `approved` → **停**，指回 `ui-page` 风格切换模式
  先定稿风格——风格未定就批量延展，每一页都会漂。
- 凭 waiver 放行时，向画师明示「本次凭 waiver 跳过策划门禁」。

### 3. 玩家旅程审计

Read `${CLAUDE_PLUGIN_ROOT}/docs/references/screen-taxonomy.md`，按其「玩家旅程 8 步审计」
逐步过一遍：

1. 从 gdd 核心循环 + interaction 全局交互原则写出「首次进入 → 核心循环 → 日常回流」路径。
2. 把 prd「页面范围」表已有页面放入旅程，找出真正的断点（哪一步缺页会断）。
3. 只为断点补候选页：每个候选过 taxonomy 的「五问」，能合并进现有页且不藏高频动作的就合并。
4. 每页标注分类 + 优先级（`must-have` / `genre-specific` / `optional`）+ 生成依赖。

### 4. 画师批范围（硬门）

AskUserQuestion 把清单交画师批：表格列出 id / 名称 / 优先级 / 为什么需要，
新增页（prd 页面范围表之外的）单独标出。画师可删页、降级、合并——范围由画师定，skill 不代批。

- 批准的新增页**先回写 prd「页面范围」表**（改 approved 文档，已在本次批准范围内）再入 map。
- prd 里被画师砍掉的页不留在 map——两处必须一致，以 prd 为准。

### 5. 写 screen-map

按 `${CLAUDE_PLUGIN_ROOT}/docs/references/screen-map-template.md` Write
`projects/<slug>/screens/screen-map.md`：

- 页面清单表：id / 名称 / 分类 / 优先级 / 状态（初始 `planned`，已出图的页如实标）/ 依赖。
- 每页一节 `## screen.<id>` 契约：purpose / 玩家旅程 / 布局分区 / 组件 / 状态——
  从 prd 覆盖需求 + interaction 对应 `## screen.<id>` 节推导，状态名沿用 interaction 契约。
- 画师确认后 `status: approved`；修改 approved 的 map 必须先经画师确认。
- 生成批次建议写在清单表后：先基准页，再高复用系统页，最后运营页。

### 6. 交棒逐页生成

screen-map approved 后，逐页生成走 `ui-page`（它从 map 的 `## screen.<id>` 节取 brief 基础）。
本 skill 到此为止，不代跑生图。

## Turn 收尾报告（七件套）

每轮有实质产物（审计完成 / 范围批准 / map 落盘）时，以固定七件套收尾：

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

- 三锚未 approved 且无 waiver → 不延展；风格未定稿（style.md `ui.*` 非 approved）→ 不延展。
- 页面范围由画师批，沉默 / 模糊不当批准；skill 不代批、不代跑生图。
- 清单从旅程断点推导，不从分类池全量搬运；页面数量与项目阶段相称。
- prd 页面范围表是上游：map 与 prd 不一致以 prd 为准，新增页先回写 prd。
- 每页契约字段与 screen-brief 对齐（purpose / 布局分区 / 组件 / 状态），不写 data_needs 等开发字段。
- 修改 approved 的 prd / screen-map 必须先经画师确认。
- 所有提问走 AskUserQuestion；工具不可用降级文本确认卡（协议同 character skill）。

## 跳过条件

git / 代码 / 纯问答；单页生成或改风格（ui-page）；写策划文档（ui-anchor）；角色资产。
