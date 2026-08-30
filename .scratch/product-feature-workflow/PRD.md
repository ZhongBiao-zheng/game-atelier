# 产品功能开发闭环

Contract status: confirmed
Prototype status: not-needed
Branch: codex/product-feature-workflow
PR: none

## Problem

仓库已有本地 Issue、ADR、测试和 CI，但缺少把产品判断、风险原型、规则变化、分支范围和交付验证串联
起来的统一入口。复杂功能容易在抽象问答后过早实现，反馈中的领域变化也可能被当成普通 UI 调整，
无关请求还会污染同一个 PR。

## Success

- 下一次重要产品功能开始时，Agent 会先建立并确认 Product Contract。
- 产品规则变化能被显式记录并同步到实现和 PR，而不是静默覆盖。
- 当前请求超出 PRD 范围时会切换到独立分支或 worktree。
- 本地有一个与 CI 关键步骤等价的交付验证入口。

## Product Contract

### Object

仓库维护一套产品功能工作包：一份当前 PRD、一个实施日志、若干纵向 Issue，以及对应代码 PR。

### Create

重要用户可见功能、跨界面功能或涉及新领域对象/Schema/迁移时，从 Feature PRD 模板显式建立；普通
Bug、文案和单点样式修改继续走轻量流程。

### Edit

PRD 原位维护当前产品事实；已确认规则发生变化时，必须追加 Decision Changes，再同步 Issue、ADR 和
PR 描述。

### Use

Agent 通过 `CLAUDE.md` 入口读取工作流。实施按风险原型和纵向切片推进，交付统一运行 `make verify`。

### Delete

工作包随 PR 保留用于审计；PR 合并后只删除功能分支，不删除已提交的需求与决策记录。

## Invariants

- 流程帮助暴露风险，不能为了填模板重复询问已经明确的内容。
- 未经用户明确授权，不合并重要功能 PR。
- 无关任务不进入当前功能分支。

## Included

- 产品功能工作流文档。
- Feature PRD 与 execution log 模板。
- Issue tracker、Agent 入口和 PR 模板接线。
- `make verify` 本地交付守门。

## No-gos

- 本轮不安装 Storybook、Playwright 或外部项目管理系统。
- 不尝试用脚本自动判断业务语义是否超出 PRD。
- 不修改现有产品功能或生产数据。

## Complexity Budget

第一阶段只修改工作流文档、模板、Agent 入口和本地验证命令；不增加运行时服务、前端依赖或业务 Schema。
若无法用现有 `.scratch` 和 Makefile 完成，则先停下来重新确认范围，不自行扩建平台。

## Riskiest Assumptions

| Assumption | Why risky | Cheapest evidence | Result |
|---|---|---|---|
| 仓库现有 `.scratch` 足以承载产品契约 | 若另建系统会形成双重事实源 | 对照现有 issue tracker 与 ADR | confirmed |
| 分支语义范围适合人工硬门而非自动猜测 | 自动判断业务语义容易误报 | 在 Agent 入口与 PR 模板双重提醒 | confirmed |
| 第一阶段无需视觉测试框架 | 新依赖会扩大本轮范围 | 先固定状态矩阵与真实页面验证 | confirmed |

## Core Flow

```text
Request
  → Scope isolation
  → Product Contract
  → Risk prototype when needed
  → First vertical slice
  → Feedback classification
  → make verify
  → Review-only PR
  → Explicit merge authorization
```

## Decision Changes

| Date | Old rule | New rule | Impact | Confirmed by |
|---|---|---|---|---|
| — | — | — | — | — |

## Acceptance

- [x] 新会话可以从 Agent 入口发现工作流。
- [x] 模板覆盖 Product Contract、风险、状态矩阵、No-gos 和 Decision Changes。
- [x] Issue 与 PR 指南要求范围隔离和描述同步。
- [x] `make verify` 可以实际运行并捕获过期 `web/dist`。
- [x] 本 PR 不包含现有产品功能修改。
- [ ] 用户明确授权后才合并。
