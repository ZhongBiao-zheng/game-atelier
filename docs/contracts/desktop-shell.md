# 桌面外壳契约

桌面外壳（`desktop/`，Tauri）只负责窗口、托盘、单实例和 viewer-server 的启停，不含业务逻辑。
它与运行包之间只通过下面列出的接口交互。改动其中任何一项都是破坏性变更：已经装在用户机器上的外壳不会随应用内更新一起更新，
必须保持旧外壳可用。守卫测试：`tests/test_desktop_shell_contract.py`。

## 目录

| 位置 | 内容 | 谁写 |
| --- | --- | --- |
| 安装位置（`/Applications/Atelier.app`） | 外壳与 `Contents/Resources/seed/GameAtelier-<版本>-<平台>.tar.gz` 种子 | 安装器，只读 |
| `<本地应用数据>/game-atelier/runtime/GameAtelier/` | ADR-0030 运行包布局 | 外壳首次启动时由种子解压；之后只由应用内更新修改 |
| `<本地应用数据>/game-atelier/runtime/shell.log` | 外壳日志 | 外壳 |
| `<数据目录>/.runtime/` | 服务记录 | 见下 |

macOS 的本地应用数据是 `~/Library/Application Support`。运行包根已存在且 `last-good` 指向完整版本时，外壳不再碰种子。
外壳所在路径不能包含符号链接（Tauri 会拒绝解析资源目录），装在 `/Applications` 不受影响。

## 固定启动器

外壳只调用运行包根下的固定启动器（macOS `启动.command`），不自己选版本、不直接找解释器。启动器无参数时等同 `--select-version`；有参数时原样转给 `bootstrap.py`。

| 调用 | 用途 | 约定 |
| --- | --- | --- |
| `--print-data-root` | 数据目录 | 标准输出只有一行绝对路径；与服务端 `data_root.resolve_data_root()` 结果一致。外壳不另写解析规则 |
| `--desktop-start` | 启动服务 | 外壳确认没有可用实例后才调用。选版本、恢复更新事务与 `--select-version` 相同；之后不联网检查更新（运行中的服务自己检查），没有启动记录时不先停服务，服务端跳过运行包模式下的 `bootstrap --check`。退出码 0 表示服务已通过实例验证，标准输出最后一行是服务使用的数据目录；非 0 时 stderr 末尾是给用户看的原因。不打开浏览器 |
| `--run -m viewer_server.server stop` | 停止服务 | 外壳显式传 `GAME_ATELIER_DATA_ROOT` 为它接管服务时的数据目录（页面可能已改了配置的数据目录，服务记录仍在旧目录） |

启动器自带 8 秒验证时限；首次启动可能更久，外壳在启动器失败后会再按服务记录等最多 30 秒。

macOS 启动器只在当前版本的解释器带 `com.apple.quarantine` 时才递归清除运行包的隔离属性（压缩包解压出来的文件都带它）；外壳解压的种子不带，遍历约 1.2 万个文件的那一秒不再每次都付。

## 服务记录（`<数据目录>/.runtime/`）

| 文件 | 写入方 | 外壳的用法 |
| --- | --- | --- |
| `server.port`、`server.instance` | 服务 | 读端口，再用状态接口核对实例 |
| `shell-control.json` | 服务完成初始化后写入，仅本人可读 | `{ "instance_id", "token" }`；外壳核对实例一致后用 `token` 调用控制接口 |
| `shell-owned` | 外壳 | 一行实例 id，记录由外壳启动的服务；外壳崩溃重开后仍能认出。跟随应用内更新后的新实例时一并改写 |

## HTTP

| 接口 | 身份 | 约定 |
| --- | --- | --- |
| `GET /api/connection/status` | 无 | `service == "game-atelier"` 且 `instance_id` 与 `server.instance` 一致才算本机服务 |
| `GET /api/shell/active-work` | `Authorization: Bearer <shell-control.json 的 token>` | 返回 `{ jobs, agents, approvals, gateway }` 四个计数；带 Origin、Fetch Metadata、cookie 或其他 Bearer 的请求一律 403；服务初始化完成前一律 403 |

## 窗口与页面

- 窗口加载 `http://127.0.0.1:<端口>/`，页面与浏览器访问同源，会话与编辑租约照常工作。
- 页面只能调用三条外壳命令（`capabilities/server-page.json`，只匹配 `http://127.0.0.1:*`）：`plugin:window|start_dragging`（顶栏 `data-tauri-drag-region` 拖动窗口）、`plugin:window|internal_toggle_maximize`（双击缩放）、`plugin:window|set_theme`（页面的深浅色，外壳记下来，下次启动的窗口底色与加载页跟着走）。外壳自己的命令（重试、查看日志）只给内置加载页。插件的沙箱 iframe（`srcdoc`，origin 为 `null`）拿不到 IPC。
- 外壳在 `127.0.0.1` 页面的主框架里，于页面脚本之前运行一段初始化脚本：给 `<html>` 写 `data-shell="macos|windows"`；macOS 隐藏系统标题栏时再写 `data-titlebar="overlay"`（页面据此给红绿灯留位）；屏蔽网页自带的右键菜单（输入框与选中文字除外）。
- 外壳向页面派发的 `window` 事件：下载落盘后 `atelier:download-saved`（`detail: { name }`）；系统菜单「设置…」`atelier:navigate`（`detail: { path }`，站内路径）。页面可选择监听，浏览器里不会出现。
- 运行包版本低于外壳版本时（重装安装器、保留了旧运行包），旧页面不会给红绿灯留位，外壳改用系统标题栏。这在窗口创建前决定；运行中改标题栏样式在实测里会让网页消失。
- `127.0.0.1` 以外的导航与新窗口转交系统浏览器。
- 关窗口收进托盘，服务继续运行；退出时只停止外壳自己启动的服务，有进行中的工作先确认。
