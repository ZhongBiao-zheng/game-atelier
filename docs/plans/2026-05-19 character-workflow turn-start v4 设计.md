# Character Workflow `turn-start` v4.0.0 设计

**生成于** 2026-05-19 via `/superpowers:brainstorming`
**Status** DRAFT
**Supersedes** SKILL.md v3.0.0（仅 turn-start 章节）
**Branch** main
**Repo** game-ui-ai-workflow

---

## 1. 问题陈述

当前 `character_workflow` Skill 的 `turn-start` 协议（v3.0.0）存在 4 个结构性缺陷：

1. **返回"数据"不返回"branch state"**：CLI 一次性返回 5 字段（drafts/active_id/spec/worldview/lessons），Skill 自己判断走哪条路，但 SKILL.md 没明说怎么判断。
2. **冷启动盲区**：`characters/` 不存在 / worldview.md 不存在 / 第一个角色都没有时，turn-start 该返回什么、Skill 该问什么都没定义。
3. **active_id 缺失的兜底逻辑薄**：SKILL.md 写"没有 active_id 且没有 draft → 问'想处理哪个角色？'"，但如果 `characters/` 是空的呢？画师无法回答这个问题。
4. **没有"本轮意图"根问题**：默认假设画师"知道自己要干嘛"。当 active 是 X 但画师其实想画 Y 时，会用错 active 默默画错。

这些缺陷集中表现在"第一次启动 Skill"和"切换角色"两个场景上——也是画师最容易卡住、感受最差的两个场景。

## 2. 设计哲学锚

本设计参考 `~/.claude/skills/gstack/office-hours` 的 5 条设计哲学，并根据画师工作流的特性做了调整：

| office-hours 哲学 | 本设计的应用 | 差异 |
|---|---|---|
| **一个根问题分叉整个 flow**（"What's your goal?"） | turn-start 用 file system stage + painter intent 两层分叉 | 拆成两层：机器能判的不问画师，只在边界问 |
| **强人设 + 反 sycophancy** | （延后到下一轮）`personas/character-helper.md` | 本轮先重做入口，人设留给下一个 Skill 重构周期 |
| **One question at a time + smart-skip + escape hatch** | Stage D 默认不问 intent（智能预测），冲突才弹 | 直接套用 |
| **Mandatory alternatives**（强制 2-3 方案） | （延后到下一轮）出图前给 3 个 prompt 备选 | 本轮先解决入口 |
| **Related Discovery**（grep 已有 design）| Stage C/D 返回 `recent_chars` 让 Skill 主动提示 | 直接套用 |

**核心权衡**：office-hours 是"思考产品"的工具，painter 工作是"执行创作"。所以"问"被压缩到 stage A/B/C 边界条件 + stage D 的 intent 冲突场景；正常回流（stage D 默认）根本不该被打断。

## 3. 总体架构：两层分叉

```
                    file system probe
                            │
                            ▼
         ┌──────────────┬──────────────┬──────────────┬──────────────┐
       Stage A        Stage B        Stage C        Stage D
   (characters/      (空)         (active 缺失)    (active OK)
    不存在)              │              │              │
         │              │              │              ▼
         ▼              ▼              ▼      智能预测 painter intent
   问 3 件套         问 1 件        AskUserQ      ┌─────┬─────┬─────┬─────┐
  项目名/世界观       角色名+        4 选 1      A出新图 B改图 C新建 D切换
  /首角色            一句话定位    + related     (默认)  (draft) (kw) (kw)
                                  discovery        │
                                                   ▼
                                          冲突才弹 AskUserQ
```

**第 1 层（File System Stage）**：CLI `turn-start` 启动时探测 file system，自动判定 stage（A/B/C/D），把判定结果作为 JSON 字段返回给 Skill。Skill 不再"猜"该走哪条路。

**第 2 层（Painter Intent）**：仅在 stage D 时启动。CLI 同时返回机器推断的 `intent`（出新图 / 改图 / 新建 / 切换），Skill 据此决定下一步对话；只在多个推断信号冲突时（如 drafts 非空 + 消息里有"新建"），才弹 AskUserQuestion 让画师选。

## 4. Stage 详细协议

### 4.1 Stage A — 全新项目

**触发条件**：`characters/` 目录不存在。

