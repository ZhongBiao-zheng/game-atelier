# 工坊 MCP 与生成批准契约

> 本地整合已实现工具、人工批准、原 Runner 执行与保守恢复，正在验收。画布工具见[画布 MCP](canvas-mcp.md)。外部工具协议为 `atelier-workshop/1`；不改变
> [ADR-0011](../adr/0011-restrict-canvas-agent-to-approved-change-sets.md) 的画布 Agent 权限。

## 范围

让用户在 Codex / Claude 使用已有 Character、Promo、Turnaround、UI、Video 工作流 Skill，
通过 MCP 取得上下文、维护工作流文档、准备生成、等待批准和读取结果。MCP 不负责推理，Skill 不负责鉴权。
所有对象仍属于原有 Project / Character / UI Scheme / Video Production，产物继续进入现有工坊。

不暴露创建 / 删除整个项目、Canvas、Studio 生成、定稿、删除产物、写 Key、任意路径读写、shell、
安装 Skill 或任意 URL 下载工具。跨项目复制或创作资产库使用必须日后单独定义授权，首版不提供通用逃生口。
现有用户手动操作保持原入口，不能为了 MCP 重定义正式资产模型。

## MCP 进程与授权

采用官方 Python SDK 的 stdio server，入口 `python -m character_workflow.mcp --credentials <file>`。
这个入口是协议适配器，不是第二个 viewer-server；stdout 只输出 MCP JSON-RPC，诊断去 stderr，
不调用会把安装进度或出图卡片写到 stdout 的 bootstrap / CLI 分支。
用户已于 2026-08-31 同意新增官方 SDK。运行依赖为 `mcp>=2.1.1,<3`，当前锁定 2.1.1；
回归包含 SDK 客户端真实启动 Atelier stdio、连接真实本机 HTTP、项目授权、文档冲突和撤销；
不等于已经验收所有 Codex / Claude 客户端版本，具体限制见[本机客户端说明](../mcp-local-client.md)。
不引入 SDK 的开发 CLI extra 或新的 Node 服务，只使用已需要的服务端协议能力。

用户先在本地管理页选择允许访问的项目，以及 `read`、`edit_documents`、`create_targets`、
`prepare_generation` 能力。新增 Agent 授权只能由该页创建，生成一个 OS 权限保护的凭据文件；
MCP 配置只含固定解释器、模块和凭据文件位置，不含明文 token / API Key。
文件在 data root 的私有配置子目录，POSIX 使用 0600，Windows 核验当前用户 ACL，不能以 chmod 成功当作 ACL 已验证。
服务端保存凭据摘要，撤销 / 到期后拒绝后续调用；凭据不会因知道 project_id 就扩大权限。

MCP 启动只读取自身的连接凭据，不扫描用户目录或更改 Agent 配置。服务未启动时返回明确的本机启动指引，
不私自重启或新建不同 data root。连接须核对实例及协议，不使用系统代理或跟随 HTTP 重定向。
服务重启需重新建立运行时工具会话；持久授权仍须未撤销且在有效期内，不能用过期 session ID 当授权。

管理端点 `POST /api/connection/agent-grants` 接受 `{ name, project_ids, capabilities, days?: 7 }`，
默认有效期 7 天、最长 30 天；返回名称和本机凭据文件位置，原始秘密不经网站或工具返回。
`POST /api/connection/agent-sessions` 用该凭据换取最长 2 小时且不超过 grant 到期时间的运行会话。
`DELETE /api/connection/agent-grants/{id}` 同时撤销派生会话并关闭连接。
Agent 自报的 client 名称只供显示，不作为权限证明；HTTP 请求无 Origin 时仍必须提供工具身份。

**限制边界**：MCP 能约束本工具服务，不能防止外部 Agent 利用宿主另外授予的文件或 shell 权限。
安装说明必须提示不要给 Agent 无关文件访问权，不能宣称接了 MCP 后整个 Codex / Claude 自动进入沙箱。

