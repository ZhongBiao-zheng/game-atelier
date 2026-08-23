# Canvas Domain v2 提案

Status: ready-for-agent

## 结论摘要

推荐采用“**稳定内容节点 + 两类有向连接 + 可变生成草稿 + 临时输入解析 + 不可变生成快照**”模型：

- 节点负责画布上的内容与交互身份，不承担历史真实性。
- `Input Connection` 负责当前这一次若提交时“哪些节点有资格成为输入”。
- `Derivation Connection` 负责显示“哪个创作表面产生了哪个结果节点”，但不作为历史证据。
- `Generation Draft` 是随时可改的当前创作意图。
- `Resolved Input` 只在提交前存在，是对当前节点、连接、`@` token、模型能力的计算结果。
- `Generation Snapshot` 在提交瞬间冻结，并与 Canvas Job 一一对应；它是“真实使用过什么”的唯一真源。

该模型复刻参考项目的可观察能力，但不复制其“同一条无类型边同时承担结构、输入、历史”的歧义，
也不引入 ComfyUI 式整图执行器。

## 代码与文档冲突证据

| 层 | 当前事实 | 冲突 |
|---|---|---|
| `CONTEXT.md` | `Provenance Connection` 记录真实使用过的输入 | 把可编辑边当作不可变历史 |
| `docs/api-contract.md` | 边只能指向 generation 节点，提交时写入 Job references | 已与当前前端行为不符 |
| Python schema v1 | 服务端拒绝任何非 generation target | 无法支持参考项目任意内容节点连接、配置、插件 |
| TS schema v1 | 只有 text/resource/generation 三类节点 | generation 节点混合草稿、Job 历史和结果展示 |
| 当前前端 | 所有节点都有左右连接柄 | 表达能力已超过后端 schema |
| 当前请求构造 | `buildCanvasGenerationRequest()` 删除三组 references | 边已经不再是真实 Job 输入 |
| 参考项目 | 无类型有向边被运行时解析成输入，生成结果仍用同一种边 | 可观察行为可学，历史语义不能照搬 |

## 领域对象

### Canvas Node

画布上的稳定交互身份，拥有位置、尺寸、标题、选择与呈现状态。节点类型创建后不转换；“空节点被
首个结果填充”是内容状态变化，不是节点换类型。

一方节点类型：

| Type | Canonical name | Owns | Does not own |
|---|---|---|---|
| `text` | Text Node | 文本内容、可选生成草稿 | Job 历史真实性 |
| `image` | Image Node | 空/已绑定图片版本、图片候选集、可选生成草稿 | 图片文件本体 |
| `video` | Video Node | 空/已绑定视频版本、可选生成草稿 | 视频文件本体 |
| `audio` | Audio Node | 空/已绑定音频版本、可选生成草稿 | 音频文件本体 |
| `config` | Generation Config Node | 生成模式、prompt、模型和参数草稿 | 结果内容 |
| `group` | Group Node | 视觉分组与一层成员关系 | 输入、执行或资产归属 |
| plugin type | Plugin Node | 经插件契约验证的呈现数据 | 任意系统权限或历史记录 |

不再保留独立 `generation` 节点类型。v2 落地时直接删除 v1 类型；新建节点根据 media kind 使用
image/video 内容节点；当前 active output 成为其内容，draft 成为该节点的 Generation Draft，Job IDs
转成运行引用。没有输出的 v1 generation 节点仍迁成对应空内容节点，而不是 config 节点。

### Content Version

一次不可变的文本或媒体内容版本。内容节点只指向当前版本；替换内容会创建/选择新版本，不会改写
旧版本。Generation Snapshot 引用具体版本，而不是“这个节点现在显示的内容”。物理文件、去重和
清理策略留给第 05 关裁定。

### Generation Surface

承载 Generation Draft、可以由用户明确点击生成的节点。Text/Image/Video/Audio Node 和 Generation
Config Node 都可以是 Generation Surface；Group 不能，Plugin 只有声明相应 capability 后才可以。

### Generation Draft

Generation Surface 当前可编辑的生成意图：mode、prompt/token 文档、模型选择、参数与输入选择策略。
Draft 自动保存但不是历史；提交后的任何编辑都不能改写已存在的 Run/Snapshot。

### Input Connection

从可提供内容的节点指向 Generation Surface 的当前输入关系。它是有向、可编辑、可撤销的“资格”，
不代表已经使用，不会触发目标节点，也不要求画布是 DAG。

### Derivation Connection

从本次 Generation Surface 或确定性本地工具的源 Content Node 指向结果 Content Node 的派生关系。
它只用于可视追溯和布局，删除边不会删除 Job、Snapshot、内容版本、工具来源或结果节点。

只有生成提交路径能创建带 Run 关联的 Derivation Connection；只有受控本地媒体命令能创建带
operation 关联的 Derivation Connection。用户、Agent 和插件不能伪造历史；它们只能通过统一校验器
创建 Input Connection。

### Resolved Input

提交前，根据 Generation Surface 当前状态计算出的临时输入集合。它包含最终 prompt、按顺序选择的
文本块与媒体内容版本，以及缺失/不兼容/超限诊断。它不持久化为历史记录。

