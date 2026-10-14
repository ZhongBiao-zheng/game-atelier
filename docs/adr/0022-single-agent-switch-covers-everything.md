---
status: accepted
---

# Agent 连接是设置里的一个开关，覆盖全部项目与画布

2026-10-14 用户确认：删掉「本机连接」页与自定义授权，设置页「Agent 连接」只有一个开关。
打开即签一份凭据（固定在 `<data_root>/.config/connections/agent.json`），授权全部工坊项目、全部画布和全部能力，
包括打开之后新建的；关掉即撤销。打开时若本机装了 Codex（`$CODEX_HOME` 或 `~/.codex` 目录存在），
同时把 `[mcp_servers.game-atelier]` 写进它的 `config.toml`；Claude Code 由插件自带 MCP 读同一份凭据。

理由：内部工作台只有本机自用场景（ADR-0017），按项目缩范围、按能力勾选从没人用，却占了页面大半；
默认授权原先是创建那一刻的项目快照，新建项目后 Agent 看不到，要重新授权，这是「点一下就能用」的反例。

取代：ADR-0021 中「默认授权只有一条，自定义授权用 `<grant_id>.json`」与「默认授权按项目列表授权」两点；
「不设有效期、撤销是唯一失效方式」保留。授权记录改存 `agent-grant.json`，旧 `grants.json` 整体作废，
升级后在设置里重新打开一次开关。

后果：
- 管理端点只剩 `GET / PUT / DELETE /api/connection/agent`；`agent-grants` 与 `codex-config` 端点删除。
- 运行会话不再携带 `project_ids` / `canvas_project_ids`，工具判权只看能力与目标是否真实存在、是否属于声明的项目。
- 要给外部或不同信任级别的 Agent 开窄权限时，需要重新设计授权模型，不能把旧的自定义授权加回来了事。
