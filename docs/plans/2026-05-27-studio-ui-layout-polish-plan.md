# Studio UI Layout Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the Studio prompt controls, generation result layout, and provider/model menus to match the 2026-05-27 visual references.

**Architecture:** Keep this as a focused frontend change. `PromptInput` owns the ratio/resolution/provider/model controls. `Studio` owns selected generation config and job actions. `RoundList` renders one generation batch per job instead of one image per round, so prompt/model/size/resolution/reference images/actions all come from structured job data.

**Tech Stack:** React 18.3, TypeScript 5.6, Tailwind v4.3, lucide-react, Vitest 2, Testing Library, pnpm.

---

## Assumptions And Decisions

- Reference images are read from `job.source_image`, `job.params.reference_images`, or `job.params.lovart_attachments` if present. If none exist, hide the reference thumbnail.
- “当前批次” means one Studio job. A done job may have multiple `output_paths`; render those images together in one row/grid and delete them as one batch.
- “删除当前批次的结果” should remove each image through the existing `DELETE /api/jobs/{job_id}/image?path=...` endpoint, then remove the batch from UI when all deletes succeed. Do not call `DELETE /api/jobs/{job_id}` for done jobs because that endpoint currently rejects non-failed jobs.
- “重新编辑” fills the bottom prompt input and restores provider alias, model, ratio, resolution, and size config. It does not auto-submit.
- “再次生成” submits a new Studio job immediately with the same prompt, alias, model, ratio, resolution, and size config.
- Keep existing compact Home behavior: Home prompt still submits then navigates to `/studio`; Home should not render generation history.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `web/src/components/studio/PromptInput.tsx` | Modify | Ratio/resolution/size UI, remove 智能 ratio, provider/model menu dimensions, controlled prompt text support for re-edit |
| `web/src/components/studio/RoundList.tsx` | Modify | Batch result header, multi-image layout, action buttons, more menu, delete batch |
| `web/src/pages/Studio.tsx` | Modify | Round data mapping, re-edit/re-generate handlers, controlled prompt state, delete done batch |
| `web/src/pages/Studio.test.tsx` | Modify | Behavioral tests for controls, batch metadata, re-edit, regenerate, delete |
| `web/src/pages/Home.test.tsx` | Modify only if needed | Ensure compact prompt still opens menus downward and submits |

---

## Task 1: PromptInput Ratio, Resolution, And Size Styling

**Files:**
- Modify: `web/src/components/studio/PromptInput.tsx`
- Test: `web/src/pages/Studio.test.tsx`

- [ ] **Step 1: Add failing tests for the new size panel**

Add these tests inside `describe('Studio', ...)` in `web/src/pages/Studio.test.tsx`:

```tsx
it('renders the size panel without smart ratio and with emphasized 1:1 option', async () => {
  renderStudio();

  fireEvent.click(await screen.findByRole('button', { name: /选择比例和分辨率/ }));

  expect(screen.queryByRole('option', { name: '智能' })).not.toBeInTheDocument();
  expect(screen.getByRole('option', { name: '1:1' })).toHaveClass('w-[59px]', 'h-[90px]');
  expect(screen.getByRole('option', { name: '4:3' })).toHaveClass('w-[53.5px]', 'h-[43px]');
  expect(screen.getByRole('option', { name: /高清 2K/ })).toHaveClass('h-10', 'text-[13px]');
  expect(screen.getByLabelText('输出宽度')).toHaveClass('h-10', 'text-[13px]');
  expect(screen.getByLabelText('输出高度')).toHaveClass('h-10', 'text-[13px]');
});
```

Run:

```bash
cd web && pnpm test Studio
```

Expected: FAIL because `智能` still exists, ratio buttons still use grid sizing, and width/height readouts have no labels/classes.

- [ ] **Step 2: Replace ratio constants**

In `web/src/components/studio/PromptInput.tsx`, replace:

```tsx
const RATIOS = ['智能', '21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'];
```

with:

```tsx
const RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
const SIDE_RATIOS = ['4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
```

- [ ] **Step 3: Replace the ratio listbox markup**

In the `openPanel === 'size'` branch, replace the ratio `div role="listbox"` with:

