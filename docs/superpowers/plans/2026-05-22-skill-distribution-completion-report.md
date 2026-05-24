# Skill 分发改造完成报告

完成日期：2026-05-24

## 成功标准核验

| # | 标准 | 状态 |
|---|---|---|
| 1 | 空机器 30 分钟内出第一张图（mac/linux/win） | ⏳ 手动验证待做（依赖真实 Plugin marketplace + 真实 Lovart key） |
| 2 | `Path.cwd()` 在 `src/` `scripts/` 零出现 | ✅ `scripts/check_no_project_root.sh` PASS |
| 3 | `PROJECT_ROOT` 全代码零出现 | ✅ 同上（grep `--include='*.py'` src/scripts/skills/tests） |
| 4 | `keys.json` chmod 600 / Windows ACL | ✅ `tests/test_keys.py::test_keys_file_chmod_600_on_posix`、`tests/test_windows_paths.py`（Windows ACL test marked skipif win32） |
| 5 | secret 永不出现在 turn-start / log / API | ✅ `keys.keys_for_turn_start()` / `keys.keys_for_api()` 剥离 + `SecretRedactionFilter`（`tests/test_secret_redaction.py`）+ `WebEditableJobPatch` 仍只白名单 4 字段 |
| 6 | Plugin 卸载数据完整 | ✅ data_root 与 Plugin 安装目录解耦（`<data_root>/.config/`、`<data_root>/.runtime/`、`<data_root>/characters/`、`<data_root>/projects/`）；卸载 Plugin 仅删 `~/.claude/plugins/...`，data_root 留存 |
| 7 | 改 data root 自动重建 venv | ✅ `bootstrap.py --check` 5 状态机 + `venv-hash` 文件追踪 pyproject.toml 变更（`tests/test_bootstrap.py` 7 个 state 测试） |
| 8 | Dev mode 零回归 | ✅ 323 passed / 4 pre-existing failed / 2 skipped；ruff PASS；web vitest 4/4 PASS；tsc lint PASS |
| 9 | 新增 ≥ 40 测试 | ✅ 实际新增约 60 个测试，覆盖 data_root / keys / secret_filter / callers dispatch / bootstrap state machine / onboarding api / keys api / windows paths / check_plugin 等 |
| 10 | AI 选 Key 行为 | ✅ `turn_start()` 输出 `available_keys`（无 secret）+ `preferred_alias_for_kind(kind)`；Job 自动从 alias 填 provider；`tests/test_turn_start_keys.py` + `tests/test_jobs.py::test_write_job_fills_alias_from_preferred_when_missing` |
| 11 | Windows CI 通过率 ≥ 95% | ⏳ `.github/workflows/ci-windows.yml` 已就位但 `continue-on-error: true`（MVP）；实际运行率待 GitHub Actions 跑过几轮后再统计 |

## 阶段实现

- 阶段 0 — Task 1 Plugin manifest 实测（schema 修正：`.claude-plugin/plugin.json` + `skills: "./skills"` 字符串路径，无 `bootstrap` lifecycle 字段）
- 阶段 1 — Tasks 2-4 platformdirs + data_root + bootstrap 骨架 + conftest 隔离 fixture
- 阶段 2 — Tasks 5-8 仓库重组 `skill/` → `skills/+src/` + PROJECT_ROOT → data_root 全量迁移 + CI guard
- 阶段 3 — Tasks 9-13 keys.py CRUD + SecretRedactionFilter + callers dispatch + Job alias + turn-start keys 输出
- 阶段 4 — Tasks 14-18 bootstrap 5 状态机 + init-data-root + ensure-venv + onboarding REST + keys REST
- 阶段 5 — Tasks 19-22 Web onboarding 分流 + DataRoot 向导 + Keys 管理页 + 主界面入口
- 阶段 6 — Tasks 23-25 Windows ACL + 跨平台进程管理 + SKILL.md/README 跨平台文档
- 阶段 7 — Tasks 26-31 Plugin manifest + check_plugin + vite outDir 改 `web/dist` + CLAUDE.md 改为开发者文档 + CI workflow + bootstrap --run 转发 + 本完成报告

