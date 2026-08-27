# 画布审查 · 剩余待修清单

来源：2026-08-26 无限画布验收账（31 条）。P0 4 条 + 前五条已修完并合入工作区改动。
本文件只列**尚未修**的 20 条，按「先修什么」排序。每条已用 grep 复核过当前代码状态。

## A 组 · 会真丢东西 / 功能是死的 —— ✅ 全部已修（2026-08-27，未提交）

| # | 问题 | 位置 | 级别 | 现状复核 |
|---|---|---|---|---|
| A1 | 节点拖大过 4000px 后自动保存永久 422，界面却报「保存冲突，内容已保留」 | `CanvasEditor.tsx:954` `completeNodeResize` | high | ✅ 已修：`clampCanvasNodeSize` + NodeResizer `maxWidth/maxHeight`；保存失败文案改成「保存失败 · 重试」并显示服务端 detail |
| A2 | 配置节点的视频首尾帧整条链路是死的：UI 按 `draft.mode` 渲染，handler 按 `node.type` 拒绝 | `CanvasEditor.tsx` 首尾帧 handler | high | ✅ 已修：handler 改用 `generationDraftForNode(target)?.mode`，与渲染侧同一判据；浏览器实测首帧连线落盘 |
| A3 | 画布平移缩放进撤销栈，Ctrl+Z 撤的是镜头，还会把内容编辑挤出 50 条上限 | `CanvasEditor.tsx:2054` `commitViewportDocument` | high | ✅ 已修：视口不再进历史，撤销也不再还原镜头；撤销/重做禁用态改读 state |
| A4 | 轮询用整体赋值写 jobs，覆盖刚提交的 job，最坏把轮询自己停掉 | `CanvasEditor.tsx:741` | medium | ✅ 已修：轮询发请求前拍 epoch，响应落地时 epoch 变了就走 `acceptCanvasJobs` 并入 |
| A5 | 空节点可以先连线，服务端在 `all_connected` 下整单拒绝，报错不指名是哪个节点 | `canvasEditorModel.ts:62` `canvasNodeProvidesOutput` | medium | ✅ 已修：前端 `canvasPendingInputNodes` 在按钮上拦住并指名；服务端错误也改成指名版本 |

## B 组 · 承诺落空 / 首次使用（5 条）

| # | 问题 | 位置 | 级别 | 现状复核 |
|---|---|---|---|---|
| B1 | 全新用户在沉浸式画布里是死路：没密钥时生成按钮无原因禁用，顶栏（含设置入口）被整块隐藏 | `AppShell.tsx:77-82` | medium | 确认未修：`immersiveCanvas` 匹配 `/canvas/<id>` 时 header 不渲染；模型下拉里已有「请先在设置中配置密钥」文案，但没有出口 |
| B2 | Shift / ⌘ 点击追加选择被 `selectOnlyNode` 打平，快捷键面板承诺的多选方式失效 | `CanvasEditor.tsx:3307` | medium | 确认未修：`onNodeClick` 无条件调 `selectOnlyNode` |
| B3 | 反推提示词完成后自动创建配置节点、抢走选中态，删掉后刷新会复活 | `CanvasEditor.tsx:2354` 附近 | medium | 未复核细节 |
| B4 | 生成按钮 5 个禁用条件（4 种引用错误 + 无密钥 / 无模型），界面对哪一个都不解释 | `CanvasEditorViews.tsx:1963` | low | 部分修：引用错误文案已加；按钮本身仍无 `title` / `aria-describedby` |
| B5 | 新建的空画布没有任何空状态引导 | `CanvasEditor.tsx:3220` 附近 | low | 确认未修：全仓 grep 不到画布空状态文案 |

## C 组 · 性能（6 条）

| # | 问题 | 位置 | 级别 | 现状复核 |
|---|---|---|---|---|
| C1 | `contextValue` 混入 `viewportZoom` / `content_versions`，缩放和打字穿透 memo 重渲染所有节点卡 | `CanvasEditor.tsx:3060` 附近 | medium | 确认未修：`viewportZoom` 仍在同一个 `useMemo` 里 |
| C2 | async 路由里直接调同步阻塞的包导入 / 上传，冻住整个事件循环（含 SSE） | `routes.py:2145` | medium | 确认未修：同文件 2704 行的媒体路由用的是 `run_in_threadpool`，是内部不一致 |
| C3 | 节点缩略图直接用原图，缩放到全局会一次性拉满分辨率原图 | `web/src/api/canvas.ts:344` | medium | 未复核细节；200 节点时是 200 张全分辨率原图同时解码 |
| C4 | `flowEdges` 依赖 `document.nodes` + `activeNodeId`，每帧 / 每键 / 每次 hover 重建全部连线 | `CanvasEditor.tsx:991` | low | 未复核细节 |
| C5 | `onNodesChange` 里逐 change 做 `nodes.map`，多选拖动是 O(n²) 且每帧都跑 | `CanvasEditor.tsx:1022` | low | 未复核细节 |
| C6 | 画布完全没接现有 SSE，改用 1.2s 轮询，每次后端做两遍全量 job 目录扫描 | `CanvasEditor.tsx:704-747` | low | 确认未修。另：`canvasMentionGraphSignature` 每次 render 都 `JSON.stringify` 全图 |

## D 组 · 工程链与文档（4 条）

| # | 问题 | 位置 | 级别 | 现状复核 |
|---|---|---|---|---|
| D1 | 仓库没有 ESLint，`react-hooks/exhaustive-deps` 从未跑过 | `web/package.json` `"lint"` | medium | 确认未修：`pnpm lint` 只是 `tsc -b --noEmit`；画布里有 55 项手维护依赖数组（已有一个缺口） |
| D2 | `CanvasEditorInner` 单组件 3408 行、176 个 hook 调用点 | `CanvasEditor.tsx:312–3720` | medium | 确认未修。已产生后果：两个 run status 映射器文案分歧、同一 helper 两处实现 |
| D3 | parity matrix 声称 130 项全 full，但七组能力在代码里找不到实现 | `reference-parity-matrix.md` | medium | 未复核。Canvas Agent G01–G15 / 节点插件 H01–H09 / WebDAV F04–F11 / C16 C17 / C06 / B22 / A06 / B21 |
| D4 | 后端 30+ 处英文 `ValueError` 直接当 detail 返回给用户，409 语义还错了 | `canvas_projects.py:222` | low | 确认未修：同批路径里 `CanvasRunCommandError` 走的是规范 `{code, message}` 中文结构，两套风格并存 |

## 已修（未提交）

**第一批**：P0 × 4 · 密钥读取（两道白名单闸）· 生成中删节点拦截 · 卸载/刷新 flush + wouter Link ·
面板视口 clamp（portal + chrome inset）· `type:'bezier'` → `'default'` · 拖文件上传 · 375px 叠字

**第二批（A 组 5 条）**：见上表。7 条回归测试，每条都验过「把修复改回去会红」。

## 留给飙哥定的一条

`canvasNodeProvidesOutput` 里 audio 不在按类型放行之列：空的音频节点连不上线，空的文本 / 图片 /
视频节点可以。这条差异没有记录理由，`canvasConnectionPolicy.test.ts` 有断言钉死。按 A5 的口径
（先连线后出图）它应该一致，但那是产品判断，没动。
