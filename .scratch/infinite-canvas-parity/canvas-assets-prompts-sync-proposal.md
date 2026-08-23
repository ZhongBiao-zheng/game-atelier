# Canvas 项目、资产、提示词与同步归属方案

Status: ready-for-agent

## Decision

2026-08-23 用户确认方案 A：Canvas Project 是 owner；跨 Canvas、创作台、工坊只做显式复制；项目内
Library Entry 复用 Content Version；项目包导入创建新项目；WebDAV 分叉创建冲突副本；公共 Prompt
编辑或加入库后成为项目本地内容。

## 结论摘要

推荐方案 A：**画布项目是内容所有权边界；同一项目内复用 Content Version，跨画布、创作台与工坊
一律显式复制；WebDAV 同步不可变项目快照，分叉时保留冲突副本，不做 last-write-wins 自动合并。**

这保留参考基线的资产库、公共提示词、批量导入导出和 WebDAV 可观察能力，同时适配
game-atelier 已确认的独立人工空间、文件系统真源、不可变 Content Version 与 Job Snapshot：

- 画布上传、生成结果、Library Entry、Local Prompt、Canvas Job、Agent 会话和插件状态均由单一
  Canvas Project 拥有。
- Library Entry 只是对本项目 Content Version 的收藏/标签，不复制字节，也不改变节点。
- 从另一个画布、创作台或工坊取内容时，服务端把字节和必要元数据复制进目标画布，之后双方独立。
- 发布到工坊是用户明确选择目标后的复制归档；工坊得到自己的资产版本和血缘记录，不与画布活同步。
- 项目 ZIP 是规范化、带摘要、可离线恢复的完整项目包；导入永远创建新 Canvas Project。
- WebDAV 复用同一规范文件集合与 content-addressed blob，但以快照谱系同步；双端分叉时远端内容导入为
  “冲突副本”，绝不按时间戳静默覆盖。
- API Key、WebDAV 密码、全局 provider 配置、插件代码、缓存和运行中事务永不进入项目包或同步快照。

固定基线没有“复制整个画布项目”入口，只有复制节点；因此不新增项目复制命令。再次导入同一项目包
已经覆盖“以此为起点”的实际需要，并保持基线一致。

## 核对结果

### 参考基线

| 领域 | 固定基线行为 | 需要适配的风险 |
|---|---|---|
| 项目资产 | 全局 Zustand/localforage 资产库；text/image/video 可收藏、编辑、删除、插入 | 全局库没有项目所有权，删除依赖递归扫描浏览器状态 |
| 项目导出 | format v3 ZIP；项目 JSON 连同 storageKey 对应媒体 | 缺摘要/条目上限/路径白名单；缺失 blob 会被静默跳过 |
| 项目导入 | 浏览器解包，媒体按原 storageKey 写入；项目分配新 ID | 节点/连接/会话 ID 原样保留；未严格验证 schema、摘要与压缩炸弹 |
| 项目删除 | 确认后从浏览器 store 删除，再清理无引用媒体 | 没有事务、恢复窗口或跨设备 tombstone |
| 公共提示词 | 7 个内置 JSON 源 + 自定义 URL；浏览器抓取、标准化、搜索/标签 | 任意 URL 在浏览器请求；校验宽松，远端数据和图片仍是不可信输入 |
| 提示词缓存 | 每源 localforage 缓存；1 小时 TTL；刷新失败保留上次成功内容 | 只有本浏览器可见，离线媒体预览不保证 |
| 设置导出 | JSON 包含 AI config、API Key、WebDAV password、提示词源 | 明文凭证外泄，已列入适配拒绝项 |
| WebDAV | canvas/assets/image log/video log 分域；按 ID + 时间戳 last-write-wins 合并 | 并发覆盖、删除复活、同 ID 分叉被吞、浏览器持有 WebDAV 凭证 |

### game-atelier 当前事实

| 事实 | 本关约束 |
|---|---|
| Canvas 媒体必须在本项目 uploads/outputs 且 Job 登记 | 跨空间不能留下裸路径或活引用 |
| 工坊资产由项目永久拥有 | Canvas 发布必须复制为目标拥有的新版本 |
| Studio 归档已采用复制 + 新 Job + archived_from 血缘 | Canvas→工坊沿用同一所有权模式，不复用源文件 |
| schema v2 的 Content Version 与 Snapshot 不可变 | 重命名/替换/删除不能改写历史 |
| library/assets.json 与 prompts.json 已确定为项目 sidecar | 资产库和本地提示词以项目为边界 |
| 文件系统是唯一真源 | 抓取、ZIP、WebDAV 都由服务端执行和验证 |

