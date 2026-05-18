---
name: character-workflow
description: 游戏角色资产工作流。承接画师在 Web UI 上的反馈、改 prompt、改 spec，对话驱动逐项问清风格/配色/镜头/道具后调 Lovart 中文 prompt 出图。**主动触发**当用户说"开始角色工作流"、"做个角色"、"出张角色立绘"、"加个新角色"、`/character-workflow <名>`，或 Web 端 viewer-server 已开着且用户粘"继续"。**禁止**生成带 `?`/"待补充"/"留空" 占位的 spec 文档 —— 决策永远走对话。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
version: 2.0.0
---

# Character Workflow

## 哲学锚（任何场景下都不许违反）

1. **文件系统是唯一 source of truth** —— `characters/<id>.md`、`.runtime/draft/*.md`、`.runtime/jobs/*.json`
2. **画师的每个动作终态都是文件** —— Web UI 写文件，Skill 读文件
3. **对话决策、文档归档** —— 永远不出"待补充"占位让画师补全
4. **中文 prompt 优先** —— 画师的链路全程中文

## Turn 起始三步（每次 turn 必做）

```
1. draft_processor.process_drafts()  → 读 .runtime/draft/ 拿画师反馈
2. active_character.read_active()    → 同步当前处理的角色 id
3. read characters/<active_id>.md    → 拿最新 spec
```

**详细步骤** → `references/turn-flow.md`

## 关键协议

### 新建角色 / 补全 spec

不要凭模板生成 `?` 占位文档。改为对话逐项问清：风格档 → 配色 → 镜头 → 视觉锚点。一次问 1–3 个，二选一优先。

**完整协议（含反例）** → `references/spec-protocol.md`

### 写出图 prompt

只在已确定要点齐了之后写。中文模板，按 "主体 → 服装 → 头部 → 道具 → 姿势 → 场景 → 风格 → 规格" 8 段式。

**模板和示例** → `references/prompt-zh.md`

### 调 Lovart 出图

**永远先确认再调用。** `jobs.write_job_pending_confirm` 把"出图卡片"（模型/厂家/尺寸/n/参考图/中文 prompt）落盘 → 在终端把卡片完整打给画师 → 等画师明确说"出图/确认"或 Web 端点确认（推到 PENDING）→ 再调 `/Users/zhengzhongbiao/.claude/skills/lovart-api/` → 更新状态 → **在终端用 `![v1](绝对路径)` markdown 把每张图打出来**（让 CC 终端直接渲染图）。一次 4 张做对比。

**完整调用流程** → `references/lovart-call.md`

## viewer-server 启停

画师 `/character-workflow <角色>` 第一次触发时：

```bash
python skill/viewer-server/server.py start
python skill/viewer-server/server.py open-browser
```

server 启动时会自动清理 stale PID。详见 `skill/viewer_server/SKILL.md`。

## 何时跳过本 Skill

- 用户问的是 git / 代码 / 部署 / 纯问答 → 跳过 turn 起始三步
- 用户没明确开始角色工作流且 viewer-server 没开 → 不要主动推角色话题
