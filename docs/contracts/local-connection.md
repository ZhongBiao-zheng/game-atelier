# 本机连接契约

> 本地整合已实现握手、Host / Origin 边界、会话、编辑租约、Agent 授权与统一传输。
> 托管网站方案（网站配对、CORS、媒体令牌）已于 2026-10-14 弃用并删除，见 [ADR-0023](../adr/0023-drop-hosted-website.md)；
> 只有本机页面与本机 Agent 两种访问方式。正常数据 API 仍遵循 [API 契约](../api-contract.md)。

## 身份与信任

每次 viewer-server 启动创建随机 `instance_id`，进程停止后失效。实例标识服务进程；
更换数据目录会撤销该进程的全部会话与编辑租约，新目录重新核验授权，不迁移旧连接。
`instance_id` 只识别连接对象，不是密码。服务只监听 `127.0.0.1`；Host 必须为实际监听的
`127.0.0.1:<port>`，不能因域名解析到回环地址就接受任意 Host。

角色与能力必须在服务端声明：

| 身份 | 可读写的范围 | 明确不能做的事 |
| --- | --- | --- |
| 未连接 | 静态页面、最小状态 | 项目、配置、媒体、事件、OpenAPI 内部信息 |
| 本地管理会话 | 同源本机设置、Agent 连接开关、批准页面 | 不因发一个 GET 就产生配置或付费写入 |
| 编辑页面会话 | 用户自己的 Atelier 数据与现有交互，持有唯一编辑租约 | 只读页面不能写入；写入需持有编辑租约 |
| 工坊工具会话 | 全部项目与画布的 typed tools 与结果（ADR-0022） | 原始 Key、全库文件、Canvas、Studio 提交、批准自身请求、管理其它授权 |

本地页面可以在同一个浏览器会话中获得管理能力和编辑租约。
工具会话不占编辑租约，但所有写操作都带目标与修订检查。
本机同一 OS 用户已能直接读写其文件，不属于 MCP 能隔离的攻击者；本协议不能替外部 Agent 的
shell / 文件系统权限提供沙箱。

所有 API 先校验 Host，再校验身份、Origin、能力和对象归属，最后读取请求资源或执行操作。
路由使用显式能力登记，未登记的新路由默认拒绝；不能只保护新增 `/connection` 和 `/workshop`。
`/api/raw`、图库、导入导出、附件下载、`/events`、OpenAPI / docs 与 SPA fallback 都必须纳入审核。
API 认证失败不能掉进 SPA 返回 200，也不能跳转到调用者提交的地址。

## 本地管理会话

`POST /api/connection/local-session` 只允许实际本机页面的精确 Origin，以及浏览器 same-origin
Fetch Metadata；不接受无 Origin 的匿名请求，不提供 CORS。响应创建随机本地会话，
使用 HttpOnly、SameSite=Strict、Path=/ 的 cookie；回环 HTTP 的 cookie 不假设具有公网 HTTPS 的 Secure 属性。
状态变更继续要求正确 Origin、JSON 内容类型及会话，避免跨站表单和无读权限的 CSRF。

开发环境 Vite 入口只能由显式开发启动模式登记精确 Origin，生产不得信任所有 localhost 端口。
非浏览器维护命令不能伪造 Origin 获取管理身份，应使用用户启动本机服务时建立的专用 OS 受保护通道。

Agent 的 Authorization 与本地管理 cookie 不可混用，有冲突的凭据拒绝。

### 连接端点

当前 status 的 protocol 为 `atelier-local/2`。
本地引导 `{}` 返回 `{ session_id, instance_id, expires_at }` 并设置最长 12 小时 cookie。
租约 POST 接收 `{ client_id, takeover?: false }`，DELETE 接收 `{ client_id }` 并返回 204。
控制请求最大 16 KiB，每实例最多 64 会话，每会话最多 4 路事件流。

