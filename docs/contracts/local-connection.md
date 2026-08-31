# 本机连接契约

> 连接握手已实现（P1a）；完整网站协议 `atelier-local/1` 尚未实现。
> 除 `/api/connection/status` 外，下列新端点均为目标契约，不能当作当前可用 API。
> 范围与阶段见[开发说明](../local-workspace.md)。正常数据 API 仍遵循 [API 契约](../api-contract.md)。

## 身份与信任

每次 viewer-server 启动创建随机 `instance_id`，进程停止或更换数据目录后失效。
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

配对码只能由本地管理页创建；网站不能自行创建码，也不能通过“首次请求的 Origin 自动绑定”抢占服务。
`OPTIONS` 只允许已经登记的待配对 / 已配对 Origin，精确响应允许的方法和头，设置 `Vary: Origin`；
不用 `Access-Control-Allow-Origin: *`，也不把 CORS 当身份验证。其它请求体在鉴权前不能被完整读取。

### 拟新增端点

| 方法与路径 | 身份 | 请求 / 响应重点 |
| --- | --- | --- |
| `GET /api/connection/status` | 无 | `{ service: "game-atelier", instance_id, app_version, protocol }`；P1a 的 protocol 固定为 null，完整鉴权就绪后才声明 `"atelier-local/1"`；不含目录、项目数、Key 或会话 |
| `POST /api/connection/local-session` | 本地同源引导 | 本地 cookie；无业务数据 |
| `POST /api/connection/pairings` | 本地管理 | `{ origin }` → `{ pairing_code, expires_at, instance_id }` |
| `POST /api/connection/pair` | 已登记的待配对 Origin | `{ pairing_code, instance_id }` → `{ session_token, session_id, expires_at, capabilities }` |
| `GET /api/connection/sessions` | 本地管理 | 会话名称、Origin、项目范围、过期时间；永不返回令牌 |
| `DELETE /api/connection/sessions/{id}` | 本地管理或当前会话自撤销 | 撤销身份及其编辑租约、媒体票据和事件流 |
| `POST /api/connection/editor-lease` | 编辑页面 | 显式申请唯一编辑租约，冲突返回 `EDITOR_IN_USE`；不静默踢出旧页 |
| `DELETE /api/connection/editor-lease` | 租约持有者 | 主动释放，不撤销仍需使用的本地管理能力 |
| `POST /api/connection/media-tickets` | 有对应资源读取权的页面 | `{ resources: [{ path, query }] }` → 每项受限 URL 与 `expires_at` |

这些端点与其 schema 在实现 PR 中同时落到 Python、TS 和测试；版本号不取代协议版本。
Web 与服务必须协商同一个受支持协议；不匹配时停止读取与写入，显示更新指引，不试旧式匿名 API。
`protocol: null` 明确表示只有本机发现能力，不能配对或从网站读取业务 API。

P1a 启动器以 `.runtime/server.instance` 和状态响应比对实例，不再读取 `/api/config`。
探测固定回环地址，禁用代理与重定向、限制响应大小、检查服务名与 schema；状态响应禁止缓存。
已有存活 PID 但实例无法核验时，启动器拒绝覆盖记录、再开第二个服务或向该 PID 发停止信号。
旧版常驻服务须在更新前正常退出；不能靠自动探测失败触发 stop→start 来“升级”，以免中断生成。
此切片没有开放 CORS、配对或鉴权业务能力，不改变下列权限设计的未实现状态。

### 编辑租约与换连接

租约绑定页面随机 `client_id`，不能仅绑定共享 cookie 或被复制到新标签页的 sessionStorage。
编辑页面每 10 秒续约，30 秒无续约则失去编辑能力。旧页恢复网络后必须重新申请，不能携旧租约写入。
本地管理页可显式撤销旧租约，但必须提示尚未保存的内容可能只在旧页；服务端不能宣称已保存未知草稿。

用户在旧页释放或在本地管理页强制接管后，新页重新加载服务器内容。旧页保持只读并保留草稿导出入口；
草稿不自动重放到新修订。编辑租约不替代已有 Canvas revision 冲突控制。
换地址、换实例、撤销和 data root 变更均使当前 Web 连接 generation 递增，取消请求 / 上传 / SSE，
释放对象 URL、清空连接级查询缓存；旧 generation 的响应即使晚到也不能写入新页面状态。

## 媒体、下载和事件

### 资源级媒体票据

原生 `<img>` / `<video>` / `<audio>` 和下载链接不能统一附带 Authorization。
不依赖第三方 cookie，不把完整会话 bearer 放进媒体 URL，也不把大视频全量下载成 Blob。
页面用已认证 POST 为具体资源换取短期、只读票据，作为该资源 URL 的 query 值。

- 票据绑定实例、会话、精确规范化资源路径与 query、GET / HEAD、用途及到期时间；初始有效期 2 分钟。
  服务端只接受内部媒体 / 下载路由白名单，不接受绝对 URL、跳转目标或任意 API 地址。
- 发行与使用时均验证对象归属和路径白名单；票据不能用于目录列举、JSON API、写操作或换其它资源。
  `/raw` 现有 Job 白名单与路径包含性检查继续有效；符号链接、编码路径穿越、重复 query 不得绕过。
- 每个 Range / HEAD 请求重新验证，过期后客户端刷新票据并恢复播放位置；已撤销会话不能刷新。
  验证期间要实际测试拖动、暂停超过有效期后继续，以及多小时视频；不通过则不能发布该链路。
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
| 401 | `CONNECTION_REQUIRED` / `SESSION_EXPIRED` | 进入未连接状态；停止后台读取 |
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

用户指定先用 Vercel 免费方案测试；部署前核实账号计划适用范围、项目权限和当前限制，不购买升级。
使用平台 HTTPS 域名，构建目标为 `web/` 的静态 Vite 产物，不能部署 viewer-server、用户项目或 Key。
配置 SPA 刷新路由；Vercel Functions 不能代理访问用户电脑的 127.0.0.1。可参考
[Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite) 的框架与路由说明。

每个预览域名都是独立 Origin，需要在本机显式授权；不信任 `*.vercel.app`，不自动继承另一分支站点的权限。
优先用一个固定测试项目域名，避免每次预览换地址导致误连；网站代码升级仍保持协议版本检查。
首次部署只用隔离测试数据与 fake provider，确认无密钥、路径、真实作品进入静态包、构建日志或浏览器遥测。
