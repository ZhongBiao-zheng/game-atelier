# Game Atelier

Game Atelier 是给游戏美术和独立游戏团队用的角色资产工作流：Claude Code Skill 负责对话、建档、写 prompt 和提交出图任务，本地 Web UI 负责查看角色、编辑 spec、管理图片与 API Key。

## 安装

从 Claude Code 已配置的 marketplace 安装：

```bash
claude plugin install game-atelier@claude-community
```

如果你拿到的是本地源码包或审核用目录，可以临时加载：

```bash
claude --plugin-dir .
```

安装后使用命名空间命令：

```text
/game-atelier:viewer-server
/game-atelier:character 暗影刺客女
/game-atelier:promo
/game-atelier:turnaround
```

## 首次启动

第一次触发 `/game-atelier:viewer-server` 或 `/game-atelier:character` 时，插件会按顺序检查：

1. 数据目录：默认 `~/character-workflow/`，Windows 默认 `C:\Users\<user>\character-workflow\`
2. `uv`：缺失时只显示安装命令，由你手动安装
3. Python venv：自动在数据目录下创建 `<data_root>/.venv/`
4. API Key：打开本地 Web UI，引导你在设置页添加第一把图像 API Key

数据目录里会保存 `characters/`、`projects/`、`.runtime/`、`.config/keys.json` 和生成图片。卸载插件不会删除这些用户资产。

## 插件会做什么

- 启动本地 FastAPI viewer-server，只绑定 `127.0.0.1`
- 在浏览器打开本地 Web UI，用来管理角色、图片、spec 和出图任务
- 在数据目录创建和更新角色档案、job JSON、运行时状态和 API Key 配置
- 通过你配置的图像服务 API Key 发起外部出图请求
- 把生成结果下载到 `<data_root>/characters/<id>/portrait|promo|turnaround/`

API Key 不写入 job patch、turn-start 输出或普通日志；server 日志带 secret redaction filter。

## 工作循环

1. `/game-atelier:viewer-server` 打开 Web UI
2. `/game-atelier:character 角色名` 创建或继续角色
3. 在 Web 上查看图片、修改 spec、保存反馈
4. 回到 Claude Code 继续对话，确认后提交出图
5. 需要宣传图或三视图时调用 `/game-atelier:promo` 或 `/game-atelier:turnaround`

同一时间只建议打开一个 Web tab。

## 故障排查

| 现象 | 处理 |
|---|---|
| `uv` 未安装 | 按插件输出的命令安装后重试 |
| 端口 5174 被占用 | viewer-server 会自动使用后续空闲端口，端口记录在 `<data_root>/.runtime/server.port` |
| 旧 `server.pid` 残留 | 启动时会探活并清理 stale PID |
| Web UI 没打开 | 重新运行 `/game-atelier:viewer-server` |
| 剪贴板失败 | Web toast 会显示手动复制按钮 |
| API Key 填错 | 在 Web 设置页更新或删除后重加 |

## 本地开发

仓库开发模式才需要下面这些命令：

```bash
make install
make dev-link
export CHARACTER_WORKFLOW_DATA_ROOT=$(pwd)
uv run python src/viewer_server/server.py start
```

发布前检查：

```bash
cd web && pnpm build
cd ..
uv run python scripts/check_plugin.py
claude plugin validate .
```
