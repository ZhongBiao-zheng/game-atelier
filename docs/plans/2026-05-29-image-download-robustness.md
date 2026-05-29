# Image URL Download Robustness Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `_download_image_url` 反复报 `IncompleteRead` 的问题，通过在现有流式下载前增加一次非流式预请求，覆盖"CDN 一次能传完、但 iter_content 分块时中断"的常见场景。

**Architecture:** 在 `_download_image_url` 内部添加 Phase 1（非流式、一次性 `resp.content`），失败后降级到现有的 Phase 2（流式 + Range 续传 × 5 次）和 Phase 3（curl 兜底）。参考项目 T8-penguin-canvas 中 `saveRemoteImage` 使用 `await res.arrayBuffer()` 的无流式一次读取思路。

**Tech Stack:** Python 3.11 · `requests` 库（已有）· `subprocess` + `curl`（已有）· pytest 8

---

## 问题根因

`IncompleteRead(1032192 bytes read, 45041 more expected)` 产生的循环：

1. 当前代码：流式请求 → 在 1032192 字节处断 → 捕获异常，`content` 保留已收到数据
2. 下一轮重试：发 `Range: bytes=1032192-` → CDN 不支持 Range，返回 HTTP 200（完整内容）
3. `_response_matches_range` → False → `content.clear()` → 重新下载
4. 又在 1032192 处断 → 回到第 2 步，5 次全失败

**修复逻辑：** 在进入流式循环之前，先做 1 次非流式请求（`stream=False`）。非流式模式下，`requests` 内部自行处理 chunked 重组，大多数情况下能一次拿到完整内容；只有失败了才降级走原有流式逻辑。

---

## 文件清单

| 操作 | 路径 |
|------|------|
| 修改 | `src/character_workflow/lib/callers/openai_image.py`（仅 `_download_image_url` 函数） |
| 修改 | `tests/test_openai_image.py`（新增 2 个测试，更新 7 个现有测试） |

---

## Task 1：为 Phase 1 写失败测试（TDD）

**Files:**
- Modify: `tests/test_openai_image.py`

- [ ] **Step 1: 在文件末尾添加 2 个新测试**

在 `tests/test_openai_image.py` 末尾追加：

```python
def test_download_image_url_uses_non_streaming_first(monkeypatch):
    """Phase 1: 第一次调用必须 stream=False（非流式），成功后不进入流式阶段。"""
    image_bytes = b"\x89PNG\r\n\x1a\ncomplete"
    captured: dict[str, object] = {}

    def fake_get(url, headers, timeout, stream):
        captured["stream"] = stream
        captured["calls"] = captured.get("calls", 0) + 1
        return FakeDownloadResponse(image_bytes)

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    result = openai_image._download_image_url("https://cdn.example.com/out.png")

    assert result == image_bytes
    assert captured["stream"] is False   # Phase 1 一定是非流式
    assert captured["calls"] == 1        # 只调了一次，直接成功


def test_download_image_url_falls_through_to_streaming_after_non_streaming_failure(
    monkeypatch,
):
    """Phase 1 失败后，应降级到 stream=True 的流式重试。"""
    image_bytes = b"\x89PNG\r\n\x1a\ncomplete"
    calls: list[bool] = []

    def fake_get(url, headers, timeout, stream):
        calls.append(stream)
        if not stream:  # Phase 1 失败
            raise requests.exceptions.ChunkedEncodingError("incomplete read")
        return FakeDownloadResponse(image_bytes)  # Phase 2 成功

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    result = openai_image._download_image_url("https://cdn.example.com/out.png")

    assert result == image_bytes
    assert calls[0] is False  # 第 1 次：Phase 1 非流式
    assert calls[1] is True   # 第 2 次：Phase 2 流式
```

- [ ] **Step 2: 运行新测试，确认它们 FAIL（Phase 1 尚未实现）**

```bash
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow
uv run pytest tests/test_openai_image.py::test_download_image_url_uses_non_streaming_first \
              tests/test_openai_image.py::test_download_image_url_falls_through_to_streaming_after_non_streaming_failure \
              -v
```

期望：**FAILED**，因为 `_download_image_url` 第一次调用仍然用 `stream=True`。

---

## Task 2：实现 Phase 1（非流式预请求）

**Files:**
- Modify: `src/character_workflow/lib/callers/openai_image.py`

- [ ] **Step 1: 用以下代码完整替换 `_download_image_url` 函数**

找到当前文件中 `def _download_image_url(url: str) -> bytes:` 这个函数（第 227 行起），用下面的实现替换整个函数体（到 `def _incomplete_read_partial` 之前）：

