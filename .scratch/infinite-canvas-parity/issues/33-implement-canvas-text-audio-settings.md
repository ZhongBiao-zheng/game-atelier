# 33：补齐文本与音频高级参数弹窗

Type: implement

Status: completed

Blocked by: 32-implement-canvas-model-media-settings

## Goal

补齐 D12/D14：将文本推理强度、文本候选数，以及音频音色、格式、速度和 instructions
收进跟随节点触发器的独立弹窗，并保证 Canvas Snapshot、Job schema 与实际调用协议一致。

## Included

- 文本设置弹窗参考固定基线提供 auto/low/medium/high/xhigh 与 1–4 个候选。
- 只有明确使用 `openai-responses` 的文本模型展示并发送 reasoning effort；auto 不发送参数。
- 新增 `openai-responses` 文本调用与响应解析，保留既有 `openai-chat` 调用。
- 音频设置弹窗提供参考项目的 13 个音色、6 种格式、速度预设/自定义值与 instructions。
- 音频速度限制 0.25–4、两位小数；空 instructions 不进入 Snapshot 与请求。
- 模型切换删除旧协议不支持或其他模态遗留的参数；所有设置变更进入撤销/重做历史。

## Excluded

- Gemini 文本/音频、自定义生成脚本、音乐生成、声音克隆、ASR。
- 文本流式渲染、全局默认偏好、跨节点批量设置。
- 放宽当前项目文本 1–4 候选及音频单结果的执行上限。

## Exit gate

- 文本/音频参数均从节点面板摘要按钮打开独立 portal 弹窗，并随触发器定位。
- UI 只显示真实协议支持的能力；模型切换与服务端冻结会再次归一化。
- reasoning、voice、format、speed、instructions 从 UI 到 caller 有聚焦测试。
- 类型检查、设计守卫、生产构建、全量基线、真实浏览器与代码审查完成。

## Verification

- Web 聚焦测试 42/42 通过；Python 聚焦测试 37/37 通过；相关 Ruff 与设计守卫通过。
- 全量 Python：8 failed / 962 passed / 3 skipped；全量 Web：22 failed / 441 passed / 13 errors。失败均为既有 Canvas v1/旧 Key 基线，本阶段没有新增失败。
- Vite production build 与 dist 归一化通过；`pnpm build` 仅被既有 Canvas v1 测试类型错误阻塞，本阶段源码无新增类型错误。
- 真实浏览器验证文本独立 portal 的节点跟随、定位与焦点；当前用户 Key 未配置文本/音频模型，完整参数交互由聚焦测试覆盖。
- Spec 与 Standards 双轴复审完成，P1/P2/P3 清零；D12、D14 parity gap 更新为 `none`。
