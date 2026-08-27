# Canvas Agent 人工边界与权限方案

Status: ready-for-agent

## 结论摘要

推荐方案 A：**Canvas Agent 是用户显式发起的项目内协作助手，不是 Workflow Skill，也不是拥有文件系统
权限的自动执行器。它可以自动读取当前画布和提出结构化 Canvas Change Set；任何持久化修改都必须通过
viewer-server 领域命令，生成、跨空间传递、发布和不可逆动作始终逐次确认。**

为复刻参考基线的面板、对话、历史、Skills、审批、诊断、结构化工具和 Codex adapter，同时保留
game-atelier 的人工创作边界：

- 采用一个按需启动的受限 Canvas Agent Host sidecar，复用用户本机 Codex 登录态、模型与流式协议，
  但不复用 Codex 的工作区写入、shell、任意网络工具或全局 Skill 执行权限。
- 浏览器只连接现有 viewer-server；viewer-server 代理 sidecar，浏览器不保存 Agent token，也不直接把
  React 状态当数据真源。
- Agent 读取 revision 化服务端 Canvas Project；所有写入先形成有 expected revision、可读摘要和预览 diff
  的 Canvas Change Set。
- 可撤销修改按用户选择的 Canvas Approval Mode 批准；每个生成、跨项目复制、发布与其他外部副作用
  无论模式如何都要逐次确认。
- Agent 永远不能新建/删除/导入/导出/同步 Canvas Project，不能改 Key/Provider，不能直接写 Job、
  Snapshot、candidate、Derivation、Content Version 路径或项目文件。
- “Skills” Tab 保留，但管理的是 Canvas Agent Skill（指令模板）。用户选择 Skill 并主动发送一轮后，它
  只能影响 Agent 的提案；保存 Skill 不执行，Skill 也不能后台触发、创建项目或绕过审批。
- Character/UI/Video Workflow Skill 的现有禁令完全不变：它们不创建、不填充、不推进 Canvas。

因此，“人工创作”被精确定义为：项目由用户创建；每轮 Agent 工作由用户主动发起；产生副作用前由用户
按已知权限确认；没有后台计划、自动拓扑执行或 Skill 自启动。它不要求用户亲手完成每一次鼠标拖拽。

## 术语冲突裁定

当前“Skill 不创建、不填充、不推进画布”中的 Skill 指项目现有 Character/UI/Video **Workflow Skill**。
参考项目 G14 的 Skill 是给 Codex 注入说明的本地 **Canvas Agent Skill**。两者如果继续都简称 Skill，
未来实现一定会误把工作流能力暴露进 Canvas，因此本方案固定以下区分：

| 术语 | 含义 | 能否自己运行 |
|---|---|---:|
| Workflow Skill | Character/UI/Video 等正式生产流程 | 不能接触 Canvas |
| Canvas Agent | 当前画布内、用户显式发起的交互助手 | 不能后台运行 |
| Canvas Agent Skill | 用户为一次 Agent Turn 选择的指令模板 | 不能；只影响提案 |
| Agent Turn | 用户一次发送到回复、工具提案和结束的交互轮 | 由用户发起 |
| Canvas Change Set | Agent 提出的原子、可验证、可审计的一组画布命令 | 批准后才可提交 |
| Canvas Approval | 用户对特定项目、变更集或会话内操作类别授予的许可 | 不等于文件/网络权限 |

## 参考基线与当前项目核对

### 固定参考基线

| 能力 | 参考实现 | 观察到的风险/缺陷 |
|---|---|---|
| Agent 连接 | 独立 Node Canvas Agent，127.0.0.1 + token + Origin pin | URL/token 落浏览器 localStorage |
| 数据读取 | 浏览器把 React snapshot POST 给 Agent 内存 | 可能滞后；绕过服务端文件真源/revision |
| 写入 | MCP→SSE→浏览器 applyCanvasAgentOps | 浏览器可直接 patch 任意 metadata；无领域 validator |
| 工具确认 | 默认自动，手动时只拦 canvas write tool | site tools 中 generation/asset 写入可绕过同一确认判据 |
| 撤销 | 只存最近一次 Agent 操作前 snapshot | 只能撤一轮；会覆盖并发变化；生成副作用不可撤却混在同一 ops |
| Codex 权限 | request/automatic/full；full = danger-full-access | 画布需求不需要任意文件、shell 和网络工具权限 |
| 多标签 | clientId、active/bound client，turn 固定网页 | 数据仍来自各浏览器快照，跨页保存冲突不受服务端统一校验 |
| Skills | 读 user/repo/system/admin；管理 repo .agents/skills | 可能改源码工作区或把业务 Workflow Skill 暴露给 Canvas |
| 生成 | run_generation 混在 apply_ops，浏览器异步触发 | 结构写已成功而 Job 提交失败时，工具仍可能返回成功快照 |
| 会话 | Codex thread、SSE replay、history/diagnostics | 页面与 Agent 各有状态，真源分散 |