## 所有权矩阵

| 对象 | 永久 owner | 字节/真源位置 | 可被谁修改 | 项目包 | WebDAV |
|---|---|---|---|---:|---:|
| Project metadata | Canvas Project | project.json | 项目命令 | 是 | 是 |
| Canvas Document / Content Versions | Canvas Project | canvas.json + uploads/outputs | 领域命令/Job Runner | 是 | 是 |
| Canvas Job / Snapshot / candidates | Canvas Project | .runtime/jobs 中按 project 归属 | Job Runner；Snapshot 不可变 | 是 | 是 |
| Library Entry | Canvas Project | library/assets.json | 用户/获批 Agent 操作 | 是 | 是 |
| Local Prompt | Canvas Project | library/prompts.json | 用户/获批 Agent 操作 | 是 | 是 |
| Public Prompt Source 配置 | 应用本机配置 | .config/canvas-prompt-sources.json | 用户 | 否；走设置包 | 可选设置域 |
| Public Prompt Cache | 可重建运行缓存 | .runtime/prompt-sources/ | 服务端抓取器 | 否 | 否 |
| Agent Session | Canvas Project | agent/sessions/ | Agent host | 是 | 是 |
| Plugin State | Canvas Project + plugin namespace | plugins/<id>/state.json | 对应已授权插件 host | 是 | 是 |
| Plugin code | 应用安装环境 | plugin registry/cache | 安装器 | 否 | 否 |
| Provider/API/WebDAV secret | 本机 credential config | .config/，日志强制脱敏 | 设置服务 | 否 | 否 |
| Workshop imported copy | 目标 Canvas Project | 目标 uploads + Content Version | 目标项目命令 | 是 | 是 |
| Canvas published copy | 目标 Workshop Project | 目标正式版本目录 + 新 Job | 工坊命令/Job Runner | 不随 Canvas 包 | 不随 Canvas 同步 |

“永久 owner”回答删除、导出和权限问题；来源血缘只说明它从哪里来，不赋予源空间继续控制副本的权利。

## 数据流

```text
另一个 Canvas / 创作台 / 工坊已登记内容
                    │ 用户显式“导入到画布”
                    ▼
         服务端鉴权、sniff、摘要、复制
                    ▼
目标 Canvas Content Version ──同项目引用──▶ 节点 / Library Entry / Snapshot
                    │
                    ├──用户显式“发布到工坊”──▶ 复制为 Workshop 自有版本 + 来源血缘
                    │
                    └──项目快照────────────────▶ ZIP 或 WebDAV snapshot

公共 Prompt JSON ──服务端不可信抓取/缓存──▶ 搜索与预览
                    │ 用户插入或编辑
                    ▼
     Text Content Version / 项目 Local Prompt（与远端脱钩）

WebDAV remote snapshot ──校验 lineage + 摘要──┬──fast-forward 原项目
                                              └──分叉时导入冲突副本
```

只有同一 Canvas Project 内允许直接引用 Content Version；图中的每一次跨边界箭头都产生目标 owner
自己的副本或不可变快照。

## 资产模型

### Library Entry 不拥有第二份内容

```ts
interface CanvasLibraryAsset {
  asset_id: string;
  version_id: string;       // 必须属于同一 Canvas Project
  title: string;
  tags: string[];
  note: string;
  created_at: string;
  updated_at: string;
}
```

- “保存到资产库”创建 Library Entry，指向现有 Content Version；不复制媒体。
- 同一 version 最多一个 Library Entry；再次保存聚焦已有条目，避免重复卡片。
- Library Entry 的标题、标签、备注可变；Content Version、节点标题和历史 Snapshot 不受影响。
- “替换资产内容”创建新的 Content Version，只把该 Library Entry 的 version_id 切到新版本；已插入的
  节点继续指向原版本，除非用户另外执行“替换此节点”。
- 从本项目资产库插入画布时，创建一个新节点指向同一 Content Version；节点删除不删除资产条目。
- 图片、视频、音频和文本都可进入资产库。音频补齐参考基线 store 当前遗漏的类型，符合已确认矩阵。
- 直接“上传到资产库”先在指定 Canvas Project 创建 upload Content Version，再创建 Library Entry，
  不强制在画布上生成节点。
