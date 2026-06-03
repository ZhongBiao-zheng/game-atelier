# Windows 同事安装清单

面向：拿到 game-atelier 的 Windows 同事。两条路任选其一——**路 A（市场安装，推荐）** 最省心、能一键更新；**路 B（源码软链）** 适合要看/改代码的人。

> 核心保证：你的**工作内容**（角色、spec、图片、API Key）全部存放在独立的**数据目录**（默认 `%USERPROFILE%\game-atelier`），和插件代码完全分离。无论怎么更新插件，**你的数据不会被覆盖**。

---

## 0. 前置依赖（两条路都要）

- [ ] **Claude Code** 已安装（命令行能跑 `claude`）
- [ ] **uv** 已安装（Python 包管理器）：见 https://docs.astral.sh/uv/ ，装完 `uv --version` 有输出
- [ ] （仅路 B 且要改前端时）**Node 18+** 和 **pnpm**

不需要手动装 Python 依赖——首次运行插件时会自动在数据目录建 `.venv` 并装好。

---

## 路 A：市场安装（推荐）

```powershell
# 1) 添加插件市场（一次性）
claude plugin marketplace add ZhongBiao-zheng/game-atelier

# 2) 安装插件
claude plugin install game-atelier@atelier

# 3) 启动，触发首次初始化向导
claude
#  在 Claude 里运行：
#    /game-atelier:viewer-server
#  按向导走三步：① 选数据目录（默认 ~\game-atelier 直接回车）
#               ② 自动建 .venv（等它跑完）
#               ③ 打开本地 Web 设置页，加一把图像服务 API Key
```

- [ ] `claude plugin list` 能看到 game-atelier
- [ ] `/game-atelier:viewer-server` 能打开本地 Web 画廊（浏览器 `127.0.0.1:5174`）
- [ ] Web 设置页加好了 API Key

**以后更新**（我发新版本后）：

```powershell
claude plugin update game-atelier@atelier
```

只更新插件代码，`~\game-atelier` 里的数据一律不动。

---

## 路 B：源码 + 一键软链（要看/改代码时）

```powershell
# 1) 克隆仓库
git clone https://github.com/ZhongBiao-zheng/game-atelier.git
cd game-atelier

# 2) 一键把 Skill 链接到本机已装的代理（Claude / Codex 自动检测）
powershell -ExecutionPolicy Bypass -File .\install.ps1
#  脚本会报告：哪个代理装好了、哪个没检测到就跳过

# 3) 重启 Claude Code 后，/game-atelier:* 命令可用
```

- [ ] 脚本输出里有 `+ 已安装：Claude Code -> ...\.claude\skills\game-atelier`
- [ ] 重启 Claude 后 `/game-atelier:character 测试名` 能触发

**软链权限说明**：脚本优先建符号链接（需「开发者模式」或管理员），失败会自动回退到**目录联接（Junction）**——普通权限即可，对目录最稳，一般不用额外设置。

**更新**：路 B 直接 `git pull` 即可（软链指向仓库，拉完就是最新）。

```powershell
cd game-atelier; git pull
```

卸载软链：`powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall`

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `uv` 不是可识别命令 | 没装 uv，按 https://docs.astral.sh/uv/ 装完重开终端 |
| `install.ps1` 被拦：禁止运行脚本 | 命令前加 `powershell -ExecutionPolicy Bypass -File .\install.ps1` |
| 端口 5174 被占 | 插件会自动顺延到下一个空闲端口，见数据目录 `.runtime\server.port` |
| Web 没自动打开 | 重新运行 `/game-atelier:viewer-server` |
| API Key 填错 | Web 设置页删掉重加 |
| 更新后数据没了？ | 不会。数据在 `~\game-atelier`，和插件代码分离；如担心可先备份该目录 |

---

## 一句话给同事

> 装好 Claude Code 和 uv → `claude plugin marketplace add ZhongBiao-zheng/game-atelier` → `claude plugin install game-atelier@atelier` → 在 Claude 里跑 `/game-atelier:viewer-server` 按向导加 Key → 开干。我发新版你就 `claude plugin update game-atelier@atelier`，你的角色和图都不受影响。
