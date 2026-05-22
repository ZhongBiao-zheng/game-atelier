# Skill 分发架构设计 — Plugin 化、数据剥离、多 API Key、跨平台

**日期：** 2026-05-22
**状态：** Draft, awaiting user review
**作者：** Brainstorming session (Claude Code + 用户)
**前置 spec：** `2026-05-21-project-scoped-memory-design.md`（项目级 Memory，已通过）

---

## 目标

把当前"仓库即工作目录"形态改造成**可分发的 Claude Code Plugin**，让目标用户（AI 时代设计师，会装 Skill / 用 Vibe Coding 工具）能做到：

1. `claude plugins install` 一条命令装好
2. 第一次说 `/character-workflow` 自动走 onboarding 向导
3. Web UI 内自助添加多家图像 API Key
4. AI 调 Skill 时按 Key 能力自动选合适的（用户可指定默认 / 点名切换）
5. 数据与代码彻底分离 — 卸载 Plugin 不丢数据，Plugin 升级不影响数据
6. macOS / Linux / Windows 三平台均可用（CI 先覆盖 mac+linux，Windows 走手动验证）

## 非目标

- 多 workspace 支持（一个用户多个 data root） — 后续 spec
- 多 provider caller 实现（Lovart 外，openai/mj/nano_banana/seedream 留 stub） — 后续 spec
- Cloud sync / 远端备份 keys.json — 后续 spec
- Plugin 自我升级 / update check — 后续 spec
- viewer-server 改 Node.js — 不计划做
- Plugin marketplace 上架流程（操作性，不属于设计） — 不在此 spec

---

## 1. 架构总览 — 代码与数据彻底分家

### 1.1 Plugin 安装目录（只读，跟 Plugin 版本走）

```
~/.claude/plugins/game-ui-ai-workflow/
  plugin.json                        ← Plugin manifest，声明 4 个 Skill + bootstrap
  skills/
    character-workflow/
      SKILL.md
      references/                    ← lessons / portrait.md 等参考资料
    character-promo/SKILL.md         (同上含 references)
    character-turnaround/SKILL.md    (同上含 references)
    viewer-server/SKILL.md
  src/                               ← Python 源码
    character_workflow/
      __main__.py
      lib/
        data_root.py                 ← 新增：resolve_data_root()
        keys.py                      ← 新增：keys.json CRUD
        callers/
          lovart.py                  ← 从 lovart_caller.py 重构
          # openai.py, midjourney.py 等暂留 stub
        projects.py, lessons.py, turn_start.py, jobs.py, ...
    character_promo/
    character_turnaround/
    viewer_server/
      server.py, routes.py, watcher.py, ...
  web/dist/                          ← Vite 构建产物（build 时生成，不入 git）
  pyproject.toml                     ← uv sync 依赖清单
  scripts/
    bootstrap.py                     ← onboarding 入口（仅 stdlib）
    check_plugin.py                  ← release 前校验脚本
  README.md
```

### 1.2 用户数据目录（可写，跟用户走 / 备份 / iCloud / 跨机搬迁）

```
<data_root>/                         ← 默认 ~/character-workflow/，首次启动向导可改
  .config/
    keys.json                        ← API Key（chmod 600 / Windows ACL）
    config.json                      ← workspace 偏好（UI 状态等）
    venv-hash                        ← pyproject.toml 的 hash，用于检测依赖变化
  .venv/                             ← uv sync 出的隔离 Python 环境
  .runtime/
    server.pid, server.port
    projects.json                    ← project meta + assignments
    active-character.json
    jobs/<job_id>.json
    draft/, draft-processed/
  projects/<slug>/                   ← 项目级 MEMORY + worldview（前置 spec 已定）
    MEMORY.md
    worldview.md
  characters/<id>/                   ← 角色资产
    spec.md, portrait/, promo/, turnaround/, source/
  MEMORY.md                          ← workspace 级（兜底）
  worldview.md                       ← workspace 级（兜底）
```

### 1.3 全局配置（极简，只记 data root 在哪）

| 平台 | 路径 |
|---|---|
| macOS / Linux | `~/.config/character-workflow/data-root` |
| Windows | `%APPDATA%\character-workflow\data-root` |

文件内容：单行绝对路径，例如 `/Users/zhengzhongbiao/character-workflow`。

用 `platformdirs.user_config_dir("character-workflow")` 统一解析，不写 `os.name` 分支。

### 1.4 关键约束

1. **Plugin 安装目录绝不写入** — 用户卸载 / 升级 Plugin 不丢数据
2. **数据目录绝不依赖 Plugin 路径** — data root 是绝对路径，Plugin 升级换路径不影响
3. **全局配置只记 `data-root` 一行** — 别的全在 data root 内部，方便整目录搬家
4. **`.venv/` 在 data root 里**（不是 Plugin 里）— Plugin 只读，venv 必须落在可写区；代价是每个 data root 一个 venv（合理）
5. **跨机搬迁流程：** 复制 `<data_root>` 到新机器 → 改 `data-root` 配置 → 跑一次 `bootstrap.py --check` 自动重建 venv → 恢复

---

## 2. Data Root 解析协议 + Dev Mode

### 2.1 解析优先级

