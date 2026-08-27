# Infinite Canvas 参考基线核对表

Status: **corrected 2026-08-27** —— 原表把 37 项标成 `full`，按代码复核后全部改判 `missing`。
原始判定是照着「设计意图 / schema / 接口存在」写的，不是照着「用户能不能用」写的。
两组整节被误标（Canvas Agent G01–G15、节点插件 H01–H09），另有 13 项零散误标。

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
- **交付状态**：`full` 表示已按 `same/adapted` 边界交付并核验；`partial` 表示有可用实现但仍有缺口；
  `missing` 表示**没有任何用户可用实现**（schema、类型、无调用方的接口都不算交付）；`n/a` 表示固定基线排除项。

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

| ID | 参考基线行为 | Source/runtime evidence | Parity | 交付状态 |
|---|---|---|---|---|
| A01 | 画布项目卡片库与空态 | `pages/canvas/index.tsx`；`01-project-index.png` | adapted：Atelier 卡片墙、创建卡与响应式空态，见 issue 26 | full |
| A02 | 新建并立即进入独立画布 | `createProject()` + `/canvas/:id` | same | full |
| A03 | 打开/切换多个画布项目 | `CanvasProjectCard`、顶部“我的画布” | same | full |
| A04 | 卡片与画布内双击重命名 | `canvas-project-card.tsx`、`canvas-top-bar.tsx` | same：卡片与顶部原地输入，见 issue 26 | full |
| A05 | 单项目确认删除 | `canvas-delete-projects-dialog.tsx` | adapted：一次确认后永久删除，不要求输入项目名 | full |
| A06 | 多选项目、批量导出/删除、删除全部 | `pages/canvas/index.tsx` | same ⚠️ 未交付：项目库没有多选、批量导出/删除或删除全部；只有单项目卡片菜单里的导出与删除 | missing |
| A07 | 单项目/多项目 ZIP 导出，媒体随包 | `canvas-export.ts`，format version 3 | adapted：服务端生成/校验项目包 | full |
| A08 | ZIP 导入并分配新项目 ID | `pages/canvas/index.tsx::importCanvas` | adapted：服务端解包和路径白名单 | full |
| A09 | 最近项目入口 | `/canvas?mode=recent` 打开列表首项 | same | full |
| A10 | 项目统计节点/连线和更新时间 | `CanvasProjectCard` | same：列表 summary 从当前 Document 派生，见 issue 26 | full |
| A11 | 浏览器 IndexedDB/localforage 持久化 | `use-canvas-store.ts` | adapted：必须使用现有文件系统真源 | full |
| A12 | 项目保存 viewport、背景、图片信息与 Agent 会话 | `CanvasProject` type | adapted：viewport/外观在 revision Document；Agent Session 使用独立 revision/sequence 冷 sidecar 与锁域，项目包严格验证并重映射，见 issue 38 | full |

> 核对纠偏：固定基线没有“复制整个画布项目”入口；只有复制节点。因此项目复制不进入 parity。

## B. 画布机械层与快捷键

| ID | 参考基线行为 | Source/runtime evidence | Parity | 交付状态 |
|---|---|---|---|---|
| B01 | 无限平移、滚轮缩放、复位、百分比缩放滑杆 | `infinite-canvas.tsx`、`canvas-zoom-controls.tsx` | adapted：React Flow 同一 viewport，8%–250% 滑杆与 100% 复位，见 issue 25 | full |
| B02 | 选择/移动两种工具模式 | `canvas-toolbar.tsx` | same | full |
| B03 | Ctrl/Space 临时反转选择与移动 | 快捷键弹窗、`pending-test` | adapted：Space / Control 临时平移，不改变单指框选与两指平移；Mac 横向双指 wheel 在画布 capture 阶段阻止浏览器 history navigation，见 issue 24 | full |
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
| B19 | 浅色/深色主题 | `canvas-theme.ts`、外观菜单 | adapted：复用 Atelier 语义 token 与 `atelier:theme`；Canvas 外观菜单可直接切换，见 Issue 39 | full |
| B20 | 图片尺寸/信息显示开关 | `showImageInfo`、外观菜单 | same | full |
| B21 | 清空画布二次确认 | `project.tsx` clear modal | same ⚠️ 未交付：画布上没有任何「清空」入口 | missing |
| B22 | 选中节点/整批元素导出 | `canvas-side-panel.tsx::exportCanvasNodes` | adapted：服务端项目包/资源导出 ⚠️ 未交付：没有「导出选中节点」；导出只有整项目包一种粒度 | missing |

