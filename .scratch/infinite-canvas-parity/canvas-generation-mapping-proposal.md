# Canvas 生成能力、Job 与状态映射

Status: ready-for-agent

## 结论摘要

推荐把 Canvas 的文本、图片、视频、音频统一建模为四种 `JobKind`，全部从服务端解析
Generation Snapshot 后进入现有 `job_runner.run_job()`；每个 caller 只负责协议传输与规范化结果，不让
浏览器接触密钥或直连模型。一个 Canvas Job 对应一个 Run，批量结果是该 Job 内的 candidate 集合。

## Decision

2026-08-23 用户确认推荐方案 A：节点 chrome 不恢复常驻“1x”，但图片/文本设置弹窗支持按模型真实
能力裁剪的批量候选，默认 1；视频/音频保持单结果。四模态全部统一进入 Job Runner，自定义模型调用
只能走后续受控的服务端 Caller Adapter。

需要新增：

- `JobKind = text | image | video | audio`。
- text/audio caller registry；现有 image/video caller 原样接入统一 outcome 接口。
- `ModelSpec.modality` 扩为四类，并由服务端输出完整 capability descriptor。
- Canvas Job 的 Snapshot、candidate、取消请求与部分成功语义。
- Canvas 专用 run submit/retry/cancel API；删除 Canvas 任意 prompt/path 的旧 `/jobs` 提交入口。
- SSE 的 Canvas Run 状态与文本流式增量；断线后以 Job/Content Version 文件真源恢复。

不新增第二个执行器，不复用 Character/UI/Video Skill，也不执行参考项目那种拿到明文 API key 的浏览器
任意脚本。

## 核对结果

### 参考基线

| 能力 | 固定基线行为 |
|---|---|
| 文本 | OpenAI Responses/Gemini/自定义脚本，支持流式、reasoning effort、1–15 个结果 |
| 图片 | generations/edit 两条路径，参考图、mask、透明背景、尺寸、质量、1–15 个结果 |
| 视频 | 创建异步任务后轮询，参考图、时长、尺寸、质量、生成音频、水印 |
| 音频 | OpenAI-compatible `/audio/speech` 或自定义脚本，voice/format/speed/instructions |
| 停止 | AbortController 停止当前浏览器请求，已完成候选保留 |
| 重试 | 从节点保存的 metadata 恢复 prompt/model/params/references；缺引用明确失败 |
| 自定义调用 | 浏览器 `AsyncFunction` 获得 raw API key、任意 URL/method/headers/body |

### game-atelier 当前能力

| 能力 | 当前事实 | 缺口 |
|---|---|---|
| 图片 | `dispatch` + 多 image caller；`n` 1–4；图片能力矩阵较完整 | 无 candidate 级失败；Snapshot 尚不存在 |
| 图片编辑 | `reference_images` 已按模型族路由 edits/generations | 无 mask 一等字段；Canvas 当前根本不传连接 refs |
| 视频 | `dispatch_video` + seedance/kling/dashscope/openrouter；轮询恢复较成熟 | Job 只支持单一终态；取消无法传进 poll loop |
| 文本 | 没有 text Job/caller | 需新增 registry、流式与 Content Version |
| 音频 | 只可作为视频参考/伴音参数，没有 audio Job/caller | 需新增 TTS registry、验证与输出目录 |
| ModelSpec | Python 只允许 image/video；前端设置已出现 audio/llm 文案 | 双端 schema 已漂移 |
| JobStatus | pending_confirm/pending/done/failed | 无 canceled/partial/cancel request |
| SSE | watcher 只广播 `job_id/status`，断线会全量刷新 | 无 candidate、run revision、文本 delta |
| Cancel | 未提交删除；pending 60 分钟后才标失败 | 无运行中协作取消，且“失败”混淆“用户停止” |
| 自定义脚本 | 无 | 不能照搬浏览器明文密钥 + 任意网络执行 |

## 生成动作映射表

| 参考动作 | mode / JobKind | 本项目 protocol/caller | Snapshot input | output |
|---|---|---|---|---|
| 文本续写/改写 | `text` | 新 `dispatch_text` registry | text/media refs 按模型 capability | Text Content Version candidates |
| 文本节点一键生图 | `image` | 现有 `dispatch` | 当前文本版本 + 已连接/mention refs | Image candidates |
| 文生图 | `image` | openai/ark/openrouter/MJ 等现有 caller | final prompt | Image candidates |
| 参考图生图/编辑 | `image` | 现有 caller 自动选 edits/generations | image versions，顺序冻结 | Image candidates |
| mask 局部编辑 | `image` | caller capability `supports_mask` | base image + mask version | Image candidates |
| 文本/图片驱动视频 | `video` | 现有 `dispatch_video` registry | text/image/video/audio versions | Video candidate |
| 视频派生编辑 | `video` | model protocol capability | source video + 其他 refs | Video candidate |
| 文本转语音 | `audio` | 新 `dispatch_audio` registry | final text；默认不接受媒体 refs | Audio candidate |
| 反推提示词 | `text` | multimodal text caller | image version | Text result + UI 创建配置节点 |
| 插件 AI 请求 | 对应四类 | host 创建普通 Canvas Run | 插件被授权的 node/version | 普通 Job/candidate |

