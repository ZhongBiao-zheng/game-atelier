# 09：规划图片与媒体工具的等价实现

Type: wayfinder:research

Status: ready-for-agent

Blocked by: 04-map-generation-capabilities, 05-resolve-project-assets-prompts-sync, 08-prototype-parity-interactions

## Question

裁剪、蒙版编辑、拆图、本地放大、AI 超分、角度生成、反推提示词、替换、自由缩放、下载和保存
资产，哪些是浏览器本地变换，哪些必须生成新文件/Job；每次操作如何留下可恢复的来源和版本？

## Deliverable

- 每个工具的输入、输出、库/模型、文件落点、Job 类型、撤销和元数据方案。
- 大图内存、EXIF、透明通道、视频/音频下载、CORS 和异常恢复评估。
- 优先复用现有依赖；确需新增库时提供维护度、许可证和 bundle 成本。
- 与参考行为逐项一致的验收用例。