- 项目编辑器侧栏只展示当前项目资产；Canvas 资产总览页可以聚合搜索所有画布项目的 Library Entry，
  但从总览把另一个项目的资产插入当前画布时仍走 transfer copy，聚合视图不改变 owner。

### 去重边界

- 媒体字节以 SHA-256 为物理身份，同一项目内可以让多个 Content Version 复用同一只读 blob。
- Content Version 代表一次语义来源事件；即使摘要相同，从工坊再次导入也可创建新 version 记录并保留
  新的 transfer origin，但不重复存储字节。
- Job outputs 保留原 outputs/<job_id>/ 路径，不为了去重移动或硬链接；导入/上传 blob 才使用项目内
  content-addressed 存储。禁止 hardlink 跨项目，以免所有权和删除互相影响。
- 不跨项目做文件级去重。节省的一点磁盘不值得引入跨 owner 引用与删除耦合。

### 跨空间传递

新增 Content Origin：

```ts
type CanvasTransferOrigin = {
  kind: 'transfer';
  source_space: 'canvas' | 'studio' | 'workshop';
  source_project_id: string | null;
  source_job_id: string | null;
  source_version_id: string | null;
  source_sha256: string;
  imported_at: string;
};
```

服务端只从已登记、当前用户可读的源对象解析内容；请求体不接受任意源路径。

#### 从另一个画布/创作台/工坊导入

1. 用户在资产选择器中明确选择来源和目标 Canvas Project。
2. 服务端验证来源 owner 与媒体登记，读取并 sniff 内容。
3. 在目标项目内复制字节，创建 transfer Content Version。
4. 可选同时创建 Library Entry 或节点；两个动作在项目锁和事务内提交。
5. 源对象之后被替换、隐藏或删除，不影响目标项目。

#### 发布到工坊

1. 用户从 Canvas Content Version/成功 candidate 执行“发布到工坊”。
2. UI 只展示媒体类型兼容且真实存在的工坊目标：
   - image → 角色立绘/美宣/三视图、UI 页面；
   - video → 视频企划；
   - text/audio 暂无工坊 owner，不伪造目标。
3. 服务端复制到目标正式版本目录，并创建目标 namespace 的新 Job/版本记录。
4. 血缘保存 canvas_project_id、source_version_id、source_job_id 与 source_sha256。
5. 发布不是移动，也不是持续同步；重复发布产生新的工坊版本，绝不覆盖。

这沿用现有 Studio archive 的“复制 + 新 Job + 显式目标”模式，但需要抽出通用的已登记来源解析器，
不能让 Canvas 冒充 namespace=studio 绕过所有权。

## 删除影响表

| 用户动作 | 立即变化 | 不会变化 | 物理字节 |
|---|---|---|---|
| 删除节点 | 节点/相关可视边消失 | Content Version、Job、Snapshot、Library Entry | 保留 |
| 清空/替换节点 | current_version_id 改变 | 旧 version、历史 Snapshot、资产条目 | 保留 |
| 删除 Input/Derivation | 当前输入资格/画布叙事改变 | Job 与 Snapshot | 保留 |
| 从资产库删除 | Library Entry 消失 | 节点、Content Version、Job | 保留 |
| 替换资产库内容 | 条目指向新 version | 旧节点与历史 | 新旧均保留 |
| 删除 Local Prompt | 本地条目消失 | 已插入文本节点/历史 Snapshot | 无媒体副作用 |
| 禁用/删除 Prompt Source | 不再搜索或刷新该源 | 已 fork 的 Local Prompt、已插入节点、上次缓存 | 缓存可延迟清理 |
| 删除 Job candidate 展示槽 | active/primary 展示关系改变 | Job、candidate、Snapshot、version | 保留 |
| 删除 Canvas Project | 从项目索引消失并产生删除 tombstone | 已发布到工坊的副本 | 项目与 owned Jobs 原子移入 trash |
| 清空 trash | 恢复能力消失 | 工坊副本、其他画布副本 | 删除该项目全部 owned bytes/jobs |

活动项目内不自动 GC Content Version 或 Job 历史。项目删除先原子移入
`.trash/canvases/<project_id>/<deleted_at>/`，关联 Canvas Job 同事务移入 trash 并写 tombstone；默认保留
30 天后由维护任务清理。UI 仍满足“确认删除后立即从列表消失”，但崩溃或误删可恢复。批量删除逐项目
事务，单个失败不声称全部成功。

WebDAV 已关联项目的删除会同步 tombstone；另一设备收到后同样移入本地 trash。用户可以从 trash 恢复为
新项目 ID，避免与已经传播的 tombstone 争夺原 ID。

