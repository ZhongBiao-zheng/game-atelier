# Infinite Canvas 参考基线核对表

Status: ready-for-human

## Baseline

- Repository: `basketikun/infinite-canvas`
- Commit: `9414048f9d0a099386aa15d81bedb5376b79ee61`
- Runtime version: `v0.16.0`
- Audit date: 2026-08-23
- Audit inputs: 中文/英文产品文档、源代码、插件 SDK、Canvas Agent、上游“待测试/TODO”、
  1440/1600px Chrome 实机运行。

## 判定规则

- **same**：复刻参考基线的用户可观察结果、状态、操作路径和交互反馈。
- **adapted**：保留相同用户能力，但按照 game-atelier 的 React Flow、FastAPI、文件真源、
  Job Runner、能力矩阵和 Atelier 设计系统重新实现。
- **excluded**：固定基线中明确未实现、仅在 TODO 中，或并非参考项目能力；不是把已交付功能静默砍掉。
- **现状 gap**：`none / partial / full` 分别表示本项目已具备、部分具备、尚未具备。

## 基线健康度

| Check | Result | Evidence / consequence |
|---|---|---|
| 固定 commit | pass | `git rev-parse HEAD` = `9414048f...` |
| 生产构建 | pass | `bun run build` 成功；主 JS 3.62MB、gzip 1.15MB，并有大 chunk 警告 |
| TypeScript | fail | `canvas-generation-helpers.ts:51`：`node.metadata` 可能为 `undefined` |
| Web 单测 | unknown | `web/package.json` 没有 test script；不可把入口存在等同于经过自动验证 |
| Canvas Agent 测试 | present | `canvas-agent/src/**/*.test.ts` 覆盖 Codex client/history/session/Skill store |
| 官方待测能力 | present | `docs/content/docs/progress/pending-test.zh-CN.mdx` 列出大量待人工验证项 |
| AI 超分 | placeholder | `project.tsx` 仅显示“暂未实现”；从已交付 parity 中排除 |
| Future TODO | not shipped | Claude Agent SDK、Skill 网络安装/资源/记忆仍在 TODO；从固定基线排除 |
| 插件安全 | known unsafe | 官方 UI 明示远程插件直接运行于页面，可访问本地数据和 API Key |

## A. 项目生命周期与持久化

| ID | 参考基线行为 | Source/runtime evidence | Parity | 现状 gap |
|---|---|---|---|---|
| A01 | 画布项目卡片库与空态 | `pages/canvas/index.tsx`；`01-project-index.png` | adapted：Atelier 卡片墙、创建卡与响应式空态，见 issue 26 | full |
| A02 | 新建并立即进入独立画布 | `createProject()` + `/canvas/:id` | same | none |
| A03 | 打开/切换多个画布项目 | `CanvasProjectCard`、顶部“我的画布” | same | none |
| A04 | 卡片与画布内双击重命名 | `canvas-project-card.tsx`、`canvas-top-bar.tsx` | same：卡片与顶部原地输入，见 issue 26 | full |
| A05 | 单项目确认删除 | `canvas-delete-projects-dialog.tsx` | same | full |
| A06 | 多选项目、批量导出/删除、删除全部 | `pages/canvas/index.tsx` | same | full |
| A07 | 单项目/多项目 ZIP 导出，媒体随包 | `canvas-export.ts`，format version 3 | adapted：服务端生成/校验项目包 | full |
| A08 | ZIP 导入并分配新项目 ID | `pages/canvas/index.tsx::importCanvas` | adapted：服务端解包和路径白名单 | full |
| A09 | 最近项目入口 | `/canvas?mode=recent` 打开列表首项 | same | full |
| A10 | 项目统计节点/连线和更新时间 | `CanvasProjectCard` | same：列表 summary 从当前 Document 派生，见 issue 26 | full |
| A11 | 浏览器 IndexedDB/localforage 持久化 | `use-canvas-store.ts` | adapted：必须使用现有文件系统真源 | none |
| A12 | 项目保存 viewport、背景、图片信息与 Agent 会话 | `CanvasProject` type | adapted：Canvas Document v2 分域保存 | partial |

> 核对纠偏：固定基线没有“复制整个画布项目”入口；只有复制节点。因此项目复制不进入 parity。

