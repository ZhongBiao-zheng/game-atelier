# Canvas 节点插件与 Caller Adapter 安全边界方案

Status: ready-for-agent

## 结论摘要

推荐方案 A：**插件先下载为不可变、可校验的本地包，再在无同源、无网络的 sandbox iframe 中运行；
viewer-server 是唯一 capability broker。节点插件永远不能在宿主 React 页面直接 import，不能读凭证、
裸路径、任意项目数据，也不能自己调用模型。**

为了保留参考基线的官方/本地/第三方插件管理、远程 URL 安装、自定义节点、panel、toolbar、资源输出、
画布操作、四模态生成和缺失插件占位，同时适配 game-atelier：

- 安装器支持官方注册表、本地开发目录和第三方 URL。URL 仍是相同用户入口，但服务器先做 SSRF/大小/
  MIME/摘要校验并落入 staging；绝不把远端 JS 作为宿主页 Blob module 执行。
- 官方包由 game-atelier 发布密钥签名；第三方无签名包可以标记“未验证”后安装，但只能进入同一严格
  sandbox。签名证明发布者和完整性，不替代 sandbox 或权限审批。
- 插件安装在应用级缓存，启用和 capability grant 绑定具体 Canvas Project 与 package digest。安装不等于
  获得任何项目权限，更新也不自动启用新代码。
- 插件 UI 在 opaque-origin iframe 内渲染；节点卡、连接柄、浮动 toolbar、panel 外壳、选择和拖动仍由
  React Flow/宿主拥有。插件通过带 nonce 的 MessagePort 发送有 schema 的 RPC。
- 插件状态只进入当前项目的 plugin namespace；节点数据由宿主的 Plugin Node envelope 保存。插件缺失、
  禁用、迁移失败或崩溃时，项目仍可打开，payload、连接、Draft 和版本 pin 原样保留。
- 插件提出跨节点/连接修改时使用与 Canvas Agent 同一领域命令和 Change Set validator；不能提交完整文档、
  任意 JSON Patch、Job/Snapshot/Derivation 字段或浏览器快照覆盖。
- 插件的文本/图片/视频/音频生成统一形成 Generation Draft 和独立逐次确认的 Run；viewer-server 冻结
  Snapshot 后交 Job Runner。插件只收到 job/candidate handle 和安全结果引用，不获得 key/base URL。
- 节点插件与服务端 Caller Adapter 是两种不同信任级别。第一版自定义模型调用使用无代码的 declarative
  Caller Profile；可执行 Caller Adapter 只允许随应用发布、签名且经源码审核的内建模块。
- SDK 采用 `@game-atelier/canvas-plugin-sdk` 的等价契约，不追求与参考项目 React component ABI 兼容；
  五个官方示例作为移植与验收 fixture，外观改用 Atelier token。

## 参考基线源码核对

固定基线：`basketikun/infinite-canvas@9414048f9d0a099386aa15d81bedb5376b79ee61`。

### 实际能力

| 能力 | 固定基线实际实现 | 本项目结论 |
|---|---|---|
| 远程安装 | fetch JS 文本，再 `import(blobUrl)` | 保留 URL 入口，改为服务器 staging + sandbox 执行 |
| 官方注册表 | jsDelivr JSON 清单，entry 指向 JS | 改为签名 manifest、文件摘要与固定 digest |
| 本地开发 | `/plugins/index.json` 或 `VITE_DEV_PLUGINS` | 显式 Developer Mode + 受控目录，仍走 sandbox |
| 离线/版本 | IndexedDB 保存 URL、源码、version | 保存不可变包；digest 才是实际版本 pin |
| renderer/panel | 远程 React component 直接挂宿主树 | iframe surface；宿主保留 chrome 与 React Flow |
| toolbar | 插件返回带闭包的 ReactNode/button | 插件返回纯数据 action descriptor，宿主渲染按钮 |
| 图读取/写入 | 可读全部 node/connection，直接 apply Agent ops | project grant + 最小读模型；跨节点写走 Change Set |
| 状态 | plugin id 的全局 localforage store | project + plugin id + digest namespace sidecar |
| AI | 浏览器注入 image/video/text 方法；内置 panel 另含 audio mode | 四模态全部经 Job Runner 和逐次确认 |
| 重依赖 | 插件可从 esm.sh 动态 import | runtime 网络默认全禁；依赖随包 vendored |
| 样式 | CSS 直接写入宿主 document.head | 只作用于插件 iframe，不污染宿主 |
| 缺失插件 | 节点显示 missing placeholder，metadata 仍在项目 | 保留并增强为可诊断、可恢复占位 |