```python
def resolve_data_root() -> Path:
    # 1. 环境变量（最高优先，dev mode 用）
    if env := os.environ.get("CHARACTER_WORKFLOW_DATA_ROOT"):
        return Path(env).expanduser().resolve()

    # 2. 全局配置文件（用户态唯一可信源）
    config_file = Path(platformdirs.user_config_dir("character-workflow")) / "data-root"
    if config_file.exists():
        path = config_file.read_text().strip()
        if path:
            return Path(path).expanduser().resolve()

    # 3. 默认（首次启动向导前的兜底）
    return Path.home() / "character-workflow"
```

### 2.2 子目录约定

| 函数 | 返回 |
|---|---|
| `data_root.config_dir()` | `<root>/.config` |
| `data_root.runtime_dir()` | `<root>/.runtime` |
| `data_root.venv_dir()` | `<root>/.venv` |
| `data_root.venv_python()` | `<root>/.venv/bin/python` (mac/linux) / `<root>/.venv/Scripts/python.exe` (Windows) |
| `data_root.projects_dir()` | `<root>/projects` |
| `data_root.characters_dir()` | `<root>/characters` |
| `data_root.workspace_memory()` | `<root>/MEMORY.md` |
| `data_root.workspace_worldview()` | `<root>/worldview.md` |
| `data_root.keys_file()` | `<root>/.config/keys.json` |

所有现有的 `Path(os.environ.get("PROJECT_ROOT", Path.cwd()))` 全部替换为对应函数。**`PROJECT_ROOT` 环境变量名淘汰**，换成 `CHARACTER_WORKFLOW_DATA_ROOT`。

### 2.3 Dev Mode

**触发：** 设置 `CHARACTER_WORKFLOW_DATA_ROOT=$PWD`。

**典型用法：**

```bash
# 在仓库根
make dev-link                                # symlink skill/* → .claude/skills/
export CHARACTER_WORKFLOW_DATA_ROOT=$(pwd)   # 仓库当 data root
uv sync                                      # 在仓库 .venv/ 装依赖
uv run python -m character_workflow turn-start
```

`.envrc`（用 direnv）写一行即可自动化：

```sh
export CHARACTER_WORKFLOW_DATA_ROOT=$PWD
```

### 2.4 测试隔离

```python
@pytest.fixture(autouse=True)
def isolated_data_root(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    return tmp_path
```

每个测试一个干净 data root，绝不污染用户真实数据。

### 2.5 边界情况

- **data root 不存在：** 向导前的所有访问返回"未初始化"信号，不创建任何目录。
- **路径含空格 / 中文：** 全程 `Path` 对象 + `subprocess` 的 list 形式，不走 shell 拼接。
- **多 OS 用户共用一台机：** 每个 OS 用户的全局 `data-root` 配置独立。
- **dev env var + 用户 `~/character-workflow/` 并存：** env var 优先级最高，绝不会污染用户数据。

---

## 3. Plugin Manifest + 4 个 Skill 组织

### 3.1 `plugin.json`

```json
{
  "name": "game-ui-ai-workflow",
  "version": "5.0.0",
  "description": "游戏角色资产工作流 — 画师可视化管理角色档案 + AI 出图",
  "author": "zhengzhongbiao",
  "homepage": "https://github.com/zhengzhongbiao/game-ui-ai-workflow",
  "skills": [
    { "name": "character-workflow",   "path": "skills/character-workflow/SKILL.md" },
    { "name": "character-promo",      "path": "skills/character-promo/SKILL.md" },
    { "name": "character-turnaround", "path": "skills/character-turnaround/SKILL.md" },
    { "name": "viewer-server",        "path": "skills/viewer-server/SKILL.md" }
  ],
  "bootstrap": {
    "command": "python",
    "args": ["scripts/bootstrap.py", "--check"]
  }
}
```

**注意：** `plugin.json` 的字段名是基于"应该长这样"推测，实施前先翻 Claude Code Plugin 官方 docs 校准（见 OQ-1）。如果字段名不一致，调整 manifest，**架构其他部分不变**。

### 3.2 4 个 Skill 保留独立

不合并。每个 Skill 有独立触发词 + 独立 prompt 调教：

- `/character-workflow` — 主流程，立绘
- `/character-promo` — 宣传图
- `/character-turnaround` — 三视图
- `/viewer-server` — server 控制（start / stop / open）

### 3.3 启动自检协议

每个 SKILL.md 顶部加一段"启动检查"，先调 `bootstrap.py --check`：

```bash
python ~/.claude/plugins/game-ui-ai-workflow/scripts/bootstrap.py --check
```

输出 JSON：

```json
{
  "status": "ready" | "needs_data_root" | "needs_uv" | "needs_venv" | "needs_first_key" | "needs_keys_repair",
  "data_root": "/Users/.../character-workflow" | null,
  "uv_path": "/opt/homebrew/bin/uv" | null,
  "venv_python": "/Users/.../character-workflow/.venv/bin/python" | null,
  "platform": "darwin" | "linux" | "win32",
  "next_action": "<人类可读的下一步说明>"
}
```

`bootstrap.py` 仅依赖 stdlib + `platformdirs`（PyPI 单包，纯 Python），用系统 python3 跑得动；venv 建好后再切到 venv python 跑业务逻辑。

