---
name: ui
version: 1.1.0
description: |
  游戏 UI 设计总控：按请求路由到阶段技能（策划锚 / UI 视觉规范 / 页面生成 / 风格切换 / 页面延展），
  编排阶段间人工门禁，每步固定七件套收尾。
  用户要做游戏 UI（界面 / 页面 / HUD / 弹窗）、走完整 UI 设计流程，或调用
  /game-atelier:ui 时使用；单独做角色立绘 / 美宣 / 三视图不归本总控。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Skill
triggers:
  - /game-atelier:ui
  - 做游戏 UI
  - 设计游戏界面
  - UI 设计工作流
---

## 定位

总控只做三件事：**路由**（把请求分派到最小充分的阶段）、**门禁**（阶段间人工批准点必停）、**编排**（完整链路按序推进）。总控自己不生产资产；项目事实全部落 `<data_root>/projects/<slug>/` 文件系统，不留在对话里。

## 运行模式（CLI 前缀判断）

与 character 主 Skill 同一套三选一规则（详见其「启动自检」节）：`${CLAUDE_PLUGIN_ROOT}` 非空 → `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --run -m character_workflow <subcmd>`（Windows 用 `python`）；Codex → `python "$BOOT" --run ...`，绝不 `uv run`；仓库内开发 → `uv run python -m character_workflow <subcmd>`。

## 快速路由

按请求选择最小充分路径，用户点名单阶段时不强迫走完整流程：

| 请求 | 去处 |
|---|---|
| 策划文档 / PRD / 交互逻辑 / 生图前需求 | Skill 工具调起 `ui-anchor` |
| UI 视觉规范 / 统一风格 / 色板字体圆角 | 本总控引导写 `style.md` 的 `ui.*` 节（见「UI 规范阶段」） |
| 单页生成 / 基准页 / 页面生图 | Skill 工具调起 `ui-page`（门禁：三锚 approved 或 waiver + style.md 存在） |
| 风格切换 / 风格候选对比 | `ui-page` 风格切换模式（结构锁定出候选 → 画师定稿 → 回写 style.md `ui.*`） |
| 页面清单 / 屏幕地图 / 批量延展 | Skill 工具调起 `ui-screens`（门禁：三锚 approved 或 waiver + style.md `ui.*` approved） |
| 角色立绘 / 美宣 / 三视图 | `character` / `promo` / `turnaround`（角色管线，不归本总控编排） |

阶段技能可独立调用，但都读同一套项目文件（design/ 三锚文档 + style.md + screens/screen-map.md）；某阶段能力尚未上线时如实告知当前能走到哪一步，不伪造产物。

## 初始化

1. `uv run python -m character_workflow turn-start` 取 `has_projects` / `projects` / active 归属项目；多项目 AskUserQuestion 选定。
2. 无项目 → 先问项目定位（一句话）→ `create-project "<项目名>"` 落盘。
3. Read `projects/<slug>/` 现状：`design/` 三锚文档各自 status、`style.md`（含 `ui.*` 节与否）、`worldview.md`。据此判断当前处于哪个阶段，只跑缺的。

## 阶段顺序与门禁

完整链路：**锚文档 → UI 规范 → 基准页 → 风格定稿 → 页面延展 → 逐页生成**。门禁一览（存在人工门禁必须停，不得把「给出下一步指引」当成自动执行下一步）：

| # | 阶段 | 产物 | 进入条件（门禁） |
|---|---|---|---|
| 1 | 策划锚（ui-anchor） | `design/{gdd,prd,interaction}.md` | 无 |
| 2 | UI 规范（本总控引导） | `style.md` 增补 `ui.*` 节 | 三锚文档 approved（或 `design/waiver.md` 在案） |
| 3 | 基准页（ui-page） | `screens/<id>/v1.png` | 同上 + style.md 存在 |
| 4 | 风格定稿（ui-page 风格切换） | 候选对比 + screens canonical + style.md `ui.*` approved | 基准页结构经画师确认 |
| 5 | 页面延展（ui-screens） | `screens/screen-map.md`（清单 + 每页契约） | 风格已定稿（style.md `ui.*` approved） |
| 6 | 逐页生成（ui-page，从 map 取契约基础） | `screens/<id>/vN.png` | screen-map `status: approved`（范围经画师批准） |

硬规则：

- 三锚文档未 approved 且无 waiver → 不进任何生图阶段，指回 `ui-anchor`。
- 基准页结构未确认 → 不开始风格定稿。
- 风格未定稿 → 不批量延展页面。
- 页面范围未批准 → 只完成 screen-map，不逐页生成。

## UI 规范阶段（不单立 skill）

锚文档批准后，由本总控引导把 UI 视觉语言写进 `style.md` 的 `ui.*` 节（`ui.typography` / `ui.geometry` / `ui.states`，格式见 `docs/references/style-template.md`）——**同文件不另立平行契约**，角色与 UI 共用一份 style.md：

1. Read `style.md`：无此文件 → 先按 style-template 问清基础节（style/palette/taboo）再补 `ui.*`；已有 → 只补 `ui.*` 节。
2. 从 interaction.md 全局交互原则 + gdd 世界观推导初稿，AskUserQuestion 逐项确认（字体气质 / 圆角描边材质 / 组件状态表现）。
3. 画师确认后落盘；修改 approved 的 style.md 必须先经画师确认。

## 每步固定输出（七件套）

每个阶段结束（含被门禁挡下时），固定输出：

```text
当前步骤：
完成状态：
本步产物：
需要你检查：
可选操作：
进入下一步的条件：
下一步可直接说的话：
```

「下一步可直接说的话」给画师一句可复制的原话（如「批准三文档」「开始 UI 规范」）。

## Guardrails

- 总控不生产资产；产物只出自阶段技能或 UI 规范引导流程。
- 门禁必停：批准点等画师明确表态，沉默 / 模糊不当批准。
- 尚未上线的能力如实告知，不伪造产物、不用 Studio 自由出图冒充流程产物。
- 项目事实落文件系统（design/ / style.md / screens/），不留在对话里。
- 修改任何 approved 文档（锚文档 / style.md / screen-map）必须先经画师确认。
- 所有提问走 AskUserQuestion；工具不可用降级文本确认卡（协议同 character skill）。

## 跳过条件

git / 代码 / 纯问答；纯角色资产需求（直接走 character / promo / turnaround）。
