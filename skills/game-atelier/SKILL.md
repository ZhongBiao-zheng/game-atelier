---
name: game-atelier
version: 1.0.0
description: |
  game-atelier 工坊总控：先诊断当前进度（环境 / 项目 / 角色资产 / UI 管线），
  再路由到对应管线技能，编排跨管线顺序与人工门禁。
  用户不确定接下来做什么资产、要从零起一个游戏项目、要跨角色与 UI 两条管线走完整资产流程、
  问工坊进度，或调用 /game-atelier:game-atelier 时使用。
  已明确要做某一件事（做立绘 / 出美宣 / 做三视图 / 做 UI 页面）直接走对应技能；
  只走 UI 一条线（含完整 UI 设计流程）走 ui 总控；两者都不必过本总控。
  改代码 / 排 bug / 发版不归本总控。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
  - Skill
triggers:
  - /game-atelier:game-atelier
  - 工坊总控
  - 游戏资产做到哪了
  - 接下来做什么资产
  - 从零起一个游戏项目
  - 走完整资产流程
---

## 定位

总控做三件事：**诊断**（一次探清环境 + 项目 + 两条管线进度）、**路由**（分派到最小充分的管线技能）、**编排**（全链按序推进，跨管线门禁必停）。

两条硬约束：

- 总控**不生产任何资产**——不写 spec、不组 prompt、不提交 job、不改 approved 文档。
- 总控**不重复实现子技能的门禁**。子技能 SKILL.md 里的判据是唯一权威；总控只探测事实（文件在不在、`status` 字面值是什么）并给建议，最终放行由被路由到的子技能自己判。总控的「建议下一步」不等于批准。

## 运行模式（CLI 前缀判断）

与 character 主 Skill 同一套三选一规则（完整说明见其「启动自检」节）：`${CLAUDE_PLUGIN_ROOT}` 非空 → `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --run -m character_workflow <subcmd>`（Windows 用 `python`）；Codex → 解析 `$BOOT` 后用 `python "$BOOT" --run ...`，**绝不 `uv run`**；仓库内开发 → `uv run python -m character_workflow <subcmd>`。

## 第一步：环境自检

跑 `<bootstrap.py> --check`。status 非 `ready` / `needs_first_key` → **停在修环境**，按 character skill「启动自检」表逐项推进，不进任何生图路由。`--check` 顺路带 `update` 字段，有新版按其「插件更新提醒」协议问一次。

## 第二步：进度诊断

一次 `turn-start` + Read 项目目录，填下表。**读不到就写「未建立」，不猜、不据一个维度推断另一个**：

| 维度 | 探测 | 汇报什么 |
|---|---|---|
| 环境 | `--check` 的 `status` | ready / 缺哪一项 |
| 项目 | turn-start `has_projects` / `projects` / `project_slug` | 项目数、当前归属项目 |
| 世界观 | turn-start `project_worldview` | 有 / 未建立 |
| 风格契约 | turn-start `project_style` | 有基础节 / 未建立 |
| 角色资产 | turn-start `recent_chars` / `spec_status` / `canonical` | 角色数、active 角色、各 slot 有无定稿 |
| UI 锚文档 | Read `projects/<slug>/design/{gdd,prd,interaction}.md` frontmatter `status` | 几份存在、各自 status 字面值、有无 `design/waiver.md` |
| UI 规范 | Read `projects/<slug>/style.md` 有无 `ui.*` 节 | 未建立 / 有节及其 status |
| 页面地图 | Read `projects/<slug>/screens/screen-map.md` frontmatter `status` | 未建立 / status 字面值 + 页面数 |

诊断完固定输出**进度卡**（总控独有产物，不与七件套混用）：

```text
项目：<name>（<slug>）
环境：<ready ｜ 缺 xxx>
角色：<N 个 ｜ active=<名>>  立绘 <有/无> · 美宣 <有/无> · 三视图 <有/无>
UI：  锚文档 <x/3 approved> · UI 规范 <未建立/draft/approved> · 页面 <N 张>
建议下一步：<一句话，只给一个>
你可以直接说：<1-3 条可复制原话>
```

「建议下一步」**只给一个**，不摆菜单让画师挑。要给备选放进「你可以直接说」，每条是能原样复制的话（如「做个新角色」「批准三文档」「开窗看图」）。

## 路由表