## 公共提示词与本地提示词

### 两层模型

1. **Prompt Source / Cache（应用级）**：远端只读目录，用于搜索、预览、复制和插入。
2. **Local Prompt（项目级）**：用户明确“加入提示词库”或编辑公共条目时创建的本地快照，之后与远端
   来源独立。

公共提示词直接插入文本节点时，节点创建自己的 Text Content Version，并把 source_id、remote_prompt_id、
source_content_hash 和 fetched_at 作为 origin metadata；远端刷新不改写节点。编辑公共提示词前自动 fork
为 Local Prompt。

### Prompt Source schema

```ts
interface CanvasPromptSource {
  source_id: string;
  name: string;
  url: string;
  homepage: string | null;
  enabled: boolean;
  built_in: boolean;
  refresh_interval_minutes: 0 | 30 | 60 | 360 | 1440;
}

interface NormalizedPublicPrompt {
  source_id: string;
  remote_id: string;
  title: string;
  content: string;
  description: string;
  tags: string[];
  cover_url: string | null;
  reference_image_urls: string[];
  author: string | null;
  source_url: string | null;
  model_hints: {
    image_mode?: string;
    image_model?: string;
    image_size?: string;
    image_count?: number;
  };
  source_updated_at: string | null;
  content_hash: string;
}
```

兼容参考仓库现有 JSON 数组字段，但服务端执行严格 schema/大小上限。未知字段忽略；没有 title 或 prompt
的项拒绝；同源 remote_id 重复拒绝后项并记录 warning，而不是让它覆盖前项。

### 抓取与信任

- 7 个内置源固定随应用版本登记；自定义源必须由用户显式添加。
- 服务端抓取，浏览器不直接 fetch 任意 URL。默认只允许 HTTPS。
- DNS 解析和每次 redirect 后都拒绝 loopback、private、link-local、multicast、metadata IP 与非 HTTP(S)
  scheme；不携带 cookies、provider key 或 WebDAV header。
- 连接/读取分别 10/30 秒；JSON 最大 10 MiB、10,000 条、最大嵌套 16；响应先检查 MIME 再解析。
- 一个源同一时间最多一次刷新；失败记录友好错误并继续提供上次成功缓存。
- 刷新计划只在 viewer-server 运行时执行，UI 不暗示关闭应用后仍会后台同步。
- JSON 只是数据，绝不支持 script/eval/template execution。
- 文本、标签与 URL 作为不可信内容转义；远端图片不进入 /api/raw 白名单。
- 离线时搜索、正文、标签和来源 attribution 来自最后成功 JSON 缓存；封面只作可重建预览缓存。真正作为
  生成参考的远端图片必须由用户明确导入项目并经过同一 MIME/大小校验。

## 项目包契约

### 规范布局

```text
game-atelier-canvas-v1.zip
├── manifest.json
├── projects/<package_project_id>/
│   ├── project.json
│   ├── canvas.json
│   ├── library/assets.json
│   ├── library/prompts.json
│   ├── agent/sessions/*.json
│   ├── plugins/*/state.json
│   └── jobs/*.json
└── blobs/sha256/<first2>/<sha256>.<ext>
```

`manifest.json`：

```ts
interface CanvasPackageManifest {
  app: 'game-atelier';
  kind: 'canvas-project-package';
  format_version: 1;
  package_id: string;
  exported_at: string;
  projects: Array<{
    package_project_id: string;
    original_project_id: string;
    entry_paths: string[];
  }>;
  entries: Array<{
    path: string;
    sha256: string;
    bytes: number;
    mime_type: string;
    role: 'metadata' | 'blob';
  }>;
}
```

### 导出

- 单项目和多选项目使用同一格式；媒体完整内嵌，缺失任何被引用 blob 时导出失败并列出问题，不生成
  “看似成功但打开缺图”的包。
- 包含项目文档、项目 library、Canvas Jobs/Snapshots/candidates、Agent sessions 和 plugin state，才能
  恢复参考基线可观察的历史、会话与插件节点状态。
- 不包含 project runtime transaction、缩略图/波形缓存、prompt source cache、provider/WebDAV 凭证、
  全局配置、插件代码或 trash。
- 模型 alias 可以作为草稿偏好保留；导入机器缺少该 alias 时显示“未配置”，不能偷偷换默认 provider。
- 选中节点/整图“导出内容”是用户交付 ZIP（媒体、txt/json），不是可再次导入的项目包；两种动作和文案
  必须分开。

### 导入

