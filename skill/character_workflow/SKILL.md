---
name: character-workflow
description: 游戏角色资产工作流。承接画师在 Web UI 上的反馈/改 prompt/改 spec，每 turn 起始读取 .runtime/draft/、同步活跃角色、按需调 Lovart 出图。仅在画师明确说"开始角色工作流"或调用 /character-workflow 时触发。
---

# Character Workflow Skill

## Turn 起始三步（**每次 turn 必做**）

### 1. 处理 draft 反馈（原子 rename）

调用 `skill/character_workflow/lib/draft_processor.py` 的 `process_drafts()`：

- 将 `.runtime/draft/*.md` 原子 rename 到 `.runtime/processing/<ts>-<original>.md`
- 读取 processing 目录全部内容、按文件名升序合并到当前上下文
- 读完后将 processing 文件移到 `.runtime/draft-processed/`

```bash
python -c "from skill.character_workflow.lib.draft_processor import process_drafts; print(process_drafts())"
```

### 2. 同步活跃角色

调用 `skill/character_workflow/lib/active_character.py`：

- 读 `.runtime/active-character.json` 拿 `active_id`
- 如果文件不存在或 `active_id` 为 null：根据上下文判断当前讨论的角色，或问画师"想处理哪个角色？"
- 处理某角色前：写入 `.runtime/active-character.json` `{"active_id":"<id>","updated_at":"<iso>"}`

### 3. 读取角色档案

- 读 `characters/<active_id>.md` 拿最新 spec
- 如果文件 mtime 新于上次 turn 结束时记录的 mtime：使用新内容覆盖记忆

## 出图流程

当画师确认要出图时：

1. 生成 `job_id = job-<ulid>`
2. 写 `.runtime/jobs/<job_id>.json` `status=pending`（用 `lib/jobs.py` 的 `write_job_pending`）
3. 调用 lovart-api skill（`/Users/zhengzhongbiao/.claude/skills/lovart-api/`）出图
4. 出图开始时更新 `status=running`
5. 出图完成后更新 `status=done`、填充 `output_paths`
6. 出图失败时更新 `status=failed`、填充 `error`

## viewer-server 启停

画师 `/character-workflow <角色>` 第一次触发时：

```bash
python skill/viewer-server/server.py start
```

完成后：

```bash
python skill/viewer-server/server.py open-browser
```

server 启动时会自动清理 stale PID（见 viewer-server SKILL.md）。

## 哲学锚（不许违反）

1. 文件系统是唯一 source of truth
2. 画师写动作的最终归宿是文件
3. Skill 内核纯 markdown + Python helpers，不绑死 host
4. 零部署、零账号、零云

## 触发条件

仅在以下情况触发：
- 用户输入 `/character-workflow <角色名>` 命令
- 用户明确说"开始角色工作流"或"开始处理角色 X"
- viewer-server 已运行时，用户在 CC 按 Cmd+V + Enter 粘贴 "继续"