**Skill 行为**：用 AskUserQuestion 一次问 3 个 question（AskUserQuestion 支持 1-4 个 question per call）：

1. **项目名**（默认 git basename，如 `game-ui-ai-workflow`）
2. **一句话世界观**（10-30 字，影响后续 prompt 质量）
3. **第一个角色名 + 一句话定位**（如 `圣灵祭祀 / 治愈系女性祭祀，金白配色`）

**自动生成文件**（画师答完后）：

| 文件 | 内容 |
|---|---|
| `.runtime/` | 空目录（占位） |
| `characters/<id>/` | 首角色目录 |
| `characters/<id>/spec.md` | spec 模板，画师定位写进"一句话定位"字段 |
| `worldview.md` | 项目根，画师输入的"一句话世界观" |
| `.runtime/projects.json` | `{"name": "<项目名>", "active": "<id>"}` |
| `.runtime/active-character.json` | `{"id": "<id>"}` |

**完成后**：自动转 stage D 进入出图对话，无需画师再选。

**理由**：用户偏好（D4 选 C）——画师第一次启动就把基础打牢，宁可被 3 个问题拦截一次，也要让 worldview 有真实内容。这违反了 office-hours 的"smart-skip"原则，但符合用户对"基础先打牢"的偏好。

### 4.2 Stage B — 有项目但无角色

**触发条件**：`characters/` 目录存在但为空（无任何子目录）。

**Skill 行为**：用 AskUserQuestion 问 1 个 question：

> 项目里还没有角色。第一个角色名 + 一句话定位（≤20 字）。
> 示例：`圣灵祭祀 / 治愈系女性祭祀，金白配色`

**自动生成文件**：

| 文件 | 内容 |
|---|---|
| `characters/<id>/spec.md` | spec 模板，定位字段填画师输入 |
| `.runtime/active-character.json` | `{"id": "<id>"}` |

**完成后**：转 stage D。

### 4.3 Stage C — 有角色但 active 缺失或失效

**触发条件**：`.runtime/active-character.json` 缺失，或里面的 `id` 在 `characters/` 下找不到对应目录。

**Skill 行为**：用 AskUserQuestion 列出 N+2 选项：

- 已有角色 1（带 tagline，从 spec.md 头部摘 8-15 字）
- 已有角色 2（带 tagline）
- ...
- 新建一个角色
- 跳过本轮（不出图）

**Related discovery**：tagline 从 `characters/<id>/spec.md` 第一行非空 markdown 内容截取，让画师快速分辨。

**自动生成文件**：

- 选已有角色 → 写 `.runtime/active-character.json`，转 stage D。
- 选新建 → 转 stage B 流程。
- 选跳过 → 退出 turn，不动文件。

### 4.4 Stage D — 正常回流

**触发条件**：`.runtime/active-character.json` 存在 + 对应 `characters/<id>/spec.md` 存在。

**Skill 行为**：跳过机器判断，进入第 2 层 **Painter Intent 智能预测**。

**Painter Intent 推断规则**（CLI 端实现，结果作为 `intent` 字段返回）：

| 推断信号 | intent |
|---|---|
| `drafts` 非空（`.runtime/draft/<id>-*.md` 存在）| **B 改图**（根据画师反馈） |
| 画师消息里有"新建 / 新角色 / 另一个角色"等关键词 | **C 新建另一个角色** → Skill 应转 stage B 流程 |
| 画师消息里有 `/character-workflow <名>` 且 `<名> ≠ active_id` | **D 切换角色** → Skill 应转 stage C 流程并自动定位到 `<名>` |
| 都不匹配 | **A 给当前 active 出新图**（默认） |
| **多个信号冲突**（如 drafts 非空 + 消息里有"新建"）| `intent_conflict: true` → Skill 必须弹 AskUserQuestion 让画师选 |

**关键约束**：

- CLI 接收画师当前消息作为参数（如 `--message "新建一个角色叫光辉骑士"`），否则只能推断 drafts 信号。
- 推断错时画师只需 1 次回退（说"不对，我要改图"），成本可控。
- 这里的 4 条规则就是 office-hours "smart-skip" 哲学的直接应用——能机器答的就不问画师。

## 5. JSON Schema 变更