```python
def _download_image_url(url: str) -> bytes:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }
    last_error: BaseException | None = None

    # Phase 1: 非流式一次读取（参考 T8-penguin-canvas arrayBuffer 思路）
    # 让 requests 内部处理 chunked 重组，覆盖 CDN 能完整传输但 iter_content 中断的场景
    try:
        resp = requests.get(url, headers=headers, timeout=180.0, stream=False)
        if resp.status_code >= 400:
            raise OpenAIImageError(f"download image {resp.status_code}: {url}")
        data = resp.content
        if data:
            return data
    except OpenAIImageError:
        raise
    except (IncompleteRead, requests.RequestException) as e:
        last_error = e

    # Phase 2: 流式下载 + Range 续传（应对大文件 / 支持断点续传的 CDN）
    content = bytearray()
    expected_total: int | None = None
    for _ in range(5):
        resume_offset = len(content)
        request_headers = dict(headers)
        if content:
            request_headers["Range"] = f"bytes={resume_offset}-"
        try:
            with requests.get(
                url,
                headers=request_headers,
                timeout=180.0,
                stream=True,
            ) as resp:
                if resp.status_code >= 400:
                    raise OpenAIImageError(f"download image {resp.status_code}: {url}")
                if content and not _response_matches_range(resp.status_code, resp.headers, resume_offset):
                    content.clear()
                expected_total = _expected_download_size(resp.headers, expected_total)
                for chunk in resp.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        content.extend(chunk)
                if content and (expected_total is None or len(content) >= expected_total):
                    return bytes(content)
        except OpenAIImageError:
            raise
        except (IncompleteRead, requests.RequestException) as e:
            partial = _incomplete_read_partial(e)
            if partial:
                content.extend(partial)
            last_error = e

    # Phase 3: curl 兜底
    fallback = _curl_download_image_url(url, headers)
    if fallback is not None:
        return fallback
    if content and expected_total is None and _looks_like_image(content):
        return bytes(content)
    raise OpenAIImageError("download image failed after retries") from last_error
```

- [ ] **Step 2: 运行 Task 1 的 2 个新测试，确认 PASS**

```bash
uv run pytest tests/test_openai_image.py::test_download_image_url_uses_non_streaming_first \
              tests/test_openai_image.py::test_download_image_url_falls_through_to_streaming_after_non_streaming_failure \
              -v
```

期望：**PASSED**

- [ ] **Step 3: 运行全部 openai_image 测试，查看哪些现有测试失败**

```bash
uv run pytest tests/test_openai_image.py -v 2>&1 | grep -E "PASSED|FAILED|ERROR"
```

预计失败的测试（在 Task 3 中逐一修复）：
- `test_write_outputs_downloads_url_with_browser_headers`
- `test_render_openai_hk_posts_to_chat_completions_and_downloads_markdown_image`
- `test_write_outputs_resumes_after_incomplete_stream`
- `test_write_outputs_uses_incomplete_read_partial_before_resume`
- `test_write_outputs_uses_nested_incomplete_read_partial_before_resume`
- `test_write_outputs_restarts_when_range_response_is_misaligned`
- `test_write_outputs_falls_back_to_curl_after_download_retries`

---

## Task 3：更新现有测试 — stream 参数断言

Phase 1 用 `stream=False`，原来断言 `stream is True` 的测试必须更新。

**Files:**
- Modify: `tests/test_openai_image.py`

### 3a: `test_write_outputs_downloads_url_with_browser_headers`

- [ ] **Step 1: 找到该测试并将 `stream is True` 改为 `stream is False`**

原断言（在测试末尾）：
```python
    assert captured["stream"] is True
```

改为：
```python
    assert captured["stream"] is False
```

原因：`_write_outputs` → `_download_image_url`，Phase 1 第一次调用是非流式。

### 3b: `test_render_openai_hk_posts_to_chat_completions_and_downloads_markdown_image`

- [ ] **Step 1: 找到该测试并将 `stream is True` 改为 `stream is False`**

原断言：
```python
    assert captured["download_stream"] is True
```

改为：
```python
    assert captured["download_stream"] is False
```

- [ ] **Step 2: 运行这两个测试，确认 PASS**

```bash
uv run pytest \
  tests/test_openai_image.py::test_write_outputs_downloads_url_with_browser_headers \
  tests/test_openai_image.py::test_render_openai_hk_posts_to_chat_completions_and_downloads_markdown_image \
  -v
```

期望：**PASSED**

---

## Task 4：更新现有测试 — 调用序列从 2 步变为 3 步

Phase 1 插入了第 1 次调用（stream=False，返回空内容），原本的第 1、2 次调用变成了第 2、3 次。需要更新这些测试的 mock 和断言。

**Files:**
- Modify: `tests/test_openai_image.py`

### 4a: `test_write_outputs_resumes_after_incomplete_stream`

- [ ] **Step 1: 用以下完整函数替换该测试**

