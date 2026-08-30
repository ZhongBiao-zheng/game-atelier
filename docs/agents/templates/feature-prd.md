# <Feature name>

Contract status: proposed
Prototype status: not-started
Branch: codex/<feature-slug>
PR: none

## Problem

描述用户当前遇到的问题、发生场景和为什么值得解决。不要把预设方案当成问题。

## Success

- 用户完成什么结果才算问题被解决。
- 用什么实际行为或证据验证。

## Product Contract

### Object

用户认为自己在维护什么？对象由谁拥有？

### Create

如何创建？哪些行为必须显式触发？哪些行为绝不自动发生？

### Edit

编辑是原位覆盖、复制还是产生版本？元数据与内容是否相同？

### Use

使用是复制还是持续引用？后续编辑是否影响已经使用的结果？

### Delete

删除、归档和恢复的语义是什么？是否可逆？

## Invariants

- <任何实现都不能破坏的规则>

## Included

- <第一版明确包含的能力>

## No-gos

- <第一版明确不做的内容>

## Complexity Budget

写明第一版允许投入的实现范围或迭代次数，以及超出预算时优先裁掉什么；不要用预算替代质量底线。

## Riskiest Assumptions

| Assumption | Why risky | Cheapest evidence | Result |
|---|---|---|---|
| <需要尽早验证的假设> | <错了会造成什么返工> | <breadboard / 原型 / probe> | pending |

## Core Flow

用简洁的 breadboard 表达入口、关键元素、动作和结果。

```text
Entry
  → Element
  → Action
  → Result
```

## State Matrix

| Surface | State | Trigger/data | Expected result | Prototype | Test |
|---|---|---|---|---|---|
| <Studio/Canvas/...> | <empty/list/detail/edit/...> | <条件> | <用户看到和能做什么> | pending | pending |

## Vertical Slices

1. <第一个可运行的端到端闭环>
2. <在闭环上增加的下一层能力>

## Decision Changes

规则一旦被确认，后续变化不能静默覆盖；记录旧规则、新规则、影响面和确认结果。

| Date | Old rule | New rule | Impact | Confirmed by |
|---|---|---|---|---|
| — | — | — | — | — |

## Acceptance

- [ ] Product Contract 与最终实现一致。
- [ ] Included 全部可在真实产品中验证。
- [ ] No-gos 没有被实现或留下隐藏入口。
- [ ] State Matrix 的相关状态已验证。
- [ ] PR 描述与当前 PRD 一致。
- [ ] `make verify` 与 CI 通过。
- [ ] 用户明确授权后才合并。