## 显式目标与上下文

每个请求携带 `project_id` 和适用的目标 ID；不能在提交时重读 `active-character.json`，
避免用户切换角色后任务落到另一个对象。创建目标时由服务端生成稳定 ID，名字只是显示值。

```ts
type WorkshopTarget =
  | { type: 'project'; project_id: string }
  | { type: 'ui_scheme'; project_id: string; ui_scheme_id: string }
  | { type: 'character'; project_id: string; character_id: string;
      asset_slot: 'portrait' | 'promo' | 'turnaround' }
  | { type: 'ui'; project_id: string; ui_scheme_id: string; screen_id: string }
  | { type: 'video'; project_id: string; production_id: string }
```

project / ui_scheme 只用于文档与上下文，不能 prepare 生成；新项目可直接维护三锚，不要求先造占位角色或页面。
所有 ID 在服务端解析并检查归属；字符形状正确不代表有权限。工坊首版只接受归属明确项目的角色，
已有项目外临时角色可在原界面归入项目后使用；不自动替用户创建项目或搬动文件。

上下文按目标返回项目基线、适用世界观 / style / spec、工作流文档、反馈与当前定稿引用。
反馈消费必须绑定目标、可重试且不把另一角色反馈挪走。读取动作默认不移动反馈文件，
单独的 acknowledge 工具只确认本轮确实处理过的 feedback ID。
大文档返回修订与截断标识，支持按枚举文档读取；不能悄悄截断后拿残文覆盖原文。

## 工具表

所有工具使用 Pydantic `extra="forbid"` 的专用输入模型；不能把宽松的 `JobParams(extra="allow")`
原样当外部工具参数。模型、协议与参考能力由现有 provider registry / caller 校验复用，不靠名字猜测。

| 工具 | 输入与结果 | 所需能力 / 副作用 |
| --- | --- | --- |
| `workshop_list_projects` | 分页返回授权项目的 ID / 名称，不列未授权项目 | read；只读 |
| `workshop_list_targets` | project、类型过滤、分页 → 已有角色 / UI 页面 / 视频企划的名称与稳定 target | read；只列当前授权项目，支持按名字继续已有创作 |
| `workshop_get_context` | project / target → 基线、文档修订、反馈 ID、目标资产引用 | read；只读 |
| `workshop_list_models` | target → 已配置 alias、可用 model、参数 / 参考能力、可核实价格 | read；不含 Key / 任意 base_url |
| `workshop_create_target` | project、类型、名字、必要父 ID、幂等键 → target | create_targets；新建角色 / UI 方案或页面 / 视频企划 |
| `workshop_read_document` | target、document kind → 内容、revision | read；仅白名单文档 |
| `workshop_write_document` | target、kind、expected_revision、完整内容、幂等键 → revision | edit_documents；冲突拒绝；不修改定稿或 Job |
| `workshop_acknowledge_feedback` | target、feedback_ids、幂等键 → 已处理 ID | edit_documents；只消费该目标反馈 |
| `workshop_list_media` | target、分页 → 当前目标登记的媒体 ID / 类型 / 标题 | read；不递归列出目录 |
| `workshop_read_media` | media_id → 有界图片预览 / 元数据，或受控 MCP resource URI | read；复核授权；不直接返回绝对文件路径 |
| `workshop_prepare_generation` | target、prompt、alias、model、typed params、media refs、幂等键 → request | prepare_generation；落准备记录，不调用供应商 |
| `workshop_get_generation` | request_id → 批准状态、Job 摘要、产物引用 | read；只读；不无限阻塞或私自重试 |
| `workshop_withdraw_generation` | request_id、expected_revision → 已撤回 / 已开始不可撤回 | prepare_generation；仅撤回尚未执行的自身请求 |
| `workshop_approve_generation` | request_id、expected_revision → approved + Job | execute_generation；仅批准自身请求，用户在对话中明确肯定后调用 |
| `workshop_read_lessons` | target → workspace / project 两层经验（按资产槽位） | read；只读 |
| `workshop_list_prompt_assets` | tags?、query?、project_id?、limit → 提示词资产索引（id / 标题 / 标签 / 最近使用 / 有无推荐配置）+ 全库 `tag_facets` | read 或 canvas_read；只读；不带正文，任务明确后调一次 |
| `workshop_read_prompt_asset` | asset_id、project_id? → segments、variables、按默认值渲染的 prompt、可选 `recommendation`（mode / model id / 白名单 params） | read 或 canvas_read；记一次使用并关联项目 |
| `workshop_append_lesson` | target、scope、line?、distilled_media_ids、幂等键 → 写入位置 | edit_documents；line 省略时只标记证据图已处理 |

