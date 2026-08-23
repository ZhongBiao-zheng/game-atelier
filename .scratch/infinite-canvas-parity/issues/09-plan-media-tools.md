# 09：规划图片与媒体工具的等价实现

Type: wayfinder:research

Status: ready-for-human

Blocked by: 04-map-generation-capabilities, 05-resolve-project-assets-prompts-sync, 08-prototype-parity-interactions

## Question

裁剪、蒙版编辑、拆图、本地放大、AI 超分、角度生成、反推提示词、替换、自由缩放、下载和保存
资产，哪些是浏览器本地变换，哪些必须生成新文件/Job；每次操作如何留下可恢复的来源和版本？

## Deliverable

- 每个工具的输入、输出、库/模型、文件落点、Job 类型、撤销和元数据方案。
- 大图内存、EXIF、透明通道、视频/音频下载、CORS 和异常恢复评估。
- 优先复用现有依赖；确需新增库时提供维护度、许可证和 bundle 成本。
- 与参考行为逐项一致的验收用例。

## Proposal

- 完整方案：`../canvas-media-tools-proposal.md`
- proposed ADR：`../../../docs/adr/0013-run-canvas-local-media-tools-on-server.md`
- 推荐方案 A：浏览器负责交互预览，Pillow 服务端负责确定性变换，AI 派生只进 Job Runner。

## Evidence

- 固定参考仓库 `9414048f` 的 crop/split/upscale/mask dialog、`canvas-image-data.ts` 与项目页调用链已核对。
- 参考实现 crop/split/upscale 最终均以浏览器 Canvas 输出 PNG，再上传并追加节点/连接。
- 本项目当前无图像处理依赖；媒体上传只有 10 MiB 静态图限制，Canvas 文件访问已按项目与 Job 白名单。
- Pillow 12.3.0（2026-07-01）支持 Python 3.11+、MIT-CMU，服务端引入不会增加 Web bundle。
- Pillow 依据均为官方一手来源：releasenotes、项目 pyproject classifier 与 LICENSE；链接见完整方案。

## Comments

- 本票只完成架构与实施门，不把媒体工具继续堆在待删除的 Canvas v1 resource/path 上。
- 方案确认前不改写 `CONTEXT.md`、已接受 ADR 或 ready-for-agent 的 Domain/Schema；所需 schema 修订已在
  完整方案中列为确认后的同一 Foundation change set。
- 方案确认后接受 ADR-0013，并先执行 schema v2 Foundation，再落 hover toolbar/read-only tools。
