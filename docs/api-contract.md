# API 契约

> 前后端形状的单一真值源。**改任一端先改这里**。厂商侧契约见 [references/provider-config.md](references/provider-config.md)。

## 双端同步点

改左边必须同步右边，反之亦然。没有代码层共享，只有约定 + 守卫。

| 契约 | Python | TypeScript | 守卫 |
|---|---|---|---|
| Job / JobParams | `lib/schemas.py` | `web/src/schema/jobs.ts` | 无 —— 靠人 |
| Key / ModelSpec | `lib/keys.py` | `web/src/api/keys.ts` | 无 —— 靠人 |
| 图像能力矩阵 | `callers/openai_image.py` | `lib/modelFamily.ts` `referenceLimits.ts` `studioSize.ts` | `tests/fixtures/capability-matrix.json`，两端各自断言 |
| 视频控件能力 | 各 `*_video.py` | `lib/videoControlCaps.ts` | 无 —— 靠人 |

给序列化 model 加字段会打红全仓精确字典断言，改完立刻跑全量 pytest + vitest。

## Job 字段所有权

`WebEditableJobPatch` = `extra="forbid"`，只有两个字段：`prompt`、`params`。其余一律 Skill / job_runner 独占，Web 改不了也不该试：

- 状态机：`status` `error` `submitted_at` `completed_at` `progress_phase`
- 产物：`output_paths`
- 归属：`character_id` `project_id` `screen_id` `production_id` `shot_id` `namespace` `asset_slot` `kind`
- 路由：`alias` `provider` `model` —— 换模型只能新建 job（`POST /studio/jobs`），不能改已有的
- 血缘：`retry_of` `source_image`

`JobParams` = `extra="allow"`（加字段不会被上游拒），但**双端仍要同步声明**，否则 TS 那边拿不到类型。后端独占写入的三个：`actual_size`、`warnings`、`requested_size` —— 前端只读不写。

Midjourney 的 `mj_sref`、`mj_cref`、`mj_oref` 均为图片路径数组（每组最多 4 张），分别归属风格、角色、Omni 语义槽；垫图仍写入通用的 `reference_images`。Web 创建 job，caller 只负责把本地路径转公网 URL 并拼接对应 flag。

`namespace` 决定产物落哪：`character` → `characters/<id>/<slot>/`，`studio` → `studio/<job_id>/`，`ui` → `projects/<slug>/screens/<screen_id>/`，`video` → `projects/<slug>/videos/<production_id>/shots/<shot_id>/`。项目视频 job 必须同时带 `project_id / production_id / shot_id`；Studio 自由视频仍为 `namespace=studio, kind=video`。`kind` 是媒体轴（image/video），`run_job` 靠它派发，别拿它表达归属。

## 端点

写操作按「谁有权」分组。全部前缀 `/api`，服务绑死 `127.0.0.1`。

**Web 独占写**（Skill 不碰）
`POST /spec/{id}` `POST /prompt/{job_id}` `POST /feedback` `POST /uploads` `POST /studio/jobs`
`POST /characters` `POST /characters/{id}/rename` `POST /characters/{id}/gallery/{kind}` `POST /characters/{id}/project`
`POST /projects` `/projects/reorder` `/projects/{id}/rename` `DELETE /projects/{id}`
`POST /keys` `PATCH /keys/{alias}` `DELETE /keys/{alias}` `POST /keys/models-preview`
`POST /config` `POST /gallery/{hidden,favorites,ratings}` `POST /onboarding/data-root` `POST /folder-picker`
`POST /clipboard-attempt` `DELETE /characters/{id}`
`POST /jobs/{id}/{confirm,cancel}` `DELETE /jobs/{id}` `DELETE /jobs/{id}/image`

**双向**
`POST /characters/{id}/canonical` `POST /projects/{id}/screens/canonical` `POST /experience`
`POST /projects/{id}/videos/{production_id}/shots/{shot_id}/selected`

**只读**
`GET /jobs` `/jobs/{id}` `/spec/{id}` `/characters` `/active-character` `/images` `/config` `/projects` `/experience` `/keys` `/onboarding/status` `/home`
`GET /gallery/{recent,project,screens,hidden,favorites,ratings,image}` `GET /raw`
`GET /characters/{id}/canonical` `GET /projects/{id}/screens/canonical`
`GET /projects/{id}/workspaces` `GET /projects/{id}/videos`

### 项目工作区响应

`GET /projects/{id}/workspaces` 返回只读聚合，不落第二份进度：

```ts
{
  project_id: string;
  art: { characters: number; canonical: number; stale: number };
  ui: {
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
    productions: number; shots: number; selected_shots: number;
    exports: number; next_action: string;
  };
}
```

`GET /projects/{id}/videos` 返回 `{ productions: ProjectVideoProduction[] }`。每个 production
含 `production_id / title / type / status / brief / exports` 与 `shots`；`brief` 明确返回
`goal / platform / ratio / duration / sound`。每个 shot 含
`shot_id / purpose / duration / status / versions / selected / prompt / model` 以及三组
`reference_images / reference_videos / reference_audios`。`POST .../selected` 请求为
`{ path: string | null }`（禁止额外字段），响应为 `{ shots: Record<string, string> }`；path 必须是
该镜头目录中实际存在的 `.mp4`。

### 几个要当心的

`GET /raw` 与 `GET /gallery/image`：路径不能随便给，`/raw` 走 job_id 白名单（只读 `output_paths` 里登记过的文件），`gallery/image` 只放行 characters、projects screens、projects videos 的 `shots/` / `exports/` 资产以及 studio 子树；项目 brief / shot-map 不对外暴露。加新产物目录要同步放行。

`GET /keys/{alias}/reveal`：唯一回明文密钥的接口。按显式 alias、按需返回；列表接口一律掩码。

`POST /keys/models-preview`：形状与分类瀑布见 [references/provider-config.md](references/provider-config.md) 的「models-preview 契约」一节。两条硬约束——① 用存储密钥时 `base_url` 只能与存储值同 host；② 默认 `/models` 未必是全集（OpenRouter 的视频模型要额外拉 `?output_modalities=video`）。

## 不变式

- 同一时间只支持一个 Web tab，多 tab 行为未定义。
- job JSON 禁止手写：`/api/jobs` 全量 Pydantic 校验，一条 schema 错会让整个列表 500（表现为「角色里没内容」）。用 `lib/jobs.py` 的 `Job`/`save_job()` 生成。
- `params.warnings` 是数组不是字符串；`status`/`kind`/`asset_slot` 必须用 schema 枚举值。
- 改后端 lib 后 viewer-server 必须重启：长驻进程缓存旧模块，症状是「X object has no attribute Y」而 pytest 全绿。
