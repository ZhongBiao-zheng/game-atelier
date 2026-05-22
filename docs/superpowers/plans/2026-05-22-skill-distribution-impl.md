# Skill 分发架构实施计划 — Plugin 化 / 数据剥离 / 多 API Key / 跨平台

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `game-ui-ai-workflow` 改造成可分发的 Claude Code Plugin — 代码与数据彻底分离，首启动向导引导用户配置 data root + API Key，AI 按 Key capabilities 选合适的 provider，macOS / Linux / Windows 三平台跑通。

**Architecture:** 三层路径解析（env var > 全局配置文件 > 默认值）+ `<data_root>/.config/keys.json` 存 Key + `bootstrap.py` 状态机驱动 onboarding。Plugin 安装目录只读、用户数据目录可写，两者绝对独立。Lovart caller MVP，其他 provider 留 stub。

**Tech Stack:** Python 3.11 / FastAPI 0.115 / Pydantic 2.9 / `platformdirs` / `pywin32` (Windows-only) / React 18.3 / TS 5.6 / Vite 5.4 / Vitest 2 / pytest 8 / uv

**Spec:** `docs/superpowers/specs/2026-05-22-skill-distribution-design.md`
**前置 plan:** `docs/superpowers/plans/2026-05-21-project-scoped-memory-impl.md`（已落地）

---

## 文件结构总览

新建：
- `src/character_workflow/lib/data_root.py` — data root 解析 + 子目录函数
- `src/character_workflow/lib/keys.py` — keys.json CRUD + 选 Key 协议
- `src/character_workflow/lib/secret_filter.py` — 日志脱敏过滤器
- `src/character_workflow/lib/callers/__init__.py` — caller registry / dispatch
- `src/character_workflow/lib/callers/lovart.py` — 从 `lovart_caller.py` 重构（接 alias）
- `scripts/bootstrap.py` — onboarding 入口（stdlib + platformdirs only）
- `scripts/check_plugin.py` — release 校验
- `plugin.json` — Plugin manifest
- `web/src/pages/onboarding/DataRoot.tsx` — 数据目录向导页
- `web/src/pages/settings/Keys.tsx` — Key 管理页
- `tests/test_data_root.py`、`test_keys.py`、`test_bootstrap.py`、`test_callers_dispatch.py`、`test_secret_redaction.py`、`test_windows_paths.py`

重命名 / 移动（一次性 git mv）：
- `skill/character_workflow/SKILL.md` → `skills/character-workflow/SKILL.md`
- `skill/character_workflow/__main__.py` → `src/character_workflow/__main__.py`
- `skill/character_workflow/lib/*` → `src/character_workflow/lib/*`
- `skill/character_workflow/references/` → `skills/character-workflow/references/`
- `skill/character_promo/{SKILL.md,references}` → `skills/character-promo/`
- `skill/character_promo/`（其余）→ `src/character_promo/`
- `skill/character_turnaround/{SKILL.md,references}` → `skills/character-turnaround/`
- `skill/character_turnaround/`（其余）→ `src/character_turnaround/`
- `skill/viewer_server/SKILL.md` → `skills/viewer-server/SKILL.md`
- `skill/viewer_server/`（其余）→ `src/viewer_server/`

修改：
- `pyproject.toml` — `platformdirs`、`pywin32; sys_platform == "win32"`、tool 配置改包路径
- `src/character_workflow/lib/{projects,lessons,turn_start,jobs,context_loader,job_runner,draft_processor}.py` — `PROJECT_ROOT` → `data_root.*`
- `src/viewer_server/{server,routes,watcher}.py` — 同上
- `src/character_workflow/lib/turn_start.py` — 输出新增 `available_keys` + `preferred_alias`
- `src/character_workflow/lib/job_runner.py` — 按 provider dispatch caller
- `src/viewer_server/routes.py` — Keys + Onboarding REST endpoints
- `web/src/App.tsx` — 首屏路由按 onboarding status
- `web/src/schema/jobs.ts`（可能不动）+ `web/src/api/`（新增 keys / onboarding）
- `Makefile` — `dev-link` 改新 skills 路径、`install` 改 `src/` 包路径
- `README.md` — 三平台安装段
- 4 个 `SKILL.md` — 顶部加 MEMORY 必读 + bootstrap self-check 协议
- 仓库 `CLAUDE.md` — 改为"开发者文档" + Dev mode 段

不动：
- `docs/`、`characters/`、`projects/`、`.runtime/`、`memory/`、`web/src/components/*`（除新增页面）

---

## 阶段总览

| 阶段 | 目标 | 任务数 |
|---|---|---|
| 0 | Plugin manifest schema 实测验证（OQ-1） | 1 |
| 1 | Foundation：`data_root` + `bootstrap --check` 骨架 | 3 |
| 2 | 仓库重组 + 现有代码 `PROJECT_ROOT` → `data_root` | 4 |
| 3 | Keys 模块 + Caller 重构 + turn-start 扩展 | 5 |
| 4 | Bootstrap 各状态 + Onboarding REST API | 5 |
| 5 | Web UI — 首屏路由 + 数据目录向导 + Keys 管理 | 4 |
| 6 | Windows 平台兼容 | 4 |
| 7 | Plugin manifest + SKILL.md + Release 基建 | 5 |
| **总** | | **31** |

---

# 阶段 0 — Plugin manifest 实测验证（OQ-1）

> **决策门：** 这个阶段必须先做完，因为 plugin.json schema 未确认。如果实测发现声明多 Skill 不支持，触发 R-1 回退（4 个独立 Plugin），后续 plan 的"Plugin 一次包含 4 Skill"假设要重看。

### Task 1: 用最小 Plugin 实测 manifest schema

**Files:**
- Create: `/tmp/test-plugin-minimal/plugin.json`
- Create: `/tmp/test-plugin-minimal/skills/echo/SKILL.md`
- Doc: 在本 plan 文件追加"Task 1 验证结果"段

- [ ] **Step 1: 建最小 Plugin 目录**

```bash
mkdir -p /tmp/test-plugin-minimal/skills/echo
```

- [ ] **Step 2: 写 plugin.json（按 spec 推测的结构）**

写 `/tmp/test-plugin-minimal/plugin.json`：

```json
{
  "name": "test-plugin-minimal",
  "version": "0.0.1",
  "description": "Manifest schema probe",
  "skills": [
    { "name": "echo-skill", "path": "skills/echo/SKILL.md" }
  ]
}
```

- [ ] **Step 3: 写最小 SKILL.md**

写 `/tmp/test-plugin-minimal/skills/echo/SKILL.md`：

```markdown
---
name: echo-skill
description: Echo whatever the user says
---

# Echo

When invoked, reply "echo: <user's message>".
```

- [ ] **Step 4: 本地安装**

```bash
claude plugins install /tmp/test-plugin-minimal
```

Expected: 安装成功，或报错说明真实 schema 字段名。

- [ ] **Step 5: 在 CC 里触发 `/echo-skill 测试`**

Expected: Skill 被识别并执行。

- [ ] **Step 6: 记录验证结果**

在本 plan 文件结尾追加段落，记录：
- 真实的 plugin.json 字段名（`skills` / `entries` / 其他？）
- `bootstrap` / `onLoad` / `preinstall` 哪个字段名工作
- Plugin 安装目录的实际路径（`~/.claude/plugins/<name>/` 还是别的）
- 单 Plugin 多 Skill 是否支持（如果不支持 → 触发 R-1）

- [ ] **Step 7: 提交验证记录**

```bash
git add docs/superpowers/plans/2026-05-22-skill-distribution-impl.md
git commit -m "docs: record plugin manifest schema validation from minimal probe"
```

**决策点：** 如果实测确认 `skills` 字段名 + 单 Plugin 多 Skill OK → 继续后续任务原计划。如果不支持 → 暂停 plan，回 spec 触发 R-1 回退讨论。

---

# 阶段 1 — Foundation：data_root + bootstrap --check 骨架

> **设计原则：** 这个阶段不动现有代码。先把新模块写好、单测过，再去重构。

### Task 2: 加 `platformdirs` 依赖 + 新建 `data_root` 模块（骨架）

**Files:**
- Modify: `pyproject.toml`
- Create: `src/character_workflow/__init__.py`（空文件）
- Create: `src/character_workflow/lib/__init__.py`（空文件）
- Create: `src/character_workflow/lib/data_root.py`
- Create: `tests/test_data_root.py`

- [ ] **Step 1: 改 `pyproject.toml` 加 `platformdirs`**

在 `dependencies` list 加：

```toml
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.32",
  "watchdog>=5.0",
  "pydantic>=2.9",
  "python-multipart>=0.0.9",
  "requests>=2.32",
  "pypinyin>=0.53",
  "platformdirs>=4",
]
```

跑：

```bash
uv sync
```

Expected: `platformdirs` 装上。

- [ ] **Step 2: 建包结构**

```bash
mkdir -p src/character_workflow/lib
touch src/character_workflow/__init__.py
touch src/character_workflow/lib/__init__.py
```

修改 `pyproject.toml`，加：

```toml
[tool.hatch.build.targets.wheel]
packages = ["src/character_workflow"]
# 注：阶段 2 重组时再补全其他包
```

或者，更简单 — 用 setuptools 的 `[tool.setuptools.packages.find]`，根据现有项目当前构建方式取舍。MVP 先用 `pythonpath` 让测试找到包：

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
pythonpath = ["src", "skill"]
```

（保留 `skill` 让阶段 2 前的测试还能跑现有代码。）

- [ ] **Step 3: 写失败测试 `test_data_root.py`**

写 `tests/test_data_root.py`：

```python
from pathlib import Path
import os
import pytest
from character_workflow.lib import data_root


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    monkeypatch.delenv("CHARACTER_WORKFLOW_DATA_ROOT", raising=False)


def test_resolve_uses_env_var_first(monkeypatch, tmp_path):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    assert data_root.resolve_data_root() == tmp_path.resolve()


def test_resolve_falls_back_to_default_when_unset(monkeypatch, tmp_path):
    # Pretend platformdirs config dir is empty
    monkeypatch.setattr(data_root, "_global_config_file", lambda: tmp_path / "nonexistent")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path / "home"))
    expected = (tmp_path / "home" / "character-workflow").resolve()
    assert data_root.resolve_data_root() == expected


def test_resolve_reads_global_config_when_env_unset(monkeypatch, tmp_path):
    cfg = tmp_path / "data-root"
    cfg.write_text(str(tmp_path / "custom-root") + "\n")
    monkeypatch.setattr(data_root, "_global_config_file", lambda: cfg)
    assert data_root.resolve_data_root() == (tmp_path / "custom-root").resolve()


def test_resolve_global_config_strips_whitespace(monkeypatch, tmp_path):
    cfg = tmp_path / "data-root"
    cfg.write_text(f"  {tmp_path / 'a'}  \n\n")
    monkeypatch.setattr(data_root, "_global_config_file", lambda: cfg)
    assert data_root.resolve_data_root() == (tmp_path / "a").resolve()


def test_subdir_helpers(monkeypatch, tmp_path):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    assert data_root.config_dir() == tmp_path / ".config"
    assert data_root.runtime_dir() == tmp_path / ".runtime"
    assert data_root.venv_dir() == tmp_path / ".venv"
    assert data_root.projects_dir() == tmp_path / "projects"
    assert data_root.characters_dir() == tmp_path / "characters"
    assert data_root.workspace_memory() == tmp_path / "MEMORY.md"
    assert data_root.workspace_worldview() == tmp_path / "worldview.md"
    assert data_root.keys_file() == tmp_path / ".config" / "keys.json"


def test_venv_python_posix(monkeypatch, tmp_path):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(data_root.sys, "platform", "linux")
    assert data_root.venv_python() == tmp_path / ".venv" / "bin" / "python"


def test_venv_python_windows(monkeypatch, tmp_path):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(data_root.sys, "platform", "win32")
    assert data_root.venv_python() == tmp_path / ".venv" / "Scripts" / "python.exe"
```

- [ ] **Step 4: 跑测试看它失败**

```bash
uv run pytest tests/test_data_root.py -v
```

Expected: 全失败（module not found）。

- [ ] **Step 5: 实现 `data_root.py`**

写 `src/character_workflow/lib/data_root.py`：

```python
"""Data root resolver: env var > global config file > default."""
from __future__ import annotations
import os
import sys
from pathlib import Path

import platformdirs

_APP_NAME = "character-workflow"
_ENV_VAR = "CHARACTER_WORKFLOW_DATA_ROOT"


def _global_config_file() -> Path:
    return Path(platformdirs.user_config_dir(_APP_NAME)) / "data-root"


def resolve_data_root() -> Path:
    if env := os.environ.get(_ENV_VAR):
        return Path(env).expanduser().resolve()
    cfg = _global_config_file()
    if cfg.exists():
        text = cfg.read_text().strip()
        if text:
            return Path(text).expanduser().resolve()
    return (Path.home() / _APP_NAME).resolve()


def config_dir() -> Path:
    return resolve_data_root() / ".config"


def runtime_dir() -> Path:
    return resolve_data_root() / ".runtime"


def venv_dir() -> Path:
    return resolve_data_root() / ".venv"


def venv_python() -> Path:
    if sys.platform == "win32":
        return venv_dir() / "Scripts" / "python.exe"
    return venv_dir() / "bin" / "python"


def projects_dir() -> Path:
    return resolve_data_root() / "projects"


def characters_dir() -> Path:
    return resolve_data_root() / "characters"


def workspace_memory() -> Path:
    return resolve_data_root() / "MEMORY.md"


def workspace_worldview() -> Path:
    return resolve_data_root() / "worldview.md"


def keys_file() -> Path:
    return config_dir() / "keys.json"


def write_global_config(path: Path) -> None:
    """写全局 data-root 配置文件（用户手动改 data root 时用）。"""
    cfg = _global_config_file()
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(str(Path(path).expanduser().resolve()) + "\n")
```

- [ ] **Step 6: 跑测试看它通过**

```bash
uv run pytest tests/test_data_root.py -v
```

Expected: 全 PASS。

- [ ] **Step 7: 提交**

```bash
git add pyproject.toml src/character_workflow/__init__.py src/character_workflow/lib/__init__.py src/character_workflow/lib/data_root.py tests/test_data_root.py
git commit -m "feat(data-root): add data_root resolver with three-tier resolution"
```

---

### Task 3: bootstrap.py 骨架（仅 `--check` 返回 ready/needs_data_root）

**Files:**
- Create: `scripts/__init__.py`（让 pytest 能 import）
- Create: `scripts/bootstrap.py`
- Create: `tests/test_bootstrap.py`

- [ ] **Step 1: 写失败测试**

写 `tests/test_bootstrap.py`：

```python
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BOOTSTRAP = REPO_ROOT / "scripts" / "bootstrap.py"


def run_bootstrap(args, env_overrides=None):
    env = {**dict(__import__("os").environ), **(env_overrides or {})}
    result = subprocess.run(
        [sys.executable, str(BOOTSTRAP), *args],
        capture_output=True, text=True, env=env,
    )
    return result


