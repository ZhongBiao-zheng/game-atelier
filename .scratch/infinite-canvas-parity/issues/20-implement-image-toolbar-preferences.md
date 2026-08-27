# 20：实现图片快捷工具偏好

Type: implement

Status: completed

Blocked by: 13-implement-read-only-media-tools, 15-implement-media-ownership-tools,
18-implement-angle-generation

## Goal

让图片节点工具栏可按用户偏好排序、显隐并切换文字标签；偏好跨 Canvas 项目生效，但不进入任何
Canvas Document、项目包或历史栈。

## Included

- 冻结图片快捷工具 ID、默认顺序和默认显隐；AI 超分不进入清单。
- 应用级 `.config/canvas-ui.json` 使用严格 schema、revision、文件锁和原子写；GET 不制造文件，PUT
  拒绝旧 revision，损坏配置不静默覆盖。
- 图片节点始终保留“更多/配置”入口；设置 Dialog 支持开关、上移、下移、图标/文字预览、取消和保存。
- 宽节点按已保存顺序显示选中工具；窄节点继续用菜单承载，菜单顺序与偏好一致；文字标签只影响快捷
  工具栏，不改变 Inspector。
- 切换项目重新读取同一份应用偏好；网络或并发保存失败保留已落盘设置并向用户显示真实错误。

## Adaptation decision

参考项目把小配置写 `localStorage`。当前项目按已批准媒体工具方案改为 viewer-server 持有的应用级
sidecar，使偏好跟随本地工作区而不是浏览器 tab，同时继续排除项目导出和 Document autosave。

## Excluded

- 视频、音频、文本、Config 和插件节点的工具栏个性化。
- AI 超分入口、跨设备 WebDAV 同步、设置 JSON 导入导出与修改旧 Canvas v1 测试。

## Exit gate

- 默认值、乱序/重复/未知工具、空清单、并发 revision、损坏 JSON 和原子落盘行为可验证。
- 同一偏好在两个项目页面一致；保存前取消零写，保存失败不伪装成功。
- `canvas.json`、项目包 manifest/zip 与 undo/redo 都不含偏好字段。
- 375/768/桌面真实页面核对入口、Dialog、排序、显隐、标签、窄屏菜单与焦点返回。
- Ruff、Canvas TypeScript、设计守卫与生产构建通过；双轴审查 P1/P2 清零。

## Verification

- 隔离 API/文件 smoke：默认 GET revision 0 且零写；合法 PUT revision +1 并原子落盘；字符串 revision、
  数值 bool、重复/未知工具均 422，旧 revision 409；损坏 JSON 返回 409 且原字节不变。
- 应用边界 smoke：两个画布项目读取同一工具顺序；双项目导出包共 9 个条目，不含 `canvas-ui.json` 或
  `image_toolbar`，Document 与历史栈不新增偏好字段。
- 真实页面：桌面宽节点核对标题上方独立玻璃工具条、排序/显隐/文字标签和取消零写；320px 窄节点按同序
  折叠菜单且始终保留配置入口；375px Dialog 无横向溢出、底部操作可聚焦；并发 409 会重载最新设置，
  再确认后可保存；浏览器 console 无 warning/error。
- 门禁：Ruff、当前 Canvas TypeScript、设计漂移 8/8、Vite production build 与 diff check 全部通过；
  完整基线保持 Python 939 passed / 13 failed / 3 skipped，Web 381 passed / 22 failed / 13 errors，均为既有
  旧契约失败；遵守边界，未修改测试源码。
- Spec 与 Standards 双轴复审 P1/P2 均为 0。
