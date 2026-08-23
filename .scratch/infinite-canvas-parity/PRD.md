# Wayfinder Map：Infinite Canvas 全功能适配复刻

Type: wayfinder:map

Status: ready-for-human

## Destination

以 `basketikun/infinite-canvas@9414048f9d0a099386aa15d81bedb5376b79ee61`
作为功能和交互基线，在 game-atelier 中实现可验收的完整等价体验：项目管理、无限画布、
全部一方节点、生成能力、提示词与资产库、图片工具、Canvas Agent、节点插件、导入导出与
WebDAV 同步均有明确落点；同时保留现有 React Flow、文件系统真源、FastAPI、统一 Job
Runner、模型密钥与能力矩阵、Atelier 设计系统，以及“画布是人工创作的独立顶级空间”这一
产品边界。

这里的“完美复刻”指：固定基线版本上用户可观察到的功能、状态、操作路径、节点行为与布局
结构达到逐项等价；不逐行搬运参考仓库的 React 19、Ant Design、Zustand/localforage、浏览器
直连模型或自研画布引擎。视觉层复刻其信息架构、空间关系、交互反馈与节点模型，再用 Atelier
暖调暗色 token 和现有组件配方表达，避免在产品中出现第二套品牌。

到达 Destination 的完成条件：

- 参考基线的公开功能被锁定成逐项 parity matrix，每一项都有 `same / adapted / excluded` 结论、
  验收步骤和证据。
- Canvas Domain v2、存储 schema、API、Job 语义、Agent 与插件安全边界完成书面决策。
- v1 schema、旧 API 字段和旧前端分支被直接删除，运行时只接受 v2。
- 桌面端完成全功能验收；窄屏端对每项功能有明确的可用降级，而不是简单缩放桌面画布。
- 自动化覆盖 schema、API、Job、画布交互和安全边界；另有与参考基线并排的视觉验收。
- MIT 许可证与必要 attribution/NOTICE 收口，不复制未获授权的品牌素材。

## Notes

### 当前已确认的产品底线

- “画布”位于“创作台”和“工坊”之间，`/canvas` 是项目卡片墙，`/canvas/:id` 是独立编辑器。
- 画布项目由用户人工创建和推进；Character/UI/Video Skill 不创建、不填充、不自动运行画布。
- React Flow 继续承担视口、节点、连接、选择、拖拽、小地图等机械层，不替换为参考项目的自研
  画布引擎。
- FastAPI 与文件系统仍是唯一持久化入口；不把凭证、项目真源或生成请求迁回浏览器 localforage。
- 现有 Job Runner 仍是生成执行唯一入口；画布连接不自动触发下游节点，也不形成整图调度器。
- Atelier `DESIGN.md` 仍是视觉 token 和反 slop 约束；参考项目用于节点模型和行为基线。

### 基线能力清单

| 能力域 | 必须进入 parity matrix 的参考能力 | game-atelier 适配锚点 |
|---|---|---|
| 项目生命周期 | 新建、切换、重命名、删除、导入、导出、最近项目 | `canvases/<id>/` 文件真源与现有卡片墙 |
| 画布机械层 | 平移缩放、复位、多选、框选、复制粘贴、删除、撤销重做、拖放上传、背景、缩略图、选区/整图导出 | React Flow + 现有 autosave/API |
| 节点系统 | 文本、图片、视频、音频、配置、分组、插件节点；空节点/有内容节点；改名、缩放、左右连接柄 | Canvas Node v2 与统一 node chrome |
| 节点生成 | 文本改写、文生图、参考图生图/编辑、视频、音频、批量结果、重试、生成元数据、`@` 上游引用 | capability matrix + Canvas Job + SSE |
| 节点工具 | 保存资产、下载、替换、自由缩放、裁剪、蒙版、拆图、本地放大、AI 超分、角度生成、反推提示词 | 现有媒体端点与新增编辑 Job/本地算子 |
| 侧边资源 | 节点列表、资产库、提示词库、搜索/标签/插入、公共仓库同步 | 文件真源资产索引；与工坊资产仅显式导入/导出 |
| Canvas Agent | 读取当前项目/选择/节点/边/状态，结构化操作，流式会话、历史、审批、权限、诊断、Skills | viewer-server 上的受控操作层；不得绕开人工边界 |
| 插件与同步 | 远程节点插件、SDK、渲染/检查/序列化/迁移/工具栏/AI 能力、设置导入导出、WebDAV | 沙箱化插件契约、服务端校验、项目包与可选同步适配器 |

### 当前架构冲突

现有术语和 API 把边定义为“真实生成引用的来源连接”，但当前前端已允许更自由的结构边，且
实际提交 Job 时不再自动注入所有上游引用。扩展节点模型前必须先拆清三个概念：

1. `Canvas Connection`：用户可编辑的画布关系和可选输入路径。
2. `Resolved Input`：一次生成前，根据节点内容、连接和 `@` 显式引用解析出的候选输入。
3. `Generation Snapshot`：提交 Job 时冻结的真实 prompt、模型、参数和媒体引用，是可追溯真源。

否则连接线、重试、删除源节点、导入导出和 Agent 编辑都会争夺同一字段的语义。

