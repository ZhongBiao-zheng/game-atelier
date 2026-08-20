# 04：轻量 UI V1 / V2 方案

Type: task
Status: ready-for-human
Blocked by: 02

## What to build

让同一项目拥有多套并存的 UI 方案。现有 UI 内容成为 V1；用户可以复制风格说明、页面地图或指定页面创建 V2,之后两套方案独立保存页面版本和定稿。

## Acceptance criteria

- [x] 当前 UI 内容切换为 V1 后仍能查看、生成、定稿和判断 stale。
- [x] 新建 V2 时可选择复制风格说明、页面地图或部分页面。
- [x] V1、V2 的页面版本和定稿互不覆盖。
- [x] 可设置默认打开的 UI 方案,切换默认不删除其他方案。
- [x] 项目文件夹可以引用整套 UI 方案或具体 UI 页面。
- [x] 不保留无方案和有方案两套长期路径。
- [x] UI Skill、Job、摘要、页面路由和双端测试同步更新。

## Comments

- 2026-08-20：实现完成，版本升至 v5.25.0；Standards / Spec 双轴最终复核通过。
- 验证：后端 926 passed / 3 skipped，前端 354 passed，Ruff、TypeScript、干净构建通过。
- Windows CI 首轮发现旧 Job 绝对路径使用反斜杠时未迁移；已改为双分隔符重写并加入跨平台回归。
