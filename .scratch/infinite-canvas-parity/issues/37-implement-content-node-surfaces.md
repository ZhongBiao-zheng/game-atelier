# 37：补齐四类内容节点表面

Type: implement

Status: completed

Blocked by: 27-implement-node-title-inline-rename, 29-implement-node-hover-toolbar,
30-implement-node-run-status-retry, 31-implement-node-generation-panel

## Goal

关闭固定参考基线 C01–C04 的剩余差异，让文本、图片、视频和音频节点本体都能直接承载其内容，
而不是依赖右侧检查器或统一的占位文案。

## Reference boundary

- 固定参考：`basketikun/infinite-canvas@9414048f9d0a099386aa15d81bedb5376b79ee61`。
- 学习 `canvas-node.tsx` 的节点模型与用户可观察结果，不复制 Ant Design、颜色、阴影或自研画布实现。
- 保留 React Flow、Canvas Document v2、不可变 Content Version、Job Runner 和 Atelier 设计系统。

## Acceptance

1. 文本节点双击正文进入节点内编辑；输入即时更新当前人工版本，Esc/失焦退出，进入一次只记一条撤销快照。
2. 文本节点工具条提供明确的“编辑文本”入口；编辑器有原生滚动与文本选择，不触发节点拖拽或画布快捷键。
3. 图片、视频、音频空节点有各自图标、文案和同模态上传入口；上传仍走既有服务端 Version 事务。
4. 有内容图片遵循 contain/cover 与自由变形显示；有内容视频、音频在节点内提供原生播放控件，并继续按接近视区惰性绑定媒体 URL。
5. 媒体控件操作不触发节点预览、拖拽或连接；媒体双击空白区域仍打开详情。
6. 375/768/桌面、8%–250% 缩放下节点内容不溢出；样式只使用 Atelier token/配方。
7. C01–C04 gap 归零；聚焦测试、TypeScript、设计守卫、production build、真实浏览器与代码审查通过。

## Non-goals

- 不新增富文本、Markdown 编辑器或时间线。
- 不在这一票新增模型能力、生成协议或 Content Version schema。
- 不修改既有 Canvas v1 测试债与用户工作树文件。

## Rollback

本票只修改节点表面组件、聚焦测试、矩阵与记录；回滚该提交即可恢复上一阶段，不影响已落盘文档和媒体。

## Verification

- 文本节点内编辑、单次历史快照、Esc/失焦退出与 `xs/sm/base` 离散字号已通过聚焦测试。
- 图片/视频/音频独立空态、同模态上传、图片/视频 display 以及视频/音频原生控件已通过组件测试。
- 375/768/桌面真实浏览器无水平溢出，文本编辑撤销恢复正确，控制台无 warning/error。
  缩放极值实测到 8% / 250%：两端根视口均无水平溢出，可见节点表面保持 `overflow-hidden`；验收后已恢复用户原 50%。
- Web 聚焦 52/52、Python 画布 v2 聚焦 29/29、Ruff、设计守卫、源码 TypeScript 与 Vite production build 通过。
- 全量 Python：8 failed / 988 passed / 3 skipped；全量 Web：22 failed / 463 passed / 13 errors。
  失败数与上阶段相同，通过数的增量均来自本票新增测试；仍是既有 Canvas v1、旧 Key 结构和旧 fixture 基线。
- Standards / Spec 双轴审查完成：节点外壳改为可聚焦 `group` 以保留内嵌控件语义；视频正确消费 `display.fit/free_resize`；C01–C04 已归零。
- `CanvasEditorViews.tsx` 的内容表面拆分列入后续结构整理；它不阻断本票用户可观察结果。
