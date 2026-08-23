# Canvas 图片与媒体工具等价实现方案

Status: ready-for-human

## 推荐结论

推荐方案 A：**交互预览留在浏览器，确定性媒体变换由 viewer-server 使用 Pillow 执行，AI 派生全部
进入 Job Runner；任何结果先成为本 Canvas Project 拥有的不可变 Content Version，再原子创建节点与
Derivation Connection。**

这不是照搬固定参考仓库的浏览器 Canvas 实现。参考基线
`basketikun/infinite-canvas@9414048f9d0a099386aa15d81bedb5376b79ee61` 的裁剪、切图与放大流程是：

```text
浏览器读取 data URL
  → HTMLCanvasElement 变换
    → toDataURL('image/png')
      → uploadImage()
        → 前端追加节点与连接
```

我们保留相同的可观察结果、对话框结构和节点布局，但把最终变换放进服务端命令，原因是：

- 文件系统是唯一真源，浏览器不能先宣布节点成功、再赌上传与 autosave 都成功。
- 服务端可以统一做 MIME sniff、像素/内存上限、EXIF orientation、摘要、原子落盘与路径白名单。
- 生成结果和上传图片都能通过 `version_id` 处理，不需要把 Job 输出下载到浏览器再重新上传。
- 多图切分可以先在 staging 全量完成，再一次提交 N 个版本、节点和 Derivation Connection，避免半成功画布。
- Pillow 是成熟的 Python 图像库，当前稳定线 12.3.0 支持 Python 3.11+，MIT-CMU 许可证；依赖只进入
  viewer-server，不增加 Web bundle。

浏览器仍负责选区、切线、蒙版笔刷、缩放预览和即时尺寸反馈；这些是可丢弃的交互态，不是真源。