## C. 节点模型与通用行为

| ID | 参考基线行为 | Source/runtime evidence | Parity | 交付状态 |
|---|---|---|---|---|
| C01 | 文本节点 | `CanvasNodeType.Text`；`03-built-in-nodes.png` | same：节点内双击/工具条编辑，字号映射 Atelier `xs/sm/base` token，见 issue 37 | full |
| C02 | 空/有内容图片节点 | `CanvasNodeType.Image`、`canvas-node.tsx` | adapted：不可变 Content Version 存储；独立空态上传与 contain/cover/free-resize 表面；上传图片为纯素材，选中不展示生成设置，见 issue 37 | full |
| C03 | 空/有内容视频节点 | `CanvasNodeType.Video` | adapted：独立空态上传、惰性媒体 URL 与节点内播放器；画面单击选择节点，播放/暂停、进度、音量与全屏仅由自有控制条触发，见 issue 37 | full |
| C04 | 空/有内容音频节点 | `CanvasNodeType.Audio` | adapted：独立空态上传、惰性媒体 URL 与节点内原生播放器，见 issue 37 | full |
| C05 | 生成配置节点，可切换文本/图片/视频/音频 | `canvas-config-composer.tsx` | adapted：Issue 40 独立配置卡 + 四态 composer，提交到统一 Job Runner | full |
| C06 | 分组节点，显示成员数量 | `CanvasNodeType.Group`、groupId | same ⚠️ 未交付：`CanvasGroupNode` 只有 schema 与成员校验，UI 没有创建入口，节点卡只会渲染一句「分组」占位 | missing |
| C07 | 开放字符串插件节点 | `CanvasNodeTypeId`、node registry | adapted：使用受限插件契约 | full |
| C08 | 节点标题双击改名 | `canvas-node.tsx` | same：七类节点的素材名固定显示在卡片左上方并共用原地输入，见 issue 27 | full |
| C09 | 四角 resize、图片比例锁/自由变形 | `canvas-node.tsx`、`freeResize` | adapted：React Flow NodeResizer | full |
| C10 | 左右连接柄与有向连接 | `canvas-connections.tsx` | adapted：React Flow Handle/Edge；统一校验、空白创建、撤销持久化与有证据派生恢复，见 issue 28 | full |
| C11 | 配置节点之间禁止连接 | 运行时文案 `configConnection` | same | full |
| C12 | 节点工具条跟随节点 | `canvas-node-hover-toolbar.tsx` | adapted：点击选中后固定出现在节点上方，反向补偿缩放并允许随节点移出视口；选中节点临时高于全部持久化节点，完整图片工具不按节点宽度折叠，空媒体保留 disabled 功能位 | full |
| C13 | 节点信息/JSON/检查器视图 | `CanvasNodeInfoModal` | excluded：后续产品决策确认实际价值有限，节点操作统一收口到选中态工具条与节点内编辑 | n/a |
| C14 | 错误节点工具条重试 | `canRetry` / `onRetry` | adapted：失败后在生成面板按当前 Draft 整批重新提交；按原快照重试已于 2026-08-26 移除 | partial |
| C15 | 节点状态 idle/loading/success/error | `CanvasNodeStatus` | adapted：由 validated result Job 派生且保留旧内容，见 issue 30 | full |
| C16 | 侧栏按名称/正文/提示词搜索和按类型筛选节点 | `CanvasNodesTab` | same ⚠️ 未交付：侧栏只有「资产 / 提示词」两个 Tab，没有节点 Tab，也就没有按名称/正文/提示词搜索或按类型筛选 | missing |
| C17 | 侧栏点击节点定位/选中，图片可单独预览 | `CanvasNodesTab`、`pending-test` | adapted：React Flow fitView ⚠️ 未交付：同上，没有节点列表，也就没有点击定位与单独预览 | missing |

