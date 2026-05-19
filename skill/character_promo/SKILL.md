---
name: character-promo
description: 角色美宣图生成。基于已有角色立绘（`characters/<id>/spec.md` + `portrait/`）或画师上传的源图，让美宣 prompt 专家引导画师补齐场景/情绪/构图/色调/张力，调 Lovart 出图到 `characters/<id>/promo/`。**主动触发**当用户说"做张美宣"、"出张宣传图"、"出 KV"、`/character-promo <id>` 或 `/character-promo --upload <path>`。**默认 n=1**；画师说"多出几张"才改。**禁止**跳过对话直接出图 —— 美宣的张力靠"先问清"。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
version: 1.0.0
---

# Character Promo

## 哲学锚

1. **复用立绘的视觉锚点** —— 不重新定义角色，只在已有 spec 基础上加美宣场景/张力
2. **场景驱动 prompt** —— 美宣 ≠ 立绘 + 背景，美宣是"角色在做什么、情绪如何、镜头如何调度"
3. **文件系统是 source of truth** —— `characters/<id>/promo/*.png` 是产物，`source/` 收画师上传的参考图
4. **出图前必经确认** —— PENDING_CONFIRM 出图卡片 → 画师 OK → 才调 Lovart

## Turn 起始（每次 turn 必做）

```bash
uv run python -m skill.character_workflow turn-start --kind promo
```

返回 JSON 同 character-workflow 主 Skill，但 `lessons` 加载 `references/lessons/promo.md`。注意 character_promo **复用** character_workflow 的 lib —— 没有自己的 turn-start CLI。

## 关键协议

### 美宣 prompt 五维度（专家引导）

| 维度 | 高优先级问题 |
|---|---|
| 场景 / 时空 | 战斗瞬间 / 仪式 / 静谧凝视？地点是？时辰是？ |
| 情绪 / 张力 | 沉静 / 怒视 / 颓然 / 凯旋？画面节奏快还是慢？ |
| 构图 / 镜头 | 仰角 / 平视 / 俯视？满构图还是大留白？焦点在脸 / 手 / 道具？ |
| 色调 / 光线 | 暖光逆光 / 冷调侧光 / 黑底高对比？整体饱和度高低？ |
| 张力锚点 | 一句话刻画看一眼就忘不掉的视觉记忆点（飘起的发丝、滴血的剑尖、回望的瞬间）。 |

提问节奏与 `character-workflow` 一致 —— 一次问 1-3 个、二选一优先、画师明确放话"你定" 就定并解释。

### 美宣 prompt 模板（中文 7 段式）

```
<角色主体（沿用 spec 视觉锚点）>，<职业/气质>。
<场景与时空>：<地点>，<时辰>，<天气/氛围>。
<情绪 + 动作>：<一句话刻画"她在做什么"+ 表情>。
<构图与镜头>：<视角>，<焦点>，<留白策略>。
<光线与色调>：<光源方向>，<主色 / 辅色>，<对比度>。
<风格与笔触>：<沿用 spec 风格档>，<参考画派/IP>，<细节密度>。
<画面规格>：<比例（建议 16:9 横版 KV / 4:5 竖版 KV）>，<分辨率>，<构图重心>。
```

不写 "高质量、影视级" 等口水词；用"侧逆光打出衣摆轮廓、背景虚化只见远山轮廓"这种具象描述。

### 调 Lovart 出图

**永远先确认再调用。** 流程：

1. `jobs.write_job(..., kind=JobKind.PROMO, source_image=<上传图绝对路径或 None>)` 落盘 `PENDING_CONFIRM`
2. 终端打可读出图卡片（模型 / 厂家 / 尺寸 / n=1 / 源图 / 中文 prompt 全列）
3. 等画师明确"出图/确认/OK"，或 Web 点确认
4. `lib.lovart_caller.submit_and_wait(..., output_dir=jobs.job_output_dir(id, JobKind.PROMO))` —— 自动落到 `characters/<id>/promo/`
5. 成功 `update_job_status(DONE, output_paths=[...])` / 失败 `FAILED`
6. 终端 `![v1](绝对路径)` 渲染 —— **默认 n=1**

**详细的 lovart 调用约定** 沿用 character_workflow 的 `references/lovart-call.md`，本 Skill 不重复。

## 上传图通道（画师从立绘外取材）

当画师粘一张参考图（手绘草图、外站资源截图）：
- 把图写到 `characters/<id>/source/<unix-timestamp>-<原文件名>`
- `source_image` 字段填该绝对路径
- 出图 prompt 里在"角色主体"段补一句"参考源图风格 / 姿态"

具体上传 API 走 `POST /api/uploads`（在路径 A 第 6 步落地，本轮未实现 —— 画师手动拷贝到 source/ 也行）。

## Turn 收尾：经验沉淀（lessons）

满足任一时触发（同 character-workflow）：
- job → DONE
- job → FAILED 且 error 是结构化原因

Skill 主动问：

> "本轮要不要沉淀一条经验到 `lessons/promo.md`？"

画师答 Y → 调：

```bash
uv run python -m skill.character_workflow append-lesson --kind promo --line "- 2026-05-19 <id> · <一句话> · prompt 片段：\`...\`"
```

## 何时跳过本 Skill

- 用户问的是 git / 代码 / 部署 / 纯问答
- 画师还没出过立绘（`characters/<id>/portrait/` 空 → 让他先 `/character-workflow`）
- 用户明确说"先做角色 spec" → 转回 character-workflow

## 复用清单

- ✅ 完全复用：`skill.character_workflow.lib.{context_loader,prompt_builder,lovart_caller,jobs,active_character,draft_processor,lessons}`
- ✅ 完全复用：`worldview.md`、`references/lovart-call.md`、`references/spec-protocol.md`（spec 不许有占位的规则在 promo 也成立）
- ✅ 共享 lessons 目录但分卷：`references/lessons/promo.md`
- 🆕 本 Skill 独有：`SKILL.md`、`references/personas/promo-expert.md`
