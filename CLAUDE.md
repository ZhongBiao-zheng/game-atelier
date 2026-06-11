# CLAUDE.md / AGENTS.md

> 此文件同时服务于 Claude Code 和 Codex。AGENTS.md 是本文件的软链接，两者内容完全一致。
> 路径差异：Claude Code 使用 `~/.claude/`，Codex 使用 `~/.codex/`。

## ⚠️ 启动必读 Memory 三层

每次进入本仓库的对话, 你必须先 Read 以下文件 (按顺序), 把内容作为本轮上下文:

1. 全局跨工作区经验：
   - Claude Code: `~/.claude/MEMORY.md`
   - Codex: `~/.codex/MEMORY.md`
2. `MEMORY.md` (仓库根) — 本工作区跨项目通用经验
3. 如果对话涉及具体角色:
   - 从 `~/game-atelier/.runtime/projects.json::assignments` 解析角色所属 project_id
   - 从 `~/game-atelier/.runtime/projects.json::projects[].slug` 找到 slug
   - Read `~/game-atelier/projects/<slug>/MEMORY.md`

不读 MEMORY 就开始写 prompt / 出图 / 改 spec / 改 Skill 视为违规。

走 /game-atelier:character 等 Skill 命令时, Skill 内部已自动加载, 无需重复 Read。

---

This file provides guidance to Claude Code (claude.ai/code) and Codex when working with code in this repository.

## What this project is

本仓库是 `game-atelier` **Plugin 源码**。Plugin 通过 `claude plugin install` 装到用户机器后，实装路径形如 `~/.claude/plugins/cache/<市场>/game-atelier/<版本>/`（**不是** `~/.claude/plugins/game-atelier/`——后者不存在）。Skill 内引用插件自带文件一律走 CC 注入的 `${CLAUDE_PLUGIN_ROOT}`，绝不硬编码 `~/.claude/plugins/<name>/`。用户数据在独立的 `<data_root>/`（默认 `~/game-atelier/`，由 `GAME_ATELIER_DATA_ROOT` 环境变量覆盖）。

详见 `docs/superpowers/specs/2026-05-22-skill-distribution-design.md` 和 `docs/superpowers/plans/2026-05-22-skill-distribution-impl.md`。

工作流由两个进程 + 一组 Skill 组成：

- **viewer-server** (`src/viewer_server/`)：FastAPI，绑死 `127.0.0.1:5174`（被占用自动 +1）。文件读写 + SSE 推送。
- **web** (`web/`)：Vite + React，dev 在 `5173`，build 落在 `web/dist/`，由 viewer-server 直接挂载。
- **Skill 套件** (`skills/{character,promo,turnaround,viewer-server}/SKILL.md` + `src/character_workflow/` Python lib)：在 CC 里被 `/game-atelier:character <名>` 等触发，读 `<data_root>/.runtime/draft/`、调 Lovart / OpenAI / ... 出图。

## Dev mode

开发时数据目录与仓库分离：data root 指向 `~/game-atelier`（平台配置文件 `~/Library/Application Support/game-atelier/data-root`），仓库根**不再**是 data root。

```bash
make dev-link              # symlink skills/* → .claude/skills/
make install               # uv sync + pnpm install
```

不需要手动设 `GAME_ATELIER_DATA_ROOT`。pytest 用 autouse `isolated_data_root` fixture 给每个测试一个独立 tmp 目录，不污染 `~/game-atelier`。

若需临时切换到其他 data root（如验证首启向导），可手动：

```bash
export GAME_ATELIER_DATA_ROOT=/tmp/test-data-root
```

## 核心架构原则

**文件系统是唯一 source of truth**（路径均相对 `<data_root>/`）：

| 文件 | 谁写 | 谁读 |
|---|---|---|
| `characters/<id>/spec.md` | Skill（对话归档）/ Web（保存 spec） | Skill / Web |
| `characters/<id>/{portrait,promo,turnaround,source}/` | Skill 写出图 / 画师上传源图 | Skill / Web |
| `.runtime/jobs/<job_id>.json` | Skill（jobs.py） | Skill / Web |
| `.runtime/draft/*.md` | Web（画师反馈） | Skill（draft_processor 消费后挪到 `draft-processed/`）|
| `.runtime/active-character.json` | 双向 | 双向 |
| `.runtime/projects.json` | Web (`POST /api/projects`) | Skill / Web |
| `.runtime/gallery-hidden.json` | Web (`POST /api/gallery/hidden`) | viewer-server（`/api/gallery/recent` 过滤首页作品展示） |
| `.runtime/server.{pid,port}` | viewer-server CLI | viewer-server CLI |
| `.config/keys.json` | Skill / Web (`POST /api/keys`) | Skill 通过 `lib/keys.py` 读 |
| `.config/venv-hash` | `bootstrap.py --ensure-venv` | `bootstrap.py --check` |