任何 action 都不能把路径、provider 或原始参数直接从浏览器塞进 Job：run endpoint 只收
`surface_node_id / expected_revision / requested_count`，服务端读取 Draft、解析 Input Connection 和 `@`
token、查询模型 capability、冻结 Snapshot 后才构造 JobParams。

## Model Capability v2

当前“图片 JSON fixture + 前端视频函数 + Key modalities”分散判定无法支撑四模态。推荐服务端成为能力
描述真源，前端只渲染；现有图片 fixture 继续作为协议回归数据，不再让 UI 自行猜完整能力。

```ts
type ModelModality = 'text' | 'image' | 'video' | 'audio';

interface ModelCapability {
  alias: string;
  provider: string;
  model: string;
  modality: ModelModality;
  protocol: string;
  controls: Record<string, JsonValue>;
  inputs: {
    text: number;
    image: number;
    video: number;
    audio: number;
    mask: boolean;
  };
  output_count: { min: number; max: number };
  supports_streaming: boolean;
  supports_cancel: boolean;
  timeout_seconds: number;
}
```

能力解析顺序：模型显式 protocol/capability → 已测试 registry → 保守协议默认；未知字段不显示，禁止
“界面有控件、后端静默丢参数”。provider 只决定传输，模型/协议决定能力。

### 现有能力保留

- 图片继续使用已实测的 family、参考图上限、quality、像素上下限与 MJ 参数规则。
- 视频继续使用 `videoControlCaps` 对应的 seedance/kling/happyhorse/openrouter 规则；实现时把同义 Python
  descriptor 变成服务端输出并用共享 fixture 防漂移。
- `warnings/actual_size/mj_flags` 是执行结果 metadata，不进入不可变 Snapshot 的 normalized params。
- Ark/国内聚合商继续走 `NO_PROXY`；图片瞬时 502/503/504 重试和视频 90 秒网络抖动容忍保持不变。

### 新 text protocol

| protocol | endpoint | streaming | params |
|---|---|---:|---|
| `openai-responses` | `/responses` | 是 | system, reasoning effort, multimodal input |
| `openai-chat` | `/chat/completions` | 是 | messages, multimodal input |
| `gemini-content` | Gemini generateContent/stream | 是 | contents, generation config |

首版只实现已有 Key 明确声明的 protocol，不根据模型名偷偷选。text output count > 1 时是一个 Job 中 N 个
独立 candidate 调用，不把模型一次返回的多段文本误当多候选。

### 新 audio protocol

| protocol | endpoint | params | output |
|---|---|---|---|
| `openai-speech` | `/audio/speech` | voice, format, speed, instructions | mp3/wav/m4a/ogg |

首版不承诺音乐生成、克隆音色或 ASR；参考项目基线的 Canvas audio generation 实际也是 TTS。响应必须
sniff 为音频，JSON 错误不能以 `.mp3` 落盘。

## Job / Snapshot / Candidate 状态

### Job schema 变化

```ts
type JobKind = 'text' | 'image' | 'video' | 'audio';
type JobStatus =
  | 'pending_confirm'
  | 'pending'
  | 'done'
  | 'partial'
  | 'failed'
  | 'canceled';

interface Job {
  // existing fields...
  cancel_requested_at?: string | null;
  canvas_run?: CanvasJobContext | null;
}
```

`pending + cancel_requested_at != null` 派生为 UI“正在停止”，不再增加 `canceling` 持久化枚举。
`completed_at` 在 done/partial/failed/canceled 时写入。

### Candidate 汇总规则

| candidates | JobStatus |
|---|---|
| 全 succeeded | `done` |
| 至少一项 succeeded，另有 failed/canceled | `partial` |
| 全 failed | `failed` |
| 无 succeeded 且至少一项 canceled、无 failed | `canceled` |
| 仍有 pending | `pending` |

每个 candidate 独立写 `pending/succeeded/failed/canceled`、version ID 与友好错误；一个失败不删除其他成功
结果。primary 默认第一个成功项，切换 primary 不改 Job 或 Snapshot。