### 文档与运行时不一致

- 产品文档说插件可贡献 serialization、deserialization 与 migration；固定 SDK/loader 没有对应字段或调用点。
  实际数据生存来自“节点 metadata 本来就在项目 JSON 中”，版本更新则直接替换代码。
- `CanvasPluginAi` 的直接方法只有 image/video/text；audio 出现在 `useBuiltinPanel.mode`，不是
  `generateAudio()`。
- 官方警告明确说明插件直接运行在当前页面，可访问包含 AI API Key 的本地数据。loader 还把宿主 React、
  DOM CSS 注入、全图读取、applyOps 和全局事件总线交给插件。
- 官方/第三方更新用 cache-busting 重新拉取同一 URL，不校验发布者、摘要或迁移路径；同 id 会直接替换。
- HTML 节点自身用了 sandbox iframe，但这是该节点内容的隔离，不是插件代码的隔离；插件模块已经先在
  宿主页执行。

因此 H05 的“迁移”不能按不存在的运行时 API 搬运，H10 的页面/密钥访问也必须继续排除。

## 信任边界

```text
官方注册表 / 第三方 HTTPS URL / 本地开发目录
                    │ 仅安装器可访问
                    ▼
viewer-server Plugin Installer
  ├─ URL/redirect/DNS/大小/MIME/压缩包校验
  ├─ manifest + file digest + signature 校验
  ├─ immutable staging / cache / rollback
  └─ 不执行插件代码
                    │ package digest
                    ▼
Canvas Project Plugin Grant
  └─ project_id + plugin_id + digest + capability
                    │ 最小上下文 + MessagePort
                    ▼
opaque-origin sandbox iframe
  ├─ allow-scripts only
  ├─ connect-src none / 无同源 / 无 cookie / 无宿主 DOM
  ├─ renderer / panel /纯函数 hook
  └─ typed RPC proposal
                    │ schema + quota + revision + ownership
                    ▼
viewer-server Capability Broker
  ├─ Canvas command / Change Set / audit
  ├─ resource broker（无裸路径）
  ├─ plugin namespace state
  └─ Generation Approval → Snapshot → Job Runner

Provider credentials ──只在 Job Runner/credential proxy──×── plugin
data root / repo / home / env / shell ─────────────────×── plugin
任意网络 ─────────────────────────────────────────────×── runtime
Character/UI/Video Workflow Skill ────────────────────×── plugin
```

## 威胁模型

| 威胁 | 参考实现暴露面 | 控制 |
|---|---|---|
| 读取 Key、WebDAV 凭证、localStorage、其他页面数据 | 插件与宿主同 realm | opaque origin；不传 secret；CSP；服务端 API 校验 |
| 读取其他项目、任意文件或媒体裸路径 | 全图 context/页面状态 | grant 绑定 project；resource handle + owner 校验；不返回 path |
| 用网络外传项目内容 | fetch/dynamic import 不受限 | runtime `connect-src 'none'`；依赖 vendored；首版无网络 capability |
| 绕过 Job Runner 发起计费请求 | 插件直接调用浏览器 AI | 只能 propose Generation Run；用户逐次批准；统一队列/配额 |
| 任意修改/删除画布 | `applyOps` 直接执行 | typed command + revision + Change Set；删除逐次确认 |
| XSS/宿主 DOM 劫持/全局 CSS 污染 | React module、injectCSS 进宿主页 | iframe DOM/CSS 隔离；host chrome 不进 iframe |
| 恶意更新/URL 内容替换 | 同 URL cache bust 覆盖 | digest pin、publisher key、显式 update、旧包保留 |
| 插件 id 抢占 | 仅检查导出字段 | registry namespace + publisher binding；id/version/digest 一致性 |
| 恶意迁移破坏项目 | 基线无迁移隔离 | 新鲜 sandbox、最小 payload、timeout、schema 验证、全项目原子提交 |
| ZIP Slip/炸弹/重复路径/软链接 | 基线是单 JS，未覆盖 | 复用项目包安全解压规范；条目、压缩比、总量与规范路径上限 |
| SSRF/DNS rebinding/重定向到内网 | 浏览器 fetch | server 每跳解析并拒绝 loopback/private/link-local；dev mode 单独授权 |
| CPU/GPU/内存耗尽、消息洪泛 | 插件常驻 React/three | 只挂载可见 surface；RPC rate/size；心跳/timeout；销毁 iframe/circuit breaker |
| 原型污染/超深 JSON/大 payload | metadata 任意字段 | JSON schema、深度/键数/字节上限；拒绝危险 key |
| capability confused deputy | 一个 context 暴露全部 host | 每个 RPC 验证 plugin/digest/project/node/instance/action nonce |
| 日志泄密 | 插件异常可带任意对象 | 结构化错误、截断、secret/path 脱敏；不记录 payload 正文 |

