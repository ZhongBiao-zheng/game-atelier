# 05：裁定项目、资产、提示词与同步的归属

Type: wayfinder:grilling

Status: ready-for-agent

Blocked by: 01-freeze-reference-baseline, 02-resolve-canvas-domain-v2

## Question

画布保持独立人工空间时，参考项目的删除/导入/导出、资产库、提示词仓库同步和 WebDAV
应如何拥有数据；它与创作台/工坊的项目资产是复制、引用还是显式发布？

## Decisions required

- 画布内资产的永久归属、去重、重命名、替换和删除语义。
- “从工坊导入”和“发布到工坊”是否存在，以及是否总是显式用户动作。
- 提示词公共仓库的信任、缓存、版本、离线和 JSON schema。
- 项目包格式、媒体内嵌策略、WebDAV 冲突和凭证存储。

## Deliverable

- 所有权矩阵、数据流图和删除影响表。
- 项目包/WebDAV/提示词索引的契约提案。

## Proposal

- 归属、数据流、删除影响与契约：`../canvas-assets-prompts-sync-proposal.md`
- proposed ADR：`../../../docs/adr/0010-copy-across-canvas-boundaries-and-sync-snapshots.md`
- 推荐方案 A：Canvas Project 是 owner；跨空间显式复制；项目包导入新建项目；WebDAV 用不可变快照
  谱系，分叉创建冲突副本。

## Decision required

确认是否采用方案 A 的五条不可逆规则：跨空间复制、Library Entry 不拥有第二份内容、无项目复制命令、
WebDAV 分叉不自动合并、公共 Prompt 编辑后 fork 为项目本地内容。

## Comments

- 2026-08-23：用户确认方案 A。ADR-0010 转 accepted；项目所有权、跨空间复制、项目包和同步冲突
  规则进入领域词汇。
