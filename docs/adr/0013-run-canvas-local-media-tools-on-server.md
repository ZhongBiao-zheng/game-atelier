---
status: accepted
---

# Canvas 确定性媒体工具在服务端执行

## Context

固定参考仓库在浏览器 Canvas 中完成裁剪、切图和本地放大，再把 data URL 上传并由前端追加节点。该实现
无法与 game-atelier 的文件系统真源、Content Version、路径白名单、revision 和原子文档提交形成可靠
边界；大图反复解码/PNG 编码也会阻塞浏览器主线程。

## Decision

浏览器只负责 crop/split/mask 的交互预览。裁剪、切图与确定性放大由 viewer-server 使用 Pillow 执行，
先在项目 staging 目录完成并验证，再与不可变 Content Version、结果节点和 Derivation Connection 原子提交。蒙版
编辑、多角度、反推提示词和视频编辑仍进入统一 Job Runner。

本地工具输出统一为 PNG，来源记录 operation、source version 与结构化参数；不覆盖源文件，不扩展 v1
resource path。Pillow 只进入 Python 运行时，不增加 Web bundle。

## Consequences

- 可统一执行 MIME/pixel/内存限制、EXIF orientation、摘要和所有权校验。
- 多图切分可以 all-or-nothing；undo 只改画布结构，历史版本仍可追溯。
- 需要新增 Pillow 依赖、bounded worker、staging/transaction 恢复与 derived 路径白名单。
- 本地工具不能离线只靠浏览器运行；这与现有 viewer-server 架构一致。