## D. 生成与结果模型

| ID | 参考基线行为 | Source/runtime evidence | Parity | 交付状态 |
|---|---|---|---|---|
| D01 | 节点下方独立 composer/提示词面板 | `canvas-node-prompt-panel.tsx`、`canvas-config-composer.tsx` | same structure + Atelier controls：六类生成节点共用独立提示词面板，真实能力与操作置底，关闭可重开，见 issue 31 | full |
| D02 | 空节点首个结果原位填充 | `canvas-node-manual.zh-CN.mdx` | same | full |
| D03 | 已有内容节点作为来源，结果建立下游节点 | manual + generation helpers | same | full |
| D04 | 文本改写；编辑已有文本时创建连接结果 | manual、`requestImageQuestion` | adapted：文本生成 Job/caller | full |
| D05 | 文本节点一键创建生图配置 | hover toolbar `generateImage` | adapted：Issue 40 建 config + input edge + 稳定引用，不自动提交 | full |
| D06 | 文生图 | image generation API | adapted：Issue 40 复用真实可路由图片 capability + Job Runner | full |
| D07 | 图片参考编辑/图生图 | `requestEdit`、resource references | adapted：Job snapshot refs | full |
| D08 | 文本/图片/配置驱动视频 | `requestVideoGeneration` | adapted：Issue 40 配置四态切换 + 现有视频 capability + Job Runner | full |
| D09 | 文本/配置驱动音频 | `requestAudioGeneration` | adapted：新增音频 capability/Job | full |
| D10 | 节点独立选择模型和参数 | settings popovers | adapted：复用现有 keys/capability matrix；工具条与创建菜单提供独立 LLM 入口，火山 Ark 对话模型走 OpenAI-compatible Chat Completions | full |
| D11 | 图片尺寸/比例/质量/透明背景/数量 | `image-settings-panel.tsx` | adapted：只显示模型真实支持参数 | full |
| D12 | 文本推理强度 auto/low/medium/high/xhigh | `text-settings-panel.tsx`、`pending-test` | adapted：`openai-responses` 展示 reasoning；Chat Completions 展示 temperature；两者均支持 max tokens 与候选数 1–4，auto 省略协议参数 | full |
| D13 | 视频尺寸、时长、质量、音频、水印 | `video-settings-panel.tsx` | adapted：按 provider capability 显示 | full |
| D14 | 音色、格式、速度、instructions | `audio-settings-panel.tsx` | adapted：按 provider capability 显示，关闭前原子提交本地草稿，服务端再次归一化 | full |
| D15 | `@` 引用已连接文本/图片/视频/音频 | prompt chip/resource mention components | adapted：提示词上方独立素材条可点击查看，图片显示缩略图、视频显示首帧，通过 `+` 增删真实 Input Connection，并在 hover/聚焦时显示图片、视频、文本或音频详情；不自动改写稳定 node token，missing 继续双端拒绝（issue 34） | full |
| D16 | 提交前根据当前连接重新编号引用 | runtime composer 文案 | adapted：冻结输入后按模态与真实数组顺序重编号（issue 34） | full |
| D17 | 图片数量 N 立即创建 N 个槽位并独立更新 | multi-image metadata、`pending-test` | adapted：一轮 Job 内逐槽执行并即时登记（issue 35） | full |
| D18 | 多图收起堆叠、展开、设主图 | `canvas-node.tsx`、`pending-test` | same：结果节点拥有堆叠与展开候选（issue 35） | full |
| D19 | 单槽位重试/删除，不抢占成功主图 | `project.tsx`、`pending-test` | adapted：只保留 tombstone 删除；单槽位重试已于 2026-08-26 按产品决定移除 | partial |
| D20 | 停止当前生成，保留已完成结果 | `stopTitle/continue`、AbortController | adapted：持久取消意图 + 候选聚合终态（issue 35） | full |
| D21 | 生成元数据保存 prompt/model/size/quality/references | `CanvasNodeMetadata` | adapted：不可变 Snapshot 在详情中展示最终 prompt、模型、完整安全参数、冻结 node/version 与独立执行结果，见 issue 36 | full |
| D22 | 根据保存元数据重试；引用丢失明确报错 | `handleRetryNode` | dropped：按保存元数据重试已于 2026-08-26 移除；重试一律按节点当前 Draft 重新解析 | none |
| D23 | 自定义模型调用脚本 | `model-script-editor.tsx`、`model-plugin.ts` | adapted：服务端受控 caller/plugin，不执行浏览器任意脚本 | full |
| D24 | 生成跨域错误专门提示 | latest commit、`pending-test` | adapted：区分 CORS/错误 API 地址、DNS、TLS、代理与网络跳点；诊断脱敏且保留 task_id，见 issue 36 | full |