### 文本流式

- caller 产出带单调 `sequence` 的 delta。
- 服务端广播 `canvas-run-delta {project_id, run_id, candidate_id, sequence, delta}`。
- 每 1 秒或每 4 KiB 把候选累计预览节流写回 Job；重连 GET Job 可以恢复到最近 checkpoint。
- 完成后创建不可变 Text Content Version，并清掉可变 preview。
- SSE delta 只是低延迟通道，Job 文件仍是状态真源；乱序/重复 sequence 被前端丢弃。

## 批量结果与历史“1x”冲突

参考基线支持图片/文本 1–15 个结果，已确认矩阵 D17/D19 也把批量候选纳入；但此前用户明确要求删除
“1x”及数量功能。推荐把最新 131 项确认解释为规则演化，同时保留此前的视觉反馈：

- 节点 chrome、浮层底栏不常驻显示“1x”。
- 数量只在图片/文本设置 popover 中出现；默认 1。
- UI 上限取 `ModelCapability.output_count.max`，不假装所有模型都支持 15。
- 当前已验证图片 caller 先保持最大 4；未来 registry 验证某模型/协议后才能放宽。
- 不支持原生 batch 的协议，由一个 Job 管理 N 个 candidate 调用；用户提交前明确提示“将按 N 次调用计费”。
- text candidate 最大并发 4，image 最大并发 2；同 alias 仍受总并发限制。
- video/audio 基线按一次一个结果，不显示数量。

这既实现批量功能，也不会把此前被否决的“1x”常驻控件重新塞回节点。

## 重试语义

### 按原设置重试

`POST runs/{run_id}/retry {mode: "original", candidate_id?}`：

- 复制原 Snapshot 的 final prompt、provider/model/alias、normalized params 和精确 version IDs。
- 所有引用先做存在性与 hash 校验；缺失即 409 `snapshot_input_missing`，不回退当前节点。
- 新建 Job/Run，`retry_of` 指原 Job；result node 复用原节点。
- 单 candidate 重试时 requested count=1，并记录 `replaces_candidate_id`；成功后替换该展示槽但保留旧
  candidate/Job 历史。
- source→result 已有 Derivation 时不造重复边；新 Snapshot 自己记录真实 Run。

### 使用当前设置再次生成

`mode: "current"` 重新读取 Draft/连接/mentions，产生新 Snapshot；它不是 retry_of，也不复用旧输入。
UI 文案必须把两者分开。

## 停止与取消

参考项目的 AbortController 不能保证上游停止或不计费；本项目要诚实表达：

1. `POST runs/{run_id}/cancel` 只写 `cancel_requested_at`，不立即伪造 canceled。
2. runner 在 candidate 间、上传前后、轮询间隔和下载前检查取消。
3. 异步 protocol 有官方 cancel endpoint 时调用并记录返回；没有时停止继续轮询/启动新 candidate。
4. 同步图片/音频/文本请求已发出后通常无法中断；UI 显示“已请求停止，上游可能继续执行并计费”。
5. 请求返回的有效产物仍落盘，已成功候选保留；剩余候选 canceled，汇总为 partial/done/canceled。
6. 取消不是失败，不能再复用当前 `/jobs/{id}/cancel` 的“超时后标 failed”语义。

## 自定义模型调用脚本

参考项目 D23 允许浏览器脚本直接获得 `apiKey`、任意构造 URL/header/body 并发起网络请求。该实现和已
排除的插件直读密钥属于同一安全问题，不能照搬。

推荐适配为第 07 关的 server-side `Caller Adapter`：

- adapter manifest 声明 modality、参数 schema、允许的目标 origin、超时与输出规范化器。
- adapter 只拿 credential handle，不读取明文 key；网络由 host proxy 注入凭证。
- 任意代码 adapter 必须安装、授权并在隔离 worker 运行，不能读 data root/env，也不能启动子进程。
- 输出先经 MIME/大小/schema 校验，再交回统一 Job Runner。
- 未完成 sandbox 前只提供内建/审计过的 adapter，不开放“粘贴 JS 立即运行”的假等价实现。

用户可观察能力仍是“为一个模型配置自定义调用”，安全实现由第 07 关裁定；它不会成为绕开 Job Runner
的第五种执行入口。

## 并发、成本与超时

### 调度

不替换 Job Runner，只在 server 外围增加 Canvas scheduler：