### 3.4 SKILL.md 内置 MEMORY 必读规则

由于 Plugin 安装到用户机器后没有项目根的 `CLAUDE.md`，"启动必读 MEMORY"那段规则**搬到 SKILL.md 顶部**：

```markdown
## ⚠️ 启动必读 Memory 三层

每次进入本工作流，必须按顺序 Read：

1. `~/.claude/MEMORY.md` — 全局跨工作区经验
2. `<data_root>/MEMORY.md` — workspace 级
3. 如果对话涉及具体角色:
   - 从 `<data_root>/.runtime/projects.json::assignments` 解析角色所属 project_id
   - 从 `projects[].slug` 找到 slug
   - Read `<data_root>/projects/<slug>/MEMORY.md` + `worldview.md`

不读 MEMORY 就写 prompt / 出图 / 改 spec 视为违规。
```

仓库内的 `CLAUDE.md` 保留并改为"开发者文档"，新增 Dev Mode 段。

---

## 4. 首次启动 Onboarding 向导

### 4.1 状态机

每次 Skill 启动跑 `bootstrap.py --check`，按 `status` 分支：

| status | 处理 |
|---|---|
| `ready` | 直接进 turn-start，正常工作流 |
| `needs_data_root` | 状态 1：CC 对话选数据目录 |
| `needs_uv` | 状态 2：提示用户装 uv |
| `needs_venv` | 状态 3：跑 `uv sync` |
| `needs_first_key` | 状态 4：Web 上加第一个 Key |
| `needs_keys_repair` | 错误恢复：`keys.json` 解析失败，提示修复 |

### 4.2 状态 1 — 选数据目录（CC 对话向导）

Skill 用 `AskUserQuestion` 问：

> 第一次使用 character-workflow。你的角色 / 图片 / 项目要放在哪？
>
> A) `~/character-workflow/`（默认，推荐）
> B) `~/Documents/character-workflow/`（跟着 iCloud Drive / OneDrive 同步）
> C) 自定义路径

选完写入全局配置文件，创建空骨架：

```
<data_root>/
  .config/        (chmod 700 / Windows ACL)
  .runtime/
  projects/
  characters/
```

**不创建** MEMORY.md / worldview.md / projects.json — 后续按需建。

### 4.3 状态 2 — 缺 uv

`bootstrap.py --check` 跑 `shutil.which("uv")`，找不到就报 `needs_uv`。CC 显示平台特定命令：

**macOS / Linux：**
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Windows（PowerShell）：**
```powershell
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

**不替用户跑** — 网络命令必须显式批准，安全和透明都更好。

### 4.4 状态 3 — 装 Python 依赖

Skill 直接跑（CC 里显示进度）：

```bash
uv sync --project <plugin_dir> --python-preference managed --venv <data_root>/.venv
```

完成后写 `<data_root>/.config/venv-hash`（pyproject.toml SHA-256），下次 `--check` 对比，未变跳过；变了重跑。

### 4.5 状态 4 — 加第一个 API Key（Web 端向导）

先启 viewer-server（`<data_root>/.venv/bin/python -m viewer_server start` / Windows `Scripts\python.exe`），自动 `webbrowser.open("http://127.0.0.1:<port>/onboarding/keys")`。

Web 极简表单：

```
新增 API Key
─────────────
别名:        [我的 Lovart 主号_____________]
Provider:    [Lovart ▾]   ← 下拉：Lovart / OpenAI / Midjourney / Nano Banana / Seedream / 自定义
Access Key:  [_________________________________]
Secret Key:  [_________________________________]  ← 部分 provider 没有，置灰
图种能力:    ☑ portrait  ☑ promo  ☑ turnaround
能力描述:    [写实立绘 / 厚涂质感最佳___________]  ← 自由文本
☑ 设为默认

         [取消]      [保存并开始工作]
```

保存 → 写 `<data_root>/.config/keys.json`（chmod 600 / Windows ACL）→ 回到 CC："Key 已加，告诉我你想做什么角色。"

### 4.6 顺序图

```
User: /character-workflow 火栗狐
   │
   ├──[1]── Skill 跑 bootstrap.py --check
   │        ← needs_data_root
   ├──[2]── CC AskUserQuestion "数据放哪？"
   │        → 写全局配置 data-root
   ├──[3]── 再跑 --check
   │        ← needs_uv （如果没装）
   ├──[4]── CC 让用户装 uv（贴平台对应命令）
   ├──[5]── 再跑 --check
   │        ← needs_venv
   ├──[6]── CC 跑 uv sync（显示进度）
   ├──[7]── 再跑 --check
   │        ← needs_first_key
   ├──[8]── Skill 启 viewer-server，打开 /onboarding/keys
   │        ← Web 填 Key 保存
   ├──[9]── 再跑 --check
   │        ← ready
   └──[10] 进 turn-start，开始问"火栗狐"的 spec