## E. 图片与媒体节点工具

| ID | 参考基线行为 | Source/runtime evidence | Parity | 交付状态 |
|---|---|---|---|---|
| E01 | 媒体加入资产库 | hover toolbar、`05-populated-image-tools.png` | adapted：写 Canvas 资产索引 | full |
| E02 | 图片/视频/音频下载 | hover toolbar | same | full |
| E03 | 图片/视频/音频替换 | hover toolbar | adapted：上传新版本并更新节点；上传图片选中后在节点右上角提供直接替换入口 | full |
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

| ID | 参考基线行为 | Source/runtime evidence | Parity | 交付状态 |
|---|---|---|---|---|
| F01 | 左侧“画布/资产/提示词库”三 Tab、可调整宽度/收起 | `canvas-side-panel.tsx`、runtime | same structure + Atelier styling ⚠️ 未交付：实为固定宽度（`w-[min(22rem,…)]`）的浮层面板，只有「资产 / 提示词」两个 Tab，既无节点 Tab 也不能调宽或收起 | missing |
| F02 | 独立资产库，图片/视频/音频/文本可复用 | `use-asset-store.ts`、`pages/assets` | adapted：Canvas 项目资产文件真源 | full |
| F03 | 上传资产、搜索/分类、插入画布、删除 | `CanvasAssetsTab`、assets page | same | full |
| F04 | 公共提示词来源、七个内置源、自定义 JSON URL | prompt source services/config | adapted：服务端抓取、缓存、schema 校验 ⚠️ 未交付：只有项目内的提示词库，没有公共来源、七个内置源或自定义 JSON URL | missing |
| F05 | 提示词搜索/标签/详情/复制/加入资产 | prompts page、`PromptDetailDialog` | same | full |
| F06 | 在画布侧栏搜索公共提示词并插入文本节点 | `CanvasPromptsTab`、`pending-test` | same ⚠️ 未交付：侧栏搜索的是项目内提示词，没有公共提示词源可搜 | missing |
| F07 | 提示词源启停、手动/定时刷新、保留上次成功缓存 | config prompt sources、scheduler | adapted：服务端调度/缓存 ⚠️ 未交付：没有提示词源，也就没有启停、刷新调度与缓存 | missing |
| F08 | 渠道、模型与默认偏好配置 | `use-config-store.ts`、config modal | adapted：Keys 管渠道/模型；对话作为一等模型分类，火山预置图片 + 豆包对话模型并识别 `/models` 中未声明模态的豆包文本家族；应用级 v2 偏好保存四模态默认模型与安全参数，见 issue 41 | full |
| F09 | 设置 JSON 导入导出，包含 API Key/WebDAV 凭证 | `config-file.ts` | adapted：不导出明文密钥；只导出非敏感偏好/引用 ⚠️ 未交付：没有设置导入导出 | missing |
| F10 | 本地存储用量、对象仓库和配额统计 | local storage settings、`pending-test` | adapted：显示服务端 Canvas 存储用量 ⚠️ 未交付：没有存储用量统计 | missing |
| F11 | WebDAV 测试和各域同步 | `app-sync.ts`、`webdav-sync.ts` | adapted：服务端同步项目包/manifest ⚠️ 未交付：只有 ADR 0010 的设计，没有 WebDAV 实现 | missing |