| 请求 | 去处 |
|---|---|
| 立绘 / 新角色 / 改立绘 / 换皮肤 | Skill 工具调起 `character` |
| 美宣 / 宣传图 / 海报 / KV | Skill 工具调起 `promo`（前置：该角色已有 spec.md + portrait/） |
| 三视图 / 角色三面 / 设定集 | Skill 工具调起 `turnaround`（前置同上） |
| 游戏 UI 任一阶段（策划锚 / UI 规范 / 页面生成 / 风格切换 / 页面延展） | Skill 工具调起 `ui`（UI 总控，内部再分派到 ui-anchor / ui-page / ui-screens） |
| 开窗看图 / 起 server / 加 API Key / Web 界面 | Skill 工具调起 `viewer-server` |
| 新建项目 / 定项目定位 | 本总控处理（问一句定位 → `create-project "<项目名>"`） |
| 世界观 / 项目经验 | 指向 Web「项目经验」页（写 `projects/<slug>/worldview.md`），总控不代笔 |
| 改代码 / 排 bug / 跑测试 / 发版 / 纯问答 | 不归本总控，见「跳过条件」 |

**UI 域一律经 `ui` 总控**，不越级直连 `ui-anchor` / `ui-page` / `ui-screens`——两层 router 各管一层，责任不重叠。例外只有画师明确点名子命令（如 `/game-atelier:ui-page`）时，直接照办。

## 建议链路

```text
建项目 → 角色立绘（首次立起 style.md 基础节）→ ┬ 美宣（promo）
                                                ├ 三视图（turnaround）
                                                └ UI 管线（ui 总控：锚 → 规范 → 基准页 → 风格定稿 → 延展 → 逐页）
```

角色排在 UI 之前的理由：`style.md` 基础节（画风工艺 / 色板语义 / 禁止项）由角色管线首次建立，UI 的 `ui.*` 节从中派生。反向也能走（先 UI），此时 `ui` 总控会要求先补基础节。两条管线共用**同一份** `style.md`，不另立平行契约。

这是**建议顺序，不是强制**。画师点名单阶段时不强迫走完整流程。

## 跨管线门禁

总控只管这几条，其余门禁在各子技能内：

1. 环境非 `ready` / `needs_first_key` → 不进任何生图路由。
2. 无项目 → 先建项目再往下（资产无归属会落进 Stage E 兜底）。
3. promo / turnaround 前该角色无立绘（无 spec.md 或 portrait/ 空）→ 指回 `character`，不让画师白跑一趟。
4. UI 生图前三锚文档未 approved 且无 waiver → 交给 `ui` 总控（其内部指向 `ui-anchor`），不越级调 `ui-page`。
5. 门禁必停：批准点等画师明确表态，沉默 / 模糊 / 「你觉得行就行」都不当批准。

## 收尾

有实质推进（建了项目 / 完成诊断 / 路由到子技能 / 被门禁挡下）时，按 ui 总控同一套七件套收尾：

```text
当前步骤：
完成状态：
本步产物：
需要你检查：
可选操作：
进入下一步的条件：
下一步可直接说的话：
```

纯诊断轮（只回答「进度到哪了」）用进度卡即可，不必套七件套。

## Guardrails

- 总控不生产资产；产物只出自子技能。
- 不重复实现子技能门禁；发现总控探测结论与子技能判据不一致 → **以子技能为准**，同时把分歧报给画师，不擅自改任一侧。
- 一次只推进一步。把「给出下一步指引」当成已经执行下一步是违规。
- 尚未上线的能力如实告知，不伪造产物、不用 Studio 自由出图冒充流程产物。
- 项目事实落文件系统（`projects/<slug>/`），不留在对话里。
- 所有提问走 AskUserQuestion；工具不可用降级为文本确认卡（协议同 character skill）。

## 跳过条件

- 改代码 / 调样式 / 排 bug / 跑测试 / 发版 → 走仓库 CLAUDE.md 的 skill routing（`/investigate`、`/review`、`/ship` 等），与本总控无关。
- 纯问答 / 查文档 / 看历史。
- 画师已明确单点需求 → 直达对应管线技能，不必先过本总控。
- 需求只落在 UI 一条线上（哪怕是「走完整 UI 流程」）→ 直接走 `ui` 总控。本总控只在**跨管线**（角色 + UI 都要）或方向未定时才有价值。
