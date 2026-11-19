---
status: accepted
---

# 桌面外壳从 Tauri 换成 Electron

2026-11-18 定：桌面外壳（`desktop/`）改用 Electron，Tauri 外壳删除。

> 2026-11-19 起安装包不再内嵌运行包、首次启动下载（ADR-0042）。下文「种子解压」「是否用种子替换」两条与代价里的 dmg 体积按当时的做法记录，现行规则见 ADR-0042 与 `docs/contracts/desktop-shell.md`。外壳与运行包之间的契约（运行包位置、种子、`--desktop-start`、`DESKTOP_CONTRACT`、服务记录、控制接口）不变，见 `docs/contracts/desktop-shell.md`。

## 背景

- Tauri 外壳在 macOS 上用系统的 WKWebView。两天内遇到三个 WebKit 特有问题：画布放大后发虚、主题色色块圆角不裁切、AV1 视频不能播放。Chrome 与 Windows（WebView2 即 Chromium）都没有这些问题，同一套页面要在两种内核上分别排查。
- WKWebView 跟随系统版本，不能锁定；用户机器上的内核版本由 macOS 决定。
- Tauri 安装器从未对外发布，现在换没有用户迁移成本；发布后再换要处理安装位置与应用标识的迁移。
- 团队使用的四个重点（稳定性、任务并发、网络连接、计费）由服务与数据层决定，与外壳选型无关；换壳只影响内核一致性与安装体验。

## 决定

- 外壳用 Electron（主进程 `desktop/src/main.mjs`），electron-builder 打包：macOS 出 dmg（ad-hoc 签名），Windows 只出应用目录，由自己的安装程序安装。
- 安全边界：`contextIsolation`、`sandbox`、不开 Node；preload 只暴露 `window.atelierShell.setTheme` 与加载页的 `window.atelierLoading`；主进程逐条核对消息的发送方框架；导航只允许本机服务与内置加载页；Electron fuses 关闭 `runAsNode`、`NODE_OPTIONS` 与 `--inspect` 参数，只从校验过完整性的 asar 加载应用。守卫测试在 `tests/test_desktop_shell_contract.py`。
- 窗口隐藏系统标题栏。macOS 红绿灯压在页面顶栏上；Windows 由系统在右上角画 40px 高的最小化 / 最大化 / 关闭按钮（背景透明，符号颜色跟随深浅色）。页面用 `app-region` 声明拖动区。
- 种子解压：macOS 用系统 bsdtar 流式解压；Windows 用自带的 zip 中央目录解析加 `worker_threads` 多线程解压，不引入依赖。
- 是否用种子替换已有运行包只由外壳判断（`replacementReason`）：运行包缺失、没有声明契约级别、版本低于种子、同版本但种子是另一次构建时替换；运行包版本不低于种子时保留，应用内更新升上去的版本不会被降级。Windows 安装程序不比较版本，只调用外壳的 `--prepare-runtime`。
- Windows 用 Atelier 自己的安装程序（`desktop/setup`，Rust + WebView2 界面），不用 NSIS。它只接收「应用目录 + 主程序路径 + `appId`」，不依赖外壳用什么构建；安装时调用外壳 `--prepare-runtime` 解压运行环境，覆盖安装前调用 `--quit`。
- 不购买代码签名证书：macOS ad-hoc 签名、未公证，Windows 安装程序与应用都不签名。首次打开的放行步骤写在 `docs/release-notes.md`。

## 实测对比

同一台 Apple Silicon 机器、隔离 HOME 与空数据目录，各 3 次取中位数（桌面体验方案 1.1 的测法；Tauri 基线为同一版本只改标识的构建，两边的种子相同）。

| 项 | Tauri | Electron |
| --- | --- | --- |
| 首次打开到页面可交互 | 12.8 秒 | 9.7 秒 |
| 冷启动到页面可交互 | 2.05 秒 | 1.72 秒 |
| 服务已在运行时打开 | 0.77 秒 | 0.56 秒 |
| macOS 种子解压 | 6.0 秒（Rust tar） | 2.6 秒（系统 bsdtar） |
| 三个 WebKit 问题 | 存在 | 都不复现（放大 3.5 倍且强制 `backdrop-filter` 仍清晰；色块圆角正确；AV1、HEVC、H.264、VP9 都能播放） |
| dmg | 131.5 MiB | 235.4 MiB |
| 首页内存（外壳进程合计，不含 Python 服务） | 324–340 MiB | 471–490 MiB |

Windows（GitHub Actions `windows-latest`，13446 个条目）：解压 12 次中位数 9.3 秒、最慢 18.8 秒，同一份代码在不同 runner 上相差一倍（原因未查明）；此前 Rust 实现在同类 runner 上 7.7–9 秒。应用目录压缩包 279.1 MiB，其中运行包 142.9 MiB。

## 代价

- **包体**：dmg 多约 104 MiB（Electron 自带 Chromium 与 Node）。Windows 同样多出 Chromium；Tauri 在 Windows 上用系统自带的 WebView2，换壳在 Windows 上的内核收益很小。
- **内存**：首页多约 150 MiB；画布页 Electron 测得约 500 MiB，Tauri 一侧没测成。
- **Windows 安装程序**：不用 NSIS，改为自绘安装程序，要单独维护（`desktop/setup`）。它自己的界面仍用 WebView2，缺 WebView2 时先询问再联网补装。CI 冒烟覆盖全新安装、运行中覆盖安装、旧运行包上的升级安装、新运行包上的安装与卸载。
- **未签名**：macOS 首次打开要到「隐私与安全性」放行，Windows 有 SmartScreen 提示；开启「智能应用控制」的 Windows 11 无法运行。签名与公证需要证书，本次不做。
- **外壳不随应用内更新**：Chromium 的安全更新要发新的安装包才能到达用户。
