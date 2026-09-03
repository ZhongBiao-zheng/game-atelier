# API 契约

> 前后端形状的单一真值源。**改任一端先改这里**。厂商侧契约见 [references/provider-config.md](references/provider-config.md)。

## 开发中的扩展契约

网站连接本机与外部 Agent 工坊入口已进入分阶段开发：
[开发范围与验收](local-workspace.md)、[本机连接](contracts/local-connection.md)、
[工坊 MCP 与生成批准](contracts/workshop-mcp.md)。本地整合分支已实现状态、鉴权、授权、编辑租约、
工坊 typed 工具与批准执行；网站配对 / CORS / 媒体票据仍是未开放的目标，不得混称上线。

改造不把项目改存浏览器、不把 Key 发给网站、不扩张 Canvas Agent 权限，也不增加第二条供应商执行路径。

`GET /api/connection/status` 返回 `{ service: "game-atelier", instance_id, app_version, protocol: "atelier-local/1" }`。
instance 是每次启动的 32 位小写十六进制标识，不是访问凭据；app_version 从插件 manifest 读取。
响应 `Cache-Control: no-store`，不读取用户配置或数据。本地协议就绪不代表网站已配对，
不能据此开放跨源调用或跳过鉴权；旧 null 协议不被新前端继续使用。

P1b 对全部路由先校验实际监听 Host、精确 Origin 与浏览器 Fetch Metadata；地址不符返回 421
`HOST_DENIED`，来源不符返回 403 `ORIGIN_DENIED`。错误为
`{ error: { code, message, request_id } }`，不回显来源或密钥，并设置 `Cache-Control: no-store`。
当前鉴权覆盖业务 API、媒体、SSE 与内部文档；本地 cookie / Agent bearer 不得混用。
本地写入需要编辑租约（设置 / 授权管理除外），Agent 只可调用授权项目内的工坊工具。
未知 API 默认 `CAPABILITY_DENIED`，未认证返回 `CONNECTION_REQUIRED`；不存在匿名原生业务旁路。
开发来源登记与导航例外见连接契约。

## 双端同步点

改左边必须同步右边，反之亦然。没有代码层共享，只有约定 + 守卫。

| 契约 | Python | TypeScript | 守卫 |
|---|---|---|---|
| LocalConnectionStatus | `viewer_server/connection_status.py` | `web/src/schema/connection.ts` | `tests/test_connection_status.py` |
| LocalConnectionBoundaryError | `viewer_server/request_boundary.py` | `web/src/schema/connection.ts` | `tests/test_local_request_boundary.py` + `api/http.test.ts` |
| 本地会话 / Agent grant / 编辑租约 | `viewer_server/connection_routes.py` | `web/src/api/connection.ts` + `api/agentGrants.ts` | `tests/test_local_connection_auth.py` + `api/connection.test.ts` |
| 工坊目标 / 生成请求 | `lib/workshop_schema.py` + `lib/workshop_generation.py` | `web/src/api/workshopRequests.ts` | `tests/test_workshop_runtime.py` + `tests/test_workshop_mcp.py` |
| Job / JobParams | `lib/schemas.py` | `web/src/schema/jobs.ts` | 无 —— 靠人 |
| Key / ModelSpec | `lib/keys.py` | `web/src/api/keys.ts` | 无 —— 靠人 |
| CharacterDerivative / CharacterEntry | `lib/schemas.py` | `web/src/schema/jobs.ts` | `tests/test_character_derivatives.py` + `LeftSidebar.test.tsx` |
| CharacterAssociationTarget / CharacterAssociationItem | `lib/schemas.py` | `web/src/schema/jobs.ts` | `tests/test_character_workspace.py` + `CharacterAssociationPicker.test.tsx` |
| CharacterWorkspaceResponse / CharacterIndexResponse | `lib/schemas.py` | `web/src/api/characters.ts` | `tests/test_character_workspace.py` + `CharacterWorkspace.test.tsx` + `CharacterIndex.test.tsx` |
| ProjectIndexItem / GalleryMedia | `lib/schemas.py` | `web/src/api/gallery.ts` | `tests/test_gallery_project.py` + `ProjectIndexPage.test.tsx` + `ProjectPage.test.tsx` |
| StudioArchiveTarget | `lib/studio_archive.py` | `web/src/api/studio.ts` | `tests/test_studio_archive.py` + `StudioArchiveDialog.test.tsx` |
| CanvasProject / CanvasDocument / CanvasJobContext | `lib/schemas.py` | `web/src/schema/canvas.ts` + `schema/jobs.ts` | `tests/test_canvas_projects.py` + `CanvasEditor.test.tsx` |
| CanvasUiPreferences | `lib/schemas.py` | `web/src/schema/canvas.ts` | issue 20 隔离 API/文件/浏览器契约核对（旧测试只读，不改） |
| CreationAsset / CreationAssetContent | `lib/schemas.py` | `web/src/schema/creationAssets.ts` | `tests/test_creation_assets.py` + `CreationAssetPanel.test.tsx` |
| 图像能力矩阵 | `callers/openai_image.py` | `lib/modelFamily.ts` `referenceLimits.ts` `studioSize.ts` | `tests/fixtures/capability-matrix.json`，两端各自断言 |
| 视频控件能力 | 各 `*_video.py` | `lib/videoControlCaps.ts` | 无 —— 靠人 |

给序列化 model 加字段会打红全仓精确字典断言，改完立刻跑全量 pytest + vitest。

## Job 字段所有权

`WebEditableJobPatch` = `extra="forbid"`，只有两个字段：`prompt`、`params`。其余一律 Skill / job_runner 独占，Web 改不了也不该试：

- 状态机：`status` `error` `submitted_at` `completed_at` `progress_phase`
- 产物：`output_paths`
- 归属：`character_id` `project_id` `ui_scheme_id` `screen_id` `production_id` `canvas_project_id` `namespace` `asset_slot` `kind`
- 路由：`alias` `provider` `model` —— 换模型只能新建 job（`POST /studio/jobs`），不能改已有的
- 血缘：`retry_of` `source_image`；创作台归档血缘写在 `params.archived_from_job_id / archived_from_path`
- 工坊批准归属：`workshop_request_id`，仅服务端绑定冻结请求；普通 prompt 编辑接口拒绝修改已冻结工坊 Job

`run_job` 接受 `PENDING_CONFIRM`（CLI 路径：终端确认即批准，运行时推进为 `PENDING`）与 `PENDING`。
带 `workshop_request_id` 的 Job 还必须与已批准请求内容匹配；批准来源为本地页面，或持有
`execute_generation` 能力的 Agent 会话（ADR-0017）。`POST /jobs/{id}/confirm` 继续批准 CLI 草稿。
Canvas / Studio 保留自己的人工提交路径，不要求工坊请求。旧历史记录不伪造批准或批量改写。