- 全局最多 4 个 active candidate；同 alias 最多 2 个；视频最多 1 个。
- 每个 Job 内 text 最多 4 并发、image 最多 2；视频/audio 顺序执行。
- scheduler 通过 Job lock 领取任务；server 重启扫描 pending Canvas Job，避免 BackgroundTasks 丢任务。
- Agent/plugin 与用户共用同一队列/配额，不得另开后台直连。

首版阈值是本地稳定性上限，后续只允许基于实测调整；排队不计入 provider timeout。

### 成本提示

- submit 前显示 model、候选数、视频时长/分辨率和“预计调用次数”。
- provider 有可靠价格表时显示估算区间；没有时明确“价格未知”，不猜数字。
- timeout/取消明确提示“任务可能已计费”；保留 task_id 便于厂商后台找回。
- Agent/plugin 触发的付费 Run 必须通过其权限/审批规则，第 06/07 关细化。

### timeout 默认

| modality | 默认策略 |
|---|---|
| image | 保留 connect 30s / read 300s；同步 read timeout 不自动重跑整次生成 |
| text | connect 30s；stream idle 60s；总 300s |
| audio | connect 30s / read 300s |
| video | 保留各 protocol 10–45 分钟轮询窗口与 90s 网络抖动容忍 |
| custom adapter | manifest 声明，host 上限 30 分钟 |

## 错误模型

Candidate error 保存结构化字段：

```ts
interface CanvasCandidateError {
  code: string;
  message: string;          // 画师可见中文
  retryable: boolean;
  billing_uncertain: boolean;
  provider_task_id: string | null;
  diagnostic_id: string;
}
```

原始异常进入本地日志并做密钥/Authorization/URL query 脱敏，不直接写 Canvas Document。现有
`_friendly_error` 扩充 context length、voice/format、内容审核、snapshot missing、取消与 partial；任何
带 task ID 的错误仍必须保留找回钩子。

## API 与 SSE

| endpoint/event | 行为 |
|---|---|
| `GET /canvas/model-capabilities` | 返回当前 Key 下四模态模型与控件 descriptor，不含密钥 |
| `POST /canvas/projects/{id}/runs` | surface + revision + count；服务端解析、冻结、排队 |
| `POST .../runs/{run_id}/retry` | original/current；可指定 candidate |
| `POST .../runs/{run_id}/cancel` | 幂等写 cancel request |
| `GET .../runs` | 项目 Run/Job 历史 |
| `GET .../runs/{run_id}` | 单 Run、Snapshot、candidate、checkpoint |
| `job-changed` | 保留，payload 补 project/run revision |
| `canvas-run-delta` | 文本流式 delta |
| `canvas-document-changed` | 结果节点/Content Version revision 更新 |

所有 SSE 都允许丢事件；客户端连接/重连后必须 GET document + active runs 对账。

## 新增 caller/protocol 清单

| 项 | 结论 |
|---|---|
| `dispatch_text` + registry | 新增，首版 openai-responses/openai-chat/gemini-content |
| `dispatch_audio` + registry | 新增，首版 openai-speech |
| image caller | 保留；改为 structured candidate outcome、cancel check、mask capability |
| video caller | 保留；poll helper 增加 cancel callback/官方 cancel hook |
| custom caller adapter | 设计进入第 07 关；sandbox 前不开放任意代码 |
| browser direct API | 删除/禁止 |

## 回归测试方案

### schema/capability

- Python/TS 四模态 ModelSpec、JobKind、JobStatus、Snapshot/candidate fixture 同步。
- image/video 现有能力矩阵逐条不退化；未知 model/protocol 只显示保守控件。
- alias/provider/model 解析后再冻结 Snapshot；客户端伪造 provider/path 被拒绝。

### runner

- 四模态 success/all fail/partial/canceled；candidate 顺序稳定。
- 文本 delta 顺序、节流 checkpoint、SSE 重连对账。
- batch 并发上限、同 alias/global/video semaphore 与 server restart 领取。
- 同步调用 cancel 后返回产物仍保留；异步 cancel task ID 保留。
- original retry 精确版本；current regenerate 重新解析；缺版本明确失败。

### caller/security

- text/audio payload、MIME、timeout、内容审核与错误翻译。
- video poll 网络抖动行为不退化；取消不吃掉 task ID。
- 自定义 adapter 不能读 env/data root/明文 key，不能访问未授权 origin。
- 所有日志和 API payload 无 access_key/Authorization。

## 待确认

采用方案 A，并将此前“删除 1x/数量功能”演化为：**不显示常驻 1x，但在图片/文本设置中支持按模型
上限的批量候选**。确认后接受 ADR-0009，关闭第 04 关并进入第 05 关资产/提示词/项目包/WebDAV。
