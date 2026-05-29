# Studio OpenAI-HK Responsive Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复出图页刷新/切页后正在生成记录丢失、去掉批次顶部时间样式、稳定 OpenAI-HK GPT Image 2 图片下载、隐藏工坊 pending_confirm 提示卡，并让小于 1280px 的前端仍可使用。

**Architecture:** 保持文件系统 job JSON 作为 source of truth，前端 Studio 只把 `/api/jobs` 中 `namespace="studio"` 的记录映射成 UI round，并在存在非终态 job 时持续刷新。OpenAI-HK 下载链路从 `urllib` URL 下载改为 `requests` 带重试，避免 `IncompleteRead` 直接失败。响应式修复以移除全局 viewport 阻断为主，只补结构性布局约束，不重做视觉系统。

**Tech Stack:** React 18 + TypeScript + Vitest + Tailwind v4；Python 3.11 + Pydantic + pytest + requests；现有 `/api/jobs`、`/api/studio/jobs`、job runner 协议。

---

## Scope Check

这 5 个问题跨前端 Studio、工坊页和 OpenAI-compatible caller，但共享同一条 job 状态链路，可以作为一个计划执行。最小成功标准：

- `/studio` 刷新或离开后返回，仍显示 `pending` studio job，并在 job 变为 `done` 后自动更新为图片批次。
- Studio 批次顶部不再显示 `toLocaleTimeString()` 那条时间样式。
- OpenAI-HK 返回图片 URL 且第一次下载抛 `IncompleteRead` / `ChunkedEncodingError` 时，会重试并落盘成功。
- 工坊角色页不再展示“1 个 job 等终端确认”提示卡。
- `window.innerWidth < 1280` 时不再显示“请在桌面浏览器打开”阻断页，主要页面仍可进入。

## File Structure

- Modify: `web/src/api/studio.ts`
  - 增加 `listStudioJobs()` 和 `getStudioJob()`，把 Studio 对 `/api/jobs` 的读取集中到 API helper。
- Modify: `web/src/pages/Studio.tsx`
  - 用 helper 加载持久化 studio jobs。
  - job 创建返回后立刻把 `jobId` 写回本地 pending round。
  - 页面存在 `pending` / `pending_confirm` studio job 时，每 2 秒刷新 `/api/jobs`。
- Modify: `web/src/components/studio/RoundList.tsx`
  - 删除批次顶部时间行，只保留 pending 的等待文案和卡片本体。
- Modify: `web/src/pages/Studio.test.tsx`
  - 覆盖 pending job 刷新恢复、pending job 轮询转 done、时间样式消失。
- Modify: `src/character_workflow/lib/callers/openai_image.py`
  - URL 图片下载改用 `requests.get()` + 3 次重试 + 统一错误信息。
- Modify: `tests/test_openai_image.py`
  - 覆盖第一次下载 `ChunkedEncodingError` 后第二次成功。
- Modify: `web/src/components/CharacterGallery.tsx`
  - 移除 `PendingConfirmBadge` 渲染、函数和 `Clock` import。
  - `pending_confirm` 不再参与 `hasAny`，让只有待终端确认 job 的 tab 按空状态展示。
- Create: `web/src/components/CharacterGallery.test.tsx`
  - 覆盖 pending_confirm job 不显示“等终端确认”。
- Modify: `web/src/App.tsx`
  - 删除 `MinViewportGuard` 包裹。
- Delete: `web/src/components/MinViewportGuard.tsx`
  - 该组件的唯一功能就是阻断小于 1280px。
- Modify: `web/src/App.test.tsx`
  - 覆盖 1024px 宽度仍进入 AppShell。
- Modify: `web/src/components/AppShell.tsx`
  - 给 header/nav 增加小宽度下的 `min-w-0`、`overflow-x-auto` 和紧凑间距，避免导航挤爆。
- Modify: `web/src/components/studio/PromptInput.tsx`
  - 小宽度下 prompt shell 改为 `min-h-[174px] h-auto`，底部 controls 可换行，避免按钮溢出。

