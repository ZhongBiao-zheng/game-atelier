# B+ Web Server API Contract

> 双端 schema 同步源。改动时必须同时更新：
> - `skill/character_workflow/lib/schemas.py`（Python / Pydantic）
> - `web/src/schema/jobs.ts`（TypeScript / 前端）

## 文件 schema

### `.runtime/jobs/<job_id>.json`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `job_id` | string | ✅ | 唯一 ID（建议 `job-<ulid>`）|
| `character_id` | string | ✅ | `characters/<id>.md` 的 id（filename without ext）|
| `prompt` | string | ✅ | 完整出图 prompt |
| `submitted_at` | string (ISO 8601) | ✅ | UTC 提交时间 |
| `model` | string | ✅ | Lovart `--include-tools` 值 |
| `params` | object | ✅ | size / steps / cfg_scale / etc |
| `seed` | int \| null | ✅ | 随机种子 |
| `output_paths` | string[] | ✅ | PNG 落地绝对路径（成功后填充）|
| `status` | enum | ✅ | `pending` \| `running` \| `done` \| `failed` |
| `error` | string \| null | ✅ | `status=failed` 时填错误消息 |

### `.runtime/active-character.json`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `active_id` | string \| null | ✅ | 当前活跃角色 id |
| `updated_at` | string (ISO 8601) | ✅ | 最后写入时间 |

### Web 可编辑字段白名单

Web 通过 `POST /api/prompt/<job_id>` 只能修改：`prompt`、`model`、`params`、`seed`。
其他字段（`status`、`output_paths`、`submitted_at`、`character_id`、`job_id`、`error`）由 Skill 写入。

## REST 端点

| Method | Path | Request body | Response |
|---|---|---|---|
| GET | `/api/jobs` | — | `Job[]` |
| GET | `/api/jobs/<job_id>` | — | `Job` |
| GET | `/api/images?character=<id>` | — | `{ character_id, output_paths: string[] }` |
| GET | `/api/spec/<character_id>` | — | `{ content: string }` |
| POST | `/api/spec/<character_id>` | `SpecPatch` | `{ ok: true, path: string }` |
| POST | `/api/prompt/<job_id>` | `WebEditableJobPatch` | `{ ok: true }` |
| POST | `/api/feedback` | `FeedbackPost` | `{ ok: true, path: string }` |
| POST | `/api/clipboard-attempt` | `ClipboardAttempt` | `{ ok: true }` |
| GET | `/api/active-character` | — | `ActiveCharacterFile` |
| GET | `/api/characters` | — | `CharacterEntry[]` |
| GET | `/api/config` | — | `{ image_storage_root: string }` |
| POST | `/api/config` | `{ image_storage_root: string }` | `{ ok: true }` |
| GET | `/events` | — | SSE stream（见下方）|

## SSE 事件流（`GET /events`）

响应头包含 `retry: 3000`（断连后浏览器 3 秒重连）。

事件类型：

```
event: job-changed
data: {"job_id":"job-001","status":"done"}

event: image-added
data: {"character_id":"shadow_assassin","path":"/abs/path.png"}

event: spec-changed
data: {"character_id":"shadow_assassin"}

event: active-character-changed
data: {"active_id":"shadow_assassin"}
```

**澄清（v2.3 Outside Voice）**：`POST /api/prompt/<job_id>` 只更新 jobs/*.json 元信息显示，**不**触发重出图。重出图由"复制 prompt 到剪贴板 + 画师在 CC Cmd+V + Enter"完成。

## 错误响应

所有 POST 失败统一返回：

```json
{ "error": "<human readable>", "code": "<machine readable>" }
```

HTTP 状态：400（schema 不匹配）/ 404（资源不存在）/ 409（并发冲突）/ 500（IO 错误）。

## 绑定地址

server 必须绑定 `127.0.0.1`，**绝不绑 `0.0.0.0`**（共享 WiFi security surface）。

## 端口

默认 `5174`（前端 dev server `5173`）。被占用时 viewer-server 自动 +1 直到找到空端口，并把实际端口写到 `.runtime/server.port`。
