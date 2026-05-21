---
name: character-workflow
version: 4.1.1
description: |
  游戏角色资产工作流。承接画师在 Web UI 上的反馈，通过对话逐项问清
  风格/配色/镜头/道具，然后调 Lovart 出中文 prompt 图。
  当用户说"做个角色"、"出张立绘"、"继续角色工作流"或调用
  /character-workflow 时主动使用。spec 里不出现占位词，
  所有缺失信息都通过对话补全，不猜测不假设。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
triggers:
  - /character-workflow
  - 开始角色工作流
  - 做个角色
  - 出张角色立绘
  - 加个新角色
  - 继续角色工作流
  - 角色立绘
---

# Character Workflow

## 哲学锚

1. **文件系统是唯一 source of truth** —— `characters/<id>/spec.md`、`.runtime/draft/*.md`、`.runtime/jobs/*.json`
2. **画师的每个动作终态都是文件** —— Web UI 写文件，Skill 读文件
3. **对话决策、文档归档** —— spec 里不出占位词，缺什么就问什么
4. **中文 prompt 优先** —— 画师的链路全程中文

## Turn 起始（每次 turn 必做 —— 决策走 `recommend_action`）

每轮开头先调一次 CLI，把画师本轮最近一条消息原文（含 `/character-workflow X` 命令前缀）整段塞进 `--message`：

```bash
uv run python -m skill.character_workflow turn-start --message "<画师本轮原文>"
# 出图 promo/turnaround 时显式加 --kind 切换对应 lessons
```

`--message` 要带上，CLI 靠它推断 `recommend_action` 决策。返回 JSON 关键字段：

```json
{
  "stage":            "A" | "B" | "C" | "D",
  "stage_reason":     "...",
  "recommend_action": "ask" | "render_card" | "switch" | "noop",
  "recommend_reason": "...",
  "active_age_minutes": 1234,
  "intent":           "new" | "revise" | "create" | "switch" | null,
  "intent_signal":    "...",
  "intent_conflict":  false,
  "recent_chars":     [{"id": "holy", "tagline": "治愈系祭祀"}],
  "drafts":           [...],
  "active_id":        "holy",
  "spec":             "<markdown>" | null,
  "worldview":        "...",
  "lessons":          "...",
  "lessons_kind":     "portrait"
}
```

**只看 `recommend_action`，按它分叉**（`intent` 字段保留 debug 用，不再用于决策）：

| recommend_action | Skill 行为 |
|---|---|
| `ask` | 用 AskUserQuestion 让画师选 —— 具体问什么按 `stage` 分（A/B/C 走前置补全，D 走 4 选项） |
| `render_card` | 终端现编 PENDING_CONFIRM 卡片 → `submit` CLI 落盘 → 等画师明示"出图/确认/OK" |
| `switch` | `set-active <target>` + **重新调** turn-start |
| `noop` | 退出 turn，不动 file system（预留，目前不会出现）|

CLI 已经把"该 ask 还是该 render_card"算好了，Skill 端不必重复判断。判定不明确时 CLI 一律给 `ask`：宁可多问，"误问"成本只是画师多打一个数字，"误出图"成本是空跑 job + 占位卡片。

把 `worldview` + `lessons` + `spec` 拼成对话前缀（建议走 `lib.prompt_builder.assemble_character_prompt`），它们就是这一轮的专家上下文。

### action = ask：按 `stage` 分叉问什么

#### Stage A —— `characters/` 目录不存在

**用 1 个 AskUserQuestion 同时问 3 题**：

1. **项目名**（默认 git basename，画师可改）
2. **一句话世界观**（10-30 字）
3. **第一个角色名 + 一句话定位**

画师答完后落盘 `worldview.md` / `.runtime/projects.json` / `characters/<id>/spec.md` / `.runtime/active-character.json`。完成后直接进 render_card 流程 —— 不重新 turn-start。

#### Stage B —— 有项目但 `characters/` 为空

问 1 题：第一个角色名 + 一句话定位（≤20 字）。落盘 spec.md + active-character.json。

#### Stage C —— `active-character.json` 缺失/失效

列 N+2 选项（用 `recent_chars` 的 `id` + `tagline` 拼"id（tagline）"显示）：
- 已有角色 1（tagline 1）
- 已有角色 2（tagline 2）
- ...
- 新建一个角色 → 走 stage B 流程
- 跳过本轮 → 退出 turn

#### Stage D —— 4 选项

画师没给明确信号时（裸触发、冷启动、上一轮已闭环），列 4 选项：
1. **按现 spec 出图** → 走 render_card 流程
2. **改 spec** → 进 spec 补全对话
3. **新建另一个角色** → 走 stage B 流程
4. **跳过本轮** → 退出 turn

### action = render_card

按下面"调 Lovart 出图"节流程：写 prompt → submit CLI → 卡片 → 等画师明示 → run-job → DONE 贴图。

### action = switch

`uv run python -m skill.character_workflow set-active <target>`，然后必须重新调一次 turn-start（新 active 才能反映到 spec / drafts / recent_chars）。

## Painter Intent 推断（debug 用，决策看 `recommend_action`）

CLI 仍输出 `intent` / `intent_signal` / `intent_conflict` 字段，但实际决策一律走 `recommend_action`。intent 是底层信号，留给 debug 和向后兼容。

`compute_recommend_action()` 的决策表（在 `lib/intent.py`）：
1. stage A/B/C → ask
2. stage D + switch 信号（target ≠ active） → switch
3. stage D + drafts 非空 → render_card
4. stage D + 含"新建/新角色/另一个角色" → ask（走 stage B 流程）
5. stage D + 含出图动词（出图/出一张/再出/v1-v4/...，词表在 `_RENDER_VERBS_LITERAL`） → render_card
6. stage D + default + active_age > 30 min → ask（冷启动）
7. stage D + default + last job ∈ {DONE, FAILED} → ask（已闭环）
8. 其他 → ask（兜底）

