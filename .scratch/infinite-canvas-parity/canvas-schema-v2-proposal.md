# Canvas schema v2 与切换方案

Status: ready-for-agent

## 结论摘要

推荐采用“**一份 revision 化 Canvas Document + 文档内不可变 Content Version + Job 内不可变
Generation Snapshot + 分域 sidecar**”的文件模型：

- `canvas.json` 继续是画布布局与内容索引的唯一真源，但只保存项目相对引用，不接受客户端原始路径。
- `content_versions` 与节点一起原子保存；节点删除或替换只改引用，不删除历史版本。
- 每个 Canvas Job 内嵌不可变 `Generation Snapshot`，运行结果另存为可变的 candidate 状态。
- Agent 会话、资产库、提示词库和插件私有状态不塞进热路径 `canvas.json`，各自使用有 revision 的 sidecar。
- 所有写入通过项目级文件锁、期望 revision 和原子替换完成；React Flow 仍只消费/提交领域文档。
- v2 运行时代码只读取 schema v2。落地提交直接删除 v1 schema、旧 API 字段和旧前端分支，不提供
  converter、兼容 union、fallback 或 migration。

该方案比参考项目的单一 localforage Project 对象多出历史真实性、路径白名单和并发控制；用户可观察
功能仍按基线等价，持久化方式适配 game-atelier 的 FastAPI + 文件系统架构。

## 当前事实与风险

| 当前事实 | v2 风险 |
|---|---|
| `canvas.json` schema v1 只有 text/resource/generation | 无法表达 config/group/plugin 与稳定内容节点 |
| resource 节点直接保存路径 | 浏览器文档可以尝试注入任意本地路径 |
| generation 节点保存 `job_ids/active_job_id` | Job 历史、当前草稿和结果展示耦合 |
| `PUT document` 无 revision/锁 | Web、Agent、插件并发时 last-write-wins 丢数据 |
| Job 只保存可变 `prompt/model/params` | 无法保证原样重试或节点删除后的真实输入 |
| `canvas.json` 与 `project.json` 分两次写 | 崩溃可能只造成活动时间落后，不能承载跨文件业务事务 |
| 当前真实 data root 有 1 个空 v1 项目 | 没有可保留内容；落地时删除空项目并从正常入口创建 v2 项目 |

固定参考仓库把 nodes、connections、chat sessions、背景和 viewport 全塞进浏览器 Project 对象；媒体用
localforage storage key 旁挂。这里不复制浏览器真源和开放字符串插件节点，因为两者都绕开服务端所有权
校验。

## 文件布局

```text
canvases/<project_id>/
├── project.json                       # CanvasProject；小而稳定
├── canvas.json                        # CanvasDocument；交互热路径
├── uploads/<blob_id>.<ext>            # 用户上传的不可变 blob
├── outputs/<job_id>/...               # Job Runner 产物
├── derived/<operation_id>/...         # 确定性本地媒体工具产物
├── library/
│   ├── assets.json                    # 显式收藏/标签，不拥有 blob
│   └── prompts.json                   # 项目提示词库
├── agent/sessions/<session_id>.json   # 对话与批准记录
├── plugins/<plugin_id>/state.json     # 插件命名空间私有数据
└── .runtime/transactions/<op_id>.json # 跨 Job/document 写入的短期恢复日志

.runtime/jobs/<job_id>.json            # 全局统一 Job；Canvas Job 内嵌 Snapshot
```

约束：

- `canvas.json` 内的 `content_versions` 保存文本正文和媒体元数据；媒体字节仍只在 `uploads/`、
  `outputs/` 或 `derived/`。
- `.runtime/transactions/` 不是第二真源。事务完成即删除；启动/首次访问时只用于完成或回滚一次中断写入。
- 缩略图、波形和局部预览属于可重建缓存，不进入导出真源。
- WebDAV 和项目包消费同一份规范文件集合，不从浏览器状态另造导出格式。

## Pydantic / TypeScript 对称 schema

下列名称在 Python 与 TypeScript 保持一一对应。实现后去掉 `V2` 后缀，v1 类型直接删除。

### CanvasProject

```ts
interface CanvasProject {
  schema_version: 2;
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface CanvasProjectSummary extends CanvasProject {
  cover: { version_id: string } | null;
  node_count: number;
  connection_count: number;
}
```

