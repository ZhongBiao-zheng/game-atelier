# Game Atelier

**本地创作画布、项目参考库与 AI 生成工具。**

在画布中组织素材与生成任务，用项目规范和参考库约束创作；模型调用使用自己配置的服务，资产保存在本地。

---

## 快速安装

### 方式一：插件市场（推荐，支持 `claude plugin update` 一键更新）

```bash
claude plugin marketplace add ZhongBiao-zheng/game-atelier
claude plugin install game-atelier@atelier
```

### 方式二：本地源码包（要看 / 改代码，或离线分发）

```bash
git clone https://cnb.cool/ZhongBiao-zheng/game-atelier.git   # 国内镜像，与 GitHub main 同步
```

仓库自带一键安装脚本，自动检测本机已装的代理（Claude Code / Codex），把 Skill 软链过去：

```bash
# macOS / Linux
./install.sh

# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会报告每个代理「装好了 / 没检测到跳过」，重启代理后生效。以后更新源码后请再运行一次安装脚本；一键启动器会自动执行这一步。卸载加 `--uninstall`。

也可只在当前会话临时加载（不落地）：

```bash
claude --plugin-dir .
```

> Windows 同事详细步骤见 [`docs/windows-install-checklist.md`](docs/windows-install-checklist.md)。
>
> 团队库目录格式（供其他工具读写）见 [`docs/team-library-format.md`](docs/team-library-format.md)。

---

## 首次启动

运行 `/game-atelier:viewer-server`，按指引完成本地初始化：

1. **数据目录** — 默认 `~/game-atelier/`（可自定义）
2. **Python 环境** — 在数据目录内自动创建 `.venv`，无需手动安装依赖
3. **API Key** — 打开本地 Web UI，在设置页添加图像服务 Key
4. **Agent 授权** — 设置 → 本机 Agent 连接，选择项目与能力；按[本机 MCP 说明](docs/mcp-local-client.md)配置 Codex / Claude

外部 Agent 通过 `canvas_*` MCP 工具操作项目；计费生成前需明确确认。凭据只保存在本地受保护的文件中。

## 命令列表

| 命令 | 用途 |
|---|---|
| `/game-atelier:viewer-server` | 启动本地 Atelier |
| `/game-atelier:canvas` | 通过已授权工具编辑项目画布 |

## 典型工作循环

1. 打开 Atelier，在画布入口创建项目。
2. 添加项目规范、参考素材和生成节点。
3. 在画布或创作台确认生成，查看结果并将合适的作品定稿到参考库。
4. 通过内置 Agent 或已授权的外部 Agent 继续编辑。

## 数据目录结构

数据与插件分离，卸载插件不会删除资产。

```
~/game-atelier/
├── canvases/<project_id>/    # 项目文档、规范、经验与媒体
├── studio/<job_id>/          # 创作台结果
├── creation-assets/         # 创作资产库
├── .runtime/jobs/           # 当前任务
└── .config/keys.json        # 模型服务配置
```

旧工坊的 characters/、projects/ 原文件保留，可手动归档。退役说明见 [ADR-0027](docs/adr/0027-canvas-project-is-the-project.md)。

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
| Agent 提示没有授权 / MCP 工具 | 从本地设置创建项目授权，按 MCP 说明配置客户端；不退回直接出图命令 |
| 另一个页面正在编辑 | 先保留旧页草稿，再显式接管；不同时编辑两份页面 |
| API Key 填错 | 在 Web 设置页更新或删除后重新添加 |
| 旧 server.pid 残留 | 启动时自动探活并清理 |
| 更新被 `web/dist` 本地改动挡住 | 双击 `Mac一键修复.command` 或 `Windows一键修复.bat` |

### 一键更新 / 修复

源码版仓库会保留一份已经构建好的 `web/dist`，因此新下载或 `git clone` 的用户不需要安装 Node / pnpm；一键启动只读取这份发布文件，不会在启动时重新构建或改写它。

一键启动与 Skill 共用数据目录内的 `.venv`（默认 `~/game-atelier/.venv`）。首次启动自动准备环境；之后只有 `pyproject.toml`、`uv.lock`、`.python-version` 或源码安装路径变化才同步依赖，普通源码更新和重复启动不会重新安装。需要同步时会先停止占用该环境的本机服务，避免 Windows 文件锁阻止安装；安装失败会中止启动，不再提示“沿用现有环境”。

Python 安装包默认走 npmmirror，Python 依赖包及构建工具默认走清华镜像；`uv.lock` 中的下载地址也使用该镜像，按锁定版本安装，启动时不改写锁文件。已有环境升级到这套启动流程后会同步一次。

如果旧版一键启动曾经留下 `web/dist` 改动，直接双击对应系统的“一键修复”脚本。脚本会先自检，只还原可再生成的 `web/dist`，再执行 fast-forward 更新；项目资产、配置和其他源码改动都不会被清理。

也可以在项目根目录手动执行同样的安全恢复：

```bash
git restore --source=HEAD --staged --worktree -- web/dist
git clean -fd -- web/dist
git pull --ff-only
```

旧版 Git 没有 `git restore` 时，第一行改用 `git checkout HEAD -- web/dist`。ZIP 下载版不含 Git 历史，不能原地更新；请重新下载最新版，已有项目资产仍保存在独立的数据目录中。

---

## 本地开发

```bash
# 安装依赖
make install

# 链接本地 Skill 到 Claude Code（重启 CC 生效）
make dev-link

# 启动（双终端）
GAME_ATELIER_DEV_ORIGIN=http://localhost:5173 uv run python src/viewer_server/server.py start # 后端
cd web && pnpm dev                                  # 前端

# 测试
make test

# 发布前检查（干净构建并刷新入库的 web/dist）
make build
uv run python scripts/check_plugin.py
claude plugin validate .
```

开发页使用 `http://localhost:5173`；前端端口变更时同步修改 `GAME_ATELIER_DEV_ORIGIN`，不使用通配来源。
该变量仅用于 Vite 开发代理，正常使用已构建的本地页面不需要设置。

---

## 安全说明

- viewer-server **仅绑定 `127.0.0.1`**，不对外网暴露
- 项目、媒体、下载和 SSE 必须有本机会话；Agent 仅使用 canvas_* 工具及 canvas_read/canvas_edit/canvas_generate 授权，计费操作前须人工确认。
- API Key 存储在本地 `.config/keys.json`，不写入任何日志或对话记录
- 图片读取接口使用 job_id 白名单，只能访问已登记的输出文件