```tsx
<div
  role="listbox"
  aria-label="选择比例"
  className="flex gap-3 rounded-2xl bg-secondary p-2"
>
  <button
    type="button"
    role="option"
    aria-selected={ratio === '1:1'}
    onClick={() => onRatioChange?.('1:1')}
    className="flex h-[90px] w-[59px] shrink-0 flex-col items-center justify-center gap-2 rounded-xl text-[13px] hover:bg-card aria-selected:bg-card transition-colors"
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
        className="flex h-[43px] w-[53.5px] flex-col items-center justify-center gap-0.5 rounded-lg text-[13px] hover:bg-card aria-selected:bg-card transition-colors"
      >
        <RatioIcon ratio={item} box={18} />
        <span>{item}</span>
      </button>
    ))}
  </div>
</div>
```

- [ ] **Step 4: Update resolution and size readout classes**

Replace the resolution option button class:

```tsx
className="rounded-xl py-4 text-center text-base hover:bg-card aria-selected:bg-card transition-colors"
```

with:

```tsx
className="h-10 rounded-xl text-center text-[13px] hover:bg-card aria-selected:bg-card transition-colors"
```

Replace the width/height readouts with labeled 40px components:

```tsx
<div aria-label="输出宽度" className="flex h-10 flex-1 items-center gap-3 rounded-xl bg-secondary px-4 text-[13px]">
  <span className="font-medium text-muted-foreground">W</span>
  <span className="flex-1 text-center tabular-nums">{computePixelSize(ratio, resolution).w}</span>
</div>
<Link2 size={16} className="shrink-0 text-muted-foreground" aria-hidden />
<div aria-label="输出高度" className="flex h-10 flex-1 items-center gap-3 rounded-xl bg-secondary px-4 text-[13px]">
  <span className="font-medium text-muted-foreground">H</span>
  <span className="flex-1 text-center tabular-nums">{computePixelSize(ratio, resolution).h}</span>
</div>
```

- [ ] **Step 5: Update `RatioIcon` signature**

Replace:

```tsx
function RatioIcon({ ratio }: { ratio: string }) {
  const box = 20;
  if (ratio === '智能') {
    return (
      <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="2" width={box - 4} height={box - 4} rx="2" />
        <path d="M7 10h6M10 7v6" strokeLinecap="round" />
      </svg>
    );
  }
```

with:

```tsx
function RatioIcon({ ratio, box = 20 }: { ratio: string; box?: number }) {
```

Keep the remaining aspect-ratio rectangle math unchanged.

- [ ] **Step 6: Verify**

Run:

```bash
cd web && pnpm test Studio
```

Expected: PASS. Existing submit test should still post `ratio`, `resolution`, and `size`.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/studio/PromptInput.tsx web/src/pages/Studio.test.tsx
git commit -m "web: polish studio size controls"
```

---

## Task 2: Provider And Model Menu Dimensions

**Files:**
- Modify: `web/src/components/studio/PromptInput.tsx`
- Test: `web/src/pages/Studio.test.tsx`

- [ ] **Step 1: Add failing menu dimension test**

Add:

```tsx
it('uses fixed width and row height for provider and model menus', async () => {
  renderStudio();

  fireEvent.click(await screen.findByRole('button', { name: /选择厂商/ }));
  expect(screen.getByRole('listbox', { name: '选择厂商列表' })).toHaveClass('w-[280px]', 'max-h-[400px]');
  expect(screen.getByRole('option', { name: /volc/ })).toHaveClass('h-[58px]', 'text-sm');

  fireEvent.click(screen.getByRole('button', { name: /选择模型/ }));
  expect(screen.getByRole('listbox', { name: '选择模型列表' })).toHaveClass('w-[280px]', 'max-h-[400px]');
  expect(screen.getByRole('option', { name: /图片 5.0 Lite/ })).toHaveClass('h-[58px]', 'text-sm');
});
```

Run:

```bash
cd web && pnpm test Studio
```

Expected: FAIL because current menus stretch from `left-*` to `right-*` and use `py-4`.

- [ ] **Step 2: Update provider listbox class**

Replace the provider panel container class with:

```tsx
className={`absolute left-0 sm:left-40 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-popover p-2 shadow-2xl`}
```

Replace each provider option class with:

```tsx
className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary aria-selected:bg-secondary"
```

Inside the provider option, reduce text sizes:

```tsx
<Building2 size={20} aria-hidden />
<span className="min-w-0">
  <span className="block truncate text-sm font-medium">{providerName(item)}</span>
  <span className="block truncate text-xs text-muted-foreground">{item.alias} · {item.models.length} models</span>