本方案不把“用户点击安装”视为对上述风险的无限同意。签名只回答“谁发布、内容是否被替换”，sandbox 与
capability 才回答“它即使恶意能做什么”。

## 插件包与安装

### 包布局

```text
game-atelier-canvas-plugin.zip
├── manifest.json
├── ui/index.js
├── ui/index.css
├── assets/*
└── SIGNATURE.ed25519          # 官方/已验证发布者必需；未验证第三方可无
```

```ts
interface CanvasPluginManifest {
  manifest_version: 1;
  id: string;
  name: string;
  version: string;
  sdk_version: string;
  publisher: { id: string; name: string; key_id?: string };
  description?: string;
  license: string;
  min_app_version: string;
  entrypoint: 'ui/index.js';
  files: Array<{ path: string; sha256: string; bytes: number; mime_type: string }>;
  node_types: PluginNodeManifest[];
  requested_capabilities: CanvasPluginCapability[];
  state_schema_version: number;
  migrations?: Array<{ from: number; to: number; export_name: string }>;
}

interface PluginNodeManifest {
  type: string;
  title: string;
  description?: string;
  icon: { kind: 'text' | 'package_svg'; value: string };
  default_size: { width: number; height: number };
  payload_schema_version: number;
  payload_schema: JsonSchema;
  input_modalities: Array<'text' | 'image' | 'video' | 'audio'>;
  output_modalities: Array<'text' | 'image' | 'video' | 'audio'>;
  generation_modalities: Array<'text' | 'image' | 'video' | 'audio'>;
  surfaces: Array<'node' | 'panel' | 'toolbar'>;
}
```

manifest 不允许任意 HTML icon、远端 asset URL、安装脚本、postinstall、server entrypoint、环境变量、
credential 名称或开放网络 origin。文件摘要覆盖 canonical manifest 之外的每个条目，签名覆盖 canonical
manifest + 文件摘要列表。

### 三类来源

| 来源 | 用户体验 | 信任状态 | 运行边界 |
|---|---|---|---|
| 官方注册表 | 浏览、安装、更新、启停、卸载 | game-atelier key 验证 | sandbox；不因“官方”获得额外项目权 |
| 第三方 URL | 粘贴 manifest/ZIP/legacy single-file URL | 已验证 publisher 或醒目标记“未验证” | 同一 sandbox；逐项目 grant |
| 本地开发目录 | Developer Mode 扫描明确目录 | 本地开发，非生产信任 | 同一 sandbox；改动后 digest 变化并重启 instance |

legacy single-file URL 只保留参考项目相同的安装入口：installer 下载文件、生成最小 staging manifest、计算
digest，并要求用户确认“未验证代码”。它仍在 sandbox 内执行，不支持参考 SDK 的宿主 React ABI；作者必须
按本项目 SDK 导出协议构建。普通模式只接受 HTTPS；Developer Mode 才允许明确的 loopback URL。

### 下载与解包限制

- registry/manifest/ZIP 每次最多 5 次 redirect；每一跳重新解析 DNS 并拒绝 loopback、private、link-local、
  multicast、metadata endpoint 和非 HTTP(S) scheme。
