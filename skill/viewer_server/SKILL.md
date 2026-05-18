---
name: viewer-server
description: 本地 FastAPI server，给 Web UI 提供文件读写 API + SSE 推送。仅本地访问（127.0.0.1）。
---

# Viewer Server

## 命令

### `python skill/viewer_server/server.py start`

启动 server：
1. 检查 `.runtime/server.pid` 是否存在
2. 若进程已死：删除 pid 文件，继续启动
3. 若进程存活：不重复启动，打印实际端口
4. 默认端口 5174；被占用时 +1 直到找到空端口
5. 实际端口写入 `.runtime/server.port`
6. 监听地址固定 `127.0.0.1`

### `python skill/viewer_server/server.py stop`

停止 server（读 `.runtime/server.pid` 发 SIGTERM）。

### `python skill/viewer_server/server.py open-browser`

`open http://127.0.0.1:<port>/`（Mac）/ `xdg-open`（Linux）。

## 单 tab 约束

同一时间只支持一个浏览器 tab 操作。多 tab 行为未定义（v2.3 Outside Voice #4 限制）。
画师指南需写明。