</span>
```

- [ ] **Step 3: Update model listbox class**

Replace the model panel container class with:

```tsx
className={`absolute left-0 sm:left-64 ${panelPosition} z-20 w-[280px] max-h-[400px] overflow-y-auto rounded-2xl border border-border bg-popover p-2 shadow-2xl`}
```

Replace each model option class with:

```tsx
className="flex h-[58px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-secondary aria-selected:bg-secondary"
```

Inside the model option:

```tsx
<Box size={22} aria-hidden />
<span className="min-w-0">
  <span className="block truncate text-sm font-medium">{item.name}</span>
  <span className="block truncate text-xs text-muted-foreground">{item.id}</span>
</span>
```

- [ ] **Step 4: Verify**

Run:

```bash
cd web && pnpm test Studio
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/studio/PromptInput.tsx web/src/pages/Studio.test.tsx
git commit -m "web: constrain studio provider model menus"
```

---

## Task 3: Render Done Results As Batches With Metadata And Actions

**Files:**
- Modify: `web/src/components/studio/RoundList.tsx`
- Modify: `web/src/pages/Studio.tsx`
- Test: `web/src/pages/Studio.test.tsx`

- [ ] **Step 1: Add failing tests for done batch metadata and actions**

Add:

```tsx
it('renders a completed studio batch with metadata and action buttons', async () => {
  globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          default_alias: 'volc',
          keys: [{
            alias: 'volc',
            provider: 'seedream',
            access_key: 'ark...key',
            secret_key: null,
            capabilities: ['portrait'],
            models: [{ name: '图片 4.7', id: 'doubao-seedream-4-5-251128' }],
            notes: '',
            created_at: '2026-05-25T00:00:00Z',
            is_default: true,
          }],
        }),
      } as any);
    }
    if (url === '/api/jobs') {
      return Promise.resolve({
        ok: true,
        json: async () => [{
          job_id: 'job-studio-1',
          character_id: 'volc',
          prompt: '一个身披白床单的幽灵般的身影在上海某城市公园的儿童游乐场玩耍，她戴着太阳镜，没有眼。背景是万圣节夜森。',
          submitted_at: '2026-05-27T01:00:00Z',
          model: 'doubao-seedream-4-5-251128',
          params: {
            ratio: '4:3',
            resolution: '2K',
            size: '2048x1536',
            reference_images: ['/tmp/ref.png'],
          },
          seed: null,
          output_paths: ['/tmp/studio/job-studio-1/v1.png', '/tmp/studio/job-studio-1/v2.png'],
          status: 'done',
          error: null,
          kind: 'image',
          namespace: 'studio',
          alias: 'volc',
          provider: 'seedream',
        }],
      } as any);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as any);
  }) as any;

  renderStudio();

  expect(await screen.findByText(/一个身披白床单/)).toHaveClass('line-clamp-2');
  expect(screen.getByRole('img', { name: '参考图' })).toHaveAttribute('src', '/api/gallery/image?path=%2Ftmp%2Fref.png');
  expect(screen.getByText(/图片 4.7/)).toBeInTheDocument();
  expect(screen.getByText(/4:3/)).toBeInTheDocument();
  expect(screen.getByText(/2048x1536/)).toBeInTheDocument();
  expect(screen.getAllByRole('img', { name: /生成结果/ })).toHaveLength(2);
  expect(screen.getByRole('button', { name: '重新编辑' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '再次生成' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '更多操作' })).toBeInTheDocument();
});
```

Run:

```bash
cd web && pnpm test Studio
```

Expected: FAIL because current done rounds render one image only and no metadata/actions.

- [ ] **Step 2: Replace `RoundState` with batch-capable shape**

In `web/src/components/studio/RoundList.tsx`, replace `RoundState` with:

```tsx
export interface RoundConfig {
  prompt: string;
  alias?: string | null;
  provider?: string | null;
  model: string;
  modelName?: string;
  ratio?: string;
  resolution?: '2K' | '4K';
  size?: string;
  referenceImages: string[];
}

export type RoundState =
  | { kind: 'pending'; startedAt: number; config: RoundConfig }
  | { kind: 'done'; jobId: string; submittedAt: string; imagePaths: string[]; config: RoundConfig }
  | { kind: 'failed'; jobId?: string; submittedAt: string; reason: string };
