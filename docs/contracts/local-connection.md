# 本机连接契约

> 本地整合已实现握手、Host / Origin 边界、会话、编辑租约、Agent 项目授权与统一传输。
> `atelier-local/2`（5.53.0 起）在此之上实现网站配对、按登记来源的 CORS 与会话级只读媒体令牌。
> 真实 HTTPS 站点的浏览器联调在首次 Vercel 部署后进行，通过前浏览器支持状态标「未验证」。
> 范围与阶段见[开发说明](../local-workspace.md)。正常数据 API 仍遵循 [API 契约](../api-contract.md)。

## 身份与信任

每次 viewer-server 启动创建随机 `instance_id`，进程停止后失效。实例标识服务进程；
更换数据目录会撤销该进程的全部会话与编辑租约，新目录重新核验授权，不迁移旧连接。
`instance_id` 只识别连接对象，不是密码。服务只监听 `127.0.0.1`；Host 必须为实际监听的
`127.0.0.1:<port>`，不能因域名解析到回环地址就接受任意 Host。

角色与能力必须在服务端声明：

| 身份 | 可读写的范围 | 明确不能做的事 |
| --- | --- | --- |
| 未连接 | 静态页面、最小状态、限流配对请求 | 项目、配置、媒体、事件、OpenAPI 内部信息 |
| 本地管理会话 | 同源本机设置、配对管理、Agent 项目授权、批准页面 | 不因发一个 GET 就产生配置或付费写入 |
| 编辑页面会话 | 用户自己的 Atelier 数据与现有交互，持有唯一编辑租约 | 网站不可读原始 Key、改 Key、选本机目录、切换 data root、管理授权或安装 Agent |
| 工坊工具会话 | 被授权项目内的工坊 typed tools 与结果 | 原始 Key、全库文件、Canvas、Studio 提交、批准自身请求、管理其它授权 |

本地页面可以在同一个浏览器会话中获得管理能力和编辑租约；网站只有编辑能力。
工具会话不占编辑租约，但所有写操作都带目标与修订检查。
本机同一 OS 用户已能直接读写其文件，不属于 MCP 能隔离的攻击者；本协议不能替外部 Agent 的
shell / 文件系统权限提供沙箱。网站 Origin 被攻陷也会危及其已授权数据，必须最小化网站第三方脚本。

所有 API 先校验 Host，再校验身份、Origin、能力和对象归属，最后读取请求资源或执行操作。
路由使用显式能力登记，未登记的新路由默认拒绝；不能只保护新增 `/connection` 和 `/workshop`。
`/api/raw`、图库、导入导出、附件下载、`/events`、OpenAPI / docs 与 SPA fallback 都必须纳入审核。
API 认证失败不能掉进 SPA 返回 200，也不能跳转到调用者提交的地址。

## 本地管理会话

`POST /api/connection/local-session` 只允许实际本机页面的精确 Origin，以及浏览器 same-origin
Fetch Metadata；不接受无 Origin 的匿名请求，不向网站提供 CORS 权限。响应创建随机本地会话，
使用 HttpOnly、SameSite=Strict、Path=/ 的 cookie；回环 HTTP 的 cookie 不假设具有公网 HTTPS 的 Secure 属性。
状态变更继续要求正确 Origin、JSON 内容类型及会话，避免跨站表单和无读权限的 CSRF。

开发环境 Vite 入口只能由显式开发启动模式登记精确 Origin，生产不得信任所有 localhost 端口。
非浏览器维护命令不能伪造 Origin 获取管理身份，应使用用户启动本机服务时建立的专用 OS 受保护通道。

本地同源 cookie 不作为网站跨站身份。网站的 Authorization 与本地管理 cookie 不可混用，
有冲突的凭据拒绝；带管理 cookie 也不能让网站来源调用管理端点。

## 网站配对

1. 用户显式启动本机服务并打开本地管理页。在该页填写或确认网站的精确 HTTPS Origin。
   禁止通配符、`null`、`file:`、`data:`、含用户名密码的 URL 和任意子域。
2. 本地页创建高熵一次性配对码，绑定 `instance_id`、目标 Origin、5 分钟有效期与拟授予范围。
   用户复制到网站；不把码放进 URL、shell 参数、日志、二维码链接或仓库配置。
3. 网站在用户点击“连接”后请求回环服务；浏览器可能先要求本地网络权限。只连接明确给出的
   `http://127.0.0.1:<port>`，不自动扫描端口、局域网或其它主机。
4. 服务原子消费配对码，签发绑定 Origin、实例与能力的随机 bearer 会话，最长 12 小时有效。
   码过期、用过、来源不符或实例已变均不建立会话。失败有统一错误和速率限制，不能暴露码是否存在。
