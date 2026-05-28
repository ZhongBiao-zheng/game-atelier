# Studio UI Polish — Popup Backgrounds, Size Panel, Failed Card, Custom Resolution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four frontend UI issues: transparent popup backgrounds, size panel style/width/selected-state, failed round card showing prompt+meta+actions, and editable W/H resolution inputs with a ratio-lock toggle.

**Architecture:** `PromptInput.tsx` owns T1, T2, T4 (popup panels, size panel style, custom resolution state). `RoundList.tsx` + `Studio.tsx` own T3 (failed card type + display). No new files — all changes are surgical edits to four existing files plus test updates.

**Tech Stack:** React 18.3, TypeScript 5.6, Tailwind v4.3 (no tailwind.config.js, tokens via `web/src/styles/tokens.css`), lucide-react, Vitest 2 + Testing Library, pnpm.

---

## Color reference (tokens.css)

```
--background:  #0F0E0D   (page bg, darkest)
--card:        #1B1917   (== --popover, dark)
--secondary:   #2A2725   (medium gray, lightest dark tone)
--primary:     #D4A574   (brass)
--foreground:  #EDEAE3
--muted-fg:    #94908B
--destructive: #C95C5C
```

The fix for "transparent" popups: outer panel `bg-popover` (= `#1B1917`) blends with the parent's `bg-card/80`. Switching outer popup background to `bg-secondary` (#2A2725) gives a visually distinct, solid dark panel. Inner nested containers then use `bg-card` for depth; selected items snap back to `bg-secondary` to "pop" from the dark inner container.

---

## Task 1: Fix Popup Panel Backgrounds + Size Panel Style

**Files:**
- Modify: `web/src/components/studio/PromptInput.tsx`
- Test: `web/src/pages/Studio.test.tsx` (no new test needed — existing layout tests cover this)

### Step 1a: Change outer popup panel backgrounds from `bg-popover` to `bg-secondary`

In `web/src/components/studio/PromptInput.tsx`:

**Provider panel** (line ~109): change `bg-popover` → `bg-secondary`
```tsx
// OLD
className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-popover p-2 shadow-2xl`}
// NEW
className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-secondary p-2 shadow-2xl`}
```

**Model panel** (line ~145): same change
```tsx
// OLD
className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-popover p-2 shadow-2xl`}
// NEW
className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-secondary p-2 shadow-2xl`}
```

**Size panel** (line ~179): change `bg-popover` → `bg-secondary` AND `w-[304px]` → `w-[320px]`
```tsx
// OLD
className={`absolute left-0 ${panelPosition} z-20 w-[304px] max-w-[calc(100vw-32px)] max-h-[70vh] overflow-y-auto rounded-2xl border border-border bg-popover shadow-2xl`}
// NEW
className={`absolute left-0 ${panelPosition} z-20 w-[320px] max-w-[calc(100vw-32px)] max-h-[70vh] overflow-y-auto rounded-2xl border border-border bg-secondary shadow-2xl`}
```

- [ ] **Step 1a: Apply the three outer-panel background changes above**

Run tests to verify no breakage:
```bash
cd web && pnpm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|✓|×)"
```
Expected: all tests still pass (no test checks `bg-popover` on panels).

### Step 1b: Update provider/model inner item hover/selected states

Because the outer panel is now `bg-secondary`, inner items must use `bg-card` for hover/selected:

Provider items (line ~122):
```tsx
// OLD
className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary aria-selected:bg-secondary"
// NEW
className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-card aria-selected:bg-card"
```

Model items (line ~157):
```tsx
// OLD
className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary aria-selected:bg-secondary"
// NEW
className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-card aria-selected:bg-card"
```

- [ ] **Step 1b: Apply the two item class changes above**

### Step 1c: Update size panel section labels — 12px, no margin, add padding

Replace all three section labels (比例, 分辨率, 尺寸):
```tsx
// OLD (three occurrences)
<div className="mb-2 text-sm font-semibold text-muted-foreground">比例</div>
<div className="mb-2 text-sm font-semibold text-muted-foreground">分辨率</div>
<div className="mb-2 text-sm font-semibold text-muted-foreground">尺寸</div>
// NEW
<div className="py-1 px-1 text-xs text-muted-foreground">比例</div>
<div className="py-1 px-1 text-xs text-muted-foreground">分辨率</div>
<div className="py-1 px-1 text-xs text-muted-foreground">尺寸</div>
```

