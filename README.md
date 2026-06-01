# Game Atelier

**游戏角色资产工作流 Plugin，让 Claude Code 成为你的游戏美术助手。**

通过对话描述角色概念，AI 自动整理 spec、生成出图 prompt，提交到 Lovart / GPT Image 等图像服务，结果直接显示在本地 Web 画廊里。

---

## 快速安装

```bash
claude plugin install game-atelier@claude-community
```

如果你拿到的是本地源码包，可以临时加载：

```bash
claude --plugin-dir .
```

---

## 首次启动

运行任意 `/game-atelier:*` 命令，插件自动引导完成三步初始化：

1. **数据目录** — 默认 `~/character-workflow/`（可自定义）
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

插件在数据目录（默认 `~/character-workflow/`）中写入：

```
~/character-workflow/
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

| Provider | 说明 |
|---|---|
| Lovart | 默认推荐，支持风格参考图 |
| GPT Image 2 | OpenAI 高质量写实风 |
| Seedream | 字节系模型，中文 prompt 友好 |

在 Web UI 设置页配置 Key，对话时可直接说"用 GPT Image 出这张"切换。

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

# 链接本地 Skill 到 Claude Code（修改 SKILL.md 立即生效，无需重启）
make dev-link
export CHARACTER_WORKFLOW_DATA_ROOT=$(pwd)

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
