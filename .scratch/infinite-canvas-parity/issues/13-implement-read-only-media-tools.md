# 13：实现只读媒体工具与版本下载

Type: implement

Status: ready-for-human

Blocked by: 09-plan-media-tools, 12-implement-project-assets-prompts

## Goal

把后续图片编辑工具共用的 `version_id` 媒体读取边界固定下来，并补齐节点工具栏中的详情、原文件下载和
复制实际生成提示词。所有动作只读，不修改 Canvas Document，也不接受浏览器传入裸路径。

## Included

- `versions/{version_id}/media` 同源预览与 `download` 附件下载。
- 服务端按项目、Content Version 与 Job 所有权解析文件，固定安全 MIME、文件名与 `nosniff`。
- 删除旧 `/content/{version_id}` 路径，不保留兼容分支。
- 节点悬浮工具条、Inspector 和详情 Dialog 的查看、下载与复制提示词入口。
- 详情展示类型、来源、尺寸、体积、格式、模型、创建时间与版本 ID。
- 复制提示词优先最新成功/部分成功 Run 的不可变 Snapshot，未运行时读取当前 Draft。

## Excluded

- 媒体替换、裁剪、切图、本地放大与蒙版编辑。
- 反推提示词、多角度生成和视频编辑 Job。
- 跨项目或跨空间下载授权。

## Exit gate

- HTTP 冒烟验证预览、下载、MIME、Content-Disposition、跨项目拒绝与旧路径删除。
- 节点 hover、Inspector、详情 Dialog 在真实页面可达，复制成功有可见且可读屏反馈。
- 设计守卫与生产构建通过，源码不新增 TypeScript / Ruff 错误。
