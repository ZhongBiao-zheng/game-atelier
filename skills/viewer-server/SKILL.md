---
name: viewer-server
description: 本地 FastAPI server，给 Web UI 提供文件读写 API + SSE 推送。仅本地访问（127.0.0.1）。
---

## ⚠️ 启动必读 Memory 三层

每次进入本工作流，必须按顺序 Read：

1. `~/.claude/MEMORY.md` — 全局跨工作区经验
2. `<data_root>/MEMORY.md` — workspace 级
3. 如果对话涉及具体角色:
   - 从 `<data_root>/.runtime/projects.json::assignments` 解析角色所属 project_id
   - 从 `projects[].slug` 找到 slug
   - Read `<data_root>/projects/<slug>/MEMORY.md` + `worldview.md`

不读 MEMORY 就写 prompt / 出图 / 改 spec 视为违规。

## 启动自检（bootstrap）

每次触发本 Skill，第一步先判断当前模式：

Dev mode：`uv run python scripts/bootstrap.py --check`
Installed Plugin mode：`python3 ~/.claude/plugins/game-ui-ai-workflow/scripts/bootstrap.py --check`

按 status 字段分流：

- `ready` → 进 turn-start，正常工作
- `needs_data_root` → 用 AskUserQuestion 问数据目录路径，POST `/api/onboarding/data-root`
- `needs_uv` → 显示 next_action 字段里的安装命令，**不要替用户跑**
- `needs_venv` → 按当前模式跑 `<bootstrap.py> --ensure-venv`；Dev mode 前缀为 `uv run python`，Installed Plugin mode 前缀为 `python3`
- `needs_first_key` → 启 viewer-server，引导用户在 Web 上加第一个 Key
- `needs_keys_repair` → 告知用户 `keys.json` 损坏，建议备份后手动编辑或删除重加

## API Key 选择规则

turn-start 返回 `available_keys` 和 `preferred_alias`：

1. **默认走 `preferred_alias`** — 不要问用户用哪个 Key
2. **用户点名某 alias / provider** — 切到匹配的 Key，更新 spec.md 的"渲染"段
3. **用户要求某种风格且 notes 里有匹配描述** — 可建议切换并解释理由
4. **`preferred_alias` 是 null** — 停下来告诉用户："当前 kind=X 没有可用 Key，去 Web 加一个"
5. **永远不要在终端 / 文档 / log 里显示 access_key / secret_key** — 你看不到，也不该看到

# Viewer Server

## 命令

### `uv run python src/viewer_server/server.py start --background`

Skill 调用路径必须带 `--background`，否则前台 server 会阻塞当前 turn。

### `uv run python src/viewer_server/server.py start`

手动终端启动 server：
1. 检查 `.runtime/server.pid` 是否存在
2. 若进程已死：删除 pid 文件，继续启动
3. 若进程存活：不重复启动，打印实际端口
4. 默认端口 5174；被占用时 +1 直到找到空端口
5. 实际端口写入 `.runtime/server.port`
6. 监听地址固定 `127.0.0.1`

### `uv run python src/viewer_server/server.py stop`

停止 server（读 `.runtime/server.pid` 发 SIGTERM）。

### `uv run python src/viewer_server/server.py open-browser`

`open http://127.0.0.1:<port>/`（Mac）/ `xdg-open`（Linux）。

## 单 tab 约束

同一时间只支持一个浏览器 tab 操作。多 tab 行为未定义（v2.3 Outside Voice #4 限制）。
画师指南需写明。
