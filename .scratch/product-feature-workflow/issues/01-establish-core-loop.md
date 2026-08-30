# 建立产品功能核心闭环

Type: feature
Status: ready-for-human
Blocked by: none

## Scope

接通 Product Contract、风险原型、规则变更、分支范围、PR 描述和本地验证，使下一次重要功能可以从同一
入口执行完整闭环。

## Acceptance

- Agent 启动重要产品功能时能发现强制入口。
- PRD 与实施日志模板可直接复制使用。
- PR 模板要求范围、规则变化和真实页面验证。
- `make verify` 覆盖完整 lint、测试、clean build 和静态产物一致性。

## Comments

- 已完成首版实现，待验证与审查。
