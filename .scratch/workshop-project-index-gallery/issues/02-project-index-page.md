# 02：工坊项目卡片墙

Type: feature

Status: done

Blocked by: 01

## Scope

- `/workshop` 改为无侧栏的 ProjectIndexPage，删除 WorkshopLanding 与根页项目列表。
- 实现新建卡、1–4 图自适应拼贴、项目活动时间和项目操作菜单。
- 新建项目 Dialog 只收名称，成功后进入新项目首页；重命名与删除沿用现有 API 和确认语义。
- 接入 shadcn Card、Dialog、Dropdown Menu 的源码组件并套用 Atelier tokens。

## Acceptance

- 空项目、少图、四图、长名称和接口错误都有明确页面状态。
- 菜单操作不误触卡片导航；创建后 URL 指向新项目首页。
- 375、768、1440 布局与键盘操作通过组件测试和人工验收。

## Comments

- 2026-08-21：项目卡片墙、新建首卡、四图拼贴、项目菜单和错误/空状态完成，并通过三档视口验收。
