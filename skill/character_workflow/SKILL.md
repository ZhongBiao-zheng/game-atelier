---
name: character-workflow
description: 游戏角色资产工作流。承接画师在 Web UI 上的反馈、改 prompt、改 spec，对话驱动逐项问清风格/配色/镜头/道具后调 Lovart 中文 prompt 出图。**主动触发**当用户说"开始角色工作流"、"做个角色"、"出张角色立绘"、"加个新角色"、`/character-workflow <名>`，或 Web 端 viewer-server 已开着且用户粘"继续"。**禁止**生成带 `?`/"待补充"/"留空" 占位的 spec 文档 —— 决策永远走对话。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
version: 4.0.0
---

# Character Workflow

## 哲学锚（任何场景下都不许违反）

1. **文件系统是唯一 source of truth** —— `characters/<id>/spec.md`、`.runtime/draft/*.md`、`.runtime/jobs/*.json`
2. **画师的每个动作终态都是文件** —— Web UI 写文件，Skill 读文件
3. **对话决策、文档归档** —— 永远不出"待补充"占位让画师补全
4. **中文 prompt 优先** —— 画师的链路全程中文

## Turn 起始（每次 turn 必做 —— 4 stage 分支）

每轮开头先调一次 CLI，把画师本轮最近一条消息原文（含 `/character-workflow X` 命令前缀）整段塞进 `--message`：

```bash
uv run python -m skill.character_workflow turn-start --message "<画师本轮原文>"
# 出图 promo/turnaround 时显式加 --kind 切换对应 lessons
```

`--message` 必传 —— intent 推断靠它。返回 JSON：

```json
{
  "stage":           "A" | "B" | "C" | "D",
  "stage_reason":    "characters/ 目录不存在",
  "intent":          "new" | "revise" | "create" | "switch" | null,
  "intent_signal":   "drafts_present" | "new_keyword" | "switch_keyword" | "default" | "conflict" | "none",
  "intent_conflict": false,
  "recent_chars":    [{"id": "holy", "tagline": "治愈系祭祀，金白配色"}],
  "drafts":          [...],
  "active_id":       "holy",
  "active_updated_at": "2026-05-19T08:00:00+00:00",
  "spec":            "<markdown>" | null,
  "worldview":       "<markdown>",
  "lessons":         "<markdown>",
  "lessons_kind":    "portrait"
}
```

按 `stage` 字段分叉，**不要自己重新探测 file system**：

### Stage A —— `characters/` 目录不存在

**用 1 个 AskUserQuestion 同时问 3 题**（AskUserQuestion 支持 1-4 题 per call）：

1. **项目名**（默认 git basename，画师可改）
2. **一句话世界观**（10-30 字，影响后续 prompt 质量）
3. **第一个角色名 + 一句话定位**（如 `圣灵祭祀 / 治愈系女性祭祀，金白配色`）

画师答完后落盘：
- `worldview.md`（画师输入的世界观）
- `.runtime/projects.json` `{"projects":[{"id":"<proj-id>","name":"<项目名>","created_at":"..."}],"assignments":{"<char-id>":"<proj-id>"}}`
- `characters/<char-id>/spec.md`（spec 模板，定位字段填画师输入）
- `.runtime/active-character.json` `{"active_id":"<char-id>","updated_at":"..."}`

完成后直接进入 stage D 出图对话 —— **不重新调 turn-start**，沿用已有 worldview / 新建的 spec 继续做。

### Stage B —— 有项目但 `characters/` 为空

**用 1 个 AskUserQuestion 问 1 题：**
> 项目里还没有角色。第一个角色名 + 一句话定位（≤20 字）。
> 示例：`圣灵祭祀 / 治愈系女性祭祀，金白配色`

落盘：
- `characters/<char-id>/spec.md`（spec 模板）
- `.runtime/active-character.json`

完成后进 stage D。

### Stage C —— `active-character.json` 缺失或失效

**用 AskUserQuestion 列 N+2 选项**（参考 `recent_chars` 的 `id` 和 `tagline`）：

- 已有角色 1（tagline 1）
- 已有角色 2（tagline 2）
- ...
- 新建一个角色
- 跳过本轮（不出图）