### game-atelier 当前约束

| 当前事实 | 对 Agent 的结论 |
|---|---|
| FastAPI/文件系统是唯一真源 | Agent 读写必须经过服务端，不使用浏览器 snapshot 作为真源 |
| Canvas Document v2 使用 revision 和项目锁 | Change Set 必须带 expected revision，冲突后重新提案 |
| Snapshot 是真实生成输入唯一真源 | Agent 不能直接创建/改写 Snapshot 或 Derivation |
| Job Runner 是唯一执行入口 | Agent 只能请求标准 Run command，不能调用模型/脚本 |
| Canvas Project 独立且人工创建 | Agent 无项目 create/import/delete/sync capability |
| 跨空间只显式复制 | transfer/publication 始终由用户逐次确认 |
| viewer-server 只绑定 127.0.0.1 | sidecar 也只走回环并由 viewer-server 代理 |
| 当前多 Web tab 行为未定义 | Canvas v2 必须用 page instance + revision 明确隔离；不扩大其他页面承诺 |

## 信任边界

```text
用户
 │ 主动发送 Agent Turn / 审批 Change Set
 ▼
浏览器 Agent Panel
 │ same-origin API + SSE；不持 sidecar secret
 ▼
viewer-server (唯一 Canvas 权限执行点)
 ├── read model：Canvas/Selection/Jobs/Library/Prompt cache
 ├── policy：project scope + revision + approval + capability
 ├── command handler：统一 validator / transaction / audit / undo
 └── sidecar proxy
       │ 随机 loopback token；protocol/version 绑定
       ▼
Canvas Agent Host sidecar
 ├── Codex app-server 生命周期、流式事件、模型与 token usage
 ├── 空临时 cwd；无 data root；无 repo write；无 shell/任意网络工具 capability
 ├── 只装 Canvas MCP tool schema
 └── 读取 viewer-server 发来的最小上下文/Canvas Agent Skill 正文
       │ 结构化 tool proposal
       └──────────────────────────────▶ viewer-server policy

Character/UI/Video Workflow Skills ──×── Canvas Project
插件 host ──独立第 07 关权限──▶ viewer-server
Provider credentials ──只由 Job Runner 使用──×── Agent Host
```

sidecar 崩溃只终止 Agent Turn，不影响 viewer-server、Canvas autosave 或已提交 Job。Agent Host 不直接
打开项目文件；即使模型提示注入成功，也拿不到 data root、Key、shell 或任意出网工具。Codex provider
传输仍由 app-server 自己完成，它不是模型可调用的网络 capability。

## Agent 上下文与页面绑定

### Project Scope

每个 Agent Session 固定绑定一个 Canvas Project。Turn 开始时冻结：

```ts
interface CanvasAgentTurnScope {
  session_id: string;
  turn_id: string;
  project_id: string;
  page_instance_id: string;
  base_revision: number;
  selected_node_ids: string[];
  referenced_versions: Array<{ node_id: string; version_id: string }>;
  selected_skill_revision: string | null;
}
```

- 浏览器 tab 首次加载生成 page_instance_id；切换项目时旧 scope 失效，不复用到新项目。
- Agent 工具不接受任意 project_id 覆盖；它只使用当前 Turn Scope。
- 当前画布优先。只有用户明确要求切换时，Agent 可以返回导航建议；真正切换由浏览器执行，旧 Turn 不跟随。
- Canvas 项目列表只返回 id/name/updated_at/counts，不返回内容；不会因为 Agent 猜标题就自动打开。
- 多标签页同时打开同一项目时，写入仍由 expected revision 冲突保护；Agent 不按“最近活跃 tab”猜目标。
- page disconnect 后继续保留会话流和只读结果；未审批 Change Set 暂停。重新打开同项目可恢复审批卡，但
  不能在另一个项目的页面批准。
