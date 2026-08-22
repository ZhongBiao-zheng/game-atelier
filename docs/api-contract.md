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
| 图像能力矩阵 | `callers/openai_image.py` | `lib/modelFamily.ts` `referenceLimits.ts` `studioSize.ts` | `tests/fixtures/capability-matrix.json`，两端各自断言 |
| 视频控件能力 | 各 `*_video.py` | `lib/videoControlCaps.ts` | 无 —— 靠人 |

给序列化 model 加字段会打红全仓精确字典断言，改完立刻跑全量 pytest + vitest。

## Job 字段所有权

`WebEditableJobPatch` = `extra="forbid"`，只有两个字段：`prompt`、`params`。其余一律 Skill / job_runner 独占，Web 改不了也不该试：

- 状态机：`status` `error` `submitted_at` `completed_at` `progress_phase`
- 产物：`output_paths`
- 归属：`character_id` `project_id` `ui_scheme_id` `screen_id` `production_id` `shot_id` `namespace` `asset_slot` `kind`
- 路由：`alias` `provider` `model` —— 换模型只能新建 job（`POST /studio/jobs`），不能改已有的
- 血缘：`retry_of` `source_image`；创作台归档血缘写在 `params.archived_from_job_id / archived_from_path`

`JobParams` = `extra="allow"`（加字段不会被上游拒），但**双端仍要同步声明**，否则 TS 那边拿不到类型。后端独占写入的三个：`actual_size`、`warnings`、`requested_size` —— 前端只读不写。

Midjourney 的 `mj_sref`、`mj_cref`、`mj_oref` 均为图片路径数组（每组最多 4 张），分别归属风格、角色、Omni 语义槽；垫图仍写入通用的 `reference_images`。Web 创建 job，caller 只负责把本地路径转公网 URL 并拼接对应 flag。

`namespace` 决定产物落哪：`character` → `characters/<id>/<slot>/`，`studio` → `studio/<job_id>/`，`ui` → `projects/<slug>/ui/<ui_scheme_id>/screens/<screen_id>/`，`video` → `projects/<slug>/videos/<production_id>/shots/<shot_id>/`。UI job 必须同时带 `project_id / ui_scheme_id / screen_id`；项目视频 job 必须同时带 `project_id / production_id / shot_id`。`kind` 是媒体轴（image/video），别拿它表达归属。

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

**双向**
`POST /characters/{id}/canonical` `POST /projects/{id}/ui-schemes/{scheme_id}/screens/canonical` `POST /experience`
`POST /projects/{id}/videos/{production_id}/shots/{shot_id}/selected`

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

自动关联只认 Job 与视频镜头中明确登记的角色素材路径，不解析 prompt。手动关联落在
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
    productions: number; shots: number; selected_shots: number;
    exports: number; next_action: string;
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
        kind: 'video'; production_id: string; shot_id: string | null;
        output_kind: 'shot' | 'export';
      };
};
```

美术只扫描项目角色三类成品槽，UI 只扫描所有方案的 screen 版本目录，视频只扫描镜头版本与 exports。
参考图、source、上传暂存、策划文档和失败 Job 不进入画廊。旧 `/gallery/project` 已删除；美术工作区
使用统一画廊的 `category=art`，`/gallery/screens` 仍服务 UI 制作页的版本元数据。

### 创作台归档契约

`GET /projects/{id}/studio-archive-targets?media_kind=image|video` 返回
`{ targets: StudioArchiveTargetOption[] }`。图片目标包含该项目的角色三类资产槽，以及所有 UI 方案中已规划
或已有版本的页面；视频目标只包含该项目所有正式企划的镜头。响应中的 `label / detail` 只用于展示，
POST 时不得回传：

```ts
type StudioArchiveTarget =
  | { kind: 'character'; character_id: string; asset_slot: AssetSlot }
  | { kind: 'ui'; ui_scheme_id: string; screen_id: string }
  | { kind: 'video'; production_id: string; shot_id: string };

type StudioArchiveTargetOption = StudioArchiveTarget & { label: string; detail: string };
```

`POST /studio/jobs/{id}/archive` 请求为
`{ source_path: string; project_id: string; target: StudioArchiveTarget }`。来源必须是该 Studio DONE Job
的 `output_paths` 成员；图片只能进入角色或 UI，视频只能进入镜头；目标必须真实属于所选项目。
服务端在目标目录复制为下一个 `vN`，不移动或改写源文件，并用完整 Job schema 新建一个正式 DONE Job。
新 Job 保留来源的 prompt、模型与生成参数，归属改为目标资产，且在 params 写入
`archived_from_job_id / archived_from_path`。响应为 `{ job, path }`；重复归档只会继续递增版本，绝不覆盖。

`GET /projects/{id}/videos` 返回 `{ productions: ProjectVideoProduction[] }`。每个 production
含 `production_id / title / type / status / brief / exports` 与 `shots`；`brief` 明确返回
`goal / platform / ratio / duration / sound`。每个 shot 含
`shot_id / purpose / duration / status / versions / selected / planned_reference_images / history`。
`history` 按新到旧保存每次 Job 的 `job_id / submitted_at / completed_at / status / prompt / model / params`，
其中 `params` 包含当次实际时长、分辨率、画幅与三组参考素材。`planned_reference_images` 是下一次生成草稿，
不得与历史混用。`POST .../selected` 请求为
`{ path: string | null }`（禁止额外字段），响应为 `{ shots: Record<string, string> }`；path 必须是
该镜头目录中实际存在的 `.mp4`。

`GET /projects/{id}/video-references` 返回当前项目可用的角色（含角色衍生）和所有 UI 方案页面定稿：
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