`project.json` 不重复保存封面；封面从当前图片 Content Version 派生。复制、删除和导入导出是项目命令，
不是额外状态字段。`CanvasProjectSummary` 只用于列表响应；封面、节点数和连线数都从当前 Document 派生，
不写回 `project.json`。

### CanvasDocument

```ts
interface CanvasDocument {
  schema_version: 2;
  project_id: string;
  revision: number;
  updated_at: string;
  viewport: CanvasViewport;
  settings: CanvasSettings;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  content_versions: Record<string, CanvasContentVersion>;
}

interface CanvasSettings {
  background: 'lines' | 'dots' | 'none';
  show_image_info: boolean;
  show_minimap: boolean;
}
```

selection、hover、打开的 panel、拖拽中坐标、临时连线、撤销栈和 SSE 进度不持久化。成功保存一次才把
`revision` 加一；客户端基于服务端回包继续编辑。

### CanvasNode

所有节点共有 `id/title/position/size/z_index`。内建类型使用 Pydantic discriminated union；插件不使用
开放的 `"<pluginId>:<name>"` 作为 discriminator，而使用受控的 `type: "plugin"` envelope。

```ts
type CanvasNode =
  | CanvasTextNode
  | CanvasImageNode
  | CanvasVideoNode
  | CanvasAudioNode
  | CanvasConfigNode
  | CanvasGroupNode
  | CanvasPluginNode;

interface CanvasContentNodeData {
  current_version_id: string | null;
  generation_draft: CanvasGenerationDraft | null;
  active_run_id: string | null;
}

interface CanvasMediaDisplay {
  fit: 'contain' | 'cover';
  free_resize: boolean;
}

interface CanvasGroupNodeData {
  member_node_ids: string[];
}

interface CanvasPluginNodeData {
  plugin_id: string;
  node_type: string;
  plugin_version: string;
  data_schema_version: number;
  payload: JsonValue;
  generation_draft: CanvasGenerationDraft | null;
}
```

具体映射：

| type | data | 允许作为 Input source | 允许作为 Generation Surface |
|---|---|---:|---:|
| `text` | `CanvasContentNodeData` | 是 | 是 |
| `image` | content + `CanvasMediaDisplay` | 是 | 是 |
| `video` | content + `CanvasMediaDisplay` | 是 | 是 |
| `audio` | content | 是 | 是 |
| `config` | required `CanvasGenerationDraft` | 否 | 是 |
| `group` | `member_node_ids` | 否 | 否 |
| `plugin` | capability-checked envelope | manifest 决定 | manifest 决定 |

每个成员最多属于一个 Group；Group 不得成为成员。节点不保存 `job_ids` 或候选数组：历史 Run 从项目
Canvas Jobs 按 `surface_node_id/result_node_id` 查询，当前 Result Set 从 `active_run_id` 对应 Job 取得。

### CanvasContentVersion

```ts
type CanvasContentVersion = CanvasTextVersion | CanvasMediaVersion;

interface CanvasContentVersionBase {
  version_id: string;
  created_at: string;
  sha256: string;
  origin: CanvasContentOrigin;
}

interface CanvasTextVersion extends CanvasContentVersionBase {
  kind: 'text';
  text: string;
}

interface CanvasMediaVersion extends CanvasContentVersionBase {
  kind: 'image' | 'video' | 'audio';
  path: string;                 // 只允许本画布项目相对路径
  mime_type: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
}

type CanvasContentOrigin =
  | { kind: 'user_edit' }
  | { kind: 'upload'; upload_id: string }
  | { kind: 'user_mask'; source_version_id: string }
  | { kind: 'job_output'; job_id: string; candidate_id: string }
  | CanvasLocalToolOrigin
  | { kind: 'import'; package_id: string };

type CanvasLocalToolOrigin =
  | { kind: 'local_tool'; operation_id: string; source_version_id: string; operation: { kind: 'crop'; rect: NormalizedRect } }
  | { kind: 'local_tool'; operation_id: string; source_version_id: string; operation: { kind: 'split'; horizontal_lines: number[]; vertical_lines: number[]; row: number; column: number } }
  | { kind: 'local_tool'; operation_id: string; source_version_id: string; operation: { kind: 'upscale'; target_long_edge: number; algorithm: 'nearest' | 'bilinear' | 'lanczos' } };
```