`tools/list` 的注解用于说明副作用，不承担权限验证。内部 HTTP 对应同名语义的 `/api/workshop/...`
端点，不能提供 `/execute-command` 或任意 `method/path/body` 的工具。
MCP resources 同样按会话与对象鉴权；大视频不在文本工具响应塞 base64，返回类型、时长、尺寸及
可在本机确认页面打开的资源引用。限制并发、分页、返回体和预览像素，避免一个工具拉完整作品库。

当前工具使用 `{ payload: <专用输入模型> }`，HTTP 工具请求体最多 1 MiB、只接受 JSON；
适配器最多同时处理 4 个调用，响应最大 1 MiB。`get_generation.output_media_ids` 精确指向本次 Job 产物，
不通过名称或“最新文件”猜结果。Agent 看到的失败摘要去除本机路径及原始供应商错误。
`list_models.capabilities` 只提供已核实的 count / quality / fixed_quality / duration 约束；
未知 size / ratio / resolution 为 null，并附 capability_basis，不把未知值宣称为支持。
输入参考硬上限在 `request_limits.max_references` 中返回，实际仍由模型适配器校验。

允许的 document kind 按已有工作流逐个登记：项目基线 / 设计锚、角色 spec、UI 方案 style / screen map、
视频 brief / 制作说明。每项必须在实现时对应现有路径解析器和 schema，禁止由传入 kind 拼成任意文件名。
修改创建索引或镜头结构时调用已有领域操作，不把 `.runtime/*.json` 或任意 Markdown 路径开放为“文档”。

第一条验收切片是角色 portrait：读 context → 更新 spec → 准备 → Web 批准 → 得到 Job 和图片。
再覆盖 promo / turnaround、UI、视频。本地回归覆盖这些目标的准备、批准与 fake provider 落盘；
真实付费调用不属于自动验收。

## 生成请求、批准与执行

### 两种记录的所有权

- **Workshop Generation Request**：服务端写 `.runtime/workshop/requests/<request_id>.json`，保存调用身份、
  目标、规范化输入快照、修订、幂等摘要、人工批准记录与执行声明。不是另一个媒体 Job 或另一份计费账。
- **Job**：继续由现有 jobs helpers / runner 写 `.runtime/jobs/<job_id>.json`；拥有执行状态、厂商 task ID、
  实际费用、错误和产物。每个 request 至多绑定一个 Job；工具展示执行状态时从该 Job 派生。

请求生命周期仅 `awaiting_approval | approved | withdrawn | expired`；执行是否成功只看 Job，
不要再维护一套可能与 Job 冲突的 DONE / FAILED。执行声明单独区分未派发、已声明调用、已持久化厂商 ID、
需人工核对。JSON 写入必须复用 per-record 文件锁与 atomic_io；跨记录步骤采用带固定 Job ID 的可恢复提交。

### 准备

