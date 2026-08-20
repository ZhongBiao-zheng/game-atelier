# API 契约

> 前后端形状的单一真值源。**改任一端先改这里**。厂商侧契约见 [references/provider-config.md](references/provider-config.md)。

## 双端同步点

改左边必须同步右边，反之亦然。没有代码层共享，只有约定 + 守卫。

| 契约 | Python | TypeScript | 守卫 |
|---|---|---|---|
| Job / JobParams | `lib/schemas.py` | `web/src/schema/jobs.ts` | 无 —— 靠人 |
| Key / ModelSpec | `lib/keys.py` | `web/src/api/keys.ts` | 无 —— 靠人 |
| ProjectFolder / ProjectFolderItem | `lib/schemas.py` | `web/src/api/projectFolders.ts` | `tests/test_project_folders.py` + `ProjectFolderPage.test.tsx` |
| CharacterVariant / CharacterEntry | `lib/schemas.py` | `web/src/schema/jobs.ts` | `tests/test_character_variants.py` + `LeftSidebar.test.tsx` + `ProjectFolderPage.test.tsx` |
| 图像能力矩阵 | `callers/openai_image.py` | `lib/modelFamily.ts` `referenceLimits.ts` `studioSize.ts` | `tests/fixtures/capability-matrix.json`，两端各自断言 |
| 视频控件能力 | 各 `*_video.py` | `lib/videoControlCaps.ts` | 无 —— 靠人 |

给序列化 model 加字段会打红全仓精确字典断言，改完立刻跑全量 pytest + vitest。

## Job 字段所有权

`WebEditableJobPatch` = `extra="forbid"`，只有两个字段：`prompt`、`params`。其余一律 Skill / job_runner 独占，Web 改不了也不该试：

- 状态机：`status` `error` `submitted_at` `completed_at` `progress_phase`
- 产物：`output_paths`
- 归属：`character_id` `project_id` `ui_scheme_id` `screen_id` `production_id` `shot_id` `namespace` `asset_slot` `kind`
- 路由：`alias` `provider` `model` —— 换模型只能新建 job（`POST /studio/jobs`），不能改已有的
- 血缘：`retry_of` `source_image`

`JobParams` = `extra="allow"`（加字段不会被上游拒），但**双端仍要同步声明**，否则 TS 那边拿不到类型。后端独占写入的三个：`actual_size`、`warnings`、`requested_size` —— 前端只读不写。

Midjourney 的 `mj_sref`、`mj_cref`、`mj_oref` 均为图片路径数组（每组最多 4 张），分别归属风格、角色、Omni 语义槽；垫图仍写入通用的 `reference_images`。Web 创建 job，caller 只负责把本地路径转公网 URL 并拼接对应 flag。

`namespace` 决定产物落哪：`character` → `characters/<id>/<slot>/`，`studio` → `studio/<job_id>/`，`ui` → `projects/<slug>/ui/<ui_scheme_id>/screens/<screen_id>/`，`video` → `projects/<slug>/videos/<production_id>/shots/<shot_id>/`。UI job 必须同时带 `project_id / ui_scheme_id / screen_id`；项目视频 job 必须同时带 `project_id / production_id / shot_id`。`kind` 是媒体轴（image/video），别拿它表达归属。

## 端点

写操作按「谁有权」分组。全部前缀 `/api`，服务绑死 `127.0.0.1`。

**Web 独占写**（Skill 不碰）
`POST /spec/{id}` `POST /prompt/{job_id}` `POST /feedback` `POST /uploads` `POST /studio/jobs`
`POST /characters` `POST /characters/{id}/variants` `POST /characters/{id}/rename` `POST /characters/{id}/gallery/{kind}` `POST /characters/{id}/project`
`POST /projects` `/projects/reorder` `/projects/{id}/rename` `DELETE /projects/{id}`
`POST /projects/{id}/folders` `/projects/{id}/folders/reorder` `/projects/{id}/folders/{folder_id}`
`DELETE /projects/{id}/folders/{folder_id}`
`POST /projects/{id}/folders/{folder_id}/items` `DELETE /projects/{id}/folders/{folder_id}/items`
`POST /projects/{id}/ui-schemes` `/projects/{id}/ui-schemes/default`