5. 网站在页面内存使用令牌，并以 sessionStorage 支持同标签刷新恢复；不得持久写
   localStorage、IndexedDB、Service Worker 或 URL。服务端只存令牌摘要，撤销记录在同进程生效。

第 5 步中的 sessionStorage 是唯一允许的刷新恢复缓存：只保存当前实例、来源、令牌和过期时间，
不保存 Key 或项目内容；断开立即清除。它仍可被同源脚本读取，不应被描述为 HttpOnly 或防 XSS 存储。
初次实现统一采用这一策略，不同时保留多个持久化方案。

实现要点（5.53.0）：配对码 `secrets.token_urlsafe(24)`，服务端只存 SHA-256 摘要，同一来源只保留最新一枚，
待配对最多 8 个；配对与 Agent 会话共用每分钟 30 次的尝试限流。网站会话 kind 为 `site`，能力固定 `read` / `edit`，
可申请编辑租约；控制端点只开放 `editor-lease`、`media-token` 与撤销自己。Origin 校验允许 `https://` 任意主机
和 `http://localhost|127.0.0.1:<port>`（后者只为本地 `vite preview` 验证托管模式，生产网站必须 HTTPS）。
托管网站直接进入界面，不调用 `/api/onboarding/status`（含本机路径，属管理端点）。

配对码只能由本地管理页创建；网站不能自行创建码，也不能通过“首次请求的 Origin 自动绑定”抢占服务。
`OPTIONS` 只允许已经登记的待配对 / 已配对 Origin，精确响应允许的方法和头，设置 `Vary: Origin`；
不用 `Access-Control-Allow-Origin: *`，也不把 CORS 当身份验证。其它请求体在鉴权前不能被完整读取。
边界层对已登记来源的所有响应（含 401 / 403 拒绝）都附精确 `Access-Control-Allow-Origin`，否则浏览器
只能看到不透明的网络错误；预检带 `Access-Control-Request-Private-Network` 时回 `Allow-Private-Network: true`
（旧版 Chrome PNA 预检，新版走本地网络权限弹窗）。待配对码过期或网站会话撤销后，该来源立刻回到 403。

### 连接端点

当前 status 的 protocol 为 `atelier-local/2`；表中 `media-tickets` 已由会话级 `media-token` 取代（见下）。
本地引导 `{}` 返回 `{ session_id, instance_id, expires_at }` 并设置最长 12 小时 cookie。
租约 POST 接收 `{ client_id, takeover?: false }`，DELETE 接收 `{ client_id }` 并返回 204。
控制请求最大 16 KiB，每实例最多 64 会话，每会话最多 4 路事件流。

| 方法与路径 | 身份 | 请求 / 响应重点 |
| --- | --- | --- |
| `GET /api/connection/status` | 无 | `{ service: "game-atelier", instance_id, app_version, protocol }`；当前为 `"atelier-local/2"`，托管网站据此判断本机是否需要更新；不含目录、项目数、Key 或会话 |
| `POST /api/connection/local-session` | 本地同源引导 | 本地 cookie；无业务数据 |
| `POST /api/connection/pairings` | 本地管理 | `{ origin }` → `{ pairing_code, origin, expires_at, instance_id }`；来源不合规 422 |
| `POST /api/connection/pair` | 已登记的待配对 Origin | `{ pairing_code, instance_id }` → `{ session_token, session_id, instance_id, expires_at, capabilities }`；码错 / 过期 / 来源不符统一 403 `SESSION_REVOKED`，实例不符 409 |
| `GET /api/connection/sessions` | 本地管理 | 会话 kind、名称、`origin`、项目范围、过期时间；永不返回令牌 |
| `DELETE /api/connection/sessions/{id}` | 本地管理或当前会话自撤销 | 撤销身份及其编辑租约、媒体令牌和事件流 |
| `POST /api/connection/media-token` | 网站会话 | `{}` → `{ media_token, expires_at }`；见「媒体令牌」 |
| `POST /api/connection/editor-lease` | 编辑页面 | 显式申请唯一编辑租约，冲突返回 `EDITOR_IN_USE`；不静默踢出旧页 |
| `DELETE /api/connection/editor-lease` | 租约持有者 | 主动释放，不撤销仍需使用的本地管理能力 |

这些端点与其 schema 在实现 PR 中同时落到 Python、TS 和测试；版本号不取代协议版本。
Web 与服务必须协商同一个受支持协议；不匹配时停止读取与写入，显示更新指引，不试旧式匿名 API。
`protocol: null` 明确表示只有本机发现能力，不能配对或从网站读取业务 API。

