# API 契约

> 前后端形状的单一真值源。**改任一端先改这里**。厂商侧契约见 [references/provider-config.md](references/provider-config.md)。

## 双端同步点

改左边必须同步右边，反之亦然。没有代码层共享，只有约定 + 守卫。

| 契约 | Python | TypeScript | 守卫 |
|---|---|---|---|
| Job / JobParams | `lib/schemas.py` | `web/src/schema/jobs.ts` | 无 —— 靠人 |
| Key / ModelSpec | `lib/keys.py` | `web/src/api/keys.ts` | 无 —— 靠人 |
| CharacterDerivative / CharacterEntry | `lib/schemas.py` | `web/src/schema/jobs.ts` | `tests/test_character_derivatives.py` + `LeftSidebar.test.tsx` |
| CharacterAssociationTarget / CharacterAssociationItem | `lib/schemas.py` | `web/src/schema/jobs.ts` | `tests/test_character_workspace.py` + `CharacterAssociationPicker.test.tsx` |
| CharacterWorkspaceResponse / CharacterIndexResponse | `lib/schemas.py` | `web/src/api/characters.ts` | `tests/test_character_workspace.py` + `CharacterWorkspace.test.tsx` + `CharacterIndex.test.tsx` |
| ProjectIndexItem / GalleryMedia | `lib/schemas.py` | `web/src/api/gallery.ts` | `tests/test_gallery_project.py` + `ProjectIndexPage.test.tsx` + `ProjectPage.test.tsx` |
| StudioArchiveTarget | `lib/studio_archive.py` | `web/src/api/studio.ts` | `tests/test_studio_archive.py` + `StudioArchiveDialog.test.tsx` |
| CanvasProject / CanvasDocument / CanvasJobContext | `lib/schemas.py` | `web/src/schema/canvas.ts` + `schema/jobs.ts` | `tests/test_canvas_projects.py` + `CanvasEditor.test.tsx` |
| CanvasUiPreferences | `lib/schemas.py` | `web/src/schema/canvas.ts` | issue 20 隔离 API/文件/浏览器契约核对（旧测试只读，不改） |
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

`JobParams` = `extra="allow"`（加字段不会被上游拒），但**双端仍要同步声明**，否则 TS 那边拿不到类型。后端独占写入的三个：`actual_size`、`warnings`、`requested_size` —— 前端只读不写。

Canvas 节点媒体设置新增的显式参数也遵循同一契约：图片 `background` 只允许
`auto | opaque | transparent`，并只向已验证的 GPT Image 直连协议发送；视频 `watermark`
为 bool，只在 Seedance / HappyHorse capability 开启时写入 Snapshot 与厂商请求。

Midjourney 的 `mj_sref`、`mj_cref`、`mj_oref` 均为图片路径数组（每组最多 4 张），分别归属风格、角色、Omni 语义槽；垫图仍写入通用的 `reference_images`。Web 创建 job，caller 只负责把本地路径转公网 URL 并拼接对应 flag。

`namespace` 决定产物落哪：`character` → `characters/<id>/<slot>/`，`studio` → `studio/<job_id>/`，`ui` → `projects/<slug>/ui/<ui_scheme_id>/screens/<screen_id>/`，`video` → `projects/<slug>/videos/<production_id>/versions/`，`canvas` → `canvases/<canvas_project_id>/outputs/<job_id>/`。UI job 必须同时带 `project_id / ui_scheme_id / screen_id`；项目视频 job 必须同时带 `project_id / production_id`；画布 job 必须带 `canvas_project_id`。Prompt 内的镜头段落不参与资产归属。`kind` 是媒体轴（image/video），别拿它表达归属。

## 端点

写操作按「谁有权」分组。全部前缀 `/api`，服务绑死 `127.0.0.1`。

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
`POST /canvas/projects/{id}/runs` `POST /canvas/projects/{id}/runs/{reverse-prompt,mask-edit,angle}`
`POST /canvas/projects/{id}/runs/{run_id}/{retry,cancel}`
`POST /canvas/projects/export` `POST /canvas/projects/import/{inspect,commit}`
`DELETE /canvas/projects/{id}` `POST /canvas/trash/{trash_id}/restore`
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
`GET /canvas/projects` `/canvas/projects/{id}/document` `/canvas/projects/{id}/jobs`
`GET /canvas/projects/{id}/versions/{version_id}/media`
`GET /canvas/projects/{id}/versions/{version_id}/download`
`GET /canvas/projects/{id}/library/assets` `/canvas/projects/{id}/library/prompts`
`GET /canvas/projects/{id}/agent/sessions` `/canvas/projects/{id}/agent/sessions/{session_id}`
`GET /canvas/trash` `GET /canvas/ui-preferences`

`GET /canvas/projects` 的 `CanvasProjectSummary` 在项目元数据之外返回派生的 `cover`、`node_count` 与
`connection_count`；这些字段不进入 `project.json`，必须与当前 `canvas.json` 一致。

### 人工画布契约

画布是 Web 用户人工创建、人工编排的独立创作空间，Skill 不创建项目、不填充节点，也不推进整张图。
文件系统真源为 schema v2 `canvases/<id>/project.json` 与 revision 化 `canvas.json`；资源字节放
`uploads/`，确定性工具产物放 `derived/<operation_id>/`，生成产物按 job 放 `outputs/<job_id>/`。

Canvas 媒体只按项目内不可变 `version_id` 读取，不接受裸路径：

- `GET /api/canvas/projects/{project_id}/versions/{version_id}/media`：同源内联预览，固定安全 MIME、
  `nosniff`，不可变私有缓存。
