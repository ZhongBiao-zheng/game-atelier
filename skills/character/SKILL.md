---
name: character
version: 4.2.0
description: |
  游戏角色资产工作流。承接画师在 Web UI 上的反馈，通过对话逐项问清
  风格/配色/镜头/道具，然后调 Lovart 出中文 prompt 图。
  当用户说"做个角色"、"出张立绘"、"继续角色工作流"或调用
  /game-atelier:character 时主动使用。spec 里不出现占位词，
  所有缺失信息都通过对话补全，不猜测不假设。
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - AskUserQuestion
triggers:
  - /game-atelier:character
  - 开始角色工作流
  - 做个角色
  - 出张角色立绘
  - 加个新角色
  - 继续角色工作流
  - 角色立绘
---

## ⚠️ 启动必读 Memory 三层

每次进入本工作流，必须按顺序 Read：

1. `~/.claude/MEMORY.md` — 全局跨工作区经验
2. `<data_root>/MEMORY.md` — workspace 级
3. 如果对话涉及具体角色：从 `<data_root>/.runtime/projects.json::assignments` 解析 project_id → 找 slug → Read `<data_root>/projects/<slug>/MEMORY.md` + `worldview.md`

不读 MEMORY 就写 prompt / 出图 / 改 spec 视为违规。

## 启动自检（bootstrap）

Dev mode：`uv run python scripts/bootstrap.py --check`
Installed Plugin mode：`python3 ~/.claude/plugins/game-atelier/scripts/bootstrap.py --check`

按 status 字段分流：`ready` → turn-start | `needs_data_root` → AskUserQuestion 问路径 | `needs_uv` → 显示安装命令，不替用户跑 | `needs_venv` → `<bootstrap.py> --ensure-venv` | `needs_first_key` → 启 viewer-server 引导加 Key | `needs_keys_repair` → 告知 keys.json 损坏

## API Key 选择规则

turn-start 返回 `available_keys` 和 `preferred_alias`：

- 默认走 `preferred_alias`，不问用户
- 用户点名 alias / provider → 切换并更新 spec.md
- `preferred_alias` 为 null → 停下，告知缺 Key
- 永远不在终端 / 文档 / log 里显示 access_key / secret_key

## viewer-server 启停

Turn 起始之前先执行：

Dev：`uv run python src/viewer_server/server.py start --background`
Plugin：`python3 ~/.claude/plugins/game-atelier/scripts/bootstrap.py --run -m viewer_server.server start --background`

Installed Plugin 模式下所有 `uv run python -m character_workflow ...` 命令改为 `python3 ~/.claude/plugins/game-atelier/scripts/bootstrap.py --run -m character_workflow <subcmd>`。

## Turn 起始

```bash
uv run python -m character_workflow turn-start --message "<画师本轮原文>"
# 出图 promo/turnaround 时加 --kind 切换对应 lessons
```

关键返回字段：

| 字段 | 含义 |
|---|---|
| `stage` | A/B/C/D/E — 当前流程位置 |
| `recommend_action` | ask / render_card / switch / noop — 本轮主要决策 |
| `active_id` / `spec` / `spec_status` | 当前角色和 spec 状态 |
| `pending_identity_normalizations` | Web 创建的临时角色（`char-<数字>`）待整理队列 |
| `recent_chars` | id + tagline 列表，Stage C 列选项用 |
| `available_keys` / `preferred_alias` | Key 选择 |
| `project_memory` / `lessons_*` | 项目 MEMORY.md 全文（含世界观、项目规则、角色名册、经验） |

**只看 `recommend_action` 决策**：

| recommend_action | 行为 |
|---|---|
| `ask` | **必须调用 AskUserQuestion**（带 options）—— 按 stage 分叉问什么（见下） |
| `render_card` | 写 prompt → submit CLI → 卡片 → 等确认 → run-job |
| `switch` | `set-active <target>` 后重新 turn-start |
| `noop` | 退出 turn，不动 file system |

### pending_identity_normalizations（优先处理）

`pending_identity_normalizations` 非空时，先于 Stage 普通流程处理。展示每条的 `old_id → display_name → recommended_id`、`asset_counts`、`spec_status`。用户确认后调：

```bash
uv run python -m character_workflow rename-character-id <old_id> <recommended_id>
```

整理完必须重新 turn-start 刷新 active / recent_chars / pending 队列。

### Stage 分叉

**Stage A**（characters/ 目录不存在）：AskUserQuestion 同时问 3 题：项目名 / 一句话世界观（10-30 字）/ 第一个角色名 + 定位。落盘后直接进 render_card，不重新 turn-start。

**Stage B**（有项目但 characters/ 为空）：问 1 题：第一个角色名 + 定位（≤20 字）。

**Stage C**（无 active character）：列 `recent_chars` 中每个角色的 `id（tagline）`+ 新建 / 跳过。用户选定后立即 `set-active <id>` 并重新 turn-start，**不再弹二次确认**，直接进入 Stage D 推断。