- manifest 最大 256 KiB；压缩包 50 MiB；解压 200 MiB；最多 1,000 条；单文件 20 MiB；压缩比 100:1。
- 拒绝绝对路径、`..`、反斜线逃逸、规范化重复路径、symlink/hardlink、设备文件和未登记文件。
- 下载到唯一 staging，完整校验后以 `plugin_id/version/digest` 原子移入 cache；失败不改变已安装版本。
- URL、publisher、license、digest、安装时间和验证状态进入安装记录；源码正文不写日志。

### 安装、启用、更新、卸载

1. **安装**只把包放入应用缓存并登记，不打开任何 Canvas Project，也不执行代码。
2. **启用**按项目展示请求 capability、数据范围和风险；grant 绑定
   `project_id + plugin_id + package_digest + capability`。
3. **更新**先并存下载新 digest，展示 publisher/版本/capability/schema diff；用户确认后才进入迁移。
4. **迁移成功**才切换项目 pin；失败保持旧 package 与旧数据。其他项目不会被一起升级。
5. **禁用**停止 sandbox，保留节点、payload、state、连接和 package pin。
6. **卸载**默认只移除未被项目 pin 的包。仍被引用时只能“全局禁用”；删除代码前列出受影响项目。
7. package cache 可以在无引用、无 rollback 保留且过回收期后由用户清理；项目包不携带插件代码。

任何 digest 变化都重新创建 sandbox。已验证同一 publisher 且 capability 不增加时，更新审批可以同时明确
续用原 grant；未验证包或 capability 增加必须逐项目重新授权，不静默继承。

## Sandbox 与运行模型

### 技术比较

| 方案 | 隔离能力 | 自定义 UI | 主要问题 | 结论 |
|---|---:|---:|---|---|
| 宿主 `import()` / React component | 无 | 完整 | 可读 Key/DOM/API、改全局状态 | 拒绝 |
| Shadow DOM | 仅样式 | 完整 | 不是安全边界，仍共享 window/network | 拒绝 |
| Web Worker | 较强 | 无 | 仍需另建 UI 边界；不能直接渲染 panel | 只作 sandbox 内优化，不作主边界 |
| opaque-origin sandbox iframe | 强 | 完整 | 多实例有成本，需 RPC/虚拟化 | **普通节点插件主边界** |
| viewer-server 同进程 Python/JS | 无 | 不适用 | 可读 data root/env/凭证 | 拒绝 |
| OS subprocess/container | 取决于平台 | 不适用 | 三平台强隔离成本高 | 未来可执行 Caller Adapter 前置条件 |
| 无代码 declarative adapter | 强 | 不适用 | 表达力低于任意脚本 | **首版自定义模型调用** |

### iframe 策略

- iframe 使用 `sandbox="allow-scripts"`，不加 `allow-same-origin`、forms、popups、top-navigation、downloads、
  pointer-lock 或 storage-access。
- CSP 默认：`default-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`；
  script/style/font/image/media 只允许已校验 package blob、内联样式和受限 data/blob URL。
- 插件不能动态 import HTTP(S) 依赖。Markdown 的 marked、Panorama 的 three.js 必须随包构建；HTML/SVG
  用户内容在插件 iframe 内再进专用内容 sandbox/sanitizer，不把 raw HTML 插入宿主 DOM。
- host 通过一次性 MessageChannel 初始化，消息含 protocol、instance nonce、project/plugin/digest/node scope。
  后续只认该 port，拒绝 window-wide event bus、广播 channel 和任意 target origin 消息。
- schema 限制消息类型、深度、键数和字节；RPC 有速率、并发、timeout。异常达到 circuit breaker 后销毁
  instance 并显示故障占位，不影响 autosave、其他插件或 Job。
- 只挂载 viewport 内和邻近预取区的 plugin node iframe；离屏节点使用宿主占位。具体 live surface 上限在
  第 08 关用 50/100 节点基准确定，不靠无限常驻 iframe 假装性能成立。
- node/panel iframe 不能覆盖宿主标题、连接柄、resize handle、hover toolbar 或生成批准卡；pointer event
  只能落在自己 surface，移动/交互开关由宿主实现。

宿主可在 iframe 内使用插件自带的 React/Preact 或原生 DOM，但不向插件传宿主 React 单例。这样版本升级、
异常边界和 DOM 权限都不会穿透。

## 数据、版本与迁移

### Plugin Node envelope

第 03 关的 `CanvasPluginNodeData` 在实施前补一个不可变 pin：

