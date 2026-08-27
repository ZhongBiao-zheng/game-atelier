# 32：补齐节点模型与媒体参数弹窗

Type: implement

Status: completed

Blocked by: 31-implement-node-generation-panel

## Goal

补齐 D10/D11/D13：将节点生成面板里的模型、图片参数与视频参数改为跟随触发器的独立弹窗，
并让前端可见控件、Canvas Snapshot、Job schema 与实际厂商请求保持同一套真实能力边界。

## Included

- 密钥与模型合并为一个模型选择弹窗，按密钥分组展示当前模态可用模型；不再使用内联原生 select。
- 图片设置使用独立摘要按钮与弹窗，按模型能力显示比例、分辨率、自定义尺寸、质量、透明背景、候选数。
- Midjourney 固定四张且不可编辑；其余图片保留 1–4 个候选，不显示常驻 `1x`。
- 视频设置沿用现有独立弹窗，补齐真实支持的水印开关；Seedance 与 HappyHorse 可配置，其他模型隐藏。
- `background` / `watermark` 纳入 TS、Pydantic、Canvas 参数归一化与对应 caller；不向不支持的厂商发送。
- 手机端复用同一套控件与能力判断。

## Excluded

- 新增厂商能力、全局默认偏好、参考素材协议、文本高级参数与音频高级参数重构。
- 右键菜单、批量节点设置、节点检查器或 Generation Snapshot 结构变更。

## Exit gate

- 模型、图片与视频参数均从节点面板内的摘要按钮打开独立 portal 弹窗，并随触发器定位。
- 所有选项只在 capability matrix 声明支持时出现；模型切换会删除旧模型不支持的参数。
- 图片候选数、像素尺寸、透明背景和视频水印从 UI 到 caller 有聚焦测试。
- 聚焦测试、设计守卫、类型检查、生产构建、全量基线、真实浏览器与代码审查完成。

## Verification

- Web 聚焦：模型/图片/视频设置、能力矩阵、参数归一化、键盘焦点、撤销/重做与设计守卫通过。
- Python 聚焦：schema、Canvas 服务端归一化及图片/视频 caller 共 160 项通过。
- 生产构建通过；真实浏览器确认 portal 跟随节点、完整落在视口内，首项焦点与 Esc 回焦正确。
- 全量基线未新增失败：Python 为 13 failed / 950 passed / 3 skipped，Web 为 22 failed / 434 passed / 13 errors；失败均为既有 Canvas v1、Keys 与 changelog 陈旧测试。
- 双重代码审查 P1/P2 清零；D10、D11、D13 parity gap 更新为 `none`。