- selection 与当前聚焦 viewport 属于 page-instance presence，不是 Canvas 内容真源。浏览器只上报这些
  临时 UI ID/坐标，viewer-server 会将 node ID 与当前文档求交；节点正文、连接、Draft 和 revision 始终
  重新从文件真源读取。

### Read Context

`canvas_get_state` 返回服务端 revision、节点/连接摘要、当前版本 ID、Draft 摘要和 Run 状态，不返回裸路径、
Key、插件私有 state 或全部历史正文。长文本默认截断；Agent 必须按稳定 node/version ID 调
`canvas_get_content` 精确读取。

Canvas Reference chip 在用户发送消息时冻结 node_id + version_id。节点随后被替换或删除，历史消息仍指向
当时版本，不按标题或节点当前内容漂移。图片附件先进入 session 临时区；只有批准“插入画布”后才成为
目标项目 upload Content Version。

## 权限矩阵

### 工具级能力

| 能力 | 默认 | 可否会话放行 | 结果 |
|---|---|---:|---|
| 读当前项目/节点/连接/selection/viewport/revision | 自动 | 不需要 | 返回最小摘要 |
| 读明确 node/version 正文或安全媒体预览 | 自动 | 不需要 | 按 project ownership 校验 |
| 读 Canvas Jobs/candidate 状态和错误 | 自动 | 不需要 | 只读，不返回 credential/裸路径 |
| 搜索公共 Prompt cache、本项目 Local Prompt/Library | 自动 | 不需要 | 不触发远端刷新 |
| 读 model capability/alias 可用性 | 自动 | 不需要 | 不返回 Key/base secret |
| 选择节点、聚焦 viewport、打开面板 | 自动 | 不需要 | 仅页面态，不写 Canvas Document |
| 新增/更新/移动/缩放/分组节点 | 逐变更集确认 | 可按“结构编辑”放行本 Session | 一个原子 Change Set |
| 创建 Input Connection | 逐变更集确认 | 可按“结构编辑”放行本 Session | 领域 validator 校验 |
| 修改 Text Content / Generation Draft | 逐变更集确认 | 可按“内容编辑”放行本 Session | 创建新内容版本或新 revision |
| 删除节点/Input/Library Entry/Local Prompt | 逐变更集确认 | 不可会话放行 | 明确删除摘要；仍可 undo |
| 把 Agent 附件插入画布 | 逐次确认 | 不可 | 临时附件转项目 owned upload |
| 保存/替换 Library Entry 或 Local Prompt | 逐次确认 | 可按“库编辑”放行本 Session | revision sidecar command |
| 提交 text/image/video/audio Generation Run | **每次确认** | **不可** | 服务端冻结 Snapshot 后交 Job Runner |
| retry original/current 或 cancel Run | **每次确认** | **不可** | 独立 Job command；显示计费说明 |
| Canvas Transfer / Publication | **每次确认** | **不可** | 显示来源、目标与复制影响 |
| 刷新自定义 Prompt Source | 每次确认 | 不可 | 有网络副作用；服务端执行 |
| 导出当前布局理解快照 | 自动 | 不需要 | 结构 JSON，不是项目包 |
| 停止 Agent Turn | 自动用户动作 | 不需要 | 中断推理，取消未批准提案 |

### Agent 永远没有的能力

- 新建、重命名、删除、恢复、导入、导出或 WebDAV 同步 Canvas Project。
- 读取或修改 provider/API/WebDAV credential、base secret、环境变量或全局 config。
- 读取任意本地 path、遍历 data root、repo、home 或插件缓存。
- 执行 shell、子进程、任意 HTTP、浏览器脚本、DOM 自动化或粘贴代码执行。
- 直接修改 Job status/output/candidate、Generation Snapshot、Derivation Connection 或媒体 path。
- 绕过模型 capability、项目 owner、MIME/摘要、配额或 expected revision 校验。
- 安装/更新/卸载节点插件，或更改插件 capability grant。
- 创建、更新、删除或启停全局/Workflow Skill；这些只能由用户在专门 UI 操作。
- 启动 Character/UI/Video Workflow Skill，创建 Canvas Project，后台定时工作或整图自动运行。
- 把“已提案”“已批准”“已提交 Job”描述成“已生成成功”。