## B. 画布机械层与快捷键

| ID | 参考基线行为 | Source/runtime evidence | Parity | 现状 gap |
|---|---|---|---|---|
| B01 | 无限平移、滚轮缩放、复位、百分比缩放滑杆 | `infinite-canvas.tsx`、`canvas-zoom-controls.tsx` | adapted：React Flow 同一 viewport，8%–250% 滑杆与 100% 复位，见 issue 25 | full |
| B02 | 选择/移动两种工具模式 | `canvas-toolbar.tsx` | same | full |
| B03 | Ctrl/Space 临时反转选择与移动 | 快捷键弹窗、`pending-test` | adapted：Space / Control 临时平移，不改变单指框选与两指平移，见 issue 24 | full |
| B04 | 空白拖动框选，多节点选择 | 快捷键弹窗、`SelectionBox` | same | full |
| B05 | Shift/Cmd 点击追加选择 | 快捷键弹窗 | same | full |
| B06 | Cmd/Ctrl+A 全选 | 快捷键弹窗 | same：生产页与快捷键 Dialog 均已接通，见 issue 24 | full |
| B07 | Cmd/Ctrl+C/V 复制粘贴节点 | 快捷键弹窗 | adapted：同项目复制节点与内部 input 连接，复用不可变 Version，见 issue 24 | full |
| B08 | 从系统剪贴板粘贴文本/图片 | `project.tsx`、快捷键弹窗 | adapted：文本落人工 Version，图片先上传服务端，见 issue 24 | full |
| B09 | Delete/Backspace 删除节点或边 | 快捷键弹窗、context menu | same：节点、边及关联连接单命令删除，输入控件不劫持，见 issue 24 | full |
| B10 | Esc 清选择并关闭浮层 | 快捷键弹窗 | same：最上层优先收拢并归还焦点，见 issue 24 | full |
| B11 | Cmd/Ctrl+Z、Shift+Z/Y 撤销重做 | toolbar/topbar/shortcut | same：toolbar、Z、Shift+Z 与 Y 共用历史，见 issue 23 | full |
| B12 | 撤销覆盖节点、边、viewport、背景和 Agent 会话 | `canvas-shortcuts.zh-CN.mdx` | adapted：Document 节点/边/viewport/外观统一历史；Agent 按批准边界独立 | full |
| B13 | 图片/视频/音频拖入画布自动建节点 | `project.tsx`、快捷键弹窗 | adapted：文件先上传服务端 | full |
| B14 | 双击空白打开节点创建菜单 | `NodeCreateMenu` | same | full |
| B15 | 从连接柄拖到空白打开“带连接创建”菜单 | `ConnectionCreateMenu` | adapted：React Flow `onConnectEnd` | full |
| B16 | 右键节点复制/删除；右键边删除 | `canvas-context-menu.tsx` | same | full |
| B17 | 小地图显示/隐藏和点击导航 | `canvas-mini-map.tsx` | adapted：React Flow MiniMap；Document 设置显隐，拖拽/滚轮/点击导航，见 issue 22 | full |
| B18 | 点/线/空白三种背景 | `canvas-toolbar.tsx`；`menu-画布外观.png` | adapted：Atelier 背景 token | full |
| B19 | 浅色/深色主题 | `canvas-theme.ts`、外观菜单 | adapted：遵循 Atelier 暖暗色，浅色保留可用 | partial |
| B20 | 图片尺寸/信息显示开关 | `showImageInfo`、外观菜单 | same | full |
| B21 | 清空画布二次确认 | `project.tsx` clear modal | same | full |
| B22 | 选中节点/整批元素导出 | `canvas-side-panel.tsx::exportCanvasNodes` | adapted：服务端项目包/资源导出 | full |

## C. 节点模型与通用行为

