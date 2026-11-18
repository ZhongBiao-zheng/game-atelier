# 桌面外壳契约

桌面外壳（`desktop/`，Tauri）只负责窗口、托盘、单实例和 viewer-server 的启停，不含业务逻辑。
它与运行包之间只通过下面列出的接口交互。改动其中任何一项都是破坏性变更：已经装在用户机器上的外壳不会随应用内更新一起更新，
必须保持旧外壳可用。守卫测试：`tests/test_desktop_shell_contract.py`。

## 目录

| 位置 | 内容 | 谁写 |
| --- | --- | --- |
| 安装位置（macOS `/Applications/Atelier.app`；Windows 默认 `%LOCALAPPDATA%\Atelier\`，可在安装时更改，当前用户安装、不需要管理员） | 外壳与种子（macOS `Contents/Resources/seed/GameAtelier-<版本>-macos-arm64.tar.gz`；Windows `Atelier.exe`、`seed\GameAtelier-<版本>-windows-x64.zip`、`uninstall.exe`） | 安装器，只读 |
| `<本地应用数据>/game-atelier/runtime/GameAtelier/` | ADR-0030 运行包布局 | 由种子解压（Windows 在安装时由安装程序调用外壳的 `--prepare-runtime`；macOS 与其他情况在外壳首次启动时）；之后只由应用内更新修改 |
| `<本地应用数据>/game-atelier/runtime/shell.log` | 外壳日志 | 外壳 |
| `<数据目录>/.runtime/` | 服务记录 | 见下 |

本地应用数据：macOS 是 `~/Library/Application Support`，Windows 是 `%LOCALAPPDATA%`。Windows 卸载时删除运行包根，数据目录不动。运行包根已存在且 `last-good` 指向完整版本时，外壳不再碰种子。Windows 覆盖安装时，已有运行包版本不低于安装包时保留，低于时先删掉再按新种子解压。
外壳所在路径不能包含符号链接（Tauri 会拒绝解析资源目录），装在 `/Applications` 不受影响。

## 固定启动器

macOS：外壳只调用运行包根下的固定启动器 `启动.command`，不自己选版本、不直接找解释器。启动器无参数时等同 `--select-version`；有参数时原样转给 `bootstrap.py`。

Windows：外壳不经 `launch.ps1`，而是做 `launch.ps1` 做的同一件事——读 `last-good`，用 `versions\<版本>\python\python.exe` 运行 `versions\<版本>\app\scripts\bootstrap.py`，设 `PYTHONPATH=…\app\src`、`PYTHONUTF8=1`，以无控制台窗口方式启动。这样 `launch.ps1`（双击启动与常驻任务的入口）一行不改；每次调用省掉 PowerShell 的启动时间；Python 的 UTF-8 输出不经 PowerShell 转码，中文数据目录也能原样传回。选版本仍由 `bootstrap.py --select-version` 负责。下表的参数两个平台相同。

这条启动规则因此写了两份：`scripts/build_release.py` 生成的 `launch.ps1`，以及 `desktop/src-tauri/src/runtime.rs` 的 Windows 代码块。指针文件、解释器与入口的相对路径、`PYTHONPATH`、`PYTHONUTF8`、要清除的环境变量，改其中一处必须同步另一处；`tests/test_desktop_shell_contract.py` 用同一张规则表同时检查两边。

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
- 外壳向页面派发的 `window` 事件：下载落盘后 `atelier:download-saved`（`detail: { name }`）；macOS 系统菜单「设置…」与 Windows 的 Ctrl+, `atelier:navigate`（`detail: { path }`，站内路径）。页面可选择监听，浏览器里不会出现。
- 运行包版本低于外壳版本时（重装安装器、保留了旧运行包），旧页面不会给红绿灯留位，外壳改用系统标题栏。这在窗口创建前决定；运行中改标题栏样式在实测里会让网页消失。
- `127.0.0.1` 以外的导航与新窗口转交系统浏览器。

## 菜单与图标

系统菜单只在 macOS 建。Windows 会把应用菜单画成窗口里的一行灰色菜单栏，所以不建；冒烟测试检查外壳日志 `menu bar=false`。macOS 菜单项在 Windows 上的去处：

| macOS 菜单项 | Windows |
| --- | --- |
| 设置…（⌘,） | 页面顶栏的设置入口；Ctrl+, 由外壳注入的页面脚本派发 `atelier:navigate` |
| 退出（⌘Q） | 通知区域图标菜单「退出」，走同一个退出流程；关窗口收进托盘 |
| 撤销、重做、剪切、拷贝、粘贴、全选 | WebView2 在输入框里原生处理 Ctrl+Z / Ctrl+Y / Ctrl+X / Ctrl+C / Ctrl+V / Ctrl+A |
| 重新载入（⌘R） | WebView2 的浏览器快捷键 F5 / Ctrl+R |
| 实际大小（⌘0） | 不需要：缩放快捷键未开启，页面不会被缩放 |
| 最小化、缩放、关闭窗口、进入全屏幕 | 系统标题栏按钮与 Win 键组合 |
| 查看日志 | 通知区域图标菜单「查看日志」；出错页的「查看日志」 |
| 关于、隐藏、全部显示 | macOS 专有，无对应 |

Windows 标题栏深浅色跟随页面：页面调用 `set_theme`，系统标题栏随之切换；下次启动按外壳记下的深浅色创建窗口。

图标：macOS 用 `assets/brand/atelier-icon-macos.svg`（含 Apple 图标网格的留白），Windows 用无留白的 `assets/brand/atelier-icon.svg`，都由 `desktop/` 下 `pnpm icons` 生成。Windows 的应用本身（以及开始菜单快捷方式、「设置 → 应用」条目、托盘）取 `bundle.icon` 里的 `icons/windows/icon.ico`，安装程序与卸载程序由 `desktop/setup/setup.rc` 嵌入同一个文件；`tests/test_desktop_shell_contract.py` 检查配置，desktop-ci 的 Windows job 用 `scripts/desktop_icon_check.ps1` 在真实安装上比对三处图标像素并把资源管理器看到的图标存进制品。

## Windows 安装程序

`Atelier-<版本>-windows-x64-setup.exe` 是 Atelier 自己的安装程序（`desktop/setup`，Rust + WebView2），不是 NSIS。安装程序本体后面附着外壳、种子与 WebView2 引导程序，格式见 `desktop/setup/src/payload.rs`，由 `scripts/build_desktop.py` 写入（守卫测试比对两边）。卸载程序 `uninstall.exe` 是同一个程序去掉附件、清单标为卸载。

| 用法 | 行为 |
| --- | --- |
| 双击 | 窗口：立即安装（可更改位置、是否建桌面快捷方式）→ 进度（复制文件，再调用外壳 `--prepare-runtime` 解压运行环境）→ 开始使用。已安装时为「立即更新」，沿用原位置 |
| `--silent [--dir <路径>] [--no-desktop-shortcut]` | 无界面安装，退出码 0 成功、1 失败、3 应用仍在运行 |
| `uninstall.exe [--silent]` | 先把自己复制到 `%TEMP%` 再运行；停止安装目录与运行包根下的进程，删除快捷方式、「设置 → 应用」条目、运行包根和安装目录里安装程序放的文件。数据目录与 WebView 本地存储不动 |
| `--preview <界面>`、`--auto` | 只供 CI 截图：渲染某个界面不做任何事；自动点主按钮 |

写入的位置：安装目录、开始菜单与桌面 `Atelier.lnk`、`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Atelier`（与此前的 NSIS 安装器相同，所以覆盖安装会直接接管旧安装；旧的 `HKCU\Software\atelier\Atelier` 会被删除）。安装或卸载时 Atelier 正在运行，会先用 `Atelier.exe --quit` 请它走自己的退出流程（有进行中的工作会先确认），等它退出再继续。缺 WebView2 时先用系统对话框询问，再用附带的引导程序联网安装。安装程序的 WebView 配置放在 `%TEMP%\atelier-setup-webview2`，日志写 `%TEMP%\atelier-setup.log`。

外壳为安装程序提供的参数（只在 Windows）：

| 调用 | 约定 |
| --- | --- |
| `Atelier.exe --prepare-runtime` | 不开窗口，按首次启动的同一段代码从安装目录 `seed\` 解压运行包到运行包根；标准输出逐行 `progress <已解压> <总数>`；退出码 0 表示运行包可用，非 0 时 stderr 末行是原因 |
| `Atelier.exe --quit` | 已在运行时请那个实例走退出流程；没有实例时直接退出 |
- 关窗口收进托盘，服务继续运行；退出时只停止外壳自己启动的服务，有进行中的工作先确认。