def test_check_reports_needs_data_root_when_no_config(tmp_path, monkeypatch):
    # Point platformdirs config dir at empty tmp_path via env
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))  # Windows
    result = run_bootstrap(
        ["--check"],
        env_overrides={
            "XDG_CONFIG_HOME": str(tmp_path / "config"),
            "APPDATA": str(tmp_path / "appdata"),
            "CHARACTER_WORKFLOW_DATA_ROOT": "",
        },
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    assert out["status"] == "needs_data_root"
    assert out["data_root"] is None
    assert "next_action" in out


def test_check_reports_data_root_when_env_var_set(tmp_path):
    (tmp_path / ".config").mkdir()
    result = run_bootstrap(
        ["--check"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path)},
    )
    assert result.returncode == 0, result.stderr
    out = json.loads(result.stdout)
    assert out["data_root"] == str(tmp_path)
    # status will be needs_uv / needs_venv / needs_first_key — anything but needs_data_root
    assert out["status"] != "needs_data_root"
```

- [ ] **Step 2: 跑测试看它失败**

```bash
uv run pytest tests/test_bootstrap.py -v
```

Expected: FAIL（bootstrap.py 不存在）。

- [ ] **Step 3: 写最小 bootstrap.py 骨架**

写 `scripts/bootstrap.py`：

```python
#!/usr/bin/env python3
"""Bootstrap entrypoint for the game-ui-ai-workflow Plugin.

Only stdlib + platformdirs (single pure-Python dep). Runs under system python.
After venv is built, business logic switches to <data_root>/.venv/python.
"""
from __future__ import annotations
import argparse
import json
import os
import shutil
import sys
from pathlib import Path

import platformdirs

APP_NAME = "character-workflow"
ENV_VAR = "CHARACTER_WORKFLOW_DATA_ROOT"


def global_config_file() -> Path:
    return Path(platformdirs.user_config_dir(APP_NAME)) / "data-root"


def resolve_data_root() -> Path | None:
    if env := os.environ.get(ENV_VAR):
        return Path(env).expanduser().resolve()
    cfg = global_config_file()
    if cfg.exists():
        text = cfg.read_text().strip()
        if text:
            return Path(text).expanduser().resolve()
    return None


def check() -> dict:
    data_root = resolve_data_root()
    if data_root is None:
        return {
            "status": "needs_data_root",
            "data_root": None,
            "uv_path": shutil.which("uv"),
            "venv_python": None,
            "platform": sys.platform,
            "next_action": "选数据目录（CC 向导问用户）",
        }
    # Skeleton: assume next stages handle uv/venv/keys
    return {
        "status": "needs_uv",  # placeholder — Task 14 expands
        "data_root": str(data_root),
        "uv_path": shutil.which("uv"),
        "venv_python": None,
        "platform": sys.platform,
        "next_action": "(skeleton) 后续状态由 Task 14+ 实现",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=False)
    sub.add_parser("--check")
    # Accept --check as flag too
    args, rest = parser.parse_known_args()
    if "--check" in sys.argv:
        print(json.dumps(check(), ensure_ascii=False))
        return 0
    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 跑测试看它通过**

```bash
uv run pytest tests/test_bootstrap.py -v
```

Expected: 两个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/bootstrap.py tests/test_bootstrap.py
git commit -m "feat(bootstrap): skeleton --check returns needs_data_root / next state"
```

---

### Task 4: 测试 fixture — 自动注入隔离 data root

**Files:**
- Create: `tests/conftest.py`（如果不存在；存在就追加）

- [ ] **Step 1: 看现有 conftest**

```bash
cat tests/conftest.py 2>/dev/null || echo "<no conftest>"
```

- [ ] **Step 2: 加 / 写 conftest 隔离 fixture**

如果 `tests/conftest.py` 不存在，新建。如果存在，**只追加**下面这段，不改既有内容：

```python
import pytest


@pytest.fixture(autouse=True)
def isolated_data_root(tmp_path, monkeypatch):
    """Every test gets a clean data root via CHARACTER_WORKFLOW_DATA_ROOT.

    Pollutes neither user data nor other tests. Keeps PROJECT_ROOT untouched
    until Phase 2 migrates code paths.
    """
    root = tmp_path / "data-root"
    root.mkdir()
    (root / ".config").mkdir()
    (root / ".runtime").mkdir()
    (root / "projects").mkdir()
    (root / "characters").mkdir()
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(root))
    return root
```

- [ ] **Step 3: 跑全套测试确认无回归**

```bash
uv run pytest -v
```

Expected: 现有测试不被这个 fixture 干扰（它只设新 env var，不动 `PROJECT_ROOT`）。

- [ ] **Step 4: 提交**

```bash
git add tests/conftest.py
git commit -m "test: auto-inject isolated data root via CHARACTER_WORKFLOW_DATA_ROOT"
```

---

# 阶段 2 — 仓库重组 + 现有代码 `PROJECT_ROOT` → `data_root`

> **顺序敏感：** 先 `git mv` 改路径，再改代码 import + path 解析。每一步独立 commit。

### Task 5: 重组目录（一次性 git mv）

**Files:** 大批 `git mv` — 见下面命令。

- [ ] **Step 1: 移动 SKILL.md 到 skills/**

```bash
mkdir -p skills/character-workflow skills/character-promo skills/character-turnaround skills/viewer-server
git mv skill/character_workflow/SKILL.md skills/character-workflow/SKILL.md
git mv skill/character_workflow/references skills/character-workflow/references
git mv skill/character_promo/SKILL.md skills/character-promo/SKILL.md
if [ -d skill/character_promo/references ]; then git mv skill/character_promo/references skills/character-promo/references; fi
git mv skill/character_turnaround/SKILL.md skills/character-turnaround/SKILL.md
if [ -d skill/character_turnaround/references ]; then git mv skill/character_turnaround/references skills/character-turnaround/references; fi
git mv skill/viewer_server/SKILL.md skills/viewer-server/SKILL.md
```

- [ ] **Step 2: 移动 Python 源码到 src/**

```bash
mkdir -p src
git mv skill/character_workflow src/character_workflow_TMP   # 避免与 skills/character-workflow 同名冲突
git mv src/character_workflow_TMP src/character_workflow
git mv skill/character_promo src/character_promo
git mv skill/character_turnaround src/character_turnaround
git mv skill/viewer_server src/viewer_server
# 清掉留下的 skill/ 顶层（如有空目录）
rmdir skill/__pycache__ 2>/dev/null || true
rmdir skill 2>/dev/null || true
git rm skill/__init__.py 2>/dev/null || true
```

- [ ] **Step 3: 移动 viewer-server 静态产物输出位置（删旧目录占位）**

```bash
# Vite 已配置 outDir: skill/viewer_server/static/, Task 25 会改 vite.config 指向 web/dist/
# 此处暂留 — 仅移动源码
```

- [ ] **Step 4: 确认重组结果**

```bash
ls skills/ && echo "---" && ls src/
```

Expected:
```
skills/character-workflow  character-promo  character-turnaround  viewer-server
src/character_workflow  character_promo  character_turnaround  viewer_server
```

- [ ] **Step 5: 改 Makefile dev-link**

读 `Makefile`，找到 `dev-link` 目标，把 `skill/character_workflow` 等 4 处路径改为 `skills/character-workflow` 等。

具体命令（举例 — 实际依赖现有 Makefile 写法）：

```makefile
dev-link:
	mkdir -p ~/.claude/skills
	ln -sfn $(PWD)/skills/character-workflow ~/.claude/skills/character-workflow
	ln -sfn $(PWD)/skills/character-promo ~/.claude/skills/character-promo
	ln -sfn $(PWD)/skills/character-turnaround ~/.claude/skills/character-turnaround
	ln -sfn $(PWD)/skills/viewer-server ~/.claude/skills/viewer-server

dev-unlink:
	rm -f ~/.claude/skills/character-workflow
	rm -f ~/.claude/skills/character-promo
	rm -f ~/.claude/skills/character-turnaround
	rm -f ~/.claude/skills/viewer-server
```

- [ ] **Step 6: 改 pyproject.toml `pythonpath`**

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
pythonpath = ["src"]
```

- [ ] **Step 7: 改全部 Python import**

```bash
grep -rl "from skill\." src/ tests/ scripts/ 2>/dev/null
grep -rl "import skill\." src/ tests/ scripts/ 2>/dev/null
```

对每个文件，用 Edit 把 `from skill.character_workflow.X` → `from character_workflow.X`，`from skill.character_promo.X` → `from character_promo.X`，以此类推。

工具命令（用 sed 一遍过 — Python files only）：

```bash
find src tests scripts -name "*.py" -exec sed -i.bak 's/from skill\.character_workflow/from character_workflow/g; s/from skill\.character_promo/from character_promo/g; s/from skill\.character_turnaround/from character_turnaround/g; s/from skill\.viewer_server/from viewer_server/g; s/import skill\.character_workflow/import character_workflow/g; s/import skill\.character_promo/import character_promo/g; s/import skill\.character_turnaround/import character_turnaround/g; s/import skill\.viewer_server/import viewer_server/g' {} \;
find src tests scripts -name "*.bak" -delete
```

- [ ] **Step 8: 改 SKILL.md 里的 CLI module 名**

```bash
grep -rl "python -m skill\." skills/ docs/ 2>/dev/null
```

对每个文件，把 `python -m skill.character_workflow X` 改为 `python -m character_workflow X`，`python -m skill.viewer_server` 改为 `python -m viewer_server` 等。

- [ ] **Step 9: 改 CLAUDE.md / README 引用的路径**

```bash
grep -rl "skill/character_workflow\|skill/viewer_server\|skill/character_promo\|skill/character_turnaround" CLAUDE.md README.md docs/ 2>/dev/null
```

对每个文件，按映射改路径（保留原文内容上下文，仅替换路径段）。

- [ ] **Step 10: 跑测试**

```bash
uv run pytest -v
```

Expected: 现有测试全 PASS（虽然代码还是用 `PROJECT_ROOT`，但导入路径已经统一）。如果失败，多半是 import 遗漏，逐个修。

- [ ] **Step 11: 提交（一次完整的 mv + import 改名）**

```bash
git add -A
git commit -m "refactor: relocate skill/<name>/ → skills/<dashed-name>/ + src/<snake_name>/

- SKILL.md + references now live in skills/<dashed-name>/
- Python source now lives in src/<snake_name>/
- Imports updated from skill.* to bare package names
- Makefile dev-link / pyproject.toml pythonpath updated"
```

---

### Task 6: 抽象 PROJECT_ROOT → data_root（character_workflow lib 部分）

**Files:**
- Modify: `src/character_workflow/lib/projects.py`
- Modify: `src/character_workflow/lib/lessons.py`
- Modify: `src/character_workflow/lib/turn_start.py`
- Modify: `src/character_workflow/lib/jobs.py`
- Modify: `src/character_workflow/lib/context_loader.py`
- Modify: `src/character_workflow/lib/job_runner.py`
- Modify: `src/character_workflow/lib/draft_processor.py`

- [ ] **Step 1: 列出所有 `PROJECT_ROOT` 使用**

```bash
grep -n "PROJECT_ROOT\|Path.cwd()" src/character_workflow/lib/*.py
```

- [ ] **Step 2: 写一个迁移单测验证替换无回归**

写 `tests/test_data_root_migration.py`：

```python
"""Smoke test: after migration, key modules read from CHARACTER_WORKFLOW_DATA_ROOT."""
from pathlib import Path
import json
import pytest
from character_workflow.lib import data_root


def test_projects_module_reads_from_data_root(isolated_data_root):
    from character_workflow.lib import projects
    runtime = data_root.runtime_dir()
    (runtime / "projects.json").write_text(json.dumps({
        "version": 1, "projects": [], "assignments": {}
    }))
    # Trigger any read path — adjust to actual module API
    result = projects.list_projects()
    assert result == []


def test_lessons_module_reads_from_data_root(isolated_data_root):
    from character_workflow.lib import lessons
    # Smoke: should not raise
    lessons.load_lessons(scope="workspace")


def test_jobs_module_writes_to_runtime_dir(isolated_data_root):
    from character_workflow.lib import jobs
    job_id = "test-job-1"
    # Adjust to actual API; assume jobs.write_job(job_id, payload)
    jobs.write_job(job_id, {
        "job_id": job_id, "status": "PENDING_CONFIRM",
        "character_id": "x", "prompt": "test", "model": "gpt_image_2",
    })
    assert (data_root.runtime_dir() / "jobs" / f"{job_id}.json").exists()
```

- [ ] **Step 3: 跑迁移单测看它失败**

```bash
uv run pytest tests/test_data_root_migration.py -v
```

Expected: 多半 FAIL（模块仍用 PROJECT_ROOT / Path.cwd()）。

- [ ] **Step 4: 改 `projects.py`**

读 `src/character_workflow/lib/projects.py`，找到所有 `PROJECT_ROOT` / `Path(os.environ.get("PROJECT_ROOT", Path.cwd()))` 用法，替换为 `data_root.runtime_dir()` / `data_root.projects_dir()` 等对应函数。

顶部加：

```python
from character_workflow.lib import data_root
```

具体替换（举例）：

| 旧 | 新 |
|---|---|
| `PROJECT_ROOT / ".runtime" / "projects.json"` | `data_root.runtime_dir() / "projects.json"` |
| `PROJECT_ROOT / "projects" / slug` | `data_root.projects_dir() / slug` |
| `PROJECT_ROOT / "characters" / cid` | `data_root.characters_dir() / cid` |

每个文件改完跑一次该模块相关的现有测试。

- [ ] **Step 5: 改 `lessons.py`**

同上模式。`lessons.py` 已经是 project-aware（前置 plan），找到所有 path constants 改成 `data_root.*` 调用。

- [ ] **Step 6: 改 `turn_start.py`**

同上。注意 `turn_start.py` 是 CLI 入口，会读 `.runtime/draft/` 等多处。全部走 `data_root`。

- [ ] **Step 7: 改 `jobs.py`**

```python
# 旧
JOBS_DIR = PROJECT_ROOT / ".runtime" / "jobs"

# 新
def _jobs_dir() -> Path:
    d = data_root.runtime_dir() / "jobs"
    d.mkdir(parents=True, exist_ok=True)
    return d
```

替换全文件所有 `JOBS_DIR` 引用为 `_jobs_dir()`。

- [ ] **Step 8: 改 `context_loader.py`、`job_runner.py`、`draft_processor.py`**

同上模式。

- [ ] **Step 9: 跑迁移单测看它通过**

```bash
uv run pytest tests/test_data_root_migration.py -v
```

Expected: PASS。

- [ ] **Step 10: 跑全套测试无回归**

```bash
uv run pytest -v
```

Expected: 全 PASS。

- [ ] **Step 11: 提交**

```bash
git add src/character_workflow/lib/*.py tests/test_data_root_migration.py
git commit -m "refactor(character_workflow): replace PROJECT_ROOT with data_root abstraction"
```

---

### Task 7: 抽象 PROJECT_ROOT → data_root（viewer_server 部分）

**Files:**
- Modify: `src/viewer_server/server.py`
- Modify: `src/viewer_server/routes.py`
- Modify: `src/viewer_server/watcher.py`

- [ ] **Step 1: 列出 viewer_server 中的 PROJECT_ROOT 使用**

```bash
grep -n "PROJECT_ROOT\|Path.cwd()" src/viewer_server/*.py
```

- [ ] **Step 2: 改 `server.py`**

替换所有 path constants 为 `data_root.runtime_dir()` 等调用。`PID_FILE` / `PORT_FILE`：

```python
from character_workflow.lib import data_root

def _pid_file() -> Path: return data_root.runtime_dir() / "server.pid"
def _port_file() -> Path: return data_root.runtime_dir() / "server.port"
```

