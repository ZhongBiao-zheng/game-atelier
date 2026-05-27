# UI Polish: Nav Pill, PromptInput Compact, Focus Ring, Studio Feed, Responsive

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five UI changes — clean nav active pill (40px), compact PromptInput (14px text / 36px buttons / 174px height), remove yellow focus ring on textarea click, Studio page refactored to full-height feed with sticky bottom input, responsive layout for viewports < 1280px.

**Architecture:** Pure frontend. No API, schema, or backend changes. Two test files need updating: `Studio.test.tsx` (heading assertion removed), `AppShell.test.tsx` (safe — keeps `bg-card/70` class). Tasks are ordered by dependency: T1→T2→T3→T4 (T4 depends on T3's header height change for Studio calc).

**Tech Stack:** React 18.3 / TypeScript 5.6 / Tailwind v4.3 / Vitest 2 / pnpm

---

## File Map

| File | Action | Task |
|---|---|---|
| `web/src/components/AppShell.tsx` | Modify | T1 (active style + height), T4 (responsive header) |
| `web/src/components/studio/PromptInput.tsx` | Modify | T2 (sizing + focus ring), T4 (dropdown responsive) |
| `web/src/pages/Studio.tsx` | Modify | T3 (feed layout), T4 (responsive height calc) |
| `web/src/pages/Home.tsx` | Modify | T4 (gallery columns) |
| `web/src/pages/Studio.test.tsx` | Modify | T3 (update heading assertion) |
| `web/src/components/AppShell.test.tsx` | Modify | T1 (add new height test) |

---

## Task 1: NavTab — Clean Active Pill (40px Height)

**Files:**
- Modify: `web/src/components/AppShell.tsx:9-23`
- Modify: `web/src/components/AppShell.test.tsx` (add one test)

### Reference

The tapnow.ai reference shows: solid dark filled pill, white text, no glow, no gradient shadows — just `bg-card/70 + ring-1`. The current active style has a complex `shadow-[inset_...]` creating micro-glows that need removing.

- [ ] **Step 1: Add a failing test for h-10 and no shadow**

In `web/src/components/AppShell.test.tsx`, add inside `describe('AppShell', ...)`:

```tsx
it('active tab has h-10 and no inset shadow', () => {
  renderAt('/');
  const tab = screen.getByText('主页');
  expect(tab.className).toContain('h-10');
  expect(tab.className).not.toContain('shadow-[inset');
});
```

Run:
```bash
cd web && pnpm test AppShell
```
Expected: FAIL — `主页` tab still has `h-11` and the shadow class.

- [ ] **Step 2: Update NavTab in AppShell.tsx**

Replace lines 9–23 in `web/src/components/AppShell.tsx`:

```tsx
function NavTab({ to, label, isActive, icon: Icon }: { to: string; label: string; isActive: boolean; icon: typeof HomeIcon }) {
  return (
    <Link
      href={to}
      className={[
        'h-10 inline-flex items-center gap-2 rounded-full px-5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary backdrop-blur-xl',
        isActive
          ? 'bg-card/70 text-foreground ring-1 ring-white/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-card/30',
      ].join(' ')}
    >
      <Icon size={18} aria-hidden />
      {label}
    </Link>
  );
}
```

Changes from old code:
- `h-11` → `h-10`
- Removed entire `shadow-[inset_0_1px_0_rgba(255,255,255,0.16),inset_0_-1px_0_rgba(255,255,255,0.08),0_1px_18px_rgba(255,255,255,0.08),0_10px_28px_rgba(0,0,0,0.24)]`
- Inactive: removed `bg-card/35`, changed `hover:bg-card/60` → `hover:bg-card/30` (transparent when idle, subtle fill on hover)

- [ ] **Step 3: Run tests**

```bash
cd web && pnpm test AppShell
```
Expected: ALL 6 PASS — `bg-card/70` check still passes, new `h-10` / no-shadow check passes.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/AppShell.tsx web/src/components/AppShell.test.tsx
git commit -m "web: clean nav active pill — h-10, no inset shadow"
```

---

## Task 2: PromptInput Compact Sizing + Remove Yellow Focus Ring

**Files:**
- Modify: `web/src/components/studio/PromptInput.tsx`
- No test changes needed (tests check behavior, not CSS classes of container/buttons)

### Sizing targets

| Element | Old | New |
|---|---|---|
| Container padding | `p-8` | `pt-[14px] px-4 pb-4` (top=14px, h/v=16px, bottom=16px) |
| Container height | auto | `h-[174px]` |
| Container layout | block + `space-y-6` | `flex flex-col gap-3` |
| Textarea font | `text-2xl` | `text-sm` (14px) |
| Textarea sizing | `rows={5}` fixed | `flex-1 min-h-0` (fills remaining height ≈ 96px) |
| Textarea focus ring | `focus-visible:ring-2 focus-visible:ring-primary` (yellow) | removed |
| ControlButton height | `h-12` | `h-9` (36px) |
| ControlButton font | `text-base` | `text-xs` (12px) |
| ControlButton gap | `gap-2 px-4` | `gap-1.5 px-3` |
| Icon sizes | `size={18}` | `size={14}` |

Height math: 174px total − 14px top − 16px bottom − 12px gap − 36px button row = **96px for textarea**.

- [ ] **Step 1: Update container div (line 62)**

```tsx
// Old
<div className="bg-card/80 rounded-[2rem] border border-input/80 p-8 space-y-6 max-w-[780px] mx-auto relative shadow-2xl shadow-black/20 backdrop-blur-xl">

// New
<div className="bg-card/80 rounded-[2rem] border border-input/80 pt-[14px] px-4 pb-4 max-w-[780px] mx-auto relative shadow-2xl shadow-black/20 backdrop-blur-xl h-[174px] flex flex-col gap-3">
```

- [ ] **Step 2: Update textarea (lines 63–71)**

```tsx
// Old
<textarea
  value={text}
  onChange={(e) => setText(e.target.value)}
  onKeyDown={onKey}
  placeholder="开始一段灵感对话..."
  rows={5}
  className="w-full bg-transparent text-2xl text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md p-2"
  aria-label="生图 prompt"
/>

// New
<textarea
  value={text}
  onChange={(e) => setText(e.target.value)}
  onKeyDown={onKey}
  placeholder="开始一段灵感对话..."
  className="flex-1 min-h-0 w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none rounded-md px-2"
  aria-label="生图 prompt"
/>
```

Changes: removed `rows={5}`, `text-2xl` → `text-sm`, added `flex-1 min-h-0`, removed `focus-visible:ring-2 focus-visible:ring-primary`, `p-2` → `px-2`.

- [ ] **Step 3: Add `shrink-0` to the bottom controls row (line 72)**

```tsx
// Old
<div className="flex justify-between items-center gap-4">

// New
<div className="flex justify-between items-center gap-4 shrink-0">
```

- [ ] **Step 4: Update ControlButton component (lines 200–216)**

```tsx
function ControlButton({
  active,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={`inline-flex h-9 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
        active
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border bg-background/30 text-foreground hover:bg-secondary'
      } ${className}`}
      {...props}
    />
  );
}
```

Changes: `h-12` → `h-9`, `gap-2` → `gap-1.5`, `px-4` → `px-3`, `text-base` → `text-xs`.

- [ ] **Step 5: Shrink icon sizes in the 4 ControlButton usages (lines 74–96)**

Change all four `size={18}` to `size={14}` for icons inside ControlButtons:

```tsx
<ControlButton active aria-label="图片生成">
  <ImageIcon size={14} aria-hidden /> 图片生成
</ControlButton>
<ControlButton
  aria-label="选择厂商"
  onClick={() => setOpenPanel(openPanel === 'provider' ? null : 'provider')}
  disabled={providers.length === 0}
>
  <Building2 size={14} aria-hidden /> {provider ? provider.alias : '未配置厂商'}
</ControlButton>
<ControlButton
  aria-label="选择模型"
  onClick={() => setOpenPanel(openPanel === 'model' ? null : 'model')}
  disabled={!provider || models.length === 0}
>
  <Box size={14} aria-hidden /> {selectedModel ? selectedModel.name : '未配置模型'}
</ControlButton>
<ControlButton
  aria-label="选择比例和分辨率"
  onClick={() => setOpenPanel(openPanel === 'size' ? null : 'size')}
>
  <Square size={14} aria-hidden /> {ratio} <span className="text-muted-foreground">|</span> 高清 {resolution}
</ControlButton>
```

- [ ] **Step 6: Run tests and typecheck**

```bash
cd web && pnpm test Studio
```
Expected: ALL 5 PASS — behavior unchanged, only visual sizing changed.

```bash
cd web && pnpm lint
```
Expected: EXIT 0

- [ ] **Step 7: Commit**

```bash
git add web/src/components/studio/PromptInput.tsx
git commit -m "web: compact PromptInput — 14px text, 36px buttons, 174px height, no yellow focus ring"
```

---

## Task 3: Studio Full-Height Feed Layout

**Files:**
- Modify: `web/src/pages/Studio.tsx:84-108`
- Modify: `web/src/pages/Studio.test.tsx:63-66`

### Reference

jimeng.jianying.com layout: history feed fills the top scrollable area, prompt input is anchored at the bottom with a separator. No large `Studio.` heading in standalone mode.

- [ ] **Step 1: Update Studio.test.tsx — replace heading assertion**

In `web/src/pages/Studio.test.tsx`, replace lines 63–66:

```tsx
// Old
it('renders hero "Studio." in serif', () => {
  renderStudio();
  expect(screen.getByText('Studio.')).toBeInTheDocument();
});

// New
it('renders prompt input on studio page', () => {
  renderStudio();
  expect(screen.getByLabelText('生图 prompt')).toBeInTheDocument();
});
```

Run:
```bash
cd web && pnpm test Studio
```
Expected: This renamed test still PASSES (textarea already has this aria-label). All 5 still pass — confirming baseline before layout change.

- [ ] **Step 2: Restructure Studio.tsx render block (lines 84–108)**

Replace the entire `return (...)` block with a branch on `compact`:

```tsx
  if (compact) {
    return (
      <div className="py-8" aria-label="生图沙箱">
        <h1 className="text-2xl leading-tight mb-8 max-w-[780px] mx-auto font-semibold">
          描述你想生成的图片
        </h1>
        <PromptInput
          onSubmit={onSubmit}
          disabled={pending}
          initialValue={seedText}
          providers={keys}
          providerAlias={providerAlias}
          model={model}
          ratio={ratio}
          resolution={resolution}
          onProviderChange={setProviderAlias}
          onModelChange={setModel}
          onRatioChange={setRatio}
          onResolutionChange={setResolution}
        />
        {rounds.length === 0 && <InspirationChips onPick={(t) => setSeedText(t)} />}
        <RoundList rounds={rounds} />
      </div>
    );
  }

  return (
    <div
      className="h-[calc(100vh-80px)] flex flex-col overflow-hidden px-6"
      aria-label="生图沙箱"
    >
      <div className="flex-1 min-h-0 overflow-y-auto py-6">
        {rounds.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <InspirationChips onPick={(t) => setSeedText(t)} />
          </div>
        ) : (
          <RoundList rounds={rounds} />
        )}
      </div>
      <div className="shrink-0 py-4 border-t border-border/30">
        <PromptInput
          onSubmit={onSubmit}
          disabled={pending}
          initialValue={seedText}
          providers={keys}
          providerAlias={providerAlias}
          model={model}
          ratio={ratio}
          resolution={resolution}
          onProviderChange={setProviderAlias}
          onModelChange={setModel}
          onRatioChange={setRatio}
          onResolutionChange={setResolution}
        />
      </div>
    </div>
  );
