# character-workflow 协议三处优化

> 创建：2026-05-19
> 触发：一次裸触发 `/character-workflow` 执行复盘，发现协议三处缺口
> 决策方：项目开发者
> 执行：交付给独立 agent，按本计划落地

---

## 背景

在执行 `/character-workflow`（无参数、无消息、drafts 空、active 已存在、spec 已完整）这一最常见入口时，暴露三处协议问题：

1. **协议工具缺口**：写 PENDING_CONFIRM job 需要执行者临时 grep `jobs.py` 源码（`job_id` 格式、`seed`/`status` 默认值、`JobParams` 字段散落），skill 文档伪代码 `jobs.write_job(...)` 与真实签名不一致。
2. **决策错位**：turn-start CLI 返回 `intent=new, signal=default` 时，SKILL.md 让 LLM 默认走"出图"。但 `default` 信号的真实含义是"画师没给任何信号"，4 种可能意图（按现 spec 出 / 改 spec / 新建角色 / 新开项目）里，"出图"只是其中之一，强默认会误推。
3. **想法落地面缺失**：终端打了 PENDING_CONFIRM 卡片，但 Web 上没有任何 "这个角色有想法在等确认" 的反映；spec.md 是想法的本体，画师只能通过对话改、不能在 Web 直接改。

---

## 定位（贯穿全计划）

**终端 = 唯一决策面**。PENDING_CONFIRM 卡片现编、确认 / 取消、改 prompt —— 都在终端跟 Claude 说。
**Web = 给美术的查看 + 文件编辑面**。看角色、看历史出图、看 spec、改 spec 文本。**不做任何交互按钮**（无确认 / 无取消 / 无 Web 端出图）。

这个定位是后面三任务的硬约束。

---

## 任务 1：新增 `submit` CLI，集中 PENDING_CONFIRM 默认值

### 目标
让 SKILL.md "调 Lovart 出图" 一节的第 1 步从"导入 jobs.py 写一段 Python"压缩到一行 shell。

### 接口

```bash
uv run python -m skill.character_workflow submit \
  --kind portrait|promo|turnaround \
  --prompt-file <path> \
  [--character <id>] \
  [--n 1] \
  [--size 1024x1536] \
  [--model generate_image_gpt_image_2] \
  [--source-image <path>]
```

### 关键约束

- **prompt 强制走文件**（`--prompt-file`），不接受 `--prompt "..."`。理由：8 段式中文 prompt 几百字，作为 shell 参数会卡在引号 / 顿号 / 换行 / 破折号转义上。Skill 端写法：`/tmp/prompt-$$.md`（PID 后缀避免并发冲突），写完调 submit。
- **`--character` 缺省读 `.runtime/active-character.json`**。读不到（stage A/B/C）就 exit code != 0 + stderr 报错。
- **默认值清单**（CLI 这一层是 single source of truth，执行者不允许重新决定）：

  | 字段 | 默认值 | 备注 |
  |---|---|---|
  | `model` | `generate_image_gpt_image_2` | 三种 kind 现阶段都走这个 |
  | `n` | 1 | 默认单图，画师明示要对比才传 `--n 4` |
  | `size` | `1024x1536` | portrait/turnaround 通用；promo 后续可在 CLI 内部按 kind 切换默认值 |
  | `seed` | None | |
  | `status` | `PENDING_CONFIRM` | submit 永远只写这个状态 |
  | `job_id` | `job-{YYYYMMDDHHMMSS}{8 hex}` | 沿用既有格式 |

- **标准输出**：成功时 stdout 只一行 job_id 字符串（方便 `JOB_ID=$(uv run ... submit ...)`）。失败时 stdout 空、stderr 写人类可读错误、exit code != 0。

### 实现位置
- `skill/character_workflow/__main__.py` 加 `submit` 子命令
- 内部仍调 `jobs.write_job()`，submit 在它上面包默认值 + job_id 生成
- 不替换 / 不删除 `jobs.write_job()`，向后兼容

