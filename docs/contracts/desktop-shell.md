# 桌面外壳契约

桌面外壳（`desktop/`，Electron，ADR-0040；首次启动下载运行包，ADR-0042）只负责窗口、托盘、单实例和 viewer-server 的启停，不含业务逻辑。
它与运行包之间只通过下面列出的接口交互。改动其中任何一项都是破坏性变更：已经装在用户机器上的外壳不会随应用内更新一起更新，
必须保持旧外壳可用。守卫测试：`tests/test_desktop_shell_contract.py`。

## 目录

| 位置 | 内容 | 谁写 |
| --- | --- | --- |
| 安装位置（macOS `/Applications/Atelier.app`；Windows 默认 `%LOCALAPPDATA%\Atelier\`，可在安装时更改，当前用户安装、不需要管理员） | 外壳（macOS 应用包；Windows 应用目录与 `uninstall.exe`）。不带运行包，只带 `stage/runtime.json`：配套运行包的版本、文件名、整个压缩包的 sha256、版本目录的 `BUILD_ID` 与契约级别（`scripts/build_desktop.py` 从压缩包本身算出） | 安装器，只读 |
| `<本地应用数据>/game-atelier/runtime/GameAtelier/` | ADR-0030 运行包布局 | 外壳首次启动时下载并解压（见「运行包下载」），何时替换见「运行包替换」；之后只由应用内更新修改 |
| `<运行包根>/versions/<版本>/DESKTOP_CONTRACT` | 一行整数：该版本提供的外壳契约级别（见「契约级别」） | `scripts/build_release.py` |
| `<本地应用数据>/game-atelier/runtime/download/` | 下载中的运行包：`<文件>.part` 与记录版本、sha256 的 `.part.json`；解压后删除 | 外壳 |
| `<本地应用数据>/game-atelier/runtime/shell.log` | 外壳日志（含每个来源的下载结果、用时与速度） | 外壳 |
| `<数据目录>/.runtime/` | 服务记录 | 见下 |

本地应用数据：macOS 是 `~/Library/Application Support`，Windows 是 `%LOCALAPPDATA%`。Windows 卸载时删除运行包父目录（下载残留一并删除），数据目录不动；卸载程序从 `%TEMP%` 运行且工作目录也设在 `%TEMP%`，安装目录在空了之后删除（暂时被占用时在卸载程序退出后再删一次，里面有用户自己的文件则保留）。

## 运行包替换

外壳是否需要另一份运行包只由外壳判断（`desktop/src/runtime.mjs` 的 `replacementReason`，对照 `stage/runtime.json`），两个平台同一套规则；安装程序不碰运行包。运行包的版本取 `current` 与 `last-good` 中较新的一个（应用内更新进行中时 `current` 已指向新版本）。版本先后与 `bootstrap.version_key` 相同：已退役的 5.x 排在 0.x 之前。

| 判定 | 条件 | 处理 |
| --- | --- | --- |
| `missing` | 没有可用的运行包（首次启动、上次解压中断） | 下载并解压 |
| `contract` | 运行包没有声明外壳要求的契约级别，且不比外壳新 | 下载并替换 |
| `build` | 运行包版本与外壳相同，但该版本目录的 `BUILD_ID` 不是本次构建记下的（或没有）。日常提交不改版本号，未发版构建与已发布版本同号，外壳绝不在用户不知情时沿用不配套的同版本运行包 | 下载并替换 |
| `too-old` | 运行包没有声明契约级别，且比外壳新 | 报错（请安装新版 Atelier），不动运行包 |
| 无 | 其他：版本不同且满足契约级别（更旧的由应用内更新升级，更新的绝不降级），或同版本且 `BUILD_ID` 相同（含经应用内更新升到同版本的情况，压缩包里本就带 `BUILD_ID`） | 保留 |

替换时先把压缩包解到临时目录并校验，再整体换入，失败时旧运行包原样保留；下载失败时不回落到旧运行包（`contract` 下它不满足契约，`build` 下它不配套），显示失败页。旧运行包的服务由外壳启动且有进行中的工作时先确认；用户取消则本次沿用旧运行包（明示的选择）。解压或下载途中退出：先中止再退出，下次启动清掉临时目录，未解压的完整压缩包校验通过即直接使用。

## 运行包下载

来源、文件名与地址只写在 `src/viewer_server/release_sources.json` 一处，外壳（经 `pnpm stage` 打进应用的副本）与应用内更新（`bundle_download.py`）都读它，守卫测试 `tests/test_release_sources.py` 断言两边没有各自的副本。

| 项 | 约定 |
| --- | --- |
| 版本 | 与外壳同版本（`stage/runtime.json` 的 `version`）；升级交给应用内更新 |
| 来源顺序 | 按文件里的顺序：CNB（`direct_first`：先不经代理，再按系统代理）→ GitHub（系统代理）。只有网络错误、5xx、404 或校验预检不符才换下一个 |
| 地址 | `<来源>/download/v<版本>/GameAtelier-<版本>-<平台>.<zip / tar.gz>`，同目录 `.sha256` |
| 校验 | 信任锚是构建时记下的 sha256，不取自来源。每个来源先取 `.sha256`（≤1 KiB）预检：与内嵌值不同或取不到就跳过该来源、不下载；下载完对整份文件按内嵌值校验，不符则删掉换下一个来源 |
| 续传 | `.part` 与记录的版本、sha256 一致时带 `Range` 继续；来源不支持 Range 则从头下 |
| 重试 | 同一来源网络错误、5xx 重试 2 次（2 s、5 s）；30 秒没有数据算卡住；不设总时限 |
| 空间 | 开始前检查：剩余字节 + 400 MiB（解压后）+ 100 MiB，不够直接显示还需多少 |
| 取消 | 保留 `.part`，加载页显示「下载已暂停」：继续下载（续传）/ 从文件导入 |
| 从文件导入 | 文件名须为 `GameAtelier-<外壳版本>-<平台>.<扩展名>`，sha256 须等于内嵌值，否则拒绝并提示需要的版本，运行包根不变。离线安装与未发版构建试装都走这条 |
| 测试源 | `GAME_ATELIER_TEST_UPDATE_FEED`（仅在 `GAME_ATELIER_TESTING=1` 时生效，只许本机 http 地址）替换全部来源；外壳另允许逗号分隔多个地址。与应用内更新同名同限制 |

## 契约级别

外壳不比较版本号判断运行包能做什么：同一版本号的测试包重装时，外壳是新的，已解压的运行包却还是早先那份，版本号相同、内容更旧。运行包改为显式声明，外壳只认声明。

- `scripts/build_release.py` 的 `DESKTOP_CONTRACT` 写进每个版本目录的 `DESKTOP_CONTRACT`；外壳要求的级别是 `desktop/src/runtime.mjs` 的同名常量，两边必须相等（守卫测试检查）。
- 级别 2：`bootstrap.py` 认识 `--desktop-start`；页面用 `app-region` 声明拖动区、通过 `window.atelierShell` 报告深浅色、在 `data-titlebar="overlay"` 下给窗口按钮留位。外壳开始依赖运行包的新能力时，两边一起加一。
- 外壳读 `current` 与 `last-good` 两个版本的标记，两个都达到要求才算满足：`last-good` 的 `bootstrap.py` 负责解析参数，`current` 提供页面（回滚时改由 `last-good` 提供）。文件缺失、内容不是整数，一律按 0 处理。
- 不满足的运行包按「运行包替换」下载替换，外壳只用 `--desktop-start` 启动，窗口始终隐藏系统标题栏。
- 应用内更新从同一种发布压缩包解出整个版本目录，标记随之更新。

## 固定启动器

macOS：外壳只调用运行包根下的固定启动器 `启动.command`，不自己选版本、不直接找解释器。启动器无参数时等同 `--select-version`；有参数时原样转给 `bootstrap.py`。

Windows：外壳不经 `launch.ps1`，而是做 `launch.ps1` 做的同一件事——读 `last-good`，用 `versions\<版本>\python\python.exe` 运行 `versions\<版本>\app\scripts\bootstrap.py`，设 `PYTHONPATH=…\app\src`、`PYTHONUTF8=1`，以无控制台窗口方式启动。这样 `launch.ps1`（双击启动与常驻任务的入口）一行不改；每次调用省掉 PowerShell 的启动时间；Python 的 UTF-8 输出不经 PowerShell 转码，中文数据目录也能原样传回。选版本仍由 `bootstrap.py --select-version` 负责。下表的参数两个平台相同。

这条启动规则因此写了两份：`scripts/build_release.py` 生成的 `launch.ps1`，以及 `desktop/src/runtime.mjs` 中 `launcher` 的 Windows 分支。指针文件、解释器与入口的相对路径、`PYTHONPATH`、`PYTHONUTF8`、要清除的环境变量，改其中一处必须同步另一处；`tests/test_desktop_shell_contract.py` 用同一张规则表同时检查两边。

| 调用 | 用途 | 约定 |
| --- | --- | --- |
| `--print-data-root` | 数据目录 | 标准输出只有一行绝对路径；与服务端 `data_root.resolve_data_root()` 结果一致。外壳不另写解析规则 |
| `--desktop-start` | 启动服务 | 外壳确认没有可用实例后调用。选版本、恢复更新事务与 `--select-version` 相同；之后不联网检查更新（运行中的服务自己检查），没有启动记录时不先停服务，服务端跳过运行包模式下的 `bootstrap --check`。退出码 0 表示服务已通过实例验证，标准输出最后一行是服务使用的数据目录；非 0 时 stderr 末尾是给用户看的原因。不打开浏览器 |
| `--run -m viewer_server.server stop` | 停止服务 | 外壳显式传 `GAME_ATELIER_DATA_ROOT` 为它接管服务时的数据目录（页面可能已改了配置的数据目录，服务记录仍在旧目录） |

启动器自带 8 秒验证时限，超时以 1 退出（stderr 为「尚未通过实例验证」），但服务进程照常在启动。换上新运行包后的首次启动常超过这个时限（系统要先检查一遍原生库），所以外壳不以启动器的退出码作结论：`--desktop-start` 返回后，无论退出码是几，外壳都再按服务记录（`server.port` + 状态接口核对 `server.instance`）等最多 30 秒，核对到服务就照常使用并记为外壳启动的服务；等不到才显示启动失败，原因取启动器 stderr 的末尾。

macOS 启动器只在当前版本的解释器带 `com.apple.quarantine` 时才递归清除运行包的隔离属性（压缩包解压出来的文件都带它）；外壳下载并解压的运行包不带，遍历约 1.2 万个文件的那一秒不再每次都付。

## 安装程序与外壳的参数

Windows 外壳是 electron-builder 产出的应用目录，由 Windows 安装程序（`desktop/setup`）整体安装；macOS 外壳是 dmg 里的应用包。两者都不带运行包，首次启动下载（见「运行包下载」）。

| 参数 | 约定 |
| --- | --- |
| `--quit` | 已有实例在运行时，该实例走正常退出流程（有进行中的任务会先确认），本次启动以 0 退出；没有实例时直接以 0 退出 |

AppUserModelID 等于 `desktop/electron-builder.yml` 的 `appId`（构建时以 `atelierAppId` 写进应用元数据）；安装程序创建的快捷方式必须带同一个值。外壳继续写 `<运行包父目录>\window-theme`（`light` / `dark`），安装程序据此决定深浅色。

Windows 没有菜单栏，`Ctrl+,` 打开设置、`F5` / `Ctrl+R` 重新载入、`F11` 全屏，托盘菜单有「显示 / 查看日志 / 退出」。

## Windows 安装程序（`desktop/setup`）

`Atelier-<版本>-windows-x64-setup.exe` 是 Atelier 自己的安装程序（Rust + WebView2 界面，不用 NSIS），不认外壳用什么构建：它只接收「应用目录 + 主程序相对路径 + `appId`」，不带运行包。这些附在安装程序本体后面（格式见 `desktop/setup/src/payload.rs`，`setup/` 下的条目只给安装程序自己用，即 WebView2 引导程序），由 `scripts/build_desktop.py` 的 `write_payload` 写入，守卫测试比对两边。卸载程序 `uninstall.exe` 是同一个程序去掉附件、清单标为卸载，并记下安装时放进安装目录的每个文件。

| 用法 | 行为 |
| --- | --- |
| 双击 | 窗口：立即安装（「更改」可改位置，选的目录名不是产品名时在其下建 `Atelier\`；可关桌面快捷方式）→ 进度（复制应用目录）→ 开始使用（打开应用，由应用下载运行环境）。已安装时为「立即更新」，沿用原位置 |
| `--silent [--dir <路径>] [--no-desktop-shortcut]` | 无界面安装；退出码 0 成功、1 失败、3 应用仍在运行 |
| `uninstall.exe [--silent]` | 先把自己复制到 `%TEMP%` 再运行；停止安装目录与运行包根下的进程，删除快捷方式、「设置 → 应用」条目、运行包父目录（`<本地应用数据>\game-atelier\runtime`），以及安装时记下的文件和因此变空的文件夹。数据目录与 WebView 本地存储不动 |
| `--preview <界面>`、`--auto` | 只供 CI 截图：渲染某个界面不做任何事；自动点主按钮 |

覆盖安装时先调用已安装外壳的 `--quit`（有进行中的工作由外壳确认），等安装目录里的进程全部退出，再等要替换的文件都不被其他程序占用（最多 30 秒，超时报出被占用的文件，安装目录不变，可直接重试）；新文件先全部写成同目录的 `.partial`，最后逐个替换，替换遇到占用时退避重试约 15 秒；不碰运行包，是否需要另一份运行包由外壳下次启动时决定（见「运行包替换」）。写入的位置：安装目录、开始菜单与桌面 `<产品名>.lnk`（带 `System.AppUserModel.ID` = `appId`）、`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<产品名>`（与此前的 NSIS 安装器相同，覆盖安装会接管旧安装，旧的 `HKCU\Software\atelier\<产品名>` 被删除）。深浅色读 `<运行包父目录>\window-theme`。缺 WebView2 时先用系统对话框询问，再用附带的引导程序联网安装。安装程序的 WebView 配置放在 `%TEMP%\atelier-setup-webview2`，日志写 `%TEMP%\atelier-setup.log`。

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
- 页面只拿到一个接口：preload 暴露的 `window.atelierShell.setTheme("light" | "dark")`（页面的深浅色，外壳记下来，下次启动的窗口底色与加载页跟着走）。内置加载页另有 `window.atelierLoading.retry()` / `openLog()` / `cancel()` / `resume()` / `importFile()`。主进程收到的每条消息都核对发送方是主框架且来自本机服务或加载页；页面运行在沙箱里、没有 Node。插件的沙箱 iframe（`srcdoc`，origin 为 `null`）拿不到任何接口。
- 拖动窗口与双击缩放由页面的 `app-region: drag`（顶栏）交给系统处理；根元素声明 `no-drag`，避免沿用上一页的拖动区。
- preload 在页面脚本之前给 `<html>` 写 `data-shell="macos|windows"` 与 `data-titlebar="overlay"`：macOS 页面给左上红绿灯留位，Windows 页面给右上系统按钮留位（`env(titlebar-area-*)`，按钮高 40px、背景透明、符号颜色跟随深浅色）；铺满窗口的浮层用 `desktop-clear-top` 避开它们。网页自带的右键菜单被屏蔽（输入框与选中文字除外）。
- 外壳向页面派发的 `window` 事件：下载落盘后 `atelier:download-saved`（`detail: { name }`）；系统菜单「设置…」`atelier:navigate`（`detail: { path }`，站内路径）。页面可选择监听，浏览器里不会出现。
- `127.0.0.1` 以外的导航与新窗口转交系统浏览器。
- 关窗口收进托盘，服务继续运行；退出时只停止外壳自己启动的服务，有进行中的工作先确认。