## Canvas Approval Mode

参考项目把 Codex 文件权限和 Canvas tool 自动确认混在两套开关中。本项目只展示与画布相关的三档权限，
并且每个新 Session、项目切换、sidecar 重启都重置为默认档，不跨会话持久化：

| 模式 | 行为 |
|---|---|
| 逐次确认（默认） | 每个持久化 Change Set 都展示审批卡 |
| 自动应用可撤销编辑 | 结构/内容/库操作按已授予类别自动提交；删除、生成和外部副作用仍逐次确认 |
| 只读 | Agent 可以分析、对话和提出建议，但不创建可执行 Change Set |

不提供参考实现的 `danger-full-access`。所谓“自动”只针对当前 project/session 中明确列出的可撤销 Canvas
命令，不赋予文件、网络、项目生命周期或 Job 执行权。

### 审批卡

每个卡片必须显示：

- Agent 目的与 Change Set ID。
- 项目名、base revision、命令数量。
- 按节点标题 + 稳定 ID 分组的新增/修改/移动/连接/删除摘要。
- 内容变更的 before/after 文本 diff；媒体只显示安全缩略图、kind、bytes、hash 前缀。
- 生成的模式、模型 alias/model、最终计数、参数摘要、输入版本列表与成本/取消提示。
- transfer/publication 的来源 owner、目标 owner 和“复制后互不联动”说明。
- 风险标签：可撤销、删除、会计费、跨空间、网络。
- 操作：拒绝、允许一次；仅低风险类别显示“本会话允许此类编辑”。

Approval Grant 绑定 `session_id + project_id + operation_class`，并记录创建时间。它不接受通配符
`*`，不跨项目、不跨 sidecar restart；新增命令类型默认落回逐次确认。Agent 自己不能请求扩大 grant，
只能提交具体 Change Set。

## Canvas Change Set

```ts
interface CanvasChangeSet {
  change_set_id: string;
  session_id: string;
  turn_id: string;
  project_id: string;
  expected_revision: number;
  intent: string;
  commands: CanvasAgentCommand[];
  risk: Array<'reversible' | 'delete' | 'cost' | 'external' | 'network'>;
  proposed_at: string;
  expires_at: string;
  proposal_fingerprint: string;
}

type CanvasAgentCommand =
  | AddNodeCommand
  | UpdateNodeCommand
  | MoveNodesCommand
  | ResizeNodeCommand
  | DeleteNodesCommand
  | AddInputConnectionsCommand
  | DeleteInputConnectionsCommand
  | GroupNodesCommand
  | UpdateLibraryCommand
  | UpdateLocalPromptCommand;
```

约束：

- Agent 使用语义命令，不提交完整 Canvas Document、任意 JSON Patch 或开放 metadata patch。
- 每种 command 有 Pydantic discriminated union 与字段白名单；未知字段/类型拒绝。
- 批次最多 100 个命令、涉及 500 个节点/连接、序列化 1 MiB；超过后拆分并重新审批。
- 服务器在提案阶段以当前 revision dry-run，生成 diff 和 inverse command；审批时再次校验
  fingerprint、expiry、session/project、expected revision。
- revision 已变化返回 `409 agent_proposal_stale`，旧审批立即失效。Agent 必须重新读取并产生新提案，
  不能把 patch 套在当前文档上。
- 通过后项目锁内原子执行所有命令，revision 只增加一次；任一 command 失败则零写入。
- Content 文本修改创建 `agent_change` Content Origin，记录 session/turn/change_set 和 approving user，
  但内容仍属于 Canvas Project。
- Agent 不能创建 Derivation；Run command 由独立 generation approval 调用第 04 关 API，并由服务端事务
  创建 Snapshot/result/Derivation。

### 生成不是普通 Change Set

“创建提示词节点 + 配置节点 + 连线 + 立即生成”拆成两阶段：