`JobParams` = `extra="allow"`（加字段不会被上游拒），但**双端仍要同步声明**，否则 TS 那边拿不到类型。Studio 在新建 Job 时可写 `estimated_cost_cny`，它是按当次 Key 渠道、模型与参数冻结的人民币预计总价；OpenRouter 等返回账单用量的 caller 可写 `actual_cost_cny`，历史优先实际费用、其次预计快照，缺失时不用当前 Key 重算。后端独占写入的还有 `actual_size`、`warnings`、`requested_size`、`provider_task_protocol`、`provider_task_ids` —— 前端只读不写。后两项用于恢复已计费的聚合商异步任务：任务 ID 必须在首次轮询前落盘，重启后只允许续查原任务，不能重新提交。

Canvas 节点媒体设置新增的显式参数也遵循同一契约：图片 `background` 只允许
`auto | opaque | transparent`，并只向已验证的 GPT Image 直连协议发送；视频 `watermark`
为 bool，只在 Seedance / HappyHorse capability 开启时写入 Snapshot 与厂商请求。

Midjourney 的 `mj_sref`、`mj_cref`、`mj_oref` 均为图片路径数组（每组最多 4 张），分别归属风格、角色、Omni 语义槽；垫图仍写入通用的 `reference_images`。编号式风格参考写入 `mj_sref_code`（只存数字），它与图片式 `mj_sref` 互斥且优先级更高。Web 创建 job，caller 只负责把本地路径转公网 URL 并拼接对应 flag。

`namespace` 决定产物落哪：`character` → `characters/<id>/<slot>/`，`studio` → `studio/<job_id>/`，`ui` → `projects/<slug>/ui/<ui_scheme_id>/screens/<screen_id>/`，`video` → `projects/<slug>/videos/<production_id>/versions/`，`canvas` → `canvases/<canvas_project_id>/outputs/<job_id>/`。UI job 必须同时带 `project_id / ui_scheme_id / screen_id`；项目视频 job 必须同时带 `project_id / production_id`；画布 job 必须带 `canvas_project_id`。Prompt 内的镜头段落不参与资产归属。`kind` 是媒体轴（image/video），别拿它表达归属。

## 端点

写操作按「谁有权」分组。全部前缀 `/api`，服务绑死 `127.0.0.1`。

工坊本地请求管理为 `GET /workshop/requests` 和
`POST /workshop/requests/{request_id}/approve { expected_revision }`；Agent 身份不能批准。
其余 MCP 工具均为专用 POST 输入，详见工坊契约，不提供通用 HTTP / 文件工具。

`GET /spec/{id}` 返回 `{ content, revision }`；`POST /spec/{id}` 要求
`{ content, expected_revision }`。项目 experience 中的 worldview 同样返回 revision 并要求
expected_revision 写入。revision 为完整内容 SHA-256；Web 与 MCP 复用同一锁与 CAS，
冲突返回 `DOCUMENT_CONFLICT`，不覆盖更新内容。新文档修订是空字节 SHA-256。
UI Scheme 的可选 `creation_request_id` 仅为服务器幂等创建索引，不是客户端权限字段。

**Web 独占写**（Skill 不碰）
`POST /spec/{id}` `POST /prompt/{job_id}` `POST /feedback` `POST /uploads` `POST /studio/jobs`
`POST /characters` `POST /characters/{id}/derivatives` `POST /characters/{id}/rename` `POST /characters/{id}/gallery/{kind}` `POST /characters/{id}/project`
`POST /projects` `/projects/reorder` `/projects/{id}/rename` `DELETE /projects/{id}`
`POST /projects/{id}/ui-schemes` `/projects/{id}/ui-schemes/default`
`PUT /projects/{id}/character-associations`

项目内新建角色时，`POST /characters` 请求为
`{ name: string, project_id: string }`，角色目录创建与项目归属在同一次请求内完成；
不带 `project_id` 仅供项目外工作流建立临时角色。

`POST /feedback` 必须携带 `{ text, character_id }`；turn-start 只消费当前 active 角色的反馈，
其他角色的反馈继续留在待处理目录。
`POST /keys` `PATCH /keys/{alias}` `DELETE /keys/{alias}` `POST /keys/models-preview`
`POST /config` `POST /gallery/{hidden,favorites,ratings}` `POST /onboarding/data-root` `POST /folder-picker`
`POST /clipboard-attempt` `DELETE /characters/{id}`
`POST /jobs/{id}/{confirm,cancel}` `DELETE /jobs/{id}` `DELETE /jobs/{id}/image`
`POST /studio/jobs/{id}/archive`
`POST /canvas/projects` `PATCH /canvas/projects/{id}` `PUT /canvas/projects/{id}/document`
`POST /canvas/projects/{id}/agent/sessions` `DELETE /canvas/projects/{id}/agent/sessions/{session_id}`
`POST /canvas/projects/{id}/uploads` `POST /canvas/projects/{id}/media-operations`
`POST /canvas/projects/{id}/runs` `POST /canvas/projects/{id}/runs/{reverse-prompt,mask-edit,angle,layer-decomposition}`
`POST /canvas/projects/{id}/runs/{run_id}/{retry,cancel}`
`POST /creation-assets/prompts`（可带 `recommendation: {mode, model, params}`，model 为模型 id，params 键须在对应 mode 的草稿白名单内）`POST /creation-assets/images/{upload,from-path}`
`PUT /creation-assets/{asset_id}/{prompt,image}`
`POST /creation-assets/{asset_id}/use` `DELETE /creation-assets/{asset_id}`
`POST /canvas/projects/{id}/creation-assets/{asset_id}/insert`
`POST /canvas/projects/export` `POST /canvas/projects/import/{inspect,commit}`
`DELETE /canvas/projects/{id}`
`PUT /canvas/ui-preferences`

**双向**
`POST /characters/{id}/canonical` `POST /projects/{id}/ui-schemes/{scheme_id}/screens/canonical` `POST /experience`
`POST /projects/{id}/videos/{production_id}/selected`