### SKILL.md 同步改写
"调 Lovart 出图" 一节步骤 1 从原伪代码改为：

```bash
# 1. 写 PENDING_CONFIRM job
echo "$prompt" > /tmp/cw-prompt-$$.md
JOB_ID=$(uv run python -m skill.character_workflow submit \
  --kind portrait --prompt-file /tmp/cw-prompt-$$.md)
rm /tmp/cw-prompt-$$.md
```

`references/lovart-call.md` 同步。

### 单测
`tests/test_submit_cli.py` 至少覆盖：
- portrait / promo / turnaround 三种 kind 各一次，断言落盘 job 的 status / kind / params / output_paths（空数组）
- 缺 `--character` 且 active-character.json 不存在 → exit code != 0
- `--prompt-file` 指向不存在文件 → exit code != 0
- stdout 是纯 job_id（无前缀 / 无颜色码 / 无换行尾部）

### 不做
- 不做 lib 函数 `create_pending_confirm()`（避免 CLI / lib 双入口分裂）
- 不做"submit + 立即调 Lovart"快捷参数（PENDING_CONFIRM 是设计有意为之，不能绕过）
- 不在 submit 里检查"上一次同角色同 prompt"防重复（画师可能就是要再来一张）

---

## 任务 2：turn-start CLI 加 `recommend_action`，决策从 LLM 收回

### 目标
LLM 端不再推断 "裸触发 + default signal 是否等于出图"。turn-start CLI 算好返回 `recommend_action`，SKILL.md 按字段分叉。

### 接口扩展

turn-start 返回 JSON 新增两个字段（其他字段不变）：

```json
{
  ...,
  "recommend_action": "render_card" | "ask" | "switch" | "noop",
  "recommend_reason": "<人类可读>",
  "active_age_minutes": 1234
}
```

`active_age_minutes` = `now - active_updated_at`（分钟，向下取整）；active-character.json 不存在则为 null。

### 决策表

按行从上到下短路命中：

| 输入信号 | recommend_action | recommend_reason 示例 |
|---|---|---|
| stage A / B / C | `ask` | "stage A: characters/ 目录不存在，问项目名 + 世界观 + 首角色" |
| stage D + 消息含 `/character-workflow <name>` 且 name ≠ active_id | `switch` | "switch 信号" |
| stage D + drafts 非空 | `render_card` | "revise: drafts 中有 N 条画师反馈" |
| stage D + 消息含"新建 / 新角色 / 另一个角色" | `ask` | "create 信号，走 stage B 流程问新角色定位" |
| stage D + 消息含明确出图动词（白名单见下） | `render_card` | "明确出图信号" |
| stage D + `default` signal + active_age_minutes > 30 | `ask` | "冷启动：active 超过 30 分钟未更新" |
| stage D + `default` signal + 上一个 job 状态 ∈ {DONE, FAILED} | `ask` | "上一轮已闭环，画师意图未明" |
| 其他 | `ask` | "兜底：判定不明确" |

**出图动词白名单**（硬编码在 `lib/intent.py`，独立函数 `_has_render_verb(msg: str) -> bool`，方便后续加词）：

```
出图 出一张 出一版 再出 重出 再来一张 来一张 换张 换一张 v1 v2 v3 v4
```

正则匹配，区分大小写无关（v2/V2 都算）。要扩缺词只改这个函数。

**核心理念**：判定不明确一律走 `ask`，宁可多问。"误问"的成本是画师多打一个数字，"误出图"的成本是写空跑 job + 占位卡片 + 画师还得说取消。

### SKILL.md 同步改写

"Turn 起始" 一节按 `recommend_action` 直接分叉，删除原来按 `stage` + `intent` 两层判断的逻辑：