**Stage D**（裸触发 / 冷启动 / 上轮已闭环）：

`recommend_action == ask` 时，**先做资产侦察再提问**，禁止直接展示通用 4 选项：

1. 列出 `<data_root>/characters/<active_id>/` 下各子目录的文件（`portrait/`、`promo/`、`turnaround/`），判断当前已有哪些资产。
2. 结合 `project_memory` 中的项目规则（如皮肤品质系统、已归档皮肤设计档案）推断最可能的下一步任务。
3. 直接用有上下文的问题询问，而不是通用菜单。例：
   - 角色有 portrait/v1.png 且项目有皮肤系统 → "当前项目有绿/蓝/紫/橙四档品质皮肤，要先做董卓的哪档？"
   - 角色有 portrait 但无 turnaround → "已有立绘，接下来出三视图还是美宣？"
   - 角色啥都没有 → 按现有流程：问外观设定。

仅在侦察结果完全无法推断时，才退回通用 4 选项（说明为什么无法推断）。

**Stage E**（active 未归属任何项目）：列已有项目 + 新开项目 + 跳过。画师选归属后 `assign-character <active_id> --project <project_id>` 再 turn-start。

## 写出图 prompt

**所有向画师提问都必须用 AskUserQuestion**（出图确认卡除外）。纯文字追问等于没问，画师选项清晰才能继续。

对话逐项问清：风格档 → 配色 → 镜头 → 视觉锚点。一次问 1-3 个，二选一优先，问清才动笔。

**spec 格式** → `docs/references/spec-template.md`
创建新 spec 时严格按模板 YAML 字段写；`asset.*` 节按需追加，问清才写，不写占位。

**spec 零占位规则** → `references/spec-protocol.md`（不得在 spec 里写 `?` / TBD / 待定）
**底层规则** → `docs/references/art-prompt-system.md`
**立绘专项** → `references/prompt-zh.md`

## 修改已出图（三模式）

画师指着现有图提修改需求时，**必须先 AskUserQuestion** 确认模式，不得自行假设：

| 模式 | 做法 | 用于 |
|---|---|---|
| A 编辑当前图 | 上传当前图作参考；prompt 只写改动指令 | 只改局部，整体满意 |
| B 完全重出 | 不带参考图；重走 spec 补全，写完整新 prompt | 整张都不满意 |
| C 局部参考混合 | 带参考图锚定满意部分；prompt 完整重写并注明锚定范围 | 人脸/配色满意，服装/姿势要大改 |

三模式互斥，混用输出不稳定。首次出图 / 用户主动"重画"不适用。

### 皮肤 / 换色默认路由

已有默认立绘 + 画师要"皮肤/品质皮肤/换装/整体换色" → 默认 A 模式。prompt 只写改动点，不重述整套外观。推荐模板：

```text
根据参考图中的角色立绘为参考，生成这个角色的"<皮肤名>"主题角色立绘皮肤。
将<默认服装/颜色>改为<目标服装/颜色>；<局部变化>；整体气质<目标气质>。
<局部记忆点>。简约白色背景。不改武器，不加特效，不改动作。
```

正文 1-3 段，约 120-260 中文字。不写长排除段；必要边界合并到最后一句。

## 出图流程

1. 写 prompt 到临时文件，落盘 PENDING_CONFIRM：

   ```bash
   JOB_ID=$(uv run python -m character_workflow submit \
     --kind portrait --prompt-file /tmp/cw-prompt-$$.md)
   ```

   `--n` 默认 1；`--source-image <绝对路径>` 给 promo/turnaround 用；stdout 是纯 job_id。

2. 终端打确认卡：alias / provider / model / 尺寸 / 参考图 / **完整 prompt 原文**（不得摘要或路径代替）
3. 等画师明确"出图/确认/OK"后：

   ```bash
   uv run python -m character_workflow run-job "$JOB_ID"
   # 或用户只说"出图"没有指定 job：
   uv run python -m character_workflow run-latest --kind portrait
   ```

4. 终端渲染：`![v1](绝对路径)` — 每张一行，末尾提一句"Web 也能看，或直接说要改哪张"

失败时：网络/凭证失败 → 问画师重试还是改 prompt；输出路径不可写 → 提醒检查 `image_storage_root`。

## Turn 收尾：经验沉淀

job → DONE / spec 首次归档 / job → FAILED（结构化原因）时触发。问画师是否沉淀经验：

```bash
uv run python -m character_workflow append-memory \
  --kind portrait \
  --line "- YYYY-MM-DD <id> · <一句话> · prompt 片段：\`...\`" \
  --scope project
```

`--scope` 默认 project；通用工具行为/协议经验用 workspace；跨工作区成立用 global。

## 跳过条件

git / 代码 / 部署 / 纯问答；用户没明确开始工作流且 viewer-server 没开；画师选"跳过本轮"。