### Generation Snapshot

提交瞬间冻结的真实生成输入：surface ID、mode、最终 prompt、model/provider/alias、规范化参数、
每个输入节点 ID 与具体 Content Version、输入顺序和提交时间。它与一个 Canvas Job 一一对应，是
回答“这份结果实际用了什么”的唯一真源；物理上优先作为 Job JSON 的不可变部分，而不是另建执行器。

### Canvas Generation Run

一次明确提交及其 Job、Generation Snapshot、结果候选和状态。Run 可产生一个结果节点及其 N 个候选；
候选有独立成功/失败状态和一个 primary 选择。切换 primary 只改变展示，不改变 Snapshot。

## 连接与端口规则

1. Input Connection 和 Derivation Connection 都有方向；禁止 self-loop 和同 role 的重复 source-target。
2. Group Node 没有端口，也不能成为任何连接端点。
3. Config Node 只有用户可见的输入端口；Derivation Connection 由生成提交或受控本地工具命令创建，
   不允许手工伪造。
4. Text/Image/Video/Audio 和声明 resource capability 的 Plugin Node 可以成为 Input source。
5. Text/Image/Video/Audio/Config 和声明 generation capability 的 Plugin Node 可以成为 Input target。
6. Config→Config 的 Input Connection 禁止；其他节点组合先允许连接，提交时再按模型 capability 检查。
7. Input Connection 允许形成环，因为系统不做拓扑执行；解析只看当前 Generation Surface 的直接输入，
   不递归执行或遍历整张图。
8. 前端 React Flow、服务端文档保存、Agent ops 和 Plugin host 必须共用同一套连接校验规则。
9. 无效输入不得被静默忽略：composer 显示缺失/不兼容/超限项，并阻止提交或要求用户明确移除。

## `@` 与输入解析规则

为复刻参考项目两种 composer 行为，Generation Draft 明确记录 selection policy：

- 普通 Text/Image/Video/Audio Node 默认 `all_connected`：自身已有内容作为 implicit self input，
  再加入全部直接 incoming Input Connection；`@` 只控制 prompt 中的称呼与顺序。
- Generation Config Node 默认 `mentions_only`：incoming Input Connection 只建立候选池，只有 prompt 中
  实际出现的 `@[node:<id>]` 被纳入 Resolved Input；没有 token 时不偷偷加入任何候选。
- Plugin Generation Surface 必须在 manifest 中选择一种 policy，默认 `mentions_only`。

统一解析顺序：

```text
读取 surface + draft
  → 收集 implicit self input 与直接 incoming Input Connection
  → 按 selection policy 和 @ token 选中、排序
  → 解析到具体 Content Version
  → 按模型 capability 验证类型、数量、大小、时长
  → 组装最终 prompt
  → 用户点击提交
  → 冻结 Generation Snapshot 并创建 Canvas Job
```

`@` token 只引用已经连接的候选节点；断开的 token 显示 missing，不允许默默变成普通文本。内容节点被
替换后，尚未提交的 draft 解析到新版本；已经提交的 Snapshot 继续引用旧版本。

## 结果节点统一规则

| Trigger surface | Before submit | On submit | Result placement |
|---|---|---|---|
| 空 Content Node | 没有 Content Version | 原节点进入生成态 | 首个成功候选填充原节点；node ID 不变 |
| 已填充 Content Node | 自身内容是 implicit input | 创建新结果节点 | surface→result Derivation Connection |
| Generation Config Node | 只有 draft 与候选 inputs | 创建新结果节点 | config→result Derivation Connection |
| Plugin write-back surface | manifest 明确 `write_back_self` | 更新原插件节点 | 仍保存 Snapshot；不伪造内容节点 |

图片 N 个结果属于一个 Image Node 的 Result Set，而不是 N 个互不相干节点。每个 candidate 独立显示
loading/success/error，可重试/删除；第一个成功项成为 primary，之后手动切换不改节点中心和 Snapshot。

文本、视频、音频仍使用同一规则；只有结果表示不同，不为每种媒体发明另一套运行模型。

## 状态模型

### Content Node

```text
empty ──绑定/首个成功结果──> ready
ready ──替换/选择候选──> ready(new Content Version)
```

节点是否 `generating / degraded` 从 active Run 和当前是否仍有可展示内容推导，不另存成历史真源：

- 没内容 + active Run 未完成：generating
- 有内容 + 新 Run 未完成：ready + generating overlay
- 有内容 + 新 Run 失败：ready + failed badge，旧内容不消失
- 没内容 + Run 失败：empty + error

### Canvas Generation Run

```text
submitted → succeeded
          → partially_succeeded
          → failed
          → canceled
```

`partially_succeeded` 表示 Result Set 至少一个成功、至少一个失败/取消；Run 的领域状态可以由 Job 状态
与 candidate 状态推导，是否扩展全局 Job 枚举留给第 03/04 关。

## 删除、替换与重试不变量