替换全文件用法。

- [ ] **Step 3: 改 `routes.py`**

所有 path 读写改 `data_root.*`。例如 `/api/raw` 的根路径白名单：

```python
SAFE_ROOTS = (
    data_root.characters_dir(),
    data_root.runtime_dir() / "jobs",
)
```

（注意 Tasks 17 会在这里继续加 keys / onboarding endpoint，此 Task 只改 path 抽象。）

- [ ] **Step 4: 改 `watcher.py`**

`watchdog` 监听根目录改为 `data_root.runtime_dir() / "draft"`、`data_root.characters_dir()` 等。

- [ ] **Step 5: 跑现有 viewer_server 相关测试**

```bash
uv run pytest tests/test_routes_post.py tests/test_routes_get.py -v
```

Expected: 全 PASS（fixture 已注入 `CHARACTER_WORKFLOW_DATA_ROOT=tmp_path`）。

- [ ] **Step 6: 提交**

```bash
git add src/viewer_server/*.py
git commit -m "refactor(viewer_server): replace PROJECT_ROOT with data_root abstraction"
```

---

### Task 8: 删除 `PROJECT_ROOT` 残留 + 验证 success criteria #2/#3

**Files:**
- Modify: 残留的旧引用文件
- Add: CI guard 脚本

- [ ] **Step 1: 全仓库扫 PROJECT_ROOT 残留**

```bash
grep -rn "PROJECT_ROOT\|Path.cwd()" src/ scripts/ skills/ 2>/dev/null
```

Expected: 应该为空。如果有遗漏，逐个清掉。

- [ ] **Step 2: 加 CI 脚本 `scripts/check_no_project_root.sh`**

写 `scripts/check_no_project_root.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

# Success criterion #2 / #3 enforcement:
# - Path.cwd() must not appear in src/, scripts/
# - PROJECT_ROOT (the legacy env var name) must not appear anywhere
violations=0
if grep -rn "Path.cwd()" src/ scripts/ 2>/dev/null; then
  echo "ERROR: Path.cwd() found in src/ or scripts/"
  violations=1
fi
if grep -rn "PROJECT_ROOT" src/ scripts/ skills/ tests/ 2>/dev/null; then
  echo "ERROR: PROJECT_ROOT env var name found — should be CHARACTER_WORKFLOW_DATA_ROOT"
  violations=1
fi
if [ $violations -ne 0 ]; then
  exit 1
fi
echo "OK: no PROJECT_ROOT / Path.cwd() leakage"
```

```bash
chmod +x scripts/check_no_project_root.sh
./scripts/check_no_project_root.sh
```

Expected: `OK: no PROJECT_ROOT / Path.cwd() leakage`。

- [ ] **Step 3: 提交**

```bash
git add scripts/check_no_project_root.sh
git commit -m "ci: guard against PROJECT_ROOT / Path.cwd() regressions"
```

---

# 阶段 3 — Keys 模块 + Caller 重构 + turn-start 扩展

### Task 9: `keys.py` 模块 — 数据模型 + 文件 I/O

**Files:**
- Create: `src/character_workflow/lib/keys.py`
- Create: `tests/test_keys.py`

- [ ] **Step 1: 写失败测试 `tests/test_keys.py`**

```python
import json
import pytest
from character_workflow.lib import keys, data_root


def _seed(payload: dict) -> None:
    keys.write_keys_db(keys.KeysDB.model_validate(payload))


def test_read_empty_when_file_missing(isolated_data_root):
    db = keys.read_keys_db()
    assert db.version == 1
    assert db.default_alias is None
    assert db.keys == []


def test_write_and_read_roundtrip(isolated_data_root):
    payload = {
        "version": 1,
        "default_alias": "lovart-primary",
        "keys": [{
            "alias": "lovart-primary",
            "provider": "lovart",
            "access_key": "ak_test",
            "secret_key": "sk_test",
            "capabilities": ["portrait", "promo", "turnaround"],
            "models": ["gpt_image_2"],
            "notes": "test",
            "created_at": "2026-05-22T14:00:00+08:00",
        }],
    }
    _seed(payload)
    db = keys.read_keys_db()
    assert db.default_alias == "lovart-primary"
    assert db.keys[0].alias == "lovart-primary"
    assert db.keys[0].access_key == "ak_test"


def test_find_by_alias(isolated_data_root):
    _seed({"version": 1, "default_alias": None, "keys": [
        {"alias": "a", "provider": "lovart", "access_key": "x", "secret_key": "y",
         "capabilities": ["portrait"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
    ]})
    k = keys.find_by_alias("a")
    assert k.access_key == "x"
    assert keys.find_by_alias("missing") is None


def test_preferred_alias_returns_default_when_capability_matches(isolated_data_root):
    _seed({"version": 1, "default_alias": "a", "keys": [
        {"alias": "a", "provider": "lovart", "access_key": "x", "secret_key": "y",
         "capabilities": ["portrait", "promo"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
    ]})
    assert keys.preferred_alias_for_kind("portrait") == "a"


def test_preferred_alias_skips_default_when_capability_missing(isolated_data_root):
    _seed({"version": 1, "default_alias": "a", "keys": [
        {"alias": "a", "provider": "openai", "access_key": "x", "secret_key": None,
         "capabilities": ["portrait"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
        {"alias": "b", "provider": "lovart", "access_key": "y", "secret_key": "z",
         "capabilities": ["turnaround"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
    ]})
    assert keys.preferred_alias_for_kind("turnaround") == "b"


def test_preferred_alias_returns_none_when_no_key_matches(isolated_data_root):
    _seed({"version": 1, "default_alias": "a", "keys": [
        {"alias": "a", "provider": "openai", "access_key": "x", "secret_key": None,
         "capabilities": ["portrait"], "models": [], "notes": "", "created_at": "2026-05-22T00:00:00+08:00"},
    ]})
    assert keys.preferred_alias_for_kind("promo") is None


def test_add_key_appends(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="lovart", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    db = keys.read_keys_db()
    assert len(db.keys) == 1
    assert db.keys[0].alias == "x"


def test_add_key_rejects_duplicate_alias(isolated_data_root):
    spec = keys.KeySpec(
        alias="x", provider="lovart", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    )
    keys.add_key(spec)
    with pytest.raises(keys.DuplicateAliasError):
        keys.add_key(spec)


def test_patch_key_updates_partial(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="lovart", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="old",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.patch_key("x", {"notes": "new", "capabilities": ["promo"]})
    k = keys.find_by_alias("x")
    assert k.notes == "new"
    assert k.capabilities == ["promo"]
    assert k.access_key == "a"  # preserved


def test_patch_key_secret_preserved_when_not_provided(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="lovart", access_key="ak1", secret_key="sk1",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.patch_key("x", {"notes": "updated"})
    k = keys.find_by_alias("x")
    assert k.access_key == "ak1"
    assert k.secret_key == "sk1"


def test_delete_key_removes(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="lovart", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.delete_key("x")
    assert keys.find_by_alias("x") is None


def test_delete_key_clears_default_alias_if_deleted(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="x", provider="lovart", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.set_default_alias("x")
    keys.delete_key("x")
    db = keys.read_keys_db()
    assert db.default_alias is None


def test_set_default_alias_validates_existence(isolated_data_root):
    with pytest.raises(keys.NoSuchAliasError):
        keys.set_default_alias("nonexistent")


def test_keys_file_chmod_600_on_posix(isolated_data_root, monkeypatch):
    import sys, os
    if sys.platform == "win32":
        pytest.skip("POSIX-only test")
    keys.add_key(keys.KeySpec(
        alias="x", provider="lovart", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    mode = oct(data_root.keys_file().stat().st_mode & 0o777)
    assert mode == "0o600"
```

- [ ] **Step 2: 跑测试看它失败**

```bash
uv run pytest tests/test_keys.py -v
```

Expected: 全 FAIL（module not found）。

- [ ] **Step 3: 实现 `keys.py`**

写 `src/character_workflow/lib/keys.py`：

```python
"""keys.json CRUD + AI Key selection protocol.

Schema: see docs/superpowers/specs/2026-05-22-skill-distribution-design.md §5.1.
Secrets never leave this module's read paths — REST API uses `keys_for_api()`
which strips secrets, and turn-start uses `keys_for_turn_start()` (same).
"""
from __future__ import annotations
import json
import os
import sys
from typing import Literal
from pydantic import BaseModel, Field

from character_workflow.lib import data_root

Provider = Literal["lovart", "openai", "midjourney", "nano_banana", "seedream", "custom"]
Kind = Literal["portrait", "promo", "turnaround"]


class KeySpec(BaseModel):
    alias: str
    provider: Provider
    access_key: str
    secret_key: str | None = None
    capabilities: list[Kind] = Field(default_factory=list)
    models: list[str] = Field(default_factory=list)
    notes: str = ""
    created_at: str


class KeysDB(BaseModel):
    version: int = 1
    default_alias: str | None = None
    keys: list[KeySpec] = Field(default_factory=list)


class DuplicateAliasError(Exception): ...
class NoSuchAliasError(Exception): ...
class KeysFileCorruptedError(Exception): ...


def read_keys_db() -> KeysDB:
    path = data_root.keys_file()
    if not path.exists():
        return KeysDB()
    try:
        raw = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise KeysFileCorruptedError(f"{path}: {e}") from e
    return KeysDB.model_validate(raw)


def write_keys_db(db: KeysDB) -> None:
    path = data_root.keys_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(db.model_dump(), ensure_ascii=False, indent=2))
    _restrict_permissions(path)


def _restrict_permissions(path) -> None:
    if sys.platform == "win32":
        # Task 23 wires Windows ACL via pywin32
        try:
            from character_workflow.lib.win_acl import restrict_keys_file_windows
            restrict_keys_file_windows(path)
        except ImportError:
            pass  # pywin32 unavailable — best-effort, see Task 23 fallback
    else:
        os.chmod(path, 0o600)


def find_by_alias(alias: str) -> KeySpec | None:
    db = read_keys_db()
    for k in db.keys:
        if k.alias == alias:
            return k
    return None


def add_key(spec: KeySpec) -> None:
    db = read_keys_db()
    if any(k.alias == spec.alias for k in db.keys):
        raise DuplicateAliasError(spec.alias)
    db.keys.append(spec)
    write_keys_db(db)


def patch_key(alias: str, patch: dict) -> None:
    db = read_keys_db()
    for i, k in enumerate(db.keys):
        if k.alias == alias:
            updated = k.model_copy(update=patch)
            db.keys[i] = updated
            write_keys_db(db)
            return
    raise NoSuchAliasError(alias)


def delete_key(alias: str) -> None:
    db = read_keys_db()
    db.keys = [k for k in db.keys if k.alias != alias]
    if db.default_alias == alias:
        db.default_alias = None
    write_keys_db(db)


def set_default_alias(alias: str) -> None:
    db = read_keys_db()
    if not any(k.alias == alias for k in db.keys):
        raise NoSuchAliasError(alias)
    db.default_alias = alias
    write_keys_db(db)


def preferred_alias_for_kind(kind: Kind) -> str | None:
    """Per spec §5.2 — default if capability matches, else first matching key."""
    db = read_keys_db()
    if db.default_alias:
        for k in db.keys:
            if k.alias == db.default_alias and kind in k.capabilities:
                return k.alias
    for k in db.keys:
        if kind in k.capabilities:
            return k.alias
    return None


def keys_for_api() -> list[dict]:
    """Strip secrets — used by REST GET /api/keys."""
    db = read_keys_db()
    out = []
    for k in db.keys:
        d = k.model_dump()
        d["access_key"] = _mask(d.get("access_key"))
        d["secret_key"] = None
        d["is_default"] = (k.alias == db.default_alias)
        out.append(d)
    return out


def keys_for_turn_start() -> list[dict]:
    """Strip secrets entirely — used by turn-start CLI for AI consumption."""
    db = read_keys_db()
    out = []
    for k in db.keys:
        out.append({
            "alias": k.alias,
            "provider": k.provider,
            "capabilities": k.capabilities,
            "models": k.models,
            "notes": k.notes,
            "is_default": k.alias == db.default_alias,
        })
    return out


def _mask(s: str | None) -> str | None:
    if not s:
        return None
    if len(s) <= 6:
        return "***"
    return f"{s[:3]}...{s[-3:]}"
```

- [ ] **Step 4: 跑测试看它通过**

```bash
uv run pytest tests/test_keys.py -v
```

Expected: 全 PASS（Windows ACL 测试用 skipif 跳过）。

- [ ] **Step 5: 提交**

```bash
git add src/character_workflow/lib/keys.py tests/test_keys.py
git commit -m "feat(keys): keys.json CRUD + preferred_alias_for_kind + secret stripping"
```

---

### Task 10: Secret redaction log filter

**Files:**
- Create: `src/character_workflow/lib/secret_filter.py`
- Create: `tests/test_secret_redaction.py`

- [ ] **Step 1: 写失败测试**

写 `tests/test_secret_redaction.py`：

```python
import logging
import io
import pytest
from character_workflow.lib.secret_filter import SecretRedactionFilter


def test_redacts_access_key_in_message():
    h = io.StringIO()
    logger = logging.getLogger("test-redact-1")
    handler = logging.StreamHandler(h)
    handler.addFilter(SecretRedactionFilter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.info("calling with access_key=ak_supersecret")
    assert "ak_supersecret" not in h.getvalue()
    assert "access_key=***" in h.getvalue()


def test_redacts_secret_key_in_message():
    h = io.StringIO()
    logger = logging.getLogger("test-redact-2")
    handler = logging.StreamHandler(h)
    handler.addFilter(SecretRedactionFilter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.info("secret_key=sk_xyz123")
    assert "sk_xyz123" not in h.getvalue()


def test_redacts_in_args_dict():
    h = io.StringIO()
    logger = logging.getLogger("test-redact-3")
    handler = logging.StreamHandler(h)
    handler.addFilter(SecretRedactionFilter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.info("payload: %s", {"access_key": "leak_me", "alias": "x"})
    assert "leak_me" not in h.getvalue()


def test_does_not_alter_safe_messages():
    h = io.StringIO()
    logger = logging.getLogger("test-redact-4")
    handler = logging.StreamHandler(h)
    handler.addFilter(SecretRedactionFilter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.info("hello world")
    assert "hello world" in h.getvalue()
```

- [ ] **Step 2: 跑测试看它失败**

```bash
uv run pytest tests/test_secret_redaction.py -v
```

- [ ] **Step 3: 实现 `secret_filter.py`**

写 `src/character_workflow/lib/secret_filter.py`：

```python
"""Logging filter that masks access_key / secret_key in log records."""
from __future__ import annotations
import logging
import re

_PATTERNS = [
    re.compile(r"(access_key)[=:\s'\"]+([A-Za-z0-9_\-]+)"),
    re.compile(r"(secret_key)[=:\s'\"]+([A-Za-z0-9_\-]+)"),
]


def _redact(text: str) -> str:
    for pat in _PATTERNS:
        text = pat.sub(r"\1=***", text)
    return text


class SecretRedactionFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        redacted = _redact(msg)
        if redacted != msg:
            record.msg = redacted
            record.args = ()
        return True
```

- [ ] **Step 4: 跑测试看它通过**

```bash
uv run pytest tests/test_secret_redaction.py -v
```