| ID | 参考基线行为 | Source/runtime evidence | Parity | 现状 gap |
|---|---|---|---|---|
| C01 | 文本节点 | `CanvasNodeType.Text`；`03-built-in-nodes.png` | same | partial |
| C02 | 空/有内容图片节点 | `CanvasNodeType.Image`、`canvas-node.tsx` | adapted：统一媒体资源节点存储 | partial |
| C03 | 空/有内容视频节点 | `CanvasNodeType.Video` | adapted | partial |
| C04 | 空/有内容音频节点 | `CanvasNodeType.Audio` | adapted | partial |
| C05 | 生成配置节点，可切换文本/图片/视频/音频 | `canvas-config-composer.tsx` | adapted：提交到统一 Job Runner | full |
| C06 | 分组节点，显示成员数量 | `CanvasNodeType.Group`、groupId | same | full |
| C07 | 开放字符串插件节点 | `CanvasNodeTypeId`、node registry | adapted：使用受限插件契约 | full |
| C08 | 节点标题双击改名 | `canvas-node.tsx` | same：七类节点共用卡片外原地输入，见 issue 27 | full |
| C09 | 四角 resize、图片比例锁/自由变形 | `canvas-node.tsx`、`freeResize` | adapted：React Flow NodeResizer | full |
| C10 | 左右连接柄与有向连接 | `canvas-connections.tsx` | adapted：React Flow Handle/Edge；统一校验、空白创建、撤销持久化与有证据派生恢复，见 issue 28 | full |
| C11 | 配置节点之间禁止连接 | 运行时文案 `configConnection` | same | full |
| C12 | 节点 hover 工具条跟随节点 | `canvas-node-hover-toolbar.tsx` | same structure + Atelier styling | full |
| C13 | 节点信息/JSON 双视图 | `CanvasNodeInfoModal` | same | full |
| C14 | 错误节点工具条重试 | `canRetry` / `onRetry` | adapted：重试生成快照 | partial |
| C15 | 节点状态 idle/loading/success/error | `CanvasNodeStatus` | adapted：映射 Job 状态 | partial |
| C16 | 侧栏按名称/正文/提示词搜索和按类型筛选节点 | `CanvasNodesTab` | same | full |
| C17 | 侧栏点击节点定位/选中，图片可单独预览 | `CanvasNodesTab`、`pending-test` | adapted：React Flow fitView | full |

## D. 生成与结果模型

| ID | 参考基线行为 | Source/runtime evidence | Parity | 现状 gap |
|---|---|---|---|---|
| D01 | 节点下方独立 composer/提示词面板 | `canvas-node-prompt-panel.tsx`、`canvas-config-composer.tsx` | same structure + Atelier controls | partial |
| D02 | 空节点首个结果原位填充 | `canvas-node-manual.zh-CN.mdx` | same | full |
| D03 | 已有内容节点作为来源，结果建立下游节点 | manual + generation helpers | same | full |
| D04 | 文本改写；编辑已有文本时创建连接结果 | manual、`requestImageQuestion` | adapted：文本生成 Job/caller | full |
| D05 | 文本节点一键创建生图配置 | hover toolbar `generateImage` | same | full |
| D06 | 文生图 | image generation API | adapted：现有图片 capability + Job | partial |
| D07 | 图片参考编辑/图生图 | `requestEdit`、resource references | adapted：Job snapshot refs | full |
| D08 | 文本/图片/配置驱动视频 | `requestVideoGeneration` | adapted：现有视频 capability + Job | partial |
| D09 | 文本/配置驱动音频 | `requestAudioGeneration` | adapted：新增音频 capability/Job | full |
| D10 | 节点独立选择模型和参数 | settings popovers | adapted：复用现有 keys/capability matrix | partial |
| D11 | 图片尺寸/比例/质量/透明背景/数量 | `image-settings-panel.tsx` | adapted：只显示模型真实支持参数 | partial |
| D12 | 文本推理强度 auto/low/medium/high/xhigh | `text-settings-panel.tsx`、`pending-test` | adapted：按模型 capability 显示 | full |
| D13 | 视频尺寸、时长、质量、音频、水印 | `video-settings-panel.tsx` | adapted：按 provider capability 显示 | partial |
| D14 | 音色、格式、速度、instructions | `audio-settings-panel.tsx` | adapted：按 provider capability 显示 | full |
| D15 | `@` 引用已连接文本/图片/视频/音频 | prompt chip/resource mention components | adapted：连接解析 + 显式 mention | full |
| D16 | 提交前根据当前连接重新编号引用 | runtime composer 文案 | adapted：Resolved Input | full |
| D17 | 图片数量 N 立即创建 N 个槽位并独立更新 | multi-image metadata、`pending-test` | adapted：一轮 Job 的候选状态 | full |
| D18 | 多图收起堆叠、展开、设主图 | `canvas-node.tsx`、`pending-test` | same | full |
| D19 | 单槽位重试/删除，不抢占成功主图 | `project.tsx`、`pending-test` | adapted：候选/轮次模型 | full |
| D20 | 停止当前生成，保留已完成结果 | `stopTitle/continue`、AbortController | adapted：Job 取消/部分成功 | full |
| D21 | 生成元数据保存 prompt/model/size/quality/references | `CanvasNodeMetadata` | adapted：不可变 Generation Snapshot | partial |
| D22 | 根据保存元数据重试；引用丢失明确报错 | `handleRetryNode` | adapted：快照路径与存在性验证 | partial |
| D23 | 自定义模型调用脚本 | `model-script-editor.tsx`、`model-plugin.ts` | adapted：服务端受控 caller/plugin，不执行浏览器任意脚本 | full |
| D24 | 生成跨域错误专门提示 | latest commit、`pending-test` | adapted：服务端直连后转换为友好错误 | partial |

