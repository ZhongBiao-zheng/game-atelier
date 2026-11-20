---
status: accepted
---

# 宿主插件的 Agent 工具、仅 Agent 可调的路由与插件工具进 Canvas MCP

2026-11-19 定，起因是 PS 联动第 2 批。飙哥的目标是「打通通道，之后用 Codex、Claude 或其他 Agent 工具也可以让 Atelier 出图，然后去 PS 调整」，并选了「给 Agent 开任意脚本」。这需要宿主插件能声明 Agent 工具、能有一条浏览器调不到的路由、能在开关关着时把工具藏起来，还要让外部 Agent 经 Canvas MCP 拿到这些工具。

## 决策

- **宿主插件可以声明 `agent_tools`**。原先只有沙箱插件可以（ADR-0037），宿主插件不声明 `ui` 与 `capabilities` 的限制不变。宿主插件的 Agent 调用不经项目批准（代码与宿主同源可信，与 ADR-0039 一致），`PluginRequest.trusted` 为真，`ctx` 能建节点、读写项目状态。
- **`agent_only` 路由**：清单路由可标 `"agent_only": true`（只给宿主插件）。浏览器经 `/api/plugins/<id>/routes/…` 调不到它：鉴权中间件把它当作未声明（`declared_access` 返回空），`plugin_server.call` 也拒绝非 Agent 入口。它只能作为 Agent 工具被调用。
- **藏起工具**：宿主插件的服务端模块用 `@api.hidden_agent_tools` 登记一个函数，返回此刻要藏起的工具短名。画布 Agent 组装工具时与 Canvas MCP 列工具时都按它过滤，直接调用藏起的工具一律拒绝。判断函数出错时整组藏起。
- **每次都确认**：工具可标 `"always_confirm": true`（只给宿主插件）。`canvas_agent_runtime.confirmation_required` 对它返回真，审查模式与 Auto 模式一样。`"summary_field"` 指定确认卡显示哪个参数的原文（PS 联动：脚本全文），确认卡保留换行与缩进；本机路径等仍按会话的隐私规则显示为「已隐藏」。
- **预览图**：插件工具结果里的 `preview: {mime_type, data_base64}`（JPEG 或 PNG，单张 ≤ 2 MiB），画布 Agent 存进 `.runtime/agent-images/`，工具结果里换成 `attach_images: ["agent-image:<文件名>"]`，由 vision 在调模型前附上；Canvas MCP 直接作为图片内容返回。这个目录只收工具结果带回来的图，文件名由服务端生成（20 位写入序号 + `-` + 12 位十六进制 + 扩展名，读取时按这个格式校验；序号是进程内严格递增的纳秒时间），每次写入前清理：序号早于 24 小时前的删掉，再按序号从旧到新删到不超过 200 张、64 MiB；目录里不合格式的文件也删掉。先后只看文件名里的序号，不看文件修改时间：Windows 上连续写入的几张 mtime 可能相同，按 mtime 排序会把刚存的那张删掉。会话历史里只留 `agent-image:` 引用，不落 data URL 与本机路径（沿用会话的隐私约束）。
- **插件工具进 Canvas MCP**：新增 `POST /api/canvas-agent/plugin-tools`（列出）与 `POST /api/canvas-agent/plugin-tools/<plugin_id>/<tool>`（调用，`{project_id, arguments}`）。两个接口只认 Agent 凭据（本机页面的会话即使走到这里也拒绝），能力按工具的 `read_only` 取 `canvas_read` / `canvas_edit`，沿用现有的一条 Agent 授权。**只对白名单里的插件开放，目前只有 `ps-bridge`**（`canvas_agent_routes.MCP_PLUGIN_IDS`），其他插件的工具仍不进 MCP。
- **调用方**：Agent 调用时 `ctx.caller` 为「画布 Agent」或「外部 Agent」，给插件记日志用。

## PS 联动怎么用这些

- 工具：`inspect`（文档与图层，只读）、`import`、`place`、`preview`（只读）、`execute`（`agent_only`、`always_confirm`、`summary_field: "code"`）。
- 「允许 Agent 在 Photoshop 里执行脚本」开关默认关，存 `<data_root>/.config/ps-bridge.json`；关着时 `execute` 被藏起，插件自己也再查一次。开关只在设置页由用户改，Agent 工具里没有改它的入口。
- 每次执行记一行 `<data_root>/.runtime/ps-bridge/execute-log.jsonl`（时间、调用方、项目、文档、脚本全文、成败、耗时），1 MiB 轮转留一份，设置页显示最近 20 条。脚本全文可能含文档里的文字内容，日志只留在本机：局域网网关、用量统计与项目包都不读也不带它。
- 外部 Agent 不逐次确认：它们本来就有 shell，能直接跑 `osascript`，逐次确认挡不住，只会打断流程。画布内置 Agent 没有文件与命令能力，却会读画布文本、素材、Skill 与团队库内容（可能带诱导文字），所以每次确认。

## 没有采用

- 把执行脚本做成普通插件路由：浏览器会话就能调到，等于给任何能让页面发请求的东西开了本机命令权限。
- 在运行时里按插件名写死「ps-bridge 的 execute 要确认」：以后别的宿主插件需要时还得改核心代码。
- MCP 工具列表随服务端动态生成：适配器常先于服务端与授权启动，启动时拉不到列表；改为适配器静态登记 PS 联动的五个工具，列工具时按服务端此刻的可用情况过滤，调用时以服务端判断为准。

## 后果

- 清单 schema 两端同步（`plugin_manifest.py` / `web/src/schema/plugins.ts`）。
- 文档：`docs/plugins/contributions.md`、`server-modules.md`、`docs/contracts/canvas-mcp.md`、`docs/api-contract.md`。
- 通用用例「官方插件启用后 Agent 工具全部注册」的期望改为「声明数减去插件此刻藏起的数」。
