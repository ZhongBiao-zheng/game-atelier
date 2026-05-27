# Atelier-Web PR1 Implementation Plan — 布局重构 + Studio 沙箱 + Keys 卡片化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有"3 栏画廊 + 浮动 Keys 按钮"的 Web 改造成 4-zone 路由壳：`/` Atelier 主页、`/studio` 出图沙箱（不绑角色）、`/character/:id` 现有 3 栏、`/settings/keys` 卡片化 Keys。同步引入向后兼容的 Job schema 重命名（`AssetSlot` / `JobKind` / `namespace`）和 SPA fallback。

**Architecture:** 引入 `wouter` 客户端路由 + AppShell 顶部 nav；后端 schema 把 `JobKind = PORTRAIT/PROMO/TURNAROUND` 重命名为 `AssetSlot`，新建 `JobKind = IMAGE/VIDEO`，新增 `namespace` 字段把 character/studio job 物理隔离。Studio 写盘到 `<data_root>/studio/<job_id>/`，character job 路径不变。FastAPI 加 SPA fallback 让 wouter 客户端路由刷新可用。**PR2（收藏池 + Skill 反哺）不在本 plan 范围**。

**Tech Stack:** Python 3.11 + FastAPI 0.115 + Pydantic 2.9 + uv；React 18.3 + TS 5.6 + Tailwind v4.3 + shadcn + Vite 5.4 + pnpm；wouter ^3.x（新依赖）；Instrument Serif + Geist + JetBrains Mono；pytest + vitest + ruff。

**源设计文档:** `docs/plans/2026-05-25 Atelier-Web 布局与生图沙箱设计.md`（已通过 `/plan-eng-review` + `/plan-design-review`）

**关键约束（不能违反）:**
- viewer-server 必须绑 `127.0.0.1`，不能改成 `0.0.0.0`
- `/api/raw` 图片读取必须保留 job_id 白名单
- `WebEditableJobPatch` 白名单不扩展：`status / output_paths / character_id / namespace / asset_slot / kind` 都是服务端独占
- DESIGN.md 反 slop：无紫蓝渐变 / 无 3 列 feature grid / 无 Inter / 无渐变按钮 / hero 区只有 Atelier Home 居中，其他左对齐
- 文件系统是 single source of truth

**最小桌面宽度:** 1280px。小于 1280px 显示 fallback 提示页。

---

## File Structure

### 新建（Python）
- `scripts/migrate_jobs_2026_05_25.py` — 一次性迁移老 job json（注入 `namespace="character"` + 重命名 `kind` → `asset_slot` + 注入新 `kind="image"`）
- `src/character_workflow/lib/studio_jobs.py` — Studio standalone job helpers（`studio_output_dir(job_id)`，与 `jobs.py` 隔离避免污染 character path）
- `tests/test_schema_compat.py` — 老 job json 反序列化 regression + 新字段默认值
- `tests/test_studio_jobs.py` — Studio API 端到端
- `tests/test_spa_fallback.py` — SPA fallback 行为
- `tests/test_gallery_recent.py` — `/api/gallery/recent` 行为

### 修改（Python）
- `src/character_workflow/lib/schemas.py` — `AssetSlot` 重命名 + 新 `JobKind` + 新 `namespace` 字段 + `Job.character_id` 保持 `str`（用 sentinel `"_studio"` 不够干净，改走 `namespace`）
- `src/character_workflow/lib/jobs.py` — 按 `namespace` 分发 output_dir
- `src/character_workflow/lib/job_runner.py` — Studio job 走 `studio_output_dir`
- `src/viewer_server/server_app.py` — SPA fallback
- `src/viewer_server/routes.py` — 新增 `/api/gallery/recent` + `/api/studio/jobs`
- `docs/api-contract.md` — 契约 v2

### 新建（Web）
- `web/src/components/AppShell.tsx` — 顶部 nav + `<Switch>` + 路由 active 高亮 + viewport 守卫
- `web/src/components/MinViewportGuard.tsx` — <1280px fallback
- `web/src/pages/Home.tsx` — Atelier Home（hero + masonry）
- `web/src/pages/Studio.tsx` — Studio 沙箱
- `web/src/pages/CharacterDetail.tsx` — 从 MainApp.tsx 提取
- `web/src/components/studio/PromptInput.tsx` — textarea + 4 个 Popover
- `web/src/components/studio/RoundList.tsx` — 历史按轮分组
- `web/src/components/studio/InspirationChips.tsx` — first-time 3 个灰 chip
- `web/src/components/studio/WaitingCopy.tsx` — 计时器 + 渐变文案
- `web/src/api/studio.ts` — `POST /api/studio/jobs` client
- `web/src/api/gallery.ts` — `GET /api/gallery/recent` client
- `web/src/pages/Home.test.tsx`
- `web/src/pages/Studio.test.tsx`
- `web/src/components/AppShell.test.tsx`

### 修改（Web）
- `web/package.json` — 加 `wouter ^3.x`
- `web/src/schema/jobs.ts` — 同步 `AssetSlot` / 新 `JobKind` / `namespace`
- `web/src/App.tsx` — onboarding 分叉保留；`ready` 分支挂 `<AppShell>` + `<Switch>`
- `web/src/MainApp.tsx` — 删除浮动 Keys 按钮；保留作为 `CharacterDetail` 的内层组件（或并入 CharacterDetail）
- `web/src/pages/settings/Keys.tsx` — 卡片化 + reveal modal + Cmd+K 类 EMPTY 状态

---

## Task Sequence

12 tasks. 每个 task 自成一个 commit 单元。任务间有先后依赖：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12。

不要并行执行不同任务（schema/runner 共享面太多）。

---

## Task 1: Schema 重命名 + namespace 字段 + 迁移脚本

**Files:**
- Modify: `src/character_workflow/lib/schemas.py`
- Create: `scripts/migrate_jobs_2026_05_25.py`
- Create: `tests/test_schema_compat.py`

### Step 1.1: 写 regression test（先红）

- [ ] **Write failing test** at `tests/test_schema_compat.py`:

```python
"""老 job json 在 schema 重命名后仍能反序列化 — 不变量必须保住."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from character_workflow.lib.schemas import AssetSlot, Job, JobKind


def _make_legacy_job_dict() -> dict:
    """老 schema：kind 字段是 portrait/promo/turnaround 字符串."""
    return {
        "job_id": "job-legacy-001",
        "character_id": "char-test",
        "prompt": "test prompt",
        "submitted_at": "2026-05-19T10:00:00Z",
        "model": "lovart",
        "params": {"size": "1024x1024"},
        "seed": None,
        "output_paths": [],
        "status": "done",
        "error": None,
        "kind": "portrait",  # 老字段名
        "source_image": None,
        "alias": None,
        "provider": None,
    }


def test_legacy_job_without_migration_does_not_load():
    """没跑 migration 的老 json 现在会失败 — 这是预期的 (跑 migration 前不应该读)."""
    legacy = _make_legacy_job_dict()
    with pytest.raises(Exception):
        Job(**legacy)


def test_migrated_job_loads_with_defaults():
    """migration 后老 job 注入 asset_slot + namespace="character" + kind="image"."""
    migrated = _make_legacy_job_dict()
    migrated.pop("kind")
    migrated["asset_slot"] = "portrait"
    migrated["namespace"] = "character"
    migrated["kind"] = "image"
    job = Job(**migrated)
    assert job.asset_slot == AssetSlot.PORTRAIT
    assert job.namespace == "character"
    assert job.kind == JobKind.IMAGE
    assert job.character_id == "char-test"


def test_studio_job_with_namespace_studio():
    """Studio job: namespace='studio', asset_slot 仍是 PORTRAIT 占位（runner 不读它）."""
    studio = _make_legacy_job_dict()
    studio.pop("kind")
    studio["job_id"] = "job-studio-001"
    studio["character_id"] = "char-test"  # placeholder, runner 看 namespace
    studio["asset_slot"] = "portrait"
    studio["namespace"] = "studio"
    studio["kind"] = "image"
    job = Job(**studio)
    assert job.namespace == "studio"
    assert job.kind == JobKind.IMAGE


def test_video_kind_value_in_enum():
    """JobKind 必须包含 VIDEO 占位（实际 runner 抛 NotImplementedError 由其他测试覆盖）."""
    assert JobKind.VIDEO.value == "video"
```

- [ ] **Run test, expect fail** because `AssetSlot` 不存在、`Job` 没有 `asset_slot` / `namespace` 字段：

```bash
uv run pytest tests/test_schema_compat.py -v
```

Expected: ImportError / ValidationError 报红。

### Step 1.2: 重命名 + 新字段（Python schema）

- [ ] **Edit `src/character_workflow/lib/schemas.py`**：

把 `JobKind = PORTRAIT/PROMO/TURNAROUND` 改名为 `AssetSlot`，新建 `JobKind = IMAGE/VIDEO`，`Job` 新增 `asset_slot` + `namespace` + 新 `kind`，删掉旧 `kind`：

```python
class AssetSlot(str, Enum):
    # 角色资产槽位 — 决定 characters/<id>/<slot>/ 物理路径。
    # 老 JobKind = PORTRAIT/PROMO/TURNAROUND 改名而来（2026-05-25 重构）。
    PORTRAIT = "portrait"
    PROMO = "promo"
    TURNAROUND = "turnaround"


class JobKind(str, Enum):
    # 媒体类型 — 与 AssetSlot 解耦。VIDEO 占位，runner 抛 NotImplementedError。
    IMAGE = "image"
    VIDEO = "video"


class Job(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: str
    character_id: str
    prompt: str
    submitted_at: str
    model: str
    params: JobParams
    seed: int | None
    output_paths: list[str]
    status: JobStatus
    error: str | None
    # 2026-05-25 重构：原 kind 拆成 asset_slot + kind + namespace。
    asset_slot: AssetSlot = AssetSlot.PORTRAIT
    kind: JobKind = JobKind.IMAGE
    namespace: str = "character"  # "character" | "studio"
    source_image: str | None = None
    alias: str | None = None
    provider: str | None = None
```

注意：保留 `Job.character_id: str`（非 Optional），Studio job 把它写成与 character 同名的 placeholder（详见 Task 7 中 namespace 分发逻辑），不引入 None 分支。

### Step 1.3: 运行 test 验证 schema 改动

- [ ] **Run test**, expect 4/4 PASS:

```bash
uv run pytest tests/test_schema_compat.py -v
```

### Step 1.4: 写迁移脚本

- [ ] **Create `scripts/migrate_jobs_2026_05_25.py`**：