```python
def test_write_outputs_resumes_after_incomplete_stream(tmp_path, monkeypatch):
    first = b"\x89PNG\r\n\x1a\n" + (b"a" * 10)
    second = b"b" * 5
    calls: list[dict[str, object]] = []

    class InterruptedDownloadResponse(FakeDownloadResponse):
        def iter_content(self, chunk_size: int):
            yield first
            raise requests.exceptions.ChunkedEncodingError("incomplete read")

    def fake_get(url, headers, timeout, stream):
        calls.append({"headers": headers, "stream": stream})
        if len(calls) == 1:
            # Phase 1 非流式：返回空内容，触发降级
            return FakeDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(second))},
            )
        if len(calls) == 2:
            # Phase 2 第 1 次流式：中途断
            return InterruptedDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(second))},
            )
        # Phase 2 第 2 次：带 Range 续传
        assert headers["Range"] == f"bytes={len(first)}-"
        return FakeDownloadResponse(
            second,
            status_code=206,
            headers={
                "Content-Range": (
                    f"bytes {len(first)}-{len(first) + len(second) - 1}/"
                    f"{len(first) + len(second)}"
                ),
            },
        )

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert len(calls) == 3
    assert calls[0]["stream"] is False                  # Phase 1
    assert calls[0]["headers"].get("Range") is None     # Phase 1 无 Range
    assert Path(paths[0]).read_bytes() == first + second
```

### 4b: `test_write_outputs_uses_incomplete_read_partial_before_resume`

- [ ] **Step 1: 用以下完整函数替换该测试**

```python
def test_write_outputs_uses_incomplete_read_partial_before_resume(tmp_path, monkeypatch):
    first = b"\x89PNG\r\n\x1a\n" + (b"a" * 4)
    partial = b"p" * 3
    second = b"b" * 5
    calls: list[dict[str, object]] = []

    class InterruptedDownloadResponse(FakeDownloadResponse):
        def iter_content(self, chunk_size: int):
            yield first
            raise IncompleteRead(partial, len(second))

    def fake_get(url, headers, timeout, stream):
        calls.append({"headers": headers})
        if len(calls) == 1:
            # Phase 1 非流式：返回空内容
            return FakeDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(partial) + len(second))},
            )
        if len(calls) == 2:
            # Phase 2 第 1 次流式：中途抛 IncompleteRead(partial)
            return InterruptedDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(partial) + len(second))},
            )
        # Phase 2 第 2 次：带 Range，从 first+partial 之后续传
        assert headers["Range"] == f"bytes={len(first) + len(partial)}-"
        return FakeDownloadResponse(
            second,
            status_code=206,
            headers={
                "Content-Range": (
                    f"bytes {len(first) + len(partial)}-"
                    f"{len(first) + len(partial) + len(second) - 1}/"
                    f"{len(first) + len(partial) + len(second)}"
                ),
            },
        )

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert len(calls) == 3
    assert Path(paths[0]).read_bytes() == first + partial + second
```

### 4c: `test_write_outputs_uses_nested_incomplete_read_partial_before_resume`

- [ ] **Step 1: 用以下完整函数替换该测试**

```python
def test_write_outputs_uses_nested_incomplete_read_partial_before_resume(tmp_path, monkeypatch):
    first = b"\x89PNG\r\n\x1a\n" + (b"a" * 4)
    partial = b"p" * 3
    second = b"b" * 5
    calls: list[dict[str, object]] = []

    class InterruptedDownloadResponse(FakeDownloadResponse):
        def iter_content(self, chunk_size: int):
            yield first
            raise requests.exceptions.ChunkedEncodingError(
                "broken",
                IncompleteRead(partial, len(second)),
            )

    def fake_get(url, headers, timeout, stream):
        calls.append({"headers": headers})
        if len(calls) == 1:
            # Phase 1 非流式：返回空内容
            return FakeDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(partial) + len(second))},
            )
        if len(calls) == 2:
            # Phase 2 第 1 次流式：嵌套 IncompleteRead
            return InterruptedDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + len(partial) + len(second))},
            )
        # Phase 2 第 2 次：带 Range
        assert headers["Range"] == f"bytes={len(first) + len(partial)}-"
        return FakeDownloadResponse(
            second,
            status_code=206,
            headers={
                "Content-Range": (
                    f"bytes {len(first) + len(partial)}-"
                    f"{len(first) + len(partial) + len(second) - 1}/"
                    f"{len(first) + len(partial) + len(second)}"
                ),
            },
        )

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert len(calls) == 3
    assert Path(paths[0]).read_bytes() == first + partial + second
```

### 4d: `test_write_outputs_restarts_when_range_response_is_misaligned`

- [ ] **Step 1: 用以下完整函数替换该测试**