## 开放问题验证

- **OQ-1**（Plugin manifest schema）：Task 1 实测结论已落地：manifest 在 `.claude-plugin/plugin.json`，`skills` 为字符串目录路径；`bootstrap` 字段不存在，bootstrap 改为 SKILL.md instructions + CLI 转发模式。
- **OQ-2**（进程生命周期）：采用 stdlib 方案 — `_spawn_detached` 用 `subprocess.CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`（win32）/ `start_new_session=True`（POSIX）；`_terminate` 用 `taskkill /F`（win32）/ `os.kill(SIGTERM)`（POSIX）。未引入 `psutil` 依赖。
- **OQ-3**（keys.json schema migrator）：v1 不实现 migrator。当前 `version: 1` 字段已经预留升级位。损坏走 `needs_keys_repair` 状态由用户手动修。

## 待做（follow-up）

- 真机 onboarding 端到端验证（mac/linux/win 三平台），覆盖 success criterion #1
- Windows CI 转必过（spec §6.6 + plan §6.6）
- 其他 provider caller 实现（openai / midjourney / nano_banana / seedream / custom）目前都是 `NotImplementedError` stub
- Plugin marketplace 上架 / `claude plugins install github:...` 流程实测
- 多 workspace 支持（当前 data_root 单一）
- 4 个 pre-existing 失败修复（promo / turnaround skill_files / 2 个 SSE timing）— 与本次改造无关，技术债

## 提交清单（共 30 个 commit，从 `17591f8` data_root 模块开始）

```
ba5763a feat(bootstrap): --run forwards args to venv python; SKILL.md uses this entry
31e1df4 ci: add mac/linux required workflow + Windows allow-failure
f7bb74d docs: rewrite CLAUDE.md as developer-mode reference + dev-mode env var
db0214f build: vite outDir → web/dist/; viewer-server serves from there
3a0215f feat(plugin): manifest + check_plugin release validator
fef1bb3 docs: SKILL.md bootstrap self-check protocol + README cross-platform install
dc4fa09 feat(server): cross-platform detached spawn + process lifecycle
d61f547 feat(windows): ACL helper restricts keys.json to owner only
43349d7 feat(web): expose Keys management from main app header
cad3fe9 feat(web): Keys management page (list/add/delete/set-default)
9960b8c feat(web): DataRoot onboarding wizard page
a962711 feat(web): split App into onboarding-aware router
365c493 feat(viewer-server): keys REST API (list/create/patch/delete/set-default)
86eb464 feat(viewer-server): onboarding status + data-root REST endpoints
c24c428 feat(bootstrap): --ensure-venv runs uv sync + writes venv-hash
0cd7164 feat(bootstrap): --init-data-root creates skeleton + writes global config
88f2023 feat(bootstrap): full --check state machine (5 states + needs_keys_repair)
0100d96 feat(jobs): auto-fill alias + provider from preferred_alias_for_kind
04c27bc feat(turn-start): expose available_keys + preferred_alias (secrets stripped)
821f300 refactor(callers): introduce alias-based dispatch + relocate lovart caller
4df48ac feat(logging): redact access_key / secret_key from log records
d589fbd feat(keys): keys.json CRUD + preferred_alias_for_kind + secret stripping
9a63584 ci: guard against PROJECT_ROOT / Path.cwd() regressions
8c33bf0 refactor(viewer_server): replace PROJECT_ROOT / RUNTIME_DIR with data_root
f7b76cf refactor(character_workflow): finish Task 6 — migrate draft_processor + active_character to data_root
f7c313d refactor(character_workflow): replace PROJECT_ROOT with data_root abstraction
fe9e99b refactor: relocate skill/<name>/ → skills/<dashed-name>/ + src/<snake_name>/
c3c47fb test: auto-inject isolated data root via CHARACTER_WORKFLOW_DATA_ROOT
bc1f88c feat(bootstrap): skeleton --check returns needs_data_root / next state
3134167 test(data-root): remove unused os import
17591f8 feat(data-root): add data_root resolver with three-tier resolution
```
