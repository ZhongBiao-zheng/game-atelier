# 04：轻量 UI V1 / V2 方案

Type: task
Status: ready-for-agent
Blocked by: 02

## What to build

让同一项目拥有多套并存的 UI 方案。现有 UI 内容成为 V1；用户可以复制风格说明、页面地图或指定页面创建 V2,之后两套方案独立保存页面版本和定稿。

## Acceptance criteria

- [ ] 当前 UI 内容切换为 V1 后仍能查看、生成、定稿和判断 stale。
- [ ] 新建 V2 时可选择复制风格说明、页面地图或部分页面。
- [ ] V1、V2 的页面版本和定稿互不覆盖。
- [ ] 可设置默认打开的 UI 方案,切换默认不删除其他方案。
- [ ] 项目文件夹可以引用整套 UI 方案或具体 UI 页面。
- [ ] 不保留无方案和有方案两套长期路径。
- [ ] UI Skill、Job、摘要、页面路由和双端测试同步更新。

## Comments
