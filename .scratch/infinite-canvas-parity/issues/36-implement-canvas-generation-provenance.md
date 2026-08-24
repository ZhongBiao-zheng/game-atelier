# 36：补齐生成记录、快照重试诊断与服务端网络提示

Type: implement

Status: completed

Blocked by: 35-implement-canvas-candidate-batches

## Goal

补齐 D21、D22、D24：让每个 AI 结果的不可变 Generation Snapshot 在详情中可读；按原设置重试时
继续严格复用快照，并把引用丢失、引用被改、模型不可用等失败原因变成可行动提示；按照本项目的
服务端直连架构，明确区分本地 viewer-server 连接失败、厂商网络失败与错误 API 地址 / CORS 响应。

## Included

- 结果详情展示最终提示词、模型、provider、alias、完整归一化参数、引用节点与引用 Version。
- 引用节点已从当前画布删除时，历史记录仍显示冻结的 node/version 标识，不伪装成当前可用。
- 展示 caller 回写的实际尺寸与 warnings，并与提交时请求参数分开。
- API Error 保留服务端稳定 `code`、HTTP status 与 recovery，不再只剩一段拼接文案。
- 原设置重试对 Snapshot 输入 / 蒙版缺失或变化、模型不可用给出明确下一步；不自动回退当前设置。
- 厂商 CORS / cross-origin、泛化 network error、DNS / TLS 等错误按“服务端直连”架构解释。

## Excluded

- 在浏览器中直连任何厂商 API，或复制参考项目的任意脚本执行模型。
- 修改已经提交的 Snapshot、用当前节点偷偷替换缺失引用、自动切换模型。
- 把本地绝对路径、密钥或完整原始请求体暴露到结果详情。
- 本阶段重构所有 Job 错误为新的持久化结构；保留现有 Job `error` 真源。

## Exit gate

- AI 结果详情能完整回答“当时用什么提示词、模型、参数和哪些引用生成”。
- 原设置重试缺引用时显示原设置不可复现，并明确可检查历史输入或改用当前设置再生成。
- 稳定错误码从 FastAPI 传到 React，不依赖中文文案反向解析。
- 网络 / CORS 类厂商错误明确说明请求发生在 viewer-server，不误导用户排查浏览器跨域。
- 聚焦测试、全量测试、设计守卫、生产构建和真实浏览器核对完成。

## Verification

- Web 聚焦 46/46、Python 聚焦 46/46、Ruff 与设计守卫通过。
- 全量 Python：8 failed / 982 passed / 3 skipped；全量 Web：22 failed / 459 passed / 13 errors。
  失败均为既有 Canvas v1、旧 Key 返回结构与旧测试 fixture 基线，本阶段没有新增失败。
- Vite production build 与 dist 归一化通过；源码类型仍只被既有 Canvas v1 测试类型错误阻塞。
- 真实 5174 画布验证最终提示词、模型、厂商、别名、请求参数、冻结引用与独立执行结果；
  控制台无 warning/error，验证后返回用户原画布且未改数据。
- Standards / Spec 双轴多轮对抗复审完成；本机路径、URL userinfo、全部 HTTP query value、
  JSON/转义 JSON 与常见 header 凭证均脱敏，同时保留 task_id；最终 P1/P2/P3 清零。
- D21、D22、D24 parity gap 更新为 `none`。