```

**每个状态都幂等** — 任何一步失败，再说一次触发词回到 `--check`，会从断点继续。

### 4.7 后续启动（已 ready）

跳过向导，bootstrap `--check` 走 10 ms 内完成（几次文件存在性检查）。

### 4.8 Dev mode 下的 onboarding

设了 `CHARACTER_WORKFLOW_DATA_ROOT=$PWD`：
- 跳过状态 1（env var 当 data root）
- 跳过状态 2、3（仓库已有 .venv，`make install` 跑过）
- 状态 4 可选：仓库根可以放 `<repo>/.config/keys.json`（gitignore），或者通过环境变量 `LOVART_ACCESS_KEY` / `LOVART_SECRET_KEY` 当作"虚拟 Key"（dev 兼容模式，alias=`env-lovart`）

dev 进 `ready` 不需要走任何向导。

---

## 5. Key Schema + AI 选 Key 协议

### 5.1 `keys.json` Schema

`<data_root>/.config/keys.json`（chmod 600 / Windows ACL DenyAll except owner）：

```json
{
  "version": 1,
  "default_alias": "lovart-primary",
  "keys": [
    {
      "alias": "lovart-primary",
      "provider": "lovart",
      "access_key": "ak_xxx",
      "secret_key": "sk_xxx",
      "capabilities": ["portrait", "promo", "turnaround"],
      "models": ["gpt_image_2", "nano_banana", "midjourney", "seedream"],
      "notes": "写实立绘 / 厚涂质感最佳",
      "created_at": "2026-05-22T14:00:00+08:00"
    },
    {
      "alias": "openai-personal",
      "provider": "openai",
      "access_key": "sk-xxx",
      "secret_key": null,
      "capabilities": ["portrait"],
      "models": ["gpt-image-1"],
      "notes": "便宜 / 速度快 / 用于草稿",
      "created_at": "2026-05-22T14:15:00+08:00"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `alias` | ✅ | 用户起名，全局唯一。AI 引用 Key 的句柄 |
| `provider` | ✅ | 枚举：`lovart` / `openai` / `midjourney` / `nano_banana` / `seedream` / `custom`。决定 caller dispatch |
| `access_key` | ✅ | 真凭证，**只有 caller 进程读，永不出 data root** |
| `secret_key` | 视 provider | 同上 |
| `capabilities` | ✅ | 用户勾选的图种：`portrait` / `promo` / `turnaround`。turn-start 按 `--kind` 过滤 |
| `models` | ⭕️ | 该 Key 能调的模型 list，caller 内部用 |
| `notes` | ⭕️ | 自由文本能力描述，AI 选 Key 时读 |
| `created_at` | ✅ | ISO8601 元数据 |

**`default_alias` 单字段：** 不在每条 Key 上加 `is_default` 布尔，避免"两条都 true"脏态。改默认 = 改这一个字段。

### 5.2 turn-start 输出新增

```json
{
  "stage": "...",
  "...": "...",
  "available_keys": [
    {
      "alias": "lovart-primary",
      "provider": "lovart",
      "capabilities": ["portrait", "promo", "turnaround"],
      "models": ["gpt_image_2", "nano_banana", "midjourney", "seedream"],
      "notes": "写实立绘 / 厚涂质感最佳",
      "is_default": true
    },
    {
      "alias": "openai-personal",
      "provider": "openai",
      "capabilities": ["portrait"],
      "models": ["gpt-image-1"],
      "notes": "便宜 / 速度快 / 用于草稿",
      "is_default": false
    }
  ],
  "preferred_alias": "lovart-primary"
}
```

**`access_key` / `secret_key` 永不出现在 turn-start 输出 / log / Web 列表 API。** AI 通过 alias 引用，Skill 调 caller 时传 alias，caller 内部去 `keys.json` 取真 key。

**`preferred_alias` 解析逻辑：**

```
preferred_alias = (
    用户在 spec.md 的"渲染"段点名指定且 capabilities 包含 --kind 的 alias
    or default_alias，若其 capabilities 包含 --kind
    or capabilities 包含 --kind 的第一个 alias
    or null  ← 触发"该 kind 缺 Key"流程
)
```

### 5.3 SKILL.md 教 AI 怎么选

```markdown
## API Key 选择规则

turn-start 返回 `available_keys` 和 `preferred_alias`：

1. **默认走 `preferred_alias`** — 不要问用户用哪个 Key
2. **用户点名某 alias / provider** — 切到匹配的 Key，更新 spec.md 的"渲染"段
3. **用户要求某种风格且 notes 里有匹配描述** — 可建议切换并解释理由
4. **`preferred_alias` 是 null** — 停下来告诉用户："当前 kind=X 没有可用 Key，去 Web 加一个"
5. **永远不要在终端 / 文档 / log 里显示 access_key / secret_key** — 你看不到，也不该看到
```

### 5.4 Caller 改造

```python
# src/character_workflow/lib/callers/lovart.py
def render(prompt, model, alias):
    keys_db = read_keys_json()              # <data_root>/.config/keys.json
    key = keys_db.find(alias=alias)
    if not key:
        raise NoSuchKeyError(alias)
    if key.provider != "lovart":
        raise WrongProviderError(...)
    env = os.environ.copy()
    env["LOVART_ACCESS_KEY"] = key.access_key
    env["LOVART_SECRET_KEY"] = key.secret_key
    subprocess.run([...], env=env, ...)
```

**多 provider 扩展：** `src/character_workflow/lib/callers/` 下一个 provider 一个文件，统一接口 `def render(prompt, model, alias) -> output_paths`。`job_runner.py` 根据 alias 的 provider 字段 dispatch。

**MVP 只实现 lovart caller** — 其他 provider 留 stub + `NotImplementedError("provider X 尚未实现")`。spec 写明扩展路径，plan 不包含其他 provider。

### 5.5 Web Key 管理 API

`viewer-server` 新增：

| Method | Path | Body | 说明 |
|---|---|---|---|
| `GET` | `/api/keys` | — | 返回**不含 secret**，secret 字段始终为 `null`，UI 显示 `sk-xx...xx` |
| `POST` | `/api/keys` | full key | 新建 |
| `PATCH` | `/api/keys/:alias` | partial | 改（含 secret 字段则更新；不含则保留原值）|
| `DELETE` | `/api/keys/:alias` | — | 删（前端必须二次确认）|
| `POST` | `/api/keys/:alias/default` | — | 设默认 |
| `GET` | `/api/onboarding/status` | — | 返回 bootstrap.py --check 同结构 |
| `POST` | `/api/onboarding/data-root` | `{path}` | 改 data root（高级用户，触发 venv 重建）|

### 5.6 安全 / 边界

- `keys.json` 写入时 `os.chmod(path, 0o600)` (mac/linux) 或 Windows ACL；启动检查权限，不是预期值就警告 + 自动修复
- 不打 log 任何 secret 字段；日志格式器加 secret-redaction filter（grep 关键字 `access_key`/`secret_key` 自动替换为 `***`）
- viewer-server 绑死 `127.0.0.1`（与现状一致），`/api/keys*` 在同一安全边界
- 误删二次确认：DELETE 前 Web 弹模态框 + 输入 alias 确认
- 备份建议：用户可以 zip `<data_root>`（含 keys.json）— 写到 README
- schema 升级路径：`version` 字段 + bootstrap.py 检测 → 备份 `keys.json.bak.<timestamp>` 后 migration（MVP 不实现 migrator，v1 不变）

---

## 6. Windows 平台细节

### 6.1 路径差异统一

| 概念 | macOS / Linux | Windows |
|---|---|---|
| 全局配置目录 | `~/.config/character-workflow/` | `%APPDATA%\character-workflow\` |
| 数据目录默认 | `~/character-workflow/` | `C:\Users\<user>\character-workflow\` |
| venv python | `<root>/.venv/bin/python` | `<root>\.venv\Scripts\python.exe` |
| Plugin 安装 | `~/.claude/plugins/<name>/` | `%USERPROFILE%\.claude\plugins\<name>\` |

**统一方案：** 用 `platformdirs` 库解析配置目录。venv python 路径用：

```python
def venv_python(venv_dir: Path) -> Path:
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"
```

### 6.2 文件权限

- **macOS / Linux：** `os.chmod(keys_file, 0o600)`，启动 verify
- **Windows：** NTFS 无 POSIX 权限。`os.chmod` 是 no-op。**采用方案：用 Windows ACL 设"仅 owner 可读写"** — 用 `pywin32` 的 `win32security` API 设置 DACL，拒绝 Everyone / Users 组访问。

```python
def restrict_keys_file_windows(path: Path):
    import win32security, ntsecuritycon
    user_sid, _, _ = win32security.LookupAccountName("", os.getlogin())
    sd = win32security.SECURITY_DESCRIPTOR()
    dacl = win32security.ACL()
    dacl.AddAccessAllowedAce(win32security.ACL_REVISION,
                              ntsecuritycon.FILE_GENERIC_READ | ntsecuritycon.FILE_GENERIC_WRITE,
                              user_sid)
    sd.SetSecurityDescriptorDacl(1, dacl, 0)
    win32security.SetFileSecurity(str(path), win32security.DACL_SECURITY_INFORMATION, sd)
```

`pywin32` 加入 pyproject.toml 的 platform-specific 依赖：

```toml
dependencies = [
  "fastapi>=0.115",
  ...
  'pywin32>=308; sys_platform == "win32"',
]
```

### 6.3 进程管理

- **后台启动 viewer-server：**
  - macOS / Linux：`subprocess.Popen([...], start_new_session=True)`
  - Windows：`subprocess.Popen([...], creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS)`
- **进程存活检测：** 用 `psutil.pid_exists(pid)` 跨平台
- **进程终止：** `psutil.Process(pid).terminate()` 跨平台（Windows 没有 SIGTERM）

### 6.4 uv 安装命令

bootstrap.py 根据 `sys.platform` 输出不同指令：

```python
def uv_install_command() -> str:
    if sys.platform == "win32":
        return 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
    return "curl -LsSf https://astral.sh/uv/install.sh | sh"
```

### 6.5 文档 / SKILL.md 跨平台

- SKILL.md 提到 `~/.zshrc` 全局变量的地方加注：仅 mac/linux 适用；Windows 用 PowerShell `$PROFILE` 或系统环境变量面板
- README 三段安装：mac/linux/windows 各一段命令

### 6.6 CI

- **MVP：** GitHub Actions `macos-latest` + `ubuntu-latest` 跑 pytest + vitest
- **Windows：** 单独 workflow（`windows-latest` runner），允许失败（continue-on-error），手动 review 结果。MVP 后第二轮 follow-up 把 Windows 转为必过

### 6.7 测试 Windows 路径分支

```python
@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only")
def test_venv_python_path_windows(): ...

@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only")
def test_keys_file_chmod_posix(): ...
```

**Windows-only 路径解析单测**用 monkeypatch 模拟 `sys.platform`，即便在 mac CI 上也能跑（不依赖真 Windows 行为）。

---

## 7. 改造影响面 + 迁移计划

### 7.1 仓库布局重组（一次性 mv）

| 旧路径 | 新路径 |
|---|---|
| `skill/character_workflow/SKILL.md` | `skills/character-workflow/SKILL.md` |
| `skill/character_workflow/__main__.py` | `src/character_workflow/__main__.py` |
| `skill/character_workflow/lib/` | `src/character_workflow/lib/` |
| `skill/character_workflow/bin/` | `src/character_workflow/bin/` |
| `skill/character_workflow/references/` | `skills/character-workflow/references/` |
| `skill/character_promo/SKILL.md` | `skills/character-promo/SKILL.md` |
| `skill/character_promo/`（其余） | `src/character_promo/` |
| `skill/character_turnaround/SKILL.md` | `skills/character-turnaround/SKILL.md` |
| `skill/character_turnaround/`（其余） | `src/character_turnaround/` |
| `skill/viewer_server/SKILL.md` | `skills/viewer-server/SKILL.md` |
| `skill/viewer_server/server.py` 等 | `src/viewer_server/` |
| `skill/viewer_server/static/`（build 产物）| `web/dist/`（不入 repo） |
| — | `plugin.json` |
| — | `scripts/bootstrap.py` |

### 7.2 代码改造清单

| 项 | 文件 | 改动 |
|---|---|---|
| Data root resolver | `src/character_workflow/lib/data_root.py`（新增） | `resolve_data_root()` + 子目录函数 |
| 替换 `Path.cwd()` | 见 7.4 文件列表 | 全部改 `data_root.xxx_dir()` |
| 环境变量改名 | 同上 | `PROJECT_ROOT` → `CHARACTER_WORKFLOW_DATA_ROOT` |
| Python 包路径 | 全部 `.py` 文件的 import | `skill.character_workflow.X` → `character_workflow.X` |
| CLI 模块名 | SKILL.md + 测试 + 文档 | `python -m skill.character_workflow` → `python -m character_workflow` |
| viewer-server 启动 | `scripts/bootstrap.py` + SKILL.md | 用 `data_root.venv_python() -m viewer_server start` |
| Keys 模块 | `src/character_workflow/lib/keys.py`（新增） | CRUD + `find_by_alias` + `get_default_for_kind` |
| Keys REST API | `src/viewer_server/routes.py` | 5 个新 endpoint（list/create/patch/delete/set-default） |
| Onboarding API | `src/viewer_server/routes.py` | `/api/onboarding/status` + `/api/onboarding/data-root` |
| turn-start 输出 | `src/character_workflow/lib/turn_start.py` | 新增 `available_keys` + `preferred_alias` |
| Caller 重构 | `src/character_workflow/lib/callers/lovart.py`（新增；从老 `lovart_caller.py` 提） | 接 alias 参数、`keys.json` 取真 key |
| Caller dispatch | `src/character_workflow/lib/job_runner.py` | 按 provider 路由到对应 caller |
| Web — 数据目录向导 | `web/src/pages/onboarding/DataRoot.tsx` | 单页 + POST `/api/onboarding/data-root` |
| Web — Key 管理 | `web/src/pages/settings/Keys.tsx` + 表单组件 | 列表 + CRUD + 设默认 |
| Web — 首屏路由 | `web/src/App.tsx` | `GET /api/onboarding/status` 决定首屏 |
| Plugin manifest | `plugin.json`（新增） | 4 个 Skill 注册 + bootstrap |
| Bootstrap | `scripts/bootstrap.py`（新增） | `--check` / `--init-data-root` / `--ensure-venv` 三个子命令 |
| Release 校验 | `scripts/check_plugin.py`（新增） | 校验 plugin.json / SKILL.md / pyproject / Web 产物完整 |
| Windows 权限 | `src/character_workflow/lib/keys.py` | 平台分支 chmod / Windows ACL |
| Windows 进程 | `src/viewer_server/server.py` | 平台分支 subprocess flags |
| 平台 deps | `pyproject.toml` | `pywin32; sys_platform == "win32"`、`platformdirs` |

### 7.3 测试改造

| 类型 | 改动 |
|---|---|
| 单测 | conftest fixture：`monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))` 自动注入 |
| 集成测 | viewer-server 端到端用 `tmp_path` 起 server |
| 新增 | `tests/test_data_root.py` — resolver 优先级（env > config > default） |
| 新增 | `tests/test_keys.py` — CRUD、`default_alias` 流程、`preferred_alias` 各种解析路径 |
| 新增 | `tests/test_bootstrap.py` — `--check` 各状态分支 |
| 新增 | `tests/test_callers_dispatch.py` — provider → caller dispatch |
| 新增 | `tests/test_secret_redaction.py` — log / API 输出含 secret 字段时是否被脱敏 |
| 新增 | `tests/test_windows_paths.py` — Windows 路径分支（monkeypatch sys.platform） |
| 现有 | 全部 `PROJECT_ROOT` env var 替换为 `CHARACTER_WORKFLOW_DATA_ROOT` |

### 7.4 需要替换 `Path.cwd()` / `PROJECT_ROOT` 的文件清单

基于 grep 结果：

- `src/character_workflow/lib/projects.py`
- `src/character_workflow/lib/lessons.py`
- `src/character_workflow/lib/turn_start.py`
- `src/character_workflow/lib/jobs.py`
- `src/character_workflow/lib/context_loader.py`
- `src/character_workflow/lib/job_runner.py`
- `src/character_workflow/lib/draft_processor.py`
- `src/viewer_server/server.py`
- `src/viewer_server/routes.py`
- `src/viewer_server/watcher.py`

### 7.5 现有用户数据迁移

**两类用户：**

1. **仓库内 dev 用户（团队内部 / 本人）：** 数据已经在 `<repo>/characters/` 等位置。设 `CHARACTER_WORKFLOW_DATA_ROOT=$PWD` 即可继续工作，**零迁移**。
2. **已按旧 `~/.character-workflow/` 跑过的早期用户：** 目前**不存在**这类用户（项目还没分发过）。**无需写迁移脚本**。

**未来 schema 升级路径：** 占位文件 `scripts/migrate_data_root.py`（空壳 + comment），实施 plan 不包含。

### 7.6 Build / Release 流程

```bash
# 开发者发版
make build                              # vite build → web/dist/
python scripts/check_plugin.py          # 校验完整
git tag v5.0.0
git push --tags
# CI 跑测试 + 打 release artifact 上传 GitHub Release
```

**用户安装：**

```bash
# 当下
claude plugins install github:zhengzhongbiao/game-ui-ai-workflow
# 未来 marketplace 上架后
claude plugins install game-ui-ai-workflow
```

### 7.7 CLAUDE.md 变化

**仓库内 `CLAUDE.md`** 改为"开发者文档"：

- "## 启动必读 Memory 三层" 那段 — **保留**（dev mode 下仓库根 = data root，路径有效）
- "## What this project is" — 改成"本仓库是 Plugin 源码"
- 新增 "## Dev mode" — 解释 env var、`make dev-link`、`.envrc` 写法

**Plugin 安装到用户机器后没有 `CLAUDE.md`** — SKILL.md 顶部自带"启动必读 MEMORY"那段强制规则（Section 3.4）。

---

## 8. 开放问题

### OQ-1 — Claude Code Plugin manifest 真实规范

`plugin.json` 字段名是基于"应该长这样"推测。Task 1 必须做：建一个最小 Plugin（一个 Skill + echo 命令），走 `claude plugins install <local-path>` 流程，确认：

- `skills` 数组 schema 精确字段名
- `bootstrap` / `lifecycle` 入口名（是 `bootstrap`、`onLoad`、`preinstall`？）
- Plugin 安装目录是 `~/.claude/plugins/<name>/` 还是别的

manifest 细节如果与本 spec 描述不符 → 调整 manifest，**架构其他部分不变**。

### OQ-2 — viewer-server 进程生命周期与 CC session 协调

- Skill 调用时拉起 → 用户关 CC → 进程留还是杀？
- 多 CC tab → 同一个 server 复用？
- 系统重启 → server 死，下次 Skill 触发自动起

**推荐：** 服务进程模式 — 拉起后台跑、PID 文件单例、用户主动 `/viewer-server stop` 才关；系统重启自动死，下次自动起。不做 CC session lifecycle 集成（CC 没暴露 hook）。

### OQ-3 — `keys.json` schema 升级流程

**推荐：** `version` 字段 + bootstrap.py 检测 → 备份 `.bak.<timestamp>` → migration。**MVP 不实现 migrator**（只有 v1）。

---

## 9. 风险

### R-1 — Plugin manifest 不支持声明多个 Skill

**回退方案：** 4 个独立 Plugin（同 GitHub repo，build 时生成 4 个 Plugin 目录），共享 Python 代码用 symlink 或 `references` Plugin。Task 1 验证后立即决定。

### R-2 — `uv sync` 无网络环境失败

**缓解：** bootstrap.py `--ensure-venv` 失败时给清晰错误（"装依赖失败：检查网络 / 看 `<data_root>/.config/uv-install.log`"），提供"`.venv/` 已存在跳过"逻辑（用户可从别处拷贝 venv）。

### R-3 — Plugin 包体积膨胀

vite build ~1-2MB + Python 源码 < 5MB，可控。`scripts/check_plugin.py` 加体积检查（>10MB fail）。

### R-4 — 用户改 data root 路径但 `.venv` 未跟着搬

`resolve_data_root()` 变了之后，下次 bootstrap `--check` 看 `<new_root>/.venv/` 不存在 → `needs_venv` → 重跑 `uv sync`。**自动恢复**。

### R-5 — `keys.json` 损坏 / 手动编辑出错

`read_keys_json()` 解析失败 → bootstrap.py 返回 `needs_keys_repair`，CC 提示"备份到 `.bak` 后手动修复"。

### R-6 — Windows ACL 设置失败

`pywin32` 未装 / 权限不足 / 非 NTFS（FAT32 移动盘）。Fallback：警告用户"Windows 文件权限保护失败，建议改 data root 到 NTFS 盘"，但不阻塞使用。

---

## 10. 成功标准

实施完成后，下列条件全部满足：

1. **空机器 → 30 分钟内出第一张图。** Mac / Linux / Windows 全新机各跑一遍 CC + Plugin install + 配 Key + 工作流。
2. **`Path.cwd()` 在 `src/`、`scripts/` 中零出现。** `git grep "Path.cwd()" src/ scripts/` 空结果。
3. **`PROJECT_ROOT` 在所有代码中零出现。** 改为 `CHARACTER_WORKFLOW_DATA_ROOT`。
4. **`keys.json` 文件权限保护到位。** Mac/Linux chmod 600；Windows ACL 仅 owner。启动检查 + 自动修复。
5. **`access_key` / `secret_key` 永不出现在** turn-start 输出 / log / Web API / 任何控制台。CI grep 检查通过。
6. **Plugin 卸载 → 删 `~/.claude/plugins/game-ui-ai-workflow/` → 用户 `<data_root>/` 数据完整无损。**
7. **改 data root 路径 → 编辑全局配置 → 下次 Skill 启动自动迁到新路径（含 venv 重建）。**
8. **Dev mode：** 仓库根 + `export CHARACTER_WORKFLOW_DATA_ROOT=$(pwd)` → `make dev-link` → 仓库 `characters/` / `.runtime/` / `projects/` 全部命中，零回归。
9. **测试：** 所有现有测试通过；新增 ≥ 40 个测试覆盖 data root / keys / bootstrap / onboarding / windows-paths / secret-redaction / caller-dispatch。
10. **AI 选 Key 行为验证（自动 + 手动场景）：**
    - `available_keys = [lovart-primary (portrait/promo/turn), openai-personal (portrait)]`
    - `--kind portrait` → `preferred_alias = lovart-primary`
    - `--kind turnaround` → `preferred_alias = lovart-primary`
    - 用户说"用 OpenAI 出张草稿" → AI 切到 `openai-personal`
    - 用户加了 mj-personal (capabilities=[promo])，`--kind portrait` 仍走 lovart-primary（mj 不匹配 kind）
11. **Windows 单元测试通过率 ≥ 95%**（CI 单独 workflow，允许 5% 平台特性 flaky；MVP 后第二轮转必过）。

---

## 11. 不属于本 spec

- 多 provider caller 实现（除 lovart 外）— 占位 stub
- 自动升级 / Plugin update check
- 多 workspace（一用户多 data root）
- Cloud sync keys.json
- viewer-server 改 Node.js
- Plugin marketplace 上架运营

---

## 12. 与前置 spec 的关系

本 spec **依赖** `2026-05-21-project-scoped-memory-design.md`（项目级 Memory 架构）：

- 前置 spec 定义了 `projects.json::assignments` + `projects/<slug>/` 三层 Memory + worldview
- 本 spec 把这些路径从"仓库根"提升为"data root"
- 前置 spec 的 turn-start 输出字段（worldview_workspace / worldview_project / lessons_global / lessons_workspace / lessons_project）保留，本 spec 新增 `available_keys` + `preferred_alias`
- 前置 spec 的 `append-memory --scope` / `create-project` / `assign-character` CLI 子命令保留，本 spec 不动

**实施顺序：** 前置 spec 的 plan 先做（已通过），本 spec 的 plan 在前置 spec 落地之后启动。

---

## 附：当前会话讨论决策点回顾

| 问题 | 决策 |
|---|---|
| 目标用户 | AI 时代设计师（会装 Skill / 用 Vibe Coding） |
| 数据目录 | 首次启动向导选，默认 `~/character-workflow/` |
| 打包形态 | Claude Code Plugin（`claude plugins install`） |
| Python deps | 首次启动 `uv sync` 到 `<data_root>/.venv` |
| Key 存储 | `<data_root>/.config/keys.json`，明文 + chmod 600 / Windows ACL |
| 4 个 Skill | 保留独立，不合并 |
| Python 包路径 | `skill.X` → `X` |
| bootstrap.py | 用 system python3，仅依赖 stdlib + `platformdirs` |
| Onboarding 状态机 | 5 个状态 + `needs_keys_repair` 错误恢复 |
| 加 Key 入口 | Web 表单（CC 对话不输入 secret） |
| AI 选 Key | turn-start 暴露 alias + metadata，secret 永不暴露 |
| `default_alias` | 单独字段（不在每条 Key 上 `is_default`） |
| MVP caller | 只 lovart，其他 provider stub |
| `references/` | 跟 SKILL.md 同目录 |
| SKILL.md MEMORY | SKILL.md 顶部自带强制规则（Plugin 用户没 CLAUDE.md） |
| 迁移脚本 | 不写（dev 用户开 env var，没真实早期用户） |
| Windows | 纳入本 spec |
| Windows ACL | 用 `pywin32` win32security 设 DACL |
| Windows 进程 | `subprocess.CREATE_NEW_PROCESS_GROUP \| DETACHED_PROCESS` |
| 平台 deps | `pywin32; sys_platform == "win32"`、`platformdirs` |
| CI | MVP 仅 mac+linux 必过，Windows allow-failure，后续转必过 |