## G. Canvas Agent

> **G01–G15 全部 `missing`（2026-08-27 按代码复核改判，此前误标 full）。** 现有的只是一个会话文件仓库
> （`canvas_agent_sessions.py`：读 / 列 / 建 / 追加消息 / 删）加 4 条 CRUD 接口，以及 `web/src/api/canvas.ts`
> 里 4 个**零调用方**的客户端函数。没有 Agent 面板、没有连接态、没有流式回复、没有审批卡、没有 Skills 管理、
> 没有结构化改图命令通道、没有 MCP 或 Codex adapter。判据：这 4 个函数在非测试代码里的调用数全为 0。
> 「有 schema、有类型、有接口」不等于交付——用户点不到的东西不进 parity。

| ID | 参考基线行为 | Source/runtime evidence | Parity | 交付状态 |
|---|---|---|---|---|
| G01 | 右侧可调整宽度的 Agent 面板 | runtime、`local-agent-panel.tsx` | same structure + Atelier styling ⚠️ 未交付，原因见本节开头 | missing |
| G02 | 本地 URL/token 自动/手动连接与状态 | `agent-connect-view.tsx` | adapted：viewer-server 内部/受控 sidecar ⚠️ 未交付，原因见本节开头 | missing |
| G03 | 对话、新对话、历史、Skills、诊断日志四 Tab | runtime buttons、agent components | same ⚠️ 未交付，原因见本节开头 | missing |
| G04 | 读取当前项目/节点/边/选择/viewport/状态 | `CanvasAgentSnapshot`、MCP tools | adapted：只读 API +页面实例绑定 ⚠️ 未交付，原因见本节开头 | missing |
| G05 | 结构化新增/修改/移动/删除节点和边 | `canvas-agent-ops.ts`、agent operations | adapted：命令校验、审计、undo ⚠️ 未交付，原因见本节开头 | missing |
| G06 | Agent 一次操作快照撤销 | `use-agent-bridge.ts` | adapted：纳入统一命令历史 ⚠️ 未交付，原因见本节开头 | missing |
| G07 | 流式回复、思考、计划、命令、文件/网页/工具事件 | agent event formatter/chat | same ⚠️ 未交付，原因见本节开头 | missing |
| G08 | 请求批准/自动审查/完全访问与审批卡 | `pending-test`、approval API | adapted：项目内权限矩阵，不默认完全访问 ⚠️ 未交付，原因见本节开头 | missing |
| G09 | 停止 turn、失败恢复、token 统计 | local agent panel | same ⚠️ 未交付，原因见本节开头 | missing |
| G10 | 历史恢复、批量删除、SSE 实时与历史一致 | agent history + pending tests | adapted：会话文件真源 ⚠️ 未交付，原因见本节开头 | missing |
| G11 | 图片附件与画布引用 chip | agent composer/reference preview | adapted：媒体路径白名单 ⚠️ 未交付，原因见本节开头 | missing |
| G12 | 多标签页页面身份隔离，turn 固定发起页 | agent session/site tools + pending tests | same security outcome ⚠️ 未交付，原因见本节开头 | missing |
| G13 | 当前画布优先，不重复列表/导航 | `pending-test` | same ⚠️ 未交付，原因见本节开头 | missing |
| G14 | Skills 列表/启停/使用/新建/编辑/删除/从会话或画布生成草稿 | `agent-skills-view.tsx` | adapted：不得让 Skill 未确认推进画布 ⚠️ 未交付，原因见本节开头 | missing |
| G15 | Canvas Agent HTTP/MCP 与 Codex adapter | `canvas-agent/src/server`、agent client | adapted：决定复用当前 Codex 还是 sidecar ⚠️ 未交付，原因见本节开头 | missing |
| G16 | Claude Agent SDK adapter | upstream TODO | excluded：固定基线未交付 | n/a |
| G17 | Skill 网络安装、资源管理、Agent memory | upstream TODO | excluded：固定基线未交付 | n/a |