```jsonc
// v3.0.0 → v4.0.0
{
  // 新增字段
  "stage":           "A" | "B" | "C" | "D",
  "stage_reason":    "characters/ 目录不存在",       // 人类可读，给 Skill 看
  "intent":          "new" | "revise" | "create" | "switch" | null,
                                                    // null = 不在 stage D / 推断失败
  "intent_signal":   "drafts_present" | "new_keyword" | "switch_keyword" | "default",
                                                    // 用于 Skill 解释为什么推断成这个 intent
  "intent_conflict": false,                         // true 时 Skill 必须 AskUserQuestion
  "recent_chars": [                                 // 仅 stage C / D 时有值
    {"id": "holy-spirit-priestess", "tagline": "治愈系祭祀，金白配色"}
  ],

  // 沿用 v3.0.0
  "drafts":       [...],
  "active_id":    "holy-spirit-priestess" | null,
  "spec":         "<markdown>" | null,
  "worldview":    "<markdown>" | "_世界观待补_",
  "lessons":      "<markdown>",
  "lessons_kind": "portrait"
}
```

**`intent` 字段值的语义**：

| 值 | 含义 | Skill 下一步 |
|---|---|---|
| `new` | 给 active 出新图（默认） | 走出图对话 |
| `revise` | 根据 drafts 改 active 的图 | 读 drafts → 改 prompt → 再出图 |
| `create` | 新建另一个角色 | 转 stage B 流程 |
| `switch` | 切换到已有角色 | 转 stage C 流程，自动定位到目标角色 |
| `null` | 不在 stage D | Skill 走 stage A/B/C 流程 |

## 6. CLI 接口变更

```bash
# v3.0.0
uv run python -m skill.character_workflow turn-start [--kind portrait|promo|turnaround]

# v4.0.0
uv run python -m skill.character_workflow turn-start \
  [--kind portrait|promo|turnaround] \
  [--message "<画师当前消息>"]            # 新增，用于 intent 推断
```

`--message` 为可选；不传时 intent 只基于 drafts 推断。Skill 端建议在调 turn-start 时把画师最近一条消息原文传进去，最大化推断准确率。

## 7. SKILL.md 改造点

| 当前 v3.0.0 章节 | v4.0.0 改造 |
|---|---|
| `## Turn 起始（每次 turn 必做）` 只说 CLI 调用 + 返回 5 字段 | 改为 `## Turn 起始（4 stage 分支判断）`，显式说明每个 stage 该做什么、问什么 |
| 无 intent 概念 | 新增 `## Painter Intent 推断（仅 stage D）`，列出 4 条规则 + 冲突 fallback |
| `## 何时跳过本 Skill` 提"没有 active_id 且没有 draft → 问'哪个角色？'" | 改为"Stage A/B/C 各自的兜底问题，不再笼统问'哪个角色'" |
| 无 related discovery | 新增 `## Related Discovery`，说明 stage C 列角色时如何用 tagline 帮画师快速分辨 |

## 8. 验收标准

| # | 场景 | 验收 |
|---|---|---|
| 1 | **冷启动**：删 `characters/` 后启动 Skill | 走 stage A → 3 件套问完 → 文件全部建立 → 自动转 stage D 进出图对话 |
| 2 | **空项目**：保留 `characters/` 但删所有子目录 | 走 stage B → 问 1 件套 → 角色建立 → 转 stage D |
| 3 | **选角色**：保留 `characters/` 但删 `.runtime/active-character.json` | 走 stage C → 列已有角色 + tagline → 选完转 stage D |
| 4 | **正常回流**：一切就绪 | 走 stage D → 默认 intent = `new` → 不打扰画师 |
| 5 | **draft 推断**：drafts 非空 | stage D 默认 intent = `revise` |
| 6 | **新建推断**：消息里有"新建一个角色" | stage D intent = `create` → Skill 自动转 stage B 流程 |
| 7 | **switch 推断**：active 是 X，消息里 `/character-workflow Y` | stage D intent = `switch` → Skill 自动转 stage C 流程 |
| 8 | **冲突**：drafts 非空 + 消息里有"新建" | `intent_conflict: true` → Skill 必须 AskUserQuestion |
| 9 | **失效 active**：`active-character.json` 里 id 在 `characters/` 找不到 | 走 stage C（视为 active 缺失） |
| 10 | **损坏 spec**：`active-character.json` 指向的角色 `spec.md` 不存在 | 走 stage C（视为失效） |

## 9. NOT in Scope