- 导入总是创建新 Canvas Project；不覆盖、不合并现有项目，也不提供独立“复制项目”命令。
- 保留项目内 node/version/connection/session/plugin-local ID，因为它们都由新 project namespace 隔离。
- 为所有全局 Canvas Job ID、Run ID 和 output path 分配新 ID，并完整重写 retry_of、Snapshot、candidate、
  Derivation、Content Origin 等内部引用；找不到对应关系则整项目导入失败。
- 所有媒体按 sha 校验后写入目标项目；Content Version path 由服务端重建，不信任包中裸路径。
- 多项目包逐项目 staging/校验，再一次性提交成功项目；默认 all-or-nothing。UI 可在失败报告后让用户重新
  选择“只导入通过校验的项目”，但不能静默跳过。
- 延续第 03 关限制：压缩 2 GiB、解压 10 GiB/20,000 条、单条目压缩比 100:1，并拒绝路径逃逸、
  symlink/hardlink、重复规范路径、未知 schema、摘要不符和可执行文件。

## WebDAV 同步契约

### 同步单位与远端布局

WebDAV 是可选的 Canvas 数据同步器，不接管整个 data root。同步单位是单个 Canvas Project；资产、Local
Prompt、Job、Agent session 和 plugin state 随所属项目一起走。另有可选的非敏感 Canvas Settings 域，
只同步模型默认偏好和 Prompt Source URL/启停/刷新间隔。

```text
<directory>/game-atelier/canvas/v1/
├── projects/<project_id>/
│   ├── latest.json
│   └── snapshots/<snapshot_id>.json
├── blobs/sha256/<first2>/<sha256>
├── tombstones/<project_id>.json
└── settings/
    ├── latest.json
    └── snapshots/<snapshot_id>.json
```

Snapshot manifest 是不可变对象，包含 package format 同构的 entry 清单、project revision、
`snapshot_id`、`parent_snapshot_id` 和各文件摘要；blob 按摘要寻址，多项目共享远端 blob，但本地仍各自
拥有副本。先上传缺失 blob，再上传 snapshot，最后通过 ETag 条件 PUT 更新 latest pointer，任何中断都
不会让 latest 指向不完整快照。

### 同步状态机

| 本地/远端关系 | 行为 |
|---|---|
| 远端不存在 | 上传本地为首个 snapshot |
| 本地未改，远端是 last_synced 后代 | 校验后 fast-forward 本地 |
| 远端未改，本地有新 revision | 上传本地后代并条件更新 latest |
| 本地和远端都未改 | no-op |
| 双方都从 last_synced 分叉 | 保留本地；远端导入为新 ID 的“冲突副本” |
| latest 在上传中被别人更新 | 重新读取；按上面规则 fast-forward 或冲突副本 |
| 远端 tombstone 是后代 | 本地项目移入 trash |
| 本地已删除且远端未分叉 | 上传 tombstone |
| 本地删除与远端编辑分叉 | 不吞编辑；远端恢复为冲突副本，本地原 ID 维持删除 |

禁止参考实现的 `updatedAt` last-write-wins 字段合并。Canvas Document、Job、Agent 和插件 state 都有各自
revision/不可变历史，字段级合并无法安全重建跨文件事务；冲突副本虽多一个项目，但不会丢内容，也更符合
个人创作工具的可理解性。

若 WebDAV 服务不正确支持 ETag/If-Match/If-None-Match，双向同步测试必须失败并提示“此服务仅可用于手动
备份导出”，不能退回无条件覆盖 latest。

### 凭证与设置包

- WebDAV URL、directory、username、credential handle 保存在本机 `.config/webdav.json`；password/token
  使用与 provider key 同级的本机 secret 存储与日志脱敏，不写入项目。
- 浏览器只调用 localhost FastAPI；PROPFIND/GET/PUT/MKCOL 和 Basic/Bearer header 均由服务端执行。
- 设置 JSON 只导出非敏感模型偏好、Prompt Source 和 WebDAV URL/directory/username；credential 字段固定
  为 `required_on_import: true`，不导出 API Key、password 或 token。
- 导入设置先展示 diff 并由用户确认，不自动覆盖当前默认模型或 source 列表。
- 删除远端快照/blob 不在自动同步主路径；远端 GC 只删除所有 latest/tombstone 都不可达且超过 30 天的
  blob，并提供 dry-run 报告。

## API 提案

