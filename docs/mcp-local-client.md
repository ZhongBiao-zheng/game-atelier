# 在本机 Agent 中连接 Atelier 工坊

本入口使用官方 Python MCP SDK 的 stdio 协议。Agent 通过受限工具访问已授权的工坊项目，
文件仍由本机 viewer-server 管理；不需要网站部署或迁移作品库，供应商 Key 不提供给 MCP 客户端。
Agent 通过工具读取的文档、预览等获授权内容会进入其会话；生成时选中的输入会发送给模型供应商。
业务权限和批准规则见[工坊契约](contracts/workshop-mcp.md)。

## 准备本机连接

1. 安装本项目依赖，正常启动 viewer-server 并打开本机 Atelier 页面。
2. 在「本机连接」页点「连接本机 Agent」：默认授权全部工坊项目、画布和操作（ADR-0017 的本机自用场景）。
   要缩小范围用「自定义」：只读查看只授予 `read`；改文档、创建目标和准备生成分别需要 `edit_documents`、
   `create_targets`、`prepare_generation`；`execute_generation` 允许 Agent 在你对话确认后直接批准。
   画布操作另有 `canvas_read / canvas_edit / canvas_generate`，见[画布 MCP 契约](contracts/canvas-mcp.md)；
   操作引导在 `skills/canvas/SKILL.md`。
3. 授权不设有效期，撤销即失效（[ADR-0021](adr/0021-agent-grants-persist-until-revoked.md)）。
   「连接本机 Agent」创建默认授权，凭据固定写在 `<data_root>/.config/connections/agent.json`；再点一次会替换旧的
   默认授权并覆盖同一文件，已注册的 Agent 下一次调用自动换用新凭据，不用改配置、不用重开会话。
   自定义授权的凭据写在 `<grant_id>.json`，注册时带 `--credentials`。凭据文件由服务端生成和保护，
   不要复制其中的 token，不要上传、提交或将它粘贴到聊天 / MCP 配置。

MCP 启动命令：默认授权不带参数，自定义授权带 `--credentials <凭据绝对路径>`。

```text
<python> -m character_workflow.mcp
```

`<python>` 是装了本项目依赖的解释器：插件用户是 `<data_root>/.venv/bin/python`（Windows 为
`<data_root>\.venv\Scripts\python.exe`，默认 data root 是 `~/game-atelier`）；源码开发环境是仓库的 `.venv/bin/python`。
「本机连接」页给出的命令已带本机解释器，不要让 Agent 自行选择另一套 Python。

MCP 进程不会启动、重启或安装 viewer-server，也不扫描端口和用户目录。凭据缺失、已撤销或 viewer-server 未启动时
照常启动，工具保持可见，调用时返回带处理指引的错误；每次调用前按文件状态判断凭据是否已被替换。
它只读取默认或指定的受保护凭据，核验精确的 `http://127.0.0.1:<port>`（以 `.runtime/server.port` 为准）服务和协议，
再换取 2 小时的运行会话，到期或服务重启后自动重换。

## 配置 Claude Code / Codex

插件注册和下列命令都由用户主动安装触发，Atelier 服务本身不改写 Agent 配置。
MCP 配置只保存解释器、模块和可选的凭据文件位置，不包含明文凭据。

Claude Code 由插件自带 MCP（`.claude-plugin/plugin.json` 的 `mcpServers.atelier`），装好插件即注册，不用执行命令；
插件 MCP 只在会话启动时加载，新开的会话里生效（`/reload-plugins` 只重载 Skill，输出会提示 MCP 改动下个会话生效），
服务显示为 `plugin:game-atelier:atelier`。启动命令是
`${ATELIER_PYTHON:-python3} ${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py --run -m character_workflow.mcp`，
由 bootstrap 找到数据目录的 venv 再启动适配器。Windows 没有 `python3` 时，在用户环境变量里设
`ATELIER_PYTHON=python`（尚未在 Windows 实测）。服务名用 `atelier` 是因为工具全名
`mcp__plugin_game-atelier_<服务名>__<工具名>` 不能超过 64 个字符。

默认授权不要再用 `claude mcp add` 手动注册：手动注册的服务与插件服务名字不同，两套工具会同时出现。
只有自定义授权才手动注册；`--scope user` 让所有项目都能用，`local` 只在执行命令的那个目录生效。
参见[Claude Code 官方 stdio 与 scope 文档](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server)。

```bash
claude mcp add --transport stdio --scope user <名字> -- <python> -m character_workflow.mcp --credentials <凭据绝对路径>
```