- [ ] **Step 1c: Replace the three section label divs**

### Step 1d: Invert size panel inner containers + selected states

Inner containers go from `bg-secondary` → `bg-card` (darker). Selected items go from `aria-selected:bg-card` → `aria-selected:bg-secondary` (lighter "pop" from dark container).

**Ratio grid container** (line ~186):
```tsx
// OLD
className="grid h-[98px] grid-cols-[56px_1fr] gap-2 rounded-2xl bg-secondary p-1"
// NEW
className="grid h-[98px] grid-cols-[56px_1fr] gap-2 rounded-2xl bg-card p-1"
```

**1:1 ratio button** (line ~193):
```tsx
// OLD
className="flex h-[90px] w-[56px] flex-col items-center justify-center gap-2 rounded-xl text-sm hover:bg-card aria-selected:bg-card transition-colors"
// NEW
className="flex h-[90px] w-[56px] flex-col items-center justify-center gap-2 rounded-xl text-sm hover:bg-secondary aria-selected:bg-secondary transition-colors"
```

**Side ratio buttons** (line ~206):
```tsx
// OLD
className="flex h-[43px] w-[53.5px] flex-col items-center justify-center gap-0.5 rounded-lg text-sm hover:bg-card aria-selected:bg-card transition-colors"
// NEW
className="flex h-[43px] w-[53.5px] flex-col items-center justify-center gap-0.5 rounded-lg text-sm hover:bg-secondary aria-selected:bg-secondary transition-colors"
```

**Resolution container** (line ~218):
```tsx
// OLD
className="grid h-9 grid-cols-2 gap-1 rounded-2xl bg-secondary p-0.5"
// NEW
className="grid h-9 grid-cols-2 gap-1 rounded-2xl bg-card p-0.5"
```

**Resolution buttons** (line ~224):
```tsx
// OLD
className="h-8 rounded-xl text-center text-sm hover:bg-card aria-selected:bg-card transition-colors"
// NEW
className="h-8 rounded-xl text-center text-sm hover:bg-secondary aria-selected:bg-secondary transition-colors"
```

**Size (W/H) container** (line ~236):
```tsx
// OLD
className="flex h-9 items-center gap-2 rounded-2xl bg-secondary p-0.5"
// NEW
className="flex h-9 items-center gap-2 rounded-2xl bg-card p-0.5"
```

- [ ] **Step 1d: Apply the six inner container / selected-state class changes**

- [ ] **Step 1e: Run tests to confirm all pass**

```bash
cd web && pnpm test
```
Expected: all tests pass (existing tests check structural classes h-9, p-0.5, h-8, text-sm, etc. — none check bg-secondary/bg-card on these inner elements).

- [ ] **Step 1f: Commit**

```bash
git add web/src/components/studio/PromptInput.tsx
git commit -m "web: fix popup backgrounds and size panel 12px label style"
```

---

## Task 2: Failed Round Card Redesign

**Files:**
- Modify: `web/src/components/studio/RoundList.tsx`
- Modify: `web/src/pages/Studio.tsx`
- Test: `web/src/pages/Studio.test.tsx`

The `failed` RoundState currently lacks `config`. This means failed cards can't show prompt/meta info or offer re-edit/regenerate actions. Adding optional `config?: RoundConfig` to the failed type and passing it through from all creation points enables the full card.

### Step 2a: Write the failing test first

In `web/src/pages/Studio.test.tsx`, add after the existing "deletes a persisted failed studio job" test:

```tsx
it('shows prompt and action buttons on a failed round card', async () => {
  globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          default_alias: 'volc',
          keys: [{
            alias: 'volc', provider: 'seedream', access_key: 'ak', secret_key: null,
            capabilities: [], models: [{ name: '图片 4.7', id: 'doubao-4.7' }],
            notes: '', created_at: '2026-05-25T00:00:00Z', is_default: true,
          }],
        }),
      } as any);
    }
    if (url === '/api/jobs') {
      return Promise.resolve({
        ok: true,
        json: async () => [{
          job_id: 'job-fail-2', character_id: 'volc',
          prompt: '失败的幻想世界', submitted_at: '2026-05-28T01:00:00Z',
          model: 'doubao-4.7', alias: 'volc', provider: 'seedream',
          params: { ratio: '3:4', resolution: '2K', size: '1728x2304' },
          seed: null, output_paths: [], status: 'failed',
          error: 'API 调用超时', kind: 'image', namespace: 'studio',
        }],
      } as any);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as any);
  }) as any;

  renderStudio();

  expect(await screen.findByText('失败的幻想世界')).toBeInTheDocument();
  expect(screen.getByText('API 调用超时')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重新编辑' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '再次生成' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '删除失败记录' })).toBeInTheDocument();
});
```

- [ ] **Step 2a: Add the test above to Studio.test.tsx**

- [ ] **Step 2b: Run to confirm it fails**

```bash
cd web && pnpm test -- --reporter=verbose -t "shows prompt and action buttons on a failed round card"
```
Expected: FAIL — currently failed card doesn't show prompt text or action buttons.

### Step 2c: Add `config?: RoundConfig` to the `failed` variant in RoundList.tsx

In `web/src/components/studio/RoundList.tsx`:

```tsx
// OLD
export type RoundState =
  | { kind: 'pending'; jobId?: string; startedAt: number; config: RoundConfig }
  | { kind: 'done'; jobId: string; submittedAt: string; imagePaths: string[]; config: RoundConfig }
  | { kind: 'failed'; jobId?: string; submittedAt: string; reason: string };

// NEW
export type RoundState =
  | { kind: 'pending'; jobId?: string; startedAt: number; config: RoundConfig }
  | { kind: 'done'; jobId: string; submittedAt: string; imagePaths: string[]; config: RoundConfig }
  | { kind: 'failed'; jobId?: string; submittedAt: string; reason: string; config?: RoundConfig };
```

- [ ] **Step 2c: Update the type**

### Step 2d: Replace the inline failed-card JSX with a `FailedCard` component

In `web/src/components/studio/RoundList.tsx`, add a new `FailedCard` function before the closing brace of the file (after `ActionButton`). Then in `RoundList`, replace the `{r.kind === 'failed' && ...}` block:

**In `RoundList`, replace lines ~69-87 (the `r.kind === 'failed'` block):**
```tsx
// OLD
{r.kind === 'failed' && (
  <div className="relative border border-destructive/40 rounded-lg p-4 max-w-sm text-sm">
    <div className="flex items-start justify-between gap-4">
      <p className="text-foreground">生成失败</p>
      {r.jobId && onDeleteFailed && (
        <button ... >删除</button>
      )}
    </div>
    <p className="text-xs text-muted-foreground mt-1">{r.reason}</p>
  </div>
)}

// NEW
{r.kind === 'failed' && (
  <FailedCard
    round={r}
    onDeleteFailed={onDeleteFailed}
    onReEdit={onReEdit}
    onRegenerate={onRegenerate}
  />
)}
```