| 推迟项 | 推迟到 | 理由 |
|---|---|---|
| Painter Profile（跨 session 累积偏好） | 未来 | office-hours 学习点 7。项目 painter 通常只有 1 人，价值低。需要先看到"画师习惯模式"才有数据驱动设计的依据 |
| Mandatory alternatives（出图前给 3 个 prompt 备选） | 下一个 Skill 重构周期 | office-hours 学习点 4。本轮先解决入口分叉 |
| Tier 系统（项目 tier 而非画师 tier） | 项目积累 50+ 张图后 | office-hours 学习点 6。当前项目还没到需要"老用户特殊路径"的阶段 |
| Phase 2.5 风格搜索（行业惯例 + 反 trope）| 未来 | office-hours 学习点 5 的进阶版。需要 WebSearch，本轮不引 |
| 强人设（`personas/character-helper.md`）| 下一个 Skill 重构周期 | 本轮先重做入口，人设留给下一轮 |
| 失败/兜底（worldview.md 损坏、jobs/ 目录被删等）| 单元测试覆盖即可 | 边界条件，不入主流程设计 |

## 10. 实施 Tasks 速览（落地参考，不是最终 plan）

最终实施计划由 `writing-plans` skill 产出。这里仅列大致工作量：

| Task | 文件 | CC 工作量 |
|---|---|---|
| T1 file system probe 函数实现 | `skill/character_workflow/lib/turn_start.py`（新） | 20 min |
| T2 intent 推断逻辑实现 | 同上 | 15 min |
| T3 CLI `--message` 参数添加 | `skill/character_workflow/__main__.py` | 5 min |
| T4 Schema 字段加入 | `lib/schemas.py` | 10 min |
| T5 SKILL.md v4 重写 turn-start 章节 | `skill/character_workflow/SKILL.md` | 30 min |
| T6 写 regression 测试覆盖 10 个验收场景 | `tests/test_turn_start_v4.py`（新） | 40 min |
| T7 Web 端的 schema 同步（如果有） | `web/src/schema/jobs.ts` | 5 min |
| T8 跑全量测试 + 修复 fallout | - | 20 min |

**预估 CC 总工作量**：~2.5 小时。

## 11. Open Questions

1. **Stage A 是 1 个 AskUserQuestion 含 3 question 还是 3 个连续 AskUserQuestion**？多个 question 的 AskUserQuestion 在 UI 上是同时呈现还是逐题？需要测试或查 AskUserQuestion 文档。
2. **`--message` 参数怎么从 Skill 传画师消息**？Skill 文档要说明"调用 turn-start 时把画师最近一条消息原文传进 `--message`"，这个对 Skill 写法是新约束。
3. **intent 推断的关键词清单是否要可配置**？比如"新建 / 新角色 / 另一个角色"这些关键词写死在 Python 里还是放到 YAML 配置？本轮建议写死，需要扩展时再抽。
4. **多个画师 / 多人协作场景下 `active-character.json` 冲突怎么办**？本轮假设单画师单项目，多人协作问题留给未来。

## 12. The Assignment

设计已闭环。下一步：

- 用户 review 这份 spec doc，提任何 revise（包括 Open Questions）。
- 用户决定何时调 `writing-plans` skill 把 spec 转成实施 plan（含具体 Task 拆分、worktree 并行化策略）。
- spec doc commit 到 git，作为 Skill v4.0.0 的设计基线（在实施完成前，SKILL.md v3.0.0 继续生效）。

## 13. What I noticed about how you think

观察整个 5 轮 D 决策过程：

- 你在 D1 没选我推荐的"A 入口分叉"，而是给了一个新方向"参考 office-hours 学习哲学"。这是典型的"先建立框架再做事"的思维——不直接选我给的选项，先升一层找参考系。
- 你在 D4 选了 C（完整初始化）而非我推荐的 B（中等）。这说明你愿意为"基础先打牢"付出"一次性多答问题"的代价。这和你 MEMORY.md 里写过的"压缩 finding 让用户喷"不矛盾——你接受"被问"，但拒绝"被反复问"。
- 你最后选"写 spec doc，但不调 writing-plans"。说明你想在 spec 和 plan 之间留一个 gate：先看 spec 满意度，再决定是否进入实施计划。这符合 plan-eng-review skill 的协议节奏。