Content Version 一旦出现，其 JSON 内容不得修改；任何替换都创建新 ID。媒体 `path` 必须落在
`canvases/<project_id>/uploads/`、`canvases/<project_id>/derived/<operation_id>/` 或
`canvases/<project_id>/outputs/<owned_job_id>/`，且文件摘要、大小与 MIME 重新由服务端
计算，客户端声明只作提示。普通文档保存不得删除或改写既有版本，也不得创建媒体版本；上传、Job、
本地媒体工具和导入命令由服务端创建媒体版本。Web 只可提交 `user_edit` 文本版本，服务端重算摘要并
校验 ID。物理 GC 只能由第 05 关定义的服务端命令执行。

### CanvasGenerationDraft

```ts
interface CanvasGenerationDraft {
  mode: 'text' | 'image' | 'video' | 'audio';
  prompt: string;                         // @ token 规范：@[node:<id>]
  input_policy: 'all_connected' | 'mentions_only';
  model: string;
  alias: string | null;
  params: JobParams;
  updated_at: string;
}
```

Draft 不保存 provider；提交时通过 alias/model 能力矩阵解析并冻结真实 provider。`params` 先沿用现有
`JobParams`，第 04 关再裁定按 mode 的字段白名单和规范化规则。

### CanvasConnection

```ts
type CanvasConnection = CanvasInputConnection | CanvasDerivationConnection;

interface CanvasInputConnection {
  id: string;
  role: 'input';
  source_node_id: string;
  target_node_id: string;
}

interface CanvasDerivationConnection {
  id: string;
  role: 'derivation';
  source_node_id: string;
  target_node_id: string;
  origin:
    | { kind: 'generation_run'; run_id: string }
    | { kind: 'local_tool'; operation_id: string };
}
```

文档 validator 实施第 02 关全部端点、重复边、自环、Config→Config、Group 和一层 membership 不变量。
`generation_run` Derivation Connection 的 `run_id/surface/result` 必须与一个本项目 Canvas Job 一致；
`local_tool` Derivation Connection 必须匹配目标 Content Version 的 immutable origin、operation_id 和源
version。普通文档 PUT 不能新造 Derivation Connection；它只能由生成提交或受控本地媒体命令写入。

### Canvas Job / Generation Snapshot

`Job` 保留现有统一字段，新增 canvas-only `canvas_run`；`namespace="canvas"` 时它必填，其他 namespace
时必须为空。

```ts
interface CanvasJobContext {
  run_id: string;
  snapshot: CanvasGenerationSnapshot;       // 创建后不可改
  result_node_id: string;
  candidates: CanvasResultCandidate[];      // Job Runner 独占写
}

interface CanvasGenerationSnapshot {
  snapshot_version: 1;
  surface_node_id: string;
  result_node_id: string;
  mode: 'text' | 'image' | 'video' | 'audio';
  final_prompt: string;
  input_policy: 'all_connected' | 'mentions_only';
  model: string;
  provider: string;
  alias: string | null;
  normalized_params: JsonValue;
  inputs: CanvasSnapshotInput[];
  mask_version_id: string | null;
  submitted_at: string;
  submitted_by: CanvasActor;
  request_fingerprint: string;               // canonical JSON SHA-256
}

interface CanvasSnapshotInput {
  order: number;
  source: 'implicit_self' | 'input_connection';
  node_id: string;
  version_id: string;
  kind: 'text' | 'image' | 'video' | 'audio';
}

interface CanvasResultCandidate {
  candidate_id: string;
  index: number;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  version_id: string | null;
  error: string | null;
}
```

Job 顶层 `prompt/model/params` 继续满足现有 runner；Snapshot 保存提交时规范化值，不随 caller 回写
`actual_size/warnings/mj_flags` 或 Web 编辑而变化。Canvas Job 禁用通用 `WebEditableJobPatch`。Run 的
`partially_succeeded` 从 candidates 推导；是否扩展全局 JobStatus 由第 04 关处理。

### 分域 sidecar envelope

资产、提示词、Agent 和插件的业务细节分别由第 05/06/07 关裁定，但 schema v2 先固定共同边界：

