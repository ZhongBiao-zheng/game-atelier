# Studio UI Layout Regression Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Web Home and Studio UI regressions caused by the Git cleanup: prompt box height/padding, size popover visual specs, selected-trigger popover alignment, generation thumbnail width, and batch action styling.

**Architecture:** Keep this as a surgical frontend-only correction. `PromptInput` owns the shared Home/Studio input, control buttons, and their popovers. `RoundList` owns completed batch thumbnails and action menus. Tests should assert the specific classes/placement that prevent these regressions from coming back.

**Tech Stack:** React 18.3, TypeScript 5.6, Tailwind v4.3, lucide-react, Vitest 2, Testing Library, pnpm.

---

## Current Context

- `web/src/components/studio/PromptInput.tsx` already has `h-[174px]`, `pt-[14px]`, `px-4`, `pb-4`, but there is no explicit regression test for Home and Studio sharing this exact input shell.
- The size popover is already close to the requested layout, but it currently uses `w-[59px]` for `1:1`; the new requirement says `56*90`.
- The size popover currently uses `p-6`, `space-y-6`, `p-2`, `h-10`, and `text-[13px]`; the new requirement says ratio component height `98`, padding `4`, resolution/size component height `36`, padding `2`, font size `14px`.
- Provider/model/size popovers are positioned with fixed offsets such as `sm:left-40`, `sm:left-64`, `sm:left-96`, which is the root cause of "popup options left aligned instead of corresponding to the selected control button".
- `RoundList` currently renders result images in a responsive grid without fixed width; the new requirement fixes each thumbnail width to `251.5`.
- Batch action buttons currently use `h-12`, variable width, and the more menu opens below with `top-full`; the new requirement says `重新编辑` and `再次生成` are `94*36`, `...` is `36*36`, and the menu opens to the right of `...`.

## Assumptions And Decisions

- "主页和出图页面" means the compact Home prompt and the non-compact Studio bottom prompt, both rendered by `PromptInput`.
- "输入框 UI 整体高度改为 174，padding: 14,16,16" maps to Tailwind `h-[174px] pt-[14px] px-4 pb-4`.
- The reference image `/Users/zhengzhongbiao/Downloads/Snipaste_2026-05-27_13-30-04.png` guides the visual treatment, but the current content order must remain `比例 - 分辨率 - 尺寸`.
- "1:1 的组件宽高：56*90" wins over the older plan's `59*90`.
- "分辨率和尺寸每个组件整体高度 36，padding 2，font-size 14px" maps to outer group `h-9 p-0.5` and option/readout `h-8 text-sm` where the outer component totals 36px.
- Popover alignment should be solved structurally by rendering each popover inside a `relative` wrapper around its own trigger. Avoid fixed `sm:left-*` offsets.
- Keep existing tests for provider/model behavior and Studio job submission; only update expected classes where the UI spec changed.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `web/src/components/studio/PromptInput.tsx` | Modify | Shared prompt shell height/padding, per-trigger popover positioning, size popover dimensions |
| `web/src/components/studio/RoundList.tsx` | Modify | Fixed result thumbnail width, action button sizes, more-menu right-side placement |
| `web/src/pages/Studio.test.tsx` | Modify | Regression tests for Studio prompt, size popover, trigger-aligned menus, thumbnails, action buttons |
| `web/src/pages/Home.test.tsx` | Modify | Regression tests for Home prompt height/padding and trigger-aligned downward menus |

---

## Task 1: Lock PromptInput Height And Padding On Home And Studio

**Files:**
- Modify: `web/src/components/studio/PromptInput.tsx`
- Test: `web/src/pages/Studio.test.tsx`
- Test: `web/src/pages/Home.test.tsx`

- [ ] **Step 1: Add a Studio regression test for the prompt shell**

In `web/src/pages/Studio.test.tsx`, add this test inside `describe('Studio', ...)`:

```tsx
it('uses the 174px prompt shell on the studio page', () => {
  renderStudio();

  expect(screen.getByTestId('studio-prompt-shell')).toHaveClass(
    'h-[174px]',
    'pt-[14px]',
    'px-4',
    'pb-4',
  );
});
```

- [ ] **Step 2: Add a Home regression test for the same prompt shell**

In `web/src/pages/Home.test.tsx`, add this test inside `describe('Home', ...)`:

```tsx
it('uses the 174px prompt shell on the home page', () => {
  renderHome();

  expect(screen.getByTestId('studio-prompt-shell')).toHaveClass(
    'h-[174px]',
    'pt-[14px]',
    'px-4',
    'pb-4',
  );
});
```

- [ ] **Step 3: Run the focused tests to verify they fail**

Run:

```bash
cd web && pnpm test Studio Home
```

Expected: FAIL because `PromptInput` does not expose `data-testid="studio-prompt-shell"` yet.

- [ ] **Step 4: Add the stable test hook without changing visual behavior**

In `web/src/components/studio/PromptInput.tsx`, update the top-level wrapper from:

```tsx
<div className="bg-card/80 rounded-[2rem] border border-input/80 pt-[14px] px-4 pb-4 max-w-[780px] mx-auto relative shadow-2xl shadow-black/20 backdrop-blur-xl h-[174px] flex flex-col gap-3">
```

to:

```tsx
<div
  data-testid="studio-prompt-shell"
  className="bg-card/80 rounded-[2rem] border border-input/80 pt-[14px] px-4 pb-4 max-w-[780px] mx-auto relative shadow-2xl shadow-black/20 backdrop-blur-xl h-[174px] flex flex-col gap-3"
>
```

- [ ] **Step 5: Verify**

Run:

```bash
cd web && pnpm test Studio Home
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/studio/PromptInput.tsx web/src/pages/Studio.test.tsx web/src/pages/Home.test.tsx
git commit -m "web: lock prompt input shell sizing"
```

---

## Task 2: Rebuild PromptInput Popover Positioning Around Each Trigger

**Files:**
- Modify: `web/src/components/studio/PromptInput.tsx`
- Test: `web/src/pages/Studio.test.tsx`
- Test: `web/src/pages/Home.test.tsx`

- [ ] **Step 1: Add Studio tests for selected-trigger alignment**

In `web/src/pages/Studio.test.tsx`, add:

```tsx
it('anchors prompt popovers to their selected trigger on the studio page', async () => {
  renderStudio();

  fireEvent.click(await screen.findByRole('button', { name: /选择厂商/ }));
  expect(screen.getByTestId('provider-control-wrap')).toHaveClass('relative');
  expect(screen.getByRole('listbox', { name: '选择厂商列表' })).toHaveClass('absolute', 'left-0', 'bottom-full');
  expect(screen.getByRole('listbox', { name: '选择厂商列表' })).not.toHaveClass('sm:left-40');

  fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
  expect(screen.getByTestId('model-control-wrap')).toHaveClass('relative');
  expect(screen.getByRole('listbox', { name: '选择模型列表' })).toHaveClass('absolute', 'left-0', 'bottom-full');
  expect(screen.getByRole('listbox', { name: '选择模型列表' })).not.toHaveClass('sm:left-64');

  fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
  expect(screen.getByTestId('size-control-wrap')).toHaveClass('relative');
  expect(screen.getByTestId('size-popover')).toHaveClass('absolute', 'left-0', 'bottom-full');
  expect(screen.getByTestId('size-popover')).not.toHaveClass('sm:left-96');
});
```

- [ ] **Step 2: Add Home tests for selected-trigger alignment with downward menus**

In `web/src/pages/Home.test.tsx`, add:

```tsx
it('anchors compact prompt popovers to their selected trigger on the home page', async () => {
  globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          default_alias: 'seedream',
          keys: [{
            alias: 'seedream',
            provider: 'seedream',
            access_key: 'ark...key',
            secret_key: null,
            capabilities: ['portrait'],
            models: [{ name: 'Doubao', id: 'doubao' }],
            notes: '',
            created_at: '2026-05-27T00:00:00Z',
            is_default: true,
          }],
        }),
      } as any);
    }
    if (url === '/api/jobs') {
      return Promise.resolve({ ok: true, json: async () => [] } as any);
    }
    return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as any);
  }) as any;

  renderHome();

  fireEvent.click(await screen.findByRole('button', { name: /选择厂商/ }));
  expect(screen.getByRole('listbox', { name: '选择厂商列表' })).toHaveClass('absolute', 'left-0', 'top-full');
  expect(screen.getByRole('listbox', { name: '选择厂商列表' })).not.toHaveClass('sm:left-40');

  fireEvent.click(screen.getByRole('button', { name: /选择比例和分辨率/ }));
  expect(screen.getByTestId('size-popover')).toHaveClass('absolute', 'left-0', 'top-full');
  expect(screen.getByTestId('size-popover')).not.toHaveClass('sm:left-96');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd web && pnpm test Studio Home
```