| 方法与路径 | 身份 | 请求 / 响应重点 |
| --- | --- | --- |
| `GET /api/connection/status` | 无 | `{ service: "game-atelier", instance_id, app_version, protocol }`；当前为 `"atelier-local/2"`；不含目录、项目数、Key 或会话 |
| `POST /api/connection/local-session` | 本地同源引导 | 本地 cookie；无业务数据 |
| `POST /api/connection/editor-lease` | 编辑页面 | 显式申请唯一编辑租约，冲突返回 `EDITOR_IN_USE`；不静默踢出旧页 |
| `DELETE /api/connection/editor-lease` | 租约持有者 | 主动释放，不撤销仍需使用的本地管理能力 |

这些端点与其 schema 在实现 PR 中同时落到 Python、TS 和测试；版本号不取代协议版本。
Web 与服务必须协商同一个受支持协议；不匹配时停止读取与写入，显示更新指引，不试旧式匿名 API。

P1a 启动器以 `.runtime/server.instance` 和状态响应比对实例，不再读取 `/api/config`。
探测固定回环地址，禁用代理与重定向、限制响应大小、检查服务名与 schema；状态响应禁止缓存。
已有存活 PID 但实例无法核验时，启动器拒绝覆盖记录、再开第二个服务或向该 PID 发停止信号。
旧版常驻服务须在更新前正常退出；不能靠自动探测失败触发 stop→start 来“升级”，以免中断生成。
P1b 对所有请求校验 ASGI socket 的实际监听地址和端口，不能用 Host / Forwarded 自报值作为信任依据。
仅接受 `127.0.0.1:<port>`（默认 80 端口省略）；重复 Host / Origin / Fetch Metadata 头拒绝。
有 Origin 时必须是精确本机来源；有 Fetch Metadata 时要求 same-origin。唯一例外是无外站 Origin 的
顶层 GET 文档导航到公开页面；API、媒体、SSE、OpenAPI / docs 不在例外内。
拒绝在读取请求体前发生，包括 Canvas 大请求体检查前。WebSocket 尚未提供，统一拒绝。

Vite 通过 `GAME_ATELIER_DEV_ORIGIN=http://localhost:5173` 显式登记一个开发来源；必须精确匹配，
只接受带端口的 HTTP localhost / 127.0.0.1，不接受外站或通配。代理改写 Host 到实际后端，保留 Origin。
生产运行不设置该变量。

P1b 本身不是鉴权；当前整合在其内侧增加 cookie / bearer 身份和显式能力登记，
无 Origin / Fetch Metadata 的原生本机业务请求也必须认证。bearer 只走 Agent 入口，带 Origin 或
Fetch Metadata 的 bearer 一律拒绝。

### 编辑租约与换连接

本机服务连接与外部 Agent 授权独立。页面启动静默握手，不因未安装 Claude / Codex 弹出连接窗口；
启动失败在原位显示服务提示，不引导 Agent 配置。设置已有“本机 Agent 连接”是主动授权入口。
已加载页面断连保留组件与草稿，轻量提示暂停保存并阻止修改（包括 Portal 控件、画布粘贴），不声称已保存。
控制请求超时 8 秒；网络中断、临时 5xx、会话自然过期最多自动恢复 3 次，间隔 1/2/4 秒。
429 等待时间不得短于 Retry-After。撤销、安全拒绝、实例变化和协议不符须人工处理，不自动重试。
恢复后只补发一次失败的 GET / HEAD 请求；生成、保存、上传、删除等业务写入不排队、不自动重发。
编辑冲突默认只读；仅用户点击“接管编辑”才弹出风险确认。页面离开取消待恢复连接，旧连接响应作废。

租约绑定页面随机 `client_id`，不能仅绑定共享 cookie 或被复制到新标签页的 sessionStorage。
编辑页面每 10 秒续约，30 秒无续约则失去编辑能力。旧页恢复网络后必须重新申请，不能携旧租约写入。
本地管理页可显式撤销旧租约，但必须提示尚未保存的内容可能只在旧页；服务端不能宣称已保存未知草稿。