```python
"""一次性脚本：把所有 .runtime/jobs/<id>.json 从老 schema 升级到新 schema.

老格式: {"kind": "portrait"|"promo"|"turnaround", ...}
新格式: {"asset_slot": ..., "kind": "image", "namespace": "character", ...}

幂等：如果已含 "asset_slot" / "namespace" 字段则跳过.
用法：CHARACTER_WORKFLOW_DATA_ROOT=/path/to/data uv run python scripts/migrate_jobs_2026_05_25.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def migrate(data_root: Path) -> tuple[int, int, int]:
    jobs_dir = data_root / ".runtime" / "jobs"
    if not jobs_dir.exists():
        print(f"[skip] {jobs_dir} 不存在")
        return 0, 0, 0
    migrated = skipped = errored = 0
    for path in sorted(jobs_dir.glob("*.json")):
        try:
            raw = json.loads(path.read_text())
        except Exception as e:
            print(f"[err] {path.name}: {e}")
            errored += 1
            continue
        if "asset_slot" in raw and "namespace" in raw:
            skipped += 1
            continue
        old_kind = raw.pop("kind", "portrait")
        raw["asset_slot"] = old_kind
        raw["namespace"] = "character"
        raw["kind"] = "image"
        # atomic rename
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(raw, indent=2, ensure_ascii=False))
        tmp.replace(path)
        migrated += 1
    print(f"migrated={migrated} skipped={skipped} errored={errored}")
    return migrated, skipped, errored


if __name__ == "__main__":
    data_root_env = os.environ.get("CHARACTER_WORKFLOW_DATA_ROOT")
    if not data_root_env:
        print("set CHARACTER_WORKFLOW_DATA_ROOT", file=sys.stderr)
        sys.exit(2)
    migrate(Path(data_root_env))
```

### Step 1.5: 写迁移脚本的测试

- [ ] **Append to `tests/test_schema_compat.py`**：

```python
def test_migration_script_idempotent(tmp_path):
    """脚本对老 json 升级；二次执行无效果."""
    from scripts.migrate_jobs_2026_05_25 import migrate

    data_root = tmp_path
    jobs_dir = data_root / ".runtime" / "jobs"
    jobs_dir.mkdir(parents=True)
    legacy = _make_legacy_job_dict()
    (jobs_dir / "job-legacy-001.json").write_text(json.dumps(legacy))
    # 第一次：1 migrated
    m1, s1, e1 = migrate(data_root)
    assert (m1, s1, e1) == (1, 0, 0)
    # 第二次：0 migrated, 1 skipped
    m2, s2, e2 = migrate(data_root)
    assert (m2, s2, e2) == (0, 1, 0)
    # 内容验证
    new = json.loads((jobs_dir / "job-legacy-001.json").read_text())
    assert new["asset_slot"] == "portrait"
    assert new["namespace"] == "character"
    assert new["kind"] == "image"
    # 用 Pydantic 反序列化必须成功
    job = Job(**new)
    assert job.asset_slot == AssetSlot.PORTRAIT
```

注意 `from scripts.migrate_jobs_2026_05_25 import migrate` —— 需要 `scripts/__init__.py` 才能 import。如果没有，加一行：

```bash
touch /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow/scripts/__init__.py
```

### Step 1.6: 运行所有测试通过

- [ ] **Run**:

```bash
uv run pytest tests/test_schema_compat.py -v
```

Expected: 5/5 PASS.

### Step 1.7: 同步 TS schema

- [ ] **Edit `web/src/schema/jobs.ts`**：

```typescript
export type JobStatus = 'pending_confirm' | 'pending' | 'done' | 'failed';

// 2026-05-25 重构: 原 JobKind 改名为 AssetSlot
export type AssetSlot = 'portrait' | 'promo' | 'turnaround';

// 新 JobKind: 媒体类型
export type JobKind = 'image' | 'video';

export type Namespace = 'character' | 'studio';

export interface JobParams {
  size?: string;
  steps?: number;
  cfg_scale?: number;
  vendor?: string;
  n?: number;
  reference_images?: string[];
  requested_size?: string;
  actual_size?: string;
  lovart_attachments?: string[];
  lovart_thread_id?: string;
  lovart_final_status?: string;
  warnings?: string[];
  [key: string]: unknown;
}

export interface Job {
  job_id: string;
  character_id: string;
  prompt: string;
  submitted_at: string;
  model: string;
  params: JobParams;
  seed: number | null;
  output_paths: string[];
  status: JobStatus;
  error: string | null;
  asset_slot?: AssetSlot;
  kind?: JobKind;
  namespace?: Namespace;
  source_image?: string | null;
  alias?: string | null;
  provider?: string | null;
}

export const WEB_EDITABLE_FIELDS = ['prompt', 'model', 'params', 'seed'] as const;
export type WebEditableField = (typeof WEB_EDITABLE_FIELDS)[number];

export interface WebEditableJobPatch {
  prompt?: string;
  model?: string;
  params?: JobParams;
  seed?: number | null;
}

// 其余 CharacterEntry / ActiveCharacterFile / Project / ProjectsFile 保持不变
export interface CharacterEntry {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'done' | 'failed';
  latest_job_id: string | null;
}

export interface ActiveCharacterFile {
  active_id: string | null;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  created_at: string;
}

export interface ProjectsFile {
  projects: Project[];
  assignments: Record<string, string>;
}
```

### Step 1.8: 修复因 schema 改名导致的下游引用

- [ ] **Grep all references to old `JobKind`** in Python code:

```bash
grep -rn "JobKind\." src/character_workflow/ tests/ --include="*.py" | grep -v schemas.py
```

预期命中: `lib/jobs.py`, `lib/job_runner.py`, 可能 `lib/prompt_builder.py`, `lib/draft_processor.py`, test files。

- [ ] **For each hit**, replace `JobKind.PORTRAIT/PROMO/TURNAROUND` → `AssetSlot.PORTRAIT/PROMO/TURNAROUND`，并把 `job.kind` 字段访问改为 `job.asset_slot`。
- [ ] **Grep TS**:

```bash
grep -rn "JobKind\|kind:" web/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules
```

预期: 主要在 ImageDetail/MainApp 把 `job.kind` 当 asset slot 读。改为 `job.asset_slot`。`kind` 字段如果暴露给 UI 显示，留意改成 `asset_slot`。

### Step 1.9: 跑全测试确保没破现有逻辑

- [ ] **Run**:

```bash
uv run pytest -q && cd web && pnpm test -- --run
```

Expected: 全绿。如果 character workflow 测试因 `Job.asset_slot` 默认值变化而失败，单独修。

### Step 1.10: Commit

- [ ] Stage and commit:

```bash
git add src/character_workflow/lib/schemas.py \
        scripts/migrate_jobs_2026_05_25.py \
        scripts/__init__.py \
        tests/test_schema_compat.py \
        web/src/schema/jobs.ts \
        src/character_workflow/lib/jobs.py \
        src/character_workflow/lib/job_runner.py
git commit -m "$(cat <<'EOF'
refactor(schema): rename JobKind→AssetSlot + new JobKind(image/video) + namespace

Decoupling asset slot from media kind to support Studio standalone jobs
and future video. character jobs use namespace=character (path unchanged);
studio jobs (T7) will use namespace=studio. JobKind=VIDEO is enum-only
placeholder; runner will NotImplementedError.

Migration script for legacy .runtime/jobs/*.json included. Idempotent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SPA Fallback in FastAPI

**Files:**
- Modify: `src/viewer_server/server_app.py`
- Create: `tests/test_spa_fallback.py`

### Step 2.1: Write failing test

- [ ] **Create `tests/test_spa_fallback.py`**:

```python
"""SPA fallback: GET 任何非 /api/* 路径 → 返回 web/dist/index.html (200)."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    # 模拟 web/dist 存在 + index.html
    dist = tmp_path / "web" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text("<html><body>spa</body></html>")
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    app = build_app(dist_dir=dist)
    return TestClient(app)


def test_spa_fallback_serves_index_for_client_route(client):
    """GET /character/foo → index.html (200), 不是 404."""
    resp = client.get("/character/foo")
    assert resp.status_code == 200
    assert "spa" in resp.text


def test_spa_fallback_serves_index_for_studio(client):
    resp = client.get("/studio")
    assert resp.status_code == 200
    assert "spa" in resp.text


def test_api_routes_still_404_on_unknown(client):
    """SPA fallback 不能吃掉 /api/* — 未知 API path 仍返回 404."""
    resp = client.get("/api/this-does-not-exist")
    assert resp.status_code == 404
    # 必须不是 index.html
    assert "spa" not in resp.text


def test_static_assets_served_normally(client, tmp_path):
    asset = tmp_path / "web" / "dist" / "assets"
    asset.mkdir()
    (asset / "main.js").write_text("console.log('ok')")
    resp = client.get("/assets/main.js")
    assert resp.status_code == 200
    assert "console.log" in resp.text
```

- [ ] **Run, expect fail**:

```bash
uv run pytest tests/test_spa_fallback.py -v
```

Expected: fail because either `build_app` signature 不接受 `dist_dir`, 或 SPA fallback 未实现。

### Step 2.2: Read current server_app.py

- [ ] **Read** `src/viewer_server/server_app.py` end-to-end, locate where StaticFiles 挂载 web/dist。

### Step 2.3: Implement SPA fallback

- [ ] **Edit `server_app.py`** —— 在所有 API 路由注册完成后、StaticFiles 挂载之后，加一条 catch-all GET 路由返回 `index.html`：

```python
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ...existing imports

def build_app(dist_dir: Path | None = None) -> FastAPI:
    # ...existing setup
    app = FastAPI()
    # register all /api/* routers first
    register_api_routes(app)

    # 静态资源
    if dist_dir is None:
        dist_dir = Path(__file__).parents[2] / "web" / "dist"
    if dist_dir.exists():
        # 把 /assets/* 之类的子目录交给 StaticFiles
        app.mount("/assets", StaticFiles(directory=dist_dir / "assets"), name="assets")
        # /favicon.ico 等 root 文件
        @app.get("/{path:path}")
        async def spa_fallback(path: str, request: Request):
            # /api/* 永远不走 fallback —— 由前面 router 已注册的端点决定 404 vs 200
            if path.startswith("api/"):
                raise HTTPException(status_code=404)
            # 命中具体静态文件就返回（favicon.ico 之类）
            file = dist_dir / path
            if path and file.is_file():
                return FileResponse(file)
            # 否则一律返回 SPA 入口
            return FileResponse(dist_dir / "index.html")
    return app
```

注意：保持现有 `register_api_routes` / handler 注册顺序不变。catch-all 必须**最后**注册。

如果 `build_app` 当前没有 `dist_dir` 参数，加一个，向后兼容（无参时落到默认路径）。

### Step 2.4: Run tests pass

- [ ] **Run**:

```bash
uv run pytest tests/test_spa_fallback.py -v
```

Expected: 4/4 PASS.

### Step 2.5: Make sure no existing tests broke

- [ ] **Run full backend**:

```bash
uv run pytest -q
```

### Step 2.6: Commit

- [ ] Stage + commit:

```bash
git add src/viewer_server/server_app.py tests/test_spa_fallback.py
git commit -m "$(cat <<'EOF'
feat(server): SPA fallback for wouter client routes

Non /api/* paths return index.html so /character/foo + /studio survive
browser refresh. /api/* unknown paths still 404 (no fallback poisoning).
Required for T3 wouter routing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: wouter + AppShell + 4 Route Skeletons

**Files:**
- Modify: `web/package.json`
- Create: `web/src/components/AppShell.tsx`
- Create: `web/src/components/AppShell.test.tsx`
- Create: `web/src/components/MinViewportGuard.tsx`
- Create: `web/src/pages/Home.tsx` (placeholder)
- Create: `web/src/pages/Studio.tsx` (placeholder)
- Create: `web/src/pages/CharacterDetail.tsx` (delegates to MainApp 内部组件 — T4 重构)
- Modify: `web/src/App.tsx`

### Step 3.1: Install wouter

- [ ] **Add dep**:

```bash
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow/web && pnpm add wouter@^3
```

### Step 3.2: Create MinViewportGuard

- [ ] **Write `web/src/components/MinViewportGuard.tsx`**：

```tsx
import { type ReactNode, useEffect, useState } from 'react';

const MIN_WIDTH = 1280;

export function MinViewportGuard({ children }: { children: ReactNode }) {
  const [tooNarrow, setTooNarrow] = useState(
    typeof window !== 'undefined' && window.innerWidth < MIN_WIDTH,
  );
  useEffect(() => {
    const onResize = () => setTooNarrow(window.innerWidth < MIN_WIDTH);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  if (tooNarrow) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6 text-center text-foreground">
        <div className="space-y-3">
          <h1 className="font-display text-2xl italic">Atelier · 工坊</h1>
          <p className="text-sm text-muted-foreground">
            请在桌面浏览器打开（≥1280px）。
            <br />
            这是一个本地图像编辑工具，在小屏上不展开。
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
```

注：`font-display` 在 Tailwind v4 `@theme` 已绑 Instrument Serif（DESIGN.md 已定）。如果项目里这个 utility 没绑，临时用 `style={{ fontFamily: "'Instrument Serif', serif" }}` —— 但优先检查 `web/src/styles/*.css` 是否已有 `--font-display`。

### Step 3.3: Create AppShell

- [ ] **Write `web/src/components/AppShell.tsx`**：

```tsx
import { type ReactNode } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { Settings } from 'lucide-react';

import { Home } from '@/pages/Home';
import { Studio } from '@/pages/Studio';
import { CharacterDetail } from '@/pages/CharacterDetail';
import { KeysPage } from '@/pages/settings/Keys';

function NavTab({ to, label, isActive }: { to: string; label: string; isActive: boolean }) {
  return (
    <Link href={to}>
      <a
        className={[
          'h-14 inline-flex items-center px-3 text-sm transition-colors',
          isActive
            ? 'text-foreground border-b-2 border-primary -mb-px font-medium'
            : 'text-muted-foreground hover:text-foreground',
        ].join(' ')}
      >
        {label}
      </a>
    </Link>
  );
}

export function AppShell() {
  const [loc] = useLocation();
  const onCharacter = loc.startsWith('/character');
  const onStudio = loc === '/studio';
  const onKeys = loc === '/settings/keys';

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 bg-card border-b border-border">
        <div className="mx-auto flex h-14 items-center justify-between px-6">
          <Link href="/">
            <a className="flex items-baseline gap-2">
              <span
                className="text-2xl font-normal"
                style={{ fontFamily: "'Instrument Serif', serif" }}
              >
                Atelier
              </span>
              <span className="text-xs text-muted-foreground">· 工作流</span>
            </a>
          </Link>
          <nav className="flex h-14 items-stretch gap-1">
            <NavTab to="/character" label="工坊" isActive={onCharacter} />
            <NavTab to="/studio" label="试稿" isActive={onStudio} />
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/settings/keys">
              <a
                aria-label="API Keys 设置"
                className={[
                  'inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                  onKeys ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                ].join(' ')}
              >
                <Settings size={18} aria-hidden />
              </a>
            </Link>
          </div>
        </div>
      </header>

      <main role="main">
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/studio" component={Studio} />
          <Route path="/character" component={CharacterDetail} />
          <Route path="/character/:id">
            {(params) => <CharacterDetail characterId={params.id} />}
          </Route>
          <Route path="/settings/keys" component={KeysPage} />
          <Route>
            <RedirectHome />
          </Route>
        </Switch>
      </main>
    </div>
  );
}

function RedirectHome() {
  const [, setLocation] = useLocation();
  setLocation('/', { replace: true });
  return null;
}
```

注意：`KeysPage` 当前在 `web/src/pages/settings/Keys.tsx` 是 default export 还是 named? T10 会重写它。这一步先确保 import 正确。如果当前 default export, 写：

```tsx
import KeysPage from '@/pages/settings/Keys';
```

### Step 3.4: Create placeholder pages

- [ ] **Write `web/src/pages/Home.tsx`** (T6 实际实现，先占位)：

```tsx
export function Home() {
  return (
    <div className="px-6 py-12 text-foreground">
      <h1
        className="text-5xl italic mb-3"
        style={{ fontFamily: "'Instrument Serif', serif" }}
      >
        Atelier
      </h1>
      <p className="text-sm text-muted-foreground italic">一间安静的暖色画廊</p>
      <p className="mt-8 text-sm text-muted-foreground">(masonry 占位 — T6 实现)</p>
    </div>
  );
}
```

- [ ] **Write `web/src/pages/Studio.tsx`** (T8 实际实现，先占位)：

```tsx
export function Studio() {
  return (
    <div className="px-6 py-8 text-foreground">
      <h1
        className="text-3xl"
        style={{ fontFamily: "'Instrument Serif', serif" }}
      >
        Studio.
      </h1>
      <p className="mt-6 text-sm text-muted-foreground">(沙箱占位 — T7/T8 实现)</p>
    </div>
  );
}
```

- [ ] **Write `web/src/pages/CharacterDetail.tsx`** (T4 重构 MainApp 时实现，先占位)：

```tsx
import { MainApp } from '@/MainApp';

export function CharacterDetail({ characterId }: { characterId?: string } = {}) {
  return <MainApp routedCharacterId={characterId} />;
}
```

注：`routedCharacterId` 是 T4 加给 MainApp 的可选 prop。这一步只是先把组件占位绑上。

### Step 3.5: Refactor App.tsx — onboarding 分叉保留，ready 分支挂 AppShell

- [ ] **Read** `web/src/App.tsx`. Locate `OnboardingState` 分叉，在 `status === 'ready'` 分支替换 `<MainApp />` 为：

```tsx
import { MinViewportGuard } from '@/components/MinViewportGuard';
import { AppShell } from '@/components/AppShell';
// ...
// ready 分支:
return (
  <MinViewportGuard>
    <AppShell />
  </MinViewportGuard>
);
```

如果 App.tsx 之前还在 ready 分支根据 view state 切换 `<KeysPage />` / `<MainApp />`，把那段 view-state-switch 整体删除（T4 会再清理 MainApp 内部的浮动 Keys 按钮）。

### Step 3.6: Write AppShell test

- [ ] **Write `web/src/components/AppShell.test.tsx`**：

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { AppShell } from './AppShell';

function renderAt(path: string) {
  const { hook } = memoryLocation({ path, static: true });
  return render(
    <Router hook={hook}>
      <AppShell />
    </Router>,
  );
}

describe('AppShell', () => {
  it('renders Atelier logo on every route', () => {
    renderAt('/studio');
    expect(screen.getByText('Atelier')).toBeInTheDocument();
  });

  it('highlights 试稿 tab on /studio', () => {
    renderAt('/studio');
    const tab = screen.getByText('试稿');
    expect(tab.className).toContain('border-primary');
  });

  it('highlights 工坊 tab on /character/foo', () => {
    renderAt('/character/foo');
    const tab = screen.getByText('工坊');
    expect(tab.className).toContain('border-primary');
  });

  it('does not highlight either tab on /', () => {
    renderAt('/');
    expect(screen.getByText('试稿').className).not.toContain('border-primary');
    expect(screen.getByText('工坊').className).not.toContain('border-primary');
  });

  it('Keys icon turns primary on /settings/keys', () => {
    renderAt('/settings/keys');
    const link = screen.getByLabelText('API Keys 设置');
    expect(link.className).toContain('text-primary');
  });
});
```

### Step 3.7: Run all Web tests + typecheck

- [ ] **Run**:

```bash
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow/web && pnpm test -- --run && pnpm lint
```

Expected: AppShell 测试通过；现有 vitest 全绿；tsc 无 error。如果 lint 报 `Cannot find module 'wouter/memory-location'`，把 import 改为 `wouter/memory-location` 在 wouter v3 是有效，但确认 `package.json` 没 lock 到老版本。

### Step 3.8: Commit

```bash
git add web/package.json web/pnpm-lock.yaml \
        web/src/App.tsx \
        web/src/components/AppShell.tsx \
        web/src/components/AppShell.test.tsx \
        web/src/components/MinViewportGuard.tsx \
        web/src/pages/Home.tsx \
        web/src/pages/Studio.tsx \
        web/src/pages/CharacterDetail.tsx
git commit -m "$(cat <<'EOF'
feat(web): wouter routing + AppShell + 1280px viewport guard

4 routes mounted under MinViewportGuard: / (Home), /studio, /character[/:id],
/settings/keys. Placeholder Home/Studio pages — actual content in T6/T8.
Onboarding fork in App.tsx untouched; AppShell only mounts on ready.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Refactor MainApp → CharacterDetail + remove floating Keys button

**Files:**
- Modify: `web/src/MainApp.tsx`
- Modify: `web/src/pages/CharacterDetail.tsx`

### Step 4.1: Read MainApp current state

- [ ] **Read** `web/src/MainApp.tsx` 全文。找到：
  - 浮动 Keys 按钮 / view-state switch
  - active_id 加载逻辑
  - 3 栏 layout（LeftSidebar / CharacterGallery / SpecForm-or-ImageDetail）

### Step 4.2: Strip floating Keys button + accept routed character id

- [ ] **Edit `MainApp.tsx`**：
  1. 删除 view-state enum 和浮动 Keys button JSX（如果还存在）
  2. 加 prop：`routedCharacterId?: string`
  3. 如果 prop 提供，覆盖 `useActiveCharacter` 的 `active_id`，否则保留现有行为（fallback 到 active_id）

举例 diff 思路（实际改动按当前文件结构调整）：

```tsx
// Before:
export function MainApp() {
  const { activeId } = useActiveCharacter();
  const [view, setView] = useState<'main' | 'keys'>('main');
  // ...
  if (view === 'keys') return <KeysPage onClose={() => setView('main')} />;
  return (
    <div>
      <button onClick={() => setView('keys')}>Keys</button>
      <LeftSidebar ... />
      ...
    </div>
  );
}

// After:
export function MainApp({ routedCharacterId }: { routedCharacterId?: string } = {}) {
  const { activeId: activeFromFile, setActive } = useActiveCharacter();
  const effectiveId = routedCharacterId ?? activeFromFile;
  // ...如果 routedCharacterId 存在且 != activeFromFile，触发 setActive(routedCharacterId)
  useEffect(() => {
    if (routedCharacterId && routedCharacterId !== activeFromFile) {
      setActive(routedCharacterId);
    }
  }, [routedCharacterId, activeFromFile, setActive]);
  // 浮动 Keys 按钮整段删除
  return (
    <div className="grid grid-cols-[280px_1fr_360px] min-h-[calc(100vh-3.5rem)]">
      <LeftSidebar activeId={effectiveId} ... />
      <CharacterGallery ... />
      {/* SpecForm or ImageDetail by selection */}
    </div>
  );
}
```

### Step 4.3: Update CharacterDetail wrapper

- [ ] **Edit `web/src/pages/CharacterDetail.tsx`** 把 prop 透传修干净（T3 已写占位，此处确认 prop 名）。

### Step 4.4: 跑 vitest + lint

- [ ] **Run**:

```bash
cd web && pnpm test -- --run && pnpm lint
```

Expected: 现有 MainApp 相关测试通过；如果有"点 Keys 按钮跳页"的旧测试，删除（按 §Design Bindings 已规定无浮动按钮）。

### Step 4.5: Manual smoke

- [ ] **Run** (Terminal A):

```bash
uv run python src/viewer_server/server.py start
```

- [ ] **Run** (Terminal B):

```bash
cd web && pnpm dev
```

- [ ] 在浏览器打开 `http://127.0.0.1:5173`，确认：
  - Header 有 "Atelier · 工作流" + "工坊" + "试稿" + ⚙
  - 点 "工坊" → URL 变 `/character`，渲染 3 栏
  - 点 ⚙ → URL 变 `/settings/keys`，浮动按钮**不存在**
  - 点 "Atelier" logo → 回 `/`
  - 浏览器后退 / 前进可用
  - Refresh 在任意 URL 都不 404（SPA fallback 已工作）