```

Update props:

```tsx
export function RoundList({
  rounds,
  onDeleteFailed,
  onReEdit,
  onRegenerate,
  onDeleteBatch,
}: {
  rounds: RoundState[];
  onDeleteFailed?: (jobId: string) => void | Promise<void>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
  onDeleteBatch?: (jobId: string, imagePaths: string[]) => void | Promise<void>;
}) {
```

- [ ] **Step 3: Replace `DoneImage` with `DoneBatch`**

Delete `DoneImage` and add:

```tsx
function imageSrc(path: string) {
  return `/api/gallery/image?path=${encodeURIComponent(path)}`;
}

function DoneBatch({
  round,
  onReEdit,
  onRegenerate,
  onDeleteBatch,
}: {
  round: Extract<RoundState, { kind: 'done' }>;
  onReEdit?: (config: RoundConfig) => void;
  onRegenerate?: (config: RoundConfig) => void | Promise<void>;
  onDeleteBatch?: (jobId: string, imagePaths: string[]) => void | Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const meta = [
    round.config.modelName ?? round.config.model,
    round.config.size,
    round.config.ratio,
    round.config.resolution,
  ].filter(Boolean);

  return (
    <section className="space-y-3">
      <div className="flex items-start gap-3 text-sm">
        {round.config.referenceImages[0] && (
          <img
            src={imageSrc(round.config.referenceImages[0])}
            alt="参考图"
            className="h-14 w-14 rounded-md object-cover"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-base leading-7 text-foreground" title={round.config.prompt}>
            {round.config.prompt}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{meta.join(' | ')}</p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-4">
        {round.imagePaths.map((path, index) => (
          <figure key={path} className="group relative overflow-hidden rounded-md bg-card">
            <img
              src={imageSrc(path)}
              alt={`生成结果 ${index + 1}`}
              className="h-full w-full object-contain"
            />
            <a
              href={imageSrc(path)}
              download={path.split('/').pop() || `${round.jobId}-${index + 1}.png`}
              aria-label={`下载生成结果 ${index + 1}`}
              title="下载图片"
              className="absolute right-2 top-2 grid size-8 place-items-center rounded-full border border-white/20 bg-black/70 text-white opacity-0 shadow-lg backdrop-blur-sm transition-opacity hover:bg-black/85 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Download className="size-4" aria-hidden />
            </a>
          </figure>
        ))}
      </div>
      <div className="relative flex items-center gap-2">
        <ActionButton onClick={() => onReEdit?.(round.config)}>重新编辑</ActionButton>
        <ActionButton onClick={() => { void onRegenerate?.(round.config); }}>再次生成</ActionButton>
        <ActionButton aria-label="更多操作" onClick={() => setMenuOpen((value) => !value)}>...</ActionButton>
        {menuOpen && (
          <div className="absolute left-0 top-full z-10 mt-2 w-44 rounded-xl border border-border bg-popover p-1 shadow-xl">
            <button
              type="button"
              className="h-10 w-full rounded-lg px-3 text-left text-sm text-destructive hover:bg-destructive/10"
              onClick={() => {
                setMenuOpen(false);
                void onDeleteBatch?.(round.jobId, round.imagePaths);
              }}
            >
              删除当前批次的结果
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

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

Also update imports:

```tsx
import { type ButtonHTMLAttributes, useState } from 'react';
import { Download } from 'lucide-react';
```

- [ ] **Step 4: Render `DoneBatch` from the list**

Replace:

```tsx
{r.kind === 'done' && <DoneImage round={r} />}
```

with:

```tsx
{r.kind === 'done' && (
  <DoneBatch
    round={r}
    onReEdit={onReEdit}
    onRegenerate={onRegenerate}
    onDeleteBatch={onDeleteBatch}
  />
)}
```

Update pending display to use `r.config.prompt` if needed:

```tsx
{r.kind === 'pending' && <WaitingCopy startedAt={r.startedAt} />}
```

- [ ] **Step 5: Update `Studio.tsx` round creation and persisted mapping**

Add helper functions:

```tsx
function referenceImagesFor(job: Job): string[] {
  const params = job.params ?? {};
  const refs = [
    job.source_image,
    ...(Array.isArray(params.reference_images) ? params.reference_images : []),
    ...(Array.isArray(params.lovart_attachments) ? params.lovart_attachments : []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return Array.from(new Set(refs));
}

function configForJob(job: Job, modelName?: string): RoundConfig {
  return {
    prompt: job.prompt,
    alias: job.alias,
    provider: job.provider,
    model: job.model,
    modelName,
    ratio: typeof job.params.ratio === 'string' ? job.params.ratio : undefined,
    resolution: job.params.resolution === '4K' ? '4K' : job.params.resolution === '2K' ? '2K' : undefined,
    size: typeof job.params.size === 'string' ? job.params.size : undefined,
    referenceImages: referenceImagesFor(job),
  };
}
```

Import `RoundConfig`:

```tsx
import { RoundList, type RoundConfig, type RoundState } from '@/components/studio/RoundList';
```

When creating a pending round in `onSubmit`, replace:

```tsx
const myRound: RoundState = { kind: 'pending', startedAt, promptPreview: prompt };
```

with:

```tsx
const selectedKey = keys.find((item) => item.alias === providerAlias);
const selectedModel = selectedKey?.models.find((item) => item.id === model);
const config: RoundConfig = {
  prompt,
  alias: providerAlias,
  provider: selectedKey?.provider,
  model,
  modelName: selectedModel?.name,
  ratio,
  resolution,
  size: sizeFor(ratio, resolution),
  referenceImages: [],
};
const myRound: RoundState = { kind: 'pending', startedAt, config };
```

When converting a done final job, replace `imagePath` and `promptPreview` fields with:

```tsx
{
  kind: 'done',
  jobId: final.job_id,
  submittedAt: final.submitted_at,
  imagePaths: final.output_paths,
  config,
}
```

Update `studioJobsToRounds` so a done job returns one round per job:

```tsx
if (job.status === 'done' && job.output_paths.length > 0) {
  return [{
    kind: 'done' as const,
    jobId: job.job_id,
    submittedAt: job.submitted_at,
    imagePaths: job.output_paths,
    config: configForJob(job),
  }];
}
```

For pending persisted jobs:

```tsx
return [{
  kind: 'pending' as const,
  startedAt: Date.parse(job.submitted_at) || Date.now(),
  config: configForJob(job),
}];
```

- [ ] **Step 6: Verify**

Run:

```bash
cd web && pnpm test Studio
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/studio/RoundList.tsx web/src/pages/Studio.tsx web/src/pages/Studio.test.tsx
git commit -m "web: render studio results as action batches"
```

---

## Task 4: Re-Edit, Regenerate, And Delete Done Batch

**Files:**
- Modify: `web/src/components/studio/PromptInput.tsx`
- Modify: `web/src/pages/Studio.tsx`
- Test: `web/src/pages/Studio.test.tsx`

- [ ] **Step 1: Add controlled prompt support to `PromptInput`**

In `Props`, add:

```tsx
value?: string;
onValueChange?: (value: string) => void;
```

Replace:

```tsx
const [text, setText] = useState('');
```

with:

```tsx
const [internalText, setInternalText] = useState('');
const text = value ?? internalText;
const setText = onValueChange ?? setInternalText;
```

Keep existing `onChange={(e) => setText(e.target.value)}` unchanged.

- [ ] **Step 2: Add failing tests for actions**

Add:

```tsx
it('re-edits a completed batch into the prompt input and restores controls', async () => {
  // Reuse the completed job mock from the metadata test.
  renderStudioWithCompletedBatch();

  fireEvent.click(await screen.findByRole('button', { name: '重新编辑' }));

  expect(screen.getByLabelText('生图 prompt')).toHaveValue(expect.stringContaining('一个身披白床单'));
  expect(screen.getByRole('button', { name: /4:3/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /高清 2K/ })).toBeInTheDocument();
});

it('regenerates a completed batch with the same config', async () => {
  const fetchMock = mockCompletedBatchAndKeys();
  renderStudio();

  fireEvent.click(await screen.findByRole('button', { name: '再次生成' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/studio/jobs', expect.any(Object)));
  const studioCall = fetchMock.mock.calls.find(([url, init]) => url === '/api/studio/jobs' && init?.method === 'POST');
  const body = JSON.parse(String(studioCall![1]!.body));
  expect(body).toMatchObject({
    prompt: expect.stringContaining('一个身披白床单'),
    alias: 'volc',
    model: 'doubao-seedream-4-5-251128',
    params: {
      ratio: '4:3',
      resolution: '2K',
      size: '2048x1536',
    },
  });
});

it('deletes every image in a completed batch through image delete endpoints', async () => {
  const fetchMock = mockCompletedBatchAndKeys();
  renderStudio();

  fireEvent.click(await screen.findByRole('button', { name: '更多操作' }));
  fireEvent.click(screen.getByRole('button', { name: '删除当前批次的结果' }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-studio-1/image?path=%2Ftmp%2Fstudio%2Fjob-studio-1%2Fv1.png', { method: 'DELETE' });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-studio-1/image?path=%2Ftmp%2Fstudio%2Fjob-studio-1%2Fv2.png', { method: 'DELETE' });
  });
  await waitFor(() => {
    expect(screen.queryByRole('img', { name: '生成结果 1' })).not.toBeInTheDocument();
  });
});
```

Create small test helpers above the tests to avoid duplicating mocks:

```tsx
function mockCompletedBatchAndKeys() {
  const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          default_alias: 'volc',
          keys: [{
            alias: 'volc',
            provider: 'seedream',
            access_key: 'ark...key',
            secret_key: null,
            capabilities: ['portrait'],
            models: [{ name: '图片 4.7', id: 'doubao-seedream-4-5-251128' }],
            notes: '',
            created_at: '2026-05-25T00:00:00Z',
            is_default: true,
          }],
        }),
      } as any);
    }
    if (url === '/api/jobs') {
      return Promise.resolve({
        ok: true,
        json: async () => [{
          job_id: 'job-studio-1',
          character_id: 'volc',
          prompt: '一个身披白床单的幽灵般的身影在上海某城市公园的儿童游乐场玩耍',
          submitted_at: '2026-05-27T01:00:00Z',
          model: 'doubao-seedream-4-5-251128',
          params: { ratio: '4:3', resolution: '2K', size: '2048x1536' },
          seed: null,
          output_paths: ['/tmp/studio/job-studio-1/v1.png', '/tmp/studio/job-studio-1/v2.png'],
          status: 'done',
          error: null,
          kind: 'image',
          namespace: 'studio',
          alias: 'volc',
          provider: 'seedream',
        }],
      } as any);
    }
    if (String(url).startsWith('/api/jobs/job-studio-1/image')) {
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as any);
    }
    if (url === '/api/studio/jobs') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          job_id: 'job-studio-2',
          status: 'pending',
          submitted_at: '2026-05-27T02:00:00Z',
        }),
      } as any);
    }
    if (url === '/api/jobs/job-studio-2') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          job_id: 'job-studio-2',
          status: 'failed',
          submitted_at: '2026-05-27T02:00:00Z',
          output_paths: [],
          error: 'test stop',
        }),
      } as any);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as any);
  });
  globalThis.fetch = fetchMock as any;
  return fetchMock;
}

function renderStudioWithCompletedBatch() {
  mockCompletedBatchAndKeys();
  return renderStudio();
}
```

- [ ] **Step 3: Wire controlled prompt state in `Studio.tsx`**

Add state:

```tsx
const [promptText, setPromptText] = useState('');
```

Pass to both `PromptInput` usages:

```tsx
value={promptText}
onValueChange={setPromptText}
```

In `onSubmit`, after `const trimmed = text.trim()` happens inside `PromptInput`, `PromptInput` will clear through `setText('')`. No extra clearing is needed in `Studio`.

- [ ] **Step 4: Add action handlers in `Studio.tsx`**

Add inside `Studio`:

```tsx
function reEdit(config: RoundConfig) {
  setPromptText(config.prompt);
  if (config.alias) setProviderAlias(config.alias);
  setModel(config.model);
  if (config.ratio) setRatio(config.ratio);
  if (config.resolution) setResolution(config.resolution);
}

async function regenerate(config: RoundConfig) {
  if (config.alias) setProviderAlias(config.alias);
  setModel(config.model);
  if (config.ratio) setRatio(config.ratio);
  if (config.resolution) setResolution(config.resolution);
  await onSubmit(config.prompt, config);
}

async function deleteDoneBatch(jobId: string, imagePaths: string[]) {
  const responses = await Promise.all(
    imagePaths.map((path) =>
      fetch(`/api/jobs/${encodeURIComponent(jobId)}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
    ),
  );
  if (responses.some((resp) => !resp.ok)) return;
  setRounds((items) => items.filter((item) => item.kind !== 'done' || item.jobId !== jobId));
}
```

Change `onSubmit` signature so regeneration can reuse a supplied config:

```tsx
const onSubmit = async (prompt: string, overrideConfig?: RoundConfig) => {
  const effectiveRatio = overrideConfig?.ratio ?? ratio;
  const effectiveResolution = overrideConfig?.resolution ?? resolution;
  const effectiveAlias = overrideConfig?.alias ?? providerAlias;
  const effectiveModel = overrideConfig?.model ?? model;
  const effectiveSize = overrideConfig?.size ?? sizeFor(effectiveRatio, effectiveResolution);
```

Use `effectiveAlias`, `effectiveModel`, `effectiveRatio`, `effectiveResolution`, and `effectiveSize` in `createStudioJob` and pending config.

Pass handlers to `RoundList`:

```tsx
<RoundList
  rounds={rounds}
  onDeleteFailed={deleteFailedRound}
  onReEdit={reEdit}
  onRegenerate={regenerate}
  onDeleteBatch={deleteDoneBatch}
/>
```

- [ ] **Step 5: Verify**

Run:

```bash
cd web && pnpm test Studio
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/studio/PromptInput.tsx web/src/pages/Studio.tsx web/src/pages/Studio.test.tsx
git commit -m "web: add studio batch reuse actions"
```

---

## Task 5: Full Regression, Build, And Visual QA

**Files:**
- Modify only if tests reveal regressions: `web/src/pages/Home.test.tsx`, `web/src/components/studio/PromptInput.tsx`, `web/src/pages/Studio.tsx`, `web/src/components/studio/RoundList.tsx`

- [ ] **Step 1: Run targeted tests**

```bash
cd web && pnpm test Studio Home
```

Expected: PASS.

- [ ] **Step 2: Run all frontend checks**

```bash
cd web && pnpm test
cd web && pnpm lint
cd web && pnpm build
```

Expected:
- `pnpm test`: all tests pass. Existing React `act(...)` warning may remain if unchanged from baseline.
- `pnpm lint`: pass.
- `pnpm build`: pass.

- [ ] **Step 3: Manual visual check**

Start dev server if none is running:

```bash
cd web && pnpm dev --host 127.0.0.1
```

Open `/studio` and verify:
- Size menu opens upward on Studio and downward on Home.
- `1:1` ratio button is visually large on the left; other ratios are compact on the right.
- Resolution and width/height components are 40px tall and 13px text.
- Provider/model menus are 280px wide, max 400px tall, 58px rows, 14px text, scroll when content exceeds height.
- Done result header shows reference image only when available, prompt max two lines, model, size, ratio, resolution.
- Done result footer shows `重新编辑`, `再次生成`, and `...`; the more menu contains only `删除当前批次的结果`.
- Re-edit fills the bottom prompt and restores model/ratio/resolution without submitting.
- Regenerate immediately creates a new pending round.
- Delete batch removes images from the UI after successful image-delete calls.

- [ ] **Step 4: Commit final fixes if any**

```bash
git add web/src/components/studio/PromptInput.tsx web/src/components/studio/RoundList.tsx web/src/pages/Studio.tsx web/src/pages/Studio.test.tsx web/src/pages/Home.test.tsx
git commit -m "web: verify studio layout polish"
```

Skip this commit if Step 1-3 required no file changes after Task 4.

---

## Self-Review

- Spec coverage:
  - Requirement 1 covered by Task 1: remove 智能, large left `1:1` at `59x90`, side ratios at `53.5x43`, resolution/size controls `13px` and `40px`.
  - Requirement 2 covered by Task 3 and Task 4: result metadata, reference image, two-line prompt with `title`, model/size/resolution, re-edit, regenerate, more menu, delete current batch.
  - Requirement 3 covered by Task 2: provider/model menus at `14px`, `58px` rows, max `400px`, width `280px`.
- Placeholder scan: no `TBD`, `TODO`, or unresolved implementation placeholders.
- Type consistency:
  - `RoundConfig` is defined in `RoundList.tsx` and imported by `Studio.tsx`.
  - `RoundState.done.imagePaths` replaces old `imagePath` everywhere.
  - `PromptInput.value/onValueChange` are optional, so Home compact usage remains compatible.
