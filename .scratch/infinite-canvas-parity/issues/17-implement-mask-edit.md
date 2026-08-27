# 17：实现图片蒙版局部编辑

Type: implement

Status: completed

Blocked by: 06-implement-generation-run-lifecycle, 14-implement-local-media-operations,
16-implement-reverse-prompt

## Goal

让任意已有图片节点在浏览器中绘制局部编辑蒙版，并以受控 Image Run 生成独立图片结果；源图片、蒙版、
prompt、模型和参数全部冻结进不可变 Snapshot，原设置重试不重新上传蒙版。

## Included

- 浏览器蒙版 Dialog：画笔、橡皮擦、笔刷大小、清空、撤销/重做、prompt、兼容图片模型与 1–4 候选。
- `POST /canvas/projects/{project_id}/runs/mask-edit` multipart 入口只接收 source node、revision、候选数与
  PNG mask；prompt/model/alias/params 由已保存的 Source Draft 解析。
- 服务端把浏览器蒙版归一为与源图同尺寸的单通道 PNG，校验真实格式、像素、非空编辑区域与源版本所有权。
- 仅允许已验证的 GPT Image + OpenAI-compatible `/images/edits` 路径；不支持时返回稳定
  `canvas_media_capability_missing`，不回退整图编辑。
- mask Content Version origin 为 `user_mask`，Snapshot 冻结 source version 与 `mask_version_id`；Job、结果
  占位节点、连接和 mask 文件使用同一可恢复事务提交。
- original retry 精确复用原 source/mask version；停止、候选与结果切换沿用普通 Run 生命周期。

## Adaptation decision

参考实现的浏览器只负责可丢弃画笔交互；文件真源、模型调用和结果提交仍由 viewer-server/Job Runner
负责。浏览器绘制语义为“涂黑的区域需要编辑”，服务端保存灰度 mask；caller 按 OpenAI 官方要求把灰度值
写入 RGBA alpha 后作为 multipart `mask` 发送。GPT Image 对 mask 是提示性约束，界面明确不承诺像素级硬边。

## Excluded

- AI 超分、多角度、视频编辑与快捷工具偏好（后续 E10/E14/E12）。
- 浏览器传入裸路径、provider、任意模型参数或绕开 Source Draft 直接提交 prompt/model。
- 修改旧 Canvas v1 测试或当前工作区其他任务的测试文件。

## Exit gate

- mask version 与源图尺寸一致且非空；错误 MIME/尺寸/空 mask/跨项目/不支持模型/revision conflict 全部零写。
- Snapshot 只有唯一 source input，并冻结 mask version；caller multipart 同时包含 image 与带 alpha 的 mask。
- original retry 使用同一 source/mask version，结果节点和 generation-run Derivation Connection 不重复。
- 真实页面核对鼠标/触控画笔、撤销重做、prompt/model、运行反馈、结果节点与连接。
- Ruff、设计守卫、生产构建通过；源码不新增 TypeScript 错误，代码审查 P1/P2 清零。

## Verification

- 隔离 Domain / ASGI smoke：PNG 真格式、同尺寸、非空编辑区、源文件指纹、GPT Image 能力边界、
  Snapshot 唯一源输入、mask Version、事务提交与 original retry 均通过。
- 真实页面：图片节点工具入口、独立蒙版 Dialog、画笔/橡皮擦/大小/清空/撤销重做、模型参数、运行反馈、
  结果节点与 generation-run Derivation Connection 均通过；控制台无 error/warn。
- 模拟 OpenAI-compatible 服务确认请求命中 `/v1/images/edits`，multipart 同时包含归一化 PNG `image`
  与 RGBA alpha `mask`；结果 Job 状态为 DONE。
- Ruff、源码 TypeScript、设计守卫 8/8、Vite production build 与 diff check 均通过；双轴审查未发现
  P1/P2。
- 全量基线为 Python 939 passed / 13 failed / 3 skipped，Web 381 passed / 22 failed；失败集中于旧
  Canvas v1 测试桩与既有模型分类契约，按本 issue Excluded 未修改测试文件。