## E. 图片与媒体节点工具

| ID | 参考基线行为 | Source/runtime evidence | Parity | 现状 gap |
|---|---|---|---|---|
| E01 | 媒体加入资产库 | hover toolbar、`05-populated-image-tools.png` | adapted：写 Canvas 资产索引 | full |
| E02 | 图片/视频/音频下载 | hover toolbar | same | full |
| E03 | 图片/视频/音频替换 | hover toolbar | adapted：上传新版本并更新节点 | full |
| E04 | 复制生成图片的提示词 | image quick tools | same | full |
| E05 | 反推提示词，创建文本+配置节点 | `reversePrompt`、preset | adapted：模型 Job + 新节点 | full |
| E06 | 蒙版局部编辑 | `canvas-node-mask-edit-dialog.tsx` | adapted：本地 mask + 图片编辑 Job | full |
| E07 | 裁剪并生成新节点 | `canvas-node-crop-dialog.tsx` | same result, server-owned file | full |
| E08 | 任意行列切图并生成子节点 | `canvas-node-split-dialog.tsx` | same result, server-owned files | full |
| E09 | 本地放大到目标长边 | `canvas-node-upscale-dialog.tsx` | adapted：浏览器/服务端算子待票 09 决定 | full |
| E10 | 多角度生成 | `CanvasNodeAngleDialog` + `generateAngleNode` | adapted：图片生成 Job | full |
| E11 | 大图查看和图片详情 | preview modal/info modal | same：节点显示当前 Version 宽高/体积，详情保留完整 metadata，见 issue 21 | full |
| E12 | 自定义图片节点快捷工具与是否显示文字 | toolbar settings + localStorage | adapted：应用级 `.config/canvas-ui.json`，revision/原子写，见 issue 20 | full |
| E13 | AI 超分入口 | `project.tsx` 只显示“暂未实现” | excluded：不是已交付功能；若要做是产品新增 | n/a |
| E14 | 视频编辑 prompt 入口 | hover toolbar `isVideo -> edit` | adapted：视频派生 Job | full |

## F. 资产库、提示词与设置同步