## H. 节点插件

> **H01–H09 全部 `missing`（2026-08-27 按代码复核改判，此前误标 full）。** 现有的只是 `CanvasPluginState`
> 一个受尺寸限制的 JSON 字段，以及节点卡上一句「插件节点」占位文案。没有插件接口、没有 SDK、没有加载器、
> 没有 sandbox / capability broker、没有官方示例。沙箱设计写在 ADR 0012，尚未实现。

| ID | 参考基线行为 | Source/runtime evidence | Parity | 交付状态 |
|---|---|---|---|---|
| H01 | 官方/本地/第三方插件管理、安装/启停/更新/卸载 | plugin manager/runtime | adapted：签名包或受信目录，不直接执行任意 URL ⚠️ 未交付，原因见本节开头 | missing |
| H02 | 远程 JS URL 安装 | `plugin-loader.ts` | adapted：相同安装体验，受 sandbox/权限控制 ⚠️ 未交付，原因见本节开头 | missing |
| H03 | manifest、节点定义、图标/描述/默认尺寸 | plugin SDK types | adapted：本项目 SDK ⚠️ 未交付，原因见本节开头 | missing |
| H04 | 自定义 renderer、panel、toolbar、interaction/move | plugin SDK + host hook | adapted：iframe/worker/host capability ⚠️ 未交付，原因见本节开头 | missing |
| H05 | 文档宣称 serialize/deserialize/migrate；运行时实际只有 JSON metadata 保存与缺失插件占位 | docs features、SDK 无迁移 hook、`MissingPluginContent` | adapted：host envelope + sandbox 原子迁移，实现完整 data-survival outcome ⚠️ 未交付，原因见本节开头 | missing |
| H06 | 插件申请文本/图片/视频 AI；音频通过内置 panel mode | `CanvasPluginAi`、`CanvasBuiltinPanelConfig` | adapted：四模态统一代理到 Job Runner ⚠️ 未交付，原因见本节开头 | missing |
| H07 | 插件结构化操作节点/边、读取资源 | `CanvasPluginHost` | adapted：capability authorization ⚠️ 未交付，原因见本节开头 | missing |
| H08 | HTML/Markdown/Panorama/Sticky/SVG 官方示例 | `plugins/canvas/*` | same examples as compatibility fixtures, Atelier visual ⚠️ 未交付，原因见本节开头 | missing |
| H09 | 插件源码离线缓存和版本固定 | plugin store/source | adapted：本地已审计包缓存 ⚠️ 未交付，原因见本节开头 | missing |
| H10 | 插件直接访问页面本地数据/API Key | 官方警告 | excluded：明确拒绝复制该安全缺陷 | n/a |

## I. 视觉与响应式基线

| ID | 参考基线行为 | Source/runtime evidence | Parity | 交付状态 |
|---|---|---|---|---|
| I01 | 顶部项目/状态/配置区，底部居中工具 dock | runtime screenshots | same spatial hierarchy + Atelier styling：375/768/1024/1440 真实 viewport 核验，见 issue 42 | full |
| I02 | 左侧资源面板、中央画布、右侧 Agent 三栏可折叠/调整 | runtime/components | same | full |
| I03 | 节点标题在卡片外上方，卡片本体承载内容 | `canvas-node.tsx`、runtime | same：标题与改名输入都跟随节点外沿，见 issue 27 | full |
| I04 | 节点工具条位于节点上方 | `canvas-node-hover-toolbar.tsx` | adapted：仅选中时显示，固定屏幕尺寸，跟随节点且不翻边、不钳位 | full |
| I05 | composer 是节点下方独立浮层并随节点移动 | prompt/config components | same：节点外 sibling 锚点随拖拽移动，反向补偿 viewport zoom 保持固定屏幕宽高与字阶，允许随节点移出视口；窄屏独立底部面板，见 issue 31 | full |
| I06 | 连接柄位于节点左右中部，边低对比 | node/connections | same behavior + Atelier colors：48px 命中区；图片、视频等内容节点即使尚未产出也保留右侧可预连 source handle，见 issue 28 | full |
| I07 | 浅/深主题、点/线/空白背景 | theme/appearance runtime | adapted：工作区浅/深主题与项目内点/线/空白背景统一收在外观菜单，见 Issue 21/39 | full |
| I08 | 画布和 Agent/左栏适配窄屏 | components + pending tests | adapted：375/768 明确可用降级 | full |
| I09 | 逐像素复制 Ant Design、白色工具条、字体与品牌色 | reference implementation detail | excluded：与“适配原项目”冲突 | n/a |