**只读**
`GET /jobs` `/jobs/{id}` `/spec/{id}` `/characters` `/active-character` `/images` `/config` `/projects` `/experience` `/keys` `/onboarding/status` `/home`
`GET /gallery/{recent,screens,hidden,favorites,ratings,image}` `GET /raw`
`GET /projects/index` `GET /projects/{id}/gallery?category={all,art,ui,video}&limit=&cursor=`
`GET /projects/{id}/gallery/media?path=`
`GET /characters/{id}/canonical` `GET /projects/{id}/ui-schemes/{scheme_id}/screens/canonical`
`GET /projects/{id}/workspaces?ui_scheme={scheme_id}` `GET /projects/{id}/videos`
`GET /projects/{id}/ui-schemes`
`GET /projects/{id}/characters/index` `/projects/{id}/characters/{character_id}/workspace`
`GET /projects/{id}/character-associations`
`GET /projects/{id}/studio-archive-targets?media_kind={image,video}`
`GET /canvas/projects` `/canvas/project-options` `/canvas/projects/{id}/document` `/canvas/projects/{id}/jobs`
`GET /canvas/projects/{id}/versions/{version_id}/media`
`GET /canvas/projects/{id}/versions/{version_id}/download`
`GET /creation-assets` `/creation-assets/{asset_id}/content`
`GET /canvas/projects/{id}/agent/sessions` `/canvas/projects/{id}/agent/sessions/{session_id}`
`GET /canvas/ui-preferences`

`GET /canvas/projects` 的 `CanvasProjectSummary` 在项目元数据之外返回派生的 `cover`、`node_count` 与
`connection_count`；这些字段不进入 `project.json`，必须与当前 `canvas.json` 一致。

`GET /canvas/project-options` 只返回 `CanvasProject` 基础元数据，供编辑器内项目切换器使用；它不会读取每个项目的
完整 `canvas.json`，避免打开画布时随其他大画布的体积产生额外解析开销。

### 人工画布契约

画布是 Web 用户人工创建、人工编排的独立创作空间，Skill 不创建项目、不填充节点，也不推进整张图。
文件系统真源为 schema v2 `canvases/<id>/project.json` 与 revision 化 `canvas.json`；资源字节放
`uploads/`，确定性工具产物放 `derived/<operation_id>/`，生成产物按 job 放 `outputs/<job_id>/`。

Canvas 媒体只按项目内不可变 `version_id` 读取，不接受裸路径：

- `GET /api/canvas/projects/{project_id}/versions/{version_id}/media`：同源内联预览，固定安全 MIME、
  `nosniff`，不可变私有缓存。可选 `?w=` 是**这张图会被显示成多宽**（已含设备像素比），不是想要的位图
  尺寸：服务端向上取到固定档位 256 / 512 / 1024 后返回缓存的 WebP 缩略图，`image/webp`。原图本身更小、
  是动图、非图片、或 `w` 超过最大档位时照发原图——缩略图纯属优化，不改变可见内容，也没有失败态。
  缓存落在 `.runtime/canvas-thumbnails/<project_id>/`，不进项目目录（导出包会按 `content_versions`
  逐一核对项目目录里的文件）；缓存键是不可变的 `version_id` 加档位，因此永不失效。
- `GET /api/canvas/projects/{project_id}/versions/{version_id}/download`：附件下载，服务端生成安全文件名。

旧的 `/content/{version_id}` 路径已删除，不保留兼容分支。

画布的错误响应统一走 `{code, message}`（message 中文，给画师看；code 稳定，给前端分支用）：
`CanvasRunCommandError` / `CanvasMediaReplaceError` / `CanvasDocumentError` 都是这个形状。
状态码的划分是**谁能修**：客户端提交的内容不合规 → 422；revision 被别处改过、刷新后重试有意义
→ 409；画布存档文件不见了或记着别的项目 ID（`CanvasStorageError`）→ **500**，因为这是服务端
数据完整性故障，重试永远不会成功，而前端的 409 文案写着「刷新后重试」。
`canvas_runs` 里那批英文断言是后台管线的内部不变式，不作为 HTTP detail 返回；它们经
`job_runner._friendly_error` 加一句中文前缀后落进 `job.error`，原文保留以便定位。
`CanvasDocument` 保存 viewport/settings、九类稳定节点、两类连接与不可变 `content_versions`。运行时只接受
`schema_version: 2`，不包含 v1 union、fallback 或 converter。
客户端在所有视口共用同一份 revision 化 Document；响应式面板、焦点、选择与媒体预览都是本地呈现状态，
不会进入 `canvas.json`。预览媒体仍只通过已登记 `version_id` 读取，不从节点或 Job 拼接裸路径。
文本节点的 `data.display.scale` 只接受 Atelier 字阶 token `xs/sm/base`，缺省为 `sm`；字号切换属于
Document 显示状态并参与 revision 与 undo/redo，不修改文本 Content Version。图片/视频继续使用
`data.display.fit/free_resize`；视频和音频播放进度、音量与控件焦点只属于浏览器呈现状态，不落盘。
画布外观属于作者可撤销的项目设置：`settings.background` 明确选择空白、点阵或线框，
`settings.show_image_info` 控制图片节点是否展示当前不可变 Content Version 的真实宽高与文件体积。
`settings.show_minimap` 控制中等及桌面视口的小地图；手机端始终隐藏。三者随普通 Document revision 保存并
参与 Web undo/redo；图片详情 Dialog 始终保留完整 metadata，不受节点信息条开关影响。
媒体 Content Version 的 `path` 始终相对当前画布项目目录；资产库与提示词使用 revision 化 sidecar，插件
私有状态使用带 plugin id/version 的独立 envelope，不把这些业务对象塞回热路径 `canvas.json`。

Canvas Agent 会话属于画布项目，文件真源为
`canvases/<project_id>/agent/sessions/<session_id>.json`。每个 Session 使用独立 revision 与单调
sequence，只保存可见消息、reasoning summary、稳定 node/version 引用和非敏感 token usage；
不允许 API Key、token、环境变量、裸本地路径、data URL 或隐藏思维链。
`POST .../agent/sessions` 由用户创建空会话，GET 列表会隔离单个损坏文件并返回
`corrupt_session_ids`；`DELETE .../agent/sessions/{session_id}` 必须携带 Session `If-Match`，冲突零写入。
项目包导出严格验证 Session schema/文件名/项目归属；导入新项目保留 session/message ID
与会话历史，只重写 `project_id`。当前打开会话、panel 宽度、焦点和流式临时态属于浏览器呈现，
不进入 Session 或 `canvas.json`。

