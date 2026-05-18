# Turn 起始三步（详细版）

每次 turn 起始按顺序执行。三步都很轻，加起来通常 < 50ms。

## 步骤 1：处理 draft 反馈

画师在 Web UI 提交反馈 → 写到 `.runtime/draft/<ts>.md` → Skill 读取并入上下文。

调用：

```bash
python -c "from skill.character_workflow.lib.draft_processor import process_drafts; import json; print(json.dumps(process_drafts(), ensure_ascii=False))"
```

返回 `list[DraftMessage]`，每条带 `character_id`（从首行 HTML 注释 `<!-- character: xxx -->` 提取）和 `text`。

内部实现：原子 rename `draft/*.md → processing/<ts>-<name>.md → draft-processed/`，避免重复消费。

## 步骤 2：同步活跃角色

读 `.runtime/active-character.json`：

```bash
python -c "from skill.character_workflow.lib.active_character import read_active; print(read_active().model_dump_json())"
```

返回 `{"active_id": "<id> | None", "updated_at": "<iso>"}`。

**Web UI 左栏的高亮和右栏内容都跟这个文件走。** Skill 切换处理对象时必须写一次：

```bash
python -c "from skill.character_workflow.lib.active_character import write_active; write_active('character-id')"
```

## 步骤 3：读取角色档案

```bash
cat characters/<active_id>.md
```

如果文件 mtime 新于上次 turn：覆盖记忆中的 spec。

## 跳过条件

- 用户消息明显与角色工作流无关（如 git 操作、纯问答） → 跳过三步
- 没有 active_id 且没有 draft → 询问"想处理哪个角色？" 但不要凭空创建文件