## 核对结论

固定基线共登记 **136 个核对项**（原文的「136 项 / 130 项完整交付」里，130 是错的）：

| 交付状态 | 数量 | 说明 |
|---|---|---|
| `full` | 90 | 已按 `same/adapted` 边界交付并核验 |
| `partial` | 2 | C14、D19 —— 均因产品决策主动收窄，见行内说明 |
| `missing` | 37 | 见下方「改判说明」 |
| `n/a` | 6 | 上游 TODO、占位、明确拒绝复制的安全缺陷 |
| `none` | 1 | D22 —— 按保存元数据重试已于 2026-08-26 按产品决定移除 |

已交付的部分是实的：独立画布项目、React Flow 机械层、七类节点与两类连接、四模态生成与候选、
媒体工具（裁剪 / 切分 / 蒙版 / 角度）、项目资产与提示词库、项目包安全导出导入、主题与响应式 chrome，
都接在 game-atelier 的文件真源、Job Runner 与设计系统上。

### 改判说明（2026-08-27）

原表的 `full` 是照「设计意图 / schema / 接口是否存在」判的，不是照「用户能不能用」判的。
按代码逐条复核后，37 项改判 `missing`：

- **G01–G15（15 项，整节）** Canvas Agent。只有会话文件仓库 + 4 条 CRUD 接口 + 4 个零调用方的前端函数。
- **H01–H09（9 项，整节）** 节点插件。只有一个受尺寸限制的 JSON 字段和一句占位文案。
- **F01 F04 F06 F07 F09 F10 F11（7 项）** 侧栏三 Tab / 可调宽收起、公共提示词源（含七个内置源）、
  源启停与刷新调度、设置导入导出、存储用量、WebDAV 同步。侧栏实为固定宽度的两 Tab 浮层；
  提示词只有项目内的那一份；WebDAV 只有 ADR 0010 的设计。
- **C06 C16 C17（3 项）** 分组节点（schema 有、UI 无创建入口）、侧栏节点搜索筛选、点击定位预览。
- **A06 B21 B22（3 项）** 项目多选与批量导出/删除/删除全部、清空画布二次确认、导出选中节点。

复核里也纠正了两处**反向**误报：F05（提示词搜索 / 标签 / 详情 / 复制 / 加入资产）与
F08（渠道、模型与四模态默认偏好）确有实现，`full` 是对的。

**这张表以后怎么用**：`full` 的判据是「用户能点到并得到结果」。schema、TS 类型、没有调用方的接口、
只写了 ADR 的设计，一律不算——判 `full` 之前先 grep 一次非测试代码里的调用方。

## Runtime evidence

- `evidence/01-project-index.png`：项目库空态与 Agent 首次连接面板。
- `evidence/02-empty-canvas.png`：空白画布的三栏布局、顶部与底部控件。
- `evidence/03-built-in-nodes.png`：六类一方节点与配置 composer。
- `evidence/04-image-node-hover.png`：空图片节点、下方 composer 与节点工具条的旧版运行证据；当前工具条改为点击选中后显示。
- `evidence/05-populated-image-tools.png`：有内容图片节点及默认快捷工具。
- `evidence/menu-画布外观.png`、`menu-快捷键.png`、`menu-节点插件.png`、
  `menu-打开画布菜单.png`：四类浮层实机入口。