画布界面与生成偏好是工作区应用级状态，文件真源为 `.config/canvas-ui.json`，不属于任何画布项目。
`GET /api/canvas/ui-preferences` 在文件不存在时返回 revision 0 的默认值且不制造文件；损坏或不符合严格
schema 的文件返回 409，原字节保持不变。`PUT /api/canvas/ui-preferences` 请求为
`{ expected_revision, image_toolbar, generation_defaults }`。`image_toolbar` 的工具 ID 必须来自固定枚举，
不允许重复但允许空清单；`generation_defaults` 严格包含 text/image/video/audio 四项，每项只保存可选的
`{ alias, model }` 与该模态白名单参数。媒体引用、蒙版、本机路径、运行回写字段和跨模态参数一律 422。
服务端在独立文件锁内校验 revision 并原子替换，冲突返回当前 revision。生成偏好只影响后续新建 Draft
和配置节点模式切换；模型保持自动选择时仍独立应用该模态默认参数。失效的显式模型回退首个 Runner 可路由
模型且不继承旧参数，已有节点、Run Snapshot 与 Job
保持不变。该偏好跨项目生效，但不进入 `CanvasDocument`、undo/redo、项目 revision、项目包 manifest/zip
或插件私有状态；凭证、Base URL 与模型目录仍只属于 Keys。

`Input Connection` 是当前可编辑输入资格，不触发下游；`Derivation Connection` 只由生成提交或受控本地
媒体命令创建。真实生成输入冻结在 Canvas Job 的 `canvas_run.snapshot`，节点不保存 `job_ids` 或候选数组。
普通 `PUT document` 必须携带 `If-Match: <revision>`：服务端项目锁内校验后 revision + 1；冲突返回 409，
不做自动合并。Web PUT 只能新增 `user_edit` 文本版本，不能写媒体版本、修改既有版本或伪造派生连接。
历史重做只允许恢复两种已有权威证据的受控例外：其一是结果 Content Version 已存在于服务端，且其不可变
`local_tool` `operation_id/source_version_id` 与提交的源节点、结果节点和派生边吻合；其二是结果 Version 的
`job_output` 指向同项目 Canvas Job 的成功 Candidate，且 Job 的 `canvas_run`、Snapshot 源节点、结果节点、
Run ID 与派生边全部吻合。两种例外都只恢复已提交历史，不创建新 Version，也不重新执行工具或生成任务。

上传接口使用 multipart `file + expected_revision`，服务端登记不可变媒体 Content Version 并返回更新后的
Document；扩展名只作入口白名单，文件类型、MIME、摘要、大小和图片尺寸均由服务端字节重算，伪扩展上传
直接拒绝。`canvas.json` 最大 25 MiB，单项目最多 10,000 节点 / 20,000 连接，单插件节点 payload 最大
256 KiB。媒体读取只收 `version_id`，不接受裸 path/job_id。Canvas Job 禁止通过通用 `/prompt/{job_id}`
修改快照、prompt 或参数。`POST /canvas/projects/{id}/runs` 只接受
`surface_node_id / expected_revision / requested_count`；服务端从已保存 Draft、连接与 Content Version
解析真实输入，冻结 `canvas_run.snapshot`，并用项目内短事务原子提交 Job、结果节点与 Derivation Connection。
Draft 的 `params` 两侧都按 mode 走白名单（`schemas.CANVAS_DRAFT_PARAM_FIELDS`）：`PUT .../document`
落盘前过一次，冻结 Snapshot 时再过一次，名单外的键一律丢弃。所有路径类字段
（`reference_images/videos/audios`、`mask_image`、`mj_sref/cref/oref`）与 caller 回写字段
（`actual_size`、`warnings`、`mj_flags`）都不在名单里 —— 浏览器不能提交路径，Canvas 的参考素材只能
来自不可变 Content Version。
批量执行使用 `batch_material` 节点：`data.items` 为最多 200 个 `{id,image_version_ids}`，
每项 1–16 张已登记图片；项 ID 在节点内唯一。节点仅提供输入，没有生成 Draft。`group.data.repeat_count`
为 1–20 轮，一层显式成员关系保持不变。分组外框按成员显示边界派生，加载与实时合并使用同一规则；
`group.size` 为正有限数的 `CanvasGroupSize`，不受普通节点 `CanvasSize` 的 4000px 上限影响，
大批次展开后仍能包围所有成员。图片、视频等普通节点继续保留 4000px 尺寸上限。分组或单节点可以调用：

- `POST /canvas/projects/{id}/batch-runs/prepare`：`{scope_node_id,expected_revision,repeat_count}`；
  校验冻结素材、输入依赖、模型能力及每步单产物，返回 `ready` 计划，不调用模型。最多 20 步、2000 次生成；
  一个范围只允许一个批量素材来源，无素材节点时固定输入为一项；不支持循环或配置/插件节点执行。
- `POST .../batch-runs/{batch_id}/start`：确认后启动；revision 必须仍匹配，同项目只允许一份活动计划。
  同一计划重复 start 不再调度。串行执行的普通 Canvas Job 带 `canvas_run.batch`
  `{batch_id,item_id,round_index,step_index}`，两个 index 从 0 开始。
- `POST .../batch-runs/{batch_id}/cancel`：取消未提交步骤，对当前 Job 发协作停止；已收费产物继续登记。
- `GET .../batch-runs` / `GET .../batch-runs/{batch_id}`：读取最近 20 份计划/单份计划，
  包含每项每步的 Job、Run、结果 Version ID 和状态；`executions[].result_node_id` 在展开前为空，
  首次提交事务展开链路后指向对应普通节点。未提交步骤不伪造节点的 `active_run_id`。

批量计划冻结数据落在项目 `.runtime/batch-plans/`；进度在 `.runtime/batches/`，活动计划索引为
`.runtime/batch-active.json`。同项同轮上游输出绑定到下游的精确 Version ID。
首次提交事务同时展开各项、各轮的真实结果节点和输入连线：第一项第一轮使用配置链路的原节点，
其余项/轮按行排在现有内容下方，各行的下游只连接同行上游；不在一个节点中切换批次结果。
内容节点的可选 `data.batch_result` 保存 `{batch_id,template_node_id,source_node_id,item_id,image_version_ids,round_index}`，
绑定本批素材的不可变版本，单独再次生成时不读取其他批次；分组再次执行只读取原配置节点，
不把自动展开的产物节点重新当作流程步骤。所有结果仍由普通 Job/Version 保存，视频不提供候选切换。
上次生成的输出不隐式成为下一次批量执行的自身参考。
失败停止剩余步骤，无自动付费重试；服务重启将活动计划标为 interrupted，不自动提交剩余步骤。
计划文件属于本机执行状态，不随项目包导入；图片素材、普通节点及已经生成的 Jobs/Versions 仍随包保存。
前端执行期间锁定画布内容编辑，仍可浏览结果；项目导出/删除在批量运行时拒绝。

