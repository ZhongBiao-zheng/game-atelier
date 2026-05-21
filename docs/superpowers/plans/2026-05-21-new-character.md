# 新建角色 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web UI 中添加"新建角色"功能，输入名字即创建目录骨架 + 空 spec.md，自动选中新角色。

**Architecture:** 后端新增 `POST /api/characters` 端点（`routes.py`），前端在 `LeftSidebar.tsx` 的 BrandHeader 加"新角色"按钮 + 内联输入，交互模式与"新项目"完全镜像。

**Tech Stack:** Python 3.11 / FastAPI / pytest；React 18.3 / TypeScript / lucide-react / Tailwind v4

---

## 文件改动清单

| 文件 | 动作 |
|---|---|
| `skill/viewer_server/routes.py` | 新增 `POST /api/characters` 端点 |
| `web/src/components/LeftSidebar.tsx` | 新增"新角色"按钮、内联输入、修复空状态按钮 |
| `tests/test_routes_post.py` | 新增后端测试（追加到文件末尾） |

---

## Task 1：后端端点 `POST /api/characters`

**Files:**
- Modify: `skill/viewer_server/routes.py`
- Test: `tests/test_routes_post.py`

- [ ] **Step 1：写失败测试（追加到 `tests/test_routes_post.py` 末尾）**

```python
def test_create_character_creates_dirs_and_spec(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    r = client.post("/api/characters", json={"name": "烈拳猴"})
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "烈拳猴"
    char_id = data["id"]
    assert char_id.startswith("char-")
    root = tmp_path / "characters" / char_id
    for d in ("portrait", "promo", "turnaround", "source"):
        assert (root / d).is_dir(), f"missing {d}/"
    spec = (root / "spec.md").read_text(encoding="utf-8")
    assert spec.startswith("# 烈拳猴")


def test_create_character_rejects_empty_name(client):
    r = client.post("/api/characters", json={"name": ""})
    assert r.status_code == 422


def test_create_character_sets_active(client, tmp_path, monkeypatch):
    import json as _json
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".runtime" / "jobs").mkdir(parents=True, exist_ok=True)
    r = client.post("/api/characters", json={"name": "测试角色"})
    assert r.status_code == 200
    char_id = r.json()["id"]
    active_file = tmp_path / ".runtime" / "active-character.json"
    assert active_file.exists()
    active = _json.loads(active_file.read_text())
    assert active["active_id"] == char_id
```

- [ ] **Step 2：运行测试确认失败**

```bash
uv run pytest tests/test_routes_post.py::test_create_character_creates_dirs_and_spec -v
```

期望：FAIL — `404 Not Found`（端点不存在）

- [ ] **Step 3：在 `routes.py` 中新增端点**

在文件末尾 `@router.delete("/jobs/{job_id}/image")` 之前，添加：

```python
class CharacterCreate(BaseModel):
    name: str


@router.post("/characters", response_model=CharacterEntry)
def create_character(payload: CharacterCreate) -> CharacterEntry:
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, detail="name required")
    import time as _time
    char_id = f"char-{int(_time.time())}"
    root = _project_root() / "characters" / char_id
    for sub in ("portrait", "promo", "turnaround", "source"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    spec_content = f"# {name}\n\n（尚无档案 — 请在终端 /character-workflow 对话补全）\n"
    (root / "spec.md").write_text(spec_content, encoding="utf-8")
    write_active(char_id)
    return CharacterEntry(id=char_id, name=name, status="idle", latest_job_id=None)
```

注意：`CharacterCreate` 放在其他 `BaseModel` 子类附近（文件开头的 schema 块）。`import time` 放在函数内，避免污染顶层命名空间。

实际操作：
1. 在文件顶部 `class` 块（`SpecPatch`、`FeedbackPost` 等附近）添加 `CharacterCreate`
2. 在文件末尾 `@router.delete` 之前添加 `create_character` 函数

- [ ] **Step 4：运行全部新测试**