**Add `FailedCard` function at the end of RoundList.tsx (before the closing):**
```tsx
function FailedCard({
  round,
  onDeleteFailed,
  onReEdit,
  onRegenerate,
}: {
  round: Extract<RoundState, { kind: 'failed' }>;
  onDeleteFailed?: (jobId: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
}) {
  const { config } = round;
  const meta = config
    ? [config.modelName ?? config.model, config.size, config.ratio, config.resolution].filter(Boolean)
    : [];

  return (
    <section className="space-y-3">
      {config && (
        <div className="flex items-start gap-3 text-sm">
          {config.referenceImages[0] && (
            <img
              src={imageSrc(config.referenceImages[0])}
              alt="参考图"
              className="h-14 w-14 rounded-md object-cover"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-base leading-7 text-foreground" title={config.prompt}>
              {config.prompt}
            </p>
            {meta.length > 0 && (
              <p className="mt-1 text-sm text-muted-foreground">{meta.join(' | ')}</p>
            )}
          </div>
        </div>
      )}
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
        <span className="shrink-0 text-destructive/70 select-none">⚠</span>
        <p className="flex-1 text-muted-foreground">{round.reason}</p>
        {round.jobId && onDeleteFailed && (
          <button
            type="button"
            aria-label="删除失败记录"
            title="删除失败记录"
            onClick={() => { void onDeleteFailed(round.jobId!); }}
            className="rounded-md border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            删除
          </button>
        )}
      </div>
      {config && (
        <div className="flex items-center gap-2">
          <ActionButton onClick={() => onReEdit?.(config)}>重新编辑</ActionButton>
          <ActionButton onClick={() => { void onRegenerate?.(config); }}>再次生成</ActionButton>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2d: Add `FailedCard` function and update `RoundList` to use it**

### Step 2e: Pass `config` when creating failed states in Studio.tsx

In `web/src/pages/Studio.tsx`, there are three places that create `{ kind: 'failed', ... }`:

**Place 1** (pollJobUntilTerminal callback, ~line 134):
```tsx
// OLD
: {
    kind: 'failed',
    jobId: final.job_id,
    submittedAt: final.submitted_at,
    reason: final.error ?? '生成完成但未返回图片',
  }
// NEW
: {
    kind: 'failed',
    jobId: final.job_id,
    submittedAt: final.submitted_at,
    reason: final.error ?? '生成完成但未返回图片',
    config,
  }