1. 审批并原子提交结构 Change Set。
2. 服务端返回新的 revision 和可预览 Resolved Input；再展示独立 Generation Approval。
3. 用户确认后才创建 Run/Job/Snapshot。

若第 2 步被拒绝，结构仍然是可编辑草稿；Agent 不把它说成失败或回滚。这样不会出现参考实现中
`run_generation` 与结构 ops 混批、Job 提交失败却已改图的含糊状态。

## Undo / Redo 与审计

### 统一命令历史

每个成功 Change Set 写一条项目内审计记录：

```ts
interface CanvasAgentAuditEntry {
  audit_id: string;
  project_id: string;
  before_revision: number;
  after_revision: number;
  session_id: string;
  turn_id: string;
  change_set_id: string;
  actor: 'canvas_agent';
  approved_by: 'user';
  commands: CanvasAgentCommand[];
  inverse_commands: CanvasAgentCommand[];
  risk: string[];
  applied_at: string;
}
```

- Agent Change Set 与用户画布命令进入同一 undo/redo history，不另设“只撤最近 Agent 操作”的栈。
- 审批通过的一批命令是一个 undo step；redo 重新执行同一语义命令并再次检查当前 revision。
- Undo 自身是新命令，不删除审计记录。只有当前状态满足 inverse precondition 才执行；存在后续冲突时
  返回 diff，让用户选择普通编辑，不恢复整份旧 snapshot 覆盖别人工作。
- Generation Run、上游计费、已下载产物和已发布工坊副本不可撤销。Undo 只能撤回画布中的
  active/result presentation 或结构节点；UI 必须写“隐藏/移除结果”，不能写“撤销生成”。
- transfer 已复制进项目的 Content Version 与已发布副本保留历史；撤回节点/Library Entry 不做物理删除。
- Agent 自己不能调用 undo/redo；它可以建议，最终由用户点击或明确发送“撤销上一变更”形成待批命令。

### 会话文件真源

`agent/sessions/<session_id>.json` 使用 revision 和单调 sequence，保存：

- user/assistant 可见消息。
- reasoning summary（不保存或展示隐藏 chain-of-thought）。
- plan/progress、tool proposal/result、approval request/decision。
- model、effort、token usage、turn status、interrupt/failure。
- Canvas Reference 的 node/version ID 和安全附件引用。
- 与 audit/change_set/run 的稳定 ID。

SSE 只是低延迟通道；重连使用 `after_sequence` 补事件，重复/乱序 sequence 丢弃。会话批量删除是用户
历史管理动作，Agent 没有该工具；删除会话不删除 audit、Canvas 内容或 Job。

## Canvas Agent Skills

### 目录与作用

Skills Tab 保留“列表、启停、使用、新建、编辑、删除、从会话或画布生成草稿”的全部可观察能力，但将
权限限定为 Canvas Agent 指令模板：

- Canvas-managed Skill 存在 data root 的专用 Agent 配置域，不写 plugin source repo、~/.codex 或
  ~/.claude。
- 可以只读发现已安装 Skill 的名称、描述和安全静态正文；用户要在 Canvas 中使用时先显式
  “复制为 Canvas Skill”，之后编辑副本。
- Character/UI/Video Workflow Skill 默认标记 incompatible，不可选择或复制到 Canvas。
- enable/disable 只影响 Canvas Agent catalog，不修改全局 Codex/Claude Skill 状态。
- 选择 Skill 只把固定 revision 正文注入下一次用户主动发送的 Turn；Turn 结束后清除选择，不自动继续。
- 从会话/画布生成只产生 Draft；用户必须查看名称、描述、instructions 与默认 prompt 后点击保存。
- 新建/更新/删除/启停只能由用户 UI 发起，Agent 没有管理 Skill 的 tool。
- Skill 正文按不可信指令处理，不能扩大 MCP schema、Approval Grant 或 sidecar sandbox。

因此 G14 的界面和使用体验存在，但它不会重新引入“Skill 自动创建/推进画布”。

## 连接、会话与故障恢复

### Sidecar 生命周期

- Agent 面板首次“连接本机 Codex”时按需启动；关闭面板不杀正在运行的 Turn，显式“断开”或 server 停止
  才结束 sidecar。