```bash
uv run pytest tests/test_routes_post.py::test_create_character_creates_dirs_and_spec tests/test_routes_post.py::test_create_character_rejects_empty_name tests/test_routes_post.py::test_create_character_sets_active -v
```

期望：3 个 PASS

- [ ] **Step 5：跑完整 pytest 确认没有回归**

```bash
uv run pytest -v --tb=short 2>&1 | tail -20
```

期望：全绿，无新失败

- [ ] **Step 6：提交**

```bash
git add skill/viewer_server/routes.py tests/test_routes_post.py
git commit -m "feat(api): POST /api/characters — 创建角色目录骨架"
```

---

## Task 2：前端 LeftSidebar 改动

**Files:**
- Modify: `web/src/components/LeftSidebar.tsx`

- [ ] **Step 1：添加 import `UserPlus`**

找到第 2 行的 lucide-react import：

```typescript
import { ChevronDown, ChevronRight, Plus, X, AlertCircle, FolderPlus } from 'lucide-react';
```

改为：

```typescript
import { ChevronDown, ChevronRight, Plus, X, AlertCircle, FolderPlus, UserPlus } from 'lucide-react';
```

- [ ] **Step 2：在 `LeftSidebar` 函数中添加新角色状态**

在 `const [creatingProject, setCreatingProject] = useState(false);` 之后添加：

```typescript
const [creatingCharacter, setCreatingCharacter] = useState(false);
const [newCharacterName, setNewCharacterName] = useState('');
const newCharInputRef = useRef<HTMLInputElement | null>(null);
```

- [ ] **Step 3：添加 `creatingCharacter` 的 focus effect**

在现有 `creatingProject` 的 `useEffect` 之后添加：

```typescript
useEffect(() => {
  if (creatingCharacter && newCharInputRef.current) newCharInputRef.current.focus();
}, [creatingCharacter]);
```

- [ ] **Step 4：添加新角色的三个操作函数**

在 `cancelNewProject` 函数之后添加：

```typescript
function startNewCharacter() {
  setCreatingCharacter(true);
  setNewCharacterName('');
  setError(null);
}

function cancelNewCharacter() {
  setCreatingCharacter(false);
  setNewCharacterName('');
}

async function commitNewCharacter() {
  const name = newCharacterName.trim();
  if (!name) { cancelNewCharacter(); return; }
  try {
    const r = await fetch('/api/characters', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const entry = await r.json() as { id: string; name: string };
    cancelNewCharacter();
    onSelect(entry.id, entry.name);
  } catch (e) {
    setError((e as Error).message);
  }
}
```

- [ ] **Step 5：修复空状态下的"新建角色"按钮**

找到空状态 return 块中（约 line 211-214）：

```typescript
<Button variant="outline" size="sm" className="mt-2">
  <Plus className="size-3.5" />
  新建角色
</Button>
```

改为：

```typescript
<Button variant="outline" size="sm" className="mt-2" onClick={startNewCharacter}>
  <Plus className="size-3.5" />
  新建角色
</Button>
```

并在空状态 `<aside>` 的 `<div className="flex-1 flex flex-col ...">` 内，在 `<Button>` 之后添加内联输入区，整段 empty return 改为：

```typescript
if (characters.length === 0 && projects.projects.length === 0) {
  return (
    <aside className="h-screen border-r border-border/60 bg-card/30 overflow-y-auto flex flex-col">
      <BrandHeader />
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center gap-4">
        <p className="font-[var(--font-display)] italic text-xl text-foreground/70">尚无作品</p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          在终端 Claude Code<br />
          输入"开始角色工作流"开始建档
        </p>
        {creatingCharacter ? (
          <div className="flex items-center gap-1.5 w-full max-w-[180px]">
            <Input
              ref={newCharInputRef}
              value={newCharacterName}
              onChange={e => setNewCharacterName(e.target.value)}
              onBlur={commitNewCharacter}
              onKeyDown={e => {
                if (e.key === 'Enter') commitNewCharacter();
                if (e.key === 'Escape') cancelNewCharacter();
              }}
              placeholder="角色名（如：烈拳猴）"
              className="h-7 text-xs"
            />
          </div>
        ) : (
          <Button variant="outline" size="sm" className="mt-2" onClick={startNewCharacter}>
            <Plus className="size-3.5" />
            新建角色
          </Button>
        )}
        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}
      </div>
    </aside>
  );
}
```

