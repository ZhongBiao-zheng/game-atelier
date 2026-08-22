# 05：视频参考联动与整体收口

Type: task
Status: ready-for-human
Blocked by: 03, 04

## What to build

让项目视频镜头可以直接选择角色皮肤或 UI 页面定稿作为参考,复用现有 Job 记录实际参考路径、Prompt 和参数,并跑通项目文件夹的完整个人创作流程。

## Acceptance criteria

- [x] 视频镜头参考选择器可浏览当前项目的角色、皮肤和 UI 定稿。
- [x] 新视频 Job 保存实际使用的参考路径,历史 Job 展示不被后续定稿改变。
- [x] “夏日版本文件夹 → 角色皮肤 → UI V2 → 宣传片”流程可完整走通。
- [x] 项目文件夹正确混合展示三类资产,跳转后保留文件夹返回上下文。
- [x] 废弃导航分支和重复本地导航状态被删除。
- [x] API 契约、Skill 文档、数据校验、前后端测试、类型检查和 clean build 全部通过。

## Comments

- 2026-08-20：实现完成，版本升至 v5.26.0；Standards / Spec 双轴最终复核通过。
- 视频参考草稿只接受当前项目定稿或已保存的明确版本；生成时复制进 Job，镜头详情按新到旧展示完整 Prompt、参数与参考素材历史。
- 验证：后端 933 passed / 3 skipped，前端 355 passed，Ruff、TypeScript、干净构建通过。