**Web 不能改 job 状态字段**：`WebEditableJobPatch` 白名单只允许 `prompt / model / params / seed`；`status / output_paths / submitted_at / character_id / job_id / error` 是 Skill 独占。

**Job JSON 禁止凭记忆手写**：`.runtime/jobs/*.json` 会被 `/api/jobs` 全量 Pydantic 校验；任意一条 schema 错误都会让前端角色页的 job 列表整体 500，表现为“角色里面没内容”。需要补写 / 回填 job 时，优先用 `src/character_workflow/lib/jobs.py` 的 `Job` / `JobParams` / `save_job()` 生成；若不得不手工改 JSON，改完必须跑：

```bash
PYTHONPATH=src uv run python - <<'PY'
from character_workflow.lib.jobs import list_jobs
print(len(list_jobs()))
PY
curl -sS http://127.0.0.1:5174/api/jobs >/dev/null
```

特别注意：`params.warnings` 是数组，不是字符串；`status` / `kind` / `asset_slot` 等字段必须使用 schema 允许的枚举值。不要让一条人工补档记录拖垮整个前端。

**Schema 双端同步**：`src/character_workflow/lib/schemas.py`（Pydantic）↔ `web/src/schema/jobs.ts`（TS）。改一边必须同步另一边。`docs/api-contract.md` 是契约源。

**出图前必须确认**：Skill 先 `jobs.write_job(...)` 写 `PENDING_CONFIRM` 状态 + 把出图卡片打到终端 → 画师明确说"出图"或 Web 点确认 → 才推进到 `PENDING` 调 Lovart（同步阻塞期间停留在 `PENDING`，无独立 `RUNNING` 状态）。

## 常用命令

```bash
# 一次性安装
make install                                          # uv sync + pnpm install

# 启动（双终端）
uv run python src/viewer_server/server.py start     # 终端 A — server
cd web && pnpm dev                                    # 终端 B — Vite dev

# Skill 软链到 .claude/skills/（重启 CC 生效）
make dev-link                                         # 让本地 /character 等开发命令可用
make dev-unlink

# 测试
make test                                             # pytest + vitest
uv run pytest -v tests/test_jobs.py                   # 单个文件
uv run pytest -v -k "test_pending_confirm"            # 按名字过滤
cd web && pnpm test                                   # vitest run

# Lint / TypeCheck
uv run ruff check src tests                           # Python lint（line-length=100）
cd web && pnpm lint                                   # tsc -b --noEmit

# 构建
make build                                            # vite build → web/dist/（viewer-server 自动挂载）

# Server 控制
uv run python src/viewer_server/server.py stop
uv run python src/viewer_server/server.py open-browser
```

## 技术栈（不要偏离）

- **Python 3.11+** / FastAPI 0.115 / Pydantic 2.9 / uvicorn / watchdog；`uv` 装包。
- **React 18.3** / TS 5.6 / Vite 5.4 / Vitest 2 / pnpm。
- **Tailwind v4.3 + shadcn**：永远 v4 写法（`@import "tailwindcss"`、`@theme`），禁止 v3 的 `tailwind.config.js` + PostCSS 组合。
- 设计系统：先读 `DESIGN.md`（Atelier 暖调暗色画廊，黄铜 `#D4A574` primary，Instrument Serif display + Geist body）。

## 安全 / 部署约束

- viewer-server **必须绑 `127.0.0.1`**，绝不 `0.0.0.0`（共享 WiFi attack surface）。
- `/api/raw` 图片读取用 job_id 白名单（只能读 `output_paths` 里登记过的文件）。
- 同一时间只支持一个 Web tab（多 tab 行为未定义）。

## Turn 起始（Skill 每次必做）

一次 CLI 拿齐三件事：

```
uv run python -m character_workflow turn-start
# → {"drafts": [...], "active_id": "...", "spec": "<characters/<id>/spec.md 内容>"}
```

## 反 Slop 红线（来自 DESIGN.md）

紫蓝渐变 / 3 列 feature grid / Inter 正文 / system-ui display / 渐变按钮 / 居中一切 —— 一律拒绝。另两条硬纪律：**无阴影**（深度靠玻璃配方 `bg-glass backdrop-blur-glass border border-border`，`shadow-*` 全禁）、**字阶四档**（xs/sm/base/display，禁任意值字号与 `text-lg` 以上档位）。以上由 `web/src/test/designDrift.test.ts` 守卫强制执行。详见 `DESIGN.md` "反 AI Slop 清单" 与 "组件配方"。

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