四模态均进入同一个 Job Runner：图片/视频沿用既有厂商协议；文本只接受明确可执行的
OpenAI-compatible `chat/completions` 或 `responses`，后者支持 `reasoning_effort`，其中 `auto` 只作为
Draft 选择且冻结/请求时省略；音频只接受 OpenAI-compatible `audio/speech`，冻结并发送白名单内的
voice/format、0.25–4 的 speed 与去除首尾空白后的非空 instructions。模型配置的 protocol 不匹配时明确
拒绝，不做伪兼容。连接输入会先按 Prompt 内 `@[node:id]` 的出现顺序冻结，再补未提及连接，并在冻结前按
模型/协议校验媒体类型和数量。`@` 菜单只枚举当前 surface 的直接 incoming `Input Connection` 且已有
同模态 Content Version 的文本、图片、视频和音频；Draft 永远保存稳定 node token，不保存“图片1”等
显示标签或 Version/path。断开连接时 Web 同一事务删除对应 token，不展示失效引用；服务端仍拒绝绕过 Web
提交的异常 missing token，不能降级成普通文本。冻结后服务端按 Snapshot 实际输入顺序分别为文本、图片、视频、音频从 1 编号，重复 token 复用
同一编号；final prompt 的标签与 `reference_images/reference_videos/reference_audios` 各自数组顺序一致，
隐式自身输入也参与编号。非原生批量的图片候选按槽位执行，每个成功槽位立即通过短事务登记
Content Version、candidate 状态与首个成功主结果；Midjourney 原生四宫格仍保留单次请求再逐槽登记。

视频 Draft 的 `frame_mode=first|last|firstlast` 使用语义化 Input Connection：可选 `slot` 只能是
`first_frame` 或 `last_frame`，源节点必须是已有图片 Content Version，目标必须是视频生成节点，且同一
目标的每个槽位最多一条连接；同一图片允许同时占用首帧和尾帧。首尾帧模式不解析普通素材连接，也禁止
`@[node:*]`；用户在提示词内输入 `@` 时，浏览器只在输入框内部给出简短提示，服务端再次拒绝；切换到
全能参考会删除槽位连接，服务端也会忽略任何
异常残留槽位。提交时按实际槽位推导 wire `frame_mode` 和首尾图片顺序，不能由浏览器伪造媒体数组。
模型选择器只展示模型名；当前视频模式名后的帮助入口在 hover 时显示图片、视频、音频与混合上限。
素材区的 `+` 不打开候选菜单，而是进入画布点选状态，用户可移动画布并点击一个合法素材节点完成连接；
点选期间界面进入专注态：隐藏小地图/缩放、右上配置和底部主工具栏，在顶部显示“从画布选择参考”与退出
动作；合法素材节点 hover 时点亮边框，“选择 + 节点名”跟随光标移动，键盘聚焦时显示在节点起始位置。项目标题、节点、节点上方上传入口
与当前生成面板保持可用。点击空白画布不会退出，选择成功、按
`Esc` 或点击退出后恢复全部 Chrome。空媒体节点的唯一上传入口使用“上传附件”胶囊样式。
浏览器在选择阶段限制新增并阻止超限提交，服务端仍按模型协议重新核对单模态与混合总数。Canvas 不列出
只接受公网视频 URL、无法消费
项目内 Content Version 的 HappyHorse video-edit 模型。

批量候选逐个校验：全部成功为 `done`，部分成功为 `partial`，全部失败为 `failed`，
停止且没有有效产物为 `canceled`；部分失败不会抹掉已经成功的 Content Version。
`POST .../runs/{run_id}/retry` 只接受 `expected_revision`：从结果节点当前 Draft/连接重新解析并冻结新
Snapshot，创建新 Job/Run，不覆盖旧记录。没有按原 Snapshot 重跑的入口，也不能只补跑单个候选。
`POST .../runs/{run_id}/cancel` 只持久化幂等 `cancel_requested_at`。Runner 尚未认领时不调用厂商并落为
`canceled`；同步厂商请求已发出时不伪装即时中断，UI 明示上游可能继续执行，有效返回仍登记，未返回候选
才标记 canceled。prepared 事务在下次项目访问或命令前完成/丢弃，不能从节点当前内容重造 Snapshot。
`POST .../runs/{run_id}/candidates/{candidate_id}/dismiss` 只允许隐藏 `failed/canceled` 槽位并写入
`dismissed_at` tombstone；Job、Snapshot、错误与既有 Content Version 均不删除，最新 tombstone 也不会让
同索引的旧失败槽位重新出现。
服务启动时先恢复全部项目事务，再核对孤儿 Job：`runner_started_at` 为空的持久任务尚未调用厂商，可安全
重新领取；已经领取但仍无终态的请求状态未知，明确标记失败且不自动重试，避免重复扣费。视频与
Midjourney 异步轮询会在每个间隔和下载前检查停止请求。进程内调度上限为全局 4 个、同一密钥别名
2 个、视频 1 个；HTTP 后台任务与重启恢复共用同一组门控。文本/图片允许候选批量，视频/音频固定单
结果。旧 `POST .../jobs` 已删除。

已有 Video Content Node 以 video Draft 提交时属于视频派生编辑：Snapshot 固定只冻结节点当前视频一个
`implicit_self`，忽略该节点的 Input Connection，并在创建 Run 前拒绝 `@[node:*]` mention；结果始终写入
独立视频节点与 generation-run Derivation Connection，不覆盖源节点。

`POST /canvas/projects/{id}/runs/reverse-prompt` 只接受 `surface_node_id + expected_revision`。服务端固定
`canvas.reverse_prompt` preset v1，优先全局 default Key、再按登记顺序选择首个 `modality=text`、
`input_modalities` 明确包含 image 且支持 OpenAI-compatible chat 的模型；浏览器不能传 preset、alias、
model 或媒体路径。Snapshot 冻结完整 preset 正文/版本、真实模型与唯一图片 Version，文本 caller 用
multimodal content 发送服务端解析的项目内图片。成功结果是独立文本节点及 generation-run 派生边，源图片
Draft 不读不改；停止与 original retry 复用普通 Run 生命周期，current retry 不适用。

普通文本 Run 可冻结并传输图片、视频和音频 Input Connection，但只认所选文本模型显式声明的
`input_modalities`，不按模型名称猜测能力。Chat Completions 在兼容端点分别使用 `image_url`、
`video_url` 与 `input_audio`；Ark-compatible Responses 分别使用 `input_image`、`input_video` 与
`input_audio`。本机媒体由 caller 编码后提交；模型虽声明能力但当前供应商协议没有对应传输格式时，
同样在创建 Run 前拒绝。两种拒绝都只显示一条短消息，不在画布增加常驻说明组件。
`POST .../runs/{run_id}/reverse-prompt-config` 在成功文本结果后幂等创建图片 Config Node 及文本→配置
Input Connection。图片模型优先使用仍可路由的画布图片生成偏好；偏好保持自动选择或显式模型失效时，
再按 default Key 优先、其余登记顺序选择。自动选择会应用已保存的默认参数，失效的显式模型不泄漏旧参数；
缺模型时保留反推文本且零写。重复请求即使携带旧 revision，也返回已经存在的同一配置，不重复创建节点或连接。

