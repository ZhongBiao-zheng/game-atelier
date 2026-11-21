# 画布 MCP 契约

> stdio 进程只暴露画布工具（[ADR-0027](../adr/0027-canvas-project-is-the-project.md)）；沿用 [ADR-0011](../adr/0011-restrict-canvas-agent-to-approved-change-sets.md) 的
> typed change set 与 revision 原则，批准粒度为授权级：持有 `canvas_edit` / `canvas_generate` 即批准，
> 无 change-set 逐次确认。画布是 server 持有、带 revision 的活文档，Agent 只能经这些工具改，不能改文件。

## 授权

控制台 Agent 连接页开关打开即授权全部画布与下列三项能力（ADR-0022）：

| 能力 | 允许 |
| --- | --- |
| `canvas_read` | 列画布、读文档、读模型列表、读生成状态、读媒体预览、参考库和类别规范、等待与核对结果 |
| `canvas_edit` | typed change set 改节点 / 连线 / 生成配置；从本机路径导入媒体 |
| `canvas_generate` | 在一个或多个 surface 节点发起生成（付费）。持有即批准，服务端记录会话来源 |

## 工具表

stdio 工具的参数包在 `payload`。适配器取出参数对象，作为 JSON 请求体发给 `POST /api/canvas-agent/<op>`。请求体和单次 HTTP 响应上限各为 1 MiB。

| 工具 | 输入 → 结果 | 能力 |
| --- | --- | --- |
| `canvas_list_projects` | `{}` → 授权画布 id / 名称 | canvas_read |
| `canvas_get_document` | project_id → revision、节点（类型 / 标题 / 位置 / 文本 ≤4000 字 / draft / 版本；分镜节点另带只读的 `storyboard` 镜头摘要）、输入与派生连线、媒体版本 | canvas_read |
| `canvas_list_models` | project_id、mode(image/video) → 可用 alias / model / 能力 | canvas_read |
| `canvas_apply_changes` | project_id、expected_revision、changes[] → 新 revision、新建 id | canvas_edit |
| `canvas_import_media` | project_id、expected_revision、本机绝对路径、title?、position? → version_id、node_id、revision | canvas_edit |
| `canvas_run` | project_id、surface_node_id、expected_revision、requested_count → job / run 摘要 | canvas_generate |
| `canvas_get_run` | project_id、run_id → 状态、候选与产物 version_id | canvas_read |
| `canvas_read_media` | project_id、version_id → 有界 JPEG 预览或元数据 | canvas_read |
| `canvas_search_library` | project_id、category?（1–24 字）、limit?（1–12，默认 12）→ 本项目定稿图片 assets[]，含 asset_id、title、category、width、height | canvas_read |
| `canvas_search_team` | project_id、query?（最多 60 字）、category?、limit?（范围同上）→ 挂载库的图片 assets[]，含 asset_id（team:…）、title、category、tags、author、library | canvas_read |
| `canvas_read_spec` | project_id、category（1–24 字）→ {text}，项目规范在前，之后为挂载库同类别的规范；均缺失时返回空字符串 | canvas_read |
| `canvas_wait_for_run` | project_id、run_id → 当前生成状态、candidates、成功产物的 version_id；终态附可取得的 checks 和预览，等待期满仍在执行时带 note | canvas_read |
| `canvas_check_run` | project_id、run_id → 生成状态与候选；成功候选的 checks[] 含 name、expected、actual、ok，失败候选带 error | canvas_read |
| `canvas_read_video_frames` | project_id、version_id、count?（1–9，默认 6）、start_ms?（≥0）、end_ms?（≥1）→ version_id、duration_ms、fps、width、height、frames[{index,t_ms}] 及一张带时间码的 JPEG 联系表 | canvas_read |
| `canvas_run_batch` | project_id、expected_revision、items[{surface_node_id,count?}] → items[]、submitted、failed、rejected、note | canvas_generate |

搜索与等待结果用 MCP 的 ImageContent 返回可用预览，最多 4 张。`attach_images` 按相同顺序列出图片引用。大小预算不足时仍返回资产或候选的文本记录。视频联系表单独作为 ImageContent，文本与 structuredContent 里只保留元数据。

`canvas_wait_for_run` 轮询同一个 run，等待上限为 240 秒。stdio 到 viewer-server 的读取超时为 270 秒，给最后一次查询和返回留出时间。等待会占用适配器 4 个并发名额中的 1 个；满额时返回 `CONNECTION_RATE_LIMITED`。客户端应为这次工具调用留足时间。等到期可用原 run_id 再查。