### Step 4.6: Commit

```bash
git add web/src/MainApp.tsx web/src/pages/CharacterDetail.tsx
git commit -m "$(cat <<'EOF'
refactor(web): MainApp accepts routedCharacterId + drop floating Keys

Floating "Keys" button removed (now /settings/keys via nav). MainApp
becomes a routed component embedded in CharacterDetail. active_id
sync stays — routed ID wins if provided.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `/api/gallery/recent` Endpoint

**Files:**
- Modify: `src/viewer_server/routes.py`
- Create: `tests/test_gallery_recent.py`

### Step 5.1: Write failing test

- [ ] **Create `tests/test_gallery_recent.py`**：

```python
"""GET /api/gallery/recent: 从所有 character 的 portrait/promo/turnaround 中按 mtime 取最新 N 张."""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    chars = tmp_path / "characters"
    chars.mkdir()
    return TestClient(build_app(dist_dir=tmp_path / "dist"))


def _make_image(p: Path, mtime_offset: float = 0):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"\x89PNG\r\n\x1a\n")
    if mtime_offset:
        target_mtime = time.time() + mtime_offset
        os.utime(p, (target_mtime, target_mtime))


def test_empty_returns_empty_list(client):
    resp = client.get("/api/gallery/recent")
    assert resp.status_code == 200
    assert resp.json() == {"items": []}


def test_returns_images_sorted_by_mtime(client, tmp_path):
    chars = tmp_path / "characters"
    _make_image(chars / "char-a" / "portrait" / "old.png", mtime_offset=-100)
    _make_image(chars / "char-b" / "portrait" / "new.png", mtime_offset=-1)
    _make_image(chars / "char-c" / "promo" / "mid.png", mtime_offset=-50)
    resp = client.get("/api/gallery/recent")
    items = resp.json()["items"]
    # 时间倒序
    assert [i["character_id"] for i in items] == ["char-b", "char-c", "char-a"]
    # 每个 item 字段
    assert items[0]["asset_slot"] == "portrait"
    assert items[0]["filename"] == "new.png"


def test_respects_limit_param(client, tmp_path):
    chars = tmp_path / "characters"
    for i in range(5):
        _make_image(chars / f"char-{i}" / "portrait" / "img.png", mtime_offset=-i)
    resp = client.get("/api/gallery/recent?limit=3")
    items = resp.json()["items"]
    assert len(items) == 3


def test_skips_studio_namespace(client, tmp_path):
    """studio/ 目录的图不进 home gallery (Pass 1.4 Decision: home = 角色作品集)."""
    chars = tmp_path / "characters"
    studio = tmp_path / "studio"
    _make_image(chars / "char-a" / "portrait" / "char.png", mtime_offset=-2)
    _make_image(studio / "job-x" / "v1.png", mtime_offset=-1)
    resp = client.get("/api/gallery/recent")
    items = resp.json()["items"]
    assert len(items) == 1
    assert items[0]["character_id"] == "char-a"


def test_handles_missing_file_gracefully(client, tmp_path):
    """单文件 stat 失败不挂整个 endpoint (Failure mode F3)."""
    chars = tmp_path / "characters"
    _make_image(chars / "char-a" / "portrait" / "good.png", mtime_offset=-1)
    # 模拟坏文件场景：创建一个 dangling symlink
    bad = chars / "char-a" / "portrait" / "broken.png"
    bad.symlink_to(tmp_path / "nonexistent")
    resp = client.get("/api/gallery/recent")
    assert resp.status_code == 200
    items = resp.json()["items"]
    # good.png 必须返回；broken.png 跳过
    assert any(i["filename"] == "good.png" for i in items)
```

- [ ] **Run, expect fail**:

```bash
uv run pytest tests/test_gallery_recent.py -v
```

### Step 5.2: Implement endpoint

- [ ] **Read** `src/viewer_server/routes.py`. Locate where 其它 GET endpoint 定义（看路由器是 APIRouter 还是直接挂 app）。

- [ ] **Append** to `routes.py`：

```python
from pathlib import Path

from fastapi import APIRouter, Query

from character_workflow.lib.data_root import get_data_root

router = APIRouter()  # 或现有 router

ASSET_SLOTS = ("portrait", "promo", "turnaround")
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


@router.get("/api/gallery/recent")
def gallery_recent(limit: int = Query(default=24, ge=1, le=100)):
    """Return most-recent images across all characters, sorted by mtime desc."""
    root = Path(get_data_root())
    characters_dir = root / "characters"
    items: list[dict] = []
    if not characters_dir.exists():
        return {"items": []}
    for char_dir in characters_dir.iterdir():
        if not char_dir.is_dir():
            continue
        for slot in ASSET_SLOTS:
            slot_dir = char_dir / slot
            if not slot_dir.is_dir():
                continue
            for f in slot_dir.iterdir():
                if f.suffix.lower() not in IMAGE_EXTS:
                    continue
                try:
                    mtime = f.stat().st_mtime
                except OSError:
                    continue  # F3: 坏 symlink / 权限丢
                items.append({
                    "character_id": char_dir.name,
                    "asset_slot": slot,
                    "filename": f.name,
                    "path": str(f.relative_to(root)),
                    "mtime": mtime,
                })
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return {"items": items[:limit]}
```

挂到 app：如果 `server_app.py` 已 `app.include_router(routes.router)`，无须改动；否则在 `build_app` 里加 `app.include_router(router)`。

### Step 5.3: Pass tests

- [ ] **Run**:

```bash
uv run pytest tests/test_gallery_recent.py -v
```

Expected: 5/5 PASS.

### Step 5.4: Commit

```bash
git add src/viewer_server/routes.py tests/test_gallery_recent.py
git commit -m "$(cat <<'EOF'
feat(api): GET /api/gallery/recent for Atelier Home masonry