```ts
interface RevisionedSidecar<T> {
  schema_version: 1;
  revision: number;
  updated_at: string;
  items: T[];
}

interface CanvasLibraryAsset {
  asset_id: string;
  version_id: string;
  title: string;
  tags: string[];
}

interface CanvasPrompt {
  prompt_id: string;
  title: string;
  content: string;
  tags: string[];
  source: 'local' | 'public';
}

interface CanvasPluginState {
  schema_version: number;
  revision: number;
  plugin_id: string;
  plugin_version: string;
  data: JsonValue;
}
```

Agent session 按 session 单文件保存 message/op/approval envelope；不得复制 API key、环境变量或任意本地
文件内容。插件 state 只能由对应 plugin namespace 读写；未安装插件时数据保持惰性，不执行代码。

## 写入、并发与恢复

### 普通文档保存

```text
客户端携带 If-Match: <revision>
  → 获取 canvases/<id>/.canvas.lock
  → 读取并验证当前 revision
  → 应用领域命令/完整文档校验
  → revision + 1
  → atomic_write_json(canvas.json)
  → 更新 project.updated_at
  → 返回新文档与 ETag
```

revision 不匹配返回 `409 revision_conflict`，附当前 revision；不做字段级自动合并。保存失败保留客户端
dirty state，禁止静默覆盖。项目锁从现有 `job_lock` 抽出跨平台通用 `file_lock(path)`，Job 继续使用同一
实现的 per-job lock。

### 生成提交与结果落盘

创建 Job、Snapshot、结果占位节点和 Derivation Connection 是跨文件操作，使用短期 transaction：

1. 项目锁内解析输入并写 `transactions/<run_id>.json` prepared 记录。
2. 原子写 Canvas Job；Snapshot 此后不可变。
3. 原子写新 revision `canvas.json`，加入占位节点/active_run/Derivation。
4. 标记 transaction committed，锁外才把 Job 交给统一 runner，然后删除 transaction。
5. 崩溃恢复按 prepared 记录和两个文件的 fingerprint 完成缺失一步；两边都未提交则安全丢弃。

Runner 完成候选时重复使用 transaction，把 output、Content Version、candidate 与节点 current version
一起校验后提交。事务恢复从不根据“节点现在的内容”重造 Snapshot。

## 路径白名单与配额

首版硬限制用于阻断损坏/压缩炸弹，不是产品套餐：

| 对象 | 限制 |
|---|---:|
| 单图片上传 | 10 MiB（沿用现状） |
| 单视频/音频上传 | 100 MiB（沿用现状） |
| `canvas.json` 请求体 | 25 MiB |
| 单项目节点 / 连接 | 10,000 / 20,000 |
| 单插件节点 payload | 256 KiB |
| 单插件项目私有 state | 1 MiB |
| 导入 zip 压缩体积 | 2 GiB |
| 导入 zip 解压体积 / 条目数 | 10 GiB / 20,000 |
| 单条目压缩比 | 100:1 |

导入拒绝绝对路径、`..`、反斜杠逃逸、symlink/hardlink、重复规范路径、未列入 manifest 的文件、摘要
不符、未知 schema、越限嵌套和可执行文件。图片/音视频扩展名只作第一层检查，服务端还要 sniff MIME。

媒体读取 API 不再接受 `path` 查询参数；只接受 `version_id`，服务端从 Content Version 解析并重新校验
项目目录、Job 所有权与真实文件。导出包不包含密钥、全局 provider 配置、插件代码或缓存。

## v2 直接切换

项目工程规则禁止兼容层和 migration，因此 `GET document` 不自动升级，也不让 v1/v2 Pydantic union
进入运行时。v2 在一个实现提交内完成以下动作：

1. 删除 Python/TypeScript v1 schema、旧 API 字段和旧前端分支。
2. 直接创建 v2 project/document/library，运行时代码只接受 `schema_version: 2`。
3. 删除当前唯一的空 v1 项目；该项目没有上传、Job 或用户内容，不需要转换。
4. 用正常“新建画布”入口创建 v2 项目，再跑 schema、API、Job、路径白名单和前端全量测试。

如果落地前发现任何非空 v1 项目，停止切换并交由用户决定数据去留；不在代码库中增加 converter、
fallback、备份恢复命令或双 schema 路径。

## API 变更表