| ID | 参考基线行为 | Source/runtime evidence | Parity | 现状 gap |
|---|---|---|---|---|
| F01 | 左侧“画布/资产/提示词库”三 Tab、可调整宽度/收起 | `canvas-side-panel.tsx`、runtime | same structure + Atelier styling | full |
| F02 | 独立资产库，图片/视频/音频/文本可复用 | `use-asset-store.ts`、`pages/assets` | adapted：Canvas 项目资产文件真源 | full |
| F03 | 上传资产、搜索/分类、插入画布、删除 | `CanvasAssetsTab`、assets page | same | full |
| F04 | 公共提示词来源、七个内置源、自定义 JSON URL | prompt source services/config | adapted：服务端抓取、缓存、schema 校验 | full |
| F05 | 提示词搜索/标签/详情/复制/加入资产 | prompts page、`PromptDetailDialog` | same | full |
| F06 | 在画布侧栏搜索公共提示词并插入文本节点 | `CanvasPromptsTab`、`pending-test` | same | full |
| F07 | 提示词源启停、手动/定时刷新、保留上次成功缓存 | config prompt sources、scheduler | adapted：服务端调度/缓存 | full |
| F08 | 渠道、模型与默认偏好配置 | `use-config-store.ts`、config modal | adapted：复用现有 Keys 与 capability matrix | partial |
| F09 | 设置 JSON 导入导出，包含 API Key/WebDAV 凭证 | `config-file.ts` | adapted：不导出明文密钥；只导出非敏感偏好/引用 | full |
| F10 | 本地存储用量、对象仓库和配额统计 | local storage settings、`pending-test` | adapted：显示服务端 Canvas 存储用量 | full |
| F11 | WebDAV 测试和各域同步 | `app-sync.ts`、`webdav-sync.ts` | adapted：服务端同步项目包/manifest | full |

## G. Canvas Agent

| ID | 参考基线行为 | Source/runtime evidence | Parity | 现状 gap |
|---|---|---|---|---|
| G01 | 右侧可调整宽度的 Agent 面板 | runtime、`local-agent-panel.tsx` | same structure + Atelier styling | full |
| G02 | 本地 URL/token 自动/手动连接与状态 | `agent-connect-view.tsx` | adapted：viewer-server 内部/受控 sidecar | full |
| G03 | 对话、新对话、历史、Skills、诊断日志四 Tab | runtime buttons、agent components | same | full |
| G04 | 读取当前项目/节点/边/选择/viewport/状态 | `CanvasAgentSnapshot`、MCP tools | adapted：只读 API +页面实例绑定 | full |
| G05 | 结构化新增/修改/移动/删除节点和边 | `canvas-agent-ops.ts`、agent operations | adapted：命令校验、审计、undo | full |
| G06 | Agent 一次操作快照撤销 | `use-agent-bridge.ts` | adapted：纳入统一命令历史 | full |
| G07 | 流式回复、思考、计划、命令、文件/网页/工具事件 | agent event formatter/chat | same | full |
| G08 | 请求批准/自动审查/完全访问与审批卡 | `pending-test`、approval API | adapted：项目内权限矩阵，不默认完全访问 | full |
| G09 | 停止 turn、失败恢复、token 统计 | local agent panel | same | full |
| G10 | 历史恢复、批量删除、SSE 实时与历史一致 | agent history + pending tests | adapted：会话文件真源 | full |
| G11 | 图片附件与画布引用 chip | agent composer/reference preview | adapted：媒体路径白名单 | full |
| G12 | 多标签页页面身份隔离，turn 固定发起页 | agent session/site tools + pending tests | same security outcome | full |
| G13 | 当前画布优先，不重复列表/导航 | `pending-test` | same | full |
| G14 | Skills 列表/启停/使用/新建/编辑/删除/从会话或画布生成草稿 | `agent-skills-view.tsx` | adapted：不得让 Skill 未确认推进画布 | full |
| G15 | Canvas Agent HTTP/MCP 与 Codex adapter | `canvas-agent/src/server`、agent client | adapted：决定复用当前 Codex 还是 sidecar | full |
| G16 | Claude Agent SDK adapter | upstream TODO | excluded：固定基线未交付 | n/a |
| G17 | Skill 网络安装、资源管理、Agent memory | upstream TODO | excluded：固定基线未交付 | n/a |

## H. 节点插件

