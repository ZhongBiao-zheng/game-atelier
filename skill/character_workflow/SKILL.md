---
name: character-workflow
description: 游戏角色资产工作流。承接画师在 Web UI 上的反馈、改 prompt、改 spec，对话驱动逐项问清风格/配色/镜头/道具后调 Lovart 中文 prompt 出图。**主动触发**当用户说"开始角色工作流"、"做个角色"、"出张角色立绘"、"加个新角色"、`/character-workflow <名>`，或 Web 端 viewer-server 已开着且用户粘"继续"。**禁止**生成带 `?`/"待补充"/"留空" 占位的 spec 文档 —— 决策永远走对话。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
version: 3.0.0
---

# Character Workflow

## 哲学锚（任何场景下都不许违反）

1. **文件系统是唯一 source of truth** —— `characters/<id>/spec.md`、`.runtime/draft/*.md`、`.runtime/jobs/*.json`
2. **画师的每个动作终态都是文件** —— Web UI 写文件，Skill 读文件
3. **对话决策、文档归档** —— 永远不出"待补充"占位让画师补全
4. **中文 prompt 优先** —— 画师的链路全程中文

## Turn 起始（每次 turn 必做）

```bash
uv run python -m skill.character_workflow turn-start
# 默认 --kind portrait；做 promo/turnaround 时显式传 --kind 进对应 lessons
```

一次返回 JSON：

```json
{
  "drafts":   [...],        # .runtime/draft/ 里画师还没消化的反馈
  "active_id": "holy",      # 当前活跃角色
  "spec":      "<markdown>",# characters/<id>/spec.md
  "worldview": "<markdown>",# 项目根 worldview.md（共享）
  "lessons":   "<markdown>",# references/lessons/<kind>.md（共享）
  "lessons_kind": "portrait"
}
```

把 `worldview` + `lessons` + `spec` 拼到对话前缀（建议走 `lib.prompt_builder.assemble_character_prompt`），它们就是这一轮的专家上下文。

切换处理对象：

```bash
uv run python -m skill.character_workflow set-active <character-id>
```

**跳过条件**：用户消息明显是 git/代码/纯问答 → 跳过。没有 active_id 且没有 draft → 问"想处理哪个角色？"，不要凭空创建文件。

## 关键协议

### 新建角色 / 补全 spec

对话逐项问清：风格档 → 配色 → 镜头 → 视觉锚点。一次问 1–3 个，二选一优先。问清才动笔。

**完整协议（含反例）** → `references/spec-protocol.md`

### 写出图 prompt

中文 8 段式："主体 → 服装 → 头部 → 道具 → 姿势 → 场景 → 风格 → 规格"。

**模板** → `references/prompt-zh.md`

### 调 Lovart 出图

**永远先确认再调用。** 流程：

1. `jobs.write_job(..., kind=JobKind.PORTRAIT)` 落盘 `PENDING_CONFIRM`（默认状态）
2. 终端打可读出图卡片（模型/厂家/尺寸/n/参考图/中文 prompt 全列）
3. 等画师明确说"出图/确认/OK"，或 Web 端点确认（后端推到 `PENDING`）
4. 调 `lib.lovart_caller.submit_and_wait(...)`，`output_dir=jobs.job_output_dir(id, kind)` —— 立绘自动落到 `characters/<id>/portrait/`（同步阻塞，job 停在 `PENDING`）
5. 成功 `update_job_status(DONE, output_paths=[...])` / 失败 `FAILED`
6. **在终端用 `![v1](绝对路径)` markdown 把每张图打出来**（CC 终端直接渲染）。**默认 n=1**，画师明示"多出几张/对比" 才提到 n=4。

**完整调用流程 + 失败处理** → `references/lovart-call.md`

### Turn 收尾：经验沉淀（lessons）

满足以下任一时触发：
- 本轮 job → DONE
- spec 第一次归档（写完 `characters/<id>/spec.md`）
- 本轮 job → FAILED 且 `error` 是结构化原因（prompt 超长 / 模型拒绝 / 内容审核），不是网络抖动

Skill 主动问画师：

> "本轮要不要沉淀一条经验到 `lessons/portrait.md`？想保留就给我一句话，否则跳过。"

画师答 Y / 给出一句话 → 调：

```bash
uv run python -m skill.character_workflow append-lesson --kind portrait --line "- 2026-05-19 holy-spirit-priestess · 金白配色高识别度 · prompt 片段：\`兜帽低垂遮眼\`"
```

格式严格遵守 `- YYYY-MM-DD <id> · <一句话> · prompt 片段：\`...\``。同 turn 多次出图 → 每次都问；画师一次性说"全部不追加" 则后续都跳过。**画师 cancel / 网络抖动 FAILED 不问。**

## viewer-server 启停

画师 `/character-workflow <角色>` 第一次触发时：

```bash
python skill/viewer-server/server.py start
python skill/viewer-server/server.py open-browser
```

server 启动时会自动清理 stale PID。详见 `skill/viewer_server/SKILL.md`。

## 何时跳过本 Skill

- 用户问的是 git / 代码 / 部署 / 纯问答 → 跳过 turn 起始
- 用户没明确开始角色工作流且 viewer-server 没开 → 不要主动推角色话题
