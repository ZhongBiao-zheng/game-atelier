# 01：冻结参考基线与逐项验收表

Type: wayfinder:research

Status: ready-for-agent

Blocked by: none

## Question

在固定 commit `9414048f9d0a099386aa15d81bedb5376b79ee61` 上，用户实际可操作的全部
页面、节点、工具、快捷键、状态和错误路径是什么；每一项应如何以可重复步骤证明 parity？

## Deliverable

- 一份带源码定位、操作步骤和截图证据的 parity matrix。
- 每项标记 `same / adapted / excluded`，`adapted/excluded` 必须记录原因与批准人。
- 区分已交付功能、实验入口、失效入口和 README/TODO 中的未来能力。
- 记录参考项目的许可证、attribution 和不可复用品牌素材。

## Exit gate

只有 matrix 经人工确认后，后续票才能用“全部功能”作为稳定验收基线。

## Result

- 完整核对表：`../reference-parity-matrix.md`
- 实机证据：`../evidence/`
- 基线健康结论：生产构建成功；TypeScript 有 1 个现存错误；AI 超分只是“暂未实现”占位；
  Claude Agent SDK 与 Skill 网络安装/资源/记忆属于未来 TODO。
- 发现并剔除误报：固定基线没有“复制整个画布项目”功能，只有复制节点。

## Comments

- 2026-08-23：用户确认 131 项进入 same/adapted，5 项上游 TODO/占位/安全缺陷/品牌实现排除；
  基线已冻结，可供后续任务使用。
