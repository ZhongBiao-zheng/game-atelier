---
name: ui-page
version: 1.2.0
description: |
  游戏 UI 单页生成与风格切换：读锚文档 + style.md + 页面 brief 组 prompt，走 job 体系出基准页 /
  单页；结构锁定出 N 个风格候选供并排对比，选定后回写 style.md ui.* 契约。
  产物归项目（projects/<slug>/screens/<screen-id>/）。一次只做一页。
  前置门：design/ 三锚文档 approved（或 waiver 在案）且 style.md 存在，否则不生图。
  用户要生成 UI 页面 / 基准页 / 界面图 / 换风格出候选，或调用 /game-atelier:ui-page 时使用。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
triggers:
  - /game-atelier:ui-page
  - 生成 UI 页面
  - 出基准页
  - 生成界面图
  - 换风格出候选
---

## 定位

一次只做一页。页面结构写进 brief（`projects/<slug>/screens/<screen-id>.md`，事实源），
生成快照存 job JSON（prompt / model / params）——brief 与 prompt 分离，生成参数不回写 brief。
产物走完整 job 体系（确认卡 / 失败重试 / 5xx 重试 / 直连白名单全部复用），落
`projects/<slug>/screens/<screen-id>/vN.png`，Web 项目页「页面」区可见。

两种模式：**基准页模式**（默认，验结构）与**风格切换模式**（结构锁定、只换风格出候选，见下节）。

## 运行模式（CLI 前缀判断）

与 character 主 Skill 同一套三选一规则（详见其「启动自检」节）：`${CLAUDE_PLUGIN_ROOT}` 非空 →
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --run -m character_workflow <subcmd>`
（Windows 用 `python`）；Codex → `python "$BOOT" --run ...`，绝不 `uv run`；
仓库内开发 → `uv run python -m character_workflow <subcmd>`。

## 工作流

### 1. 定项目

`turn-start` 取 `has_projects` / `projects` / active 归属项目（同 ui-anchor 协议）；
多项目用 AskUserQuestion 选定，拿到 `project_slug`。

### 2. 门禁检查（硬门，不过不生图）

Read `projects/<slug>/design/{gdd,prd,interaction}.md` 与 `projects/<slug>/style.md`：

- 三锚文档任一缺失或 `status` 非 `approved`，且无 `design/waiver.md` → **停**，指回 `ui-anchor`，不生图。
- `style.md` 不存在 → **停**，指回 `ui` 总控的「UI 规范阶段」补契约（有基础节即可放行，`ui.*` 节缺失时提示补全但不阻塞）。
- 凭 waiver 放行时，向画师明示「本次凭 waiver 跳过策划门禁」。

### 3. 定 screen-id

`projects/<slug>/screens/screen-map.md` 存在且 approved → 从其页面清单表取 `screen-id`
（按依赖与优先级推荐下一个 `planned` 页）；否则从 prd「页面范围」表取。
画师点名哪页做哪页；没点名时推荐 must-have 的第一个未生成页，基准页通常是 `home`。
画师点名的 id 不在表里 → 先确认是否补进 prd / screen-map（改 approved 文档须画师确认），不擅自造页。

### 4. 写 / 更新 brief

Read `projects/<slug>/screens/<screen-id>.md`：

- 不存在 → 按 `${CLAUDE_PLUGIN_ROOT}/docs/references/screen-brief-template.md` 推初稿：
  screen-map 有 `## screen.<id>` 节时**以它为基础**（purpose / 布局分区 / 组件 / 状态直接取用，
  只补反向限制等缺项）；没有 map 时从 prd（覆盖需求）+ interaction（`## screen.<id>` 节的流程与状态）推。
  AskUserQuestion 确认布局分区与反向限制后 Write 落盘。
- 已存在 → 只在画师要求结构改动时更新；生成参数（尺寸 / 模型 / 风格词）不写进 brief。
- 状态名沿用 interaction.md 契约；零占位。

### 5. 组 prompt 并提交

prompt 组装顺序：style.md（基础节 + `ui.*`）→ brief（定位 / 布局分区 / 组件 / 状态）→ 反向限制（逐条），
写入临时文件后提交：

```bash
uv run python -m character_workflow submit-screen \
  --project <slug> --screen <screen-id> --prompt-file <tmp.txt> \
  [--reference-image <基准页图绝对路径>]
```