---

### Task 1: Studio Pending Job Persistence

**Files:**
- Modify: `web/src/api/studio.ts`
- Modify: `web/src/pages/Studio.tsx`
- Test: `web/src/pages/Studio.test.tsx`

- [ ] **Step 1: Add failing test for restored pending jobs**

Append this test inside `describe('Studio', ...)` in `web/src/pages/Studio.test.tsx`:

```tsx
it('restores a pending studio job after returning to the page', async () => {
  globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          default_alias: 'oa',
          keys: [{
            alias: 'oa',
            provider: 'openai',
            access_key: 'sk',
            secret_key: null,
            capabilities: [],
            models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
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
          job_id: 'job-pending-1',
          character_id: 'oa',
          prompt: '刷新后仍在生成的画面',
          submitted_at: '2026-05-28T02:00:00Z',
          model: 'gpt-image-2',
          params: { ratio: '1:1', resolution: '2K', size: '1024x1024' },
          seed: null,
          output_paths: [],
          status: 'pending',
          error: null,
          kind: 'image',
          namespace: 'studio',
          alias: 'oa',
          provider: 'openai',
        }],
      } as any);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as any);
  }) as any;

  renderStudio();

  expect(await screen.findByText('刷新后仍在生成的画面')).toBeInTheDocument();
  expect(screen.getByTestId('studio-pending-job-pending-1')).toBeInTheDocument();
});
```

- [ ] **Step 2: Add failing test for persisted pending refresh turning done**

Append this test in the same file:

```tsx
it('refreshes persisted pending studio jobs until they become done', async () => {
  vi.useFakeTimers();
  const firstJobs = [{
    job_id: 'job-pending-2',
    character_id: 'oa',
    prompt: '轮询完成的图',
    submitted_at: '2026-05-28T02:05:00Z',
    model: 'gpt-image-2',
    params: { ratio: '1:1', resolution: '2K', size: '1024x1024' },
    seed: null,
    output_paths: [],
    status: 'pending',
    error: null,
    kind: 'image',
    namespace: 'studio',
    alias: 'oa',
    provider: 'openai',
  }];
  const secondJobs = [{
    ...firstJobs[0],
    status: 'done',
    output_paths: ['/tmp/studio/job-pending-2/v1.png'],
  }];
  let jobsCallCount = 0;
  globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
    if (url === '/api/keys') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          default_alias: 'oa',
          keys: [{
            alias: 'oa',
            provider: 'openai',
            access_key: 'sk',
            secret_key: null,
            capabilities: [],
            models: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
            notes: '',
            created_at: '2026-05-25T00:00:00Z',
            is_default: true,
          }],
        }),
      } as any);
    }
    if (url === '/api/jobs') {
      jobsCallCount += 1;
      return Promise.resolve({
        ok: true,
        json: async () => (jobsCallCount >= 2 ? secondJobs : firstJobs),
      } as any);
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as any);
  }) as any;

  renderStudio();
  expect(await screen.findByTestId('studio-pending-job-pending-2')).toBeInTheDocument();

  await act(async () => {
    vi.advanceTimersByTime(2100);
  });

  expect(await screen.findByRole('img', { name: '生成结果 1' })).toHaveAttribute(
    'src',
    '/api/gallery/image?path=%2Ftmp%2Fstudio%2Fjob-pending-2%2Fv1.png',
  );
  vi.useRealTimers();
});
```

At the top of `web/src/pages/Studio.test.tsx`, extend the import:

```tsx
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
pnpm --dir web test -- Studio.test.tsx
```

Expected: FAIL because `studio-pending-job-pending-1` is not rendered and persisted pending jobs do not refresh after mount.

- [ ] **Step 4: Add Studio API helpers**

Replace `web/src/api/studio.ts` with:

```ts
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

export async function listStudioJobs(): Promise<Job[]> {
  const resp = await fetch('/api/jobs');
  if (!resp.ok) throw new Error(`studio jobs failed: ${resp.status}`);
  const jobs = await resp.json() as Job[];
  return jobs.filter((job) => job.namespace === 'studio');
}

export async function getStudioJob(jobId: string): Promise<Job | null> {
  const resp = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!resp.ok) return null;
  const job = await resp.json() as Job;
  return job.namespace === 'studio' ? job : null;
}
```

- [ ] **Step 5: Patch Studio to refresh persisted studio jobs**

In `web/src/pages/Studio.tsx`, change the import:

```ts
import { createStudioJob, getStudioJob, listStudioJobs } from '@/api/studio';
```

Replace the first `useEffect` that fetches `/api/jobs` with:

```tsx
  const refreshPersistedJobs = useCallback(async () => {
    const jobs = await listStudioJobs();
    setPersistedJobs(jobs);
    return jobs;
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!compact) {
      listStudioJobs()
        .then((jobs) => {
          if (!cancelled) setPersistedJobs(jobs);
        })
        .catch(() => {
          if (!cancelled) setPersistedJobs([]);
        });
    }
    listKeys()
      .then((resp) => {
        if (cancelled) return;
        const usable = resp.keys.filter((key) => key.models.length > 0);
        setKeys(usable);
        const selected = usable.find((key) => key.alias === resp.default_alias) ?? usable[0];
        setProviderAlias(selected?.alias ?? '');
        setModel(selected?.models[0]?.id ?? '');
      })
      .catch(() => {
        if (!cancelled) setKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, [compact]);
```

Add this effect after the `mergePersistedRounds` effect:

```tsx
  const hasActivePersistedJob = persistedJobs.some(
    (job) => job.status === 'pending' || job.status === 'pending_confirm',
  );

  useEffect(() => {
    if (compact || !hasActivePersistedJob) return;
    const id = window.setInterval(() => {
      void refreshPersistedJobs();
    }, 2000);
    return () => window.clearInterval(id);
  }, [compact, hasActivePersistedJob, refreshPersistedJobs]);
```

Inside `onSubmit`, after `const job = await createStudioJob(...)`, insert:

```tsx
      setPersistedJobs((items) => upsertJob(items, job));
      setRounds((rs) =>
        rs.map((r) =>
          r === myRound
            ? {
                ...myRound,
                jobId: job.job_id,
                startedAt: Date.parse(job.submitted_at) || startedAt,
              }
            : r,
        ),
      );
```

Replace `pollJobUntilTerminal` with:

```tsx
async function pollJobUntilTerminal(
  jobId: string,
  onFinal: (job: Job) => void,
) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const job = await getStudioJob(jobId);
    if (!job) continue;
    if (job.status === 'done' || job.status === 'failed') {
      onFinal(job);
      return;
    }
  }
  onFinal({
    job_id: jobId,
    character_id: '',
    prompt: '',
    submitted_at: new Date().toISOString(),
    model: '',
    params: {},
    seed: null,
    output_paths: [],
    status: 'failed',
    error: 'timeout',
    kind: 'image',
    namespace: 'studio',
  });
}

function upsertJob(items: Job[], next: Job): Job[] {
  const without = items.filter((item) => item.job_id !== next.job_id);
  return [next, ...without];
}
```

In `RoundList` pending render, Task 2 will add `data-testid`; do that before re-running the tests.

- [ ] **Step 6: Run tests to verify Task 1 passes**

Run:

```bash
pnpm --dir web test -- Studio.test.tsx
```

Expected: PASS, with existing React `act` warning allowed only if it already appears in the current baseline.

- [ ] **Step 7: Commit Task 1**

```bash
git add -- web/src/api/studio.ts web/src/pages/Studio.tsx web/src/pages/Studio.test.tsx
git commit -m "fix(web): persist studio pending jobs across navigation"
```

---

### Task 2: Remove Studio Batch Time Style