| API | 语义 |
|---|---|
| GET/PUT .../library/assets | revision + If-Match；项目内 asset entries |
| POST .../library/assets | 保存 version 或导入已验证 transfer source |
| PATCH/DELETE .../library/assets/{asset_id} | 改 metadata/删 entry，不删 version |
| POST .../library/assets/{asset_id}/insert | 创建指向同 version 的节点 |
| POST .../transfers | 从 Canvas/Studio/Workshop 已登记对象复制进本项目 |
| POST .../publications | 从 Content Version 显式复制到兼容工坊目标 |
| GET/PUT .../library/prompts | 项目 Local Prompts，revision + If-Match |
| GET/POST/PATCH/DELETE /canvas/prompt-sources | 应用级 source 配置 |
| POST /canvas/prompt-sources/{id}/refresh | 服务端刷新；失败保留上次成功 cache |
| GET /canvas/public-prompts | 查缓存；keyword/tag/source/page |
| POST /canvas/projects/export | 服务端流式生成单/多项目包 |
| POST /canvas/projects/import/inspect | staging 校验并返回报告，不写 live |
| POST /canvas/projects/import/commit | 基于 inspect token 原子导入新项目 |
| DELETE /canvas/projects/{id} | 确认 token + expected revision；移入 trash/tombstone |
| POST /canvas/projects/{id}/sync | 单项目 WebDAV 状态机 |
| POST /canvas/sync | 已启用项目批量同步，逐项目返回结果 |
| POST /canvas/webdav/test | 服务端测试 auth、写读删与条件请求 |
| GET /canvas/storage | 按项目统计 metadata/uploads/outputs/jobs/cache/trash |

所有 mutating API 都通过 project lock、revision 和原子写；transfer/publication/import/delete/sync 用第 03 关
的短期 transaction 模式。接口只收稳定 ID，不收任意本地 path。

## 故障与反例核对

| 场景 | 结果 |
|---|---|
| 工坊原图后来被删除 | Canvas 拥有副本，节点和 Snapshot 可继续读取 |
| Canvas 内容发布后继续编辑 | 工坊版本不变；再次发布产生新版本 |
| 同一资产插入十个节点 | 十个节点共享本项目 version，不复制十份媒体 |
| 删除资产库卡片 | 已插入节点和历史不丢 |
| 删除源节点后原设置重试 | Snapshot 引用 version 仍在，允许精确重试 |
| 公共 Prompt Source 下线 | 最后成功正文/搜索可用；已 fork/插入内容完全独立 |
| 恶意 Prompt URL 指向 127.0.0.1 | 服务端 SSRF 校验拒绝 |
| ZIP 含 ../、symlink、重复路径或摘要不符 | inspect 失败，live 零写入 |
| 包内引用不存在 Job/Version | 整个对应项目失败，不伪造或丢弃历史 |
| 两台设备离线修改同一画布 | 本地保留，远端形成冲突副本；无内容被覆盖 |
| 一端删除、一端继续编辑 | 删除 tombstone 与编辑分叉，编辑侧成为冲突副本 |
| WebDAV 上传 blob 后断电 | latest 未更新，孤立 blob 可由延迟 GC 清理 |
| 导入机器没有原 alias/plugin | 草稿标未配置、插件节点惰性显示；不换模型、不执行代码 |
| 导出设置包 | 不含 API Key/WebDAV password/token |

## 方案比较

| 方案 | 优点 | 代价/风险 |
|---|---|---|
| A. 项目 owner + 跨域复制 + 快照谱系同步（推荐） | 独立空间成立；删除/离线/历史可解释；不丢并发修改 | 跨项目占用更多本地空间；冲突时多一个项目 |
| B. 全局资产库 + 跨空间活引用 + 时间戳合并 | 表面节省空间，接近参考源码 | 删源即断链；路径白名单和项目导出失真；并发内容静默丢失 |
| C. 只做 ZIP 备份，不做双向 WebDAV | 最简单、安全 | F11 不等价；用户无法跨设备持续同步 |

## 本关需确认

推荐确认方案 A，并把“独立空间”落实为以下不可逆规则：

1. **跨 Canvas/创作台/工坊只复制，不活引用；发布与导入必须是用户显式动作。**
2. **项目内 Library Entry 复用 Content Version；删条目/节点不删除历史字节。**
3. **ZIP 导入永远新建项目；无“复制整个项目”功能。**
4. **WebDAV 使用不可变快照谱系；分叉创建冲突副本，不做按时间戳覆盖。**
5. **提示词源是服务端校验的只读数据源；编辑/加入库后 fork 为项目本地 Prompt。**
