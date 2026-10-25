---
name: viewer-server
description: 用户要打开 Atelier Web 画廊、首次安装初始化，或 Web 打不开需要重启本地服务时用。用于本机服务管理；画布创作由 canvas Skill 处理。
disable-model-invocation: true
---

## 排障经验

排查安装、启动或更新故障时，读取仓库根 MEMORY.md 对应小节；项目规范和 Agent 经验由画布管理。

## 启动自检（bootstrap）

每次触发本 Skill，第一步先判断当前模式：

Dev mode：`uv run python scripts/bootstrap.py --check`
Installed Plugin mode：`python3 "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.py" --check`（Windows 用 `python` 代替 `python3`，见下）
Codex mode：先解析 bootstrap.py 绝对路径（跟随软链反推 repo 根），之后所有命令都用 `$BOOT`，**绝不用 `uv run`**：

```bash
BOOT=$(python -c "import os;p=os.path.realpath(os.path.expanduser('~/.codex/skills/game-atelier-viewer-server'));print(os.path.join(os.path.dirname(os.path.dirname(p)),'scripts','bootstrap.py'))")
python "$BOOT" --check
```

> 判断模式（三选一）：① 环境变量 `${CLAUDE_PLUGIN_ROOT}` 非空 → Installed Plugin mode（Claude，一律用其下的 plugin 命令，绝不用相对路径 `scripts/bootstrap.py`）；② 为空且运行于 **Codex**（`AI_AGENT` 以 `codex` 开头，或本 skill 软链在 `~/.codex/skills/`——Codex 不会设 `${CLAUDE_PLUGIN_ROOT}`）→ **Codex mode**：用上面解析的 `$BOOT` 跑 `python "$BOOT" --run -m viewer_server.server start --background`，**per-turn 绝不 `uv run`**（Codex 沙箱外的 uv 缓存会每轮弹权限）；③ 为空且在仓库内开发 → Dev mode。插件实装路径形如 `~/.claude/plugins/cache/<市场>/game-atelier/<版本>/`，绝不能硬编码 `~/.claude/plugins/game-atelier/`。**解释器名**：路径含盘符（`C:\...`）即 Windows → 用 `python`（Windows 的 `python3` 常是损坏的 Microsoft Store 别名：`python3 --version` 假装正常，但 `python3 -c ...` / 跑脚本会异常退出，如 exit 49）；macOS/Linux → 用 `python3`。某解释器跑插件脚本异常退出，立即换另一个名字重试，别反复试同一个。

按 status 字段分流：

- `ready` → 启动或检查本机服务
- `needs_data_root` → 用 AskUserQuestion 问数据目录路径，POST `/api/onboarding/data-root`
- `needs_uv` → 显示 next_action 字段里的安装命令，**不要替用户跑**
- `needs_venv` → 按当前模式跑 `<bootstrap.py> --ensure-venv`；Dev mode 前缀为 `uv run python`，Installed Plugin mode 前缀为 `python3`
- `needs_first_key` → 启 viewer-server，引导用户在 Web 上加第一个 Key
- `needs_keys_repair` → 告知用户 `keys.json` 损坏，建议备份后手动编辑或删除重加

## 插件更新提醒（--check 顺路返回，不阻断流程）

`--check` 输出带 `update` 字段。仅当 `update_available` 为 true 且 `dismissed` 为 false 时提醒一次：用 AskUserQuestion 问「插件有新版 v<latest>（当前 v<current>），要更新吗？」（选项：现在更新 / 这次跳过）。其余情况（字段为 null / 无更新 / 已跳过）只字不提，直接往下走。

- **现在更新**：Installed Plugin mode → 跑 `claude plugin update game-atelier`；Dev / Codex mode（git clone）→ 在仓库根跑 `git checkout -- web/dist && git pull --ff-only`（dist 是入库构建产物，先还原防挡 pull）。完成后告知用户：新版下次会话（重启 CC / 重进 skill）生效，本轮继续按当前版本工作。
- **这次跳过**：跑 `<bootstrap.py> --dismiss-update`（前缀按当前模式，同 `--check`），同一版本之后不再问；出更高版本再提。
- 更新失败（网络 / 权限）：报错原样告知，继续本轮工作，不反复重试。

# Viewer Server

## 命令

### `uv run python src/viewer_server/server.py start --background`

Skill 调用路径必须带 `--background`，否则前台 server 会阻塞当前 turn。

### `uv run python src/viewer_server/server.py start`

手动终端启动 server：
1. 检查 `.runtime/server.pid` 是否存在
2. 若进程已死：删除 pid 文件，继续启动
3. 若进程存活：不重复启动，打印实际端口
4. 默认端口 5174；被占用时 +1 直到找到空端口
5. 实际端口写入 `.runtime/server.port`
6. 监听地址固定 `127.0.0.1`

### `uv run python src/viewer_server/server.py stop`

停止 server（读 `.runtime/server.pid` 发 SIGTERM）。

### `uv run python src/viewer_server/server.py open-browser`

`open http://127.0.0.1:<port>/`（Mac）/ `xdg-open`（Linux）。

## 图片呈现（/api/raw）

`GET /api/raw?path=<相对路径>&job_id=<job_id>` 是**把本地图片以 HTTP 呈现给画师**的通道之一：
用于「HTML 渲染且不能访问本地文件」（`http://` 页面，如 DeepSeek Harness GUI / 远程网页）的场景。
完整规则见 `docs/references/image-presentation.md`（三渲染通道：终端内联图像 / HTML 可访问本地 /
HTML 不可访问本地——本接口只服务第三种有后端的情况；无后端时用 base64 data URI 兜底），要点：

- 相对路径基准 = data root（如 `canvases/<id>/outputs/<job_id>/v2.png`），不是 CWD。
- **必须带 job_id**：以该 job 的 `output_paths` / `reference_images` / `source_image` 作白名单，
  对不上 → 403。这是 job 白名单鉴权，别绕。
- 端口读 `.runtime/server.port`（默认 5174，被占用 +1），别写死。
- `read_image` 工具（agent 自己看图）与 `/api/raw`（呈现给画师）是两回事：模型不支持图片输入时
  `read_image` 会报错，属正常，不代表出图失败；呈现画师永远走 Markdown 图片 + 可加载地址。

## 单 tab 约束

同一时间只支持一个浏览器 tab 操作。多 tab 行为未定义（v2.3 Outside Voice #4 限制）。
画师指南需写明。