- 默认由 viewer-server 启动并持有随机 token/端口；浏览器只看到 connected/protocol/model 状态。
- 高级手动连接只允许 loopback URL，token 由 viewer-server 保存并代理；拒绝公网/局域网 endpoint。
- sidecar 与 viewer-server 双向校验 protocol version，token 放 header 而非 query/log。
- Codex app-server 使用空临时 cwd、tool networkAccess=false、无 workspace write 的 sandbox；只注册受限
  Canvas MCP。模型 provider 传输仍由 app-server 管理。
- sidecar 不持久化 Canvas 数据；session、approval、audit 真源都由 viewer-server 文件保存。

### 状态与恢复

| 故障 | 行为 |
|---|---|
| Agent Host/Codex 启动失败 | Canvas 正常可用；面板显示诊断与重试 |
| SSE 断线 | 按 sequence 重连；不重复执行已提交 Change Set |
| 页面刷新 | 恢复 Session/history/pending approval；用服务端 revision 重建 |
| page/project switch | Turn 保持原 project scope；新页不接收旧审批 |
| Change Set 过期 | 标 stale；不执行；Agent 重新读取 |
| 审批后提交时 revision 冲突 | 零写入；审批失效；生成新 diff |
| sidecar 在提案后崩溃 | 提案仍可查看但不可自行扩展；用户可拒绝，重连后继续 |
| sidecar 在提交后崩溃 | 以 audit/file truth 判断是否已应用；不得重放 |
| 用户停止 Turn | 中断 Codex；拒绝未提交提案；已提交命令/Job 保留 |
| Job Runner 失败 | Agent 读到标准 Run 状态；不得改 status 或伪造成功 |
| attachment session temp 丢失 | 插入审批失败且项目零写入；提示重新上传 |
| Skill revision 改变 | 当前 Turn 保留冻结正文；下一 Turn 要求重新选择 |
| 会话文件损坏 | 隔离单 session，项目/其他会话仍可打开；诊断报告不含内容/secret |

### 诊断

诊断 Tab 展示连接、protocol、sidecar/Codex 状态、SSE sequence、最近工具名/耗时/错误、approval 和
revision conflict。日志默认脱敏 token、prompt/media body、Key、绝对 home/data-root path；按日期轮转。
“导出诊断”是用户动作，生成脱敏报告，不附项目内容或会话正文。

## API / MCP 提案

### viewer-server API

| API | 语义 |
|---|---|
| POST /canvas/projects/{id}/agent/sessions | 用户显式创建项目 Agent Session |
| GET /canvas/projects/{id}/agent/sessions | 项目会话摘要 |
| GET/DELETE .../agent/sessions/{session_id} | 读取/用户删除会话 |
| POST .../agent/sessions/{session_id}/turns | 用户发送 Turn；冻结 scope/revision/refs/Skill |
| POST .../agent/turns/{turn_id}/interrupt | 用户停止 Turn |
| GET .../agent/events?after_sequence= | session SSE + replay |
| POST .../agent/change-sets/inspect | 服务端 dry-run、risk、diff，不写 |
| POST .../agent/change-sets/{id}/approve | 用户批准；再次校验后原子提交 |
| POST .../agent/change-sets/{id}/decline | 用户拒绝并审计 |
| POST .../agent/generation-approvals | 独立冻结预览，不创建 Job |
| POST .../agent/generation-approvals/{id}/approve | 调标准 runs endpoint |
| GET /canvas/agent/status | sidecar/protocol/model/diagnostic summary |
| POST /canvas/agent/connect|disconnect | viewer-server 管 sidecar |
| GET/PUT /canvas/agent/skills | Canvas-managed Skill catalog，用户 UI only |
| POST /canvas/agent/skills/draft | 从会话/画布生成待审 Draft，不保存 |

### MCP tools

对模型只暴露：

- Read：`canvas_get_state`、`canvas_get_selection`、`canvas_get_content`、
  `canvas_get_runs`、`canvas_search_prompts`、`canvas_list_assets`、`canvas_get_capabilities`。
- Propose：`canvas_propose_changes`、`canvas_propose_generation`、
  `canvas_propose_transfer`、`canvas_propose_publication`。
- Status：`canvas_get_proposal_status`、`canvas_get_run_status`。