P1a 启动器以 `.runtime/server.instance` 和状态响应比对实例，不再读取 `/api/config`。
探测固定回环地址，禁用代理与重定向、限制响应大小、检查服务名与 schema；状态响应禁止缓存。
已有存活 PID 但实例无法核验时，启动器拒绝覆盖记录、再开第二个服务或向该 PID 发停止信号。
旧版常驻服务须在更新前正常退出；不能靠自动探测失败触发 stop→start 来“升级”，以免中断生成。
P1b 对所有请求校验 ASGI socket 的实际监听地址和端口，不能用 Host / Forwarded 自报值作为信任依据。
仅接受 `127.0.0.1:<port>`（默认 80 端口省略）；重复 Host / Origin / Fetch Metadata 头拒绝。
有 Origin 时必须是精确本机来源；有 Fetch Metadata 时要求 same-origin。唯一例外是无外站 Origin 的
顶层 GET 文档导航到公开页面，以便从网站链接打开本地页面；API、媒体、SSE、OpenAPI / docs 不在例外内。
拒绝在读取请求体前发生，包括 Canvas 大请求体检查前。WebSocket 尚未提供，统一拒绝。

Vite 通过 `GAME_ATELIER_DEV_ORIGIN=http://localhost:5173` 显式登记一个开发来源；必须精确匹配，
只接受带端口的 HTTP localhost / 127.0.0.1，不接受外站或通配。代理改写 Host 到实际后端，保留 Origin。
生产运行不设置该变量；网站配对不能借用这个入口。

P1b 本身不是鉴权；当前整合在其内侧增加 cookie / bearer 身份和显式能力登记，
无 Origin / Fetch Metadata 的原生本机业务请求也必须认证。带 Origin 的 bearer 只在该 Origin 已登记为网站时
按 `site` 会话鉴权；不带 Origin 的 bearer 仍走 Agent 入口，网站令牌放到那里是错误身份而非匿名。

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

### 会话级媒体令牌（5.53.0 实现；替代原「逐资源票据」方案）

原生 `<img>` / `<video>` / `<audio>` 和下载链接不能统一附带 Authorization。
不依赖第三方 cookie，不把完整会话 bearer 放进媒体 URL，也不把大视频全量下载成 Blob。
网站会话用 `POST /api/connection/media-token` 换取一枚只读媒体令牌，作为媒体 URL 的 `media_token` query 值：

- 令牌 30 分钟有效、随会话撤销；每会话最多保留 4 枚，前端每 20 分钟换新，旧令牌到期前仍可用，
  已加载的 `<img>` / `<video>` 不会因换令牌而重新请求。
- 边界层只对 GET / HEAD 的媒体路由（`MEDIA_ROUTES`：raw / images / gallery image / 创作资产内容 /
  画布版本 media 与 download / 图层下载 / 工坊参考图）放行带令牌的 cross-site 请求；JSON API、写操作、
  连接控制端点带令牌一律拒绝。令牌与 cookie / Authorization 混用拒绝，重复出现拒绝。
- 与原方案的差异：令牌绑定会话而非单个资源。泄漏影响面是该会话已可读的媒体、最长 30 分钟；
  换来的是 30 余处同步 `<img src>` 无需改成异步取票。这是 2026-09-10 实现时的显式取舍：
  用户当日只定了「先补配对再上线」，未逐条审过票据方案，若要收紧回逐资源票据需另立任务。
- 连续播放超过令牌有效期的视频，后续 Range 请求会 401，需要刷新页面；属已知限制，未做自动续播。

以下条目保留原方案中仍然成立的约束（「票据」读作「令牌」）：

- 令牌只在服务端内部媒体 / 下载路由白名单上生效，不接受绝对 URL、跳转目标或任意 API 地址；
  不能用于目录列举、JSON API、写操作。`/raw` 现有 Job 白名单与路径包含性检查继续有效；
  符号链接、编码路径穿越、重复 query 不得绕过。
- 每个 Range / HEAD 请求重新验证令牌与会话；已撤销会话不能换新令牌。
- 票据 URL 不记录在 access log、异常上报、Referer、复制分享或 Job 中；页面与媒体使用
  `Referrer-Policy: no-referrer`，私有响应不进入共享缓存。撤销不能追回已下载或已缓冲的字节。
- Web 合并相同资源的并发取票，缓存有界（初始最多 64 项）并到期淘汰；按可见列表请求，
  不为整个作品库预签或预加载。普通图片缩略图与现有分页策略保持不变。
- 明确禁用本机 API 重定向，下载名称由服务端生成；导出 API 只返回当前会话可读取的下载资源。

### 事件流

用同一个连接层的带鉴权 `fetch` 读取现有 SSE，不把长期令牌放入 `/events` URL。
解析按 SSE 帧而非网络 chunk，处理 CRLF、多行 data、分片、心跳与有界帧大小；可复用可靠实现时优先复用，
新增依赖仍需批准。重连只在会话有效且 generation 未改变时进行，并清理定时器和 AbortController。

