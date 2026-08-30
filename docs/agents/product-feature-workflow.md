# Product feature workflow

本流程用于重要的用户可见功能、跨 Studio/Canvas 等多界面功能，以及会引入新领域对象、Schema 或
数据迁移的改动。单点 Bug、文案和纯样式微调走普通开发流程，不强制原型关卡。

目标不是增加文档，而是把最贵的返工提前到问题定义和原型阶段。每个功能只维护一份
`.scratch/<feature-slug>/PRD.md` 作为当前产品事实；Issue、实现、测试和 PR 都必须引用它。

## 0. Scope isolation

开始工作前先检查当前分支、已有 PR 和对应 PRD：

1. 当前请求属于现有 PRD 的 Included 范围，才允许继续使用当前功能分支。
2. 请求落在 No-gos 或其他产品域，必须从 `origin/main` 新建分支或 worktree。
3. 不得为了省切分成本，把无关 Bug、重构、计价或构建修改混入当前功能 PR。
4. 未推送但有价值的工作先保存到命名明确的 WIP 分支，再切换任务；不得丢弃或塞进 `main`。

功能分支默认命名为 `codex/<feature-slug>`，并在 PRD 顶部记录实际分支名。

## 1. Shape the product contract

从 `docs/agents/templates/feature-prd.md` 建立 PRD。提问只用于填补 Product Contract 的空白或解决
冲突，不按编号无限追加选择题。

Product Contract 必须回答：

- Object：用户认为自己在维护什么？谁拥有它？
- Create：如何创建？哪些行为绝不能自动发生？
- Edit：编辑是原位覆盖、复制还是产生版本？
- Use：使用是复制还是持续引用？既有结果是否会变化？
- Delete：删除、归档和恢复分别是什么语义？

同时写清 Invariants、No-gos、Riskiest assumptions 和复杂度预算。`Contract status` 未变成
`confirmed` 前，不得写生产 Schema、迁移或完整业务实现。

如果用户一开始已经给出完整、无冲突的规格，可以直接整理成 Product Contract，请用户确认一次；
不要为了走流程重复询问已经明确的内容。

## 2. Prototype the risky flow

先用 breadboard 描述入口、关键元素、连接和结果，再只为风险最高的交互制作真实上下文原型。
原型应使用真实页面位置、真实组件密度、长文案和已有设计 token，不需要覆盖整个产品。

State Matrix 至少检查相关状态：

- empty / list / detail / edit
- loading / error / destructive confirmation
- default / hover / focus / disabled
- 长文本、多标签、滚动和窄宽度
- 功能涉及的每个真实界面，例如 Studio 与 Canvas

用户确认后把 3–6 张关键状态截图或文字结论留在 PRD，更新 `Prototype status: confirmed`。
一次性原型代码应在正式交付前删除，不能成为生产路径或第二套实现。

当功能没有关键交互或原型不会降低风险时，可以在 PRD 记录原因并标为 `not-needed`。

## 3. Build one vertical slice

第一批实现必须是一个可运行、可测试、可供用户实际体验的最小闭环，而不是先横向铺满所有后端或前端：

1. 一种核心对象。
2. 一个真实入口。
3. 一条 Create → Use 或 Edit → Result 链路。
4. 对应测试和实际页面验证。

用户体验第一片后，再扩展其他对象、界面、迁移和边界状态。每个 Issue 应描述一个自洽的纵向结果，
而不是只写“完成后端”“完成前端”。难以逆转的领域决策在 Product Contract 和首个切片确认后才写 ADR。

## 4. Classify feedback before changing code

收到测试反馈后先分类：

- Contract change：改变对象、编辑、使用、删除或所有权语义。停止普通开发，在 Decision Changes 中
  记录旧规则、新规则、影响面和确认结果，再同步 PRD、Issue、ADR 与 PR 描述。
- Interaction change：不改变领域语义的操作路径或视觉调整。直接修改，并覆盖相关交互状态。
- Bug：实现偏离已确认契约。先写或补充回归测试，再修复。

Contract change 绝不能被描述成“删除几个组件”并静默落地。

## 5. Keep delivery in small batches

- 一个 PR 只解决一个产品主题；相关测试与实现放在一起。
- 大功能优先拆成可独立运行的 stacked PR；所有 PR 均保持待审，除非用户明确授权合并。
- 实施中出现无关请求时，按 Scope isolation 新建分支或 worktree。
- PR 创建和重大规则变化后，都要根据当前 PRD 重写摘要、Included、No-gos 和验证结果。
- PR 描述不能继续陈述已被 Decision Changes 推翻的旧设计。

## 6. Verification gates

开发过程中运行定向测试；交付前运行 `make verify`。用户可见界面还必须完成一次真实浏览器检查，覆盖
PRD State Matrix 中的相关状态。

合并前确认：

- Product Contract 与实现一致。
- PRD、ADR、API 契约和 PR 描述没有旧规则残留。
- Diff 不包含 PRD 以外的功能。
- 关键 UI 状态有测试或人工验证证据。
- `make verify` 与 CI 通过。
- 用户已明确授权合并。

## Required artifacts

保持最小文档集合：

- `PRD.md`：当前产品事实、验收和决策变化。
- `execution-log.md`：实现中的判断、偏离、审查修复和遗留风险。
- `issues/*.md`：可独立验收的纵向切片。
- `docs/adr/*`：仅保存已稳定且难以逆转的领域/架构决策。

复盘经验按性质落位：产品规则进 PRD/ADR，执行规则进本文，重复机械错误进测试或 CI，跨项目原则进
全局 Memory。只写复盘但没有触发点或守卫，不视为完成吸收。