```

Note: `h-[calc(100vh-80px)]` matches the current `h-20` header. T4 will update this to a responsive value after shrinking the header.

- [ ] **Step 3: Run all tests**

```bash
cd web && pnpm test
```
Expected: ALL 29 PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Studio.tsx web/src/pages/Studio.test.tsx
git commit -m "web: studio full-height feed — sticky bottom input, no heading"
```

---

## Task 4: Responsive Support for Viewports < 1280px

**Files:**
- Modify: `web/src/components/AppShell.tsx` (header height + nav gap)
- Modify: `web/src/pages/Studio.tsx` (height calc + padding)
- Modify: `web/src/pages/Home.tsx` (gallery columns)
- Modify: `web/src/components/studio/PromptInput.tsx` (dropdown overflow)

### 4A: AppShell responsive header

- [ ] **Step 1: Shrink header on mobile (AppShell.tsx line 36)**

```tsx
// Old
<div className="mx-auto flex h-20 items-center justify-between px-8">

// New
<div className="mx-auto flex h-14 md:h-20 items-center justify-between px-4 md:px-8">
```

- [ ] **Step 2: Reduce nav gap on mobile (AppShell.tsx line 46)**

```tsx
// Old
<nav className="flex items-center gap-3">

// New
<nav className="flex items-center gap-1 md:gap-3">
```

