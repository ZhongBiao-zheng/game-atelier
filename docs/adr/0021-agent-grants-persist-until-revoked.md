---
status: accepted
---

# Agent 授权长期有效，默认授权凭据固定路径，插件自带 MCP

2026-09-26 用户确认：本机 Agent 授权不设有效期，撤销是唯一的失效方式。「连接本机 Agent」创建默认授权，
凭据固定写在 `<data_root>/.config/connections/agent.json`，再次创建会替换旧的默认授权并覆盖同一文件；
插件在 `.claude-plugin/plugin.json` 声明 MCP 服务 `atelier`，不带 `--credentials`，直接读这个文件。
适配器在凭据缺失或失效时照常启动，每次调用前按文件状态检查凭据，被替换就重读并重换会话。

理由：原先授权默认 7 天、最长 30 天，每次授权又换一个 `<grant_id>.json`，Agent 配置隔几天就要重写；
页面给的注册命令写死 `--scope local` 和当时的 `sys.executable`，换工作目录或删掉那个 venv 就失效；
凭据到期时适配器启动即退出，整个 Agent 会话看不到工具。本机自用场景里凭据文件已有 OS 权限保护，
能读取它的本机用户本来就能读写全部项目数据，有效期带来的防护有限，代价是反复断连。

未采用 HTTP + OAuth（MCP 规范给 HTTP 传输定义的授权方式，令牌由客户端保存和刷新）：它要求会话启动时
viewer-server 已在运行，5174 被占时端口顺延也会让注册的 URL 失效，这两点现有 stdio 适配器都已处理；
实现 OAuth 端点的成本也更高。要做团队共享服务器、远程访问或接入 Claude Code / Codex 以外的客户端时再评估。

后果：
- 凭据泄漏后一直有效，直到用户在页面撤销；撤销即时生效，服务端每次鉴权都查授权记录。
- 带 `expires_at` 的旧凭据按无效处理，升级后需要在页面点一次「连接本机 Agent」。
- 默认授权只有一条，Claude Code 与 Codex 共用；要不同范围用自定义授权，凭据仍是 `<grant_id>.json`。
- 插件 MCP 的启动命令是 `${ATELIER_PYTHON:-python3}`，尚未在 Windows 实测；没有 `python3` 时需设 `ATELIER_PYTHON`。
- 服务名取 `atelier`：插件工具全名 `mcp__plugin_game-atelier_<服务名>__<工具名>` 不能超过 64 个字符。