**Files:**
- Modify: `web/src/components/studio/RoundList.tsx`
- Test: `web/src/pages/Studio.test.tsx`

- [ ] **Step 1: Add failing test for hidden submitted time**

Append this test to `web/src/pages/Studio.test.tsx`:

```tsx
it('does not render the batch submitted time above studio results', async () => {
  renderStudioWithCompletedBatch();

  expect(await screen.findByText(/一个身披白床单/)).toBeInTheDocument();
  expect(screen.queryByText(/1:00:00/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir web test -- Studio.test.tsx
```

Expected: FAIL because `RoundList` currently renders `new Date(r.submittedAt).toLocaleTimeString()`.

- [ ] **Step 3: Remove the time row from RoundList**

In `web/src/components/studio/RoundList.tsx`, replace the `rounds.map` body with:

```tsx
      {rounds.map((r) => {
        const stableKey =
          r.kind === 'pending' && r.jobId ? `pending-${r.jobId}` :
          r.kind === 'pending' ? `pending-${r.startedAt}` :
          `${r.kind}-${r.submittedAt}`;
        return (
          <div key={stableKey}>
            {r.kind === 'pending' && (
              <div className="mb-3">
                <WaitingCopy startedAt={r.startedAt} />
              </div>
            )}
            {r.kind === 'pending' && (
              <div
                data-testid={r.jobId ? `studio-pending-${r.jobId}` : undefined}
                data-skeleton
                aria-busy="true"
                className="aspect-square w-64 bg-card/40 rounded-lg flex items-center justify-center"
              >
                <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {r.kind === 'done' && (
              <DoneBatch
                round={r}
                onReEdit={onReEdit}
                onRegenerate={onRegenerate}
                onDeleteBatch={onDeleteBatch}
              />
            )}
            {r.kind === 'failed' && (
              <FailedCard
                round={r}
                onDeleteFailed={onDeleteFailed}
                onReEdit={onReEdit}
                onRegenerate={onRegenerate}
              />
            )}
          </div>
        );
      })}
```

- [ ] **Step 4: Run tests to verify Task 1 + Task 2 pass together**

Run:

```bash
pnpm --dir web test -- Studio.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add -- web/src/components/studio/RoundList.tsx web/src/pages/Studio.test.tsx
git commit -m "fix(web): remove studio batch timestamp"
```

---

### Task 3: Retry OpenAI-HK Image URL Downloads

**Files:**
- Modify: `src/character_workflow/lib/callers/openai_image.py`
- Test: `tests/test_openai_image.py`

- [ ] **Step 1: Add failing retry test**

In `tests/test_openai_image.py`, add `import requests` near the top:

```python
import requests
```

Append this test:

```python
def test_download_image_url_retries_chunked_encoding_error(monkeypatch):
    calls = {"count": 0}

    class FakeResponse:
        content = b"\x89PNG\r\n\x1a\nretry"

        def raise_for_status(self) -> None:
            return None

    def fake_get(url, headers=None, timeout=None):
        calls["count"] += 1
        assert url == "https://cdn.example.com/retry.png"
        assert headers["Accept"] == "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
        assert timeout == 180.0
        if calls["count"] == 1:
            raise requests.exceptions.ChunkedEncodingError(
                "IncompleteRead(884736 bytes read, 30896 more expected)"
            )
        return FakeResponse()

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    data = openai_image._download_image_url("https://cdn.example.com/retry.png")

    assert calls["count"] == 2
    assert data == b"\x89PNG\r\n\x1a\nretry"
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
uv run pytest -q tests/test_openai_image.py
```

Expected: FAIL because `openai_image` does not import `requests` and `_download_image_url()` uses `urllib.request.urlopen()`.

- [ ] **Step 3: Replace URL downloader with requests retries**

In `src/character_workflow/lib/callers/openai_image.py`, add imports:

```python
import time

import requests
```

Add constants after `_KNOWN_ENDPOINT_SUFFIXES`:

```python
_DOWNLOAD_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
}
```

Replace `_download_image_url()` with:

```python
def _download_image_url(url: str) -> bytes:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            resp = requests.get(url, headers=_DOWNLOAD_HEADERS, timeout=180.0)
            resp.raise_for_status()
            if not resp.content:
                raise OpenAIImageError(f"download image empty response: {url}")
            return resp.content
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else "unknown"
            raise OpenAIImageError(f"download image {status}: {url}") from e
        except requests.RequestException as e:
            last_error = e
            if attempt < 2:
                time.sleep(0.3 * (attempt + 1))
                continue
    raise OpenAIImageError(f"download image failed after 3 attempts: {last_error}") from last_error
```

Update `test_write_outputs_downloads_url_with_browser_headers` fake from `urlopen` to `requests.get`:

```python
def test_write_outputs_downloads_url_with_browser_headers(tmp_path, monkeypatch):
    image_bytes = b"\x89PNG\r\n\x1a\nurl"
    captured: dict[str, object] = {}

    class FakeResponse:
        content = image_bytes

        def raise_for_status(self) -> None:
            return None

    def fake_get(url, headers=None, timeout=None):
        captured["url"] = url
        captured["user_agent"] = headers["User-Agent"]
        captured["accept"] = headers["Accept"]
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert captured["url"] == "https://cdn.example.com/out.png"
    assert "Mozilla" in captured["user_agent"]
    assert captured["accept"] == "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
    assert Path(paths[0]).read_bytes() == image_bytes
```

Update `test_write_outputs_wraps_url_download_http_errors`:

```python
def test_write_outputs_wraps_url_download_http_errors(tmp_path, monkeypatch):
    class FakeResponse:
        status_code = 403

        def raise_for_status(self) -> None:
            raise requests.HTTPError("Forbidden", response=self)

    monkeypatch.setattr(openai_image.requests, "get", lambda *args, **kwargs: FakeResponse())

    try:
        openai_image._write_outputs(
            {"data": [{"url": "https://cdn.example.com/out.png"}]},
            tmp_path,
        )
    except openai_image.OpenAIImageError as exc:
        assert "download image 403" in str(exc)
        assert "https://cdn.example.com/out.png" in str(exc)
    else:
        raise AssertionError("expected OpenAIImageError")
```

In `test_render_openai_hk_posts_to_chat_completions_and_downloads_markdown_image`, keep `urllib` for the chat API call and monkeypatch requests for the image URL:

```python
    def fake_get(url, headers=None, timeout=None):
        assert url == "https://cdn.example.com/out.png"
        captured["download_user_agent"] = headers["User-Agent"]
        return type("FakeResponse", (), {
            "content": image_bytes,
            "raise_for_status": lambda self: None,
        })()

    monkeypatch.setattr(openai_image.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(openai_image.requests, "get", fake_get)
```

Remove the download branch from that test's `fake_urlopen`.

- [ ] **Step 4: Run focused Python tests**

Run:

```bash
uv run pytest -q tests/test_openai_image.py tests/test_callers_dispatch.py tests/test_job_runner.py
uv run ruff check src/character_workflow/lib/callers/openai_image.py tests/test_openai_image.py
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add -- src/character_workflow/lib/callers/openai_image.py tests/test_openai_image.py
git commit -m "fix(openai): retry image url downloads"
```

---

### Task 4: Hide Workshop Pending Confirm Component

**Files:**
- Modify: `web/src/components/CharacterGallery.tsx`
- Create: `web/src/components/CharacterGallery.test.tsx`

- [ ] **Step 1: Add failing CharacterGallery test**