- [ ] **Step 3: Add responsive sizing to NavTab base className (AppShell.tsx line 14)**

```tsx
// Old base class string
'h-10 inline-flex items-center gap-2 rounded-full px-5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary backdrop-blur-xl',

// New
'h-9 md:h-10 inline-flex items-center gap-2 rounded-full px-3 md:px-5 text-xs md:text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary backdrop-blur-xl',
```

Note: `'h-9 md:h-10'.includes('h-10')` is `true` (substring of `md:h-10`), so the existing AppShell test `expect(tab.className).toContain('h-10')` still passes. ✓

- [ ] **Step 4: Run AppShell tests to confirm no regression**

```bash
cd web && pnpm test AppShell
```
Expected: ALL 6 PASS.

### 4B: Studio responsive height calc

Header changed from `h-20` (80px) to `h-14 md:h-20` (56px / 80px). Update the Studio full-height calc to match.

- [ ] **Step 5: Update Studio.tsx height and padding for non-compact mode**

In `web/src/pages/Studio.tsx`, change the outer div of the non-compact return:

```tsx
// Old (from T3)
<div
  className="h-[calc(100vh-80px)] flex flex-col overflow-hidden px-6"
  aria-label="生图沙箱"
>

// New
<div
  className="h-[calc(100vh-56px)] md:h-[calc(100vh-80px)] flex flex-col overflow-hidden px-3 sm:px-6"
  aria-label="生图沙箱"
>
```