加新动词只改 `lib/intent.py` 一处，不要在 SKILL.md 自己做关键词匹配。

## Related Discovery（stage C / D 列角色用）

`recent_chars` 数组提供 `id` + `tagline`：tagline 从 `characters/<id>/spec.md` 首行非空、非标题 markdown 内容截取，≤30 字。stage C 列选项时直接用这两个字段拼"角色 id（tagline）"显示，让画师快速分辨。

## 切换处理对象

```bash
uv run python -m skill.character_workflow set-active <character-id>
```

stage D 推断到 `switch` 时 Skill 自动调一次，然后必须重新 turn-start（新 active 才能反映到 spec / drafts / recent_chars）。

## 关键协议

### 新建角色 / 补全 spec

对话逐项问清：风格档 → 配色 → 镜头 → 视觉锚点。一次问 1–3 个，二选一优先。问清才动笔。

**完整协议（含反例）** → `references/spec-protocol.md`

### 写出图 prompt

写 prompt 前先读共享底层规则（spec 锚点协议 / generation_mode / 禁止项 / 输出格式），再按立绘专项规则写。

**共享底层** → `references/art-prompt-system.md`
**立绘专项** → `references/prompt-zh.md`

### 修改已出图（三模式协议）

**触发条件**：画师指着现有图（`portrait/v1.png` 等）说"换 X / 加 Y / 改 Z"的修改需求时，**必须先用 AskUserQuestion 问**选哪种模式，不得自行假设：

| 模式 | 做法 | 适用场景 |
|---|---|---|
| **A 编辑当前图** | 上传当前图作参考图；prompt **只写改动指令**，不重写人物外观/服装/姿势的完整设定 | 只改局部，对整体满意 |
| **B 完全重出** | **不带参考图**；重新走 spec 补全对话，写完整新 prompt | 整张图都不满意，从零开始 |
| **C 局部参考混合** | 带参考图锚定满意部分；prompt 完整重写，但**明确标注**哪部分以参考图为准、哪部分重画 | 人脸/配色满意，但服装/姿势要大改 |

三种模式互斥，**绝不混用**（带参考图 + 整张重写 prompt = 模型不知锚哪边，输出不稳定）。

A 模式时 spec 只更新被改的字段；B 模式可大改 spec；C 模式改受影响段并注明"参考图锁定哪部分"。

首次出图、用户主动说"重画"等场景不适用此规则。

### 调 Lovart 出图

先落盘 PENDING_CONFIRM 再调 Lovart，画师可以预览完整 prompt 并随时取消，避免空跑 job。流程：

1. 用 `submit` CLI 落盘 `PENDING_CONFIRM`（默认值集中在 CLI 里管理，不要直接调 `jobs.write_job`）：

   ```bash
   cat > /tmp/cw-prompt-$$.md <<'PROMPT'
   ...中文 8 段式 prompt...
   PROMPT
   JOB_ID=$(uv run python -m skill.character_workflow submit \
     --kind portrait --prompt-file /tmp/cw-prompt-$$.md)
   rm /tmp/cw-prompt-$$.md
   ```

   `--character` 缺省读 `.runtime/active-character.json`；`--n` 默认 1（画师明示对比才传 `--n 4`）；`--source-image <绝对路径>` 给 promo/turnaround 用；stdout 是纯 job_id。
2. 终端打可读出图卡片（模型/厂家/尺寸/n/参考图/完整中文 prompt 全列）

   **硬规则：确认卡必须直接贴出“本次将要提交给模型的完整 prompt 原文”。**
   不许只写 prompt 文件路径、不许摘要、不许用 `...` 省略、不许说“同 spec”。
   画师必须能在确认前完整审读即将出图的 prompt。
3. 等画师明确说"出图/确认/OK"后，调用 runner：

   ```bash
   uv run python -m skill.character_workflow run-job "$JOB_ID"
   ```

   用户只说"出图"且没有指定 job 时，调用：

   ```bash
   uv run python -m skill.character_workflow run-latest --kind portrait
   ```

4. runner 负责推进 `PENDING_CONFIRM -> PENDING -> DONE/FAILED`、上传参考图、清空旧 error、筛掉无效 artifact，并把正式产物写到 `characters/<id>/<kind>/vN.png`。
5. 在终端用 `![v1](绝对路径)` markdown 把每张图打出来（CC 终端直接渲染）。默认 n=1，画师明示"多出几张/对比" 才提到 n=4。

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

画师明确授权 Skill 自行判断（例如"你自行判断哪些需要沉淀"、"我在测试 Skill 工作模式"）→ 不再追问，直接选 1–2 条能防止下次失败或提升出图质量的可复用经验追加。只沉淀规则，不写流水账。

格式：`- YYYY-MM-DD <id> · <一句话> · prompt 片段：\`...\``。同 turn 多次出图每次都问；画师一次性说"全部不追加"则后续跳过。画师 cancel / 网络抖动 FAILED 不问。

## viewer-server 启停

每次调用本 Skill 时，Turn 起始之前先执行：

```bash
uv run python skill/viewer_server/server.py start
uv run python skill/viewer_server/server.py open-browser
```

server 自动检测 PID，已在运行则跳过重启；open-browser 每次都会弹出窗口。详见 `skill/viewer_server/SKILL.md`。

## 何时跳过本 Skill

- 用户消息明显是 git / 代码 / 部署 / 纯问答 → 完全跳过 turn-start
- 用户没明确开始角色工作流且 viewer-server 没开 → 不要主动推角色话题
- `recommend_action == "ask"` 时画师选"跳过本轮" → 退出 turn，不动 file system