```ts
interface CanvasPluginNodeData {
  plugin_id: string;
  node_type: string;
  plugin_version: string;       // 人类可读 semver
  package_digest: string;       // 实际执行代码 pin，必需
  data_schema_version: number;
  payload: JsonValue;
  generation_draft: CanvasGenerationDraft | null;
}
```

宿主拥有 id、位置、尺寸、z-index、group、connections、Draft、Content Version、Run 与历史。插件只能处理
自己的 `payload`；它不能把任意字段伪装为 Job/Snapshot/path/status。每节点 payload 默认上限 1 MiB、JSON
深度 32、总键数 10,000；项目 plugin state 默认 4 MiB。大媒体必须经 resource broker 成为项目 Content
Version，不能塞 data URL 逃避归属与包限额。

### 序列化与缺失插件

- host envelope 是项目保存、导出、WebDAV 和缺失插件恢复的 canonical serialization；项目打开不依赖
  插件代码运行，也不依赖插件 `deserialize()` 成功。
- SDK 可提供 sandbox 内的 payload validator/normalizer，但返回值仍须匹配 manifest JSON Schema；失败只
  让该节点进入故障占位，不能阻止整个项目读取。
- 缺失/禁用/版本不符/签名失效/崩溃时显示宿主占位：插件名/id、node type、semver、digest 前缀、原因，
  以及“安装精确版本、启用、导出诊断、删除节点”。不渲染 payload 为 HTML，也不自动换到最新版本。
- 占位节点继续参与位置、选择、复制、删除、连接保存和项目包导出；没有 manifest 时不作为有效生成输入，
  已有 Generation Snapshot/Job 历史不受影响。

这实现参考文档承诺的 data-survival outcome，但不把不存在的基线 serialize/deserialize hook 变成项目真源。

### 原子迁移

1. 下载并验证新 package，但保持旧 digest active。
2. 按项目锁定，复制所有该 digest 的 node payload 与 project plugin state 到 migration staging。
3. 在新鲜、不可联网的 migration sandbox 中按连续 `from → to` 路径执行纯函数；只传单个 payload 或该
   plugin state，不传图、文件、路径、凭证、Job 或其他 plugin state。
4. 每步检查 timeout、输出大小、JSON schema、危险 key 和确定性；任一节点/state 失败则整个项目零写入。
5. 生成迁移摘要与受影响节点数；用户确认后在一个项目 transaction 中提交新 payload/state、schema
   version 与 package digest，并保留 rollback snapshot。
6. sandbox 启动新版本；健康检查失败则自动恢复旧 snapshot/digest。降级只允许显式 reverse migration，
   否则只能恢复备份或创建项目副本。

migration hook 不能改 node id/type/position/size/group/connection、Content Version、Draft、Job、Snapshot、
Derivation 或其他 plugin namespace。默认单 payload 250 ms、整个项目 10 s；超时即失败，阈值可由真实 fixture
基准上调，但不能取消。

## Capability 授权

### Capability matrix

| capability | 默认 | 数据范围 | 写入/确认 |
|---|---|---|---|
| `node.read_self` | 启用必需 | 自身 envelope 的安全 view/payload | 只读 |
| `node.write_self` | 显式 grant | 自身 payload/title/size 白名单 | 用户在该 surface 的直接编辑；统一 revision/undo |
| `graph.read` | 显式 grant | 当前项目 node/connection 摘要，无路径/正文媒体 | 只读 |
| `graph.propose` | 显式 grant | typed node/connection commands | 每个跨节点 Change Set 预览确认；删除不可会话放行 |
| `resource.read_inputs` | 显式 grant | 当前节点已连接输入的明确 version handle | owner/MIME/bytes 校验；返回安全 blob/text |
| `resource.create` | 显式 grant | 当前项目新 Content Version | 用户上传/明确插件动作；大媒体不进 payload |
| `storage.project` | 显式 grant | 当前项目自己的 plugin namespace | revision + quota；不能列其他 namespace |
| `generation.text` | 显式 grant | 标准 Draft/Run API | **每次确认**；Job Runner |
| `generation.image` | 显式 grant | 同上 | **每次确认**；Job Runner |
| `generation.video` | 显式 grant | 同上 | **每次确认**；Job Runner |
| `generation.audio` | 显式 grant | 同上 | **每次确认**；Job Runner |
| `clipboard.write` | 显式 grant | 插件提供的有限文本/blob | 每次由用户点击宿主按钮 |
| `export.download` | 显式 grant | 宿主验证的插件内容导出 | 每次由用户点击宿主按钮 |
| runtime network | 不提供 | 无 | 安装网络不等于运行网络 |