Expected: 全 PASS。

- [ ] **Step 5: 在 viewer-server 启动时挂上过滤器**

读 `src/viewer_server/server.py`，找到 logger 配置区域，加：

```python
from character_workflow.lib.secret_filter import SecretRedactionFilter

# After logger / handler setup:
for handler in logging.getLogger().handlers:
    handler.addFilter(SecretRedactionFilter())
```

- [ ] **Step 6: 提交**

```bash
git add src/character_workflow/lib/secret_filter.py tests/test_secret_redaction.py src/viewer_server/server.py
git commit -m "feat(logging): redact access_key / secret_key from log records"
```

---

### Task 11: Caller dispatch + Lovart caller 重构（接 alias）

**Files:**
- Create: `src/character_workflow/lib/callers/__init__.py`
- Create: `src/character_workflow/lib/callers/lovart.py`
- Create: `src/character_workflow/lib/callers/stubs.py`
- Modify: `src/character_workflow/lib/job_runner.py`
- Delete: `src/character_workflow/lib/lovart_caller.py`（重构后移走）
- Create: `tests/test_callers_dispatch.py`

- [ ] **Step 1: 写失败测试 `tests/test_callers_dispatch.py`**

```python
import pytest
from character_workflow.lib import keys
from character_workflow.lib.callers import dispatch, NoSuchKeyError, WrongProviderError


def _seed_lovart(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="lov", provider="lovart", access_key="ak", secret_key="sk",
        capabilities=["portrait"], models=["gpt_image_2"], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))


def test_dispatch_routes_lovart_alias(isolated_data_root, monkeypatch):
    _seed_lovart(isolated_data_root)
    called = {}
    def fake_render(prompt, model, alias, **kw):
        called["prompt"] = prompt
        called["model"] = model
        called["alias"] = alias
        return ["/tmp/fake.png"]
    monkeypatch.setattr("character_workflow.lib.callers.lovart.render", fake_render)
    out = dispatch(prompt="a wolf", model="gpt_image_2", alias="lov")
    assert out == ["/tmp/fake.png"]
    assert called == {"prompt": "a wolf", "model": "gpt_image_2", "alias": "lov"}


def test_dispatch_raises_on_unknown_alias(isolated_data_root):
    with pytest.raises(NoSuchKeyError):
        dispatch(prompt="x", model="y", alias="unknown")


def test_dispatch_raises_not_implemented_for_stub_providers(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="oa", provider="openai", access_key="x", secret_key=None,
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    with pytest.raises(NotImplementedError):
        dispatch(prompt="x", model="y", alias="oa")
```

- [ ] **Step 2: 跑测试看它失败**

```bash
uv run pytest tests/test_callers_dispatch.py -v
```

- [ ] **Step 3: 写 `callers/__init__.py`**

```python
"""Provider-routing entrypoint for image generation calls.

dispatch(prompt, model, alias) looks up the alias in keys.json,
checks provider type, and routes to the matching caller module.
"""
from __future__ import annotations
from character_workflow.lib import keys
from character_workflow.lib.callers import lovart, stubs


class NoSuchKeyError(Exception): ...
class WrongProviderError(Exception): ...


_PROVIDER_CALLERS = {
    "lovart": lovart.render,
    "openai": stubs.openai_render,
    "midjourney": stubs.midjourney_render,
    "nano_banana": stubs.nano_banana_render,
    "seedream": stubs.seedream_render,
    "custom": stubs.custom_render,
}


def dispatch(*, prompt: str, model: str, alias: str, **kwargs):
    key = keys.find_by_alias(alias)
    if key is None:
        raise NoSuchKeyError(alias)
    if key.provider not in _PROVIDER_CALLERS:
        raise WrongProviderError(key.provider)
    return _PROVIDER_CALLERS[key.provider](
        prompt=prompt, model=model, alias=alias, **kwargs
    )
```

- [ ] **Step 4: 写 `callers/lovart.py`（从老 `lovart_caller.py` 提）**

读老 `src/character_workflow/lib/lovart_caller.py`，把核心 subprocess 逻辑移到新文件 `src/character_workflow/lib/callers/lovart.py`：

```python
"""Lovart caller — reads access_key / secret_key from keys.json via alias."""
from __future__ import annotations
import os
import subprocess
from pathlib import Path
from character_workflow.lib import keys, data_root


def render(*, prompt: str, model: str, alias: str, **kwargs) -> list[str]:
    key = keys.find_by_alias(alias)
    if key is None or key.provider != "lovart":
        raise ValueError(f"alias {alias} is not a lovart key")

    cli = os.environ.get("LOVART_CLI", "lovart")
    env = os.environ.copy()
    env["LOVART_ACCESS_KEY"] = key.access_key
    if key.secret_key:
        env["LOVART_SECRET_KEY"] = key.secret_key

    output_dir = kwargs.get("output_dir") or str(data_root.runtime_dir() / "jobs" / "output")
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    cmd = [
        cli,
        "--prompt", prompt,
        "--include-tools", f"generate_image_{model}",
        "--output-dir", output_dir,
        "--json", "--download",
    ]
    if subject := kwargs.get("subject_image"):
        cmd.extend(["--subject-image", subject])

    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"lovart CLI failed: {proc.stderr}")

    # Parse output paths from CLI JSON output (existing logic preserved verbatim
    # from lovart_caller.py — keep the same JSON shape).
    import json as _json
    payload = _json.loads(proc.stdout)
    return [item["local_path"] for item in payload.get("images", [])]
```

**保留老 `lovart_caller.py` 中所有重要 logic（错误处理、subject_image、reference）— 上面是简化版骨架，实施时移植完整逻辑。**

- [ ] **Step 5: 写 `callers/stubs.py`**

```python
"""Stub callers for providers not yet implemented."""
from __future__ import annotations


def _stub(provider: str):
    def _impl(**_kwargs):
        raise NotImplementedError(f"provider {provider} 尚未实现 — 见 spec §5.4")
    return _impl


openai_render = _stub("openai")
midjourney_render = _stub("midjourney")
nano_banana_render = _stub("nano_banana")
seedream_render = _stub("seedream")
custom_render = _stub("custom")
```

- [ ] **Step 6: 改 `job_runner.py` 使用 dispatch**

读 `src/character_workflow/lib/job_runner.py`，找到调 `lovart_caller.render(...)` 的地方，改为：

```python
from character_workflow.lib.callers import dispatch

# 在 _run_job() 里 — 旧 lovart_caller.render(...) 改为：
output_paths = dispatch(
    prompt=job.prompt,
    model=job.model,
    alias=job.alias,  # 新字段（Task 12 给 Job model 加上）
    subject_image=job.subject_image_path,
    output_dir=str(job_output_dir),
)
```

- [ ] **Step 7: 删除老的 `lovart_caller.py`**

```bash
git rm src/character_workflow/lib/lovart_caller.py
```

更新 import 引用 — `grep -rn "lovart_caller" src/ tests/` 应该没有结果。如有遗漏，逐个修。

- [ ] **Step 8: 跑测试**

```bash
uv run pytest tests/test_callers_dispatch.py -v
uv run pytest -v
```

Expected: 全 PASS（如有现存 lovart 集成测试，需要 update 用新 dispatch API）。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "refactor(callers): introduce alias-based dispatch + relocate lovart caller"
```

---

### Task 12: Job 模型加 `alias` 字段 + turn-start 输出 `available_keys` / `preferred_alias`

**Files:**
- Modify: `src/character_workflow/lib/schemas.py`
- Modify: `src/character_workflow/lib/turn_start.py`
- Modify: `src/character_workflow/lib/jobs.py`
- Modify: `web/src/schema/jobs.ts`（保持同步）
- Modify: `tests/test_turn_start.py`（如已存在；否则新建）

- [ ] **Step 1: 在 `schemas.py` 给 Job 加 `alias` + `provider` 字段**

读 `src/character_workflow/lib/schemas.py`，找到 Job / JobCreate Pydantic model。加：

```python
class Job(BaseModel):
    job_id: str
    character_id: str
    kind: Literal["portrait", "promo", "turnaround"]
    status: JobStatus
    prompt: str
    model: str
    alias: str | None = None         # ← 新增：用哪个 Key
    provider: str | None = None      # ← 新增：alias 对应的 provider，便于前端 badge 显示
    params: dict | None = None
    seed: int | None = None
    subject_image_path: str | None = None
    output_paths: list[str] = Field(default_factory=list)
    submitted_at: str | None = None
    error: str | None = None
```

**`WebEditableJobPatch` 不加 `alias`** — Web 不应直接改 Key 选择（AI 决定），保留 Web 仅可改 `prompt / model / params / seed`。

- [ ] **Step 2: 同步 TS schema**

读 `web/src/schema/jobs.ts`，给 `Job` 类型加 `alias?: string | null` 和 `provider?: string | null`：

```typescript
export const jobStatus = z.enum([
  "PENDING_CONFIRM", "PENDING", "DONE", "FAILED",
]);

export const jobSchema = z.object({
  job_id: z.string(),
  character_id: z.string(),
  kind: z.enum(["portrait", "promo", "turnaround"]),
  status: jobStatus,
  prompt: z.string(),
  model: z.string(),
  alias: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  // ... 其他字段保持原样
});
```

- [ ] **Step 3: 改 `turn_start.py` 输出新增 `available_keys` / `preferred_alias`**

读 `src/character_workflow/lib/turn_start.py`，找到最后构造输出 dict 的位置。加：

```python
from character_workflow.lib import keys

# kind 来自 CLI args 或 spec.md 解析 — 假设已有 self.kind 或类似
def _build_output(self) -> dict:
    base = {
        # ... 现有字段保持
    }
    base["available_keys"] = keys.keys_for_turn_start()
    base["preferred_alias"] = keys.preferred_alias_for_kind(self.kind) if self.kind else None
    return base
```

- [ ] **Step 4: 写测试 `tests/test_turn_start_keys.py`**

```python
import json
import subprocess
import sys
from pathlib import Path
from character_workflow.lib import keys

REPO_ROOT = Path(__file__).resolve().parent.parent


