# 画布 MCP 契约

> 与[工坊 MCP](workshop-mcp.md) 共用同一个 stdio 进程、同一份凭据文件，但授权与工具分开
> （ADR-0017 决定 4，遵守 [ADR-0011](../adr/0011-restrict-canvas-agent-to-approved-change-sets.md) 的
> change set 原则）。画布是 server 持有、带 revision 的活文档，Agent 只能经这些工具改，不能改文件。

## 授权

Agent 授权（`POST /api/connection/agent-grants`）新增 `canvas_project_ids` 与三项能力：

| 能力 | 允许 |
| --- | --- |
| `canvas_read` | 列授权画布、读文档、读模型列表、读生成状态、读媒体预览 |
| `canvas_edit` | typed change set 改节点 / 连线 / 生成配置；从本机路径导入媒体 |
| `canvas_generate` | 在 surface 节点发起生成（付费）。持有即批准，服务端记录会话来源 |

工坊 `project_ids` 与画布 `canvas_project_ids` 互不继承；任一非空即可创建授权，画布授权必须含 `canvas_read`。

## 工具表

HTTP 端点 `POST /api/canvas-agent/<op>`，请求体 JSON ≤ 1 MiB，参数包在 `payload`。

| 工具 | 输入 → 结果 | 能力 |
| --- | --- | --- |
| `canvas_list_projects` | `{}` → 授权画布 id / 名称 | canvas_read |
| `canvas_get_document` | project_id → revision、节点（类型 / 标题 / 位置 / 文本 ≤4000 字 / draft / 版本）、输入与派生连线、媒体版本 | canvas_read |
| `canvas_list_models` | project_id、mode(image/video) → 可用 alias / model / 能力（同工坊 `list_models` 行） | canvas_read |
| `canvas_apply_changes` | project_id、expected_revision、changes[] → 新 revision、新建 id | canvas_edit |
| `canvas_import_media` | project_id、expected_revision、本机绝对路径、title?、position? → version_id、node_id、revision | canvas_edit |
| `canvas_run` | project_id、surface_node_id、expected_revision、requested_count → job / run 摘要 | canvas_generate |
| `canvas_get_run` | project_id、run_id → 状态、候选与产物 version_id | canvas_read |
| `canvas_read_media` | project_id、version_id → 有界 JPEG 预览或元数据 | canvas_read |

### change set

`changes` 每项以 `op` 区分，一次最多 50 条，整批在同一 `expected_revision` 上原子提交：

| op | 字段 | 说明 |
| --- | --- | --- |
| `add_text` | title、text、position、node_id? | 新建文本节点 + user_edit 文本版本 |
| `add_media_node` | title、version_id、position、node_id? | 引用本画布已有媒体版本建节点 |
| `set_text` | node_id、text | 文本节点新版本，旧版本不可变 |
| `set_draft` | node_id、mode、prompt、model、alias?、input_policy?、params? | 生成配置；params 只收标量并按浏览器白名单过滤，路径类字段丢弃 |
| `connect` / `disconnect` | source/target/slot? · connection_id | 只处理 `input` 连线，派生连线由服务端写 |
| `move` / `remove_node` | node_id、position · node_id | 删节点同时删其输入连线 |

revision 不符返回 `DOCUMENT_CONFLICT`，重读后再改。生成产物、派生连线、历史版本由服务端持有，
工具不能新建或改动；`canvas_run` 之后用 `canvas_get_run` 查同一 run_id，不重提。

### 本机文件导入

`canvas_import_media` 接受本机绝对路径（图片 ≤10 MB，视频 / 音频 ≤100 MB，后缀同 Web 上传白名单），
复制为不可变 upload 版本并建节点；不接受相对路径、目录、URL。OS 用户已能读的文件才导得进，
这不是对宿主 Agent 文件权限的沙箱（见工坊契约「限制边界」）。

## 错误

复用工坊错误形状与 code：`TARGET_NOT_AUTHORIZED`（画布不在授权内）、`DOCUMENT_CONFLICT`、
`INVALID_TARGET`（节点 / run 不存在）、`INVALID_PARAMETERS`、`REFERENCE_NOT_ALLOWED`、`CONTENT_TOO_LARGE`。
Agent 看到的失败摘要去除供应商原始报错与本机路径。
