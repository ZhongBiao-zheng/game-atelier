---
name: viewer-server
description: |
  显式启动、停止、重启或打开本机 Atelier 服务的运维入口，服务仅绑定 127.0.0.1。
  用户要开窗看图、启动本机工坊或排查启动环境时使用；不用于执行生成、读取项目资料或绕过 MCP 授权。
---

# 本机 Viewer Server

仅在用户明确要求启动 / 停止 / 重启 / 打开服务时执行对应操作。
Character、UI、Video 等业务 Skill 已走 MCP；连接失败不能自动切换到本 Skill 直接生成。
不读取业务 spec、全局记忆、供应商密钥，不改 Job。

## 启动自检

根据当前插件来源选择一个入口，不猜不存在的安装目录：

- Dev mode：仓库中用 `uv run python scripts/bootstrap.py --check`。
- Installed Plugin mode：`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --check`。
  Claude 注入的根为真实插件缓存目录，不硬编码用户插件路径。
- Codex mode：从**当前已加载 Skill 的真实目录**向上两级定位 scripts/bootstrap.py，
  将该绝对路径作为 `$BOOT`，用 `python "$BOOT" --check`；
  per-turn 绝不为业务工具连接反复执行 `uv run`。

Windows 用 `python`，不用 `python3`（Microsoft Store 别名可能出现 exit 49）；
已知解释器异常应先说明并核对实际环境，不循环执行安装。
自检只用于明确的本机运维任务，不是每次艺术创作的前置脚本。

| 自检状态 | 处理 |
| --- | --- |
| ready | 执行用户请求的服务操作 |
| needs_data_root | 请用户在本机首启向导选择数据目录，不自行写配置 |
| needs_uv / needs_venv | 说明缺项与安装入口；需要安装时单独取得用户同意 |
| needs_first_key | 打开本机页面，让用户在供应商设置添加 Key |
| needs_keys_repair | 说明配置读取失败，请用户在本机管理，不能打印密钥内容 |

不借运维请求自动拉代码、还原文件、升级插件或删除配置；版本号和 GitHub 入口由产品界面展示。

## 启动、停止、打开

Skill 启动要带 `--background`，避免前台进程阻塞对话。

开发环境：

```bash
uv run python src/viewer_server/server.py start --background
uv run python src/viewer_server/server.py stop
uv run python src/viewer_server/server.py open-browser
```

安装模式按用户请求选择一条，不把全部命令连续执行：

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --run -m viewer_server.server start --background
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --run -m viewer_server.server stop
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --run -m viewer_server.server open-browser
```

Codex 同样用已定位的 `python "$BOOT" --run -m viewer_server.server ...`。
重启只在用户请求时先停后启；不要停止与此项目无关的进程。

服务固定绑定 127.0.0.1；默认从 5174 起选可用端口，由启动结果给出实际地址。
不改为 0.0.0.0，不将服务暴露到局域网，不手工删除 pid 或端口文件猜测运行状态。

## 连接与媒体

启动成功后，用户在本机浏览器完成连接与编辑租约；其他标签页应只读接管提示，
不要绕过租约同时编辑。Agent 必须有独立本机授权，按
[客户端配置说明](../../docs/mcp-local-client.md) 连接 MCP。
不复制 token 到聊天、MCP 配置或 URL，不更改全局客户端设置。

看图遵循 [呈现规则](../../docs/references/image-presentation.md)：
MCP 返回有界图片内容，完整作品在已鉴权 Atelier 页查看。
不能把未经鉴权的 raw URL 发给其他客户端，也不能在媒体加载失败时开放匿名接口。