画师选已有 → 写 `.runtime/active-character.json` → 进 stage D。
画师选新建 → 走 stage B 流程。
画师选跳过 → 退出 turn，不动 file system。

### Stage D —— 正常回流（默认不打扰）

按 `intent` 字段分叉，**不要问画师**（除非 `intent_conflict: true`）：

| intent | 行为 |
|---|---|
| `new` | 默认。走出图 8 段式 prompt → PENDING_CONFIRM 卡片 |
| `revise` | drafts 非空。先读 drafts 内容，融进 prompt 修订，再 PENDING_CONFIRM |
| `create` | 消息含"新建"关键词。即时转 stage B 流程问"新角色名 + 定位" |
| `switch` | 消息含 `/character-workflow Y` 且 Y ≠ active。写 `active-character.json={"active_id":"Y"}` 后**重新调一次** turn-start |
| `null` + `intent_conflict: true` | 信号冲突（如 drafts 非空 + 消息有"新建"）。用 AskUserQuestion 让画师二选一：A "继续改当前角色的图" / B "新建另一个角色" |

把 `worldview` + `lessons` + `spec` 拼成对话前缀（建议走 `lib.prompt_builder.assemble_character_prompt`），它们就是这一轮的专家上下文。

## Painter Intent 推断（仅 stage D —— CLI 已算好，Skill 直接读）

CLI 端 `infer_intent()` 已在 turn-start 时算好结果。Skill 端读 `intent` 和 `intent_conflict` 字段即可，**不要自己重写推断逻辑**。规则（参考）：

1. `drafts` 非空 → `revise`，signal=`drafts_present`
2. message 含"新建 / 新角色 / 另一个角色" → `create`，signal=`new_keyword`
3. message 含 `/character-workflow <name>` 且 name ≠ active_id → `switch`，signal=`switch_keyword`
4. 都不匹配 → `new`，signal=`default`
5. 多信号同时命中 → `intent=null`, `intent_conflict=true`

## Related Discovery（stage C / D 列角色用）

`recent_chars` 数组提供 `id` + `tagline`：tagline 从 `characters/<id>/spec.md` 首行非空、非标题 markdown 内容截取，≤30 字。stage C 列选项时直接用这两个字段拼"角色 id（tagline）"显示，让画师快速分辨。

## 切换处理对象

```bash
uv run python -m skill.character_workflow set-active <character-id>
```

stage D 推断到 `switch` 时 Skill 自动调一次，**然后必须重新 turn-start**（新 active 才能反映到 spec / drafts / recent_chars）。

## 关键协议

### 新建角色 / 补全 spec

对话逐项问清：风格档 → 配色 → 镜头 → 视觉锚点。一次问 1–3 个，二选一优先。问清才动笔。

**完整协议（含反例）** → `references/spec-protocol.md`

### 写出图 prompt

中文 8 段式："主体 → 服装 → 头部 → 道具 → 姿势 → 场景 → 风格 → 规格"。

**模板** → `references/prompt-zh.md`

### 调 Lovart 出图

**永远先确认再调用。** 流程：

1. 用 `submit` CLI 落盘 `PENDING_CONFIRM`（默认值集中点，**禁止自己导 jobs.write_job**）：

   ```bash
   cat > /tmp/cw-prompt-$$.md <<'PROMPT'
   ...中文 8 段式 prompt...
   PROMPT
   JOB_ID=$(uv run python -m skill.character_workflow submit \
     --kind portrait --prompt-file /tmp/cw-prompt-$$.md)
   rm /tmp/cw-prompt-$$.md
   ```

   `--character` 缺省读 `.runtime/active-character.json`；`--n` 默认 1（画师明示对比才传 `--n 4`）；`--source-image <绝对路径>` 给 promo/turnaround 用；stdout 是纯 job_id。
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

- 用户消息明显是 git / 代码 / 部署 / 纯问答 → 完全跳过 turn-start
- 用户没明确开始角色工作流且 viewer-server 没开 → 不要主动推角色话题
- Stage A/B/C 时画师选"跳过本轮" → 退出 turn，不动 file system
- v3 的兜底逻辑"没有 active_id 且没有 draft → 问'哪个角色？'"已被 4 stage 协议替代，**不再适用**