```python
def test_write_outputs_restarts_when_range_response_is_misaligned(tmp_path, monkeypatch):
    first = b"\x89PNG\r\n\x1a\npartial"
    full = b"\x89PNG\r\n\x1a\nfull"
    calls: list[dict[str, object]] = []

    class InterruptedDownloadResponse(FakeDownloadResponse):
        def iter_content(self, chunk_size: int):
            yield first
            raise requests.exceptions.ChunkedEncodingError("incomplete read")

    def fake_get(url, headers, timeout, stream):
        calls.append({"headers": headers})
        if len(calls) == 1:
            # Phase 1 非流式：返回空内容
            return FakeDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + 10)},
            )
        if len(calls) == 2:
            # Phase 2 第 1 次流式：中断
            return InterruptedDownloadResponse(
                b"",
                headers={"Content-Length": str(len(first) + 10)},
            )
        # Phase 2 第 2 次：带 Range，但返回 bytes 0-（不对齐）→ 触发 content.clear()
        assert headers["Range"] == f"bytes={len(first)}-"
        return FakeDownloadResponse(
            full,
            status_code=206,
            headers={"Content-Range": f"bytes 0-{len(full) - 1}/{len(full)}"},
        )

    monkeypatch.setattr(openai_image.requests, "get", fake_get)

    paths = openai_image._write_outputs(
        {"data": [{"url": "https://cdn.example.com/out.png"}]},
        tmp_path,
    )

    assert len(calls) == 3
    assert Path(paths[0]).read_bytes() == full
```

- [ ] **Step 2: 运行 Task 4 的所有更新测试，确认 PASS**

```bash
uv run pytest \
  tests/test_openai_image.py::test_write_outputs_resumes_after_incomplete_stream \
  tests/test_openai_image.py::test_write_outputs_uses_incomplete_read_partial_before_resume \
  tests/test_openai_image.py::test_write_outputs_uses_nested_incomplete_read_partial_before_resume \
  tests/test_openai_image.py::test_write_outputs_restarts_when_range_response_is_misaligned \
  -v
```

期望：**PASSED**

---

## Task 5：更新 curl 兜底相关测试（调用次数变化）

Phase 1 加了 1 次非流式调用，所有"5 次全失败后走 curl"的测试从 5 次变成 6 次。

**Files:**
- Modify: `tests/test_openai_image.py`

### 5a: `test_write_outputs_falls_back_to_curl_after_download_retries`

- [ ] **Step 1: 将 `assert len(get_calls) == 5` 改为 `== 6`**

找到该断言：
```python
    assert len(get_calls) == 5
```

改为：
```python
    assert len(get_calls) == 6
```

原因：1 次 Phase 1（非流式）+ 5 次 Phase 2（流式）= 6 次总调用。

- [ ] **Step 2: 运行该测试确认 PASS**

```bash
uv run pytest tests/test_openai_image.py::test_write_outputs_falls_back_to_curl_after_download_retries -v
```

期望：**PASSED**

---

## Task 6：全量测试验证

- [ ] **Step 1: 运行全部 openai_image 测试**

```bash
uv run pytest tests/test_openai_image.py -v
```

期望：**全部 PASSED**（20 个测试）。如有失败，检查失败信息，按 Task 3/4/5 的模式逐一修复。

- [ ] **Step 2: 运行完整测试套件，确认无回归**

```bash
uv run pytest tests/ -v --tb=short 2>&1 | tail -30
```

期望：所有测试 PASSED，总数不少于原来数量。

- [ ] **Step 3: commit**

```bash
git add src/character_workflow/lib/callers/openai_image.py tests/test_openai_image.py
git commit -m "fix: add non-streaming pre-flight to _download_image_url to reduce IncompleteRead failures"
```

---

## 自检：Spec 覆盖确认

| 需求 | 覆盖任务 |
|------|---------|
| Phase 1 非流式首次尝试 | Task 2 实现 + Task 1 新测试 |
| Phase 1 失败后降级 Phase 2 | Task 1 新测试 `test_download_image_url_falls_through_to_streaming_after_non_streaming_failure` |
| stream 参数断言更新 | Task 3 |
| 调用序列（2 步 → 3 步）更新 | Task 4 |
| curl 兜底调用次数（5 → 6）更新 | Task 5 |
| 全量回归验证 | Task 6 |

**已知不变行为（无需测试更新）：**
- `test_write_outputs_wraps_url_download_http_errors`：HTTP 4xx 在 Phase 1 即报错，不影响调用次数断言
- `test_write_outputs_uses_curl_before_known_truncated_partial_image`：Phase 1 非流式 `resp.content = b""`（空），继续走 Phase 2，最终 curl 兜底，行为不变
- `test_write_outputs_hides_raw_incomplete_read_when_all_downloads_fail`：无调用次数断言，Phase 1 + Phase 2 × 5 + curl 三层全失败，最终 raise `OpenAIImageError`，行为不变
