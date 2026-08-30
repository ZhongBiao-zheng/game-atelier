# Canvas 项目关系与旧数据升级

Type: feature
Status: ready-for-human
Blocked by: 01-backend-model

## Scope

把 Canvas 本地资产和提示词升级为全局创作资产，并把 `全部资产 / 本项目` 改为全局资产过滤与项目关系。

## Acceptance

- 升级幂等且保留原项目可见内容。
- 旧版本化资产迁移前生成时间戳完整备份。
- 项目包继续可验证、导入并携带冻结内容与来源标题。

## Comments

- 已实现旧 Canvas sidecar 幂等升级和版本化资产 v1→v2 一次性备份迁移；项目包继续携带固定内容与来源标题快照。