stdout 是纯 job_id，stderr 是确认卡——**原样转发确认卡给画师，就地停下**（同 character skill 出图前确认协议）。
尺寸默认横幅 1536x1024，画面为竖版游戏时传 `--size 1024x1536`。

### 6. 确认后执行

画师明确说「出图」→ `run-job <job_id>`。产物落 `projects/<slug>/screens/<screen-id>/vN.png`，
提示画师在 Web 项目页「页面」区查看。失败 → 把 job.error 的中文原因给画师，经确认后 `retry-job <job_id>`。
screen-map 存在时，把该页清单表状态推进为 `generated`（定稿后推进为 `canonical`）。

## 风格切换模式（B3）

基准页结构经画师确认后才进入本模式——**结构不变、只换风格**，出 N 个候选并排对比，选定的那个成为
项目风格基准。

### 1. 锁结构

Read 该 screen 的 brief，**一字不改**；候选之间只有风格描述不同，布局分区 / 组件 / 状态全部沿用。
brief 缺失 → 先回基准页模式补 brief，不凭空开候选。

### 2. 问风格方向

AskUserQuestion 让画师给 2-4 个风格方向（如「厚涂写实 / 扁平卡通 / 像素复古」）；画师说不清时，
按 gdd 定位 + worldview 调性提三个候选方向请他选，不擅自决定。

### 3. 每候选一条 job

逐个提交，每条独立 job，来源关系落盘：

```bash
uv run python -m character_workflow submit-screen \
  --project <slug> --screen <screen-id> --prompt-file <tmp-候选N.txt> \
  --style-variant "<风格方向>" --base-version <基准页文件名，如 v1.png> \
  --reference-image <基准页图绝对路径>
```

确认卡逐条转发给画师；**全部候选可一次性确认后连续 run-job**，但每条失败各自报错、各自重试。
旧候选一律保留不删——版本对比历史是后续经验沉淀的素材。

### 4. 画师选定 → 定稿

Web 项目页「页面」区并排对比后，画师点「定稿」即写入项目级 canonical；也可由 skill 代写：

```bash
uv run python -m character_workflow set-screen-canonical \
  --project <slug> --screen <screen-id> --path <选定图路径>
```

风格标签由后端从 job 反查，不用重复报。

### 5. 回写 style.md `ui.*`（本模式的真正产出）

把选定候选的风格拆成**可执行描述**（下次生成能照着复现的话，不是「好看」这种评价），写进
`style.md` 的 `ui.typography` / `ui.geometry` / `ui.states` 三节（格式见
`${CLAUDE_PLUGIN_ROOT}/docs/references/style-template.md`），经画师确认后把 `status` 置 `approved`
并刷新 `updated`。从此所有延展页 prompt 注入这份契约，风格漂移有守卫。

未回写就宣称「风格已定」= 违规：契约不落文件，下一页照样漂。

回写会改 style.md → 刚设的定稿指纹随即过时（A3）。回写完成后**重跑一次
`set-screen-canonical`（同 path）刷新指纹**，别让这张「定义新风格的图」自己挂着
「风格已变更」角标。反过来，之后再改 style.md 前，先跑 `stale-report` 向画师列出
项目下会过时的定稿（角色 + screen），经确认再动。

## Turn 收尾报告（七件套）

每轮有实质产物（brief 落盘 / job 提交 / 出图完成）时，以固定七件套收尾：

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

- 三锚文档未 approved 且无 waiver → 不生图；style.md 缺失 → 不生图。门禁必停，不得代画师批准。
- 出图前确认卡必停：画师明确表态才 run-job，沉默 / 模糊不当确认。
- 一次只做一页；不批量延展（那是 ui-screens，B4）。
- brief 是结构事实源：结构改动写 brief，prompt 快照只存 job JSON，不三份存储。
- 修改 approved 的 prd / interaction（补页面 / 改状态名）必须先经画师确认。
- 风格候选必须结构锁定：改了 brief 的不是候选，是新基准页。
- 定稿由画师选，skill 不代选；旧候选保留不删。
- 风格选定后必须回写 style.md `ui.*` 并置 approved，否则不得宣称风格已定。
- 所有提问走 AskUserQuestion；工具不可用降级文本确认卡（协议同 character skill）。

## 跳过条件

git / 代码 / 纯问答；角色资产（character / promo / turnaround）；写策划文档（ui-anchor）。
