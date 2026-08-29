# 画布资产接入

Type: feature
Status: ready-for-human
Blocked by: 02-canvas-relations-migration, 03-shared-panel

## Scope

让资产按当前画布上下文填入生成草稿、作为参考或创建节点，并提供项目范围和显式版本更新。

## Acceptance

- 首次使用自动建立项目关系。
- 旧引用不自动更新。
- 当前引用和本画布全部引用的显式更新均可验证。

## Comments

- 已实现上下文使用、项目关系、编辑断链与显式版本更新；“更新本画布全部”在同一事务中覆盖内容节点和生成草稿，并清理已删除变量。