批量生成接受 1–20 个不同节点，每项 count 为 1–4，默认 1。客户端传入用户核对过的画布修订号；整批重复节点或起始修订冲突时直接退回。提交成功后，下一项沿用刚提交的修订号。中途的其他编辑会触发修订冲突。结果按输入顺序返回，每项含 index（从 0 起）、surface_node_id、count 和 status。submitted 项带 run_id、result_node_id，failed 项带 error。持有 canvas_generate 即获服务端批准，MCP 不产生内置 Agent 的逐项确认卡，因此 rejected 为 0。

提交成功只表示任务已登记。以 run_id 等待或查询最终的生成状态；网关逐项核算额度。后续项失败时，已成功的项保留，返回结果中的订单号可继续查询。网关返回的标准额度与重置时间可见，其他厂商的原始报错使用安全摘要。自动重复整批会产生新任务。

### 插件工具（ADR-0043）

只对白名单里的插件开放，目前只有 PS 联动（`ps-bridge`）。适配器静态登记 `ps_inspect` / `ps_import` / `ps_place` / `ps_preview` / `ps_execute`，列工具时按服务端此刻的可用情况过滤（插件未启用、脚本开关关着时 `ps_execute` 不列出），调用时以服务端判断为准。

| HTTP | 输入 → 结果 | 能力 |
| --- | --- | --- |
| `POST /api/canvas-agent/plugin-tools` | `{}` → `{tools: [{plugin_id, tool, read_only, description, parameters}]}` | Agent 凭据 |
| `POST /api/canvas-agent/plugin-tools/<plugin_id>/<tool>` | `{project_id, arguments}` → 插件工具的结果（`preview` 字段为 `{mime_type, data_base64}` 图片） | 只读工具 canvas_read，其余 canvas_edit |

两个接口只认 Agent 凭据，本机页面的会话走到这里也返回 403。工具当前不可用返回 404 `TOOL_NOT_AVAILABLE`。

### change set

`changes` 每项以 `op` 区分，一次最多 50 条，整批在同一 `expected_revision` 上原子提交：

| op | 字段 | 说明 |
| --- | --- | --- |
| `add_text` | title、text、position、node_id? | 新建文本节点 + user_edit 文本版本 |
| `add_media_node` | title、version_id、position、node_id? | 引用本画布已有媒体版本建节点 |
| `add_surface` | kind(image/video/audio)、title、position、node_id? | 空媒体节点作生成面，产物落在同一节点；与 Web 行为一致 |
| `set_text` | node_id、text | 文本节点新版本，旧版本不可变 |
| `set_draft` | node_id、mode、prompt、model、alias?、input_policy?、params? | 生成配置；mode 必须与节点类型一致（text→text，image/video/audio 节点→同类），否则 `INVALID_TARGET`；params 只收标量并按浏览器白名单过滤，路径类字段丢弃 |
| `connect` / `disconnect` | source/target/slot? · connection_id | 只处理 `input` 连线，派生连线由服务端写。文本节点接进带 draft 的节点时，服务端自动把 `@[node:<id>]` 补进 prompt（已有则不重复） |
| `move` / `remove_node` | node_id、position · node_id | 删节点同时删其输入连线 |

revision 不符返回 `DOCUMENT_CONFLICT`，重读后再改。生成产物、派生连线、历史版本由服务端持有，
工具不能新建或改动；`canvas_run` 之后用 `canvas_get_run` 查同一 run_id，不重提。

### 本机文件导入

`canvas_import_media` 接受本机绝对路径（图片 ≤10 MB，视频 / 音频 ≤100 MB，后缀同 Web 上传白名单），
版本与引用节点在同一把锁、同一次提交里落盘（revision 只 +1；撞 revision 不留孤儿版本）；
不接受相对路径、目录、URL。**边界**：按符号链接终点判，只允许用户家目录与工作区（data_root）内的
文件，工作区里其他画布的目录不算——画布授权是按项目给的，不能借它读走本机任意图片。越界返回
`REFERENCE_NOT_ALLOWED` 403。

## 错误

错误包含 code、message 与 request_id：`TARGET_NOT_AUTHORIZED`（画布不在授权内）、`DOCUMENT_CONFLICT`、
`INVALID_TARGET`（节点 / run 不存在）、`INVALID_PARAMETERS`、`REFERENCE_NOT_ALLOWED`、`CONTENT_TOO_LARGE`。
Agent 看到的失败摘要去除供应商原始报错与本机路径。