图片工具栏的“拆分图层”先在画布中创建一个 `layer_stack` 节点和一条图片输入连线，不调用厂商。未运行节点的
`source_version_id` 跟随唯一上游图片的当前 Version，替换或重新生成上游图片时同时更新节点预览与随源图比例计算的
初始尺寸；运行中及已完成节点冻结本次源 Version，历史产物不随上游变化。节点左侧展示源图，右侧保存用户选择的
`alias + model` 与可选提示词。`POST
/canvas/projects/{id}/runs/layer-decomposition` 只接受该节点的 `surface_node_id + expected_revision + alias + model`，
服务端还会核对请求选择与节点已保存设置完全一致。只接受火山直连或明确使用 Ark 协议的 Seedream 5.0 Pro，
绝不自动替换渠道或模型。比例固定为“智能”并继承输入图；分辨率默认 `auto`，可显式选择
`1K / 1.5K / 2K`。调用固定提交单张源图、`layer_decomposition=true`、节点保存的 `size`、
`output_format=png`、`response_format=b64_json` 与
`watermark=false`，不自动回退到其他渠道或普通生图。提交与完成事务都复用原 `layer_stack` 节点；完成后把背景图
和最多 16 张透明 PNG 全部登记为不可变图片 Version，并保存厂商返回的 `z_index`、`name`、
`description`、`bounding_box`。底图使用普通 `job_output` 血缘，透明层使用带 `job_id + output_index` 的
`layer_decomposition` 血缘；媒体读取和项目包导入导出均校验该索引与 Job 输出一致。图层栈按绝对 bbox
重建原图，显隐只修改节点呈现状态，不改写产物字节或 Job 历史。

`POST /canvas/projects/{id}/runs/mask-edit` 使用 multipart，只接受 `surface_node_id / expected_revision /
requested_count / mask_file`。prompt、alias、model 与参数必须先保存为源图片节点的 image Draft，服务端
读取后冻结；浏览器不能传媒体路径或绕过 Draft。蒙版必须是与 EXIF 归一后源图同尺寸的单帧 PNG，透明或
灰度值 0 表示编辑、255 表示保留，空蒙版拒绝。服务端把归一灰度蒙版登记为不可变 `user_mask` Content
Version，并与 Job、Snapshot、结果节点、派生边在同一可恢复事务提交；Snapshot 记录
`mask_version_id`，且唯一输入固定为当前源图 Version，不接收其它连接节点引用；original retry 重新校验
源图与蒙版摘要后原样复用。首版只允许已验证走 OpenAI-compatible
`/images/edits` 的 GPT Image 模型；不支持时返回 `canvas_media_capability_missing`，绝不降级为整图生成。

`POST /canvas/projects/{id}/runs/angle` 只接受 `surface_node_id / expected_revision / requested_count` 与
`horizontal_angle(-60..60) / pitch_angle(-45..45) / camera_distance(1..10) / wide_angle`。服务端优先全局
default Key、再按登记顺序选择首个支持至少一张参考图的图片模型；浏览器不能传自由 prompt、alias、model
或媒体路径。服务端固定 `canvas.angle_edit` preset v1，把当前图片 Version 作为唯一 Snapshot input，完整
机位参数、preset、真实 provider/alias/model 和受控最终 prompt 一并冻结。结果始终是独立图片节点及一条
generation-run Derivation Connection；original retry 重新校验源图摘要并逐字段复用原 Snapshot。

`POST /canvas/projects/{id}/media-operations` 只接受当前图片节点和不可变源 Version ID，并以
discriminated union 执行 `crop`、`split` 或确定性 `upscale`。服务端用 Pillow 校验真实格式、摘要、静态帧、
EXIF 方向与 64MP 上限，统一输出剥离元数据的 RGB/RGBA PNG；切图限制 2–12 行列且每块最短边至少 16px，
放大只允许 1024/2048/3072/4096 长边和 nearest/bilinear/lanczos，明确不提供 AI 细节恢复。一次命令在
项目级串行、全局最多并发 2 个；全部输出先写 staging，校验总块数与体积后原子移动到
`derived/<operation_id>/` 并提交 Document。若进程在移动后中断，下一次项目访问按事务摘要完成提交；恢复不
重跑图片处理。冲突为零写，源文件永不覆盖；一次 split 的结果节点和 `local_tool` 派生边作为一个画布历史
命令撤销/重做，Content Version 与字节继续保留。裁剪/切图参数校验分别固定返回
`canvas_media_invalid_crop` / `canvas_media_invalid_split`，无法识别的请求或放大参数返回
`canvas_media_invalid_request`；解码、规模、源不一致、revision 冲突、处理资源与事务失败均返回带
`code/message` 的结构化错误。产物移动前的资源错误保证零提交；移动后的错误返回事务待恢复语义，
不谎报零变化，也不把 Pillow 或文件系统异常直接暴露为 500。

`POST /canvas/projects/{id}/nodes/{node_id}/replace` 允许 image/video/audio 节点用同模态文件填充或替换。
请求使用 multipart `file + expected_revision`；服务端校验真实 MIME、节点模态与 revision；已有内容时还要
校验当前 Version。命令创建新的不可变 upload Content Version，并只切换原节点 `current_version_id`。
空节点直接指向新 Version；已有节点的旧 Version 与字节继续保留，因此画布 undo/redo 只恢复指针，不重新
上传。跨模态、伪后缀、节点缺失、已有指针引用的 Version 缺失和 revision 冲突均为零写。
图片的 `display.free_resize=false` 让 React Flow resize 保持当前 Version 宽高比；切换只更新节点显示
状态，不修改 Content Version 的真实尺寸。

项目包使用 `game-atelier-canvas-v1.zip`：`manifest.json` 对每个 metadata/blob 记录 SHA-256、字节数、
MIME 与角色，项目内容放在 `projects/<package_project_id>/`，媒体放在
`blobs/sha256/<first2>/<sha256>.<ext>`。导入先调用 `inspect` 完成路径、链接、重复条目、压缩比、配额、
schema、摘要和项目内引用校验，再凭 30 分钟 token 调用 `commit`；commit 永远创建新项目，并重映射所有
全局 Canvas Job ID、Run ID、output path、retry/derivation/content origin 引用。node/version/connection
等项目内 ID 保留。包不包含凭证、全局 provider 配置、缓存、插件代码或运行中事务；存在 pending Job
时导出、导入和删除均返回 409。
导入与删除分别使用持久事务记录和固定锁序；服务启动时回滚中断的导入，并完成中断的永久删除。每 6 小时
维护一次过期或遗弃的导入 claim。

