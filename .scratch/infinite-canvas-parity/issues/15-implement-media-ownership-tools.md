# 15：实现媒体替换与比例锁

Type: implement

Status: completed

Blocked by: 13-implement-read-only-media-tools, 14-implement-local-media-operations

## Goal

让已有图片、视频和音频节点可以用同类型本地文件替换当前内容，同时保留旧 Content Version；让图片和
图片节点的自由缩放开关真正控制 React Flow resize 是否锁定当前媒体比例。

## Included

- `POST /canvas/projects/{project_id}/nodes/{node_id}/replace` multipart 命令。
- 扩展名、真实 MIME、体积、节点类型、current version 与 revision 双重校验。
- 新文件成为项目内不可变 upload Content Version，原节点只切换 `current_version_id`。
- hover 工具条和检查器提供替换、锁定比例/自由缩放入口；处理时节点级禁用并就近公告失败。
- 替换与比例切换各形成一个画布历史命令；undo/redo 只切换指针/显示状态，不重复上传字节。

## Excluded

- 把图片替换成视频或其他跨模态转换。
- 修改媒体字节、裁剪、蒙版、角度生成、反推提示词、视频编辑与快捷工具个性化。
- 修改旧 Canvas v1 测试或当前工作区其他任务的测试文件。

## Exit gate

- 隔离数据验证三种媒体替换、跨类型拒绝、伪后缀拒绝、revision 冲突零写、旧 version/字节保留和
  undo/redo 不重复上传。
- 真实页面验证 hover/检查器入口、文件选择、节点级 busy、错误公告、比例锁与自由缩放。
- Ruff、设计守卫、生产构建通过；源码不新增 TypeScript 错误，双轴复审 P1/P2 清零。

## Verification

- 隔离 direct/API smoke 覆盖 image/video/audio、EXIF 方向、跨类型/伪后缀拒绝、revision 冲突零写，
  并确认替换前后的不可变 Version 与文件同时保留。
- 真实页面确认 hover 工具条、Inspector、精确文件类型过滤、节点 busy、比例锁/自由缩放及无控制台错误；
  Inspector 操作区在窄面板内分行且可换行。
- `ruff check`、Python 编译、设计守卫 8/8、Vite production build、源码 TypeScript 检查通过。
  完整测试只保留既有 Canvas v1、模型分类、Keys 及并行任务 changelog 基线失败，未修改测试文件。
- 双轴复审发现的服务端响应并发覆盖、命令期间项目切换、Inspector 溢出和上传提交重复逻辑均已修正；
  P1/P2 清零。
