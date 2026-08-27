# 04：把全部生成行为映射到现有模型与 Job

Type: wayfinder:research

Status: ready-for-agent

Blocked by: 02-resolve-canvas-domain-v2, 03-design-schema-v2-and-cutover

## Question

参考项目的文本、图片生成/编辑、视频、音频、批量结果、重试、自定义参数和自定义调用脚本，
分别如何落到现有 capability matrix、keys、callers、Canvas Job、SSE 和输出目录，而不允许浏览器
直连模型或另建执行器？

## Deliverable

- “参考生成动作 → 本项目 capability/protocol/job params/output” 映射表。
- Generation Snapshot、重试、缺失引用、取消、失败、部分批次成功的状态设计。
- 需要新增 caller/protocol 的清单；无法安全等价的自定义脚本能力单独列决策。
- 成本/并发/超时/错误翻译与回归测试方案。

## Proposal

- 生成映射与状态方案：`../canvas-generation-mapping-proposal.md`
- proposed ADR：`../../../docs/adr/0009-route-all-canvas-generation-through-jobs.md`
- 推荐方案 A：四模态统一 Job/Snapshot/candidate；新增 text/audio caller registry；取消与部分成功进入
  Job 状态；自定义脚本适配为受控服务端 caller adapter。

## Decision required

131 项矩阵包含批量候选，但早期反馈要求删除“1x/数量功能”。推荐规则演化为：节点不常驻显示“1x”，
图片/文本设置内仍提供按模型真实上限裁剪的批量候选，默认 1。

## Comments

- 2026-08-23：用户确认方案 A。保留批量候选能力，但不恢复节点常驻“1x”；四模态统一走
  Job/Snapshot/candidate，ADR-0009 转 accepted。
