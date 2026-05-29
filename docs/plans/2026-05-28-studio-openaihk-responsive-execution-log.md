# Studio OpenAI-HK Responsive Fixes Execution Log

## 2026-05-28 23:10

- Branch: `codex/studio-openaihk-responsive-fixes`.
- Existing dirty worktree observed before implementation; changes will be scoped to the five reported issues and existing user edits will not be reverted.
- Execution mode: subagent-driven. Main session coordinates integration and verification; subagents receive narrow tasks and do not write memory.

## 2026-05-28 23:27

- Studio: added `/api/jobs` helpers, restored persisted pending studio jobs, refreshed active studio jobs, bound created pending rounds to `jobId`, and removed the old submitted time row from `RoundList`.
- Pending studio jobs now show prompt text plus waiting status, so refreshed in-flight jobs are visible as records rather than anonymous skeletons.
- Subagents completed OpenAI-HK URL download retry, workshop `pending_confirm` hiding, and the 1280px viewport guard removal.
- Integration note: responsive prompt shell intentionally changed from fixed `h-[174px]` to `min-h-[174px] h-auto`; updated Home/Studio assertions accordingly.

## 2026-05-28 23:31

- Verification:
  - `uv run pytest -q tests/test_openai_image.py` -> 7 passed.
  - `pnpm --dir web exec vitest run src/pages/Studio.test.tsx src/components/CharacterGallery.test.tsx src/App.test.tsx src/pages/Home.test.tsx` -> 41 passed.
  - `pnpm --dir web lint` -> passed.
  - `pnpm --dir web test` -> 71 passed, with existing React `act(...)` warnings.
- Browser smoke:
  - Started Vite, but the app chose `http://localhost:5175/` because 5173/5174 were busy.
  - `node_repl` could not import Playwright, and gstack browse failed to start with `No available port after 5 attempts in range 10000-60000`.
  - Stopped the Vite process started in this session; existing older Vite/viewer-server processes were left untouched.

## 2026-05-28 23:35

- Final reviewer found a P1: `roundKey()` used status-prefixed keys, so the same job could leave a pending spinner behind after becoming done/failed.
- Fix: `roundKey()` now uses status-independent `jobId`, and Studio test asserts `studio-pending-job-pending-2` disappears after polling returns done.
- Re-verification:
  - `pnpm --dir web exec vitest run src/pages/Studio.test.tsx` -> 28 passed.
  - `uv run pytest -q tests/test_openai_image.py` -> 7 passed.
  - `pnpm --dir web exec vitest run src/pages/Studio.test.tsx src/components/CharacterGallery.test.tsx src/App.test.tsx src/pages/Home.test.tsx` -> 41 passed.
  - `pnpm --dir web lint` -> passed.
- Final reviewer re-check: APPROVED.

## 2026-05-28 23:50

- User reported the real OpenAI-HK failure still appears in the UI: `download image failed: IncompleteRead(1025856 bytes read, 24805 more expected)`.
- Root cause refinement: the earlier retry covered `requests.get` failures, but the real failure can occur while reading the response body. Retrying without preserving already-read bytes still lets partial CDN responses fail the job.
- Fix: `_download_image_url()` now streams bytes into a buffer, appends `IncompleteRead.partial` when present, resumes with `Range: bytes=<downloaded>-`, validates `Content-Range` before appending resumed bytes, falls back to `curl -sS -L --fail --retry 5`, and reports a short `download image failed after retries` error if every strategy fails.
- Verification:
  - `uv run pytest -q tests/test_openai_image.py` -> 14 passed.
  - `uv run ruff check src/character_workflow/lib/callers/openai_image.py tests/test_openai_image.py` -> passed.
  - `uv run pytest -q tests/test_openai_image.py tests/test_callers_dispatch.py tests/test_job_runner.py` -> 26 passed.
- Review loop:
  - Reviewer found partial PNG could be returned even when known bytes were missing, unvalidated `206 Content-Range` could misalign resumed bytes, and nested `ChunkedEncodingError(..., IncompleteRead(...))` was under-tested.
  - Fixed all three and re-review returned APPROVED.