依赖依据来自 Pillow 官方材料：[稳定版与发布时间](https://pillow.readthedocs.io/en/stable/releasenotes/)、
[Python 支持范围](https://github.com/python-pillow/Pillow/blob/main/pyproject.toml) 与
[MIT-CMU 许可证](https://github.com/python-pillow/Pillow/blob/main/LICENSE)。实现时仍以 lockfile 解析结果和
本仓库 Python 3.11 测试为准，不根据文档描述猜测已安装版本。

## 工具逐项归属

| Matrix | 用户动作 | 执行位置 | 新文件 / Job | 画布结果 | 来源与撤销 |
|---|---|---|---|---|---|
| E01 | 保存到资产库 | 服务端 library command | 无新字节 | Canvas Library Entry 指向当前 version | 撤销只删除 entry；version 不变 |
| E02 | 图片/视频/音频下载 | 服务端 version download | 无 | 无节点变化 | 按 version_id 下载；不接收裸 path |
| E03 | 替换媒体 | 服务端 upload + node command | 新 upload version | 原节点切换 current_version_id | undo 恢复旧指针；旧 version 保留 |
| E04 | 复制生成提示词 | 浏览器读 Snapshot/Draft | 无 | 剪贴板文本 | 优先实际 Snapshot，未运行才读 Draft |
| E05 | 反推提示词 | 专用受控 Text Run + 幂等 config command | Canvas Job | 新文本节点 + 图片生成配置节点 | Snapshot 记录源图片/preset；不改原 Draft |
| E06 | 蒙版局部编辑 | 浏览器画 mask；Job Runner 编辑 | mask input + image Job | 新图片节点 | Snapshot 冻结源 version、mask 与 prompt |
| E07 | 裁剪 | Pillow local tool | 1 个 derived PNG/version | 源节点右侧新图片节点 | local_tool origin；undo 移除节点/边 |
| E08 | 任意行列切图 | Pillow local tool | N 个 derived PNG/version | 规则网格子节点 | 同 operation_id；一次原子提交/撤销 |
| E09 | 本地放大 | Pillow local tool | 1 个 derived PNG/version | 源节点右侧新图片节点 | 明示为重采样，不冒充 AI 细节恢复 |
| E10 | 多角度生成 | Job Runner image edit | image Job | 新图片节点 | Snapshot 冻结角度参数与源 version |
| E11 | 大图查看/详情 | version media + metadata API | 无 | lightbox / info dialog | 只读，不加载未知外链 |
| E12 | 快捷工具与标签偏好 | 应用级 UI preference | `.config/canvas-ui.json` | toolbar 排序/显隐 | 不进入 Canvas Document/项目包 |
| E13 | AI 超分 | 排除 | 无 | 不显示可执行入口 | 固定基线只有“暂未实现”占位 |
| E14 | 视频编辑 prompt | Job Runner video derivation | video Job | 新视频节点 | Snapshot 冻结源视频与 prompt |

“自由缩放”只改 `CanvasMediaDisplay.free_resize` 和节点尺寸，不生成像素文件；切回锁比例时以当前 Content
Version 的真实宽高比约束后续 resize，不把已经自由变形的节点尺寸写回媒体元数据。

## 为什么不采用另外两种方案

### B. 完全照搬浏览器 Canvas

优点是前端实现直接、无后端依赖。拒绝作为最终路径：大图解码和 PNG 编码占主线程/内存；跨浏览器
Canvas 限制不同；EXIF、色彩配置与动画帧容易静默变化；N 张切图需要 N 次上传，无法与文档原子提交。

### C. 所有工具都建 Job

优点是状态模型统一。拒绝：裁剪、切图、确定性重采样不调用模型、无计费、通常亚秒级，把它们塞进
Job Runner 会制造无意义的 pending/cancel/provider 语义。只有 AI 蒙版、反推、角度和视频编辑进入 Job。

## Content Version 与本地工具来源

方案 A 确认后，作为 schema v2 Foundation 的显式修订一次性更新 Domain v2、schema v2、generation
mapping、`CONTEXT.md`、`docs/api-contract.md` 和 ADR-0007；在确认前这些正式契约保持不变，ADR-0013
保持 `proposed`。修订包含：

- Derivation Connection 的来源由单一 `run_id` 改为 `generation_run | local_tool` discriminated union。
- `CanvasContentOrigin` 增加 `user_mask`，并把 `local_tool` 扩展为完整、不可变的来源描述。
- `CanvasGenerationSnapshot` 增加 nullable `mask_version_id`。
- 媒体路径白名单和项目布局增加 `canvases/<project_id>/derived/<operation_id>/`。
- generation mapping 增加受控的 `mask-edit` 与 `reverse-prompt` 专用 Run 入口；两者都不接受浏览器传入
  provider、路径或任意模型参数。

其中 `local_tool` origin 不再只保存一个无法解释的 id：

```ts
type CanvasLocalToolOrigin =
  | {
      kind: 'local_tool';
      operation_id: string;
      source_version_id: string;
      operation: { kind: 'crop'; rect: NormalizedRect };
    }
  | {
      kind: 'local_tool';
      operation_id: string;
      source_version_id: string;
      operation: {
        kind: 'split';
        horizontal_lines: number[];
        vertical_lines: number[];
        row: number;
        column: number;
      };
    }
  | {
      kind: 'local_tool';
      operation_id: string;
      source_version_id: string;
      operation: {
        kind: 'upscale';
        target_long_edge: number;
        algorithm: 'nearest' | 'bilinear' | 'lanczos';
      };
    };
```

- 坐标和切线使用 `[0, 1]` 归一化值；服务端按 EXIF orientation 归一后的真实像素换算。
- 一个 split operation 的所有子 version 共享 operation_id，每个 union 分支在 operation 内记录 row/column。
- local tool 不改写源 version，不覆盖源文件，也不复用源节点作为结果。
- 新增项目相对目录 `derived/<operation_id>/`；普通上传仍在 `uploads/`，模型产物仍在
  `outputs/<job_id>/`。三者都只能由服务端根据 version/job 所有权解析。
- Content Version 保存服务端实测的 `sha256/bytes/mime_type/width/height`，客户端字段不可信。

## 统一本地工具命令

不增加三套形状相似的端点，使用 discriminated union：

```http
POST /api/canvas/projects/{project_id}/media-operations
Content-Type: application/json
```

```ts
type CanvasMediaOperationRequest = {
  expected_revision: number;
  source_node_id: string;
  source_version_id: string;
  operation:
    | { kind: 'crop'; rect: NormalizedRect }
    | { kind: 'split'; horizontal_lines: number[]; vertical_lines: number[] }
    | { kind: 'upscale'; target_long_edge: 1024 | 2048 | 3072 | 4096; algorithm: 'nearest' | 'bilinear' | 'lanczos' };
};

interface CanvasMediaOperationResponse {
  operation_id: string;
  document: CanvasDocument;       // 已增加 versions、nodes 与 Derivation Connection 列表的新 revision
  created_version_ids: string[];
  created_node_ids: string[];
}
```

命令只接受 source node/version ID，不接受媒体路径。服务端验证 version 属于项目、kind=image、节点当前
可引用该 version；如果用户明确对历史候选操作，UI 先让该候选成为可见版本，再执行命令。

### 原子执行顺序

```text
校验 project / expected_revision / source node+version
  → 解析 version 所属文件并 sniff/decode
    → 在项目内唯一 staging 目录完成全部输出
      → 验证尺寸、总字节、摘要和 piece 数
        → 获取项目锁并再次校验 revision/source version
          → 原子移动 derived 文件
            → 原子写 Canvas Document 新 revision
              → 删除 staging，返回新文档
```

任何失败都不修改 Canvas Document。若进程恰在文件移动后、文档写入前退出，项目启动恢复逻辑根据
transaction record 完成文档提交或删除未引用的 derived 目录；它不重跑变换，也不猜用户意图。

本地工具在 viewer-server 的 bounded thread pool 执行，不能阻塞 FastAPI event loop；项目级并发上限 1，
全局上限 2。浏览器显示“处理中”，但不伪造 Job 状态。

## 节点布局与连接

- Crop/Upscale/Mask/Angle/Reverse/Video Edit：结果节点放在源节点右侧 `96px`，保持源节点中心 Y。
- Split：第一块从源节点右侧 `96px` 开始，按 row/column 排列，块间距 `16px`；节点显示比例来自真实
  piece 尺寸，不直接用源节点视觉尺寸除行列。
- 每个结果创建 Derivation Connection；其 `origin` 是 `{ kind: 'generation_run', run_id }` 或
  `{ kind: 'local_tool', operation_id }`。本地工具不伪造 Canvas Job，也不把结果边当成下次生成的隐式 Input。
- 一次 split 是一个 undo command；撤销移除整批节点与 Derivation Connection，但 Content Version 和 derived 字节
  继续作为历史保存，直到项目删除/明确 GC。
- 当前 v1 的 `resource.path` 与 `provenance` 不扩展这些能力；媒体工具作为 schema v2 Foundation 后的首个
  vertical slice 落地，避免马上删除的兼容层。

## 交互与视觉

节点 hover 工具条沿用参考项目的信息架构，但用 Atelier token：

- 工具条位于节点卡片上方、随节点移动，与标题行错开；玻璃壳 `bg-glass backdrop-blur-glass border`，
  不在 TSX 写 shadow。
- 默认快速项：信息、删除、保存资产、下载、复制提示词（有 Snapshot 才显示）、反推、替换、蒙版、
  裁剪、切图、放大、查看；窄节点折叠进“更多”。
- AI 超分不显示；多角度默认在“更多”；自由缩放按钮用锁/开锁状态表达。
- 图标按钮都有中文 `aria-label` 和 tooltip；用户可在设置里调整顺序、显隐和是否显示文字。
- Crop：默认 76% 中央选区；自由、固定、原图、1:1、4:3、16:9、9:16；拖动与八向调整。
- Split：默认 2×2，最多 12×12；支持行列数和拖动切线，内部 undo/redo 不污染画布历史。
- Upscale：1024/2048/3072/4096 长边，低于/等于源长边的目标禁用；算法显示“像素/平滑/高质量”。
- 大图对话框按真实宽高 contain，显示格式、像素、体积、来源、模型/时间；不默认下载原图到 JS 内存。

Dialog 使用现有 Radix/shadcn 组件，不引 Ant Design；字阶、层级与 `DESIGN.md` 一致。

## Pillow 处理规则

建议依赖：`Pillow>=12.3,<13`。

| 领域 | 规则 |
|---|---|
| 解码 | `Image.open()` 后立即校验 format/frame/pixels，再 `load()`；不信扩展名 |
| Orientation | 所有工具先 `ImageOps.exif_transpose()`，输出宽高即用户眼睛看到的方向 |
| Crop | 归一化坐标 clamp；四边向内/外取整保证至少 1×1；越界/空选区 422 |
| Split | 切线排序去重；相邻切线至少 16px；最多 12×12/144 块 |
| Upscale | NEAREST / BILINEAR / LANCZOS；长边最多 4096；禁止小于等于源尺寸 |
| Alpha | 有 alpha 输出 RGBA PNG；无 alpha 输出 RGB PNG；不把透明区填黑 |
| Metadata | 清除 EXIF/GPS/XMP；允许保留受限 ICC profile；不复制未知文本 chunk |
| Animated | APNG/animated WebP/GIF 不进入静态工具；明确提示先抽帧或转静态图 |
| Format | 本地工具统一输出 PNG，和参考基线一致；原始上传格式不被覆盖 |

固定上限：

- 输入解码后最多 64 megapixels；任一输出最多 64 megapixels。
- 本地放大最长边 4096；裁剪/切图不主动放大。
- split 最多 144 块，单块最短边至少 16px，整次输出未压缩估算最多 512 MiB、落盘总量最多 256 MiB。
- 单项目同一时间一个 local operation；操作超时 60 秒。
- Pillow 的 decompression bomb warning 按错误处理，并叠加上述更严格像素上限。

这些上限是产品约束，不依赖浏览器/机器偶然能承受多大 Canvas。

## Mask、角度和反推的 Job 语义

### 蒙版编辑

浏览器只生成与源图同像素尺寸的单通道 PNG mask；提交后服务端校验尺寸、alpha/灰度和非空区域，在本
Canvas Project 的 `uploads/` 中创建不可变 image Content Version，origin 为
`{ kind: 'user_mask', source_version_id }`。Generation Snapshot 用 `mask_version_id` 冻结这份 mask，并
继续把源节点 version 放在 inputs；重试从两个不可变 version 解析字节。caller capability 不支持 mask 时
入口禁用，不回退整图编辑。

mask 不经过通用 `POST .../runs`，也不允许浏览器先写一个裸路径。使用专用受控入口：

```http
POST /api/canvas/projects/{project_id}/runs/mask-edit
Content-Type: multipart/form-data
```

请求只包含 `surface_node_id`、`expected_revision`、`requested_count` 与 `mask_file`；prompt、model、provider、
源图片和其他参数仍由服务端从 Surface Draft、Input Connection 与 capability matrix 解析。服务端先把 mask
写入 transaction staging 并验证，再在项目锁内原子创建 mask Content Version、Snapshot、Job、结果占位节点
与 generation_run Derivation Connection。任一步失败都不发布 mask version 或空结果节点；事务恢复沿用
Run 的 prepared/committed 记录。原样重试继续走普通 retry endpoint，因为 Snapshot 已持有
`mask_version_id`，无需再次上传字节。

### 多角度

参考仓库的本地 `transformAngleDataUrl()` 只是缩放/倾斜预览，真实“生成另一个角度”仍应调用图像编辑
模型。本项目只实现 Job 版本：方位角、俯仰、距离和广角作为结构化参数进入 Snapshot，源图为显式 input。

### 反推提示词

反推不复用通用 `POST .../runs`，也不暂存、覆盖图片节点已有的 image Draft。hover 动作调用专用入口：

```http
POST /api/canvas/projects/{project_id}/runs/reverse-prompt
Content-Type: application/json
```

请求只包含 `surface_node_id` 与 `expected_revision`。服务端验证它是有当前 image version 的 Content Node，
从 capability matrix 解析应用级 `reverse_prompt_default_alias` 指向的多模态文本模型，并使用代码内版本化
preset `canvas.reverse_prompt.v1` 创建 `mode='text'`、单结果的 Canvas Run。preset 的完整正文、ID 和版本与
真实 model/provider/alias 一起冻结进 Snapshot；源图片 current version 是唯一 input。默认模型不存在或不支持
image understanding 时入口禁用并返回 `canvas_reverse_prompt_model_missing`。整个过程不读取或修改源节点 Draft。

Run 只创建文本结果节点；源图片→文本结果是带 Run 来源的 Derivation Connection。Job 成功后，UI 调用以 `run_id` 为幂等键的受控
`POST .../runs/{run_id}/reverse-prompt-config` 命令，服务端再原子创建图片 Generation Config Node 和文本
结果→图片配置的 Input Connection；页面重载时若发现成功 Run 尚无 config，继续显示同一恢复动作，不重复创建。

Config Draft 固定初始化为 `mode='image'`、`input_policy='mentions_only'`、
`prompt='@[node:<text_result_node_id>]'`，model/alias/params 取命令执行时通过服务端 capability matrix 校验过的
应用级图片生成默认值。若没有有效默认图片模型，命令返回 `canvas_image_default_missing`，保留文本结果并
让用户先完成模型设置。模型输出只写文本 Content Version，不允许直接改其他节点。

## 下载、替换与大图

```http
GET /api/canvas/projects/{project_id}/versions/{version_id}/media
GET /api/canvas/projects/{project_id}/versions/{version_id}/download
POST /api/canvas/projects/{project_id}/nodes/{node_id}/replace
POST /api/canvas/projects/{project_id}/versions/{version_id}/library
```

- media/download 都由 version_id 解析；download 设置安全的 `Content-Disposition: attachment` 和规范文件名。
- 响应禁止 sniff 为 HTML/SVG；媒体 MIME 固定来自服务端。
- 全部同源，不请求远端 data URL，避免 CORS 污染 Canvas。
- replace 使用 multipart + expected_revision；成功创建 upload Content Version 并切换节点，返回新文档。
- 大图预览直接把 version media URL 交给 `<img>/<video>/<audio>`；只在打开时加载，不把整文件转 base64。

## 错误与恢复

| code | 用户文案要点 |
|---|---|
| `canvas_media_revision_conflict` | 画布已变化，已保留选择；刷新后重试 |
| `canvas_media_source_missing` | 源版本或文件不存在，不创建空节点 |
| `canvas_media_decode_failed` | 文件不是受支持的静态图片或已损坏 |
| `canvas_media_too_large` | 报真实像素/体积与本工具上限 |
| `canvas_media_invalid_crop` | 选区为空/越界，请重新选择 |
| `canvas_media_invalid_split` | 切线重叠、块太小或超过 12×12 |
| `canvas_media_upscale_not_needed` | 目标长边没有大于原图 |
| `canvas_media_output_too_large` | 预计输出超出内存/落盘上限 |
| `canvas_media_capability_missing` | 当前模型不支持 mask/视频编辑 |
| `canvas_reverse_prompt_model_missing` | 未配置支持图片理解的反推文本模型 |

原始 Pillow/caller 异常只进脱敏日志；API 返回稳定 code + 中文 message，不泄露绝对路径。

## 验收矩阵

### 后端

- crop：EXIF 旋转 JPEG、透明 PNG、边界取整、1×1 拒绝、源文件 checksum 不变。
- split：2×2、非均匀切线、12×12、重复/相邻过近切线、任一块失败则 document 零写。
- upscale：三算法、比例保持、4096 cap、目标不大于原图拒绝、alpha 保留。
- sniff/limits：伪后缀、动画、多帧、decompression bomb、64MP、256MiB 总输出。
- revision/transaction：冲突 409、staging 清理、文件移动/文档提交四个崩溃点恢复。
- ownership：跨项目 version、裸 path、伪造 operation/source version 全部拒绝。

### Web

- 图片 hover 工具条只显示真实可用动作；video/audio 只有信息/下载/替换与各自派生入口。
- crop/split/upscale 对话框键盘可达、Esc 关闭、确认期间不可重复提交。
- local operation 成功后节点位置、真实比例、Derivation Connection 与选中态正确；失败不留空节点。
- split 整批一次 undo；redo 恢复同一 versions，不重新处理图片。
- 375/768 视口工具条折叠，Dialog 可滚动且确认按钮可达。
- 大图按需加载，下载文件名/MIME 正确；`1x` 与 AI 超分占位不出现。

### E01–E14 逐项行为

- E01：首次保存创建一个 Canvas Library Entry；重复保存聚焦同一条目；undo 不删除 Content Version。
- E02：image/video/audio 下载都以 version_id 鉴权，文件名与 MIME 正确，跨项目 version 返回 403。
- E03：替换创建新 upload version 并切换原节点；undo 恢复旧 version，redo 不重复上传字节。
- E04：有成功 Run 时复制 Snapshot.final_prompt；无 Run 时复制 Draft.prompt；两者都不存在时入口隐藏。
- E05：专用反推 Run 冻结 `canvas.reverse_prompt.v1`、文本模型与源图片且不改变源 Draft；成功创建文本节点
  与一条 generation_run Derivation Connection；随后幂等 config command 创建初始化 Draft、配置节点与一条
  Input Connection。断线/重试不重复创建；缺反推模型时不创建 Run，缺图片默认模型时保留文本结果。
- E06：mask version 与源图尺寸一致且非空；Snapshot 冻结 source/mask version；original retry 精确复用。
- E07：裁剪结果尺寸、位置、local_tool origin 与一条 Derivation Connection 正确。
- E08：切图块数、row/column、网格布局、同 operation_id 与整批 undo/redo 正确。
- E09：三种重采样、长边/比例/alpha 与“不恢复细节”文案正确。
- E10：角度参数和源 version 进入 Snapshot，结果只有 generation_run Derivation Connection。
- E11：大图/详情按需读取 version media，不生成 base64/blob 副本。
- E12：工具顺序、显隐、文字偏好写应用级配置，切项目仍生效且不污染项目包。
- E13：AI 超分入口不存在。
- E14：视频编辑以源 video version + prompt 创建新 Run/节点，失败保留源视频且不产生空结果。

### 性能

- 24MP JPEG crop P95 < 2s，2×2 split P95 < 4s，4096 长边 upscale P95 < 8s（开发机基线）。
- 操作期间 React Flow 平移/选择不被主线程图片编码阻塞。
- 150 节点画布不预取所有原图或生成 150 个 blob/data URL。

## 实施顺序

1. **Foundation**：先落 schema v2 Content Version、Derivation Connection、revision/lock 与 version media API；删除 v1。
2. **Read-only tools**：hover toolbar、大图/信息、version download、复制 prompt。
3. **Ownership tools**：replace、保存资产、自由缩放偏好。
4. **Local operation**：引入 Pillow 12.3，先 crop，再 split，再 upscale，共用 media operation command。
5. **AI tools**：mask Job、角度 Job、反推提示词、视频编辑。
6. **Closeout**：快捷工具偏好、窄屏、性能/内存、故障恢复和与参考基线并排验收。

每一步必须在一个可工作的产品上增加能力；不先搭一套未接节点/版本的“大而全图片编辑器”。

## 需要确认

采用方案 A，并同意：

1. 新增服务端依赖 `Pillow>=12.3,<13`，不增加前端图像库。
2. 裁剪/切图/本地放大最终由服务端执行，浏览器只做交互预览。
3. 媒体工具不扩展当前 v1；先完成 schema v2 Foundation，再按上述顺序进入工具实现。
4. 本地放大明确叫“放大/重采样”，AI 超分继续排除。