Codex 没有插件自带的 MCP，默认授权执行一次即可，之后重新授权不用再改；自定义授权在末尾加 `--credentials`。
这里的 CLI 命令会写入用户的 Codex MCP 配置，执行前确认作用范围。
参见[OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

```bash
codex mcp add game-atelier -- <python> -m character_workflow.mcp
```

路径有空格时给整个路径加引号；Windows 使用解释器和凭据文件的 Windows 绝对路径。
本机命令语法已对照 Codex CLI 0.137.0 和 Claude Code 2.1.162 的帮助核验；
这不等于已经完成这两个客户端的真实模型 / 权限弹窗验收。

## 工具可见与 Skill 可见是两件事

重启或刷新客户端连接后，先确认工具列表中存在 18 个 `workshop_*` 与 8 个 `canvas_*` 工具，再确认客户端加载了
本项目原有的 Character、Promo、Turnaround、UI 或 Video Skill。Claude Code 插件同时带来 Skill 与 MCP；
Codex 或手动注册 MCP 的客户端，Skill 需要另外安装。
不要为通过 MCP 检查给 Agent 开放整个 data root 或无关目录，也不要关闭客户端安全确认。

工具参数统一放在 `payload` 中，未知字段、类型转换、任意路径和额外的 `confirmed` 一律拒绝。
例如列授权项目：

```json
{"payload":{"page":1,"page_size":20}}
```

角色生成的流程是：

1. `workshop_list_projects` 取得被授权的项目，`workshop_list_targets` 按名称定位目标，
   再用返回的明确目标调用 `workshop_get_context`。
2. 读取 `workshop_list_models` 与需要的文档。写文档必须带读取时的 `expected_revision` 和幂等键，
   不能把截断上下文当作完整文档覆盖保存。
3. 调用 `workshop_prepare_generation`，保存返回的 request ID。此时不会调用供应商。
4. 请用户在 Atelier 页面核对供应商、提示词、素材和费用，再人工批准。
5. 用 `workshop_get_generation` 查询该请求，读取原 Job 的状态与产物引用。

没有通用文件 / HTTP / shell 工具。授权含 `execute_generation` 时，Agent 在用户明确确认后可用
`workshop_approve_generation` 批准自己准备的请求；不含时重试 prepare 或伪造布尔值都不能代替页面批准。权限不足时应回到本机管理页授权，不能改走 shell 或直接调用供应商。

新项目三锚使用 `project` 文档目标，尚无页面的 UI 方案使用 `ui_scheme` 文档目标；
两者都不能直接准备生成，不需要先创建占位角色或页面。原有 Skill 的操作约束见
[共享 MCP 工作流](references/workshop-mcp-workflow.md)。

## 错误与撤销

| 结果 | 处理 |
| --- | --- |
| `CREDENTIALS_INVALID` | 默认授权：在「本机连接」页点「连接本机 Agent」后直接重试；自定义授权：重新授权并更新 `--credentials`；不放宽文件权限 |
| `LOCAL_SERVICE_UNAVAILABLE` | 先正常启动本机 Atelier；写请求可能已提交时先查询状态，不能盲目重复 |
| `PROTOCOL_MISMATCH` | 更新本机服务后重新连接，不退回匿名接口 |
| `SESSION_REVOKED` / `CAPABILITY_DENIED` | 本次授权不允许操作，在管理页明确调整 |
| `DOCUMENT_CONFLICT` | 重新读取最新完整文档再修改，不能强制覆盖 |
| `EXECUTION_NEEDS_REVIEW` | 在 Atelier 人工核对上游结果，不自动重提付费生成 |

在本机管理页撤销 Agent 授权后，派生工具会话不能继续调用。撤销不会删除项目，
也不能追回已送往供应商的请求或已下载的内容。

MCP 限制的是本工具服务，不是整个 Agent：如果宿主另外授予了 shell、文件系统或其他供应商工具，
那些权限不受此授权约束。

## 开发回归与验收边界

```bash
uv run pytest -q tests/test_workshop_mcp.py tests/test_mcp_sdk_dependency.py
```

`test_workshop_mcp.py` 启动真实 SDK 客户端与本模块子进程，用隔离 HTTP 服务验证 18 个工具的
序列化、严格输入、会话换取、撤销、实例变化、结果大小、禁止代理 / 重定向和错误脱敏。
另有真实 `build_app` 集成：通过本机浏览器鉴权创建授权，再经 MCP 创建角色、读写实际文档、
读写新项目 GDD 与空 UI 方案规范、验证目标发现 / 幂等 / 冲突，撤销后立即拒绝工具调用。
所有数据均在隔离测试目录，不读取真实用户数据，
也不进行真实扣费。
`test_mcp_sdk_dependency.py` 仅是 SDK 依赖探针，不能当作工坊业务完成的证据。

工坊“准备 → Web 批准 → Job Runner → 原目录产物”的领域回归单独执行；真实 Codex / Claude
模型调用、客户端权限弹窗与各 Skill 的端到端验收需在隔离配置和项目中记录，不修改当前用户的
登录、模型、全局工具或 Skill 安装。没有额外付费授权不做真实供应商出图。