事件是失效通知，不是持久真源；断线重连后重取相关索引 / Job，不能靠无重放保证的 SSE 补全所有状态。
网站只收其页面权限内事件；MCP 首版查询任务状态，不开放全库广播。服务端撤销授权时主动关闭旧事件流，
不能只在最初连接时鉴权。连接丢失不自动重提生成或重放内容修改。

## 统一 Web 传输的完成标准

请求包装器、媒体解析与事件订阅由一份 connection state 驱动；非 UI 模块可以取得受控客户端，
但不能读取令牌。客户端使用现有 React 状态，不引入新全局状态库。JSON 和 multipart 保持各自正确请求头，
不把 FormData 强制转 JSON，上传支持取消和服务端大小限制。

审计范围至少包括 `MainApp`、`Studio`、`Home`、项目索引 / 画廊、Character / UI / Video 工作区、
Canvas 媒体与导入导出、资产库、FirstRunConfig、Feedback、Spec、Clipboard、Filmstrip、useActiveCharacter。
验收时全仓搜索直接 `fetch`、`EventSource`、`/api/raw`、`/api/gallery/image`、媒体 `src` 与下载 `href`；
每个剩余调用须属于连接层或有明确同源静态资源理由，不能留部分页面固定访问网站自己的 `/api`。

原始 Key 的 reveal / create / update / delete、models-preview、系统目录选择、data root 切换、
服务器控制与授权管理保持本地管理专属。网站模型列表只返回可使用的 alias 与能力，不返回 access key。
需要这些操作时给“在本机管理”入口；不能远程传任意本机路径来模拟上传，使用浏览器 File 正式上传。

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
| 429 | `CONNECTION_RATE_LIMITED` | 按 Retry-After 退避，禁止持续轮询配对 |

连接控制请求最多 16 KiB；单次媒体取票最多 32 个资源。上传与 Canvas 文档继续沿用业务上限，
另逐路由补全未限制的大请求；不得把 16 KiB 套到真实文件上传。无效配对限流、会话总数、事件连接数
在实现时设显式上限并测试，不允许内存集合无限增长。

## 启动、站点与验证

拟新增的 `viewer-server connect --site <https-origin>` 复用启动器：服务未启动才启动；已有实例正常则复用，
不 stop→start 中断生成。不以端口“有人响应”认定它就是本项目；验证 service、协议和记录的实例身份。
命令只打开带非敏感本机地址的网站及本地配对页面，不自动创建对任意来源的授权、不安装常驻开机服务。

静态站点独立构建，所有业务请求走连接层；原本地 dist 分发保留。生产构建不得依赖 Vite proxy，
不得把 data_root、`.runtime`、`.config`、源码调试信息或真实测试产物打包进站点。
站点部署需 HTTPS、正确 SPA 路由、限制第三方脚本的 CSP；`connect-src` / `media-src` 只放行
站点所需来源和字面回环地址，不接受用户任意远程 URL。控制端点 / 配对响应设置 `no-store`。

Chrome 的 [Local Network Access 文档](https://developer.chrome.com/blog/local-network-access)
说明访问回环还需安全上下文和用户权限；旧 PNA 头不能代替权限流程。浏览器拒绝、本机离线、
协议过旧分别呈现，不建议关安全开关。真实 HTTPS 联调通过前，本协议的浏览器支持状态一律标“未验证”。
测试至少覆盖本地页回归、HTTPS 配对、撤销中的 SSE、过期媒体续播、两个标签页接管、
旧实例迟到响应、跨项目资源票据、攻击 Origin / Host / CSRF、无网与端口变更。

### Vercel 测试站

用户 2026-09-10 确认：Vercel Hobby 绑自己的 GitHub 账号（ZhongBiao-zheng），Hobby 禁商用条款可接受。
使用平台 HTTPS 域名，构建目标为 `web/` 的静态 Vite 产物，不能部署 viewer-server、用户项目或 Key。
仓库根 `vercel.json` 固定：`cd web && npx pnpm@11.1.2` 安装与构建（与 CI 同版本，Vercel 默认 pnpm 不认
`pnpm-workspace.yaml` 的 `allowBuilds`）、输出 `web/dist`、SPA 重写、CSP（`connect-src` / `img-src` /
`media-src` 只放行 `'self'` 与 `http://127.0.0.1:*`，字体来自 Google Fonts）、`dev` 分支不触发部署。
Vercel Functions 不能代理访问用户电脑的 127.0.0.1。可参考
[Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite) 的框架与路由说明。

每个预览域名都是独立 Origin，需要在本机显式授权；不信任 `*.vercel.app`，不自动继承另一分支站点的权限。
优先用一个固定测试项目域名，避免每次预览换地址导致误连；网站代码升级仍保持协议版本检查。
首次部署只用隔离测试数据与 fake provider，确认无密钥、路径、真实作品进入静态包、构建日志或浏览器遥测。
