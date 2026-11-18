# 桌面外壳契约

桌面外壳（`desktop/`，Tauri）只负责窗口、托盘、单实例和 viewer-server 的启停，不含业务逻辑。
它与运行包之间只通过下面列出的接口交互。改动其中任何一项都是破坏性变更：已经装在用户机器上的外壳不会随应用内更新一起更新，
必须保持旧外壳可用。守卫测试：`tests/test_desktop_shell_contract.py`。

## 目录

| 位置 | 内容 | 谁写 |
| --- | --- | --- |
| 安装位置（macOS `/Applications/Atelier.app`；Windows `%LOCALAPPDATA%\Atelier\`，当前用户安装、不需要管理员） | 外壳与种子（macOS `Contents/Resources/seed/GameAtelier-<版本>-macos-arm64.tar.gz`；Windows `seed\GameAtelier-<版本>-windows-x64.zip`） | 安装器，只读 |
| `<本地应用数据>/game-atelier/runtime/GameAtelier/` | ADR-0030 运行包布局 | 外壳首次启动时由种子解压；之后只由应用内更新修改 |
| `<运行包根>/versions/<版本>/DESKTOP_CONTRACT` | 一行整数：该版本提供的外壳契约级别（见「契约级别」） | `scripts/build_release.py` |
| `<本地应用数据>/game-atelier/runtime/shell.log` | 外壳日志 | 外壳 |
| `<数据目录>/.runtime/` | 服务记录 | 见下 |

本地应用数据：macOS 是 `~/Library/Application Support`，Windows 是 `%LOCALAPPDATA%`。Windows 卸载时删除运行包根，数据目录不动。运行包根已存在且 `last-good` 指向完整版本时，外壳不再碰种子。
外壳所在路径不能包含符号链接（Tauri 会拒绝解析资源目录），装在 `/Applications` 不受影响。

## 契约级别

外壳不比较版本号判断运行包能做什么：同一版本号的测试包重装时，外壳是新的，已解压的运行包却还是早先那份，版本号相同、内容更旧。运行包改为显式声明，外壳只认声明。

- `scripts/build_release.py` 的 `DESKTOP_CONTRACT` 写进每个版本目录的 `DESKTOP_CONTRACT`；外壳要求的级别是 `desktop/src-tauri/src/runtime.rs` 的同名常量，两边必须相等（守卫测试检查）。
- 级别 1：`bootstrap.py` 认识 `--desktop-start`；页面在 `data-titlebar="overlay"` 下给红绿灯留位。外壳开始依赖运行包的新能力时，两边一起加一。
- 外壳读 `current` 与 `last-good` 两个版本的标记，两个都达到要求才算满足：`last-good` 的 `bootstrap.py` 负责解析参数，`current` 提供页面（回滚时改由 `last-good` 提供）。文件缺失、内容不是整数，一律按 0 处理。
- 满足：用 `--desktop-start` 启动；macOS 用隐藏标题栏（红绿灯压在页面顶栏上）。不满足：用 `--select-version --no-browser` 启动、再用 `--print-data-root` 取数据目录，即第一版外壳的做法；窗口保留系统标题栏。
- 首次启动还没有运行包时，标题栏按种子里的同一个标记判断（标记在压缩包靠前的位置，读几条条目即可；没有标记的旧种子要读完整个压缩包，约一秒）。Windows 的启动路径走同一判断；Windows 窗口始终用系统标题栏。
- 应用内更新从同一种发布压缩包解出整个版本目录，标记随之更新。

## 固定启动器

macOS：外壳只调用运行包根下的固定启动器 `启动.command`，不自己选版本、不直接找解释器。启动器无参数时等同 `--select-version`；有参数时原样转给 `bootstrap.py`。

Windows：外壳不经 `launch.ps1`，而是做 `launch.ps1` 做的同一件事——读 `last-good`，用 `versions\<版本>\python\python.exe` 运行 `versions\<版本>\app\scripts\bootstrap.py`，设 `PYTHONPATH=…\app\src`、`PYTHONUTF8=1`，以无控制台窗口方式启动。这样 `launch.ps1`（双击启动与常驻任务的入口）一行不改；每次调用省掉 PowerShell 的启动时间；Python 的 UTF-8 输出不经 PowerShell 转码，中文数据目录也能原样传回。选版本仍由 `bootstrap.py --select-version` 负责。下表的参数两个平台相同。

这条启动规则因此写了两份：`scripts/build_release.py` 生成的 `launch.ps1`，以及 `desktop/src-tauri/src/runtime.rs` 的 Windows 代码块。指针文件、解释器与入口的相对路径、`PYTHONPATH`、`PYTHONUTF8`、要清除的环境变量，改其中一处必须同步另一处；`tests/test_desktop_shell_contract.py` 用同一张规则表同时检查两边。

| 调用 | 用途 | 约定 |
| --- | --- | --- |
| `--print-data-root` | 数据目录 | 标准输出只有一行绝对路径；与服务端 `data_root.resolve_data_root()` 结果一致。外壳不另写解析规则 |
| `--desktop-start` | 启动服务 | 外壳确认没有可用实例、且运行包声明了契约级别 1 后才调用（否则改用 `--select-version --no-browser`，见「契约级别」）。选版本、恢复更新事务与 `--select-version` 相同；之后不联网检查更新（运行中的服务自己检查），没有启动记录时不先停服务，服务端跳过运行包模式下的 `bootstrap --check`。退出码 0 表示服务已通过实例验证，标准输出最后一行是服务使用的数据目录；非 0 时 stderr 末尾是给用户看的原因。不打开浏览器 |
| `--run -m viewer_server.server stop` | 停止服务 | 外壳显式传 `GAME_ATELIER_DATA_ROOT` 为它接管服务时的数据目录（页面可能已改了配置的数据目录，服务记录仍在旧目录） |

启动器自带 8 秒验证时限；首次启动可能更久，外壳在启动器失败后会再按服务记录等最多 30 秒。

macOS 启动器只在当前版本的解释器带 `com.apple.quarantine` 时才递归清除运行包的隔离属性（压缩包解压出来的文件都带它）；外壳解压的种子不带，遍历约 1.2 万个文件的那一秒不再每次都付。

## Windows 安装程序与外壳的参数（Electron 外壳）

Windows 外壳是 electron-builder 产出的应用目录，由 Windows 安装程序（`desktop/setup`）整体安装；种子放在 exe 旁的 `seed\`（`seed.json` 描述文件名、版本、`BUILD_ID` 与契约级别，由 `scripts/build_desktop.py` 写入），外壳从 `path.dirname(process.execPath)\seed` 读取。macOS 的种子仍在 `Contents/Resources/seed/`。

| 参数 | 约定 |
| --- | --- |
| `--prepare-runtime` | 不开窗口、不占单实例锁，按首启同一段逻辑把种子解压到运行包根（运行包已满足要求时什么都不做）。标准输出逐行 `progress <已解压> <总数>`（Windows 为 zip 条目数，macOS 为压缩字节数），数值只增不减，最后一行两数相等；退出码 0 表示运行包可用，非 0 时 stderr 末行是原因。需要替换旧运行包且其服务由外壳启动时，直接停掉该服务、不再确认（安装程序先调用过 `--quit`） |
| `--quit` | 已有实例在运行时，该实例走正常退出流程（有进行中的任务会先确认），本次启动以 0 退出；没有实例时直接以 0 退出 |

AppUserModelID 等于 `desktop/electron-builder.yml` 的 `appId`（构建时以 `atelierAppId` 写进应用元数据）；安装程序创建的快捷方式必须带同一个值。外壳继续写 `<运行包父目录>\window-theme`（`light` / `dark`），安装程序据此决定深浅色。

Windows 窗口隐藏系统标题栏，最小化 / 最大化 / 关闭按钮由系统画在页面右上角（背景透明、符号颜色跟随页面深浅色），页面写 `data-titlebar="overlay"` 并按 `data-shell="windows"` 在右侧留位；Windows 没有菜单栏，`Ctrl+,` 打开设置、`F5` / `Ctrl+R` 重新载入、`F11` 全屏，托盘菜单有「显示 / 查看日志 / 退出」。

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
- 运行包没有声明契约级别 1 时（例如重装安装器后保留了旧运行包），旧页面不会给红绿灯留位，外壳改用系统标题栏。这在窗口创建前决定；运行中改标题栏样式在实测里会让网页消失。
- `127.0.0.1` 以外的导航与新窗口转交系统浏览器。
- 关窗口收进托盘，服务继续运行；退出时只停止外壳自己启动的服务，有进行中的工作先确认。