Expected: FAIL because the wrappers/test ids do not exist and the popovers still use fixed `sm:left-*` offsets.

- [ ] **Step 4: Add wrapper helpers in `PromptInput`**

In `web/src/components/studio/PromptInput.tsx`, keep:

```tsx
const panelPosition = menuDirection === 'down'
  ? 'top-full mt-3'
  : 'bottom-full mb-3';
```

Then replace the entire button row's left-side control group:

```tsx
<div className="flex flex-wrap gap-2">
  ...
</div>
```

with the exact structure below. This keeps each popover as a child of the selected trigger's wrapper:

```tsx
<div className="flex flex-wrap gap-2">
  <ControlButton active aria-label="图片生成">
    <ImageIcon size={14} aria-hidden /> 图片生成
  </ControlButton>

  <div data-testid="provider-control-wrap" className="relative">
    <ControlButton
      aria-label="选择厂商"
      onClick={() => setOpenPanel(openPanel === 'provider' ? null : 'provider')}
      disabled={providers.length === 0}
    >
      <Building2 size={14} aria-hidden /> {providerDisplayName}
    </ControlButton>
    {openPanel === 'provider' && (
      <div role="listbox" aria-label="选择厂商列表" className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-popover p-2 shadow-2xl`}>
        <div className="px-3 py-2 text-sm text-muted-foreground">选择厂商</div>
        {providers.map((item) => (
          <button
            key={item.alias}
            type="button"
            role="option"
            aria-selected={item.alias === provider?.alias}
            onClick={() => {
              onProviderChange?.(item.alias);
              onModelChange?.(item.models[0]?.id ?? '');
              setOpenPanel(null);
            }}
            className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary aria-selected:bg-secondary"
          >
            <Building2 size={20} aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{providerName(item)}</span>
              <span className="block truncate text-xs text-muted-foreground">{item.alias} · {item.models.length} models</span>
            </span>
          </button>
        ))}
      </div>
    )}
  </div>

  <div data-testid="model-control-wrap" className="relative">
    <ControlButton
      aria-label="选择模型"
      onClick={() => setOpenPanel(openPanel === 'model' ? null : 'model')}
      disabled={!provider || models.length === 0}
    >
      <Box size={14} aria-hidden /> {selectedModel ? selectedModel.name : '未配置模型'}
    </ControlButton>
    {openPanel === 'model' && (
      <div role="listbox" aria-label="选择模型列表" className={`absolute left-0 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-popover p-2 shadow-2xl`}>
        <div className="px-3 py-2 text-sm text-muted-foreground">选择模型：{providerDisplayName}</div>
        {models.map((item) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={selectedModel?.id === item.id}
            onClick={() => {
              onModelChange?.(item.id);
              setOpenPanel(null);
            }}
            className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary aria-selected:bg-secondary"
          >
            <Box size={22} aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{item.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{item.id}</span>
            </span>
          </button>
        ))}
      </div>
    )}
  </div>

  <div data-testid="size-control-wrap" className="relative">
    <ControlButton
      aria-label="选择比例和分辨率"
      onClick={() => setOpenPanel(openPanel === 'size' ? null : 'size')}
    >
      <Square size={14} aria-hidden /> {ratio} <span className="text-muted-foreground">|</span> {resolution === '2K' ? '高清 2K' : '超清 4K'}
    </ControlButton>
    {openPanel === 'size' && (
      <div data-testid="size-popover" className={`absolute left-0 ${panelPosition} z-20 w-[304px] max-w-[calc(100vw-32px)] max-h-[70vh] overflow-y-auto rounded-2xl border border-border bg-popover shadow-2xl`}>
        {/* keep the size panel content here; Task 3 replaces its inner classes */}
      </div>
    )}
  </div>