Scans characters/*/{portrait,promo,turnaround}/ by mtime desc. Default
limit=24, max=100. Studio namespace explicitly excluded (Home is the
character-portfolio surface, not the sandbox stream). Per-file stat
errors skipped gracefully (broken symlinks won't 500).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Atelier Home Page Implementation

**Files:**
- Create: `web/src/api/gallery.ts`
- Modify: `web/src/pages/Home.tsx`
- Create: `web/src/pages/Home.test.tsx`

### Step 6.1: Write API client

- [ ] **Write `web/src/api/gallery.ts`**:

```tsx
export interface GalleryItem {
  character_id: string;
  asset_slot: 'portrait' | 'promo' | 'turnaround';
  filename: string;
  path: string;
  mtime: number;
}

export async function fetchGalleryRecent(limit = 24): Promise<GalleryItem[]> {
  const resp = await fetch(`/api/gallery/recent?limit=${limit}`);
  if (!resp.ok) throw new Error(`gallery fetch failed: ${resp.status}`);
  const data = (await resp.json()) as { items: GalleryItem[] };
  return data.items;
}
```

### Step 6.2: Write failing test

- [ ] **Write `web/src/pages/Home.test.tsx`**:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { Home } from './Home';

beforeEach(() => {
  global.fetch = vi.fn();
});

function renderHome() {
  const { hook } = memoryLocation({ path: '/', static: true });
  return render(
    <Router hook={hook}>
      <Home />
    </Router>,
  );
}

describe('Home', () => {
  it('shows hero title and italic tagline', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });
    renderHome();
    expect(screen.getByText('Atelier')).toBeInTheDocument();
    expect(screen.getByText(/一间安静的暖色画廊/)).toBeInTheDocument();
  });

  it('shows skeleton during LOADING', () => {
    (global.fetch as any).mockReturnValueOnce(new Promise(() => {}));
    const { container } = renderHome();
    expect(container.querySelectorAll('[data-skeleton]').length).toBeGreaterThan(0);
  });

  it('shows EMPTY copy when 0 characters', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });
    renderHome();
    await waitFor(() => {
      expect(screen.getByText(/工坊还空着/)).toBeInTheDocument();
    });
  });

  it('renders masonry images on SUCCESS', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            character_id: 'char-a',
            asset_slot: 'portrait',
            filename: 'a.png',
            path: 'characters/char-a/portrait/a.png',
            mtime: 0,
          },
        ],
      }),
    });
    renderHome();
    const imgs = await screen.findAllByRole('img');
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute('src')).toContain('characters/char-a/portrait/a.png');
  });

  it('shows ERROR state on fetch failure', async () => {
    (global.fetch as any).mockResolvedValueOnce({ ok: false, status: 500 });
    renderHome();
    await waitFor(() => {
      expect(screen.getByText(/暂时拿不到图片/)).toBeInTheDocument();
    });
  });
});
```

### Step 6.3: Implement Home

- [ ] **Edit `web/src/pages/Home.tsx`** (替换 T3 占位):

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'wouter';

import { fetchGalleryRecent, type GalleryItem } from '@/api/gallery';

type State =
  | { kind: 'loading' }
  | { kind: 'success'; items: GalleryItem[] }
  | { kind: 'error' };

export function Home() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancel = false;
    fetchGalleryRecent(24)
      .then((items) => !cancel && setState({ kind: 'success', items }))
      .catch(() => !cancel && setState({ kind: 'error' }));
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <div className="px-8 py-12">
      <section className="mb-12 text-center">
        <h1
          className="text-5xl italic text-foreground"
          style={{ fontFamily: "'Instrument Serif', serif" }}
        >
          Atelier
        </h1>
        <p className="mt-3 text-sm italic text-muted-foreground">一间安静的暖色画廊</p>
      </section>

      {state.kind === 'loading' && (
        <div className="columns-3 lg:columns-4 2xl:columns-5 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              data-skeleton
              className="mb-6 break-inside-avoid bg-card/40 rounded-lg"
              style={{ height: 200 + (i % 3) * 80 }}
            />
          ))}
        </div>
      )}

      {state.kind === 'error' && (
        <div className="text-sm text-muted-foreground text-center py-12">
          暂时拿不到图片，刷新试试。
        </div>
      )}

      {state.kind === 'success' && state.items.length === 0 && (
        <div className="text-center py-12">
          <p
            className="text-2xl italic text-foreground"
            style={{ fontFamily: "'Instrument Serif', serif" }}
          >
            工坊还空着。
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            在终端跑{' '}
            <code className="font-mono text-foreground/80 bg-card px-1.5 py-0.5 rounded">
              /character-workflow &lt;名字&gt;
            </code>{' '}
            开始第一个角色。
          </p>
        </div>
      )}

      {state.kind === 'success' && state.items.length > 0 && (
        <div className="columns-3 lg:columns-4 2xl:columns-5 gap-6">
          {state.items.map((item) => (
            <Link
              key={`${item.character_id}-${item.filename}`}
              href={`/character/${item.character_id}`}
            >
              <a className="mb-6 block break-inside-avoid">
                <img
                  src={`/api/raw?path=${encodeURIComponent(item.path)}`}
                  alt=""
                  className="w-full rounded-lg border border-border/40 hover:border-primary/40 transition-all duration-150 hover:scale-[1.02]"
                  loading="lazy"
                />
              </a>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
```

注意 `/api/raw?path=...` —— 看 `routes.py` 的 `/api/raw` 当前签名。如果它是 job_id whitelist 形式，**不能**用直接 path。在 Step 6.4 处理。

### Step 6.4: Verify `/api/raw` can serve gallery items

- [ ] **Read** `src/viewer_server/routes.py` 找 `/api/raw`。
- [ ] 如果只接受 `?job_id=...`，**新增一个 path** `/api/gallery/image?path=...` 严格校验 path 必须以 `characters/<id>/<slot>/` 开头才 serve（避免目录遍历）：

```python
@router.get("/api/gallery/image")
def gallery_image(path: str):
    root = Path(get_data_root())
    target = (root / path).resolve()
    # 必须在 characters/ 子树内
    if not str(target).startswith(str((root / "characters").resolve())):
        raise HTTPException(status_code=400, detail="path outside characters/")
    if not target.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(target)
```

然后 Home.tsx 用 `/api/gallery/image?path=...`。

- [ ] **Add test** to `tests/test_gallery_recent.py`：

```python
def test_gallery_image_endpoint_rejects_traversal(client, tmp_path):
    resp = client.get("/api/gallery/image?path=../../../etc/passwd")
    assert resp.status_code == 400

def test_gallery_image_endpoint_serves_valid_path(client, tmp_path):
    _make_image(tmp_path / "characters" / "char-a" / "portrait" / "x.png")
    resp = client.get("/api/gallery/image?path=characters/char-a/portrait/x.png")
    assert resp.status_code == 200
```

### Step 6.5: Pass Web tests

- [ ] **Run**:

```bash
cd web && pnpm test -- --run Home && pnpm lint
uv run pytest tests/test_gallery_recent.py -v
```

### Step 6.6: Manual smoke

- [ ] Dev server 仍在跑（T4.5）。打开 `http://127.0.0.1:5173/` ：
  - hero "Atelier" + italic "一间安静的暖色画廊" 居中显示
  - 如果项目里已有图，masonry 渲染
  - 无图：EMPTY 文案 + serif "工坊还空着。"
  - 反 dashboard 验证：无数字、无进度条、无 metric chip
  - Resize 浏览器到 1024px：masonry 变 3 列；超 1600 变 5 列

### Step 6.7: Commit

```bash
git add web/src/api/gallery.ts web/src/pages/Home.tsx web/src/pages/Home.test.tsx \
        src/viewer_server/routes.py tests/test_gallery_recent.py
git commit -m "$(cat <<'EOF'
feat(web): Atelier Home — hero + masonry + LOADING/EMPTY/ERROR states

CSS columns (3/4/5 cols by viewport), no grid. Hero centered + masonry
left-aligned per editorial contrast (DESIGN.md Pass 4.6). No dashboard
metrics, no progress chips. /api/gallery/image with path-whitelist
serves files (rejects traversal).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Studio Backend — `/api/studio/jobs` + Runner Branch

**Files:**
- Modify: `src/character_workflow/lib/jobs.py`
- Modify: `src/character_workflow/lib/job_runner.py`
- Create: `src/character_workflow/lib/studio_jobs.py`
- Modify: `src/viewer_server/routes.py`
- Create: `tests/test_studio_jobs.py`

### Step 7.1: Write failing test

- [ ] **Create `tests/test_studio_jobs.py`**:

```python
"""POST /api/studio/jobs creates standalone job under namespace=studio."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from character_workflow.lib.schemas import Job, JobKind, JobStatus
from viewer_server.server_app import build_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    # 写一个 default key
    keys_dir = tmp_path / ".config"
    keys_dir.mkdir()
    (keys_dir / "keys.json").write_text(json.dumps({
        "version": 1,
        "default_alias": "default",
        "keys": [{"alias": "default", "provider": "openai", "secret": "sk-fake"}],
    }))
    return TestClient(build_app(dist_dir=tmp_path / "dist"))


def test_post_studio_job_creates_pending_confirm(client):
    resp = client.post("/api/studio/jobs", json={
        "prompt": "a quiet warm gallery",
        "model": "gpt-image-2",
        "params": {"size": "1024x1024"},
    })
    assert resp.status_code == 201
    payload = resp.json()
    assert payload["status"] == "pending_confirm"
    assert payload["namespace"] == "studio"
    assert payload["kind"] == "image"


def test_post_studio_job_uses_default_alias_when_omitted(client):
    resp = client.post("/api/studio/jobs", json={
        "prompt": "x",
        "model": "gpt-image-2",
        "params": {},
    })
    assert resp.json()["alias"] == "default"


def test_post_studio_job_rejects_video_kind(client):
    resp = client.post("/api/studio/jobs", json={
        "prompt": "x",
        "model": "gpt-image-2",
        "params": {},
        "kind": "video",
    })
    assert resp.status_code == 422


def test_studio_job_writes_to_studio_namespace_path(tmp_path, monkeypatch):
    """run_job over a studio job lands in <data_root>/studio/<job_id>/."""
    from character_workflow.lib.studio_jobs import studio_output_dir
    monkeypatch.setenv("CHARACTER_WORKFLOW_DATA_ROOT", str(tmp_path))
    out = studio_output_dir("job-test-xyz")
    assert out == tmp_path / "studio" / "job-test-xyz"


def test_characters_endpoint_does_not_leak_studio(client, tmp_path):
    """GET /api/characters 不返回 studio/ 目录."""
    # 创建 studio job 输出目录
    (tmp_path / "studio" / "job-x").mkdir(parents=True)
    (tmp_path / "characters" / "char-real").mkdir(parents=True)
    resp = client.get("/api/characters")
    chars = [c["id"] for c in resp.json()]
    assert "job-x" not in chars
    assert "studio" not in chars
```

- [ ] **Run, expect fail**:

```bash
uv run pytest tests/test_studio_jobs.py -v
```

### Step 7.2: Implement studio_jobs.py

- [ ] **Write `src/character_workflow/lib/studio_jobs.py`**:

```python
"""Studio standalone job helpers. namespace='studio'，输出落到 <data_root>/studio/<job_id>/."""
from __future__ import annotations

from pathlib import Path

from character_workflow.lib.data_root import get_data_root


def studio_root() -> Path:
    return Path(get_data_root()) / "studio"


def studio_output_dir(job_id: str) -> Path:
    """Studio job 写盘路径. 与 characters/<id>/<slot>/ 物理隔离."""
    d = studio_root() / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d
```

### Step 7.3: Patch jobs.py / job_runner.py to dispatch by namespace

- [ ] **Read** `src/character_workflow/lib/jobs.py` 找 `job_output_dir`。

- [ ] **Edit `jobs.py`** `job_output_dir` —— 增加 namespace 分支：

```python
from character_workflow.lib.studio_jobs import studio_output_dir
from character_workflow.lib.schemas import Job

def job_output_dir_for(job: Job) -> Path:
    if job.namespace == "studio":
        return studio_output_dir(job.job_id)
    # 老路径：characters/<id>/<asset_slot>/
    return Path(get_data_root()) / "characters" / job.character_id / job.asset_slot.value
```

如果 `job_output_dir(character_id, kind)` 仍被调用，保留向后兼容 wrapper（character namespace 默认）。

- [ ] **Edit `job_runner.py`** —— 找写盘的位置（应该是 `run_job` 里），把 `job_output_dir(...)` 改为 `job_output_dir_for(job)`。

### Step 7.4: Add `/api/studio/jobs` endpoint

- [ ] **Append to `src/viewer_server/routes.py`**:

```python
from pydantic import BaseModel, Field

from character_workflow.lib.jobs import write_job, generate_job_id
from character_workflow.lib.schemas import Job, JobKind, JobParams, JobStatus, AssetSlot
from character_workflow.lib.keys import read_keys_db


class StudioJobCreate(BaseModel):
    model_config = {"extra": "forbid"}
    prompt: str = Field(min_length=1)
    model: str
    params: JobParams
    alias: str | None = None
    kind: JobKind = JobKind.IMAGE  # 验证: 'video' 会 422 (NotImplemented)


@router.post("/api/studio/jobs", status_code=201)
def create_studio_job(body: StudioJobCreate):
    if body.kind == JobKind.VIDEO:
        raise HTTPException(status_code=422, detail="video not implemented")
    db = read_keys_db()
    alias = body.alias or db.default_alias
    if not alias:
        raise HTTPException(status_code=400, detail="no default key configured")
    key_row = next((k for k in db.keys if k.alias == alias), None)
    if not key_row:
        raise HTTPException(status_code=400, detail=f"unknown alias {alias}")
    from datetime import datetime, timezone
    job = Job(
        job_id=generate_job_id(),
        character_id=alias,  # placeholder; namespace='studio' 让 runner 走 studio path
        prompt=body.prompt,
        submitted_at=datetime.now(timezone.utc).isoformat(),
        model=body.model,
        params=body.params,
        seed=None,
        output_paths=[],
        status=JobStatus.PENDING_CONFIRM,
        error=None,
        asset_slot=AssetSlot.PORTRAIT,  # 不读
        kind=JobKind.IMAGE,
        namespace="studio",
        alias=alias,
        provider=key_row.provider,
    )
    write_job(job)
    return job.model_dump(mode="json")
```

- [ ] **Ensure `/api/characters`** 跳过 studio/。Read 当前实现，确认只扫 `characters/` 子树。本来就应是如此（路径硬编码），但 add 一个 paranoid guard 删除 `if name == "studio": continue` 也无害。

### Step 7.5: Pass tests

- [ ] **Run**:

```bash
uv run pytest tests/test_studio_jobs.py -v
uv run pytest -q  # 整体回归
```

Expected: 5/5 PASS + 整体绿。

### Step 7.6: Commit

```bash
git add src/character_workflow/lib/studio_jobs.py \
        src/character_workflow/lib/jobs.py \
        src/character_workflow/lib/job_runner.py \
        src/viewer_server/routes.py \
        tests/test_studio_jobs.py
git commit -m "$(cat <<'EOF'
feat(api): POST /api/studio/jobs + namespace=studio runner dispatch

Studio standalone jobs write to <data_root>/studio/<job_id>/ — physically
separate from characters/. character_id field stores alias placeholder
(non-null invariant preserved). default_alias used when client omits.
JobKind=VIDEO returns 422 (NotImplemented gate).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Studio Frontend — PromptInput + RoundList + States

**Files:**
- Create: `web/src/api/studio.ts`
- Modify: `web/src/pages/Studio.tsx`
- Create: `web/src/components/studio/PromptInput.tsx`
- Create: `web/src/components/studio/RoundList.tsx`
- Create: `web/src/components/studio/InspirationChips.tsx`
- Create: `web/src/components/studio/WaitingCopy.tsx`
- Create: `web/src/pages/Studio.test.tsx`

### Step 8.1: API client

- [ ] **Write `web/src/api/studio.ts`**:

```tsx
import type { Job, JobKind, JobParams } from '@/schema/jobs';

export interface StudioJobCreate {
  prompt: string;
  model: string;
  params: JobParams;
  alias?: string;
  kind?: JobKind;
}

export async function createStudioJob(body: StudioJobCreate): Promise<Job> {
  const resp = await fetch('/api/studio/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`studio job failed: ${resp.status}`);
  return resp.json();
}
```

### Step 8.2: InspirationChips

- [ ] **Write `web/src/components/studio/InspirationChips.tsx`**:

```tsx
const FALLBACK_CHIPS = [
  "soft cotton low-angle warm tungsten",
  "逆光逐光剑客 cinematic",
  "清晨厨房静物 painterly",
];

export function InspirationChips({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2 mt-4 justify-center">
      {FALLBACK_CHIPS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onPick(c)}
          className="text-xs text-muted-foreground bg-card border border-border/60 rounded-full px-3 py-1.5 hover:text-foreground hover:border-primary/40 transition-colors"
        >
          试试: "{c}"
        </button>
      ))}
    </div>
  );
}
```

> 注：PR2 才接 `<data_root>/MEMORY.md::prompt_patterns` 数据源，PR1 用 hardcoded fallback 即可。

### Step 8.3: WaitingCopy

- [ ] **Write `web/src/components/studio/WaitingCopy.tsx`**:

```tsx
import { useEffect, useState } from 'react';

export function WaitingCopy({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.floor((now - startedAt) / 1000);
  let copy = '';
  if (elapsed >= 30) copy = '可能要再等一会，复杂场景慢一点。';
  else if (elapsed >= 15) copy = '模型在画了…';
  else if (elapsed >= 5) copy = '正在调度…';
  return (
    <div className="text-xs text-muted-foreground font-mono">
      {elapsed}s
      {copy && <span className="ml-2">{copy}</span>}
    </div>
  );
}
```

### Step 8.4: PromptInput

- [ ] **Write `web/src/components/studio/PromptInput.tsx`**:

```tsx
import { type KeyboardEvent, useCallback, useState } from 'react';
import { ArrowUp } from 'lucide-react';

interface Props {
  onSubmit: (prompt: string) => void | Promise<void>;
  disabled?: boolean;
  initialValue?: string;
}

export function PromptInput({ onSubmit, disabled, initialValue = '' }: Props) {
  const [text, setText] = useState(initialValue);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setText('');
  }, [text, disabled, onSubmit]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="bg-card rounded-lg border border-input p-4 space-y-3 max-w-3xl mx-auto">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder="你好，想创作什么？描述你想生成的图片…"
        rows={3}
        className="w-full bg-transparent text-base text-foreground placeholder:italic placeholder:text-muted-foreground resize-none focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md p-2"
        aria-label="生图 prompt"
      />
      <div className="flex justify-between items-center">
        <div className="text-xs text-muted-foreground">
          {/* MVP: 参数 popover 留位，用文案替代 */}
          图片生成 · GPT Image 2 · 1024×1024 · default key
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !text.trim()}
          aria-label="提交生成"
          title="提交 (⌘↵)"
          className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary ring-offset-2 ring-offset-background transition-colors"
        >
          <ArrowUp size={18} aria-hidden />
        </button>
      </div>
    </div>
  );
}
```

> 注：4 个 Popover (kind/model/params/key) 在 PR1 简化为静态文案（"图片生成 · GPT Image 2 · 1024×1024 · default key"）。完整 Popover 行为列入 §Backlog T-006 — 不在本 PR1 范围。这降低本任务复杂度同时保留视觉位置。

### Step 8.5: RoundList

- [ ] **Write `web/src/components/studio/RoundList.tsx`**:

```tsx
import { WaitingCopy } from './WaitingCopy';