| recommend_action | Skill 行为 |
|---|---|
| `ask` | AskUserQuestion 列 4 选项：① 按现 spec 出图 ② 改 spec ③ 新建角色 ④ 跳过本轮。option 4 直接退出 turn，不动 file system |
| `render_card` | 终端现编 PENDING_CONFIRM 卡片 + 调 `submit` CLI（任务 1） |
| `switch` | 调 `set-active` + 重新 turn-start |
| `noop` | 不动 file system（当前不会用到，预留） |

`intent` / `intent_signal` 字段保留输出但 SKILL.md 不再提（debug 用、向后兼容）。"Painter Intent 推断" 整节改为"参考实现细节，实际决策看 `recommend_action`"。

### 实现位置
- 决策逻辑放在 `skill/character_workflow/lib/intent.py`（新文件或扩展现有 intent 推断），独立函数 `compute_recommend_action(stage, message, drafts, active_age_minutes, last_job_status) -> tuple[str, str]`
- `__main__.py turn-start` 调它、拼进返回 JSON

### 单测
`tests/test_recommend_action.py` 覆盖决策表每一行：
- stage A/B/C → ask（各一例）
- switch 信号
- drafts 非空 → render_card
- "新建" 关键词 → ask
- 出图动词每个关键词至少一例 → render_card
- default + age > 30 → ask
- default + last DONE → ask
- default + last FAILED → ask
- 兜底 → ask

### 不做
- 不删除 `intent` / `intent_signal` 字段（向后兼容、debug 用）
- 不让 LLM 推断关键词 —— 词表只能改 `intent.py` 一处
- 不基于消息语义模型（embeddings / LLM call）做意图推断 —— 关键词 + 规则就够，黑盒成本不值

---

## 任务 3：Web 端补 spec 显示 + 编辑（无任何交互按钮）

### 定位再次明确

✅ Web 要有：
- 当前 active 角色的 spec.md 显示
- spec.md 直接编辑（textarea + 保存按钮 → 调 `POST /spec`）
- PENDING_CONFIRM job 的存在感（角色卡片或顶栏一个只读徽章："1 个 job 等终端确认"）

❌ Web 绝对不加：
- "确认出图" 按钮
- "取消" 按钮
- 改 PENDING_CONFIRM job 的 prompt / 参数的表单（即使 `WebEditableJobPatch` 后端允许，UI 不暴露）
- 任何能在 Web 触发 Lovart 出图的入口
- 结构化字段表单（风格档 / 配色 / 镜头分独立输入框）—— spec 是 markdown，让画师整段编辑

### 前置：先核实 Web 现状

执行 agent 进入任务 3 前，先做以下核实并把结论写入 PR 描述：

1. `grep -rn "POST /spec\|/api/spec\|saveSpec" web/src` —— Web 是否已经接到 `POST /spec`
2. 读 `web/src/components/CharacterGallery.tsx` —— 当前 tab 结构（已知有 portrait / promo / turnaround 三 tab），是否已有 spec tab
3. `grep -rn "pending_confirm\|PENDING_CONFIRM" web/src` —— Web 当前如何处理 PENDING_CONFIRM 状态

按核实结果走分支：

| 情况 | 任务 3 工作量 |
|---|---|
| **a. Web 已有 spec tab 且能改** | 只补"PENDING_CONFIRM 徽章"一个 UI 元素 |
| **b. 有 spec 显示但只读** | 加 textarea + 保存按钮 + 徽章 |
| **c. 完全没有 spec tab** | 新增 spec tab（参考 portrait tab 结构，TAB_META 已是配置表）+ 编辑功能 + 徽章 |

### 实现位置（预期）

- `web/src/components/CharacterGallery.tsx` —— 加 spec tab（如果情况 c）
- `web/src/components/SpecPanel.tsx` —— 新增组件（markdown textarea + 保存按钮 + 字数显示）
- `web/src/hooks/useSpec.ts` —— 新增 hook（GET /spec、POST /spec、SSE 监听 spec.md 变化时本地刷新）
- `web/src/components/CharacterCard.tsx`（或 sidebar）—— 加 PENDING_CONFIRM 徽章