Create `web/src/components/CharacterGallery.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { CharacterGallery } from './CharacterGallery';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CharacterGallery pending confirm jobs', () => {
  it('does not render terminal confirmation jobs in the workshop UI', async () => {
    vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL) => {
      if (url === '/api/jobs') {
        return Promise.resolve({
          ok: true,
          json: async () => [{
            job_id: 'job-confirm-1',
            character_id: 'cao-cao',
            prompt: '待终端确认的图',
            submitted_at: '2026-05-28T03:00:00Z',
            model: 'gpt-image-2',
            params: { size: '1024x1024', n: 1 },
            seed: null,
            output_paths: [],
            status: 'pending_confirm',
            error: null,
            asset_slot: 'portrait',
            kind: 'image',
            namespace: 'character',
            alias: 'oa',
            provider: 'openai',
          }],
        } as any);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as any);
    }));

    render(
      <CharacterGallery
        characterId="cao-cao"
        characterName="曹操"
        detailMode={false}
        onSelectImage={vi.fn()}
        sseSignal={0}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/等终端确认/)).not.toBeInTheDocument();
    });
    expect(await screen.findByText('等待第一张作品')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir web test -- CharacterGallery.test.tsx
```

Expected: FAIL because `PendingConfirmBadge` renders “1 个 job 等终端确认”.

- [ ] **Step 3: Remove pending confirm UI**

In `web/src/components/CharacterGallery.tsx`:

Change the import:

```tsx
import { X, AlertTriangle, Loader2, Upload } from 'lucide-react';
```

Remove:

```tsx
  const pendingConfirm = tabJobs.filter(j => j.status === 'pending_confirm');
```

Change `hasAny`:

```tsx
  const hasAny = allImages.length > 0 || isRunning || failedJobs.length > 0;
```

Remove this render line:

```tsx
      {pendingConfirm.length > 0 && <PendingConfirmBadge jobs={pendingConfirm} characterId={characterId} />}
```

Delete the entire `PendingConfirmBadge` function.

Remove the unused `FeedbackInput` import:

```tsx
import { FeedbackInput } from './FeedbackInput';
```

- [ ] **Step 4: Run CharacterGallery test**

Run:

```bash
pnpm --dir web test -- CharacterGallery.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run web tests touched by Task 4**

Run:

```bash
pnpm --dir web test -- CharacterGallery.test.tsx LeftSidebar.test.tsx
pnpm --dir web lint
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add -- web/src/components/CharacterGallery.tsx web/src/components/CharacterGallery.test.tsx
git commit -m "fix(web): hide pending confirm jobs in workshop"
```

---

### Task 5: Remove 1280px Viewport Blocker

**Files:**
- Modify: `web/src/App.tsx`
- Delete: `web/src/components/MinViewportGuard.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/components/AppShell.tsx`
- Modify: `web/src/components/studio/PromptInput.tsx`

- [ ] **Step 1: Add failing test for 1024px app access**

Append this test to `web/src/App.test.tsx`:

```tsx
it('does not block the app below 1280px', async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  (globalThis.fetch as ReturnType<typeof vi.fn>)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'ready',
        data_root: '/tmp/workflow',
        uv_path: null,
        venv_python: null,
        platform: 'darwin',
        next_action: null,
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] }),
    });

  render(<App />);

  await waitFor(() => {
    expect(screen.getByText('Atelier')).toBeInTheDocument();
  });
  expect(screen.queryByText(/请在桌面浏览器打开/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir web test -- App.test.tsx
```

Expected: FAIL because `MinViewportGuard` renders the blocker.

- [ ] **Step 3: Remove MinViewportGuard from App**

Replace `web/src/App.tsx` imports:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchOnboardingStatus, type OnboardingState } from './api/onboarding';
import { DataRootPage } from './pages/onboarding/DataRoot';
import { KeysPage } from './pages/settings/Keys';
import { AppShell } from '@/components/AppShell';
```

Replace the `ready` branch:

```tsx
    case 'needs_first_key':
    case 'ready':
    default:
      return <AppShell />;
```

Delete `web/src/components/MinViewportGuard.tsx`.

- [ ] **Step 4: Make AppShell header usable at narrower widths**

In `web/src/components/AppShell.tsx`, update the header container:

```tsx
        <div className="mx-auto flex min-h-14 md:min-h-20 items-center justify-between gap-2 px-3 md:px-8">
```

Update the logo link:

```tsx
          <Link href="/" className="min-w-0 shrink flex items-baseline gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
```

Update the small subtitle:

```tsx
            <span className="hidden sm:inline text-xs text-muted-foreground">· 工作流</span>
```

Update nav:

```tsx
          <nav className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto px-1 md:gap-3">
```

- [ ] **Step 5: Let PromptInput controls wrap without clipping**

In `web/src/components/studio/PromptInput.tsx`, change the shell class:

```tsx
      className="bg-card/80 rounded-[2rem] border border-input/80 pt-[14px] px-4 pb-4 max-w-[780px] mx-auto relative shadow-2xl shadow-black/20 backdrop-blur-xl min-h-[174px] h-auto flex flex-col gap-3"
```

Change controls row:

```tsx
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center shrink-0">
```

Change the controls group:

```tsx
        <div className="flex min-w-0 flex-wrap gap-2">
```

Change submit button:

```tsx
          className="inline-flex items-center justify-center w-10 h-10 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ring-offset-2 ring-offset-background transition-colors"
```

- [ ] **Step 6: Run responsive tests and lint**

Run:

```bash
pnpm --dir web test -- App.test.tsx AppShell.test.tsx Studio.test.tsx
pnpm --dir web lint
```

Expected: PASS.

- [ ] **Step 7: Manual browser check**

Run:

```bash
pnpm --dir web build
uv run python src/viewer_server/server.py start --background
```

Open the current server URL from `.runtime/server.port` and check:

- Width 1024: `/`, `/studio`, `/character`, `/settings` all render without the old blocker text.
- Width 390: header remains navigable, Studio prompt controls wrap instead of clipping.
- `/character` still shows left sidebar and gallery; detail view may be tight, but core navigation and delete/add actions remain reachable.

- [ ] **Step 8: Commit Task 5**

```bash
git add -- web/src/App.tsx web/src/App.test.tsx web/src/components/AppShell.tsx web/src/components/studio/PromptInput.tsx
git add --update -- web/src/components/MinViewportGuard.tsx
git commit -m "fix(web): allow app below 1280px"
```

---

## Final Verification

- [ ] Run Python focused tests:

```bash
uv run pytest -q tests/test_openai_image.py tests/test_callers_dispatch.py tests/test_job_runner.py
uv run ruff check src/character_workflow/lib/callers/openai_image.py tests/test_openai_image.py
```

Expected: PASS.

- [ ] Run web focused tests:

```bash
pnpm --dir web test -- Studio.test.tsx CharacterGallery.test.tsx App.test.tsx AppShell.test.tsx
pnpm --dir web lint
pnpm --dir web build
```

Expected: PASS. Existing React `act` warning may remain if it matches the current baseline.

- [ ] Run git hygiene check:

```bash
git status --short
```

Expected: only files changed by these tasks are staged or committed. Pre-existing unrelated work stays untouched.

## Self-Review

- Spec coverage:
  - Issue 1 is covered by Task 1: persisted studio pending jobs and active refresh.
  - Issue 2 is covered by Task 2: removes `toLocaleTimeString()` batch time row.
  - Issue 3 is covered by Task 3: OpenAI-HK URL downloads retry `IncompleteRead`-class failures through `requests`.
  - Issue 4 is covered by Task 4: no “job 等终端确认” UI in workshop.
  - Issue 5 is covered by Task 5: removes `<1280px` blocker and adds small-width layout constraints.
- Placeholder scan:
  - No placeholder markers or undefined helper names are used.
- Type consistency:
  - `Job`, `JobParams`, `JobKind`, `RoundState`, `RoundConfig` names match existing files.
  - `listStudioJobs()` and `getStudioJob()` are introduced before `Studio.tsx` imports them.
  - `studio-pending-${jobId}` test id matches Task 2 `RoundList` implementation.