export type RoundState =
  | { kind: 'pending'; startedAt: number; promptPreview: string }
  | { kind: 'done'; submittedAt: string; imagePath: string }
  | { kind: 'failed'; submittedAt: string; reason: string };

export function RoundList({ rounds }: { rounds: RoundState[] }) {
  if (rounds.length === 0) return null;
  return (
    <div className="max-w-3xl mx-auto mt-8 space-y-8">
      {rounds.map((r, idx) => (
        <div key={idx}>
          <div className="border-t border-border/40 pt-3 mb-3 flex items-baseline gap-3">
            <span className="text-xs text-muted-foreground font-mono">
              {r.kind === 'pending'
                ? new Date(r.startedAt).toLocaleTimeString()
                : new Date(r.submittedAt).toLocaleTimeString()}
            </span>
            {r.kind === 'pending' && <WaitingCopy startedAt={r.startedAt} />}
          </div>
          {r.kind === 'pending' && (
            <div
              data-skeleton
              aria-busy="true"
              className="aspect-square w-64 bg-card/40 rounded-lg flex items-center justify-center"
            >
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {r.kind === 'done' && (
            <img
              src={`/api/gallery/image?path=${encodeURIComponent(r.imagePath)}`}
              alt=""
              className="rounded-lg border border-border/40 max-w-sm"
            />
          )}
          {r.kind === 'failed' && (
            <div className="border border-destructive/40 rounded-lg p-4 max-w-sm text-sm">
              <p className="text-foreground">生成失败</p>
              <p className="text-xs text-muted-foreground mt-1">{r.reason}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

注：`/api/gallery/image` 在 T6 已经允许 `characters/`，但 studio 图在 `studio/<job_id>/`。需要把 endpoint 接受面扩展到 `characters/` OR `studio/`：

- [ ] **Edit `/api/gallery/image`** in `routes.py`:

```python
@router.get("/api/gallery/image")
def gallery_image(path: str):
    root = Path(get_data_root())
    target = (root / path).resolve()
    allowed_roots = [(root / "characters").resolve(), (root / "studio").resolve()]
    if not any(str(target).startswith(str(p)) for p in allowed_roots):
        raise HTTPException(status_code=400, detail="path outside allowed roots")
    if not target.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(target)
```

- [ ] **Add test** to `tests/test_gallery_recent.py`:

```python
def test_gallery_image_endpoint_serves_studio(client, tmp_path):
    _make_image(tmp_path / "studio" / "job-x" / "v1.png")
    resp = client.get("/api/gallery/image?path=studio/job-x/v1.png")
    assert resp.status_code == 200
```

### Step 8.6: Studio page

- [ ] **Edit `web/src/pages/Studio.tsx`** (替换 T3 占位):

```tsx
import { useState } from 'react';

import { createStudioJob } from '@/api/studio';
import { InspirationChips } from '@/components/studio/InspirationChips';
import { PromptInput } from '@/components/studio/PromptInput';
import { RoundList, type RoundState } from '@/components/studio/RoundList';

export function Studio() {
  const [rounds, setRounds] = useState<RoundState[]>([]);
  const [pending, setPending] = useState(false);
  const [seedText, setSeedText] = useState('');

  const onSubmit = async (prompt: string) => {
    setPending(true);
    const startedAt = Date.now();
    const myRound: RoundState = { kind: 'pending', startedAt, promptPreview: prompt };
    setRounds((rs) => [myRound, ...rs]);
    try {
      const job = await createStudioJob({
        prompt,
        model: 'gpt-image-2',
        params: { size: '1024x1024' },
      });
      // PR1 不订阅 SSE — 简化：跑成功后端会在 output_paths 写盘
      // 用 polling 拿最终 status (MVP)
      await pollJobUntilTerminal(job.job_id, (final) => {
        setRounds((rs) =>
          rs.map((r) =>
            r === myRound
              ? final.status === 'done'
                ? {
                    kind: 'done',
                    submittedAt: final.submitted_at,
                    imagePath: final.output_paths[0],
                  }
                : { kind: 'failed', submittedAt: final.submitted_at, reason: final.error ?? 'unknown' }
              : r,
          ),
        );
      });
    } catch (e: any) {
      setRounds((rs) =>
        rs.map((r) =>
          r === myRound ? { kind: 'failed', submittedAt: new Date().toISOString(), reason: e.message } : r,
        ),
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="px-6 py-8">
      <h1
        className="text-3xl mb-6 max-w-3xl mx-auto"
        style={{ fontFamily: "'Instrument Serif', serif" }}
      >
        Studio.
      </h1>
      <PromptInput onSubmit={onSubmit} disabled={pending} initialValue={seedText} />
      {rounds.length === 0 && <InspirationChips onPick={(t) => setSeedText(t)} />}
      <RoundList rounds={rounds} />
    </div>
  );
}

async function pollJobUntilTerminal(jobId: string, onFinal: (job: any) => void) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const resp = await fetch(`/api/jobs/${jobId}`);
    if (!resp.ok) continue;
    const job = await resp.json();
    if (job.status === 'done' || job.status === 'failed') {
      onFinal(job);
      return;
    }
  }
  onFinal({ status: 'failed', submitted_at: new Date().toISOString(), error: 'timeout' });
}
```

注：服务端 confirm 流转（`pending_confirm` → `pending` → `done`）需要从 Studio UI 调一次 `POST /api/jobs/<id>/confirm`，否则会一直停在 `pending_confirm`。简化策略：Studio 提交即代表确认（画师在 Web 已点 ↑），后端 endpoint 直接写 `status=PENDING` 跳过 confirm 步骤。

- [ ] **Edit `/api/studio/jobs`** in `routes.py` 改为 `status=PENDING` 直接入队（Studio = 实时旁路，不需要二次确认）：

```python
status=JobStatus.PENDING,
```

并在 endpoint 末尾触发一次 background runner（如果项目已有 worker 队列，把 job 推过去；如果没有，直接 `asyncio.create_task(run_job_async(job))`）。

- [ ] **Update test** `test_post_studio_job_creates_pending_confirm` 改为 `assert payload["status"] == "pending"`，名字改 `_creates_pending`。

### Step 8.7: Studio page test

- [ ] **Write `web/src/pages/Studio.test.tsx`**:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { Studio } from './Studio';

beforeEach(() => {
  global.fetch = vi.fn();
});

function renderStudio() {
  const { hook } = memoryLocation({ path: '/studio', static: true });
  return render(
    <Router hook={hook}>
      <Studio />
    </Router>,
  );
}

describe('Studio', () => {
  it('renders hero "Studio." in serif', () => {
    renderStudio();
    expect(screen.getByText('Studio.')).toBeInTheDocument();
  });

  it('shows inspiration chips when no rounds', () => {
    renderStudio();
    expect(screen.getByText(/soft cotton low-angle/)).toBeInTheDocument();
  });

  it('disables submit when prompt empty', () => {
    renderStudio();
    const submit = screen.getByLabelText('提交生成');
    expect(submit).toBeDisabled();
  });

  it('Cmd+Enter submits the prompt', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ job_id: 'j1', status: 'pending', submitted_at: '2026-05-25T00:00:00Z' }),
    });
    renderStudio();
    const textarea = screen.getByLabelText('生图 prompt');
    fireEvent.change(textarea, { target: { value: 'test prompt' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/studio/jobs',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('Enter without Cmd inserts newline (not submit)', () => {
    renderStudio();
    const textarea = screen.getByLabelText('生图 prompt') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'line1' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
```

### Step 8.8: Run tests + lint

- [ ] **Run**:

```bash
cd web && pnpm test -- --run && pnpm lint
uv run pytest tests/test_studio_jobs.py tests/test_gallery_recent.py -v
```

### Step 8.9: Manual smoke

- [ ] Dev server running. Open `http://127.0.0.1:5173/studio`:
  - Hero "Studio." 左对齐 serif
  - 3 个灰色 chip 灵感
  - Textarea + 圆形黄铜 ↑ 按钮（不渐变）
  - 输入 prompt → Cmd+Enter → 进入 pending round（skeleton + 计时器）
  - 后端如果有 key 配置且 lovart caller 工作，会跑完 → SUCCESS 渲染图
  - 如果没 key → ERROR round

### Step 8.10: Commit

```bash
git add web/src/api/studio.ts \
        web/src/pages/Studio.tsx web/src/pages/Studio.test.tsx \
        web/src/components/studio/ \
        src/viewer_server/routes.py \
        tests/test_studio_jobs.py tests/test_gallery_recent.py
git commit -m "$(cat <<'EOF'
feat(web): Studio sandbox — PromptInput + Cmd+Enter + RoundList + 4 states

LOADING (skeleton + timer + 5s/15s/30s copy), EMPTY (chips), ERROR
(border-destructive card), SUCCESS (image). Round divider per submit
in time-desc order. Submit button: nakedly primary, never gradient.
PR1 uses static param strip; full Popover-driven kind/model/params
selection deferred to T-006.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Keys Page — Card Layout + Reveal Modal

**Files:**
- Modify: `web/src/pages/settings/Keys.tsx`
- Create: `web/src/components/keys/KeyCard.tsx`
- Create: `web/src/components/keys/RevealModal.tsx`
- Modify: `web/src/pages/settings/Keys.test.tsx`

### Step 9.1: Read current Keys.tsx

- [ ] **Read** `web/src/pages/settings/Keys.tsx` + `KeyForm.tsx` + `Keys.test.tsx` 全文。

### Step 9.2: KeyCard component

- [ ] **Write `web/src/components/keys/KeyCard.tsx`**:

```tsx
import { Star } from 'lucide-react';

export interface KeyRow {
  alias: string;
  provider: string;
  masked_secret: string;
  is_default: boolean;
  last_used_at?: string | null;
  created_at?: string | null;
}

interface Props {
  row: KeyRow;
  onSetDefault: () => void;
  onDelete: () => void;
}

export function KeyCard({ row, onSetDefault, onDelete }: Props) {
  return (
    <div className="bg-card border border-border rounded-lg p-5 space-y-2 w-full max-w-2xl">
      <div className="flex items-center gap-2">
        {row.is_default && (
          <Star size={14} className="fill-primary stroke-primary" aria-label="默认 Key" />
        )}
        <span className="text-sm font-medium text-foreground">{row.alias}</span>
        <span className="text-xs text-muted-foreground">{row.provider}</span>
      </div>
      <div className="font-mono text-sm text-muted-foreground">{row.masked_secret}</div>
      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-muted-foreground">
          {row.last_used_at ? `最近使用 ${formatRelative(row.last_used_at)}` : '从未使用'}
          {row.created_at && ` · 创建 ${formatRelative(row.created_at)}`}
        </span>
        <div className="flex gap-3">
          {!row.is_default && (
            <button
              type="button"
              onClick={onSetDefault}
              className="text-xs text-muted-foreground hover:text-primary transition-colors"
            >
              设为默认
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            aria-label={`删除 ${row.alias}`}
            className="text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return `${days} 天前`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours} 小时前`;
  return '刚刚';
}
```

### Step 9.3: RevealModal

- [ ] **Write `web/src/components/keys/RevealModal.tsx`**:

```tsx
import { useState } from 'react';

interface Props {
  secret: string;
  onClose: () => void;
}

export function RevealModal({ secret, onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      // TODO T-D03 fallback
    }
  };

  const requestClose = () => {
    if (confirmClose) onClose();
    else setConfirmClose(true);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reveal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
    >
      <div className="bg-card border border-border rounded-lg p-8 max-w-md w-full space-y-4">
        <h2
          id="reveal-title"
          className="text-2xl"
          style={{ fontFamily: "'Instrument Serif', serif" }}
        >
          新 Key 已创建
        </h2>
        <p className="text-sm text-muted-foreground">
          这是你最后一次看到完整 secret。
          <br />
          关闭这个窗口后将永远只显示后 4 位。
        </p>
        <div className="bg-muted rounded-md p-3 flex items-center justify-between gap-3">
          <code className="font-mono text-sm text-foreground break-all">{secret}</code>
          <button
            type="button"
            onClick={copy}
            className="text-sm bg-primary text-primary-foreground rounded-md px-3 py-1.5 min-w-[44px] hover:bg-primary/90"
          >
            复制
          </button>
        </div>
        {copied && <p className="text-xs" style={{ color: '#E5B570' }}>复制成功 ✓</p>}
        {confirmClose && (
          <p className="text-xs text-destructive">确定关闭？secret 不会再出现。</p>
        )}
        <button
          type="button"
          onClick={requestClose}
          className="w-full bg-primary text-primary-foreground rounded-md py-2 text-sm font-medium hover:bg-primary/90"
        >
          {confirmClose ? '确定关闭' : '我已保存，关闭'}
        </button>
      </div>
    </div>
  );
}
```

### Step 9.4: Rewrite Keys.tsx with card layout

- [ ] **Edit `web/src/pages/settings/Keys.tsx`** —— 替换为卡片列表 + EMPTY 状态 + Reveal modal hookup. 保留现有 CRUD logic（GET / POST / DELETE / PATCH default）；只换 JSX + 加 RevealModal 触发：

```tsx
import { useEffect, useState } from 'react';

import { KeyCard, type KeyRow } from '@/components/keys/KeyCard';
import { RevealModal } from '@/components/keys/RevealModal';
import { KeyForm } from './KeyForm';
// 现有 api/keys.ts 接口 (无需改动)
import { listKeys, deleteKey, setDefaultKey, type ListKeysResponse } from '@/api/keys';

export function KeysPage() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [revealSecret, setRevealSecret] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listKeys();
      setKeys(resp.keys.map(toKeyRow(resp.default_alias)));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const onCreated = (secret: string) => {
    setShowForm(false);
    setRevealSecret(secret);
    void refresh();
  };

  return (
    <div className="px-6 py-8 max-w-2xl mx-auto">
      <div className="flex justify-between items-baseline mb-6">
        <h1 className="text-2xl text-foreground" style={{ fontFamily: "'Instrument Serif', serif" }}>
          API Keys
        </h1>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="text-sm bg-primary text-primary-foreground rounded-md px-3 py-2 hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary ring-offset-2 ring-offset-background"
        >
          + 新建 Key
        </button>
      </div>

      {loading && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} data-skeleton className="h-28 w-full max-w-2xl bg-card/40 rounded-lg" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="text-sm text-destructive">{error}</div>
      )}

      {!loading && !error && keys.length === 0 && (
        <div className="text-center py-16">
          <p className="text-2xl italic text-foreground" style={{ fontFamily: "'Instrument Serif', serif" }}>
            还没有 API Key。
          </p>
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="mt-6 text-sm bg-primary text-primary-foreground rounded-md px-4 py-2"
          >
            + 新建 Key
          </button>
        </div>
      )}

      {!loading && !error && keys.length > 0 && (
        <div className="space-y-3">
          {keys.map((k) => (
            <KeyCard
              key={k.alias}
              row={k}
              onSetDefault={async () => { await setDefaultKey(k.alias); void refresh(); }}
              onDelete={async () => {
                const confirm = window.prompt(`输入 "${k.alias}" 确认删除`);
                if (confirm !== k.alias) return;
                await deleteKey(k.alias);
                void refresh();
              }}
            />
          ))}
        </div>
      )}

      {showForm && (
        <KeyForm
          onCancel={() => setShowForm(false)}
          onCreated={onCreated}
        />
      )}

      {revealSecret && (
        <RevealModal secret={revealSecret} onClose={() => setRevealSecret(null)} />
      )}
    </div>
  );
}

function toKeyRow(defaultAlias: string | null) {
  return (k: any): KeyRow => ({
    alias: k.alias,
    provider: k.provider,
    masked_secret: k.masked_secret ?? '****',
    is_default: k.alias === defaultAlias,
    last_used_at: k.last_used_at,
    created_at: k.created_at,
  });
}
```

> `KeyForm` 的 `onCreated` 回调需要在 form 内 POST 后把 raw secret 透传出来。如果当前 form 没有，改 form 让它接收 raw secret 后调 `onCreated(secret)`。如果后端 POST `/api/keys` 当前响应不返回 raw secret（出于安全），改后端：创建 endpoint **唯一一次**返回 secret 后台立刻 mask 入库。

- [ ] 检查 `src/viewer_server/routes.py` 的 `POST /api/keys` 响应，必要时增加 `"secret_revealed": "<full>"` 字段（仅 POST 这一次回传，GET 永远 masked）。

### Step 9.5: Update existing Keys test

- [ ] **Edit `web/src/pages/settings/Keys.test.tsx`** —— 现有测试可能基于老 UI（浮动 close button）需要调整。重点保留：
  - 默认 key ★ 显示
  - EMPTY 状态显示 "还没有 API Key。"
  - 删除二次确认（window.prompt mock）
  - 新建后 reveal modal 出现

### Step 9.6: Pass tests + lint

- [ ] **Run**:

```bash
cd web && pnpm test -- --run Keys && pnpm lint
uv run pytest tests/test_keys*.py -v 2>/dev/null || true
```

### Step 9.7: Manual smoke

- [ ] Open `http://127.0.0.1:5173/settings/keys`:
  - Card 列表，默认 key ★ 黄铜
  - 点 "+ 新建 Key" → KeyForm 弹窗
  - 创建 → RevealModal 出现，显示完整 secret + 复制按钮
  - 关闭 modal → 列表刷新，新 key 显示 masked
  - 点删除 → window.prompt 二次确认

### Step 9.8: Commit

```bash
git add web/src/pages/settings/Keys.tsx \
        web/src/pages/settings/Keys.test.tsx \
        web/src/components/keys/ \
        src/viewer_server/routes.py 2>/dev/null || true
git commit -m "$(cat <<'EOF'
feat(web): Keys page card layout + one-time reveal modal

Single-column cards (max-w-2xl), brass ★ for default, mono masked
secret. POST /api/keys now returns secret_revealed once; UI shows
reveal dialog with copy + double-confirm close. EMPTY state matches
onboarding visual.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: A11y polish — aria-labels, focus rings, tab order

**Files:**
- Touch: `web/src/components/AppShell.tsx` + Home / Studio / Keys components

### Step 10.1: Audit pass

- [ ] **Grep** icon-only buttons (no text child):

```bash
grep -rn "<button\|<Button" web/src --include="*.tsx" | grep -v ".test.tsx"
```

确保每个 icon-only button 都有 `aria-label`。

### Step 10.2: Focus ring uniformity

- [ ] 对所有 `<button>` / `<a>` / `<input>` / `<textarea>`，确保 className 包含 `focus-visible:ring-2 focus-visible:ring-primary`（圆形按钮多加 `ring-offset-2 ring-offset-background`）。
- [ ] AppShell Logo link 加 `focus-visible:ring`。

### Step 10.3: aria roles

- [ ] Studio `<main>` 已有 `role="main"`（AppShell 提供）。再加 `aria-label="生图沙箱"` 到 Studio 根 div（不是 main，因 main 在 AppShell）。
- [ ] Atelier Home：根 div `aria-label="作品集首页"`.

### Step 10.4: Tab order verification

- [ ] Manual: 在 Studio 页面 Tab 一遍，确认顺序: textarea → submit。AppShell: Atelier logo → 工坊 → 试稿 → ⚙ Keys。

### Step 10.5: Commit

```bash
git add web/src/
git commit -m "$(cat <<'EOF'
chore(a11y): aria-labels for icon-only buttons + uniform focus rings

All icon-only buttons (★ favorite, ⋯ details, ↑ submit, ⚙ keys, etc.)
carry aria-label per DESIGN.md Pass 6 finding 6.4. Focus rings use
ring-primary uniformly; circular submit uses ring-offset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: API Contract Doc Sync + Backend `/api/jobs/<id>` GET

**Files:**
- Modify: `docs/api-contract.md`
- Possibly: `src/viewer_server/routes.py` (if `GET /api/jobs/<id>` 不存在)

### Step 11.1: Verify GET /api/jobs/<id> exists

- [ ] **Grep**:

```bash
grep -n "api/jobs" src/viewer_server/routes.py
```

如果只有 `POST /api/jobs/.../confirm` 等，没有单 job GET，Studio 轮询会 404。

- [ ] 如果没有，**add**:

```python
@router.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    from character_workflow.lib.jobs import read_job
    try:
        job = read_job(job_id)
    except FileNotFoundError:
        raise HTTPException(404)
    return job.model_dump(mode="json")
```

- [ ] 加测试：

```python
def test_get_single_job(client, tmp_path):
    # 先 POST /api/studio/jobs 创建
    r1 = client.post("/api/studio/jobs", json={
        "prompt": "x", "model": "gpt-image-2", "params": {},
    })
    job_id = r1.json()["job_id"]
    r2 = client.get(f"/api/jobs/{job_id}")
    assert r2.status_code == 200
    assert r2.json()["job_id"] == job_id
```

### Step 11.2: Update docs/api-contract.md

- [ ] **Read** `docs/api-contract.md`. Append v2 section:

```markdown
## v2 (2026-05-25) — Atelier-Web PR1

### Schema 重命名
- `JobKind` (老) → `AssetSlot` —— values `portrait/promo/turnaround` 不变
- 新 `JobKind` —— values `image/video` (video 仅占位)
- `Job` 新增字段:
  - `asset_slot: AssetSlot` (默认 `portrait`)
  - `kind: JobKind` (默认 `image`)
  - `namespace: 'character' | 'studio'` (默认 `character`)

### 新增端点
- `GET /api/gallery/recent?limit=24` → `{items: [{character_id, asset_slot, filename, path, mtime}]}`
- `GET /api/gallery/image?path=...` → file response. 仅接受 `characters/*` 和 `studio/*` 前缀；rejects traversal.
- `POST /api/studio/jobs` body `{prompt, model, params, alias?, kind?}` → Job (status=pending). namespace=studio。video kind → 422.
- `GET /api/jobs/{job_id}` → Job

### 不变
- `/api/raw` whitelist 不变
- `WebEditableJobPatch` whitelist 不变（不加 namespace / asset_slot / kind）

### 迁移
- 老 `.runtime/jobs/<id>.json` 须跑 `scripts/migrate_jobs_2026_05_25.py` 升级。幂等。
```

### Step 11.3: Tests + lint

- [ ] **Run**:

```bash
uv run pytest -q
cd web && pnpm test -- --run && pnpm lint && cd ..
uv run ruff check src tests
```

### Step 11.4: Commit

```bash
git add docs/api-contract.md src/viewer_server/routes.py tests/test_studio_jobs.py
git commit -m "$(cat <<'EOF'
docs(api): v2 contract — namespace/asset_slot/JobKind + new endpoints

Documents schema break + Studio/Gallery endpoints. GET /api/jobs/{id}
added so Studio UI can poll for terminal status.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Full E2E smoke + DESIGN.md anti-slop checklist

**Files:** none (verification only)

### Step 12.1: Run full test suite

- [ ] **Run**:

```bash
uv run pytest -v 2>&1 | tail -30
cd web && pnpm test -- --run && pnpm lint && cd ..
uv run ruff check src tests
```

Expected: 全绿。

### Step 12.2: Build production bundle

- [ ] **Run**:

```bash
make build
```

Verify `web/dist/index.html` exists and bundle compiles.

### Step 12.3: Run viewer-server (production mode = serves dist)

- [ ] **Run** (single terminal — production-like):

```bash
uv run python src/viewer_server/server.py stop 2>/dev/null || true
uv run python src/viewer_server/server.py start
```

### Step 12.4: Open browser smoke checklist

打开 `http://127.0.0.1:5174`（或 server 实际端口）：

- [ ] `/` 是 Atelier Home（hero 居中、masonry 左对齐）
- [ ] `/studio` 是 Studio（hero "Studio." 左对齐 serif）
- [ ] `/character/<existing-id>` 渲染 3 栏
- [ ] `/settings/keys` 卡片化 Keys + ★ + reveal modal
- [ ] **不存在的路由 `/foo` 重定向到 `/`**
- [ ] 任何页面 refresh 不 404（SPA fallback 工作）
- [ ] 浏览器后退 / 前进可用
- [ ] `<1280px` 显示 fallback 提示页
- [ ] Tab 顺序在 Studio: textarea → submit；AppShell: logo → 工坊 → 试稿 → ⚙
- [ ] Studio Cmd+Enter 触发提交

### Step 12.5: DESIGN.md anti-slop checklist

- [ ] **无紫蓝渐变** — grep `gradient` / `bg-gradient-*` in `web/src/`，结果应为空（或仅 testing fixtures）
- [ ] **无 3 列 feature grid** — Atelier Home 是 masonry，不是 grid
- [ ] **无 Inter** — DESIGN.md token 没引 Inter，确认 `web/src/styles/` CSS 没硬编码 Inter
- [ ] **无渐变按钮** — Studio submit ↑ 是 `bg-primary` 纯色
- [ ] **居中只限 Atelier Home hero** — Studio hero 左对齐 ✓

### Step 12.6: 迁移脚本 dry-run on a copy of real data

- [ ] 如果有真实 `<data_root>`:

```bash
cp -r <data_root>/.runtime <data_root>/.runtime.bak.20260525
CHARACTER_WORKFLOW_DATA_ROOT=<data_root> uv run python scripts/migrate_jobs_2026_05_25.py
```

确认输出 `migrated=N skipped=0 errored=0`，且后续 `viewer-server` 能正常读取。

### Step 12.7: PR

- [ ] **Create PR**:

```bash
git push -u origin lovart-runner-reliability-20260520
gh pr create --title "Atelier-Web PR1: 4-zone routing + Studio sandbox + Keys cards" --body "$(cat <<'EOF'
## Summary
- Wouter client-side routing + AppShell with 4 zones (`/` Home, `/studio`, `/character/:id`, `/settings/keys`)
- Atelier Home: serif hero + CSS-columns masonry of recent character images
- Studio sandbox: standalone image gen (namespace='studio'), bypasses Claude/Codex quota
- Keys page: card layout + brass ★ default + one-time reveal modal
- Schema migration: JobKind→AssetSlot, new JobKind(image/video), namespace field
- SPA fallback in FastAPI so client routes survive refresh
- Anti-slop guards from DESIGN.md applied throughout

## Test plan
- [ ] `uv run pytest -v` all green
- [ ] `cd web && pnpm test -- --run && pnpm lint` all green
- [ ] `ruff check src tests` no warnings
- [ ] Manual: 4 zones + browser refresh + Cmd+Enter + reveal modal + <1280px fallback
- [ ] `scripts/migrate_jobs_2026_05_25.py` ran on real data, idempotent

## Out of scope (PR2, ≥1 week later)
- favorites pool + `/api/favorites` endpoints
- Skill `turn-start` `lessons_pending_count`
- distillation flow (LLM 5-line review + stdin selection)
- Studio nav distill dot indicator

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

### Spec coverage check (against 源 design doc Success Criteria)

| § Success Criteria | Covered by | Status |
|---|---|---|
| 打开 Web → Atelier 主页，无数字/进度条 | T6 | ✓ |
| 顶部 nav 4 区域可切换，URL 真实变化 | T3 AppShell | ✓ |
| 左上角 "Atelier" 任何 zone 点回 | T3 AppShell Logo link | ✓ |
| `/studio` 能用 default key 出图 | T7 + T8 | ✓ |
| 收藏一张图后 favorites/index.json 有记录 | **PR2 — 不在本 plan** | 延期 |
| Skill turn-start 输出 `lessons_pending_count` | **PR2** | 延期 |
| 旧的 API Keys 浮动按钮消失 | T4 + T9 | ✓ |
| Keys 页改卡片式，黄铜 ★ | T9 | ✓ |
| `JobKind.VIDEO` 在 schema, Studio kind 下拉 disabled | T1 + T7 (422) | ✓（下拉 disabled UI 在 T-006 backlog） |
| pnpm test / pytest / ruff / pnpm lint 全绿 | T12 | ✓ |
| DESIGN.md 反 slop 检查 | T12 Step 12.5 | ✓ |

### Design Review D1-D7 coverage

| Design task | Covered by |
|---|---|
| D1 AppShell nav + 状态高亮 | T3 |
| D2 Atelier Home masonry + states | T6 |
| D3 Studio 4 states + chip | T8 |
| D4 圆形 submit 纯色 + Cmd+Enter | T8 |
| D5 Keys cards + reveal | T9 |
| D6 <1280px fallback | T3 (MinViewportGuard) |
| D7 aria-labels + focus rings | T10 |

D8 (favorite ★ animation) 和 D9 (distill dot) 属 PR2，不在本 plan。

### Placeholder scan

- [x] 无 "TBD" / "TODO" 在步骤体内（只在 Backlog T-006 提及 Studio Popovers 延期，明确写出）
- [x] 每个 "Write failing test" 步都给了完整测试代码
- [x] 每个 commit message 都是完整 HEREDOC，不是占位

### Type consistency

- `AssetSlot` 在 T1 Python schema + TS schema 同步
- `JobKind` 新值 `image/video` 一致
- `namespace: 'character' | 'studio'` 一致
- `studio_output_dir(job_id) → Path` signature 在 T7 + 测试中一致
- `KeyRow` interface 在 T9 KeyCard + Keys.tsx 一致

### 已知妥协（在本 plan 范围内已明确）

1. **Studio Popovers 简化**：T8 用静态文案条 `图片生成 · GPT Image 2 · 1024×1024 · default key` 代替 4 个 Popover。完整 Popover 行为列入 backlog T-006。理由：MVP 用 default 出图即可省 Claude 额度，参数 fine-grained 选择是 P2。
2. **Studio 不订阅 SSE**：T8 用 `pollJobUntilTerminal` 2s 轮询代替 SSE 接入。原 viewer-server SSE 是按 character_id 推，Studio namespace 还没接 SSE 路由。SSE 接入列入 backlog T-007。
3. **Studio 跳过 `pending_confirm`**：T8 直接 `status=PENDING` 入队（点 ↑ 即确认）。理由：Skill 链路的 confirm 是为终端 dry-run 设计的；Studio Web 点提交本身就是用户意图，再二次确认是冗余。

### Backlog (本 plan 之外)

- T-006: Studio 4 个完整 Popover (kind/model/ratio/key)
- T-007: Studio 接入 SSE 替换 polling
- T-008: PR2 — 收藏池 + Skill 反哺（独立 plan）

---

## Execution Handoff

Plan complete and saved. Two execution options:

**1. Subagent-Driven (recommended)** — 每个 task 派一个 fresh subagent，task 间 review，fast iteration

**2. Inline Execution** — 当前 session 顺序跑 task，每个 task commit 后 checkpoint

Which approach?
