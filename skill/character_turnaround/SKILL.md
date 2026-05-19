---
name: character-turnaround
description: 角色三视图生成。基于已有角色立绘（`characters/<id>/spec.md` + `portrait/`）或画师上传的源图，让三视图 prompt 专家引导画师锁死正/侧/背三面比例、表情包、武器拆解，调 Lovart 一次性出**一张横幅三联视图**到 `characters/<id>/turnaround/`。**主动触发**当用户说"做三视图"、"出张角色三面"、"出 character sheet"、`/character-turnaround <id>` 或 `/character-turnaround --upload <path>`。**默认 n=1**；三视图本身就是横幅图，几乎不需要多版本对比。**禁止**跳过对话直接出图 —— 三视图的可用性靠"先量好比例"。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
version: 1.0.0
---

# Character Turnaround

## 哲学锚

1. **三视图是工程图，不是美宣** —— 三面比例尺、武器朝向、配饰位置必须能落到建模/动画/卡牌的下游工序，"漂亮"不是首要目标
2. **沿用立绘锚点，不重定义角色** —— 配色 / 服装 / 头饰必须与 `spec.md` 完全一致，三视图只补充"另外两面长什么样"
3. **一张横幅图出齐三面** —— Lovart 一次调用出 1536×1024 横版，正面 / 侧面 / 背面横向排列；不拼合不多次调用
4. **文件系统是 source of truth** —— `characters/<id>/turnaround/*.png` 是产物
5. **出图前必经确认** —— PENDING_CONFIRM 出图卡片 → 画师 OK → 才调 Lovart

## Turn 起始（每次 turn 必做）

```bash
uv run python -m skill.character_workflow turn-start --kind turnaround
```

返回 JSON 同 character-workflow 主 Skill，但 `lessons` 加载 `references/lessons/turnaround.md`。character_turnaround **复用** character_workflow 的 lib —— 没有自己的 turn-start CLI。

## 关键协议

### 三视图 prompt 四维度（专家引导）

| 维度 | 高优先级问题 |
|---|---|
| 视图组合 | 标准三视图（正/侧/背）？要不要加 3/4 侧、表情包、动作小图？ |
| 比例尺 | 三面身高一致？头身比？武器/披风长度一致？参考"角色设定集"标尺线？ |
| 道具拆解 | 武器是单独拆视图还是挂在腰间？头饰要不要独立特写？ |
| 画面规格 | 默认 1536×1024 横版三联；要不要加灰底等高线 / 简单网格辅助？ |

提问节奏与 character-workflow / character-promo 一致 —— 一次问 1-3 个，二选一优先，画师明示"你定" 就定并解释。

### 三视图 prompt 模板（中文 5 段式）

```
<角色主体（严格沿用 spec：发色 / 瞳色 / 服装 / 武器）>，<职业/气质>，<头身比>。
<视图组合>：正面 / 侧面 / 背面 横向排列，三面身高比例一致，<是否包含 3/4 视角 / 表情包 / 道具特写>。
<服装与道具的多面呈现>：<背面披风/绑带细节>，<侧面武器佩戴位置>，<头饰从各面看的形状>。
<画面规格>：横幅 1536×1024，灰底 / 浅色网格，三面均匀分布，留白做标尺线。
<风格与笔触>：<沿用 spec 风格档>，线稿清晰 / 平涂上色 / 半厚涂任选其一，避免环境光干扰识别。
```

不写 "影视级 / 8K / masterpiece" —— 三视图重在"信息密度高、各面对得上"，不在画面氛围。

### 调 Lovart 出图

**永远先确认再调用。** 流程：

1. `jobs.write_job(..., kind=JobKind.TURNAROUND, source_image=<上传图绝对路径或 None>)` 落盘 `PENDING_CONFIRM`
2. 终端打可读出图卡片（模型 / 厂家 / 尺寸 `1536x1024` / n=1 / 源图 / 中文 prompt 全列）
3. 等画师明确"出图/确认/OK"，或 Web 点确认
4. `lib.lovart_caller.submit_and_wait(..., output_dir=jobs.job_output_dir(id, JobKind.TURNAROUND))` —— 自动落到 `characters/<id>/turnaround/`
5. 成功 `update_job_status(DONE, output_paths=[...])` / 失败 `FAILED`
6. 终端 `![v1](绝对路径)` 渲染 —— **默认 n=1**

**详细的 lovart 调用约定** 沿用 character_workflow 的 `references/lovart-call.md`，本 Skill 不重复。

## 上传图通道（画师从立绘外取材）

当画师粘一张参考图（手绘草图、外站三视图截图）：
- 把图写到 `characters/<id>/source/<unix-timestamp>-<原文件名>`
- `source_image` 字段填该绝对路径
- 出图 prompt 里在"视图组合"段补一句"参考源图的视图布局 / 比例"

具体上传 API 走 `POST /api/uploads`（已在路径 A 第 6 步落地）。

## Turn 收尾：经验沉淀（lessons）

满足任一时触发（同 character-workflow / character-promo）：
- job → DONE
- job → FAILED 且 error 是结构化原因

Skill 主动问：

> "本轮要不要沉淀一条经验到 `lessons/turnaround.md`？"

画师答 Y → 调：

```bash
uv run python -m skill.character_workflow append-lesson --kind turnaround --line "- 2026-05-19 <id> · <一句话> · prompt 片段：\`...\`"
```

## 何时跳过本 Skill

- 用户问的是 git / 代码 / 部署 / 纯问答
- 画师还没出过立绘（`characters/<id>/portrait/` 空 → 让他先 `/character-workflow`）
- 用户明确说"先做美宣" → 转去 character_promo

## 复用清单

- ✅ 完全复用：`skill.character_workflow.lib.{context_loader,prompt_builder,lovart_caller,jobs,active_character,draft_processor,lessons}`
- ✅ 完全复用：`worldview.md`、`references/lovart-call.md`、`references/spec-protocol.md`
- ✅ 共享 lessons 目录但分卷：`references/lessons/turnaround.md`
- 🆕 本 Skill 独有：`SKILL.md`、`references/personas/turnaround-expert.md`、`references/prompt-turnaround-zh.md`