- [ ] **Step 6：在非空状态的 BrandHeader 添加"新角色"按钮**

找到非空状态的 `<BrandHeader>` 块（约 line 222-234）：

```typescript
<BrandHeader>
  <Button
    variant="outline"
    size="sm"
    onClick={startNewProject}
    disabled={creatingProject}
    title="新建项目（用来给角色分类）"
    className="h-7 px-2 text-xs"
  >
    <FolderPlus className="size-3" />
    新项目
  </Button>
</BrandHeader>
```

改为：

```typescript
<BrandHeader>
  <div className="flex items-center gap-1">
    <Button
      variant="ghost"
      size="sm"
      onClick={startNewCharacter}
      disabled={creatingCharacter}
      title="新建角色"
      className="h-7 px-2 text-xs"
    >
      <UserPlus className="size-3" />
      新角色
    </Button>
    <Button
      variant="outline"
      size="sm"
      onClick={startNewProject}
      disabled={creatingProject}
      title="新建项目（用来给角色分类）"
      className="h-7 px-2 text-xs"
    >
      <FolderPlus className="size-3" />
      新项目
    </Button>
  </div>
</BrandHeader>
```

- [ ] **Step 7：在角色列表顶部添加内联 Input**

找到 `<div className="flex-1 px-2 py-3">` 内，`{creatingProject && ...}` 块之前，添加：

```typescript
{creatingCharacter && (
  <div className="mb-2 flex items-center gap-1.5 px-2 py-1">
    <UserPlus className="size-3.5 text-muted-foreground shrink-0" />
    <Input
      ref={newCharInputRef}
      value={newCharacterName}
      onChange={e => setNewCharacterName(e.target.value)}
      onBlur={commitNewCharacter}
      onKeyDown={e => {
        if (e.key === 'Enter') commitNewCharacter();
        if (e.key === 'Escape') cancelNewCharacter();
      }}
      placeholder="角色名（如：烈拳猴）"
      className="h-7 text-xs"
    />
  </div>
)}
```

- [ ] **Step 8：TypeScript 检查**

```bash
cd web && pnpm lint
```

期望：零报错

- [ ] **Step 9：提交**

```bash
git add web/src/components/LeftSidebar.tsx
git commit -m "feat(web): 新建角色 — BrandHeader 按钮 + 内联输入 + 空状态修复"
```

---

## Task 3：手动验证

- [ ] **Step 1：启动后端**

```bash
uv run python skill/viewer_server/server.py start
```

- [ ] **Step 2：启动前端**

```bash
cd web && pnpm dev
```

- [ ] **Step 3：验证空状态**

打开 `http://127.0.0.1:5173`，若角色列表为空：
- 应看到"尚无作品"文字 + "新建角色"按钮
- 点击按钮 → 出现 Input，placeholder = "角色名（如：烈拳猴）"
- 输入"测试角色" → Enter → 应跳转到新角色画廊（空）
- 检查磁盘：`ls characters/char-*/` 应看到 portrait/ promo/ turnaround/ source/ spec.md

- [ ] **Step 4：验证非空状态**

已有角色时：
- BrandHeader 右上角应有"新角色"（ghost）和"新项目"（outline）两个按钮
- 点"新角色" → 列表顶部出现带 `UserPlus` icon 的 Input
- 输入名字 Enter → 新角色出现在列表，自动选中

- [ ] **Step 5：验证 Escape 取消**

点"新角色" → 按 Escape → Input 消失，无副作用

- [ ] **Step 6：提交最终**

若无额外改动：

```bash
git log --oneline -3
```

确认两个 commit 均在。
