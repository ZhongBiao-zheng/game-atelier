# Canvas 项目关系与旧数据升级

Type: feature
Status: ready-for-human
Blocked by: 01-backend-model

## Scope

把 Canvas 本地资产和提示词升级为全局创作资产，并把 `全部资产 / 本项目` 改为全局资产过滤与项目关系。

## Acceptance

- 升级幂等且保留原项目可见内容。
- 移出项目只删除关系。
- 项目包继续可验证、导入和导出关系所需内容。

## Comments

- 已实现旧 Canvas sidecar 幂等升级、项目关系过滤/移除、项目导入关系恢复与项目删除关系清理；项目包继续携带固定内容快照。