1. 删除节点会删除附着的两类连接，但不会删除已提交 Job、Generation Snapshot 或仍被 Snapshot 引用的
   Content Version。
2. 删除 Derivation Connection 只改变画布叙事，不改变“真实来源”。
3. 替换 Content Node 内容会创建新版本；旧 Snapshot 仍引用旧版本。
4. 修改 Draft、模型、连接或 `@` token 只影响下一次提交。
5. “按原设置重试”从 Generation Snapshot 创建新 Run；缺失的底层版本是数据损坏，明确报错，不回退到
   节点当前内容。
6. “使用当前设置再次生成”重新运行 Resolved Input，创建新 Snapshot；UI 必须把它与原样重试区分。
7. 删除 Group 只解除成员关系；子节点、连接、内容和运行记录保留。Group 不允许嵌套。
8. 删除结果 candidate 不等于删除 Run；至少保留 Snapshot/Job 元数据。物理垃圾回收按引用计数/保留策略
   在第 05 关裁定。

## Actor 权限不变量

- 用户、Agent、插件最终都调用同一领域命令与校验器，不能直接改 Canvas JSON。
- Agent/插件可以在授权后创建普通节点、修改 Draft、建立 Input Connection、提交生成；具体授权粒度由
  第 06/07 关决定。
- Agent/插件不能创建或修改 Generation Snapshot，不能创建“带历史含义”的 Derivation Connection，
  不能把 Job 标成成功。
- Skill 仍不自动创建、填充或推进 Canvas；Canvas Agent 是否属于用户确认后的操作器由第 06 关裁定。

## 场景压力测试

### S1：文本 + 两张参考图 → Config → 4 张结果

三条 Input Connection 进入 Config，prompt 只 `@` 文本与第二张图；Resolved Input 只包含这两项。提交
冻结 Snapshot，立即创建一个 Image Result Node 和 Config→Result Derivation Connection；Result Node
内部有四个 candidate，部分失败仍保留成功项。

### S2：生成后删除原参考图节点

图节点和相关 Input Connection 消失，但 Snapshot 引用的 Content Version 被保留；原样重试仍可运行。
画布上不再显示来源线不等于历史被改写。

### S3：生成后替换参考图节点内容

下一次“使用当前设置生成”解析到新版本；旧结果的 Snapshot 仍指向旧版本。“按原设置重试”使用旧版本。

### S4：用户把 A→B、B→A 连成环

允许保存，因为连接不是执行图。点击 B 生成只读取 B 自身与直接 A→B 输入，不执行 A，也不遍历 B→A。

### S5：删除 Group

组内节点留在原坐标并解除 membership；节点之间连接、Job、Snapshot 和内容版本均不变化。

### S6：Agent 声称某节点由另一节点生成

Agent 可以画一条 Input Connection，但不能伪造 Derivation Connection 或 Snapshot。真实派生只能来自一次
已提交的 Canvas Generation Run 或受控本地媒体命令。

## 备选方案

### A. 推荐：typed connection + immutable snapshot

优点：满足参考能力，历史可追溯，Agent/插件无法伪造，重试语义清晰，不需要图执行器。代价是 schema
比参考项目多一个 connection role 和 Generation Snapshot 概念。

### B. 照搬参考：所有边都是无类型关系

拒绝理由：一条可删除的边同时承担当前输入和历史来源；删除/替换节点、重试、Agent 修改后无法回答
“当时真实用了什么”，也与现有 Job 真源冲突。

### C. 强类型端口 + DAG/整图执行

拒绝理由：会把人工创作空间变成工作流引擎，违反已确认产品边界，并引入拓扑调度、循环和失败传播。

## CONTEXT.md 拟更新术语

批准本提案后，替换现有 `来源连接(Provenance Connection)`，并补充以下精简术语：

- `Content Node`：承载当前文本或媒体版本的稳定画布节点；空/有内容是状态，不是不同节点类型。
- `Generation Config Node`：只承载可编辑生成草稿和输入候选的节点，不拥有生成结果。
- `Input Connection`：当前可编辑的输入资格关系，不代表已经使用，也不触发下游。
- `Derivation Connection`：生成表面或确定性本地工具源节点与结果节点之间的可视派生关系，不是历史真源。
- `Generation Draft`：尚未提交、可以继续编辑的创作意图。
- `Resolved Input`：提交前从草稿、连接和显式引用解析出的临时输入集合。
- `Generation Snapshot`：提交时冻结的实际 prompt、模型、参数和内容版本，是历史输入唯一真源。
- `Canvas Generation Run`：一次明确提交及其 Job、快照、候选结果与最终状态。
- `Group Node`：仅组织画布空间的一层视觉容器，不参与输入或执行。

## 对 ADR-0006 的处理

保留 ADR-0006 的三项决定：React Flow 只负责机械层、Job Runner 是唯一执行入口、Canvas 是独立人工
空间。由新 ADR-0007 **只替代**其中“来源连接记录实际输入”的语义；ADR-0006 不整体废弃。

## Decision

2026-08-23：用户确认采用方案 A。ADR-0007 已接受，`CONTEXT.md` 已更新为本提案的规范术语。