`prepare` 验证项目 / 目标 / 模型 / 参考类型，复用能力归一化并冻结 prompt、参数、引用内容、价格说明。
引用只能来自授权目标的登记媒体或用户已正式上传并授权的资源；拒绝 HTTP URL、`file://`、绝对路径、
目录遍历和跨项目 ID。可变源文件在准备时复制成请求拥有的不可变输入并记录摘要，不能只记路径后任它变化。
UI 页面可发现同项目、同方案内其他页面的定稿图片（不含那些页面的全部历史图），
返回 `source_screen_id`、`is_canonical`、`style_stale`，并生成当前目标作用域的 media ID；
延展页可明确选择基准页，跨方案或跨项目的 media ID 仍拒绝。
检查被授权内容的真实路径和符号链接；复制期间内容改变则重试读取或失败，不产出混合快照。

结果含 `request_id`、`revision`、`state`、目标 / 模型 / 输入摘要、
`estimated_cost_cny: number | null`、价格依据与待批准页面位置。没有可核实价格就显示“费用待确认”，
不写 0 或猜价格。卡片明确指出哪些参考素材将发送给哪家供应商。

准备记录默认 24 小时失效；失效不能继续批准。用户修改已准备的 prompt / model / params / refs
需新建请求并重新批准，不修改冻结快照。MCP 连续调用 prepare 不等于连续同意付费。

### 批准

本地 / 网站页面调用 `POST /api/workshop/requests/{id}/approve`，请求 `{ expected_revision }`。
Agent 会话调用 `workshop_approve_generation`，仅当其授权含 `execute_generation` 且请求由自己准备时通过，
服务端记录 `approved_by = grant_id`（ADR-0017）；否则返回 `CAPABILITY_DENIED`。批准入口检查有效编辑会话、归属、
快照与当前调用配置的指纹，防止确认前 alias 被改成另一供应商或参数能力发生变化。

批准与冻结 Job 绑定在一次可恢复事务中：持锁重读→核验未撤回 / 未到期 / 修订未变→
登记批准来源与时间→用固定 Job ID 写 `PENDING` Job→提交执行队列。双击批准返回同一 Job，
绝不能先启动工作线程再写批准或 Job。执行器在实际提交前再次校验声明，持 `job_execution_lock`，
释放元数据锁后才等待网络，不能长时间占用项目文件锁。

批准本次请求仅允许该冻结调用，不授予下一轮、重试、额外数量或跨项目权限。
浏览器退出后已批准任务继续；撤销工具会话会阻止它的新调用、使其待批准请求不可批准，
但不假装能撤回已送往供应商的计费请求。运行中停止能力仍按供应商实际支持处理。

### 幂等与恢复

`idempotency_key` 按 Agent grant + 操作 + 目标作用域保存，内容摘要包含规范化参数和引用内容摘要。
同键同内容返回原结果；同键不同内容 `IDEMPOTENCY_CONFLICT`。服务端生成 request / job ID；
不能信任工具自报 Job ID，更不能以重试工具调用绕过原快照。

执行声明必须先于网络发送落盘。启动恢复扫描自己的工坊记录，不把 Canvas / Studio Job 收进另一条队列：

| 中断位置 | 恢复行为 |
| --- | --- |
| 未批准 | 保持等待，不调用供应商 |
| 已批准事务未完成、尚未声明调用 | 用固定 ID 补全记录；确认不存在执行者后调度一次 |
| 已声明调用且已保存 provider task ID | 仅对支持恢复的协议续查原 task，不重提 |
| 已声明调用但无法判定上游是否收到 | 标记需人工核对，禁止自动重新出图或假称零费用 |
| 已有有效产物 / 终态 Job | 完成记录对齐，不重新生成 |

使用现有 caller 的供应商 ID 持久化逻辑；协议不能恢复时如实中断。
“重试”始终是新请求、新批准、新 Job，保留旧 Job 错误与血缘；不能因为结果不明自动退回 prepare 再跑。
不许把原图当失败重试结果写入。付费安全依赖幂等、锁与保守恢复，不宣称跨供应商 exactly-once。