```

**Place 2** (catch block, ~line 146):
```tsx
// OLD
r === myRound ? { kind: 'failed', submittedAt: new Date().toISOString(), reason: e.message } : r,
// NEW
r === myRound ? { kind: 'failed', submittedAt: new Date().toISOString(), reason: e.message, config } : r,
```

**Place 3** (`studioJobsToRounds`, ~line 298):
```tsx
// OLD
return [{
  kind: 'failed' as const,
  jobId: job.job_id,
  submittedAt: job.submitted_at,
  reason: job.error ?? '生成失败',
}];
// NEW
return [{
  kind: 'failed' as const,
  jobId: job.job_id,
  submittedAt: job.submitted_at,
  reason: job.error ?? '生成失败',
  config: configForJob(job, keys),
}];
```

- [ ] **Step 2e: Apply the three failed-state creation updates in Studio.tsx**

- [ ] **Step 2f: Run the new test to confirm it passes**

```bash
cd web && pnpm test -- -t "shows prompt and action buttons on a failed round card"
```
Expected: PASS.

- [ ] **Step 2g: Run full suite to confirm no regressions**

```bash
cd web && pnpm test
```
Expected: all pass.

- [ ] **Step 2h: Commit**

```bash
git add web/src/components/studio/RoundList.tsx web/src/pages/Studio.tsx web/src/pages/Studio.test.tsx
git commit -m "web: show prompt/meta and action buttons on failed round cards"
```

---

## Task 3: Editable Resolution Inputs with Ratio Lock

**Files:**
- Modify: `web/src/components/studio/PromptInput.tsx`
- Modify: `web/src/pages/Studio.tsx`
- Modify: `web/src/pages/Studio.test.tsx`

**Design:**
- W and H fields become `<input type="number">` elements
- Local state `localW`, `localH`, `sizeLocked` (default `true`) lives inside `PromptInput`
- When `sizeLocked=true` and user edits W: `H = round(W * b/a)` where a:b is the selected ratio
- When `sizeLocked=true` and user edits H: `W = round(H * a/b)`
- Selecting a ratio or resolution preset always recomputes W/H (regardless of lock)
- The Link2 icon becomes a toggle button for `sizeLocked`; when turning lock ON, resets W/H to current ratio preset
- Minimum px per side for seedream provider: 1296 (fire volcano engine constraint)
- ControlButton shows `{localW}:{localH} | {resolution label}` instead of `{ratio} | {resolution label}`
- New prop `onCustomSizeChange?: (w: number, h: number) => void` — Studio.tsx uses this to track current custom size for submission

### Step 3a: Write failing tests first

In `web/src/pages/Studio.test.tsx`, **update two existing tests** and **add three new tests**:

**Update: "submits the same pixel size shown in the size panel" (line ~275)**

Change `toHaveTextContent` → `toHaveValue` for W/H fields:
```tsx
// OLD
expect(screen.getByLabelText('输出宽度')).toHaveTextContent('2048');
expect(screen.getByLabelText('输出高度')).toHaveTextContent('1152');
// NEW
expect(screen.getByLabelText('输出宽度')).toHaveValue(2048);
expect(screen.getByLabelText('输出高度')).toHaveValue(1152);
```

**Update: "submits the valid Seedream 2K 3:4 size" (line ~377)**

```tsx
// OLD
expect(screen.getByLabelText('输出宽度')).toHaveTextContent('1728');
expect(screen.getByLabelText('输出高度')).toHaveTextContent('2304');
// NEW
expect(screen.getByLabelText('输出宽度')).toHaveValue(1728);
expect(screen.getByLabelText('输出高度')).toHaveValue(2304);
```

**Update: "re-edits a completed batch into the prompt input and restores controls" (line ~566)**

```tsx
// OLD
expect(sizeButton).toHaveTextContent('4:3');
expect(sizeButton).toHaveTextContent('高清 2K');
// NEW
expect(sizeButton).not.toHaveTextContent('4:3');
expect(sizeButton).toHaveTextContent('2304');
expect(sizeButton).toHaveTextContent('高清 2K');
```

**Add new test: "adjusts height when width is edited with ratio locked"**

Add inside the `describe('Studio', ...)` block:
```tsx
it('adjusts height when width is edited with ratio locked', async () => {
  const fetchMock = vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          default_alias: 'oa',
          keys: [{
            alias: 'oa', provider: 'openai', access_key: 'sk', secret_key: null,
            capabilities: [], models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
            notes: '', created_at: '2026-05-25T00:00:00Z', is_default: true,
          }],
        }),
      } as any);
    }
    if (url === '/api/jobs') {
      return Promise.resolve({ ok: true, json: async () => [] } as any);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as any);
  });
  globalThis.fetch = fetchMock as any;

  renderStudio();
  await screen.findByRole('button', { name: /选择比例和分辨率/ });
  fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
  fireEvent.click(screen.getByRole('option', { name: '4:3' }));

  // W=2048, H=round(3/4*2048)=1536
  expect(screen.getByLabelText('输出宽度')).toHaveValue(2048);
  expect(screen.getByLabelText('输出高度')).toHaveValue(1536);

  // Edit W → H adjusts to maintain 4:3
  fireEvent.change(screen.getByLabelText('输出宽度'), { target: { value: '2000' } });
  // H = round(2000 * 3/4) = 1500
  expect(screen.getByLabelText('输出高度')).toHaveValue(1500);
});
```

**Add new test: "submits custom dimensions when W/H are manually edited"**

```tsx
it('submits custom dimensions when W/H are manually edited', async () => {
  const fetchMock = vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          default_alias: 'oa',
          keys: [{
            alias: 'oa', provider: 'openai', access_key: 'sk', secret_key: null,
            capabilities: [], models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
            notes: '', created_at: '2026-05-25T00:00:00Z', is_default: true,
          }],
        }),
      } as any);
    }
    if (url === '/api/jobs') {
      return Promise.resolve({ ok: true, json: async () => [] } as any);
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ job_id: 'j1', status: 'pending', submitted_at: '2026-05-25T00:00:00Z' }),
    } as any);
  });
  globalThis.fetch = fetchMock as any;

  renderStudio();
  await screen.findByRole('button', { name: /选择比例和分辨率/ });
  fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));

  // Unlock ratio lock
  fireEvent.click(screen.getByRole('button', { name: '解除比例锁定' }));
  // Manually set W=1920, H=1080
  fireEvent.change(screen.getByLabelText('输出宽度'), { target: { value: '1920' } });
  fireEvent.change(screen.getByLabelText('输出高度'), { target: { value: '1080' } });

  fireEvent.change(screen.getByLabelText('生图 prompt'), { target: { value: '自定义尺寸测试' } });
  fireEvent.click(screen.getByLabelText('提交生成'));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
  const call = fetchMock.mock.calls.find(([url]) => url === '/api/studio/jobs');
  const body = JSON.parse(String(call![1]!.body));
  expect(body.params.size).toBe('1920x1080');
});
```

**Add new test: "ControlButton shows pixel dimensions not ratio text"**

```tsx
it('ControlButton shows pixel dimensions instead of ratio after ratio is selected', async () => {
  renderStudio();
  await screen.findByRole('button', { name: /选择比例和分辨率/ });
  fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
  fireEvent.click(screen.getByRole('option', { name: '16:9' }));

  const sizeButton = screen.getByRole('button', { name: /选择比例和分辨率/ });
  expect(sizeButton).not.toHaveTextContent('16:9');
  expect(sizeButton).toHaveTextContent('高清 2K');
  // seedream 2K 16:9 = SIZE_TABLE['2K']['16:9'] = 2560x1440
  expect(sizeButton).toHaveTextContent('2560');
});
```

- [ ] **Step 3a: Apply all test changes described above**

- [ ] **Step 3b: Run tests to confirm they fail (for new tests) and existing ones still pass where not touched**

```bash
cd web && pnpm test -- --reporter=verbose 2>&1 | tail -30
```
Expected: new tests FAIL (ControlButton still shows ratio text), updated existing tests FAIL (W/H still use `toHaveTextContent` variant — but we already changed those to `toHaveValue` so they should fail now since W/H are still static text spans).

### Step 3c: Update PromptInput.tsx — add local state + helper constants

In `web/src/components/studio/PromptInput.tsx`:

**Update the Props interface** to add `onCustomSizeChange`:
```tsx
interface Props {
  onSubmit: (prompt: string) => void | Promise<void>;
  disabled?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  providers?: KeyView[];
  providerAlias?: string;
  model?: string;
  ratio?: string;
  resolution?: '2K' | '4K';
  onProviderChange?: (alias: string) => void;
  onModelChange?: (model: string) => void;
  onRatioChange?: (ratio: string) => void;
  onResolutionChange?: (resolution: '2K' | '4K') => void;
  onCustomSizeChange?: (w: number, h: number) => void;  // ADD
  menuDirection?: 'up' | 'down';
}
```

**Add at top of `PromptInput` function body** (after the existing state declarations):
```tsx
const MIN_PX_SEEDREAM = 1296;