| API | v2 变化 |
|---|---|
| `GET /canvas/projects` | 返回 schema v2 summary；封面由 Content Version 派生 |
| `POST /canvas/projects` | 直接创建 v2 project/document/libraries |
| `PUT /canvas/projects/{id}/document` | 必须 `If-Match`；只接受 v2；用户 PUT 不能创建 Derivation |
| `GET .../media?path=&job_id=` | 删除 |
| `GET .../content/{version_id}` | 新增；按 version ownership 读取媒体/文本元数据 |
| `POST .../uploads` | 返回 Content Version，不再返回可写入文档的裸 path |
| `POST .../jobs` | 删除外部任意 prompt/path 入口 |
| `POST .../runs` | 新增；只提交 surface node id、expected revision，服务端解析并冻结 Snapshot |
| `POST .../runs/{run_id}/retry` | 新增 `original/current` 两种明确语义 |
| `GET .../jobs` | 保留；返回项目 Canvas Jobs/Run 数据 |
| project delete/export/import | 新增；统一走项目命令和项目级锁；导入分配新项目 ID |
| library/agent/plugin API | 分别由第 05/06/07 关细化，全部使用 revision/namespace 校验 |

## `docs/api-contract.md` 更新清单

方案确认并实现 schema 时一次性更新：

- 顶部同步表把 `CanvasProject/CanvasDocument/CanvasJobContext` 指向 Python/TS 对称类型和新测试。
- 人工画布契约改写为 Domain v2 术语，删除 provenance、generation node 和 `job_ids` 旧语义。
- Job 契约补充 canvas-only snapshot、candidate 与通用 Web patch 禁止项。
- 写 API 增加 revision/ETag/409 契约；媒体读取改成 version ID 白名单。
- 加入项目包 manifest、配额、失败原子性和 v1 不被运行时接受的 cutover 说明。

当前 `docs/api-contract.md` 继续描述已运行的 v1，不提前伪装成尚未实现的 v2。

## 测试与 Exit Gate

### Python

- Pydantic/TS fixture parity：七类节点、两类边、版本、Snapshot/candidate、sidecar envelope。
- graph validator：缺失端点、自环、重复边、Group、Config→Config、伪造 Derivation、跨项目版本。
- immutable validator：已有 Content Version 或 Snapshot 被 PUT 改写时拒绝。
- revision：连续保存、旧 revision 409、并发锁、写失败保持原 checksum。
- media/import：路径逃逸、symlink、MIME 欺骗、zip bomb、摘要/Job ownership。
- transaction recovery：四个崩溃点逐一恢复且 Job/Snapshot/document 一致。

### TypeScript

- schema fixture typecheck；React Flow adapter 不把运行态写回领域文档。
- autosave conflict 保留 dirty state；409 不覆盖服务端版本。
- `@` token 与连接解析只产生临时 Resolved Input，请求体不携带裸路径。

### Cutover evidence

- repo 搜索确认 Python/TypeScript v1 schema、旧 API 字段和旧前端分支零残留。
- 正常“新建画布”入口直接产生通过 v2 validator 的 project/document/library。
- 缺失文件、非法路径和损坏 Job 三类输入均被 v2 validator/API 拒绝。
- 全量 schema、API、Job、路径白名单与前端测试通过，运行时不包含双版本分支。

## 需要确认的方案 B/C 对比

### A. 推荐：文档内 Content Version + Job Snapshot + revision sidecar

优点：节点和内容引用单文件原子保存；删除节点仍保留版本；热文档不包含聊天/插件大对象；最贴合现有
文件真源。代价：`canvas.json` 会随文本/媒体元数据历史增长，需要第 05 关定义 GC/归档。

### B. 每个 Content Version 一个 JSON 文件

拒绝：读写节点会跨多个文件，生成完成需要更复杂的事务与恢复；10,000 节点下小文件数量也更高。

### C. 把所有项目状态和历史塞进一个 Project JSON

拒绝：参考项目浏览器结构虽简单，但 Agent 消息、插件 state 和内容历史会放大 autosave、冲突与损坏
半径，也无法对插件私有数据实施清晰权限。

## Decision

2026-08-23：用户要求继续开发，确认采用方案 A；ADR-0008 已接受。第 03 关在切换证据通过后关闭。