## 与现有入口的收敛

`run_job` 接受 `PENDING_CONFIRM`（CLI 路径，终端确认即批准）与 `PENDING`，带 `workshop_request_id` 的 Job 还要有匹配的已批准请求；
不能只是把状态改成 PENDING 就绕过批准。Studio / Canvas 保留自己的已有人工提交授权和 runner 调度，
不能误用工坊批准记录覆盖它们。

现有 `submit` / `submit-screen` / `submit-video` 与 `run-job` / `run-latest`、Web 的 confirm、
重试分支、Skill 中的执行说明都在 P3/P4 同步更新。废弃的直接执行待确认 Job 路径删除，
不做新旧并行或失败后退回直调 caller。老的未确认工坊草稿不能自动获批准；UI 明示重新准备，
已有历史 Job 只读，不回填伪造批准，不批量改用户记录。

Job schema 如需新增归属或声明字段，Python / TypeScript / API 契约一起改；不借用目前
仅 Canvas 可用的 `runner_started_at` 字段。规范化模型与参考参数不在 CLI、HTTP、MCP 三处复制。

## Skill 集成与客户端交付

先建立可调用工具再更新 Skill：读原 SKILL 全文及其引用，保留原创作流程、项目基线、人工反馈、
归档位置和费用说明，替换实际读写 / 准备 / 状态查询动作，不新造同名 Skill 副本。
MCP 模式不需要整个 data root 文件权限；没有项目授权时先给授权指引，不能偷偷改用 shell。
注册 MCP 不等于客户端已加载 Skill；安装说明分别检查工具可见与 Skill 可见。

Codex / Claude 使用各自支持的 stdio 配置形式；示例使用占位路径与环境变量，不提交本机账户路径或密钥。
用户自行确认配置或明确授权安装后才修改全局客户端配置。测试在独立临时配置目录进行，
不更改当前 Agent 的登录、模型、全局工具或 Skill 安装。客户端拒绝工具权限时正常退出，不诱导全局放权。

## 验收清单

- SDK 客户端真实启动 stdio 进程并 initialize / list / call，stdout 无额外日志；无效参数只返回结构化错误。
- 同一 grant 只列授权项目，所有 read / write / media / resource / job 均复核归属；枚举 ID 不泄露其它项目。
- 未批准 prepare 调用次数任意增加，fake provider 的调用计数仍为 0；伪造 `confirmed`、直接调用 approve、
  修改 Job 状态、撤回 / 批准竞争与两进程执行均不能绕过或重复调用。
- 文档保存检查 expected_revision；MCP 和 Web 并发编辑得到冲突而非覆盖，读取截断内容不能当完整文档写回。
- 同幂等键重放只返回旧请求 / Job；不同内容冲突；重启后不丢幂等账和输入快照。
- 强制中断覆盖批准事务各步、发送前后、provider ID 落盘、下载、产物落盘；核实恢复行为与上表一致。
- 角色 / UI / 视频各跑通 fake provider 的完整工作流，结果分别在原有目录与 UI 出现；
  不出现“API 返回 success，但工坊无内容”或“只改 Job 状态没人执行”。
- 取消、到期或撤销不会删用户项目；孤立快照只按明确安全清理条件回收，有 Job / 审计引用时保留。
- 真实 Agent 联调记录客户端版本、授权弹窗、Skill 选择与结果页面。没有真实厂商扣费授权就不实付出图。

错误形状复用连接契约，业务 code 包括 `TARGET_NOT_AUTHORIZED`、`DOCUMENT_CONFLICT`、
`REFERENCE_NOT_ALLOWED`、`MODEL_UNAVAILABLE`、`APPROVAL_REQUIRED`、`REQUEST_EXPIRED`、
`IDEMPOTENCY_CONFLICT`、`EXECUTION_NEEDS_REVIEW`；不返回原始 HTTP 客户端异常或供应商凭据。