### SSE / 文件监听

`POST /spec` 后 watcher 会推 SSE 事件（CLAUDE.md 表里 spec.md 是 Skill/Web 双写）。**Web 端必须订阅这个事件**，否则 Claude 在终端改了 spec、Web 不刷新，画师会看到错版本。

### 单测
- `web/src/components/__tests__/SpecPanel.test.tsx` —— 显示 + 编辑 + 保存
- `web/src/hooks/__tests__/useSpec.test.ts` —— GET/POST 流程
- PENDING_CONFIRM 徽章的显示条件（仅 active 角色有 PENDING_CONFIRM job 时显示）

### 不做
- 不在 Web 渲染"出图卡片"（任何形态）
- 不做 spec markdown preview（textarea + 等宽字体就够，画师本来就在写 markdown）
- 不做 spec diff / 版本历史（git log 已够，本计划范围外）
- 不在 Web 操作 `.runtime/draft/*.md`（draft 已有独立写入机制 [[文件创建反馈]]）

---

## 任务执行顺序

1. **任务 1（submit CLI）** —— 完全独立，先做
2. **任务 2（recommend_action）** —— 依赖任务 1 的 SKILL.md 改写（按 `render_card` 分叉时引用任务 1 的 submit），第二做
3. **任务 3（Web spec 面板）** —— 完全独立，可以与 1/2 并行

建议先做 1 → 串 2，3 单开一个 PR 并行。

---

## 验收标准

**协议层**：
- 裸触发 `/character-workflow`（无参数、drafts 空、active 完整、spec 已写）→ Skill 只执行 1 次 turn-start CLI + 1 次 AskUserQuestion，不再有自动写 job、不再有 grep 源码
- 明示"出图"触发 → Skill 执行 1 次 turn-start + 1 次 submit CLI，PENDING_CONFIRM 卡片在终端打出
- 消息带 `/character-workflow <other-character>` → Skill 自动 set-active + 重新 turn-start

**Web 层**：
- 画师在 Web 看得到当前 active 角色 spec.md 内容
- 画师在 Web 改 spec、保存后，Skill 下一轮 turn-start 读到的 spec 是新版本
- 画师在 Web 看得到 "1 个 job 等终端确认" 徽章（仅当存在 PENDING_CONFIRM job）
- 画师在 Web 找不到任何"确认出图"或"取消"按钮

**质量**：
- 新增单测全绿（pytest + vitest）
- `uv run ruff check skill tests` 干净
- `cd web && pnpm lint` 干净
- 既有 122 个测试 0 回归

---

## 不在本计划范围

- 终端 PENDING_CONFIRM 卡片的渲染逻辑（继续 LLM 现编，不结构化）
- 终端卡片与 Web 渲染的 single source of truth 收敛（本次明确分工：终端管决策 + 现编，Web 管显示 + 文件编辑，两边不共用渲染数据）
- 三类 kind（portrait / promo / turnaround）的 size / model 差异化（submit CLI 用同一套默认值，差异化等真实需求出现再说）
- spec 结构化字段编辑（markdown 整段编辑足够）
- 改 PENDING_CONFIRM job prompt / 参数的 Web 入口（后端允许但 UI 不暴露，画师要改 prompt 直接跟 Claude 说）

---

## 给执行 agent 的提示

- 哲学锚：CLAUDE.md "文件系统是唯一 source of truth" + "Web 不能改 job 状态字段" 不能违反
- 任务 3 前一定先核实 Web 现状再决定实现工作量，不要假设情况 c
- 任务 2 改 SKILL.md 时**整段重写** "Turn 起始" 一节，不要在旧逻辑上打补丁 —— 决策表是新的 SSoT
- 任务 1 的 prompt 文件机制要在 SKILL.md 写清"调用方负责创建 + 删除"，避免 `/tmp` 残留