</div>
```

- [ ] **Step 5: Move the existing popover contents, then delete the old sibling popovers**

Move the existing provider, model, and size popover bodies into the wrappers from Step 4.

Delete these old sibling branches after the row:

```tsx
{openPanel === 'provider' && (...)}
{openPanel === 'model' && (...)}
{openPanel === 'size' && (...)}
```

Do not duplicate popovers. Each `openPanel` branch should exist exactly once.

- [ ] **Step 6: Verify**

Run:

```bash
cd web && pnpm test Studio Home
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/studio/PromptInput.tsx web/src/pages/Studio.test.tsx web/src/pages/Home.test.tsx
git commit -m "web: align prompt popovers to active controls"
```

---

## Task 3: Apply The Size Popover Visual Spec

**Files:**
- Modify: `web/src/components/studio/PromptInput.tsx`
- Test: `web/src/pages/Studio.test.tsx`

- [ ] **Step 1: Update the existing size panel test**

In `web/src/pages/Studio.test.tsx`, replace the existing expectations in `renders the size panel without smart ratio and with emphasized 1:1 option` with:

```tsx
expect(screen.queryByRole('option', { name: '智能' })).not.toBeInTheDocument();
expect(screen.getByRole('listbox', { name: '选择比例' })).toHaveClass('h-[98px]', 'p-1');
expect(screen.getByRole('option', { name: '1:1' })).toHaveClass('w-[56px]', 'h-[90px]', 'text-sm');
expect(screen.getByRole('option', { name: '4:3' })).toHaveClass('w-[53.5px]', 'h-[43px]', 'text-sm');
expect(screen.getByRole('listbox', { name: '选择分辨率' })).toHaveClass('h-9', 'p-0.5');
expect(screen.getByRole('option', { name: /高清 2K/ })).toHaveClass('h-8', 'text-sm');
expect(screen.getByLabelText('输出宽度')).toHaveClass('h-8', 'text-sm');
expect(screen.getByLabelText('输出高度')).toHaveClass('h-8', 'text-sm');
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd web && pnpm test Studio -- -t "size panel"
```

Expected: FAIL because the current implementation uses `w-[59px]`, `p-2`, `h-10`, and `text-[13px]`.

- [ ] **Step 3: Replace the size popover inner panel**

In `web/src/components/studio/PromptInput.tsx`, inside `data-testid="size-popover"`, use this exact content:

```tsx
<div className="p-5 space-y-4">
  <section>
    <div className="mb-2 text-sm font-semibold text-muted-foreground">比例</div>
    <div
      role="listbox"
      aria-label="选择比例"
      className="flex h-[98px] gap-2 rounded-2xl bg-secondary p-1"
    >
      <button
        type="button"
        role="option"
        aria-selected={ratio === '1:1'}
        onClick={() => onRatioChange?.('1:1')}
        className="flex h-[90px] w-[56px] shrink-0 flex-col items-center justify-center gap-2 rounded-xl text-sm hover:bg-card aria-selected:bg-card transition-colors"
      >
        <RatioIcon ratio="1:1" box={28} />
        <span>1:1</span>
      </button>
      <div className="grid grid-cols-4 gap-1.5">
        {SIDE_RATIOS.map((item) => (
          <button
            key={item}
            type="button"
            role="option"
            aria-selected={ratio === item}
            onClick={() => onRatioChange?.(item)}
            className="flex h-[43px] w-[53.5px] flex-col items-center justify-center gap-0.5 rounded-lg text-sm hover:bg-card aria-selected:bg-card transition-colors"
          >
            <RatioIcon ratio={item} box={18} />
            <span>{item}</span>
          </button>
        ))}
      </div>
    </div>
  </section>

  <section>
    <div className="mb-2 text-sm font-semibold text-muted-foreground">分辨率</div>
    <div role="listbox" aria-label="选择分辨率" className="grid h-9 grid-cols-2 gap-1 rounded-2xl bg-secondary p-0.5">
      {(['2K', '4K'] as const).map((item) => (
        <button
          key={item}
          type="button"
          role="option"
          aria-selected={resolution === item}
          onClick={() => onResolutionChange?.(item)}
          className="h-8 rounded-xl text-center text-sm hover:bg-card aria-selected:bg-card transition-colors"
        >
          {item === '2K' ? '高清 2K' : '超清 4K'}
        </button>
      ))}
    </div>
  </section>

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
</div>
```

- [ ] **Step 4: Verify size behavior still submits the displayed pixel size**

Run:

```bash
cd web && pnpm test Studio -- -t "same pixel size"
```

Expected: PASS.

- [ ] **Step 5: Verify the full Studio suite**

Run:

```bash
cd web && pnpm test Studio
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/studio/PromptInput.tsx web/src/pages/Studio.test.tsx
git commit -m "web: match studio size popover spec"
```

---

## Task 4: Fix Completed Batch Thumbnail Width

**Files:**
- Modify: `web/src/components/studio/RoundList.tsx`
- Test: `web/src/pages/Studio.test.tsx`

- [ ] **Step 1: Add a thumbnail width assertion**

In `web/src/pages/Studio.test.tsx`, inside `renders a completed studio batch with metadata and action buttons`, after:

```tsx
expect(screen.getAllByRole('img', { name: /生成结果/ })).toHaveLength(2);
```

add:

```tsx
expect(screen.getByTestId('studio-result-thumb-1')).toHaveClass('w-[251.5px]');
expect(screen.getByTestId('studio-result-thumb-2')).toHaveClass('w-[251.5px]');
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd web && pnpm test Studio -- -t "completed studio batch"
```

Expected: FAIL because the figure elements do not expose test ids and do not have `w-[251.5px]`.

- [ ] **Step 3: Replace the image grid container and figure classes**

In `web/src/components/studio/RoundList.tsx`, replace:

```tsx
<div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-4">
  {round.imagePaths.map((path, index) => (
    <figure key={path} className="group relative overflow-hidden rounded-md bg-card">
```

with:

```tsx
<div className="flex flex-wrap gap-1">
  {round.imagePaths.map((path, index) => (
    <figure
      key={path}
      data-testid={`studio-result-thumb-${index + 1}`}
      className="group relative w-[251.5px] overflow-hidden rounded-md bg-card"
    >
```

Keep the image as:

```tsx
<img
  src={imageSrc(path)}
  alt={`生成结果 ${index + 1}`}
  className="h-full w-full object-contain"
/>
```

- [ ] **Step 4: Verify**

Run:

```bash
cd web && pnpm test Studio -- -t "completed studio batch"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/studio/RoundList.tsx web/src/pages/Studio.test.tsx
git commit -m "web: fix studio batch thumbnail width"
```

---

## Task 5: Fix Batch Action Button Sizes And More Menu Placement

**Files:**
- Modify: `web/src/components/studio/RoundList.tsx`
- Test: `web/src/pages/Studio.test.tsx`

- [ ] **Step 1: Add action sizing and right-side menu assertions**

In `web/src/pages/Studio.test.tsx`, add this test inside `describe('Studio', ...)`:

```tsx
it('uses fixed batch action sizes and opens the more menu to the right', async () => {
  renderStudioWithCompletedBatch();

  expect(await screen.findByRole('button', { name: '重新编辑' })).toHaveClass('h-9', 'w-[94px]');
  expect(screen.getByRole('button', { name: '再次生成' })).toHaveClass('h-9', 'w-[94px]');
  expect(screen.getByRole('button', { name: '更多操作' })).toHaveClass('h-9', 'w-9');

  fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

  expect(screen.getByTestId('studio-more-menu')).toHaveClass('absolute', 'left-full', 'top-0', 'ml-2');
  expect(screen.getByTestId('studio-more-menu')).not.toHaveClass('top-full');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd web && pnpm test Studio -- -t "batch action sizes"
```

Expected: FAIL because action buttons are `h-12`, the more button does not use `w-9`, and the menu opens below.

- [ ] **Step 3: Update `DoneBatch` action markup**

In `web/src/components/studio/RoundList.tsx`, replace:

```tsx
<div className="relative flex items-center gap-2">
  <ActionButton onClick={() => onReEdit?.(round.config)}>重新编辑</ActionButton>
  <ActionButton onClick={() => { void onRegenerate?.(round.config); }}>再次生成</ActionButton>
  <ActionButton aria-label="更多操作" onClick={() => setMenuOpen((value) => !value)}>...</ActionButton>
  {menuOpen && (
    <div className="absolute left-0 top-full z-10 mt-2 w-44 rounded-xl border border-border bg-popover p-1 shadow-xl">
```

with:

```tsx
<div className="flex items-center gap-2">
  <ActionButton onClick={() => onReEdit?.(round.config)}>重新编辑</ActionButton>
  <ActionButton onClick={() => { void onRegenerate?.(round.config); }}>再次生成</ActionButton>
  <div className="relative">
    <ActionButton compact aria-label="更多操作" onClick={() => setMenuOpen((value) => !value)}>...</ActionButton>
    {menuOpen && (
      <div data-testid="studio-more-menu" className="absolute left-full top-0 z-10 ml-2 w-44 rounded-xl border border-border bg-popover p-1 shadow-xl">
```

Then close the extra wrapper after the menu:

```tsx
    )}
  </div>
</div>
```

- [ ] **Step 4: Update `ActionButton` to support normal and compact sizes**

Replace:

```tsx
function ActionButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="h-12 rounded-xl bg-secondary px-5 text-sm font-medium text-foreground hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      {...props}
    />
  );
}
```

with:

```tsx
function ActionButton({
  compact = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { compact?: boolean }) {
  return (
    <button
      type="button"
      className={`${compact ? 'h-9 w-9 px-0' : 'h-9 w-[94px] px-3'} rounded-xl bg-secondary text-sm font-medium text-foreground hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}
      {...props}
    />
  );
}
```

- [ ] **Step 5: Verify**

Run:

```bash
cd web && pnpm test Studio -- -t "batch action sizes"
```

Expected: PASS.

- [ ] **Step 6: Run the full Studio suite**

Run:

```bash
cd web && pnpm test Studio
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/studio/RoundList.tsx web/src/pages/Studio.test.tsx
git commit -m "web: polish studio batch actions"
```

---

## Task 6: Final Verification And Browser QA

**Files:**
- Modify only if regressions are found: `web/src/components/studio/PromptInput.tsx`, `web/src/components/studio/RoundList.tsx`, `web/src/pages/Studio.test.tsx`, `web/src/pages/Home.test.tsx`

- [ ] **Step 1: Run all frontend tests**

Run:

```bash
cd web && pnpm test
```

Expected: PASS.

- [ ] **Step 2: Run lint**

Run:

```bash
cd web && pnpm lint
```

Expected: PASS.

- [ ] **Step 3: Start the web app**

Run:

```bash
cd web && pnpm dev
```

Expected: Vite starts and prints a local URL, usually `http://localhost:5173/`.

- [ ] **Step 4: Manual browser QA on Home**

Open `/`.

Verify:

- Prompt shell height is 174px.
- Prompt shell padding visually matches top 14px, horizontal 16px, bottom 16px.
- Provider, model, and size popovers open downward from their own trigger buttons.
- Size popover order is `比例 - 分辨率 - 尺寸`.
- Ratio section is 98px tall with 4px padding.
- `1:1` is visually tall at 56px by 90px.
- Other ratio buttons are 53.5px by 43px.
- Resolution and size components are 36px tall with 2px padding and 14px text.

- [ ] **Step 5: Manual browser QA on Studio**

Open `/studio`.

Verify:

- Bottom prompt shell matches Home dimensions.
- Provider, model, and size popovers open upward from their own trigger buttons.
- A completed batch renders each result thumbnail at 251.5px wide.
- `重新编辑` and `再次生成` are 94px by 36px.
- `...` is 36px by 36px.
- Clicking `...` opens the menu to the right of the button.

- [ ] **Step 6: Commit any final fixes**

If Step 4 or Step 5 required changes:

```bash
git add web/src/components/studio/PromptInput.tsx web/src/components/studio/RoundList.tsx web/src/pages/Studio.test.tsx web/src/pages/Home.test.tsx
git commit -m "web: verify studio layout polish"
```

If no changes were needed, do not create an empty commit.

---

## Self-Review

- Spec coverage:
  - Requirement 1 is covered by Task 1.
  - Requirement 2 is covered by Task 3, while preserving order `比例 - 分辨率 - 尺寸`.
  - Requirement 3 is covered by Task 4.
  - Requirement 4 is covered by Task 5.
  - Requirement 5 is covered by Task 2.
- Placeholder scan:
  - No `TBD`, `TODO`, or "implement later" placeholders.
  - Each code-changing step includes exact code or exact class replacements.
- Type consistency:
  - `compact` is added only to local `ActionButton`.
  - `data-testid` values used in tests match the planned implementation.
  - `PromptInput` remains API-compatible with current Home and Studio callers.