- `GET /api/canvas/projects/{project_id}/versions/{version_id}/download`：附件下载，服务端生成安全文件名。

旧的 `/content/{version_id}` 路径已删除，不保留兼容分支。
`CanvasDocument` 保存 viewport/settings、七类稳定节点、两类连接与不可变 `content_versions`。运行时只接受
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
和配置节点模式切换；失效模型回退首个 Runner 可路由模型且不继承旧参数，已有节点、Run Snapshot 与 Job
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
四模态均进入同一个 Job Runner：图片/视频沿用既有厂商协议；文本只接受明确可执行的
OpenAI-compatible `chat/completions` 或 `responses`，后者支持 `reasoning_effort`，其中 `auto` 只作为
Draft 选择且冻结/请求时省略；音频只接受 OpenAI-compatible `audio/speech`，冻结并发送白名单内的
voice/format、0.25–4 的 speed 与去除首尾空白后的非空 instructions。模型配置的 protocol 不匹配时明确
拒绝，不做伪兼容。连接输入会先按 Prompt 内 `@[node:id]` 的出现顺序冻结，再补未提及连接，并在冻结前按
模型/协议校验媒体类型和数量。`@` 菜单只枚举当前 surface 的直接 incoming `Input Connection` 且已有
同模态 Content Version 的文本、图片、视频和音频；Draft 永远保存稳定 node token，不保存“图片1”等
显示标签或 Version/path。断开连接后的 token 保留为 missing，Web 阻止提交且服务端再次拒绝，不能降级成
普通文本。冻结后服务端按 Snapshot 实际输入顺序分别为文本、图片、视频、音频从 1 编号，重复 token 复用
同一编号；final prompt 的标签与 `reference_images/reference_videos/reference_audios` 各自数组顺序一致，
隐式自身输入也参与编号。非原生批量的图片候选按槽位执行，每个成功槽位立即通过短事务登记
Content Version、candidate 状态与首个成功主结果；Midjourney 原生四宫格仍保留单次请求再逐槽登记。
批量候选逐个校验：全部成功为 `done`，部分成功为 `partial`，全部失败为 `failed`，
停止且没有有效产物为 `canceled`；部分失败不会抹掉已经成功的 Content Version。
`POST .../runs/{run_id}/retry` 明确区分 `original` 与 `current`：前者校验并复用原 Snapshot 的精确
version/hash/model，允许用 `candidate_id` 单独补跑并记录 `replaces_candidate_id`；后者从结果节点当前
Draft/连接重新解析并冻结新 Snapshot。两者都创建新 Job/Run，不覆盖旧记录。
`POST .../runs/{run_id}/cancel` 只持久化幂等 `cancel_requested_at`。Runner 尚未认领时不调用厂商并落为
`canceled`；同步厂商请求已发出时不伪装即时中断，UI 明示上游可能继续执行，有效返回仍登记，未返回候选
才标记 canceled。prepared 事务在下次项目访问或命令前完成/丢弃，不能从节点当前内容重造 Snapshot。
`POST .../runs/{run_id}/candidates/{candidate_id}/dismiss` 只允许隐藏 `failed/canceled` 槽位并写入
`dismissed_at` tombstone；Job、Snapshot、错误与既有 Content Version 均不删除，最新 tombstone 也不会让
同索引的旧失败槽位重新出现。单槽位重试成功只补回该索引，不覆盖已有成功主结果。
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
`POST .../runs/{run_id}/reverse-prompt-config` 在成功文本结果后幂等创建图片 Config Node 及文本→配置
Input Connection。图片模型同样由服务端优先 default Key、再按登记顺序选择；缺模型时保留反推文本且
零写。重复请求即使携带旧 revision，也返回已经存在的同一配置，不重复创建节点或连接。

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
导入、删除、恢复分别使用持久事务记录与独立 claim 锁；服务启动时恢复中断事务，并每 6 小时执行一次
维护，实际清除超过 30 天的回收数据。

删除请求必须携带当前 `expected_revision` 和完整 `confirm_name`。服务端在固定的 project→job 锁序下，
把项目目录、owned Job 与完整恢复包移入 `.trash/canvases/<original_id>/<trash_id>/` 并写 tombstone；项目
立即从索引消失，默认保留 30 天。`GET /canvas/trash` 只列仍可恢复的记录；恢复通过同一项目包导入器创建
新项目 ID，原 ID 的 tombstone 不复活，避免与已经传播的删除记录争用身份。

项目创作库分别落在 `library/assets.json` 与 `library/prompts.json`，两者都是独立
`RevisionedSidecar`。所有写操作必须携带 sidecar 当前 `If-Match`；读取和成功写入响应返回对应
`ETag`。资产通过 `POST /canvas/projects/{id}/library/assets` 收藏同项目现有 Content Version，同一
version 最多一个条目；PATCH 只改标题和标签，DELETE 只移出资产库，不删除节点、Content Version 或
媒体字节。`POST .../library/assets/{asset_id}/insert` 携带 Canvas Document 的 `If-Match` 和目标坐标，
创建指向同一不可变 Content Version 的新节点。

项目提示词通过 `POST/PATCH/DELETE .../library/prompts` 管理；项目本地条目可编辑，公共源条目在项目内
只读。`POST .../library/prompts/{prompt_id}/insert` 携带 Canvas Document 的 `If-Match` 和目标坐标，
先按当前提示词内容创建新的 `user_edit` Text Content Version，再创建指向该版本的文本节点。创作库写入
与画布插入均在项目锁下校验 revision；冲突返回 409，不做 last-write-wins 或自动合并。

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