| ID | 参考基线行为 | Source/runtime evidence | Parity | 现状 gap |
|---|---|---|---|---|
| H01 | 官方/本地/第三方插件管理、安装/启停/更新/卸载 | plugin manager/runtime | adapted：签名包或受信目录，不直接执行任意 URL | full |
| H02 | 远程 JS URL 安装 | `plugin-loader.ts` | adapted：相同安装体验，受 sandbox/权限控制 | full |
| H03 | manifest、节点定义、图标/描述/默认尺寸 | plugin SDK types | adapted：本项目 SDK | full |
| H04 | 自定义 renderer、panel、toolbar、interaction/move | plugin SDK + host hook | adapted：iframe/worker/host capability | full |
| H05 | 文档宣称 serialize/deserialize/migrate；运行时实际只有 JSON metadata 保存与缺失插件占位 | docs features、SDK 无迁移 hook、`MissingPluginContent` | adapted：host envelope + sandbox 原子迁移，实现完整 data-survival outcome | full |
| H06 | 插件申请文本/图片/视频 AI；音频通过内置 panel mode | `CanvasPluginAi`、`CanvasBuiltinPanelConfig` | adapted：四模态统一代理到 Job Runner | full |
| H07 | 插件结构化操作节点/边、读取资源 | `CanvasPluginHost` | adapted：capability authorization | full |
| H08 | HTML/Markdown/Panorama/Sticky/SVG 官方示例 | `plugins/canvas/*` | same examples as compatibility fixtures, Atelier visual | full |
| H09 | 插件源码离线缓存和版本固定 | plugin store/source | adapted：本地已审计包缓存 | full |
| H10 | 插件直接访问页面本地数据/API Key | 官方警告 | excluded：明确拒绝复制该安全缺陷 | n/a |

## I. 视觉与响应式基线

| ID | 参考基线行为 | Source/runtime evidence | Parity | 现状 gap |
|---|---|---|---|---|
| I01 | 顶部项目/状态/配置区，底部居中工具 dock | runtime screenshots | same spatial hierarchy + Atelier styling | partial |
| I02 | 左侧资源面板、中央画布、右侧 Agent 三栏可折叠/调整 | runtime/components | same | full |
| I03 | 节点标题在卡片外上方，卡片本体承载内容 | `canvas-node.tsx`、runtime | same：标题与改名输入都跟随节点外沿，见 issue 27 | full |
| I04 | hover 工具条位于节点上方 | `canvas-node-hover-toolbar.tsx` | same | full |
| I05 | composer 是节点下方独立浮层并随节点移动 | prompt/config components | same | partial |
| I06 | 连接柄位于节点左右中部，边低对比 | node/connections | same behavior + Atelier colors：48px 命中区、低对比贝塞尔、派生虚线与相关边高亮，见 issue 28 | full |
| I07 | 浅/深主题、点/线/空白背景 | theme/appearance runtime | adapted：固定 Atelier 暗色 token；外观菜单明确选择点/线/空白并持久化 | full |
| I08 | 画布和 Agent/左栏适配窄屏 | components + pending tests | adapted：375/768 明确可用降级 | full |
| I09 | 逐像素复制 Ant Design、白色工具条、字体与品牌色 | reference implementation detail | excluded：与“适配原项目”冲突 | n/a |

## 核对结论

1. 固定基线共登记 **136 个核对项**：131 项进入 `same/adapted` 目标，5 项上游未来、占位、
   安全缺陷或品牌实现明确排除；另拒绝复制两个实现缺陷——远程插件直读密钥、设置包导出明文密钥。
2. game-atelier 当前只在独立项目、React Flow 基础机械层、图片/视频单节点生成、自动保存、
   小地图和下方 composer 上具有部分基础；多选/创建菜单/配置节点/批量结果/资源侧栏/图片工具/
   Agent/插件/WebDAV 均属于完整缺口。
3. 参考项目不能作为无条件健康真源：当前 commit 生产构建成功但 TypeScript 失败，AI 超分是占位，
   且官方仍有大规模人工待测清单。我们的“完美复刻”必须以矩阵验收，而不是以复制代码为准。
4. 下一票必须先裁定连接与 Generation Snapshot 语义，否则 D15-D22、Agent 操作、插件 host、
   导入导出和重试都会基于互相冲突的数据模型开发。

## Runtime evidence

- `evidence/01-project-index.png`：项目库空态与 Agent 首次连接面板。
- `evidence/02-empty-canvas.png`：空白画布的三栏布局、顶部与底部控件。
- `evidence/03-built-in-nodes.png`：六类一方节点与配置 composer。
- `evidence/04-image-node-hover.png`：空图片节点、下方 composer 与 hover 工具条。
- `evidence/05-populated-image-tools.png`：有内容图片节点及默认快捷工具。
- `evidence/menu-画布外观.png`、`menu-快捷键.png`、`menu-节点插件.png`、
  `menu-打开画布菜单.png`：四类浮层实机入口。