用户在旧页释放或在本地管理页强制接管后，新页重新加载服务器内容。旧页保持只读并保留草稿导出入口；
草稿不自动重放到新修订。编辑租约不替代已有 Canvas revision 冲突控制。
换地址、换实例、撤销和 data root 变更均使当前 Web 连接 generation 递增，取消请求 / 上传 / SSE，
释放对象 URL、清空连接级查询缓存；旧 generation 的响应即使晚到也不能写入新页面状态。

## 媒体、下载和事件

本地页面的原生媒体、上传与下载使用同源 HttpOnly cookie，所有资源路由仍经鉴权和原白名单校验。
同源媒体不另造 URL 令牌。`/events` 使用带身份的 fetch 事件流，撤销 / 到期后关闭。

### 事件流

用同一个连接层的带鉴权 `fetch` 读取现有 SSE，不把长期令牌放入 `/events` URL。
解析按 SSE 帧而非网络 chunk，处理 CRLF、多行 data、分片、心跳与有界帧大小；可复用可靠实现时优先复用，
新增依赖仍需批准。重连只在会话有效且 generation 未改变时进行，并清理定时器和 AbortController。

事件是失效通知，不是持久真源；断线重连后重取相关索引 / Job，不能靠无重放保证的 SSE 补全所有状态。
MCP 首版查询任务状态，不开放全库广播。服务端撤销授权时主动关闭旧事件流，
不能只在最初连接时鉴权。连接丢失不自动重提生成或重放内容修改。

## 统一 Web 传输的完成标准

请求包装器、媒体解析与事件订阅由一份 connection state 驱动；非 UI 模块可以取得受控客户端，
但不能读取令牌。客户端使用现有 React 状态，不引入新全局状态库。JSON 和 multipart 保持各自正确请求头，
不把 FormData 强制转 JSON，上传支持取消和服务端大小限制。

审计范围至少包括 `MainApp`、`Studio`、`Home`、项目索引 / 画廊、Character / UI / Video 工作区、
Canvas 媒体与导入导出、资产库、FirstRunConfig、Feedback、Spec、Clipboard、Filmstrip、useActiveCharacter。
验收时全仓搜索直接 `fetch`、`EventSource`、`/api/raw`、`/api/gallery/image`、媒体 `src` 与下载 `href`；
每个剩余调用须属于连接层或有明确同源静态资源理由。

原始 Key 的 reveal / create / update / delete、models-preview、系统目录选择、data root 切换、
服务器控制与授权管理保持本地管理专属。不能传任意本机路径来模拟上传，使用浏览器 File 正式上传。

## 错误与限制

错误形状：`{ error: { code, message, request_id } }`，message 简短中文且无令牌、Key、绝对敏感路径。
`request_id` 仅用于本机日志定位，不包含参数。既有业务错误仍沿用业务契约，连接层只统一连接错误。

| HTTP | code | 页面处理 |
| --- | --- | --- |
| 401 | `CONNECTION_REQUIRED` / `SESSION_EXPIRED` | 暂停业务请求；仅自然过期允许有限自动握手恢复，其余手动重连 |
| 421 | `HOST_DENIED`（P1b 已实现） | 请求 Host 与实际监听地址 / 端口不符，拒绝路由 |
| 403 | `ORIGIN_DENIED` / `CAPABILITY_DENIED` / `SESSION_REVOKED` | 不重试；显示连接或权限原因 |
| 409 | `INSTANCE_CHANGED` / `EDITOR_IN_USE` / `REVISION_CONFLICT` | 保留草稿，要求重连 / 接管 / 重取，不覆盖 |
| 426 | `PROTOCOL_MISMATCH` | 展示双方版本与更新入口，不调用不兼容业务 API |
| 429 | `CONNECTION_RATE_LIMITED` | 按 Retry-After 退避 |

连接控制请求最多 16 KiB。上传与 Canvas 文档继续沿用业务上限，
另逐路由补全未限制的大请求；不得把 16 KiB 套到真实文件上传。Agent 换会话限流、会话总数、事件连接数
在实现时设显式上限并测试，不允许内存集合无限增长。