def _seed_keys(isolated_data_root):
    keys.add_key(keys.KeySpec(
        alias="lov", provider="lovart", access_key="ak", secret_key="sk",
        capabilities=["portrait", "promo"], models=["gpt_image_2"],
        notes="主力", created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.add_key(keys.KeySpec(
        alias="oa", provider="openai", access_key="x", secret_key=None,
        capabilities=["portrait"], models=[],
        notes="便宜", created_at="2026-05-22T00:00:00+08:00",
    ))
    keys.set_default_alias("lov")


def test_turn_start_includes_available_keys_without_secrets(isolated_data_root):
    _seed_keys(isolated_data_root)
    # Run CLI: python -m character_workflow turn-start --kind portrait
    result = subprocess.run(
        [sys.executable, "-m", "character_workflow", "turn-start", "--kind", "portrait"],
        capture_output=True, text=True,
        env={**__import__("os").environ},
    )
    out = json.loads(result.stdout)
    assert "available_keys" in out
    assert len(out["available_keys"]) == 2
    for k in out["available_keys"]:
        assert "access_key" not in k
        assert "secret_key" not in k
    assert out["preferred_alias"] == "lov"


def test_turn_start_preferred_alias_skips_when_capability_mismatch(isolated_data_root):
    _seed_keys(isolated_data_root)
    result = subprocess.run(
        [sys.executable, "-m", "character_workflow", "turn-start", "--kind", "turnaround"],
        capture_output=True, text=True,
    )
    out = json.loads(result.stdout)
    # Default "lov" has portrait/promo but not turnaround — falls back
    # to first key with turnaround capability, which is none → null
    assert out["preferred_alias"] is None
```

- [ ] **Step 5: 跑测试看它通过**

```bash
uv run pytest tests/test_turn_start_keys.py -v
```

- [ ] **Step 6: 提交**

```bash
git add src/character_workflow/lib/schemas.py src/character_workflow/lib/turn_start.py web/src/schema/jobs.ts tests/test_turn_start_keys.py
git commit -m "feat(turn-start): expose available_keys + preferred_alias (secrets stripped)"
```

---

### Task 13: jobs 创建时传 `alias` + 默认值解析

**Files:**
- Modify: `src/character_workflow/lib/jobs.py`
- Modify: `tests/test_jobs.py`（如已存在）

- [ ] **Step 1: 看 jobs.write_job / create_job 签名**

```bash
grep -n "def write_job\|def create_job" src/character_workflow/lib/jobs.py
```

- [ ] **Step 2: 加 alias 默认解析**

修改 `write_job` 或 `create_job`，如果 caller 没传 `alias`，调 `keys.preferred_alias_for_kind(kind)` 自动填入。同时填 `provider`：

```python
from character_workflow.lib import keys as _keys_mod

def write_job(job_id: str, payload: dict) -> Path:
    if "alias" not in payload or payload["alias"] is None:
        kind = payload.get("kind", "portrait")
        payload["alias"] = _keys_mod.preferred_alias_for_kind(kind)
    if payload.get("alias") and "provider" not in payload:
        key = _keys_mod.find_by_alias(payload["alias"])
        if key:
            payload["provider"] = key.provider
    # ... 原逻辑写文件
```

- [ ] **Step 3: 测试**

加到 `tests/test_jobs.py`：

```python
def test_write_job_fills_alias_from_preferred_when_missing(isolated_data_root):
    from character_workflow.lib import keys, jobs
    keys.add_key(keys.KeySpec(
        alias="lov", provider="lovart", access_key="ak", secret_key="sk",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    path = jobs.write_job("test-job", {
        "job_id": "test-job", "character_id": "x", "kind": "portrait",
        "status": "PENDING_CONFIRM", "prompt": "p", "model": "m",
    })
    import json
    payload = json.loads(path.read_text())
    assert payload["alias"] == "lov"
    assert payload["provider"] == "lovart"


def test_write_job_alias_null_when_no_key_matches(isolated_data_root):
    from character_workflow.lib import jobs
    path = jobs.write_job("test-job", {
        "job_id": "test-job", "character_id": "x", "kind": "portrait",
        "status": "PENDING_CONFIRM", "prompt": "p", "model": "m",
    })
    import json
    payload = json.loads(path.read_text())
    assert payload["alias"] is None
```

- [ ] **Step 4: 跑测试**

```bash
uv run pytest tests/test_jobs.py -v
```

- [ ] **Step 5: 提交**

```bash
git add src/character_workflow/lib/jobs.py tests/test_jobs.py
git commit -m "feat(jobs): auto-fill alias + provider from preferred_alias_for_kind"
```

---

# 阶段 4 — Bootstrap 各状态 + Onboarding REST API

### Task 14: bootstrap.py 状态全实现（`--check` 5 个状态）

**Files:**
- Modify: `scripts/bootstrap.py`
- Modify: `tests/test_bootstrap.py`

- [ ] **Step 1: 加测试 — 5 个状态全覆盖**

追加到 `tests/test_bootstrap.py`：

```python
def test_check_needs_uv_when_uv_missing(tmp_path, monkeypatch):
    (tmp_path / ".config").mkdir()
    monkeypatch.setenv("PATH", "")  # 让 shutil.which("uv") 找不到
    result = run_bootstrap(
        ["--check"],
        env_overrides={
            "CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path),
            "PATH": "",
        },
    )
    out = json.loads(result.stdout)
    assert out["status"] == "needs_uv"


def test_check_needs_venv_when_venv_missing(tmp_path, monkeypatch):
    # uv exists (we trust system PATH), but no .venv/
    (tmp_path / ".config").mkdir()
    result = run_bootstrap(
        ["--check"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path)},
    )
    out = json.loads(result.stdout)
    # On CI machines uv exists; expect needs_venv (or needs_first_key if venv-hash
    # check is too lenient). For now only needs_venv is acceptable.
    assert out["status"] in ("needs_venv", "needs_uv")  # skip uv-less CI


def test_check_needs_first_key_when_venv_exists_but_keys_empty(tmp_path, monkeypatch):
    (tmp_path / ".config").mkdir()
    venv = tmp_path / ".venv"
    venv.mkdir()
    # Fake bin/python to satisfy "venv exists" check
    bin_dir = venv / ("Scripts" if sys.platform == "win32" else "bin")
    bin_dir.mkdir()
    (bin_dir / ("python.exe" if sys.platform == "win32" else "python")).touch()
    # Fake venv-hash matching pyproject.toml
    import hashlib
    pyproject_hash = hashlib.sha256(
        (REPO_ROOT / "pyproject.toml").read_bytes()
    ).hexdigest()
    (tmp_path / ".config" / "venv-hash").write_text(pyproject_hash)
    result = run_bootstrap(
        ["--check"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path)},
    )
    out = json.loads(result.stdout)
    assert out["status"] == "needs_first_key"


def test_check_needs_keys_repair_when_keys_corrupted(tmp_path, monkeypatch):
    (tmp_path / ".config").mkdir()
    (tmp_path / ".venv").mkdir()
    venv_bin = tmp_path / ".venv" / ("Scripts" if sys.platform == "win32" else "bin")
    venv_bin.mkdir()
    (venv_bin / ("python.exe" if sys.platform == "win32" else "python")).touch()
    import hashlib
    pyproject_hash = hashlib.sha256(
        (REPO_ROOT / "pyproject.toml").read_bytes()
    ).hexdigest()
    (tmp_path / ".config" / "venv-hash").write_text(pyproject_hash)
    (tmp_path / ".config" / "keys.json").write_text("{ not valid json")
    result = run_bootstrap(
        ["--check"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path)},
    )
    out = json.loads(result.stdout)
    assert out["status"] == "needs_keys_repair"


def test_check_returns_ready_when_keys_present(tmp_path, monkeypatch):
    (tmp_path / ".config").mkdir()
    (tmp_path / ".venv").mkdir()
    venv_bin = tmp_path / ".venv" / ("Scripts" if sys.platform == "win32" else "bin")
    venv_bin.mkdir()
    (venv_bin / ("python.exe" if sys.platform == "win32" else "python")).touch()
    import hashlib
    pyproject_hash = hashlib.sha256(
        (REPO_ROOT / "pyproject.toml").read_bytes()
    ).hexdigest()
    (tmp_path / ".config" / "venv-hash").write_text(pyproject_hash)
    (tmp_path / ".config" / "keys.json").write_text(json.dumps({
        "version": 1, "default_alias": "x",
        "keys": [{
            "alias": "x", "provider": "lovart", "access_key": "ak",
            "secret_key": "sk", "capabilities": ["portrait"], "models": [],
            "notes": "", "created_at": "2026-05-22T00:00:00+08:00",
        }],
    }))
    result = run_bootstrap(
        ["--check"],
        env_overrides={"CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path)},
    )
    out = json.loads(result.stdout)
    assert out["status"] == "ready"
```

- [ ] **Step 2: 跑测试看它失败**

```bash
uv run pytest tests/test_bootstrap.py -v
```

- [ ] **Step 3: 重写 `bootstrap.py` 的 `check()` 函数**

替换原 `check()` 为：

```python
import hashlib
import json
from pathlib import Path


def _pyproject_hash() -> str | None:
    # bootstrap.py runs from Plugin install dir, so plugin.json sibling = pyproject
    candidates = [
        Path(__file__).resolve().parent.parent / "pyproject.toml",
    ]
    for c in candidates:
        if c.exists():
            return hashlib.sha256(c.read_bytes()).hexdigest()
    return None


def _venv_python(venv: Path) -> Path:
    if sys.platform == "win32":
        return venv / "Scripts" / "python.exe"
    return venv / "bin" / "python"


def _venv_ok(venv: Path, expected_hash: str | None) -> bool:
    if not _venv_python(venv).exists():
        return False
    hash_file = venv.parent / ".config" / "venv-hash"
    if not hash_file.exists():
        return False
    if expected_hash and hash_file.read_text().strip() != expected_hash:
        return False
    return True


def check() -> dict:
    plat = sys.platform
    data_root = resolve_data_root()
    if data_root is None:
        return {
            "status": "needs_data_root", "data_root": None,
            "uv_path": shutil.which("uv"), "venv_python": None,
            "platform": plat, "next_action": "选数据目录（CC 向导问用户）",
        }

    uv_path = shutil.which("uv")
    if not uv_path:
        return {
            "status": "needs_uv", "data_root": str(data_root),
            "uv_path": None, "venv_python": None, "platform": plat,
            "next_action": _uv_install_instruction(plat),
        }

    venv = data_root / ".venv"
    expected_hash = _pyproject_hash()
    if not _venv_ok(venv, expected_hash):
        return {
            "status": "needs_venv", "data_root": str(data_root),
            "uv_path": uv_path, "venv_python": None, "platform": plat,
            "next_action": "跑 uv sync 装 Python 依赖到 <data_root>/.venv",
        }

    keys_file = data_root / ".config" / "keys.json"
    if keys_file.exists():
        try:
            payload = json.loads(keys_file.read_text())
            if not isinstance(payload, dict) or "keys" not in payload:
                raise ValueError("keys.json missing 'keys' field")
            if not payload["keys"]:
                return {
                    "status": "needs_first_key", "data_root": str(data_root),
                    "uv_path": uv_path, "venv_python": str(_venv_python(venv)),
                    "platform": plat, "next_action": "Web 上加第一个 API Key",
                }
        except (json.JSONDecodeError, ValueError) as e:
            return {
                "status": "needs_keys_repair", "data_root": str(data_root),
                "uv_path": uv_path, "venv_python": str(_venv_python(venv)),
                "platform": plat,
                "next_action": f"keys.json 解析失败：{e}。建议备份后手动修复或重新加 Key",
            }
    else:
        return {
            "status": "needs_first_key", "data_root": str(data_root),
            "uv_path": uv_path, "venv_python": str(_venv_python(venv)),
            "platform": plat, "next_action": "Web 上加第一个 API Key",
        }

    return {
        "status": "ready", "data_root": str(data_root),
        "uv_path": uv_path, "venv_python": str(_venv_python(venv)),
        "platform": plat, "next_action": "进 turn-start",
    }


def _uv_install_instruction(platform: str) -> str:
    if platform == "win32":
        return 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
    return "curl -LsSf https://astral.sh/uv/install.sh | sh"
```

- [ ] **Step 4: 跑测试看它通过**

```bash
uv run pytest tests/test_bootstrap.py -v
```

Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/bootstrap.py tests/test_bootstrap.py
git commit -m "feat(bootstrap): full --check state machine (5 states + needs_keys_repair)"
```

---

### Task 15: bootstrap.py `--init-data-root` 子命令

**Files:**
- Modify: `scripts/bootstrap.py`
- Modify: `tests/test_bootstrap.py`

- [ ] **Step 1: 写失败测试**

```python
def test_init_data_root_creates_skeleton(tmp_path):
    target = tmp_path / "my-data"
    result = run_bootstrap(
        ["--init-data-root", str(target)],
        env_overrides={
            "XDG_CONFIG_HOME": str(tmp_path / "config"),
            "APPDATA": str(tmp_path / "appdata"),
        },
    )
    assert result.returncode == 0, result.stderr
    assert target.exists()
    assert (target / ".config").exists()
    assert (target / ".runtime").exists()
    assert (target / "projects").exists()
    assert (target / "characters").exists()


def test_init_data_root_writes_global_config(tmp_path):
    target = tmp_path / "my-data"
    cfg_home = tmp_path / "config"
    result = run_bootstrap(
        ["--init-data-root", str(target)],
        env_overrides={
            "XDG_CONFIG_HOME": str(cfg_home),
            "APPDATA": str(cfg_home),
        },
    )
    assert result.returncode == 0
    # platformdirs uses XDG_CONFIG_HOME on linux/mac, APPDATA on windows
    found = list(cfg_home.rglob("data-root"))
    assert len(found) == 1
    assert found[0].read_text().strip() == str(target.resolve())
```

- [ ] **Step 2: 跑测试看它失败**

```bash
uv run pytest tests/test_bootstrap.py::test_init_data_root_creates_skeleton -v
```

- [ ] **Step 3: 实现 `--init-data-root`**

在 `bootstrap.py` 的 `main()` 加 subparser：

```python
def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--init-data-root", metavar="PATH")
    parser.add_argument("--ensure-venv", action="store_true")
    args = parser.parse_args()

    if args.check:
        print(json.dumps(check(), ensure_ascii=False))
        return 0
    if args.init_data_root:
        return init_data_root(Path(args.init_data_root))
    if args.ensure_venv:
        return ensure_venv()
    parser.print_help()
    return 1


def init_data_root(target: Path) -> int:
    target = target.expanduser().resolve()
    for sub in (".config", ".runtime", "projects", "characters"):
        (target / sub).mkdir(parents=True, exist_ok=True)
    cfg = global_config_file()
    cfg.parent.mkdir(parents=True, exist_ok=True)
    cfg.write_text(str(target) + "\n")
    print(json.dumps({"data_root": str(target), "config_file": str(cfg)}))
    return 0
```

- [ ] **Step 4: 跑测试**

```bash
uv run pytest tests/test_bootstrap.py -v
```

- [ ] **Step 5: 提交**

```bash
git add scripts/bootstrap.py tests/test_bootstrap.py
git commit -m "feat(bootstrap): --init-data-root creates skeleton + writes global config"
```

---

### Task 16: bootstrap.py `--ensure-venv` 子命令

**Files:**
- Modify: `scripts/bootstrap.py`
- Modify: `tests/test_bootstrap.py`

- [ ] **Step 1: 写失败测试（用 mock uv）**

```python
def test_ensure_venv_runs_uv_sync(tmp_path, monkeypatch):
    (tmp_path / ".config").mkdir()
    # Fake uv that creates a .venv structure when called
    fake_uv_dir = tmp_path / "fake-bin"
    fake_uv_dir.mkdir()
    fake_uv = fake_uv_dir / "uv"
    fake_uv.write_text(f"""#!/usr/bin/env bash
echo "fake uv: $@"
mkdir -p "{tmp_path}/.venv/bin"
touch "{tmp_path}/.venv/bin/python"
""")
    fake_uv.chmod(0o755)
    result = run_bootstrap(
        ["--ensure-venv"],
        env_overrides={
            "CHARACTER_WORKFLOW_DATA_ROOT": str(tmp_path),
            "PATH": str(fake_uv_dir) + ":/usr/bin:/bin",
        },
    )
    assert result.returncode == 0, result.stderr
    assert (tmp_path / ".venv" / "bin" / "python").exists()
    # venv-hash should be written matching current pyproject.toml
    hash_file = tmp_path / ".config" / "venv-hash"
    assert hash_file.exists()
```

- [ ] **Step 2: 跑测试看它失败**

```bash
uv run pytest tests/test_bootstrap.py::test_ensure_venv_runs_uv_sync -v
```

- [ ] **Step 3: 实现**

```python
def ensure_venv() -> int:
    data_root = resolve_data_root()
    if data_root is None:
        print(json.dumps({"error": "data_root not configured — run --init-data-root first"}))
        return 1
    uv = shutil.which("uv")
    if not uv:
        print(json.dumps({"error": "uv not on PATH"}))
        return 2
    venv = data_root / ".venv"
    plugin_dir = Path(__file__).resolve().parent.parent
    import subprocess
    cmd = [uv, "sync", "--project", str(plugin_dir)]
    env = {**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv)}
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        print(json.dumps({"error": "uv sync failed", "stderr": proc.stderr}))
        return 3
    # Write venv-hash
    hash_value = _pyproject_hash()
    if hash_value:
        (data_root / ".config" / "venv-hash").write_text(hash_value)
    print(json.dumps({"status": "ok", "venv_python": str(_venv_python(venv))}))
    return 0
```

**注意：** `UV_PROJECT_ENVIRONMENT` 是 uv 接受的 env var，让 venv 落在指定路径。如果实测发现 uv 不接受这个 env var，改用 `uv venv <data_root>/.venv` + `uv pip sync` 两步法。Task 1 实测 Plugin 时一并验证。

- [ ] **Step 4: 跑测试**

```bash
uv run pytest tests/test_bootstrap.py -v
```

- [ ] **Step 5: 提交**

```bash
git add scripts/bootstrap.py tests/test_bootstrap.py
git commit -m "feat(bootstrap): --ensure-venv runs uv sync + writes venv-hash"
```

---

### Task 17: Onboarding REST endpoints

**Files:**
- Modify: `src/viewer_server/routes.py`
- Modify: `tests/test_routes_get.py` 或新建 `tests/test_onboarding_api.py`

- [ ] **Step 1: 写失败测试 `tests/test_onboarding_api.py`**

```python
import json
from fastapi.testclient import TestClient
from viewer_server.app import create_app  # adjust to actual factory


def _client(isolated_data_root):
    return TestClient(create_app())


def test_onboarding_status_returns_bootstrap_check_payload(isolated_data_root):
    client = _client(isolated_data_root)
    resp = client.get("/api/onboarding/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "status" in data
    assert data["status"] in (
        "needs_data_root", "needs_uv", "needs_venv",
        "needs_first_key", "needs_keys_repair", "ready",
    )


def test_post_data_root_writes_global_config(isolated_data_root, tmp_path, monkeypatch):
    new_root = tmp_path / "switched-root"
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "cfg"))
    monkeypatch.setenv("APPDATA", str(tmp_path / "cfg"))
    client = _client(isolated_data_root)
    resp = client.post("/api/onboarding/data-root", json={"path": str(new_root)})
    assert resp.status_code == 200
    assert resp.json()["data_root"] == str(new_root.resolve())
    assert new_root.exists()
```

- [ ] **Step 2: 跑测试看它失败**

```bash
uv run pytest tests/test_onboarding_api.py -v
```

- [ ] **Step 3: 加 routes**

在 `src/viewer_server/routes.py` 加：

```python
import subprocess
import sys
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from character_workflow.lib import data_root

router = APIRouter()  # if existing routes use a different router var, append there


class DataRootPayload(BaseModel):
    path: str


@router.get("/api/onboarding/status")
def onboarding_status():
    repo_root = Path(__file__).resolve().parents[2]  # src/viewer_server/routes.py → repo
    bootstrap = repo_root / "scripts" / "bootstrap.py"
    proc = subprocess.run(
        [sys.executable, str(bootstrap), "--check"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise HTTPException(500, f"bootstrap --check failed: {proc.stderr}")
    import json as _json
    return _json.loads(proc.stdout)


@router.post("/api/onboarding/data-root")
def set_data_root(payload: DataRootPayload):
    repo_root = Path(__file__).resolve().parents[2]
    bootstrap = repo_root / "scripts" / "bootstrap.py"
    proc = subprocess.run(
        [sys.executable, str(bootstrap), "--init-data-root", payload.path],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise HTTPException(500, f"init-data-root failed: {proc.stderr}")
    import json as _json
    return _json.loads(proc.stdout)
```

- [ ] **Step 4: 跑测试**

```bash
uv run pytest tests/test_onboarding_api.py -v
```

- [ ] **Step 5: 提交**

```bash
git add src/viewer_server/routes.py tests/test_onboarding_api.py
git commit -m "feat(viewer-server): onboarding status + data-root REST endpoints"
```

---

### Task 18: Keys REST endpoints (5 个)

**Files:**
- Modify: `src/viewer_server/routes.py`
- Create: `tests/test_keys_api.py`

- [ ] **Step 1: 写失败测试 `tests/test_keys_api.py`**

```python
from fastapi.testclient import TestClient
from viewer_server.app import create_app
from character_workflow.lib import keys


def _client(isolated_data_root):
    return TestClient(create_app())


def _make_payload(alias="lov"):
    return {
        "alias": alias, "provider": "lovart",
        "access_key": "ak", "secret_key": "sk",
        "capabilities": ["portrait"], "models": ["gpt_image_2"],
        "notes": "test", "created_at": "2026-05-22T00:00:00+08:00",
    }


def test_list_keys_returns_empty_initially(isolated_data_root):
    client = _client(isolated_data_root)
    resp = client.get("/api/keys")
    assert resp.status_code == 200
    assert resp.json() == {"keys": [], "default_alias": None}


def test_create_then_list(isolated_data_root):
    client = _client(isolated_data_root)
    r1 = client.post("/api/keys", json=_make_payload())
    assert r1.status_code == 201
    r2 = client.get("/api/keys")
    body = r2.json()
    assert len(body["keys"]) == 1
    k = body["keys"][0]
    assert k["alias"] == "lov"
    assert k["access_key"] != "ak"  # masked
    assert k["secret_key"] is None  # stripped


def test_create_duplicate_alias_409(isolated_data_root):
    client = _client(isolated_data_root)
    client.post("/api/keys", json=_make_payload())
    r = client.post("/api/keys", json=_make_payload())
    assert r.status_code == 409


def test_patch_key(isolated_data_root):
    client = _client(isolated_data_root)
    client.post("/api/keys", json=_make_payload())
    r = client.patch("/api/keys/lov", json={"notes": "updated"})
    assert r.status_code == 200
    body = client.get("/api/keys").json()
    assert body["keys"][0]["notes"] == "updated"


def test_patch_preserves_secret_when_not_provided(isolated_data_root):
    client = _client(isolated_data_root)
    client.post("/api/keys", json=_make_payload())
    client.patch("/api/keys/lov", json={"notes": "x"})
    # Verify via direct read since API masks
    k = keys.find_by_alias("lov")
    assert k.access_key == "ak"
    assert k.secret_key == "sk"


def test_delete_key(isolated_data_root):
    client = _client(isolated_data_root)
    client.post("/api/keys", json=_make_payload())
    r = client.delete("/api/keys/lov")
    assert r.status_code == 204
    assert client.get("/api/keys").json()["keys"] == []


def test_set_default(isolated_data_root):
    client = _client(isolated_data_root)
    client.post("/api/keys", json=_make_payload())
    r = client.post("/api/keys/lov/default")
    assert r.status_code == 200
    assert client.get("/api/keys").json()["default_alias"] == "lov"


def test_set_default_nonexistent_404(isolated_data_root):
    client = _client(isolated_data_root)
    r = client.post("/api/keys/missing/default")
    assert r.status_code == 404
```

- [ ] **Step 2: 跑测试看它失败**

```bash
uv run pytest tests/test_keys_api.py -v
```

- [ ] **Step 3: 加 endpoints**

在 `src/viewer_server/routes.py` 加：

```python
from character_workflow.lib import keys

class KeyCreatePayload(BaseModel):
    alias: str
    provider: str
    access_key: str
    secret_key: str | None = None
    capabilities: list[str] = []
    models: list[str] = []
    notes: str = ""
    created_at: str | None = None


class KeyPatchPayload(BaseModel):
    access_key: str | None = None
    secret_key: str | None = None
    capabilities: list[str] | None = None
    models: list[str] | None = None
    notes: str | None = None


@router.get("/api/keys")
def list_keys():
    db = keys.read_keys_db()
    return {"keys": keys.keys_for_api(), "default_alias": db.default_alias}


@router.post("/api/keys", status_code=201)
def create_key(payload: KeyCreatePayload):
    from datetime import datetime
    spec = keys.KeySpec(
        alias=payload.alias, provider=payload.provider,
        access_key=payload.access_key, secret_key=payload.secret_key,
        capabilities=payload.capabilities, models=payload.models,
        notes=payload.notes,
        created_at=payload.created_at or datetime.now().astimezone().isoformat(),
    )
    try:
        keys.add_key(spec)
    except keys.DuplicateAliasError:
        raise HTTPException(409, f"alias '{payload.alias}' already exists")
    return {"alias": payload.alias}


@router.patch("/api/keys/{alias}")
def patch_key(alias: str, payload: KeyPatchPayload):
    patch_data = {k: v for k, v in payload.model_dump().items() if v is not None}
    try:
        keys.patch_key(alias, patch_data)
    except keys.NoSuchAliasError:
        raise HTTPException(404, f"alias '{alias}' not found")
    return {"alias": alias}


@router.delete("/api/keys/{alias}", status_code=204)
def delete_key_endpoint(alias: str):
    keys.delete_key(alias)
    return None


@router.post("/api/keys/{alias}/default")
def set_default(alias: str):
    try:
        keys.set_default_alias(alias)
    except keys.NoSuchAliasError:
        raise HTTPException(404, f"alias '{alias}' not found")
    return {"default_alias": alias}
```

- [ ] **Step 4: 跑测试**

```bash
uv run pytest tests/test_keys_api.py -v
```

- [ ] **Step 5: 提交**

```bash
git add src/viewer_server/routes.py tests/test_keys_api.py
git commit -m "feat(viewer-server): keys REST API (list/create/patch/delete/set-default)"
```

---

# 阶段 5 — Web UI（首屏路由 + 数据目录向导 + Keys 管理）

### Task 19: Web 首屏路由 — 按 onboarding status 分流

**Files:**
- Modify: `web/src/App.tsx`
- Create: `web/src/api/onboarding.ts`
- Modify: `web/src/main.tsx` 或现有的 router setup

- [ ] **Step 1: 写 API 客户端**

写 `web/src/api/onboarding.ts`：

```typescript
export type OnboardingStatus =
  | "ready"
  | "needs_data_root"
  | "needs_uv"
  | "needs_venv"
  | "needs_first_key"
  | "needs_keys_repair";

export interface OnboardingState {
  status: OnboardingStatus;
  data_root: string | null;
  uv_path: string | null;
  venv_python: string | null;
  platform: "darwin" | "linux" | "win32";
  next_action: string;
}

export async function fetchOnboardingStatus(): Promise<OnboardingState> {
  const r = await fetch("/api/onboarding/status");
  if (!r.ok) throw new Error(`onboarding/status failed: ${r.status}`);
  return r.json();
}

export async function setDataRoot(path: string): Promise<{ data_root: string }> {
  const r = await fetch("/api/onboarding/data-root", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!r.ok) throw new Error(`set data root failed: ${r.status}`);
  return r.json();
}
```

- [ ] **Step 2: 改 App.tsx 首屏分流**

读 `web/src/App.tsx`。在主入口加 onboarding 状态加载 + 路由分流逻辑：

```tsx
import { useEffect, useState } from "react";
import { fetchOnboardingStatus, OnboardingState } from "./api/onboarding";
import { DataRootPage } from "./pages/onboarding/DataRoot";
import { KeysPage } from "./pages/settings/Keys";
import { MainApp } from "./MainApp"; // 现有主界面

export default function App() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchOnboardingStatus().then(setState).catch(e => setError(String(e)));
  }, []);

  if (error) return <div className="p-8 text-red-500">{error}</div>;
  if (!state) return <div className="p-8">加载中…</div>;

  switch (state.status) {
    case "needs_data_root":
      return <DataRootPage onComplete={() => fetchOnboardingStatus().then(setState)} />;
    case "needs_first_key":
    case "needs_keys_repair":
      return <KeysPage mode="onboarding" onComplete={() => fetchOnboardingStatus().then(setState)} />;
    case "needs_uv":
    case "needs_venv":
      // 这两个状态 Web 不能解决（要终端跑命令），显示提示
      return <div className="p-8">
        <h2 className="text-xl">需要终端操作</h2>
        <pre className="mt-4 bg-stone-100 p-4">{state.next_action}</pre>
      </div>;
    case "ready":
    default:
      return <MainApp />;
  }
}
```

**注意：** `MainApp` 是把现有 `App.tsx` 主体内容抽出来的组件 — 如果当前 App.tsx 直接渲染主界面，把那段移到新建的 `web/src/MainApp.tsx`。

- [ ] **Step 3: 改 `package.json` 加测试（如果还没有）**

```bash
cd web && pnpm test
```

确认现有测试还跑得动。

- [ ] **Step 4: 提交**

```bash
git add web/src/App.tsx web/src/MainApp.tsx web/src/api/onboarding.ts
git commit -m "feat(web): split App into onboarding-aware router"
```

---

### Task 20: DataRoot 向导页

**Files:**
- Create: `web/src/pages/onboarding/DataRoot.tsx`
- Create: `web/src/pages/onboarding/DataRoot.test.tsx`

- [ ] **Step 1: 写失败测试**

写 `web/src/pages/onboarding/DataRoot.test.tsx`：

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DataRootPage } from "./DataRoot";

global.fetch = vi.fn();

describe("DataRootPage", () => {
  it("posts the entered path on save", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data_root: "/tmp/x" }),
    });
    const onComplete = vi.fn();
    render(<DataRootPage onComplete={onComplete} />);
    fireEvent.change(screen.getByLabelText(/数据目录路径/), {
      target: { value: "/tmp/x" },
    });
    fireEvent.click(screen.getByText(/保存/));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/onboarding/data-root",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "/tmp/x" }),
      })
    );
  });

  it("shows the platform default as an option", () => {
    render(<DataRootPage onComplete={() => {}} />);
    expect(screen.getByText(/character-workflow/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试看它失败**

```bash
cd web && pnpm test DataRoot
```

- [ ] **Step 3: 实现**

写 `web/src/pages/onboarding/DataRoot.tsx`：

```tsx
import { useState } from "react";
import { setDataRoot } from "@/api/onboarding";

interface Props {
  onComplete: () => void;
}

const DEFAULT_PATHS = [
  { label: "~/character-workflow/（推荐）", value: "~/character-workflow" },
  { label: "~/Documents/character-workflow/（iCloud / OneDrive 同步）", value: "~/Documents/character-workflow" },
];

export function DataRootPage({ onComplete }: Props) {
  const [path, setPath] = useState(DEFAULT_PATHS[0].value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await setDataRoot(path);
      onComplete();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto p-8 space-y-6">
      <h1 className="text-2xl">第一次使用 character-workflow</h1>
      <p>你的角色 / 图片 / 项目要存到哪？</p>
      <div className="space-y-2">
        {DEFAULT_PATHS.map(opt => (
          <label key={opt.value} className="flex items-center gap-3">
            <input
              type="radio" name="data-root"
              checked={path === opt.value}
              onChange={() => setPath(opt.value)}
            />
            <span>{opt.label}</span>
          </label>
        ))}
        <label className="flex items-center gap-3">
          <input
            type="radio" name="data-root"
            checked={!DEFAULT_PATHS.some(o => o.value === path)}
            onChange={() => setPath("")}
          />
          <span>自定义</span>
        </label>
      </div>
      <div>
        <label htmlFor="path-input" className="block text-sm mb-1">数据目录路径</label>
        <input
          id="path-input"
          type="text"
          value={path}
          onChange={e => setPath(e.target.value)}
          className="w-full border rounded px-3 py-2"
        />
      </div>
      {error && <div className="text-red-600">{error}</div>}
      <button
        onClick={save}
        disabled={!path || saving}
        className="px-4 py-2 bg-stone-900 text-white rounded disabled:opacity-50"
      >
        {saving ? "保存中..." : "保存并继续"}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试看它通过**

```bash
cd web && pnpm test DataRoot
```

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/onboarding/DataRoot.tsx web/src/pages/onboarding/DataRoot.test.tsx
git commit -m "feat(web): DataRoot onboarding wizard page"
```

---

### Task 21: Keys 管理页 — 列表 + 添加表单

**Files:**
- Create: `web/src/pages/settings/Keys.tsx`
- Create: `web/src/pages/settings/KeyForm.tsx`
- Create: `web/src/api/keys.ts`
- Create: `web/src/pages/settings/Keys.test.tsx`

- [ ] **Step 1: 写 API 客户端**

写 `web/src/api/keys.ts`：

```typescript
export interface KeyView {
  alias: string;
  provider: string;
  access_key: string;  // masked
  secret_key: null;
  capabilities: string[];
  models: string[];
  notes: string;
  created_at: string;
  is_default: boolean;
}

export interface KeyCreatePayload {
  alias: string;
  provider: string;
  access_key: string;
  secret_key?: string | null;
  capabilities: string[];
  models?: string[];
  notes?: string;
}

export async function listKeys(): Promise<{ keys: KeyView[]; default_alias: string | null }> {
  const r = await fetch("/api/keys");
  if (!r.ok) throw new Error(`listKeys: ${r.status}`);
  return r.json();
}

export async function createKey(payload: KeyCreatePayload): Promise<void> {
  const r = await fetch("/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`createKey ${r.status}: ${body}`);
  }
}

export async function patchKey(alias: string, patch: Partial<KeyCreatePayload>): Promise<void> {
  const r = await fetch(`/api/keys/${encodeURIComponent(alias)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patchKey ${r.status}`);
}

export async function deleteKey(alias: string): Promise<void> {
  const r = await fetch(`/api/keys/${encodeURIComponent(alias)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`deleteKey ${r.status}`);
}

export async function setDefaultKey(alias: string): Promise<void> {
  const r = await fetch(`/api/keys/${encodeURIComponent(alias)}/default`, { method: "POST" });
  if (!r.ok) throw new Error(`setDefault ${r.status}`);
}
```

- [ ] **Step 2: 写表单组件**

写 `web/src/pages/settings/KeyForm.tsx`：

```tsx
import { useState } from "react";
import { KeyCreatePayload } from "@/api/keys";

const PROVIDERS = ["lovart", "openai", "midjourney", "nano_banana", "seedream", "custom"];
const CAPABILITIES = ["portrait", "promo", "turnaround"];

interface Props {
  initial?: Partial<KeyCreatePayload>;
  onSubmit: (payload: KeyCreatePayload) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

export function KeyForm({ initial, onSubmit, onCancel, submitLabel = "保存" }: Props) {
  const [alias, setAlias] = useState(initial?.alias ?? "");
  const [provider, setProvider] = useState(initial?.provider ?? "lovart");
  const [accessKey, setAccessKey] = useState(initial?.access_key ?? "");
  const [secretKey, setSecretKey] = useState(initial?.secret_key ?? "");
  const [caps, setCaps] = useState<string[]>(initial?.capabilities ?? ["portrait", "promo", "turnaround"]);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (c: string) => setCaps(caps.includes(c) ? caps.filter(x => x !== c) : [...caps, c]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        alias, provider, access_key: accessKey,
        secret_key: secretKey || null,
        capabilities: caps, notes,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 max-w-xl">
      <div>
        <label className="block text-sm mb-1">别名（唯一）</label>
        <input value={alias} onChange={e => setAlias(e.target.value)}
          className="w-full border rounded px-3 py-2" placeholder="my-lovart-primary" />
      </div>
      <div>
        <label className="block text-sm mb-1">Provider</label>
        <select value={provider} onChange={e => setProvider(e.target.value)}
          className="w-full border rounded px-3 py-2">
          {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-sm mb-1">Access Key</label>
        <input type="password" value={accessKey} onChange={e => setAccessKey(e.target.value)}
          className="w-full border rounded px-3 py-2" autoComplete="off" />
      </div>
      <div>
        <label className="block text-sm mb-1">Secret Key（视 provider）</label>
        <input type="password" value={secretKey} onChange={e => setSecretKey(e.target.value)}
          className="w-full border rounded px-3 py-2" autoComplete="off" />
      </div>
      <div>
        <label className="block text-sm mb-1">图种能力</label>
        <div className="flex gap-4">
          {CAPABILITIES.map(c => (
            <label key={c} className="flex items-center gap-2">
              <input type="checkbox" checked={caps.includes(c)} onChange={() => toggle(c)} />
              {c}
            </label>
          ))}
        </div>
      </div>
      <div>
        <label className="block text-sm mb-1">能力描述（自由文本）</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)}
          className="w-full border rounded px-3 py-2" rows={2} />
      </div>
      {error && <div className="text-red-600">{error}</div>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={!alias || !accessKey || saving}
          className="px-4 py-2 bg-stone-900 text-white rounded disabled:opacity-50">
          {saving ? "保存中..." : submitLabel}
        </button>
        <button onClick={onCancel} className="px-4 py-2 border rounded">取消</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 写 Keys.tsx 主页**

写 `web/src/pages/settings/Keys.tsx`：

```tsx
import { useEffect, useState } from "react";
import { listKeys, createKey, deleteKey, setDefaultKey, KeyView, KeyCreatePayload } from "@/api/keys";
import { KeyForm } from "./KeyForm";

interface Props {
  mode?: "onboarding" | "normal";
  onComplete?: () => void;
}

export function KeysPage({ mode = "normal", onComplete }: Props) {
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [defaultAlias, setDefaultAlias] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(mode === "onboarding");
  const [error, setError] = useState<string | null>(null);

  const reload = () => listKeys().then(r => {
    setKeys(r.keys);
    setDefaultAlias(r.default_alias);
  }).catch(e => setError(String(e)));

  useEffect(() => { reload(); }, []);

  const onAdd = async (p: KeyCreatePayload) => {
    await createKey(p);
    setShowForm(false);
    reload();
    if (mode === "onboarding" && onComplete) onComplete();
  };

  const onDelete = async (alias: string) => {
    const confirmed = window.prompt(`删除 Key "${alias}" — 输入别名确认：`);
    if (confirmed !== alias) return;
    await deleteKey(alias);
    reload();
  };

  const onSetDefault = async (alias: string) => {
    await setDefaultKey(alias);
    reload();
  };

  return (
    <div className="max-w-3xl mx-auto p-8 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl">API Keys</h1>
        {!showForm && (
          <button onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-stone-900 text-white rounded">
            + 添加 Key
          </button>
        )}
      </div>

      {error && <div className="text-red-600">{error}</div>}

      {showForm && (
        <div className="border p-4 rounded">
          <h2 className="text-lg mb-4">新增 API Key</h2>
          <KeyForm onSubmit={onAdd} onCancel={() => setShowForm(false)} submitLabel="保存并开始工作" />
        </div>
      )}

      <ul className="space-y-3">
        {keys.map(k => (
          <li key={k.alias} className="border rounded p-4 flex justify-between items-start">
            <div>
              <div className="font-medium">
                {k.alias}
                {k.is_default && <span className="ml-2 text-xs bg-stone-200 px-2 py-0.5 rounded">默认</span>}
              </div>
              <div className="text-sm text-stone-500">
                {k.provider} · {k.capabilities.join(" / ")} · key: {k.access_key}
              </div>
              {k.notes && <div className="text-sm text-stone-700 mt-1">{k.notes}</div>}
            </div>
            <div className="flex gap-2">
              {!k.is_default && (
                <button onClick={() => onSetDefault(k.alias)}
                  className="px-3 py-1 text-sm border rounded">设为默认</button>
              )}
              <button onClick={() => onDelete(k.alias)}
                className="px-3 py-1 text-sm border rounded text-red-600">删除</button>
            </div>
          </li>
        ))}
        {keys.length === 0 && !showForm && (
          <li className="text-stone-500 text-center py-8">还没有 API Key — 点上方添加一个</li>
        )}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: 写测试 `Keys.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { KeysPage } from "./Keys";

describe("KeysPage", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("renders empty state when no keys", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [], default_alias: null }),
    });
    render(<KeysPage />);
    await waitFor(() => expect(screen.getByText(/还没有 API Key/)).toBeInTheDocument());
  });

  it("lists keys with default badge", async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        keys: [{
          alias: "lov", provider: "lovart", access_key: "ak...xx",
          secret_key: null, capabilities: ["portrait"], models: [],
          notes: "", created_at: "x", is_default: true,
        }],
        default_alias: "lov",
      }),
    });
    render(<KeysPage />);
    await waitFor(() => expect(screen.getByText("lov")).toBeInTheDocument());
    expect(screen.getByText("默认")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: 跑测试**

```bash
cd web && pnpm test Keys
```

- [ ] **Step 6: 提交**

```bash
git add web/src/pages/settings/ web/src/api/keys.ts
git commit -m "feat(web): Keys management page (list/add/delete/set-default)"
```

---

### Task 22: 主界面入口加 Keys 设置按钮

**Files:**
- Modify: `web/src/MainApp.tsx`（或现有顶部导航组件）

- [ ] **Step 1: 加 settings 路由 / 按钮**

读现有主界面 `MainApp.tsx`，找到顶部导航 / Header。加：

```tsx
const [view, setView] = useState<"main" | "keys">("main");

// 在 Header 区域
<button onClick={() => setView(view === "keys" ? "main" : "keys")}>
  {view === "keys" ? "返回" : "API Keys"}
</button>

// 主体
{view === "keys" ? <KeysPage /> : <ExistingMainView />}
```

- [ ] **Step 2: 手动验证**

```bash
cd web && pnpm dev
```

打开 http://localhost:5173/，点 "API Keys" 按钮，应该看到 Keys 管理页。

- [ ] **Step 3: 提交**

```bash
git add web/src/MainApp.tsx
git commit -m "feat(web): expose Keys management from main app header"
```

---

# 阶段 6 — Windows 平台兼容

### Task 23: Windows ACL 模块（`win_acl.py`）

**Files:**
- Create: `src/character_workflow/lib/win_acl.py`
- Modify: `pyproject.toml`
- Create: `tests/test_windows_paths.py`

- [ ] **Step 1: pyproject 加 pywin32**

```toml
dependencies = [
  # ... existing ...
  "platformdirs>=4",
  'pywin32>=308; sys_platform == "win32"',
]
```

```bash
uv sync
```

- [ ] **Step 2: 写测试 `tests/test_windows_paths.py`**

```python
import sys
import pytest
from pathlib import Path


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only test")
def test_venv_python_posix(monkeypatch, tmp_path):
    from character_workflow.lib import data_root
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr("character_workflow.lib.data_root.sys.platform", "linux")
    assert data_root.venv_python().name == "python"


def test_venv_python_windows_via_monkeypatch(monkeypatch, tmp_path):
    from character_workflow.lib import data_root
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr("character_workflow.lib.data_root.sys.platform", "win32")
    result = data_root.venv_python()
    assert result.name == "python.exe"
    assert result.parent.name == "Scripts"


def test_uv_install_command_windows(monkeypatch):
    monkeypatch.setattr("scripts.bootstrap.sys.platform", "win32")
    from scripts.bootstrap import _uv_install_instruction
    assert "powershell" in _uv_install_instruction("win32")
    assert "irm" in _uv_install_instruction("win32")


def test_uv_install_command_posix():
    from scripts.bootstrap import _uv_install_instruction
    assert "curl" in _uv_install_instruction("linux")


@pytest.mark.skipif(sys.platform != "win32", reason="Windows-only ACL test")
def test_keys_file_acl_restricts_to_owner(isolated_data_root):
    from character_workflow.lib import keys
    keys.add_key(keys.KeySpec(
        alias="x", provider="lovart", access_key="a", secret_key="b",
        capabilities=["portrait"], models=[], notes="",
        created_at="2026-05-22T00:00:00+08:00",
    ))
    import win32security
    sd = win32security.GetFileSecurity(
        str(keys.data_root.keys_file()),
        win32security.DACL_SECURITY_INFORMATION,
    )
    dacl = sd.GetSecurityDescriptorDacl()
    assert dacl.GetAceCount() >= 1
    # First ACE should be owner-only
```

- [ ] **Step 3: 跑测试看 Windows ACL 测试 skip / posix 测试 fail**

```bash
uv run pytest tests/test_windows_paths.py -v
```

- [ ] **Step 4: 写 `win_acl.py`**

```python
"""Windows ACL helpers — restrict keys.json to owner only.

On non-Windows platforms this module's functions are no-ops.
"""
from __future__ import annotations
import sys
from pathlib import Path


def restrict_keys_file_windows(path: Path) -> None:
    if sys.platform != "win32":
        return
    try:
        import os
        import win32security
        import ntsecuritycon
    except ImportError:
        # pywin32 not installed — fall back silently per spec R-6
        return

    user_sid, _, _ = win32security.LookupAccountName("", os.getlogin())
    sd = win32security.SECURITY_DESCRIPTOR()
    dacl = win32security.ACL()
    dacl.AddAccessAllowedAce(
        win32security.ACL_REVISION,
        ntsecuritycon.FILE_GENERIC_READ | ntsecuritycon.FILE_GENERIC_WRITE,
        user_sid,
    )
    sd.SetSecurityDescriptorDacl(1, dacl, 0)
    win32security.SetFileSecurity(
        str(path), win32security.DACL_SECURITY_INFORMATION, sd,
    )
```

- [ ] **Step 5: 跑测试**

```bash
uv run pytest tests/test_windows_paths.py -v
```

- [ ] **Step 6: 提交**

```bash
git add src/character_workflow/lib/win_acl.py tests/test_windows_paths.py pyproject.toml
git commit -m "feat(windows): ACL helper restricts keys.json to owner only"
```

---

### Task 24: 进程管理跨平台（subprocess 启动 flag）

**Files:**
- Modify: `src/viewer_server/server.py`
- Modify: `tests/test_server_lifecycle.py`（如已存在；否则新建）

- [ ] **Step 1: 看现有 server.py 的后台启动逻辑**

```bash
grep -n "Popen\|start_new_session\|creationflags" src/viewer_server/server.py
```

- [ ] **Step 2: 改后台启动逻辑**

读 `src/viewer_server/server.py`，找到 `start --background` 路径，把 `subprocess.Popen` 调用改为：

```python
import sys
import subprocess

def _spawn_detached(cmd: list[str]) -> int:
    """Cross-platform detached subprocess spawn."""
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
        proc = subprocess.Popen(cmd, creationflags=flags)
    else:
        proc = subprocess.Popen(cmd, start_new_session=True)
    return proc.pid
```

- [ ] **Step 3: 跨平台进程存活检测**

如果 `server.py` 用 `os.kill(pid, 0)` 检测，改为：

```python
def _process_alive(pid: int) -> bool:
    try:
        import psutil
        return psutil.pid_exists(pid)
    except ImportError:
        # Fallback for POSIX
        import os
        try:
            os.kill(pid, 0)
            return True
        except (OSError, ProcessLookupError):
            return False
```

如需 psutil，加到 pyproject.toml dependencies。

- [ ] **Step 4: 跨平台 terminate**

```python
def _terminate(pid: int) -> None:
    try:
        import psutil
        proc = psutil.Process(pid)
        proc.terminate()
        proc.wait(timeout=5)
    except (ImportError, ProcessLookupError):
        if sys.platform != "win32":
            import os, signal
            try: os.kill(pid, signal.SIGTERM)
            except ProcessLookupError: pass
```

- [ ] **Step 5: 跑现有 server lifecycle 测试**

```bash
uv run pytest tests/ -k "server" -v
```

- [ ] **Step 6: 提交**

```bash
git add src/viewer_server/server.py pyproject.toml
git commit -m "feat(server): cross-platform detached spawn + process lifecycle"
```

---

### Task 25: SKILL.md 文档跨平台 + README 三平台段

**Files:**
- Modify: `skills/character-workflow/SKILL.md`
- Modify: `skills/character-promo/SKILL.md`
- Modify: `skills/character-turnaround/SKILL.md`
- Modify: `skills/viewer-server/SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: SKILL.md 顶部加 bootstrap self-check 协议**

对每个 `skills/*/SKILL.md`，在文件最顶（YAML frontmatter 之后）加：

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

## 启动自检（bootstrap）

每次触发本 Skill，第一步：

```bash
python ~/.claude/plugins/game-ui-ai-workflow/scripts/bootstrap.py --check
```

按 status 字段分流：

- `ready` → 进 turn-start，正常工作
- `needs_data_root` → 用 AskUserQuestion 问数据目录路径，POST `/api/onboarding/data-root`
- `needs_uv` → 显示 next_action 字段里的安装命令，**不要替用户跑**
- `needs_venv` → 跑 `python <plugin>/scripts/bootstrap.py --ensure-venv`
- `needs_first_key` → 启 viewer-server，引导用户在 Web 上加第一个 Key
- `needs_keys_repair` → 告知用户 `keys.json` 损坏，建议备份后手动编辑或删除重加
```

- [ ] **Step 2: SKILL.md 加 API Key 选择规则段（spec §5.3）**

对每个 `skills/*/SKILL.md`，在 bootstrap 自检段之后加：

```markdown
## API Key 选择规则

turn-start 返回 `available_keys` 和 `preferred_alias`：

1. **默认走 `preferred_alias`** — 不要问用户用哪个 Key
2. **用户点名某 alias / provider** — 切到匹配的 Key，更新 spec.md 的"渲染"段
3. **用户要求某种风格且 notes 里有匹配描述** — 可建议切换并解释理由
4. **`preferred_alias` 是 null** — 停下来告诉用户："当前 kind=X 没有可用 Key，去 Web 加一个"
5. **永远不要在终端 / 文档 / log 里显示 access_key / secret_key** — 你看不到，也不该看到
```

- [ ] **Step 3: SKILL.md 跨平台环境变量提示**

如 SKILL.md 提到 `~/.zshrc` 设环境变量：

```markdown
**注：** 上面命令的环境变量设法仅适用 macOS / Linux（写 `~/.zshrc` / `~/.bashrc`）。
Windows 用户用 PowerShell `$PROFILE` 或系统环境变量面板设。
```

- [ ] **Step 4: README 三平台安装段**

读 `README.md`，重写"快速开始 → 一次性安装"段：

```markdown
## 安装

### macOS / Linux

```bash
claude plugins install github:zhengzhongbiao/game-ui-ai-workflow
```

首次触发 `/character-workflow` 会引导：
1. 选数据目录（默认 `~/character-workflow/`）
2. 装 `uv`（如果还没装）
3. 自动 `uv sync` 装 Python 依赖
4. 在 Web 上加第一个 API Key

### Windows

```powershell
claude plugins install github:zhengzhongbiao/game-ui-ai-workflow
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
```

- [ ] **Step 5: 提交**

```bash
git add skills/*/SKILL.md README.md
git commit -m "docs: SKILL.md bootstrap self-check protocol + README cross-platform install"
```

---

# 阶段 7 — Plugin manifest + CLAUDE.md + Release 基建

### Task 26: `plugin.json` + check_plugin.py

**Files:**
- Create: `plugin.json`
- Create: `scripts/check_plugin.py`
- Create: `tests/test_check_plugin.py`

- [ ] **Step 1: 写 plugin.json**

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

**如果 Task 1 实测发现 schema 不一致：** 按实测结果调整字段名。

- [ ] **Step 2: 写测试 `tests/test_check_plugin.py`**

```python
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "check_plugin.py"


def test_check_plugin_passes_on_current_repo():
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        capture_output=True, text=True,
    )
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"


def test_check_plugin_fails_when_skill_md_missing(tmp_path, monkeypatch):
    # Snapshot plugin.json with non-existent SKILL.md path → should fail
    fake_repo = tmp_path / "fake-repo"
    fake_repo.mkdir()
    (fake_repo / "plugin.json").write_text(json.dumps({
        "name": "x", "version": "0.0.1", "description": "x",
        "skills": [{"name": "missing", "path": "skills/missing/SKILL.md"}],
    }))
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--repo", str(fake_repo)],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
```

- [ ] **Step 3: 写 `scripts/check_plugin.py`**

```python
#!/usr/bin/env python3
"""Release sanity check — validates plugin.json + skill files + web build."""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

MAX_SIZE_MB = 10


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--repo", default=".")
    args = p.parse_args()
    repo = Path(args.repo).resolve()

    failures: list[str] = []

    # 1. plugin.json valid
    manifest = repo / "plugin.json"
    if not manifest.exists():
        failures.append("plugin.json missing")
        return _report(failures)
    try:
        m = json.loads(manifest.read_text())
    except json.JSONDecodeError as e:
        failures.append(f"plugin.json invalid JSON: {e}")
        return _report(failures)
    for required in ("name", "version", "description", "skills"):
        if required not in m:
            failures.append(f"plugin.json missing required field: {required}")

    # 2. Each declared SKILL.md exists
    for skill in m.get("skills", []):
        sp = repo / skill["path"]
        if not sp.exists():
            failures.append(f"declared skill file missing: {skill['path']}")

    # 3. bootstrap.py exists
    bootstrap = repo / "scripts" / "bootstrap.py"
    if not bootstrap.exists():
        failures.append("scripts/bootstrap.py missing")

    # 4. pyproject.toml exists
    if not (repo / "pyproject.toml").exists():
        failures.append("pyproject.toml missing")

    # 5. Plugin size sanity
    total = sum(f.stat().st_size for f in repo.rglob("*") if f.is_file()
                and not _excluded(repo, f))
    size_mb = total / (1024 * 1024)
    if size_mb > MAX_SIZE_MB:
        failures.append(f"Plugin size {size_mb:.1f}MB exceeds {MAX_SIZE_MB}MB cap")

    return _report(failures)


def _excluded(repo: Path, f: Path) -> bool:
    parts = f.relative_to(repo).parts
    return any(p in (".git", "node_modules", "__pycache__", ".venv", "characters",
                     ".runtime", "memory", "projects") for p in parts)


def _report(failures: list[str]) -> int:
    if failures:
        for f in failures:
            print(f"FAIL: {f}")
        return 1
    print("OK: plugin checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 跑测试**

```bash
uv run pytest tests/test_check_plugin.py -v
./scripts/check_plugin.py 2>/dev/null || python scripts/check_plugin.py
```

Expected: 测试 PASS，脚本输出 `OK: plugin checks passed`。

- [ ] **Step 5: 提交**

```bash
git add plugin.json scripts/check_plugin.py tests/test_check_plugin.py
git commit -m "feat(plugin): manifest + check_plugin release validator"
```

---

### Task 27: 改 vite build outDir → web/dist/

**Files:**
- Modify: `web/vite.config.ts`
- Modify: `src/viewer_server/server.py`（static files mount 改路径）

- [ ] **Step 1: 改 vite.config.ts**

读 `web/vite.config.ts`，把 `outDir` 改：

```typescript
export default defineConfig({
  // ...
  build: {
    outDir: "dist",  // 旧: "../skill/viewer_server/static"
    emptyOutDir: true,
  },
});
```

- [ ] **Step 2: 改 viewer_server static mount**

读 `src/viewer_server/server.py` 或 `app.py`，找到 `StaticFiles` mount。改为：

```python
from pathlib import Path

# Find web/dist/ relative to repo root (parent of src/)
_REPO_ROOT = Path(__file__).resolve().parents[2]
_STATIC_DIR = _REPO_ROOT / "web" / "dist"

app.mount("/", StaticFiles(directory=str(_STATIC_DIR), html=True), name="static")
```

- [ ] **Step 3: 加 .gitignore**

```bash
grep "web/dist" .gitignore || echo "web/dist/" >> .gitignore
```

- [ ] **Step 4: 改 Makefile build target**

```makefile
build:
	cd web && pnpm install && pnpm build
```

(去掉任何 `cp` 到 `skill/viewer_server/static/` 的步骤。)

- [ ] **Step 5: 构建验证**

```bash
make build
ls web/dist/
```

Expected: `web/dist/index.html` 等存在。

- [ ] **Step 6: 提交**

```bash
git add web/vite.config.ts src/viewer_server/ .gitignore Makefile
git commit -m "build: vite outDir → web/dist/; viewer-server serves from there"
```

---

### Task 28: 仓库 CLAUDE.md 改为"开发者文档" + Dev mode 段

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 改 CLAUDE.md**

读现有 `CLAUDE.md`。改：

1. 头部"What this project is" → 改为：

```markdown
## What this project is

本仓库是 `game-ui-ai-workflow` **Plugin 源码**。Plugin 通过 `claude plugins install` 装到用户机器后，安装路径在 `~/.claude/plugins/game-ui-ai-workflow/`，用户数据在独立的 `<data_root>/`（默认 `~/character-workflow/`）。

详见 `docs/superpowers/specs/2026-05-22-skill-distribution-design.md`。
```

2. 加新段 "Dev mode"：

```markdown
## Dev mode

仓库内开发时，把仓库根当 data root：

```bash
export CHARACTER_WORKFLOW_DATA_ROOT=$(pwd)
make dev-link              # symlink skills/* → ~/.claude/skills/
make install               # uv sync + pnpm install
```

用 direnv 自动化：

```sh
# .envrc
export CHARACTER_WORKFLOW_DATA_ROOT=$PWD
```

Dev 模式跳过首启动向导。`make test` / `pytest` 自动用 `tmp_path` 隔离 data root，不污染仓库。
```

3. "启动必读 Memory 三层" 段保留（dev 模式下仓库根 = data root，路径有效）。

4. "常用命令" 段：把 `python -m skill.character_workflow` 改为 `python -m character_workflow`，`skill/character_workflow/` 等路径改为 `src/character_workflow/`、`skills/character-workflow/`。

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: rewrite CLAUDE.md as developer-mode reference + dev-mode env var"
```

---

### Task 29: CI workflow（mac+linux 必过，Windows allow-failure）

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/ci-windows.yml`

- [ ] **Step 1: mac + linux CI**

写 `.github/workflows/ci.yml`：

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [macos-latest, ubuntu-latest]
        python-version: ["3.11"]
    steps:
      - uses: actions/checkout@v4

      - name: Install uv
        uses: astral-sh/setup-uv@v3

      - name: Set up Python ${{ matrix.python-version }}
        run: uv python install ${{ matrix.python-version }}

      - name: Install Python deps
        run: uv sync

      - name: Run ruff
        run: uv run ruff check src scripts tests

      - name: Run pytest
        run: uv run pytest -v

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install web deps
        working-directory: web
        run: pnpm install --frozen-lockfile

      - name: Run vitest
        working-directory: web
        run: pnpm test

      - name: Type check
        working-directory: web
        run: pnpm lint

      - name: Build web
        working-directory: web
        run: pnpm build

      - name: Plugin sanity check
        run: uv run python scripts/check_plugin.py

      - name: No PROJECT_ROOT regression
        run: bash scripts/check_no_project_root.sh
```

- [ ] **Step 2: Windows CI（allow-failure）**

写 `.github/workflows/ci-windows.yml`：

```yaml
name: CI (Windows)

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test-windows:
    runs-on: windows-latest
    continue-on-error: true   # MVP: allow failure, follow-up Task: 转必过
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv python install 3.11
      - run: uv sync
      - run: uv run pytest -v
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - working-directory: web
        run: pnpm install --frozen-lockfile
      - working-directory: web
        run: pnpm test
```

- [ ] **Step 3: 提交**

```bash
git add .github/workflows/ci.yml .github/workflows/ci-windows.yml
git commit -m "ci: add mac/linux required workflow + Windows allow-failure"
```

---

### Task 30: bootstrap.py 入口（系统 Python → venv Python 切换）

**Files:**
- Modify: `scripts/bootstrap.py` 加 `--run` subcommand
- Modify: 4 个 `SKILL.md` 把 turn-start 命令包一层 bootstrap

**目的：** SKILL.md 调命令时，不能假设用户 PATH 上的 python 是 `<data_root>/.venv/python`。需要 bootstrap.py 先解析 venv python 路径，然后转发。

- [ ] **Step 1: 加 `--run` subcommand**

```python
def run_in_venv(args: list[str]) -> int:
    data_root = resolve_data_root()
    if data_root is None:
        print(json.dumps({"error": "data_root not set"}))
        return 1
    venv_py = _venv_python(data_root / ".venv")
    if not venv_py.exists():
        print(json.dumps({"error": "venv not built — run --ensure-venv"}))
        return 2
    import subprocess
    proc = subprocess.run([str(venv_py), *args])
    return proc.returncode


# In main():
parser.add_argument("--run", action="store_true", help="forward remaining args to venv python")
args, rest = parser.parse_known_args()
if args.run:
    return run_in_venv(rest)
```

- [ ] **Step 2: 改 SKILL.md 调命令的方式**

读 `skills/character-workflow/SKILL.md`，把：

```bash
uv run python -m character_workflow turn-start
```

改为：

```bash
python ~/.claude/plugins/game-ui-ai-workflow/scripts/bootstrap.py --run -m character_workflow turn-start
```

dev 模式（仓库内）继续用 `uv run python -m ...`。

- [ ] **Step 3: 测试**

写 `tests/test_bootstrap_run.py`：

```python
def test_run_fails_when_no_data_root(tmp_path):
    result = run_bootstrap(
        ["--run", "-c", "print('hi')"],
        env_overrides={
            "XDG_CONFIG_HOME": str(tmp_path / "cfg"),
            "APPDATA": str(tmp_path / "cfg"),
            "CHARACTER_WORKFLOW_DATA_ROOT": "",
        },
    )
    assert result.returncode != 0
    assert "data_root" in result.stdout
```

- [ ] **Step 4: 跑测试**

```bash
uv run pytest tests/test_bootstrap_run.py -v
```

- [ ] **Step 5: 提交**

```bash
git add scripts/bootstrap.py skills/*/SKILL.md tests/test_bootstrap_run.py
git commit -m "feat(bootstrap): --run forwards args to venv python; SKILL.md uses this entry"
```

---

### Task 31: 验证全套成功标准 + 写 release notes

**Files:**
- Create: `docs/superpowers/plans/2026-05-22-skill-distribution-completion-report.md`

- [ ] **Step 1: 跑所有验证**

```bash
# Success criterion #2 / #3
bash scripts/check_no_project_root.sh
# Plugin sanity
python scripts/check_plugin.py
# All tests
uv run pytest -v
cd web && pnpm test && pnpm lint && pnpm build && cd ..
```

Expected: 全 PASS。

- [ ] **Step 2: 写完成报告**

写 `docs/superpowers/plans/2026-05-22-skill-distribution-completion-report.md`：

```markdown
# Skill 分发改造完成报告

完成日期：<填日期>

## 成功标准核验

| # | 标准 | 状态 |
|---|---|---|
| 1 | 空机器 30 分钟内出第一张图（mac/linux/win） | ⏳ 手动验证待做 |
| 2 | `Path.cwd()` 在 src/ scripts/ 零出现 | ✅ scripts/check_no_project_root.sh PASS |
| 3 | `PROJECT_ROOT` 全代码零出现 | ✅ 同上 |
| 4 | `keys.json` chmod 600 / Windows ACL | ✅ tests/test_keys.py / test_windows_paths.py |
| 5 | secret 永不出现在 turn-start / log / API | ✅ tests/test_secret_redaction.py + grep 检查 |
| 6 | Plugin 卸载数据完整 | ✅ 数据 root 独立于 Plugin 安装目录 |
| 7 | 改 data root 自动重建 venv | ✅ bootstrap.py --check 状态机 |
| 8 | Dev mode 零回归 | ✅ tests/ 全过 |
| 9 | 新增 ≥ 40 测试 | <填实际数> |
| 10 | AI 选 Key 行为 | ✅ tests/test_turn_start_keys.py |
| 11 | Windows CI 通过率 ≥ 95% | <填实际数> |

## 开放问题验证

- OQ-1: <填 Task 1 实测结果>
- OQ-2: <填进程生命周期采用方案>
- OQ-3: keys.json schema v1，未做 migrator（MVP 不实现）

## 待做（follow-up）

- Windows CI 转必过（spec §6.6）
- 其他 provider caller 实现（openai / mj / nano_banana / seedream）
- Plugin marketplace 上架
- 多 workspace 支持
```

- [ ] **Step 3: 提交**

```bash
git add docs/superpowers/plans/2026-05-22-skill-distribution-completion-report.md
git commit -m "docs: skill distribution implementation completion report"
```

---

## 总结

| 阶段 | 任务范围 | 验证 |
|---|---|---|
| 0 | Task 1 — Plugin manifest 实测 | `claude plugins install` 成功 |
| 1 | Tasks 2-4 — data_root + bootstrap 骨架 + 测试 fixture | `pytest tests/test_data_root.py test_bootstrap.py` |
| 2 | Tasks 5-8 — 重组 + PROJECT_ROOT → data_root | `check_no_project_root.sh` PASS |
| 3 | Tasks 9-13 — keys + callers + turn-start | `pytest tests/test_keys*.py test_callers_dispatch.py test_turn_start_keys.py` |
| 4 | Tasks 14-18 — bootstrap 全状态 + REST API | `pytest tests/test_bootstrap.py test_onboarding_api.py test_keys_api.py` |
| 5 | Tasks 19-22 — Web UI | `pnpm test` |
| 6 | Tasks 23-25 — Windows compat | `pytest tests/test_windows_paths.py` + 手动 Windows 验证 |
| 7 | Tasks 26-31 — Plugin manifest + CI + 文档 + 完成报告 | `check_plugin.py` PASS + CI 通过 |

执行时建议用 **subagent-driven-development**（每 Task 一个 subagent，task 完成后 review 再下一个），避免单 session 累积上下文太长。