`POST /feedback` 必须携带 `{ text, character_id }`；turn-start 只消费当前 active 角色的反馈，
其他角色的反馈继续留在待处理目录。
`POST /keys` `PATCH /keys/{alias}` `DELETE /keys/{alias}` `POST /keys/models-preview`
`POST /config` `POST /gallery/{hidden,favorites,ratings}` `POST /onboarding/data-root` `POST /folder-picker`
`POST /clipboard-attempt` `DELETE /characters/{id}`
`POST /jobs/{id}/{confirm,cancel}` `DELETE /jobs/{id}` `DELETE /jobs/{id}/image`

**双向**
`POST /characters/{id}/canonical` `POST /projects/{id}/ui-schemes/{scheme_id}/screens/canonical` `POST /experience`
`POST /projects/{id}/videos/{production_id}/shots/{shot_id}/selected`

**只读**
`GET /jobs` `/jobs/{id}` `/spec/{id}` `/characters` `/active-character` `/images` `/config` `/projects` `/experience` `/keys` `/onboarding/status` `/home`
`GET /gallery/{recent,project,screens,hidden,favorites,ratings,image}` `GET /raw`
`GET /characters/{id}/canonical` `GET /projects/{id}/ui-schemes/{scheme_id}/screens/canonical`
`GET /projects/{id}/workspaces?ui_scheme={scheme_id}` `GET /projects/{id}/videos`
`GET /projects/{id}/ui-schemes`
`GET /projects/{id}/folders`

### 角色变体契约

角色皮肤是项目资产库中的独立角色资产，目录、Spec、三类出图、Job、反馈、定稿与母角色完全
隔离。母子关系只落在皮肤目录的 `characters/<variant_id>/variant.json`：

```ts
type CharacterVariant = {
  parent_character_id: string;
  difference: string;
  created_at: string;
};

type CharacterEntry = {
  id: string;
  name: string;
  status: string;
  latest_job_id: string | null;
  thumbnail?: string | null;
  variant: CharacterVariant | null;
};
```

`POST /characters/{parent_id}/variants` 请求为
`{ name: string, difference: string, folder_id?: string }`。母角色必须已归属项目；皮肤自动继承该
项目归属。传 `folder_id` 时，服务端同时把新皮肤作为 `kind='character'` 引用加入当前项目文件夹，
但资产本体仍只存在于资产库。响应为新皮肤的 `CharacterEntry`。

`turn-start` 对皮肤额外返回 `variant`，其中包含母角色 id / 显示名、母角色身份锚、皮肤差异、
当前资产槽位和母角色定稿表；`project_style` 仍是项目风格真源。出图必须组合
`project_style + variant.parent_identity_anchor + variant.difference + variant.asset_slot`，Job 的
`character_id` 始终写皮肤 id。

皮肤与母角色必须保持相同项目归属：皮肤不能单独更换项目；移动母角色时所有直接皮肤一起移动，
并移除旧项目文件夹中的这些引用，避免跨项目悬空关系。

### 项目文件夹契约

项目文件夹只保存个人整理关系，落在 `projects/<slug>/folders.json`；资产本体、历史和归属仍由
角色目录、UI 页面目录与视频企划目录负责。文件夹删除或移除成员不得删除任何资产文件。

```ts
type ProjectFolderItem = {
  kind: 'character' | 'ui_scheme' | 'ui_screen' | 'video_production';
  asset_id: string;
  scheme_id?: string | null;
};

type ProjectFolder = {
  id: string;
  name: string;
  note: string;
  created_at: string;
  items: ProjectFolderItem[];
};

type ProjectFoldersFile = { folders: ProjectFolder[] };
```

`folders` 数组顺序就是用户排序，`items` 按加入顺序展示。同一引用在单个文件夹内去重，但可同时
出现在多个文件夹；`ui_screen` 必须带 `scheme_id`，`ui_scheme` 的 `asset_id` 就是方案 id；
美术/UI/视频视图只按 `kind` 过滤，不改变资产归属。所有写操作均返回完整的
`ProjectFoldersFile`：新建请求 `{ name, note? }`，更新请求 `{ name, note }`，排序请求
`{ ordered_ids }`，加入成员请求为 `ProjectFolderItem`；移除成员通过查询参数 `kind` 和
`asset_id` 指定，`ui_screen` 还必须带 `scheme_id`。加入时服务端必须验证资产确实属于该项目。