Where `56px = h-14` (mobile header) and `80px = h-20` (desktop header).

Also update the compact heading to be responsive:

```tsx
// Old (from T3)
<h1 className="text-2xl leading-tight mb-8 max-w-[780px] mx-auto font-semibold">

// New
<h1 className="text-xl sm:text-2xl leading-tight mb-6 sm:mb-8 max-w-[780px] mx-auto font-semibold">
```

### 4C: Home gallery responsive columns

- [ ] **Step 6: Add `columns-2` base for small screens (Home.tsx)**

Change both `columns-3 lg:columns-4 2xl:columns-5` occurrences — one for the loading skeleton (line 36) and one for the success grid (line 73):

```tsx
// Old (both instances)
className="columns-3 lg:columns-4 2xl:columns-5 gap-6"

// New
className="columns-2 sm:columns-3 lg:columns-4 2xl:columns-5 gap-6"
```

### 4D: PromptInput dropdown overflow fix

On screens narrower than 640px (`sm`), the dropdown panels use `left-40`/`left-64`/`left-96` which overflow the viewport. Fix: full-width on mobile, positioned on sm+.

- [ ] **Step 7: Fix provider dropdown (PromptInput.tsx line 110)**

```tsx
// Old
className="absolute left-40 right-8 top-full z-20 mt-3 rounded-2xl border border-border bg-popover p-2 shadow-2xl"

// New
className="absolute left-0 sm:left-40 right-0 sm:right-8 top-full z-20 mt-3 rounded-2xl border border-border bg-popover p-2 shadow-2xl"
```

- [ ] **Step 8: Fix model dropdown (PromptInput.tsx line 135)**

```tsx
// Old
className="absolute left-64 right-8 top-full z-20 mt-3 rounded-2xl border border-border bg-popover p-2 shadow-2xl"

// New
className="absolute left-0 sm:left-64 right-0 sm:right-8 top-full z-20 mt-3 rounded-2xl border border-border bg-popover p-2 shadow-2xl"
```

- [ ] **Step 9: Fix size dropdown (PromptInput.tsx line 159)**

```tsx
// Old
className="absolute left-96 right-8 top-full z-20 mt-3 rounded-2xl border border-border bg-popover p-8 shadow-2xl space-y-8"

// New
className="absolute left-0 sm:left-96 right-0 sm:right-8 top-full z-20 mt-3 rounded-2xl border border-border bg-popover p-8 shadow-2xl space-y-8"
```

- [ ] **Step 10: Run all tests and lint**

```bash
cd web && pnpm test
```
Expected: ALL 29 PASS.

```bash
cd web && pnpm lint
```
Expected: EXIT 0.

- [ ] **Step 11: Commit**

```bash
git add web/src/components/AppShell.tsx web/src/pages/Studio.tsx web/src/pages/Home.tsx web/src/components/studio/PromptInput.tsx
git commit -m "web: responsive layout for viewports <1280px"
```

---

## Self-Review

**Spec coverage:**
- ✓ T1: NavTab `h-10`, no shadow (tapnow reference: clean dark pill)
- ✓ T2: PromptInput `text-sm` textarea, `h-9 text-xs` buttons, `pt-[14px] px-4 pb-4` padding, `h-[174px]` total height
- ✓ T2: No yellow focus ring (removed `focus-visible:ring-2 focus-visible:ring-primary` from textarea)
- ✓ T3: Studio non-compact = full-height feed, sticky PromptInput at bottom with border-t separator, InspirationChips centered in empty state (jimeng reference)
- ✓ T4: `<1280px` — header `h-14 md:h-20`, nav responsive sizing, gallery `columns-2` base, dropdown full-width on mobile

**Breaking tests addressed:**
- `AppShell.test.tsx`: keeps `bg-card/70` → existing 5 tests pass; adds 1 new test
- `Studio.test.tsx`: `renders hero "Studio."` replaced with `renders prompt input on studio page` (heading removed from non-compact layout)
- `Home.test.tsx`: no changes needed (heading `描述你想生成的图片` is in compact mode, unchanged)

**Type consistency:**
- `ControlButton` only used inside `PromptInput.tsx` — all usages updated in T2 Step 5
- `NavTab` updated once in T1, then extended with responsive classes in T4 Step 3 (same file)
- `Studio` compact/non-compact branch shares same state, same props to `PromptInput` — no type divergence