// Local resolution state
const initSize = computeStudioPixelSize(ratio, resolution, provider?.provider);
const [localW, setLocalW] = useState(initSize.w);
const [localH, setLocalH] = useState(initSize.h);
const [sizeLocked, setSizeLocked] = useState(true);
```

- [ ] **Step 3c: Add Props.onCustomSizeChange, MIN_PX_SEEDREAM, and local state**

### Step 3d: Add sync effect and handler functions in PromptInput

Add the following after the `const canSubmit` and `panelPosition` lines:

```tsx
// Sync W/H when ratio/resolution/provider changes (only when locked)
useEffect(() => {
  const { w, h } = computeStudioPixelSize(ratio, resolution, provider?.provider);
  setLocalW(w);
  setLocalH(h);
  onCustomSizeChange?.(w, h);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [ratio, resolution, provider?.provider]);

const minPx = provider?.provider === 'seedream' ? MIN_PX_SEEDREAM : 1;

function handleRatioSelect(newRatio: string) {
  onRatioChange?.(newRatio);
  const { w, h } = computeStudioPixelSize(newRatio, resolution, provider?.provider);
  setLocalW(w);
  setLocalH(h);
  onCustomSizeChange?.(w, h);
}

function handleResolutionSelect(newRes: '2K' | '4K') {
  onResolutionChange?.(newRes);
  const { w, h } = computeStudioPixelSize(ratio, newRes, provider?.provider);
  setLocalW(w);
  setLocalH(h);
  onCustomSizeChange?.(w, h);
}

function handleWChange(raw: string) {
  const newW = Math.max(minPx, parseInt(raw, 10) || minPx);
  setLocalW(newW);
  if (sizeLocked) {
    const [a, b] = ratio.split(':').map(Number);
    const newH = a > 0 ? Math.max(minPx, Math.round(newW * b / a)) : localH;
    setLocalH(newH);
    onCustomSizeChange?.(newW, newH);
  } else {
    onCustomSizeChange?.(newW, localH);
  }
}

function handleHChange(raw: string) {
  const newH = Math.max(minPx, parseInt(raw, 10) || minPx);
  setLocalH(newH);
  if (sizeLocked) {
    const [a, b] = ratio.split(':').map(Number);
    const newW = b > 0 ? Math.max(minPx, Math.round(newH * a / b)) : localW;
    setLocalW(newW);
    onCustomSizeChange?.(newW, newH);
  } else {
    onCustomSizeChange?.(localW, newH);
  }
}

function handleToggleLock() {
  const next = !sizeLocked;
  setSizeLocked(next);
  if (next) {
    const { w, h } = computeStudioPixelSize(ratio, resolution, provider?.provider);
    setLocalW(w);
    setLocalH(h);
    onCustomSizeChange?.(w, h);
  }
}
```

Also **update the ratio button onClick** from `() => onRatioChange?.(...)` to `() => handleRatioSelect(...)`:
```tsx
// 1:1 button onClick:
onClick={() => handleRatioSelect('1:1')}
// side ratio buttons onClick:
onClick={() => handleRatioSelect(item)}
// resolution buttons onClick:
onClick={() => handleResolutionSelect(item)}
```

- [ ] **Step 3d: Add the sync effect and handler functions, update ratio/resolution button onClick handlers**

### Step 3e: Update ControlButton and W/H section in JSX

**Update ControlButton** (currently shows `{ratio} <span>|</span> {resolution === '2K' ? '高清 2K' : '超清 4K'}`):
```tsx
// OLD
<Square size={14} aria-hidden /> {ratio} <span className="text-muted-foreground">|</span> {resolution === '2K' ? '高清 2K' : '超清 4K'}
// NEW
<Square size={14} aria-hidden /> {localW}:{localH} <span className="text-muted-foreground">|</span> {resolution === '2K' ? '高清 2K' : '超清 4K'}
```

**Replace the size section** (the entire `<section>` containing `尺寸`, `输出宽度`, `Link2`, `输出高度`, `PX`):

```tsx
// OLD
<section>
  <div className="mb-2 text-sm font-semibold text-muted-foreground">尺寸</div>
  <div className="flex h-9 items-center gap-2 rounded-2xl bg-secondary p-0.5">
    <div aria-label="输出宽度" className="flex h-8 flex-1 items-center gap-2 rounded-xl px-3 text-sm">
      <span className="font-medium text-muted-foreground">W</span>
      <span className="flex-1 text-center tabular-nums">{computeStudioPixelSize(ratio, resolution, provider?.provider).w}</span>
    </div>
    <Link2 size={15} className="shrink-0 text-muted-foreground" aria-hidden />
    <div aria-label="输出高度" className="flex h-8 flex-1 items-center gap-2 rounded-xl px-3 text-sm">
      <span className="font-medium text-muted-foreground">H</span>
      <span className="flex-1 text-center tabular-nums">{computeStudioPixelSize(ratio, resolution, provider?.provider).h}</span>
    </div>
    <span className="shrink-0 pr-3 text-sm text-muted-foreground">PX</span>
  </div>
</section>

// NEW (note: section label already updated in Task 1, so only the inner div changes here)
<section>
  <div className="py-1 px-1 text-xs text-muted-foreground">尺寸</div>
  <div className="flex h-9 items-center gap-2 rounded-2xl bg-card p-0.5">
    <input
      type="number"
      aria-label="输出宽度"
      value={localW}
      min={minPx}
      onChange={(e) => handleWChange(e.target.value)}
      className="h-8 flex-1 min-w-0 bg-transparent text-center tabular-nums text-sm focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
    />
    <button
      type="button"
      aria-label={sizeLocked ? '解除比例锁定' : '锁定比例'}
      title={sizeLocked ? '解除比例锁定' : '锁定比例'}
      onClick={handleToggleLock}
      className={`shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded ${sizeLocked ? 'text-primary' : 'text-muted-foreground'}`}
    >
      <Link2 size={15} aria-hidden />
    </button>
    <input
      type="number"
      aria-label="输出高度"
      value={localH}
      min={minPx}
      onChange={(e) => handleHChange(e.target.value)}
      className="h-8 flex-1 min-w-0 bg-transparent text-center tabular-nums text-sm focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
    />
    <span className="shrink-0 pr-3 text-sm text-muted-foreground">PX</span>
  </div>
</section>
```

Note: since Task 1 already changed the outer section-label div, here we only need to update the `bg-card` part of the inner container (already done in Task 1, Step 1d). The `section` label `尺寸` was updated in Task 1 Step 1c. Just update the inner content.

- [ ] **Step 3e: Replace ControlButton text and update the size section JSX to use inputs**

### Step 3f: Update Studio.tsx to track custom size and use it for submission

In `web/src/pages/Studio.tsx`:

**Add `customSize` state** alongside the other state declarations:
```tsx
const [customSize, setCustomSize] = useState('');
```

**Add `onCustomSizeChange` prop** to both `<PromptInput>` usages (compact and full):
```tsx
// In both <PromptInput> calls, add:
onCustomSizeChange={(w, h) => setCustomSize(`${w}x${h}`)}
```

**Update `onSubmit` effective size** (~line 72):
```tsx
// OLD
const effectiveSize = overrideConfig?.size ?? studioSizeFor(effectiveRatio, effectiveResolution, effectiveProvider);
// NEW
const effectiveSize = overrideConfig?.size ?? (customSize || studioSizeFor(effectiveRatio, effectiveResolution, effectiveProvider));
```

- [ ] **Step 3f: Add customSize state and onCustomSizeChange in Studio.tsx**

### Step 3g: Run tests and confirm all pass

```bash
cd web && pnpm test
```

Expected: all tests pass, including the 3 new tests from Step 3a.

If any test fails: check that the `aria-label` on both inputs is exactly `'输出宽度'` and `'输出高度'` (the tests use these exact strings). Also check that `toHaveValue` is being used (not `toHaveTextContent`) in the updated tests.

- [ ] **Step 3g: Run full test suite**

- [ ] **Step 3h: TypeScript check**

```bash
cd web && pnpm lint
```
Expected: no errors.

- [ ] **Step 3i: Commit**

```bash
git add web/src/components/studio/PromptInput.tsx web/src/pages/Studio.tsx web/src/pages/Studio.test.tsx
git commit -m "web: editable W/H resolution inputs with ratio-lock toggle in size panel"
```

---

## Post-implementation Checklist

- [ ] Run full test suite one final time: `cd web && pnpm test`
- [ ] TypeScript check: `cd web && pnpm lint`
- [ ] Start dev server and manually verify in browser:
  - Provider and model popups have dark visible background
  - Size panel is 320px wide, labels are small, selected state is visually clear
  - Failed rounds show prompt text + action buttons
  - W/H inputs are editable; editing W adjusts H when locked; ControlButton shows pixel dims

---

## Self-Review Against Spec

1. **Transparent popup backgrounds** ✓ — T1 changes `bg-popover` → `bg-secondary` on all three panels.
2. **Size panel width 320 / 12px labels / selected states** ✓ — T1/T2 sets `w-[320px]`, `text-xs py-1 px-1`, inverts container/selected colors.
3. **Failed round card with prompt/meta/actions** ✓ — T3 adds `config?` field and `FailedCard` component.
4. **Editable W/H + ratio lock + ControlButton shows pixels** ✓ — T4 adds inputs, handlers, lock toggle, `localW:localH` in button.
5. **火山引擎 min 1296px** ✓ — `MIN_PX_SEEDREAM = 1296` enforced in `handleWChange`/`handleHChange`.
6. **No placeholder steps** ✓ — all steps have exact code.
7. **TDD** ✓ — failing tests written before implementation in T2 (Step 2a/2b) and T3 (Step 3a/3b).
8. **Existing tests preserved** ✓ — all three test changes are minimal: `toHaveTextContent` → `toHaveValue` for W/H, and ControlButton check updated to not assert `'4:3'`.