grant 不支持 `*`，不能跨 project、digest 或 publisher；插件不能自行扩大 grant。工具栏 item 只是纯数据
`{id,label,icon,action_id,danger}`，宿主点击后才发 action nonce。`node.write_self` 仍由 schema/revision/undo
约束；timer、setup 或隐藏 surface 没有可用的写 action，防止插件把“启用”解释成后台自动推进。

### 结构化操作

- 插件不能调用通用 `applyOps`。它发送 `propose_change_set`，命令 union 与 Canvas Agent 共用 validator，
  actor/audit 记录 plugin id/digest/node instance。
- 自身连续输入通过 host 的 node payload command 合并为一个可撤销编辑批次；跨节点新增、连接、删除和
  批量移动都展示预览卡。
- viewport/selection/focus 属于页面 presence，可由当前用户手势触发，不写 Canvas Document。
- 插件事件总线只在同一 `project + plugin + digest` namespace 内，并有 payload/rate 上限；没有全局广播。

### 资源读取

- 插件按稳定 node/version handle 请求自己已连接或用户明确选择的资源，不接受 file path、URL 或 project_id。
- viewer-server 校验 project ownership、Content Version、MIME/bytes，再返回截断文本或短寿命 opaque blob
  handle；handle 不可跨 project/instance 使用。
- 生成输出由 host 决定是否写回 plugin payload、创建结果 Content Node 或只显示 candidate；插件不能把
  provider 临时 URL 直接保存成历史真源。

## 四模态 AI 与 Caller Adapter

### 插件生成

插件 manifest 可以声明 generation modality，但 runtime 只提供：

```ts
requestGeneration({
  surface_node_id,
  modality,
  draft_patch,
  requested_writeback
}) -> GenerationProposalHandle
```

host 使用第 04 关 capability matrix 解析真实 alias/model/参数，展示独立批准卡；用户确认后服务端冻结
Snapshot 并创建 Canvas Job。插件可订阅本次 Run 的排队/运行/partial/done/failed/canceled 摘要，但不能
改 status、重试、取消或读 credential。retry/cancel 仍是用户逐次确认的标准动作。

插件不能隐藏固定 prompt prefix：任何 prefix/system instruction 都进入批准卡和 Snapshot。付费 Run 不允许
project grant、toolbar click 或“自动模式”替代逐次确认。

### 自定义模型调用

节点插件和模型 caller 绝不共包、绝不共享 permission：

1. **Declarative Caller Profile（首版开放）**：用户定义 modality、固定 HTTPS origin、method、请求字段映射、
   credential handle、timeout/polling 和响应提取 schema。host 生成请求、注入 credential、验证响应；没有
   `eval`、模板表达式执行或任意 header/path 代码。
2. **Bundled Caller Adapter（首版允许）**：随 game-atelier 发布、官方签名且经源码审核的 Python adapter，
   仍由 `dispatch/dispatch_video/text/audio registry` 调用。
3. **第三方可执行 Caller Adapter（首版不开放）**：只有在 macOS/Windows/Linux 都能证明独立进程无
   data root/env/child process、网络仅走 allowlist proxy、资源上限与 kill 生效后，才能另立 ADR 开放。

credential handle 只让 proxy 知道使用哪一项凭证，不把明文交给 profile、node plugin、浏览器或日志。
所有输出先过 HTTP/status、JSON/MIME、大小、摘要和 modality validator，再回到 Job Runner。

## 故障与恢复

