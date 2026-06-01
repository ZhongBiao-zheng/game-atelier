# Game Atelier

游戏角色资产工坊 — Claude Code Plugin + 本地 Web UI，画师可视化管理角色档案与 AI 出图。

## 安装

### macOS / Linux

```bash
claude plugin install game-atelier@claude-community
```

首次触发 `/game-atelier:character` 会引导：
1. 选数据目录（默认 `~/character-workflow/`）
2. 装 `uv`（如果还没装）
3. 自动 `uv sync` 装 Python 依赖
4. 在 Web 上加第一个 API Key

### Windows

```powershell
claude plugin install game-atelier@claude-community
```

向导步骤同上。装 `uv` 命令：

```powershell
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

数据目录默认 `C:\Users\<user>\character-workflow\`。

### 开发模式（仓库内）

```bash
git clone https://github.com/zhengzhongbiao/game-ui-ai-workflow
cd game-ui-ai-workflow
make install
make dev-link
export CHARACTER_WORKFLOW_DATA_ROOT=$(pwd)
```

Dev 模式跳过 onboarding 向导，仓库根直接当 data root。

## 快速开始

### 启动

终端 A — viewer-server：
```bash
uv run python src/viewer_server/server.py start
```

终端 B — 前端（开发模式）：
```bash
cd web && pnpm dev
```

打开浏览器：`http://localhost:5173/`

首次启动会要求选图片存储目录。

### 在 Claude Code 中触发 Skill

安装态命令使用 Plugin namespace：

```text
/game-atelier:character 暗影刺客女
/game-atelier:promo
/game-atelier:turnaround
```

开发模式通过 `make dev-link` 软链到本仓库时，也可以用短命令：

```text
/character 暗影刺客女
/promo
/turnaround
```

Skill 会读 `characters/<id>/spec.md`、调图像 API 出图、把 jobs 状态写到 `.runtime/jobs/`。

### 工作循环

1. 在 Web 上看图 / 改 spec / 改 prompt / 写反馈
2. 点保存 → 浏览器自动复制"继续"到剪贴板
3. 切到 CC 窗口（Cmd+Tab）→ Cmd+V + Enter
4. Skill 继续下一轮

## 故障排查

| 现象 | 解决 |
|---|---|
| 端口 5174 被占用 | server 会自动 +1 找空端口，看 `.runtime/server.port` |
| `server.pid` 残留 | start 命令会自动清理 stale PID |
| 剪贴板失败 | toast 内显示"手动复制"按钮，点一下即可 |
| 浏览器不支持 clipboard API | 推荐 Chrome / Edge；Safari 在 HTTPS / localhost 下也可用 |
| 多 tab 行为异常 | **限制**：同一时间只开一个 tab |

## 项目结构

见 `docs/api-contract.md` 和 `docs/plans/2026-05-15 游戏角色资产工作流-产品形态设计方案-v2.md`。