### UI 方案契约

方案元数据落 `projects/<slug>/ui/schemes.json`，内容为
`{ default_scheme_id: string, schemes: Array<{ id, name, created_at }> }`。方案 id 由服务端按 `v1`、
`v2` 递增生成；默认方案只决定 `/workshop/{project}/ui` 的打开目标，切换默认不删数据。

`POST /projects/{id}/ui-schemes` 请求为
`{ name, source_scheme_id, copy_style, copy_screen_map, screen_ids }`。复制的页面版本成为新方案起点，
但不复制 canonical；两套方案之后独立写 `style.md / screens / canonical.json`。viewer-server 启动时
显式执行一次旧项目升级：把旧 `screens/` 移到 `ui/v1/screens/`，把根 `style.md` 的 `ui.*` 章节
移入 V1，并经完整 Job 模型校验修正 Job、canonical 和文件夹引用。正常读取只接受新路径，不做迁移或 fallback。

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
    productions: number; shots: number; selected_shots: number;
    exports: number; next_action: string;
  };
}
```

`GET /projects/{id}/videos` 返回 `{ productions: ProjectVideoProduction[] }`。每个 production
含 `production_id / title / type / status / brief / exports` 与 `shots`；`brief` 明确返回
`goal / platform / ratio / duration / sound`。每个 shot 含
`shot_id / purpose / duration / status / versions / selected / planned_reference_images / history`。
`history` 按新到旧保存每次 Job 的 `job_id / submitted_at / completed_at / status / prompt / model / params`，
其中 `params` 包含当次实际时长、分辨率、画幅与三组参考素材。`planned_reference_images` 是下一次生成草稿，
不得与历史混用。`POST .../selected` 请求为
`{ path: string | null }`（禁止额外字段），响应为 `{ shots: Record<string, string> }`；path 必须是
该镜头目录中实际存在的 `.mp4`。

`GET /projects/{id}/video-references` 返回当前项目可用的角色、角色皮肤和所有 UI 方案页面定稿：
`{ candidates: Array<{ kind, asset_id, scheme_id, label, detail, path, stale }> }`。只返回真实存在的
canonical 文件；`stale` 只提示人工判断，不自动替换。

`POST /projects/{id}/videos/{production}/shots/{shot}/references` 请求为
`{ paths: string[] }`（禁止重复和额外字段），只接受该项目当前 canonical 或该镜头已保存的明确版本，
响应为 `{ paths: string[] }`。草稿落 `projects/<slug>/videos/<production>/references.json`；
`submit-video-shot` 创建 Job 时把这些路径复制进 `params.reference_images`。因此后续切换 canonical
只改变候选，不会改写历史 Job。

### 几个要当心的

`GET /raw` 与 `GET /gallery/image`：路径不能随便给，`/raw` 走 job_id 白名单，只读该 Job 的
`output_paths`、`params.reference_{images,videos,audios}`、MJ 三组参考素材与 `source_image`；
`gallery/image` 只放行 characters、projects screens、projects videos 的 `shots/` / `exports/` 资产以及 studio 子树；项目 brief / shot-map 不对外暴露。加新产物目录要同步放行。

`GET /keys/{alias}/reveal`：唯一回明文密钥的接口。按显式 alias、按需返回；列表接口一律掩码。

`POST /keys/models-preview`：形状与分类瀑布见 [references/provider-config.md](references/provider-config.md) 的「models-preview 契约」一节。两条硬约束——① 用存储密钥时 `base_url` 只能与存储值同 host；② 默认 `/models` 未必是全集（OpenRouter 的视频模型要额外拉 `?output_modalities=video`）。

## 不变式

- 同一时间只支持一个 Web tab，多 tab 行为未定义。
- job JSON 禁止手写：`/api/jobs` 全量 Pydantic 校验，一条 schema 错会让整个列表 500（表现为「角色里没内容」）。用 `lib/jobs.py` 的 `Job`/`save_job()` 生成。
- `params.warnings` 是数组不是字符串；`status`/`kind`/`asset_slot` 必须用 schema 枚举值。
- 改后端 lib 后 viewer-server 必须重启：长驻进程缓存旧模块，症状是「X object has no attribute Y」而 pytest 全绿。
