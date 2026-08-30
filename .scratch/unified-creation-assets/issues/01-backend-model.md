# 全局创作资产模型与 API

Type: feature
Status: ready-for-human
Blocked by: none

## Scope

实现提示词、图片单内容模型、标签、物理删除、图片摘要去重、最近使用排序与 CRUD/使用记录 API。

## Acceptance

- Python 与 TypeScript schema 同步。
- 并发写入走文件锁与原子写。
- 后端单测覆盖原位编辑、物理删除、来源快照、迁移备份与重复图片。

## Comments

- 已重构为应用级单内容目录、原位编辑、物理删除、SHA-256 图片去重、最近使用排序与完整 API；并发写入使用文件锁和原子写。