删除请求只携带当前 `expected_revision`。服务端在固定的 project→job 锁序下确认 revision 与 owned Job
均静止后，先把项目和 Job 原子移入 `.runtime/canvas-delete-transactions/` 的短期事务目录，再立即物理清除；
项目从索引消失后不可恢复。画布不提供回收区、撤销删除或恢复 API。

创作资产是应用级个人数据，真源为 `creation-assets/catalog.json` 与
`creation-assets/blobs/<sha256>.<ext>`，Studio 与所有 Canvas 共享同一资产身份。资产只有 prompt/image
两类，每个资产只维护一份当前内容；标题、标签、提示词正文/变量和图片均由同一个编辑入口原位更新。
图片按 SHA-256 去重，提示词重复只在 Web 提醒。资产可物理删除，删除前必须显式确认，删除后不可恢复。

Canvas 的“本项目”是 CreationAsset 上的项目关系过滤，不是项目内第二套可编辑 sidecar。首次使用资产会
建立关系；删除画布会清理该项目关系。旧版
`library/assets.json` 与 `library/prompts.json` 在首次读取时幂等迁移，旧 HTTP library 端点已删除。

`POST .../creation-assets/{asset_id}/insert` 携带 Canvas Document 的 `If-Match`、目标坐标和可选变量值，
把资产当前内容复制为新的 Canvas Content Version；内容 origin 只保存当时的资产标题快照，不保存
asset_id 或可回写引用。Studio Job 的 `params.creation_asset_source_title` 同样只保存只读标题快照。
后续编辑或删除资产都不会改变既有节点、草稿或生成记录，也不存在更新引用 API。画布项目包只携带已复制
内容和来源标题，不携带个人资产库。

旧 schema v1 在 server 启动时一次性迁移到 v2：迁移前把完整 `creation-assets/` 和将被改写的 Job/
Canvas 文件复制到 `.runtime/backups/creation-assets/<UTC timestamp>/`；资产保留最新内容、恢复原归档项，
旧引用转成标题快照。Job 与 Canvas 分别在正式锁内完成完整 schema 校验后落盘；已被淘汰的旧图片版本
blob 只在备份完成后从活动目录清理。运行时永不读取该备份。

### 角色衍生契约

角色衍生是项目资产库中的平级角色资产，目录、Spec、三类出图、Job、反馈与定稿均独立。它只保存
创建时的来源快照，不形成父子树或归属依赖。关系落在 `characters/<derivative_id>/derivative.json`：

```ts
type CharacterDerivative = {
  source_character_id: string;
  source_character_name: string;
  source_paths: string[];
  created_at: string;
};

type CharacterEntry = {
  id: string;
  name: string;
  status: string;
  latest_job_id: string | null;
  thumbnail?: string | null;
  derivative: CharacterDerivative | null;
};
```

`POST /characters/{source_id}/derivatives` 请求为 `{ name: string, source_paths: string[] }`。
来源角色必须已归属项目；服务端自动加入来源角色三类 canonical 图片，并接受同项目画廊图片或
`.runtime/uploads/` 本次上传图片。所有来源图会复制到新角色 `source/`，`source_paths` 只记录复制后的
相对路径。新角色初始继承来源角色当时的项目归属，之后可独立移动、删除或继续作为新衍生的来源；
来源角色改名或删除不会改写快照。

`turn-start` 对衍生角色额外返回 `derivative`，包含来源角色 id / 创建时显示名、冻结后的来源路径与
当前资产槽位；`project_style` 仍是项目风格真源，Job 的 `character_id` 始终写当前衍生角色 id。

### UI 方案契约

方案元数据落 `projects/<slug>/ui/schemes.json`，内容为
`{ default_scheme_id: string, schemes: Array<{ id, name, created_at }> }`。方案 id 由服务端按 `v1`、
`v2` 递增生成；默认方案只决定 `/workshop/{project}/ui` 的打开目标，切换默认不删数据。

`POST /projects/{id}/ui-schemes` 请求为
`{ name, source_scheme_id, copy_style, copy_screen_map, screen_ids }`。复制的页面版本成为新方案起点，
但不复制 canonical；两套方案之后独立写 `style.md / screens / canonical.json`。viewer-server 启动时
显式执行一次旧项目升级：把旧 `screens/` 移到 `ui/v1/screens/`，把根 `style.md` 的 `ui.*` 章节
移入 V1，并经完整 Job 模型校验修正 Job 与 canonical。正常读取只接受新路径，不做迁移或 fallback。
`GET /projects/{id}/ui-schemes?visible_only=true` 仅返回包含实际 UI 文档、页面或作品的方案，供侧栏
隐藏初始化产生的空 V1；不带参数时仍返回完整方案文件，供 UI 工作流使用。

### 角色索引、工作台与关联

`GET /projects/{id}/characters/index` 返回项目角色卡片的派生数据：每个条目包含完整
`CharacterEntry`、单张角色封面 `cover_path` 与 `activity_at`。封面优先使用定稿立绘；未定稿时
使用最早的立绘。它只从项目归属和角色目录聚合，不落独立索引文件。

`GET /projects/{id}/characters/{character_id}/workspace` 返回角色视角的资产聚合：

```ts
type CharacterWorkspace = {
  character: CharacterEntry;
  assets: Array<{
    slot: 'portrait' | 'promo' | 'turnaround';
    count: number;
    canonical: CanonicalEntry | null;
    media: GalleryMedia[];
  }>;
  related: Array<{
    target:
      | { kind: 'ui'; scheme_id: string; screen_id: string }
      | { kind: 'video'; production_id: string };
    title: string;
    detail: string;
    source: 'auto' | 'manual' | 'both';
    featured_path: string | null;
    count: number;
    media: GalleryMedia[];
  }>;
  recent_media: GalleryMedia[];
};
```

自动关联只认 Job 与视频企划中明确登记的角色素材路径，不解析 prompt。手动关联落在
`projects/<slug>/character-associations.json`；`PUT /projects/{id}/character-associations` 请求为
`{ character_id, target, associated }`。角色和 UI 页面 / 视频企划必须属于同一项目，移除手动关联
不会删除自动关联或任何作品文件。

### 项目工作区响应

`GET /projects/{id}/workspaces` 返回只读聚合，不落第二份进度：

```ts
{
  project_id: string;
  art: { characters: number; canonical: number; stale: number };
  ui: {
    scheme_id: string;
    anchors: Record<'gdd' | 'prd' | 'interaction', string>;
    anchors_approved: number; style_status: string; has_ui_style: boolean;
    screen_map_status: string; screens: number; versions: number;
    canonical: number; stale: number;
    screen_items: Array<{
      screen_id: string; name: string; category: string; priority: string;
      status: string; dependency: string; purpose: string; brief_summary: string;
    }>;
    next_action: string; next_command: string;
  };
  video: {
    productions: number; versions: number; selected: number; next_action: string;
  };
}
```