### 推荐交付路线

```text
基线冻结
  → 领域与数据 v2
    → 生成适配 + 项目/资源能力
      → React Flow 交互原型验收
        → 图片工具
          → Agent 与插件安全边界
            → 完整架构包、实施批次与验收矩阵
```

开发阶段建议按可工作的垂直切片推进，而不是按前后端分层大爆炸：

1. **Foundation**：schema v2、旧路径删除、项目全生命周期、多选/复制粘贴/resize/group、导入导出。
2. **Creation parity**：文本/图片/视频/音频/配置节点、连接创建菜单、生成与重试、批量结果。
3. **Creative utilities**：节点工具栏、资产/提示词侧栏、拖放、背景、画布/选区导出、图片编辑工具。
4. **Extensibility**：Agent 受控操作、审批/权限/会话、插件 SDK/沙箱/迁移、WebDAV。
5. **Closeout**：性能、无障碍、窄屏、故障恢复、视觉对照、许可证、文档与旧路径删除。

### 依据

- 参考仓库：`basketikun/infinite-canvas`，基线 commit
  `9414048f9d0a099386aa15d81bedb5376b79ee61`。
- 本项目：`CONTEXT.md`、`DESIGN.md`、`docs/api-contract.md`、
  `docs/adr/0006-react-flow-for-provenance-canvas.md`。
- 旧 `.scratch/infinite-canvas/PRD.md` 只描述已完成的 MVP。本地图批准后，它的“不做图片编辑器、
  Agent、插件”等范围声明被本地图取代，但“独立人工空间、React Flow、统一 Job Runner”继续有效。

## Decisions so far

- 2026-08-23：参考基线固定为 `9414048f` / runtime v0.16.0；136 项中 131 项进入
  `same/adapted`，AI 超分占位、Claude SDK TODO、Skill 后续 TODO、插件直读密钥与原样 Ant Design
  品牌实现共 5 项排除。
- 2026-08-23：Canvas Domain v2 采用方案 A：稳定内容节点、Input/Derivation 两类连接、可编辑
  Generation Draft、临时 Resolved Input 与 Canvas Job 一一对应的不可变 Generation Snapshot；
  Snapshot 是实际生成输入的唯一真源，画布连接不触发整图执行。
- 2026-08-23：Canvas schema v2 采用 revision 化热文档内 Content Version、Job 内 Snapshot 与
  library/Agent/plugin 分域 sidecar；运行时只接受 v2，现有 v1 仅做发布前切换，不保留兼容分支。
- 2026-08-23：Canvas 文本、图片、视频、音频统一进入 Job Runner，并用不可变 Snapshot 与 candidate
  表达输入及批量结果；节点不常驻“1x”，图片/文本只在设置内按模型真实上限提供批量候选，默认 1。
- 2026-08-23：Canvas Project 拥有自己的资产、提示词与历史；跨 Canvas/创作台/工坊只做显式复制；
  项目包导入新建项目，WebDAV 用不可变快照谱系同步，分叉时创建冲突副本而非时间戳覆盖。
- 2026-08-23：Canvas Agent 采用受限 sidecar + 服务端 typed Change Set/审批；每轮由用户主动发起，
  Workflow Skill 仍不接触 Canvas，生成、删除、跨空间动作和远端刷新始终逐次确认。
- 2026-08-23：官方、本地与第三方 Canvas Node Plugin 统一使用 digest pin 的不可变包、opaque-origin
  iframe sandbox 和项目级 capability grant；跨节点写入走 Change Set，四模态生成只走 Job Runner；
  自定义模型首版只开放 declarative Caller Profile。

## Not yet specified

- `same / adapted / excluded` 的最终判定规则，以及“视觉完美”的截图容差和目标视口。
- 图片工具中纯本地算子与需要模型/Job 的边界，以及浏览器性能目标。
- schema v2 落地提交中旧 Canvas Document/Edge 字段的完整删除清单。
- 参考仓库后续 commit 是否追踪；当前默认只对固定基线负责。

## Out of scope

- 替换 React Flow、FastAPI、文件系统真源、统一 Job Runner 或 Atelier 设计系统。
- 让 Skill 自动创建、填充、推进或批量执行画布。
- ComfyUI 式整图执行、自动拓扑调度、分支、循环和子图运行。
- 参考仓库基线中不存在的社区、积分、公开分享、3D、3D 片场和剪辑时间线。
- 参考仓库 TODO 中尚未交付的 Claude Agent SDK 适配、网页安装 Skill、Agent memory。
- 逐行复制参考仓库实现、Ant Design 视觉、浏览器直连模型和浏览器保存明文密钥。

## Initial tickets

- `01-freeze-reference-baseline.md`
- `02-resolve-canvas-domain-v2.md`
- `03-design-schema-v2-and-cutover.md`
- `04-map-generation-capabilities.md`
- `05-resolve-project-assets-prompts-sync.md`
- `06-resolve-canvas-agent-boundary.md`
- `07-resolve-plugin-security-boundary.md`
- `08-prototype-parity-interactions.md`
- `09-plan-media-tools.md`
- `10-produce-implementation-program.md`
