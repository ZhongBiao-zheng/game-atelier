# Game Atelier

**游戏角色资产工作流 Plugin，让 Claude Code 成为你的游戏美术助手。**

通过对话描述角色概念，AI 自动整理 spec、生成出图 prompt，提交到你自己配置的图像服务，结果直接显示在本地 Web 画廊里。

---

## 快速安装

### 方式一：插件市场（推荐，支持 `claude plugin update` 一键更新）

```bash
claude plugin marketplace add ZhongBiao-zheng/game-atelier
claude plugin install game-atelier@atelier
```

### 方式二：本地源码包（要看 / 改代码，或离线分发）

仓库自带一键安装脚本，自动检测本机已装的代理（Claude Code / Codex），把 Skill 软链过去：

```bash
# macOS / Linux
./install.sh

# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会报告每个代理「装好了 / 没检测到跳过」，重启代理后生效。卸载加 `--uninstall`。

也可只在当前会话临时加载（不落地）：

```bash
claude --plugin-dir .
```

> Windows 同事详细步骤见 [`docs/windows-install-checklist.md`](docs/windows-install-checklist.md)。

---

## 首次启动

运行任意 `/game-atelier:*` 命令，插件自动引导完成三步初始化：

1. **数据目录** — 默认 `~/game-atelier/`（可自定义）
2. **Python 环境** — 在数据目录内自动创建 `.venv`，无需手动安装依赖
3. **API Key** — 打开本地 Web UI，在设置页添加图像服务 Key

> 数据目录（角色档案、图片、API Key）与插件完全分离，卸载插件不会影响你的资产。

---

## 命令列表

| 命令 | 用途 |
|---|---|
| `/game-atelier:viewer-server` | 启动本地 Web UI，查看角色画廊 |
| `/game-atelier:character <角色名>` | 创建或继续某个角色的工作流 |
| `/game-atelier:promo` | 给当前角色出宣传图（海报 / KV） |
| `/game-atelier:turnaround` | 给当前角色出三视图 |

---

## 典型工作循环

```
1. /game-atelier:viewer-server     → 打开 Web 画廊
2. /game-atelier:character 暗影刺客  → 开始或继续角色
3. 描述你想要的形象 → AI 整理 spec，生成 prompt 预览
4. 确认后出图 → 结果自动出现在 Web 画廊
5. 在 Web 上查看、编辑 spec、留下反馈
6. 回到 Claude Code 继续迭代
```

---

## 数据目录结构

插件在数据目录（默认 `~/game-atelier/`）中写入：

```
~/game-atelier/
├── characters/<id>/          # 角色档案
│   ├── spec.md               # 角色定义（可在 Web 编辑）
│   ├── portrait/             # 立绘图片
│   ├── promo/                # 宣传图
│   └── turnaround/           # 三视图
├── projects/                 # 项目分组
├── .runtime/                 # 运行时状态（server PID / job 队列）
└── .config/keys.json         # API Key 配置
```

---

## 支持的图像服务

只要是 **OpenAI 兼容格式** 的图像服务，配上 Key 就能用——覆盖了市面上的大多数模型：

- **OpenAI 官方**：gpt-image 系列，高质量写实风
- **火山引擎 / 豆包 Seedream**：字节系模型，中文 prompt 友好
- **第三方聚合商**：一个 Key 下挂多个模型族（如 gpt-image、nano-banana 等），按 modelId 自动识别能力（尺寸 / 比例 / 质量）
- **自定义 OpenAI 兼容端点**：填 base URL + Key 即可接入

在 Web UI 设置页配置 Key，对话时可直接说"用某某模型出这张"切换。每个模型族的尺寸、比例、质量控件会按其能力自动适配。

---

## 故障排查

| 现象 | 处理 |
|---|---|
| `uv` 未安装 | 按插件输出的命令安装，[安装文档](https://docs.astral.sh/uv/) |
| 端口 5174 被占用 | viewer-server 自动使用后续空闲端口，见 `.runtime/server.port` |
| Web UI 没打开 | 重新运行 `/game-atelier:viewer-server` |
| API Key 填错 | 在 Web 设置页更新或删除后重新添加 |
| 旧 server.pid 残留 | 启动时自动探活并清理 |

---

## 本地开发

```bash
# 安装依赖
make install

# 链接本地 Skill 到 Claude Code（重启 CC 生效）
make dev-link

# 启动（双终端）
uv run python src/viewer_server/server.py start    # 后端
cd web && pnpm dev                                  # 前端

# 测试
make test

# 发布前检查
cd web && pnpm build
cd .. && uv run python scripts/check_plugin.py
claude plugin validate .
```

---

## 安全说明

- viewer-server **仅绑定 `127.0.0.1`**，不对外网暴露
- API Key 存储在本地 `.config/keys.json`，不写入任何日志或对话记录
- 图片读取接口使用 job_id 白名单，只能访问已登记的输出文件
