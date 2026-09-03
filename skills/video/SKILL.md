---
name: video
version: 2.0.0
description: |
  游戏项目完整视频工作流：建立视频企划 brief 与一份多镜头完整 Prompt，一次提交生成一支完整视频，
  多次生成形成整片版本并选定最终版本。适用于宣传片、角色展示、玩法演示、剧情过场和社媒短视频。
  用户要做项目视频、写或优化项目视频提示词、使用 Shot 1-N 描述完整短片、生成或选定正式视频资产，
  或调用 /game-atelier:video 时使用；无项目归属的自由视频试验走 Web 创作台。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
triggers:
  - /game-atelier:video
  - 做项目视频
  - 做宣传片
  - 生成完整视频
  - 写视频提示词
  - 生成营销视频
---

## 定位

本 Skill 管理正式项目视频，最小闭环是：

**企划 brief → 一份完整多镜头 Prompt → 一次生成一支完整视频 → 整片选版**。

每个 Job 只归属 `project_id + production_id`，产物落
`projects/<slug>/videos/<production-id>/versions/vN.mp4`。`镜头1…镜头N` 或 `Shot 1…Shot N`
只是 `prompt.md` 内的叙事段落，绝不拆成多个 Job、目录、页面或选版单位。

本阶段不做时间线剪辑、片段拼接或逐镜头续帧。长篇多片段制作是另一条未来工作流，不在这里模拟。
改动本 Skill 的路由或产出契约时，复跑 `evals/trigger_cases.json` 与 `evals/evals.json`。

## 运行模式

与 character Skill 同一套三选一前缀：Claude Installed Plugin 用
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --run -m character_workflow`；Codex 解析
`$BOOT` 后用 `python "$BOOT" --run -m character_workflow`；仓库开发用
`uv run python -m character_workflow`。Codex per-turn 不用 `uv run`。

## 工作流

### 1. 定项目与模型

运行 `turn-start` 读取 projects 和可用 Key。无项目先建项目；多项目时让画师明确选一个。

在写 Prompt 前确定实际模型。不同模型的写法和硬限制不同；读取
`references/prompt-contract.md`，按所选模型分流，不拿通用长模板硬套 Seedance。

### 2. 建视频企划

一次问清：企划名称、类型（promo / character / gameplay / cutscene / social / custom）、目标平台、
比例、目标总时长、传播目的、角色与声音策略。声音按任务选择对白、音效、环境音、BGM、静音或组合，
不得默认禁止 BGM。

```bash
create-video-production \
  --project <project-id-or-slug> \
  --production <production-id> \
  --title "<企划名>" \
  --type <type>
```

命令生成 `brief.md` 与 `prompt.md`。已有同名企划时不得覆盖，回到已有文件继续。

### 3. 写一份完整 Prompt 并停在确认门

从项目角色和 UI 定稿中选择整个企划需要的参考素材。优先 canonical；定稿 stale 必须提示。
没有角色立绘定稿时允许使用该角色最早的立绘版本，并明确标记“尚未定稿”。逐张检查图片和
参考视频；发现可辨识写实真人脸时阻止 Seedance 提交并要求更换素材。

按照 `references/prompt-contract.md` 写 `prompt.md`。Seedance 常规短片用主体、场景、声音、
镜头 1–N；一个镜头段只写机位/景别和具体事件。参考图已经表达的外观不重复堆料，易画错的身份
才补关键特征与负面约束。

把完整 Prompt、模型、时长、比例、参考素材和声音策略一次性交给画师确认。沉默不算批准。

### 4. 一次提交完整视频

Web 企划详情里选择的参考素材已存入企划级 `references.json`；提交时会复制实际路径进 Job 快照。
命令行的参考素材参数只补 Web 候选之外的临时素材，重复路径自动去重。

```bash
submit-video-production \
  --project <project-id-or-slug> \
  --production <production-id> \
  --duration <seconds> \
  --resolution <720p|1080p> \
  --ratio <16:9|9:16> \
  [--prompt-file <prompt.txt>] \
  [--reference-image <path>] \
  [--reference-video <path>] \
  [--reference-audio <path>]
```

缺省读取企划目录的 `prompt.md`。stdout 是 job_id，stderr 是确认卡。原样展示确认卡并停；画师明确
说“生成 / 出片”后才 `run-job <job_id>`。无论 Prompt 内有几个 Shot，只运行一次 Job。

### 5. 重试与整片选版

需要另一版时，对完整 Prompt 做最小修改后再次 `submit-video-production`；得到新的整片版本，
不把不同版本当成分镜素材拼接。

```bash
set-video-selected \
  --project <project-id-or-slug> \
  --production <production-id> \
  --path <vN.mp4>
```

取消定稿用 `--clear`。定稿不删除其他完整版本。

## 每步输出

```text
当前步骤：
完成状态：
本步产物：
需要你检查：
进入下一步的条件：
下一步可直接说的话：
```

## 手的选择（CLI / MCP 双路径）

本 Skill 的知识层（记忆注入、设定协议、prompt 规则、经验沉淀）与「手」无关；只有读写资料 / 准备 / 执行这一层按可用性选一条：

- 客户端工具列表里有 `workshop_*` 工具 → 走 MCP：按 `docs/references/workshop-mcp-workflow.md` 用同名工具替代本文的 turn-start / submit / run-job / append-memory 等命令，其余章节照旧。
- 没有 → 走本文的 CLI 命令。

两条路径的批准门相同：确认卡 + 画师明确肯定。MCP 路径下，授权带 `execute_generation` 时用 `workshop_approve_generation` 完成批准；不带时请画师去 Atelier「待批准生成」页确认。同一轮绝不混用两条手。

## Guardrails

- 正式视频必须归项目和企划；不拿 Studio Job 冒充。
- 企划 id 只用小写字母、数字、连字符。
- 一份完整 Prompt 只能创建一个 Job；Shot 标题不能触发批量任务。
- Prompt 与生成确认都是人工门禁，但用户明确授权批量重试时可按整片版本连续执行。
- 音频策略按任务决定；只有任务明确无 BGM 时才写“不要背景音乐”。
- 模型时长和素材上限必须在提交前检查；Seedance 2.0 与 2.5 规则见 Prompt 契约。
- Web 参考选择是下一次完整生成的草稿；切换 canonical 不回写历史 Job。
- 不在没有真实需求时扩成时间线编辑器或逐镜头拼接系统。
