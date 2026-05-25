# B+ Web Server API Contract

> 双端 schema 同步源。改动时必须同时更新：
> - `skill/character_workflow/lib/schemas.py`（Python / Pydantic）
> - `web/src/schema/jobs.ts`（TypeScript / 前端）

## 文件 schema

### `.runtime/jobs/<job_id>.json`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `job_id` | string | ✅ | 唯一 ID（建议 `job-<ulid>`）|
| `character_id` | string | ✅ | `characters/<id>/spec.md` 的 id（顶层目录名）|
| `prompt` | string | ✅ | 完整出图 prompt |
| `submitted_at` | string (ISO 8601) | ✅ | UTC 提交时间 |
| `model` | string | ✅ | Lovart `--include-tools` 值 |
| `params` | object | ✅ | size / steps / cfg_scale / etc |
| `seed` | int \| null | ✅ | 随机种子 |
| `output_paths` | string[] | ✅ | PNG 落地绝对路径（成功后填充）|
| `status` | enum | ✅ | `pending_confirm` \| `pending` \| `done` \| `failed` |
| `error` | string \| null | ✅ | `status=failed` 时填错误消息 |
| `kind` | enum | ✅ | `portrait` \| `promo` \| `turnaround`；旧 job 缺省按 `portrait` |
| `source_image` | string \| null | ✅ | 本地源参考图；runner 会归一进 `params.reference_images` |

`params` 中 runner 维护的扩展字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `reference_images` | string[] | Web 展示和本地调用输入，至少包含 `source_image` |
| `requested_size` | string \| null | 画师请求尺寸；兼容旧 `size` |
| `actual_size` | string \| null | runner 从最终图片读到的实际尺寸 |
| `lovart_attachments` | string[] | 本地参考图上传 Lovart 后得到的远端 URL |
| `lovart_thread_id` | string \| null | 本次 Lovart 线程 |
| `lovart_final_status` | string \| null | Lovart 返回的最终状态；有有效图时 `timeout` 也可 DONE + warning |
| `warnings` | string[] | 非阻塞异常，例如 timeout 但已选到有效 artifact |

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
| DELETE | `/api/jobs/<job_id>` | — | `{ ok: true }`；仅允许删除 `status=failed` 的失败记录 |
| DELETE | `/api/jobs/<job_id>/image?path=<path>` | — | `{ ok: true }`；删除 job 内的一张输出图 |
| GET | `/api/images?character=<id>` | — | `{ character_id, output_paths: string[] }` |
| GET | `/api/spec/<character_id>` | — | `{ content: string }` |
| POST | `/api/spec/<character_id>` | `SpecPatch` | `{ ok: true, path: string }` |
| POST | `/api/prompt/<job_id>` | `WebEditableJobPatch` | `{ ok: true }` |
| POST | `/api/feedback` | `FeedbackPost` | `{ ok: true, path: string }` |
| POST | `/api/clipboard-attempt` | `ClipboardAttempt` | `{ ok: true }` |
| POST | `/api/uploads` | multipart `file` | `{ path: string, filename: string }`；上传到 `.runtime/uploads/` |
| POST | `/api/characters/<character_id>/gallery/<kind>` | multipart `file` | `{ job_id: string, path: string, filename: string }`；直接加入角色图廊 |
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

---

## v2（2026-05-25）— Atelier-Web PR1

### Schema 重命名（向后兼容靠迁移脚本）

- 老 `kind` 字段（`portrait` / `promo` / `turnaround`）→ 拆出为独立类型 `AssetSlot`，枚举值不变
- 新 `JobKind`（`image` / `video`）—— 媒体类型；`video` 仅占位，runner 会抛 `NotImplementedError`
- `Job` 新增三个字段：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `asset_slot` | `AssetSlot` | `portrait` | 替代原 `kind` 字段的语义 |
| `kind` | `JobKind` | `image` | 媒体类型 |
| `namespace` | string | `character` | `character` \| `studio`；runner 按此分流 |

- `Job.character_id` 保持 `str`（非 `Optional`）。Studio job 把 alias 写在此处作 placeholder，runner 看 `namespace` 而非 `character_id`。

### 新增端点

| Method | Path | Request body | Response |
|---|---|---|---|
| GET | `/api/gallery/recent?limit=24` | — | `{items: [{character_id, asset_slot, filename, path, mtime}]}`；按 mtime 倒序，仅扫 `characters/*/{portrait,promo,turnaround}/` |
| GET | `/api/gallery/image?path=<rel>` | — | 二进制 `FileResponse`；仅接受 `characters/` 和 `studio/` 前缀，越界返回 400 |
| POST | `/api/studio/jobs` | `{prompt, model, params, alias?, kind?}` | `Job`（`status=pending`，`namespace=studio`，跳过 `pending_confirm`——UI 点 ↑ 即确认）；`kind=video` 返回 422；端点末尾 schedule background runner |
| GET | `/api/jobs/{job_id}` | — | `Job`；Studio UI 用它做 2 s polling |

### 修改的端点

- `POST /api/keys` 现在返回 `{...row, secret_revealed: true}`，其中 `secret_revealed` 字段 **仅在创建时一次性返回**（值为原始 secret）；`GET /api/keys` 列表永远只返回 masked 值。

### 不变的安全边界

- `/api/raw` 仍走 `job_id` 白名单（只能读 `output_paths` 里已登记的文件）。
- `WebEditableJobPatch` 白名单**不扩展**：`status`、`output_paths`、`character_id`、`namespace`、`asset_slot`、`kind`、`error` 均为 Skill / server 独占，Web 不可写。

### 数据迁移

老 `.runtime/jobs/<id>.json` 必须跑一次迁移脚本以补齐新字段：

```bash
CHARACTER_WORKFLOW_DATA_ROOT=/path/to/data uv run python scripts/migrate_jobs_2026_05_25.py
```

脚本幂等：重复执行无副作用。
