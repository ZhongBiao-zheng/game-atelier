---
name: video
version: 1.1.0
description: |
  游戏项目视频工作流：建立视频企划 brief 与镜头表，按单镜头生成、迭代并选定版本。
  产物归项目 projects/<slug>/videos/<production-id>/，适用于宣传片、角色展示、玩法演示、
  剧情过场和社媒短视频。用户要做项目宣传视频、拆镜头、生成正式视频资产，或调用
  /game-atelier:video 时使用；无项目归属的自由视频试验走 Web 创作台。
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
  - 拆视频镜头
  - 生成视频镜头
---

## 定位

本 Skill 管理正式项目视频，最小闭环是：**企划 brief → 镜头表 → 单镜头生成 → 选定版本**。
每个 job 归属 `project_id + production_id + shot_id`，产物落
`projects/<slug>/videos/<production-id>/shots/<shot-id>/vN.mp4`，Web 工坊「视频」页可见。

本阶段不做时间线剪辑、字幕、配乐和自动拼接。自由试验不建企划，直接去创作台。

## 运行模式

与 character Skill 同一套三选一前缀：Claude Installed Plugin 用
`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --run -m character_workflow`；Codex 解析
`$BOOT` 后用 `python "$BOOT" --run -m character_workflow`；仓库开发用
`uv run python -m character_workflow`。Codex per-turn 不用 `uv run`。

## 工作流

### 1. 定项目

运行 `turn-start` 读取 projects。无项目先建项目；多项目时让画师明确选一个，不把视频落进
Studio namespace 冒充正式项目资产。

### 2. 建视频企划

一次问清：企划名称、类型（promo / character / gameplay / cutscene / social / custom）、目标平台、
比例、目标总时长、声音策略。把可执行要求补进 brief，然后运行：

```bash
create-video-production \
  --project <project-id-or-slug> \
  --production <production-id> \
  --title "<企划名>" \
  --type <type>
```

命令生成 `brief.md` 与 `shot-map.md`。已有同名企划时不得覆盖，回到已有文件继续。

### 3. 写镜头表并停在范围确认门

从 brief 拆最少充分镜头，在 `shot-map.md` 表中写 `shot-id / 用途 / 时长 / 状态`，再为每个镜头补：

- 画面目的与主体动作；
- 景别、运镜、首尾状态；
- 角色 / UI / 场景定稿引用；
- 声音或口型要求；
- 连续性约束。

把镜头表交画师确认，沉默不算批准。未批准不批量提交镜头。

### 4. 单镜头提交

一次只处理一个镜头。读项目 worldview、style、企划 brief、shot-map 对应镜头和引用定稿，写临时 prompt，运行：

画师如果已在 Web 镜头详情里选择角色、角色衍生或 UI 定稿，不要再手工重复拼 `--reference-image`；
`submit-video-shot` 会读取该镜头的 `references.json` 草稿，并把当时的实际文件路径复制进新 Job。
命令行 `--reference-image` 只用于补充 Web 候选之外的临时参考，重复路径会自动去重。

```bash
submit-video-shot \
  --project <project-id-or-slug> \
  --production <production-id> \
  --shot <shot-id> \
  --prompt-file <prompt.txt> \
  --duration <seconds> \
  --resolution <720p|1080p> \
  --ratio <16:9|9:16> \
  [--reference-image <path>] \
  [--reference-video <path>] \
  [--reference-audio <path>]
```

stdout 是 job_id，stderr 是确认卡。原样展示确认卡并停；画师明确说“生成 / 出片”后才
`run-job <job_id>`。模型与素材上限由现有视频 caller 契约负责，不在 Skill 猜参数。

### 5. 选定镜头版本

画师明确选定某个版本后运行：

```bash
set-video-selected \
  --project <project-id-or-slug> \
  --production <production-id> \
  --shot <shot-id> \
  --path <vN.mp4>
```

取消选定用 `--clear`。选定不删除其他版本，旧版本保留用于比较与复盘。

## 每步输出

```text
当前步骤：
完成状态：
本步产物：
需要你检查：
进入下一步的条件：
下一步可直接说的话：
```

## Guardrails

- 正式视频必须归项目、企划和镜头；不拿 Studio job 冒充。
- 企划 id / shot id 只用小写字母、数字、连字符。
- 镜头范围和生成确认都是人工门禁，一次只推进一步。
- 引用角色或 UI 时优先 canonical；定稿 stale 必须提示。
- Web 里的参考选择是下一次生成草稿；镜头详情按新到旧展示全部 Job 的 Prompt、参数和参考素材，切换 canonical 不回写旧 Job。
- 不在没有真实需求时扩成时间线编辑器。
