# 全局创作资产模型与 API

Type: feature
Status: ready-for-human
Blocked by: none

## Scope

实现提示词、图片、不可变版本、标签、归档、图片摘要去重、最近使用排序与 CRUD/使用记录 API。

## Acceptance

- Python 与 TypeScript schema 同步。
- 并发写入走文件锁与原子写。
- 后端单测覆盖版本、元数据、归档、恢复与重复图片。

## Comments

- 已实现应用级目录、提示词/图片不可变版本、标签、归档恢复、SHA-256 图片去重、最近使用排序与完整 API；并发写入使用文件锁和原子写。