参考项目中 create/update/move/connect/generate 等便捷工具继续对模型显示相同描述，但在 MCP adapter 内只
构造成 propose tool 的 typed command，绝不直接执行。没有 site_navigate、workbench_generate、
assets_add、Skill management、filesystem、shell 或 arbitrary network tool。

## 验收与测试

### 自动化

- Pydantic/TS 对称 command、Change Set、approval、session/event schema。
- 每个 command 字段白名单、端点/owner/revision/risk 分类 property tests。
- proposal inspect→approve 原子性、stale/expiry/fingerprint/project mismatch 全失败且零写入。
- 结构 Change Set 与 Generation Approval 两阶段测试；拒绝生成仍保留结构草稿。
- undo/redo inverse precondition；并发用户编辑后不得 snapshot overwrite。
- Agent 不能构造 Snapshot/Derivation/Job success/path/credential/plugin grant。
- sidecar sandbox contract：空 cwd、tool networkAccess=false、无 workspace write、MCP allowlist。
- page_instance/turn/project 绑定，多 tab 切换不会把工具发到错误项目。
- Session SSE replay sequence、断线重连、interrupt、重复结果幂等。
- Skill draft/revision/复制为 Canvas Skill；Workflow Skill incompatible。
- token/path/prompt/media 日志脱敏与单 session 损坏隔离。

### 逐项验收

- G01/G03/G07/G09/G10/G11：面板布局、对话/历史/Skills/诊断、流式事件、停止、附件与引用。
- G02/G15：自动/高级 loopback 连接、protocol mismatch、sidecar unavailable。
- G04/G13：当前画布优先、稳定 ID 读取，不按标题猜目标。
- G05/G06：一批结构命令一个 undo step；revision 冲突不覆盖。
- G08：三档 Canvas Approval Mode；生成/删除/外部副作用始终逐次确认。
- G12：两个 tab/两个项目并行 Turn，所有审批和结果回到原 project scope。
- G14：Skill CRUD/draft/use 全部存在，但保存不执行、选择只作用下一 Turn、Workflow Skill 不可用。
- 375px：Agent 作为全屏抽屉，画布状态保留；768px：Agent/资源栏互斥展开；桌面为可调宽三栏。

## 方案比较

| 方案 | 优点 | 代价/风险 |
|---|---|---|
| A. 受限 sidecar + 服务端 Change Set/审批（推荐） | 完整复刻 Agent UX；文件真源、人工边界和安全成立 | 增加可选 sidecar 进程；审批/会话 schema 较多 |
| B. 直接复用参考 browser snapshot + applyOps | 代码搬得最快 | 绕过 revision/领域校验；确认不覆盖 site tools；误写项目与丢并发 |
| C. 只做只读聊天，无结构写和 Skills | 安全最简单 | G05/G06/G08/G14/G15 不等价，不满足 131 项 |

## Decision

2026-08-23 用户确认方案 A。Canvas Agent 固定为用户显式发起、项目内受限的协作助手；它只能读取
服务端真源并提出 typed Canvas Change Set，持久化修改由 viewer-server 在 revision、capability 与
Canvas Approval 下执行。Character/UI/Video Workflow Skill 继续绝对不能创建、填充或推进 Canvas；
Canvas Agent Skill 只是下一次用户主动 Agent Turn 的指令模板。生成、删除、Transfer、Publication 与
Prompt 远端刷新始终逐次确认，Agent Host 不获得 data root、repo write、shell、任意网络工具或
`danger-full-access`。

## 本关确认项

方案 A 已确认。以下规则解释不是产品方向变化，而是对“人工创作”的精确定义：

1. Workflow Skill 继续绝对不能创建、填充或推进 Canvas。
2. Canvas Agent Skill 只是下一次用户主动 Turn 的指令模板，不是 Workflow Skill。
3. Agent 可以提出并在授权后执行项目内结构/内容修改；项目生命周期永远由用户 UI 操作。
4. Generation、删除、Transfer、Publication、Prompt 远端刷新始终逐次确认，不能会话自动放行。
5. Agent Host 复用本机 Codex 登录与模型，但没有 data root、repo write、shell、任意网络工具或
   `danger-full-access`。