| 故障 | 行为 |
|---|---|
| registry/URL 离线 | 使用已安装 digest；不偷偷换 URL；新安装失败不影响旧包 |
| manifest/signature/digest 错 | staging 丢弃并报告具体字段；不执行任何代码 |
| package 与 node pin 不同 | 缺失版本占位；用户选择安装精确 digest 或迁移 |
| iframe 启动/渲染异常 | 单 surface 故障；重试一次后 circuit breaker；项目继续 autosave |
| RPC 超时/洪泛/超额 | 终止 instance，撤销未提交 proposal；已提交领域命令不回滚历史 |
| state/payload schema 错 | 保留原 JSON 与诊断；不运行插件 normalizer 覆盖 |
| migration 失败 | 整项目零写；旧 digest/state 继续使用 |
| 生成失败/取消 | 按 Canvas Job 规则保留 Snapshot/candidate；插件不得改写为 success |
| 插件禁用/卸载 | 节点与 state 惰性保留；连接/历史不删除 |
| 项目导入缺插件 | 不携带/执行代码；显示精确 pin 占位 |

## SDK 兼容目标

采用版本化的 `@game-atelier/canvas-plugin-sdk` 与 RPC protocol，复刻用户能力而不是参考源码 ABI：

- 相同：节点类型/标题/图标/默认尺寸、node/panel/toolbar surface、move/interaction、资源输出、项目内状态、
  图读取/结构化操作、四模态生成、官方/本地/第三方管理和缺失占位。
- 适配：React component 改 iframe app；闭包 toolbar 改 descriptor；直接 `applyOps` 改 Change Set；
  `ctx.ai` 改 Generation Proposal；远程依赖改 package asset。
- 不兼容：宿主 React 单例、`window.InfiniteCanvasRuntime`、global CSS/event bus、任意 metadata、API Key、
  动态 CDN import 和浏览器原始 fetch。

HTML、Markdown、Panorama、Sticky Note、SVG 五个官方插件逐个移植成 compatibility fixture；功能和节点空间
关系与固定基线等价，颜色、字体、toolbar/panel 外壳使用 Atelier 设计系统。它们必须走与第三方相同的
sandbox/RPC，不用“官方特权”掩盖契约缺口。

## API 与存储落点

```text
<data_root>/.config/canvas-plugins/installed.json       # 非敏感安装索引
<data_root>/.runtime/canvas-plugin-cache/<id>/<digest>/ # immutable package cache
<data_root>/canvases/<project>/plugins/<id>/state.json  # project-owned state
<data_root>/canvases/<project>/plugin-grants.json        # project + digest grants
```

缓存和 grant 记录不进入 Canvas Project Package/WebDAV；project state 与 node pin 进入项目包。导入到新设备
后必须重新安装精确 package 并逐项目授权。路径只在服务端存在，不返回插件。

主要 API：

| API | 语义 |
|---|---|
| `GET /canvas/plugins/registry` | 服务端抓取/验证官方清单摘要 |
| `GET /canvas/plugins/installed` | 安装记录、digest、验证状态、引用计数 |
| `POST /canvas/plugins/inspect` | URL/本地包下载到 staging，返回 manifest/risk，不安装 |
| `POST /canvas/plugins/install` | 用户确认后原子登记已验证 staging |
| `POST /canvas/plugins/{id}/update-inspect` | 新旧 digest/capability/schema diff |
| `POST /canvas/plugins/{id}/uninstall` | 引用检查后卸载或拒绝 |
| `GET/PUT /canvas/projects/{id}/plugin-grants` | 项目启用与 capability grant |
| `POST /canvas/projects/{id}/plugins/{plugin}/migrate-inspect` | sandbox dry-run + 摘要 |
| `POST /canvas/projects/{id}/plugins/{plugin}/migrate` | 项目锁内原子切 pin |
| `GET/PUT /canvas/projects/{id}/plugins/{plugin}/state` | namespace/revision/quota 校验 |
| `POST /canvas/projects/{id}/plugins/rpc` | page instance 绑定的 broker 通道/短请求 fallback |

浏览器从 viewer-server 获取已校验 package assets；服务端对 HTML/CSP/COOP/CORP/nosniff/cache headers 固定，
不允许用户上传的 package 覆盖应用路由。

## 验收与测试

### 安装供应链

- official manifest canonicalization、Ed25519、publisher/id binding、file digest、version/digest pin。
- 未签名第三方醒目标记且只能 sandbox；更新不能通过相同 URL 静默换 publisher/capability。
- SSRF：redirect、IPv4/IPv6、DNS rebinding、localhost/private/link-local/metadata host 全拒绝；Developer Mode
  只放行明确 loopback target。