### 项目索引与项目画廊

`GET /projects/index` 是项目卡片墙的派生读取模型：

```ts
type ProjectIndexItem = {
  project: Project;
  cover_paths: string[]; // 0..4 张最新未隐藏图片，视频不参与
  activity_at: string;   // 项目目录与已归属角色资产树的最新 mtime
};
```

项目重命名、角色归属和作品隐藏这类不直接改项目内容文件的写操作会触碰对应项目目录；不另存
`updated_at`。`GET /projects/{id}/gallery` 从文件系统实时聚合全部未隐藏成品版本，使用
`category=all|art|ui|video` 过滤，按 `produced_at` 倒序并以 opaque cursor 渐进读取。
`GET /projects/{id}/gallery/media?path=` 只读取同一派生集合中的单个作品，用于通过首页 URL 的
`?media=` 查询恢复预览；已隐藏、失败或不属于该项目的路径统一返回 404。

```ts
type GalleryMedia = {
  path: string;
  media_type: 'image' | 'video';
  produced_at: string;
  title: string;
  detail: string;
  job_id: string | null;
  target:
    | { kind: 'art'; character_id: string; asset_slot: AssetSlot }
    | { kind: 'ui'; scheme_id: string; screen_id: string }
    | {
        kind: 'video'; production_id: string; output_kind: 'version';
      };
};
```

美术只扫描项目角色三类成品槽，UI 只扫描所有方案的 screen 版本目录，视频只扫描企划的完整版本。
参考图、source、上传暂存、策划文档和失败 Job 不进入画廊。旧 `/gallery/project` 已删除；美术工作区
使用统一画廊的 `category=art`，`/gallery/screens` 仍服务 UI 制作页的版本元数据。

### 创作台归档契约

`GET /projects/{id}/studio-archive-targets?media_kind=image|video` 返回
`{ targets: StudioArchiveTargetOption[] }`。图片目标包含该项目的角色三类资产槽，以及所有 UI 方案中已规划
或已有版本的页面；视频目标只包含该项目所有正式企划。响应中的 `label / detail` 只用于展示，
POST 时不得回传：

```ts
type StudioArchiveTarget =
  | { kind: 'character'; character_id: string; asset_slot: AssetSlot }
  | { kind: 'ui'; ui_scheme_id: string; screen_id: string }
  | { kind: 'video'; production_id: string };

type StudioArchiveTargetOption = StudioArchiveTarget & { label: string; detail: string };
```

`POST /studio/jobs/{id}/archive` 请求为
`{ source_path: string; project_id: string; target: StudioArchiveTarget }`。来源必须是该 Studio DONE Job
的 `output_paths` 成员；图片只能进入角色或 UI，视频只能进入完整视频企划；目标必须真实属于所选项目。
服务端在目标目录复制为下一个 `vN`，不移动或改写源文件，并用完整 Job schema 新建一个正式 DONE Job。
新 Job 保留来源的 prompt、模型与生成参数，归属改为目标资产，且在 params 写入
`archived_from_job_id / archived_from_path`。响应为 `{ job, path }`；重复归档只会继续递增版本，绝不覆盖。

`GET /projects/{id}/videos` 返回 `{ productions: ProjectVideoProduction[] }`；
`GET /projects/{id}/videos/{production}` 返回单个企划。每个 production
含 `production_id / title / type / status / brief / prompt / versions / selected / planned_reference_images / history`；
`brief` 明确返回 `goal / platform / ratio / duration / sound`。`prompt` 是一次提交的完整多镜头提示词；
`versions` 中每个文件都是一支完整视频。
`history` 按新到旧保存每次 Job 的 `job_id / submitted_at / completed_at / status / prompt / model / params`，
其中 `params` 包含当次实际时长、分辨率、画幅与三组参考素材。`planned_reference_images` 是下一次生成草稿，
不得与历史混用。`POST .../selected` 请求为
`{ path: string | null }`（禁止额外字段），响应为 `{ path: string | null }`；path 必须是
该企划 `versions/` 中实际存在的 `.mp4`。

`GET /projects/{id}/video-references` 返回当前项目可用的角色（含角色衍生）和所有 UI 方案页面定稿：
`{ candidates: Array<{ kind, asset_id, scheme_id, label, detail, path, stale }> }`。只返回真实存在的
canonical 文件；角色没有立绘定稿时返回最早立绘并标记“尚未定稿”。`stale` 只提示人工判断，
不自动替换。

`POST /projects/{id}/videos/{production}/references` 请求为
`{ paths: string[] }`（禁止重复和额外字段），只接受该项目当前候选素材或该企划已保存的明确版本，
响应为 `{ paths: string[] }`。草稿落 `projects/<slug>/videos/<production>/references.json`；
`submit-video-production` 创建一个完整视频 Job 时把这些路径复制进 `params.reference_images`。因此后续切换 canonical
只改变候选，不会改写历史 Job。

### 几个要当心的

`GET /raw` 与 `GET /gallery/image`：路径不能随便给，`/raw` 走 job_id 白名单，只读该 Job 的
`output_paths`、`params.reference_{images,videos,audios}`、MJ 三组参考素材与 `source_image`；
`gallery/image` 只放行 characters、projects screens、projects videos 的 `versions/` 资产以及 studio 子树；项目 brief / prompt 不对外暴露。加新产物目录要同步放行。

`GET /keys/{alias}/reveal`：唯一回明文密钥的接口。按显式 alias、按需返回；列表接口一律掩码。

`POST /keys/models-preview`：形状与分类瀑布见 [references/provider-config.md](references/provider-config.md) 的「models-preview 契约」一节。两条硬约束——① 用存储密钥时 `base_url` 只能与存储值同 host；② 默认 `/models` 未必是全集（OpenRouter 的视频模型要额外拉 `?output_modalities=video`）。

## 不变式

- 同一时间只支持一个 Web tab，多 tab 行为未定义。
- job JSON 禁止手写：`/api/jobs` 全量 Pydantic 校验，一条 schema 错会让整个列表 500（表现为「角色里没内容」）。用 `lib/jobs.py` 的 `Job`/`save_job()` 生成。
- `params.warnings` 是数组不是字符串；`status`/`kind`/`asset_slot` 必须用 schema 枚举值。
- 改后端 lib 后 viewer-server 必须重启：长驻进程缓存旧模块，症状是「X object has no attribute Y」而 pytest 全绿。