- ZIP Slip、symlink、重复规范路径、炸弹、条目/单文件/总量/MIME/未登记文件上限。
- staging 安装/更新 crash 原子性；离线缓存、引用保护、回收与 rollback。

### sandbox/权限

- 恶意 fixture 尝试 window.parent DOM、localStorage/indexedDB/cookie、same-origin API、fetch/WebSocket/
  EventSource、动态 import、forms/popups/downloads，均失败。
- MessagePort nonce/project/plugin/digest/node/page instance 错配、重放、超深/超大/洪泛消息全拒绝。
- CSS/keyboard/pointer 不能逃出 surface；插件不能遮住连接柄、toolbar 或批准卡。
- grant 不跨 project/digest；安装未启用零代码执行；禁用/离屏/项目关闭无后台 timer 或写入。
- payload/state quota、prototype pollution、schema mismatch、revision conflict 与 undo/redo。

### 领域与 AI

- graph read 不泄露 path/credential/plugin private state；resource handle 只读已授权版本且不可跨项目重放。
- plugin Change Set 不能写 Job/Snapshot/Derivation/Content path/status；删除逐次确认且 stale revision 零写。
- 四模态每次生成都有批准卡、Snapshot 与 Canvas Job；插件不能直连 provider、伪造 success 或绕过队列。
- declarative Caller Profile 无 eval/任意 header/私网 origin；credential 只在 proxy 注入；输出 validator 失败
  不产生 Content Version。

### 数据生存与兼容 fixture

- 缺失/禁用/错误/旧 digest 节点打开、保存、复制、导出、WebDAV、重新安装后 payload/连接不变。
- 多节点 + plugin state 连续迁移、任一点失败 all-or-nothing、rollback、无 reverse path 降级拒绝。
- HTML/Markdown/Panorama/Sticky/SVG 与固定基线逐项行为对照；依赖离线可用、无 CDN 请求。
- 50/100 plugin node viewport 虚拟化、快速平移缩放、iframe crash/restart、窄屏 panel；具体性能阈值由第 08
  关原型实测封板。
- macOS/Windows/Linux 路径、cache lock、atomic replace 与 sandbox headers 一致。

## 方案比较

| 方案 | 优点 | 代价/风险 |
|---|---|---|
| A. immutable package + iframe sandbox + capability broker（推荐） | H01-H09 可实现；密钥/文件/宿主 DOM 隔离；缺失和迁移可恢复 | SDK 需重新适配；多 iframe 需虚拟化；无任意 runtime 网络 |
| B. 参考 loader 原样 import remote JS | 搬运最快，React 插件源码兼容 | H10 安全缺陷必然存在；可绕过 Job Runner/文件真源，不能接受 |
| C. 只允许随应用编译的官方节点 | 安全面最小 | 失去第三方 URL、SDK、安装/更新等 H01-H09 目标 |
| D. 所有插件放 viewer-server subprocess | 可集中控制文件/网络 | 自定义 UI 仍需边界；三平台可靠 OS sandbox 成本过高；节点插件没有必要 |

## Decision

2026-08-23 用户确认继续采用方案 A。节点插件固定使用 immutable package、opaque-origin iframe sandbox 与
viewer-server capability broker；保留第三方 URL 安装入口，但不提供宿主页直接执行兼容模式。runtime 首版
无任意网络，跨节点写入走 Change Set，四模态生成逐次确认并进入 Job Runner，项目数据按 digest pin 原子
迁移。自定义模型首版只开放 declarative Caller Profile，不开放第三方可执行 Caller Adapter。

## 本关确认项

方案 A 已确认，实施边界如下：

1. 保留第三方 URL 安装入口，但远程内容必须先落不可变包并只在 iframe sandbox 执行，不提供宿主页
   `import()` 兼容模式。
2. runtime 首版完全无任意网络；marked/three 等依赖随包发布。官方插件也不获得隐藏特权。
3. 插件跨节点修改走 Change Set，四模态生成每次确认并进入 Job Runner；插件永远没有凭证、裸路径、
   Job/Snapshot 直写权。
4. digest 是真实版本 pin；项目打开不依赖插件运行，更新迁移按项目原子提交，失败继续用旧版本。
5. 自定义模型首版开放 declarative Caller Profile；第三方可执行 Caller Adapter 暂不开放，直到三平台进程
   sandbox 有独立验证和新 ADR。
