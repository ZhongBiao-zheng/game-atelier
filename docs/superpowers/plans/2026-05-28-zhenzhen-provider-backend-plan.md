# Zhenzhen Provider Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real, testable multi-model image backend by porting T8-penguin-canvas's Zhenzhen/T8star key routing, image protocol builders, reference-image handling, and async task state machine into this Python/FastAPI project.

**Architecture:** Keep this project's existing `<data_root>/.config/keys.json` and `alias + provider + models` model, then add Zhenzhen-specific routing metadata instead of copying T8's fixed `settings.json` fields. Implement a focused `zhenzhen` caller with small protocol modules: key picking, reference normalization, payload builders, submit/query transport, and output download. Wire `job_runner` through the existing `dispatch()` path so Studio and character jobs both use the same durable job state.

**Tech Stack:** Python 3.11, FastAPI, Pydantic v2, `requests`, pytest, existing Vite/React settings UI.

---

## Scope Check

This plan covers only image generation backend parity with the useful parts of T8:

- General key + classified keys
- `pickApiKey()` equivalent by model hint
- `ensureKey()` equivalent where classified-only keys work
- Async submit/query key memory using `task_id -> alias`
- Three image protocols: GPT-size, banana-ratio, MJ
- Protocol layering, payload builders, reference-image normalization, async status normalization

This plan does not implement video, audio, RunningHub, or LLM proxying. Those are independent subsystems in T8 and should get their own plans if needed.

## Source References From T8

- Key settings: `/Users/zhengzhongbiao/Documents/GitHub/拆解项目/T8-penguin-canvas/backend/src/routes/settings.js`
- Key selection helpers: `/Users/zhengzhongbiao/Documents/GitHub/拆解项目/T8-penguin-canvas/backend/src/routes/proxy.js:67-145`
- GPT/Nano image protocols: `/Users/zhengzhongbiao/Documents/GitHub/拆解项目/T8-penguin-canvas/backend/src/routes/proxy.js:195-576`
- FAL image protocol: `/Users/zhengzhongbiao/Documents/GitHub/拆解项目/T8-penguin-canvas/backend/src/routes/proxy.js:578-845`
- MJ protocol: `/Users/zhengzhongbiao/Documents/GitHub/拆解项目/T8-penguin-canvas/backend/src/routes/proxy.js:847-977`
- Model registry: `/Users/zhengzhongbiao/Documents/GitHub/拆解项目/T8-penguin-canvas/src/providers/models.ts`

## File Structure

### Create

- `src/character_workflow/lib/callers/zhenzhen.py`
  - Public caller entrypoint `render(...)`.
  - Looks up effective key by alias/model.
  - Calls protocol-specific submit/query functions.
  - Downloads generated files to the caller's temporary output directory.

- `src/character_workflow/lib/callers/zhenzhen_keys.py`
  - T8-style `pickApiKey()` and `ensureKey()` equivalents for this project's `KeySpec`.
  - Stores task key memory as `task_id -> alias`, not raw key.

- `src/character_workflow/lib/callers/zhenzhen_protocols.py`
  - Model hint classification.
  - GPT size map.
  - `ImageProtocol` enum.
  - Payload builder functions for `gpt-size`, `banana-ratio`, `fal`, and `mj`.

- `src/character_workflow/lib/callers/zhenzhen_refs.py`
  - Reference-image normalization.
  - Local path/data URL/http URL handling.
  - Multipart file preparation.
  - Upload to `/v1/files` when a protocol needs public URLs.

- `tests/test_zhenzhen_keys.py`
  - General/classified key selection and fallback tests.

- `tests/test_zhenzhen_protocols.py`
  - Payload builder tests for GPT-size, banana-ratio, FAL, and MJ.

- `tests/test_zhenzhen_refs.py`
  - Reference-image conversion tests.

- `tests/test_zhenzhen_caller.py`
  - End-to-end mocked caller tests for sync and async upstream responses.

### Modify

- `src/character_workflow/lib/keys.py`
  - Add provider `zhenzhen`.
  - Add routing metadata to `KeySpec`.
  - Preserve backward compatibility for existing keys.

- `src/viewer_server/routes.py`
  - Accept new key routing metadata in `/api/keys`.

- `src/character_workflow/lib/callers/__init__.py`
  - Route `provider == "zhenzhen"` to `zhenzhen.render`.
  - Route existing UI provider values that should use Zhenzhen protocols where appropriate.

- `src/character_workflow/lib/job_runner.py`
  - Store task metadata and warnings returned by Zhenzhen caller.
  - Keep existing output validation and durable move behavior.

- `web/src/pages/settings/KeyForm.tsx`
  - Add Zhenzhen provider preset.
  - Add routing scope/category controls only when provider is Zhenzhen.

- `web/src/api/keys.ts`
  - Add routing metadata fields to Key payload types.

### Keep

- Keep `.config/keys.json` as the key storage file.
- Keep `alias` as the stable user-visible key identity.
- Keep `job_runner` as the only place that turns generated temp files into durable job outputs.
- Keep Lovart path untouched except for dispatch coexistence.

---

## Architecture Decisions

1. **Do not copy T8's fixed field settings model.**
   T8 has `zhenzhenApiKey`, `gptImageApiKey`, `nanoBananaApiKey`, `mjApiKey`, etc. This project already supports multiple named keys. We add routing metadata to each key instead.

2. **Use provider `zhenzhen` for the T8star-compatible aggregate upstream.**
   OpenAI official, Seedream official-compatible, Lovart, and Zhenzhen are different upstream contracts. Mixing them under `openai_image.py` caused the current backend to become fake-flexible.

3. **Store `task_id -> alias`, not `task_id -> raw api_key`.**
   T8 stores raw key in memory. This project can be safer with the same behavior by remembering the alias and re-reading the secret at query time.

4. **Treat `model` as the routing hint.**
   The caller receives `model` from Studio. Protocol selection uses model hints such as `gpt-image`, `nano-banana`, `mj`, and `fal`.

5. **Return local temp file paths from callers.**
   `job_runner` remains responsible for image validation, versioned destination paths, sidecar files, and final job state.

---

## Task 1: Extend Key Schema With Zhenzhen Routing Metadata

**Files:**
- Modify: `src/character_workflow/lib/keys.py`
- Modify: `src/viewer_server/routes.py`
- Test: `tests/test_keys.py`
- Test: `tests/test_keys_api.py`

- [ ] **Step 1: Write failing schema tests**

Append to `tests/test_keys.py`:

```python
def test_zhenzhen_key_persists_routing_metadata(isolated_data_root):
    spec = keys.KeySpec(
        alias="zz-general",
        provider="zhenzhen",
        base_url="https://ai.t8star.org",
        access_key="zz-secret",
        secret_key=None,
        capabilities=["portrait", "promo", "turnaround"],
        models=[
            {"name": "GPT Image 2", "id": "gpt-image-2-all"},
            {"name": "Nano Banana Pro", "id": "nano-banana-pro"},
        ],
        routing_scope="general",
        routing_category=None,
        routing_hints=[],
        homepage_url="https://ai.t8star.org",
        docs_url=None,
        api_key_url=None,
        modalities=["image"],
        notes="",
        created_at="2026-05-28T00:00:00+08:00",
    )

    keys.add_key(spec)
    row = keys.find_by_alias("zz-general")

    assert row is not None
    assert row.provider == "zhenzhen"
    assert row.routing_scope == "general"
    assert row.routing_category is None
    assert row.routing_hints == []
```

Append to `tests/test_keys_api.py`:

```python
def test_create_zhenzhen_key_accepts_routing_metadata(client):
    payload = _make_payload("zz-gpt")
    payload.update({
        "provider": "zhenzhen",
        "base_url": "https://ai.t8star.org",
        "access_key": "zz-secret",
        "secret_key": None,
        "routing_scope": "classified",
        "routing_category": "gpt_image",
        "routing_hints": ["gpt-image", "gpt_image", "gptimage"],
        "models": [{"name": "GPT Image 2", "id": "gpt-image-2-all"}],
        "modalities": ["image"],
    })

    resp = client.post("/api/keys", json=payload)
    assert resp.status_code == 201, resp.text

    row = client.get("/api/keys").json()["keys"][0]
    assert row["provider"] == "zhenzhen"
    assert row["routing_scope"] == "classified"
    assert row["routing_category"] == "gpt_image"
    assert row["routing_hints"] == ["gpt-image", "gpt_image", "gptimage"]
    assert row["access_key"] != "zz-secret"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_keys.py::test_zhenzhen_key_persists_routing_metadata tests/test_keys_api.py::test_create_zhenzhen_key_accepts_routing_metadata -v
```

Expected: FAIL because `Provider` does not include `zhenzhen` and `KeySpec` does not define routing fields.

- [ ] **Step 3: Add schema fields**

In `src/character_workflow/lib/keys.py`, update `Provider` and `KeySpec`:

```python
Provider = Literal[
    "lovart",
    "openai",
    "midjourney",
    "nano_banana",
    "seedream",
    "runway",
    "kling",
    "veo",
    "seedance",
    "custom",
    "zhenzhen",
]

RoutingScope = Literal["general", "classified"]
RoutingCategory = Literal[
    "gpt_image",
    "nano_banana",
    "mj",
    "veo",
    "grok",
    "seedance",
    "suno",
]
```

Add these fields to `KeySpec`:

```python
    routing_scope: RoutingScope = "general"
    routing_category: RoutingCategory | None = None
    routing_hints: list[str] = Field(default_factory=list)
```

- [ ] **Step 4: Extend API payloads**

In `src/viewer_server/routes.py`, add fields to `_KeyCreatePayload`:

```python
    routing_scope: keys.RoutingScope = "general"
    routing_category: keys.RoutingCategory | None = None
    routing_hints: list[str] = []
```

Add fields to `_KeyPatchPayload`:

```python
    routing_scope: keys.RoutingScope | None = None
    routing_category: keys.RoutingCategory | None = None
    routing_hints: list[str] | None = None
```

Pass fields into `keys.KeySpec(...)` inside `create_key`:

```python
            routing_scope=payload.routing_scope,
            routing_category=payload.routing_category,
            routing_hints=payload.routing_hints,
```

- [ ] **Step 5: Run tests**

Run:

```bash
uv run pytest tests/test_keys.py::test_zhenzhen_key_persists_routing_metadata tests/test_keys_api.py::test_create_zhenzhen_key_accepts_routing_metadata -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/character_workflow/lib/keys.py src/viewer_server/routes.py tests/test_keys.py tests/test_keys_api.py
git commit -m "keys: add zhenzhen routing metadata"
```

---

## Task 2: Implement Zhenzhen Key Selection

**Files:**
- Create: `src/character_workflow/lib/callers/zhenzhen_keys.py`
- Test: `tests/test_zhenzhen_keys.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_zhenzhen_keys.py`:

```python
from character_workflow.lib import keys
from character_workflow.lib.callers import zhenzhen_keys


def _add(alias: str, *, scope: str, category: str | None, access_key: str) -> None:
    keys.add_key(keys.KeySpec(
        alias=alias,
        provider="zhenzhen",
        base_url="https://ai.t8star.org",
        access_key=access_key,
        secret_key=None,
        capabilities=["portrait", "promo", "turnaround"],
        models=[],
        routing_scope=scope,
        routing_category=category,
        routing_hints=[],
        modalities=["image"],
        notes="",
        created_at="2026-05-28T00:00:00+08:00",
    ))


def test_pick_key_prefers_classified_gpt_key(isolated_data_root):
    _add("zz-general", scope="general", category=None, access_key="general-key")
    _add("zz-gpt", scope="classified", category="gpt_image", access_key="gpt-key")

    picked = zhenzhen_keys.pick_key(model_hint="gpt-image-2-all")

    assert picked.alias == "zz-gpt"
    assert picked.access_key == "gpt-key"


def test_pick_key_falls_back_to_general_when_classified_missing(isolated_data_root):
    _add("zz-general", scope="general", category=None, access_key="general-key")

    picked = zhenzhen_keys.pick_key(model_hint="nano-banana-pro")

    assert picked.alias == "zz-general"
    assert picked.access_key == "general-key"


def test_pick_key_allows_classified_only_without_general(isolated_data_root):
    _add("zz-mj", scope="classified", category="mj", access_key="mj-key")

    picked = zhenzhen_keys.pick_key(model_hint="midjourney")

    assert picked.alias == "zz-mj"
    assert picked.access_key == "mj-key"


def test_pick_key_uses_explicit_alias_first(isolated_data_root):
    _add("zz-general", scope="general", category=None, access_key="general-key")
    _add("zz-gpt", scope="classified", category="gpt_image", access_key="gpt-key")

    picked = zhenzhen_keys.pick_key(model_hint="gpt-image-2-all", alias="zz-general")

    assert picked.alias == "zz-general"
    assert picked.access_key == "general-key"


def test_pick_key_raises_clear_error_when_no_key(isolated_data_root):
    try:
        zhenzhen_keys.pick_key(model_hint="gpt-image-2-all")
    except zhenzhen_keys.ZhenzhenKeyError as e:
        assert "未配置" in str(e)
    else:
        raise AssertionError("expected ZhenzhenKeyError")


def test_task_alias_memory_roundtrip():
    zhenzhen_keys.remember_task_alias("task-1", "zz-gpt")

    assert zhenzhen_keys.recall_task_alias("task-1") == "zz-gpt"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_zhenzhen_keys.py -v
```

Expected: FAIL because `zhenzhen_keys.py` does not exist.

- [ ] **Step 3: Create implementation**

Create `src/character_workflow/lib/callers/zhenzhen_keys.py`:

```python
from __future__ import annotations

import time
from dataclasses import dataclass

from character_workflow.lib import keys


class ZhenzhenKeyError(RuntimeError):
    pass


_CATEGORY_HINTS: dict[str, tuple[str, ...]] = {
    "gpt_image": ("gpt-image", "gpt2", "gpt_image", "gptimage"),
    "nano_banana": ("nano-banana", "nano_banana", "nanobanana"),
    "mj": ("midjourney", "mj-", "mj_", "mj/", "mj"),
    "veo": ("veo",),
    "grok": ("grok",),
    "seedance": ("seedance",),
    "suno": ("suno", "chirp"),
}


@dataclass(frozen=True)
class TaskAliasRecord:
    alias: str
    expires_at: float


_TASK_ALIAS_TTL_SECONDS = 30 * 60
_TASK_ALIAS_MAP: dict[str, TaskAliasRecord] = {}


def classify_model_hint(model_hint: str) -> str | None:
    m = str(model_hint or "").lower()
    if not m:
        return None
    for category, hints in _CATEGORY_HINTS.items():
        if any(hint in m for hint in hints):
            return category
    return None


def _is_zhenzhen(k: keys.KeySpec) -> bool:
    return k.provider == "zhenzhen"


def _matches_category(k: keys.KeySpec, category: str | None, model_hint: str) -> bool:
    if not category:
        return False
    if k.routing_scope != "classified":
        return False
    if k.routing_category == category:
        return True
    m = str(model_hint or "").lower()
    return any(str(h).lower() in m for h in k.routing_hints)


def pick_key(*, model_hint: str, alias: str | None = None) -> keys.KeySpec:
    db = keys.read_keys_db()
    zhenzhen_keys = [k for k in db.keys if _is_zhenzhen(k)]
    if alias:
        selected = next((k for k in zhenzhen_keys if k.alias == alias), None)
        if selected:
            return selected
        raise ZhenzhenKeyError(f"alias {alias!r} 不是可用的 Zhenzhen Key")

    category = classify_model_hint(model_hint)
    selected = next((k for k in zhenzhen_keys if _matches_category(k, category, model_hint)), None)
    if selected:
        return selected

    if db.default_alias:
        default = next(
            (k for k in zhenzhen_keys if k.alias == db.default_alias and k.routing_scope == "general"),
            None,
        )
        if default:
            return default

    general = next((k for k in zhenzhen_keys if k.routing_scope == "general"), None)
    if general:
        return general

    label = category or "图像"
    raise ZhenzhenKeyError(f"未配置 {label} 专属 Zhenzhen API Key，且通用 Zhenzhen API Key 也为空")


def remember_task_alias(task_id: str, alias: str) -> None:
    if not task_id or not alias:
        return
    _TASK_ALIAS_MAP[str(task_id)] = TaskAliasRecord(
        alias=alias,
        expires_at=time.time() + _TASK_ALIAS_TTL_SECONDS,
    )


def recall_task_alias(task_id: str) -> str | None:
    record = _TASK_ALIAS_MAP.get(str(task_id))
    if record is None:
        return None
    if record.expires_at < time.time():
        _TASK_ALIAS_MAP.pop(str(task_id), None)
        return None
    return record.alias
```

- [ ] **Step 4: Run tests**

Run:

```bash
uv run pytest tests/test_zhenzhen_keys.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/character_workflow/lib/callers/zhenzhen_keys.py tests/test_zhenzhen_keys.py
git commit -m "callers: add zhenzhen key selection"
```

---

## Task 3: Add Zhenzhen Protocol Builders

**Files:**
- Create: `src/character_workflow/lib/callers/zhenzhen_protocols.py`
- Test: `tests/test_zhenzhen_protocols.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_zhenzhen_protocols.py`:

```python
from character_workflow.lib.callers import zhenzhen_protocols as zp


def test_detect_protocol_gpt_size():
    assert zp.detect_image_protocol("gpt-image-2-all") == zp.ImageProtocol.GPT_SIZE


def test_detect_protocol_banana_ratio():
    assert zp.detect_image_protocol("nano-banana-pro") == zp.ImageProtocol.BANANA_RATIO


def test_detect_protocol_mj():
    assert zp.detect_image_protocol("midjourney") == zp.ImageProtocol.MJ


def test_detect_protocol_fal():
    assert zp.detect_image_protocol("gpt-image-2-fal") == zp.ImageProtocol.FAL


def test_aspect_to_gpt_size_matches_t8_map():
    assert zp.aspect_to_gpt_size("16:9", "2K") == "2560x1440"
    assert zp.aspect_to_gpt_size("9:16", "1K") == "720x1280"
    assert zp.aspect_to_gpt_size("Auto", "2K") == "auto"


def test_build_gpt_size_fields_uses_white_image_when_no_refs():
    fields = zp.build_gpt_size_fields(
        prompt="a fox",
        model="gpt-image-2-all",
        n=1,
        aspect_ratio="1:1",
        image_size="2K",
        size=None,
        quality=None,
        refs=[],
    )

    assert fields.text == {
        "prompt": "a fox",
        "model": "gpt-image-2-all",
        "n": "1",
        "quality": "auto",
        "moderation": "auto",
        "size": "2048x2048",
        "aspectRatio": "1:1",
        "resolution": "2k",
    }
    assert fields.needs_white_placeholder is True


def test_build_banana_json_payload_for_text_to_image():
    payload = zp.build_banana_json_payload(
        prompt="a penguin",
        model="nano-banana-pro",
        aspect_ratio="16:9",
        image_size="4K",
    )

    assert payload == {
        "prompt": "a penguin",
        "model": "nano-banana-pro",
        "aspect_ratio": "16:9",
        "image_size": "4K",
    }


def test_build_mj_payload_keeps_t8_fields():
    payload = zp.build_mj_payload(
        prompt="castle --v 8.1 --ar 16:9",
        base64_array=[],
        ar="16:9",
        seed=123,
    )

    assert payload["prompt"] == "castle --v 8.1 --ar 16:9"
    assert payload["base64Array"] == []
    assert payload["ar"] == "16:9"
    assert payload["seed"] == 123
    assert payload["remix"] is True
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_zhenzhen_protocols.py -v
```

Expected: FAIL because `zhenzhen_protocols.py` does not exist.

- [ ] **Step 3: Create implementation**

Create `src/character_workflow/lib/callers/zhenzhen_protocols.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class ImageProtocol(str, Enum):
    GPT_SIZE = "gpt-size"
    BANANA_RATIO = "banana-ratio"
    FAL = "fal"
    MJ = "mj"


@dataclass(frozen=True)
class MultipartFields:
    text: dict[str, str]
    needs_white_placeholder: bool = False


GPT_SIZE_MAP = {
    "1:1_1k": "1024x1024", "1:1_2k": "2048x2048", "1:1_4k": "2880x2880",
    "3:2_1k": "1248x832", "3:2_2k": "2496x1664", "3:2_4k": "3504x2336",
    "2:3_1k": "832x1248", "2:3_2k": "1664x2496", "2:3_4k": "2336x3504",
    "4:3_1k": "1152x864", "4:3_2k": "2304x1728", "4:3_4k": "3264x2448",
    "3:4_1k": "864x1152", "3:4_2k": "1728x2304", "3:4_4k": "2448x3264",
    "5:4_1k": "1120x896", "5:4_2k": "2240x1792", "5:4_4k": "3200x2560",
    "4:5_1k": "896x1120", "4:5_2k": "1792x2240", "4:5_4k": "2560x3200",
    "16:9_1k": "1280x720", "16:9_2k": "2560x1440", "16:9_4k": "3840x2160",
    "9:16_1k": "720x1280", "9:16_2k": "1440x2560", "9:16_4k": "2160x3840",
    "2:1_1k": "2048x1024", "2:1_2k": "2688x1344", "2:1_4k": "3840x1920",
    "1:2_1k": "1024x2048", "1:2_2k": "1344x2688", "1:2_4k": "1920x3840",
    "21:9_1k": "1456x624", "21:9_2k": "3024x1296", "21:9_4k": "3696x1584",
    "9:21_1k": "624x1456", "9:21_2k": "1296x3024", "9:21_4k": "1584x3696",
}


def detect_image_protocol(model: str, param_kind: str | None = None) -> ImageProtocol:
    if param_kind:
        if param_kind == "gpt-size":
            return ImageProtocol.GPT_SIZE
        if param_kind == "banana-ratio":
            return ImageProtocol.BANANA_RATIO
        if param_kind == "mj":
            return ImageProtocol.MJ
    m = str(model or "").lower()
    if m.endswith("-fal") or "/fal/" in m or "fal-ai/" in m:
        return ImageProtocol.FAL
    if "midjourney" in m or m == "mj" or m.startswith("mj"):
        return ImageProtocol.MJ
    if "nano-banana" in m or "nanobanana" in m:
        return ImageProtocol.BANANA_RATIO
    return ImageProtocol.GPT_SIZE


def aspect_to_gpt_size(aspect_ratio: str | None, size_level: str | None) -> str:
    ar = str(aspect_ratio or "").strip()
    lvl = str(size_level or "1K").lower()
    if not ar or ar in ("Auto", "AUTO", "empty"):
        return "auto"
    return GPT_SIZE_MAP.get(f"{ar}_{lvl}", "1024x1024")


def build_gpt_size_fields(
    *,
    prompt: str,
    model: str,
    n: int,
    aspect_ratio: str | None,
    image_size: str | None,
    size: str | None,
    quality: str | None,
    refs: list[str],
) -> MultipartFields:
    ar = str(aspect_ratio or "").strip()
    is_auto = not ar or ar in ("Auto", "AUTO", "empty")
    resolution = str(image_size or "2K").lower()
    px = size or aspect_to_gpt_size(ar, resolution)
    return MultipartFields(
        text={
            "prompt": prompt,
            "model": model,
            "n": str(n or 1),
            "quality": quality or "auto",
            "moderation": "auto",
            "size": px,
            "aspectRatio": "" if is_auto else ar,
            "resolution": resolution,
        },
        needs_white_placeholder=not bool(refs),
    )


def build_banana_json_payload(
    *,
    prompt: str,
    model: str,
    aspect_ratio: str | None,
    image_size: str | None,
) -> dict[str, Any]:
    ar = str(aspect_ratio or "").strip()
    is_auto = not ar or ar in ("Auto", "AUTO", "empty")
    return {
        "prompt": prompt,
        "model": model,
        "aspect_ratio": "1:1" if is_auto else ar,
        "image_size": str(image_size or "2K").upper(),
    }


def build_mj_payload(
    *,
    prompt: str,
    base64_array: list[str],
    ar: str | None = None,
    seed: int | None = None,
) -> dict[str, Any]:
    return {
        "base64Array": base64_array,
        "instanceId": "",
        "modes": [],
        "notifyHook": "",
        "prompt": prompt,
        "remix": True,
        "state": "",
        "ar": ar,
        "no": None,
        "c": None,
        "s": None,
        "iw": None,
        "tile": False,
        "r": None,
        "video": False,
        "sw": None,
        "cw": None,
        "sv": None,
        "seed": seed,
    }
```

- [ ] **Step 4: Run tests**

Run:

```bash
uv run pytest tests/test_zhenzhen_protocols.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/character_workflow/lib/callers/zhenzhen_protocols.py tests/test_zhenzhen_protocols.py
git commit -m "callers: add zhenzhen image protocol builders"
```

---

## Task 4: Implement Reference Image Handling

**Files:**
- Create: `src/character_workflow/lib/callers/zhenzhen_refs.py`
- Test: `tests/test_zhenzhen_refs.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_zhenzhen_refs.py`:

```python
import base64

from character_workflow.lib.callers import zhenzhen_refs


def test_data_url_to_file_part():
    data = base64.b64encode(b"abc").decode("ascii")

    part = zhenzhen_refs.ref_to_file_part(f"data:image/png;base64,{data}")

    assert part is not None
    assert part.filename.endswith(".png")
    assert part.content_type == "image/png"
    assert part.data == b"abc"


def test_local_path_to_file_part(tmp_path):
    image = tmp_path / "ref.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 32)

    part = zhenzhen_refs.ref_to_file_part(str(image))

    assert part is not None
    assert part.filename == "ref.png"
    assert part.content_type == "image/png"
    assert part.data.startswith(b"\x89PNG")


def test_ref_to_banana_image_keeps_remote_url():
    assert zhenzhen_refs.ref_to_banana_image("https://example.com/a.png") == "https://example.com/a.png"


def test_ref_to_banana_image_converts_local_file_to_data_url(tmp_path):
    image = tmp_path / "ref.jpg"
    image.write_bytes(b"jpeg-bytes")

    out = zhenzhen_refs.ref_to_banana_image(str(image))

    assert out.startswith("data:image/jpeg;base64,")
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_zhenzhen_refs.py -v
```

Expected: FAIL because `zhenzhen_refs.py` does not exist.

- [ ] **Step 3: Create implementation**

Create `src/character_workflow/lib/callers/zhenzhen_refs.py`:

```python
from __future__ import annotations

import base64
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import requests


@dataclass(frozen=True)
class FilePart:
    filename: str
    content_type: str
    data: bytes


def _ext_for_mime(mime: str) -> str:
    if mime == "image/jpeg":
        return "jpg"
    return (mime.split("/")[-1] or "png").replace("jpeg", "jpg")


def _content_type_for_path(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(path))
    return guessed or "image/png"


def ref_to_file_part(ref: str) -> FilePart | None:
    if not isinstance(ref, str) or not ref:
        return None
    if ref.startswith("data:"):
        header, _, raw = ref.partition(",")
        if ";base64" not in header or not raw:
            return None
        mime = header.removeprefix("data:").split(";")[0] or "image/png"
        data = base64.b64decode(raw)
        return FilePart(filename=f"ref.{_ext_for_mime(mime)}", content_type=mime, data=data)
    if ref.startswith("http://") or ref.startswith("https://"):
        resp = requests.get(ref, timeout=180)
        resp.raise_for_status()
        mime = resp.headers.get("content-type", "image/png").split(";")[0]
        suffix = Path(urlparse(ref).path).suffix.lstrip(".") or _ext_for_mime(mime)
        return FilePart(filename=f"ref.{suffix}", content_type=mime, data=resp.content)
    path = Path(ref).expanduser()
    if path.is_file():
        mime = _content_type_for_path(path)
        return FilePart(filename=path.name, content_type=mime, data=path.read_bytes())
    return None


def ref_to_banana_image(ref: str) -> str | None:
    if not isinstance(ref, str) or not ref:
        return None
    if ref.startswith("data:") or ref.startswith("http://") or ref.startswith("https://"):
        return ref
    part = ref_to_file_part(ref)
    if part is None:
        return None
    encoded = base64.b64encode(part.data).decode("ascii")
    return f"data:{part.content_type};base64,{encoded}"


def upload_ref_to_zhenzhen(ref: str, *, api_key: str, base_url: str) -> str | None:
    part = ref_to_file_part(ref)
    if part is None:
        return None
    response = requests.post(
        f"{base_url.rstrip('/')}/v1/files",
        headers={"Authorization": f"Bearer {api_key}"},
        files={"file": (part.filename, part.data, part.content_type)},
        timeout=180,
    )
    response.raise_for_status()
    payload = response.json()
    url = payload.get("url")
    return url if isinstance(url, str) and url else None
```

- [ ] **Step 4: Run tests**

Run:

```bash
uv run pytest tests/test_zhenzhen_refs.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/character_workflow/lib/callers/zhenzhen_refs.py tests/test_zhenzhen_refs.py
git commit -m "callers: add zhenzhen reference image handling"
```

---

## Task 5: Implement Zhenzhen Caller Sync and Async Image Flow

**Files:**
- Create: `src/character_workflow/lib/callers/zhenzhen.py`
- Test: `tests/test_zhenzhen_caller.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_zhenzhen_caller.py`:

```python
import base64
import json

import pytest
import requests

from character_workflow.lib import keys
from character_workflow.lib.callers import zhenzhen


def _add_key(alias: str = "zz") -> None:
    keys.add_key(keys.KeySpec(
        alias=alias,
        provider="zhenzhen",
        base_url="https://ai.t8star.org",
        access_key="zz-secret",
        secret_key=None,
        capabilities=["portrait", "promo", "turnaround"],
        models=[{"name": "GPT Image 2", "id": "gpt-image-2-all"}],
        routing_scope="general",
        routing_category=None,
        routing_hints=[],
        modalities=["image"],
        notes="",
        created_at="2026-05-28T00:00:00+08:00",
    ))


class FakeResponse:
    def __init__(self, payload, *, status_code=200, content=b""):
        self._payload = payload
        self.status_code = status_code
        self.ok = status_code < 400
        self.content = content
        self.headers = {"content-type": "image/png"}
        self.text = json.dumps(payload)

    def json(self):
        return self._payload

    def raise_for_status(self):
        if not self.ok:
            raise requests.HTTPError(self.text)


def test_render_downloads_sync_b64_image(isolated_data_root, tmp_path, monkeypatch):
    _add_key()
    img = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 32).decode("ascii")
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse({"data": [{"b64_json": img}]})

    monkeypatch.setattr(zhenzhen.requests, "post", fake_post)

    paths = zhenzhen.render(
        prompt="fox",
        model="gpt-image-2-all",
        alias="zz",
        output_dir=tmp_path,
        n=1,
        params={"aspect_ratio": "1:1", "image_size": "2K", "reference_images": []},
    )

    assert len(paths) == 1
    assert (tmp_path / "v1.png").read_bytes().startswith(b"\x89PNG")
    assert calls[0][0] == "https://ai.t8star.org/v1/images/edits?async=true"
    assert calls[0][1]["headers"]["Authorization"] == "Bearer zz-secret"


def test_render_polls_async_task_and_remembers_alias(isolated_data_root, tmp_path, monkeypatch):
    _add_key()
    image_bytes = b"\x89PNG\r\n\x1a\n" + b"x" * 32
    post_calls = []
    get_calls = []

    def fake_post(url, **kwargs):
        post_calls.append((url, kwargs))
        return FakeResponse({"data": "task-123"})

    def fake_get(url, **kwargs):
        get_calls.append((url, kwargs))
        return FakeResponse({
            "data": {
                "status": "success",
                "data": {"data": [{"url": "https://cdn.example.com/out.png"}]},
            }
        })

    def fake_download(url, timeout):
        return FakeResponse({}, content=image_bytes)

    monkeypatch.setattr(zhenzhen.requests, "post", fake_post)
    monkeypatch.setattr(zhenzhen.requests, "get", fake_get)
    monkeypatch.setattr(zhenzhen, "_download_url", fake_download)

    paths = zhenzhen.render(
        prompt="fox",
        model="nano-banana-pro",
        alias="zz",
        output_dir=tmp_path,
        n=1,
        params={"aspect_ratio": "1:1", "image_size": "2K", "reference_images": []},
        poll_interval=0,
        max_polls=1,
    )

    assert len(paths) == 1
    assert (tmp_path / "v1.png").read_bytes() == image_bytes
    assert get_calls[0][0] == "https://ai.t8star.org/v1/images/tasks/task-123"
    assert get_calls[0][1]["headers"]["Authorization"] == "Bearer zz-secret"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_zhenzhen_caller.py -v
```

Expected: FAIL because `zhenzhen.py` does not exist.

- [ ] **Step 3: Create implementation**

Create `src/character_workflow/lib/callers/zhenzhen.py`:

```python
from __future__ import annotations

import base64
import time
from pathlib import Path
from typing import Any

import requests

from character_workflow.lib.callers import zhenzhen_keys, zhenzhen_protocols as protocols
from character_workflow.lib.callers import zhenzhen_refs


DEFAULT_BASE_URL = "https://ai.t8star.org"


class ZhenzhenError(RuntimeError):
    pass


def _base_url(key) -> str:
    return (key.base_url or DEFAULT_BASE_URL).rstrip("/")


def _download_url(url: str, timeout: float = 180.0):
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    return response


def _write_image_bytes(output_dir: Path, data: bytes, index: int) -> str:
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"v{index}.png"
    path.write_bytes(data)
    return str(path)


def _write_outputs(payload: dict[str, Any], output_dir: Path) -> list[str]:
    items = payload.get("data")
    if isinstance(items, dict):
        nested = items.get("data")
        if isinstance(nested, dict):
            items = nested.get("data")
        elif isinstance(nested, list):
            items = nested
    if not isinstance(items, list):
        return []
    paths: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("b64_json"), str):
            data = base64.b64decode(item["b64_json"])
            paths.append(_write_image_bytes(output_dir, data, len(paths) + 1))
        elif isinstance(item.get("url"), str):
            response = _download_url(item["url"])
            paths.append(_write_image_bytes(output_dir, response.content, len(paths) + 1))
    return paths


def _task_id(payload: dict[str, Any]) -> str | None:
    data = payload.get("data")
    if isinstance(data, str):
        return data
    if isinstance(data, dict) and isinstance(data.get("task_id"), str):
        return data["task_id"]
    for key in ("task_id", "id"):
        if isinstance(payload.get(key), str):
            return payload[key]
    return None


def _post_json_or_form(url: str, *, api_key: str, json_body=None, data=None, files=None) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {api_key}"}
    if json_body is not None:
        headers["Content-Type"] = "application/json"
        response = requests.post(url, headers=headers, json=json_body, timeout=600)
    else:
        response = requests.post(url, headers=headers, data=data, files=files, timeout=600)
    text = response.text
    try:
        payload = response.json()
    except Exception as e:
        raise ZhenzhenError(f"上游响应非 JSON: {text[:300]}") from e
    if not response.ok:
        message = (
            payload.get("error", {}).get("message")
            if isinstance(payload.get("error"), dict)
            else payload.get("error") or payload.get("message") or f"上游 HTTP {response.status_code}"
        )
        raise ZhenzhenError(str(message))
    return payload


def _submit_standard_image(
    *,
    api_key: str,
    base_url: str,
    prompt: str,
    model: str,
    n: int,
    params: dict[str, Any],
) -> dict[str, Any]:
    refs = list(params.get("reference_images") or [])
    protocol = protocols.detect_image_protocol(model, params.get("param_kind"))
    if protocol == protocols.ImageProtocol.BANANA_RATIO and not refs:
        payload = protocols.build_banana_json_payload(
            prompt=prompt,
            model=model,
            aspect_ratio=params.get("aspect_ratio") or params.get("ratio"),
            image_size=params.get("image_size") or params.get("resolution"),
        )
        return _post_json_or_form(
            f"{base_url}/v1/images/generations?async=true",
            api_key=api_key,
            json_body=payload,
        )

    fields = protocols.build_gpt_size_fields(
        prompt=prompt,
        model=model,
        n=n,
        aspect_ratio=params.get("aspect_ratio") or params.get("ratio"),
        image_size=params.get("image_size") or params.get("resolution"),
        size=params.get("size"),
        quality=params.get("quality"),
        refs=refs,
    )
    files = []
    for ref in refs:
        part = zhenzhen_refs.ref_to_file_part(ref)
        if part:
            files.append(("image", (part.filename, part.data, part.content_type)))
    if fields.needs_white_placeholder:
        files.append(("image", ("blank.png", b"\x89PNG\r\n\x1a\n", "image/png")))
    return _post_json_or_form(
        f"{base_url}/v1/images/edits?async=true",
        api_key=api_key,
        data=fields.text,
        files=files,
    )


def _poll_task(
    *,
    task_id: str,
    alias: str,
    output_dir: Path,
    max_polls: int,
    poll_interval: float,
) -> list[str]:
    for _ in range(max_polls):
        if poll_interval:
            time.sleep(poll_interval)
        key = zhenzhen_keys.pick_key(model_hint="", alias=zhenzhen_keys.recall_task_alias(task_id) or alias)
        url = f"{_base_url(key)}/v1/images/tasks/{task_id}"
        response = requests.get(url, headers={"Authorization": f"Bearer {key.access_key}"}, timeout=180)
        payload = response.json()
        if not response.ok:
            raise ZhenzhenError(payload.get("error", {}).get("message") or f"上游 HTTP {response.status_code}")
        inner = payload.get("data") or {}
        status = str(inner.get("status") or "").lower()
        if status in ("success", "completed", "done"):
            paths = _write_outputs(payload, output_dir)
            if paths:
                return paths
        if status in ("failure", "failed", "error"):
            raise ZhenzhenError(str(inner.get("fail_reason") or "任务失败"))
    raise ZhenzhenError(f"任务轮询超时: {task_id}")


def render(
    *,
    prompt: str,
    model: str,
    alias: str | None,
    output_dir: Path | str,
    n: int = 1,
    params: dict[str, Any] | None = None,
    max_polls: int = 1800,
    poll_interval: float = 2.0,
    **_kwargs,
) -> list[str]:
    params = dict(params or {})
    key = zhenzhen_keys.pick_key(model_hint=model, alias=alias)
    out_dir = Path(output_dir)
    payload = _submit_standard_image(
        api_key=key.access_key,
        base_url=_base_url(key),
        prompt=prompt,
        model=model,
        n=n,
        params=params,
    )
    paths = _write_outputs(payload, out_dir)
    if paths:
        return paths
    task_id = _task_id(payload)
    if not task_id:
        raise ZhenzhenError(f"上游未返回图片也未返回 task_id: {payload!r}")
    zhenzhen_keys.remember_task_alias(task_id, key.alias)
    return _poll_task(
        task_id=task_id,
        alias=key.alias,
        output_dir=out_dir,
        max_polls=max_polls,
        poll_interval=poll_interval,
    )
```

- [ ] **Step 4: Run tests**

Run:

```bash
uv run pytest tests/test_zhenzhen_caller.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/character_workflow/lib/callers/zhenzhen.py tests/test_zhenzhen_caller.py
git commit -m "callers: implement zhenzhen image caller"
```

---

## Task 6: Wire Dispatch and Job Runner

**Files:**
- Modify: `src/character_workflow/lib/callers/__init__.py`
- Modify: `src/character_workflow/lib/job_runner.py`
- Test: `tests/test_callers_dispatch.py`
- Test: `tests/test_job_runner.py`

- [ ] **Step 1: Write failing dispatch test**

Append to `tests/test_callers_dispatch.py`:

```python
def test_dispatch_routes_zhenzhen_alias_to_zhenzhen_render(
    isolated_keys_db, tmp_path, monkeypatch,
):
    _add("zz-main", "zhenzhen")
    captured = {}

    def fake_render(*, prompt, model, alias, **kwargs):
        captured["prompt"] = prompt
        captured["model"] = model
        captured["alias"] = alias
        captured["kwargs"] = kwargs
        return [str(tmp_path / "v1.png")]

    monkeypatch.setattr(
        "character_workflow.lib.callers.zhenzhen.render",
        fake_render,
    )

    paths = dispatch(
        prompt="fox",
        model="gpt-image-2-all",
        alias="zz-main",
        output_dir=tmp_path,
        params={"size": "1024x1024"},
    )

    assert paths == [str(tmp_path / "v1.png")]
    assert captured["alias"] == "zz-main"
    assert captured["model"] == "gpt-image-2-all"
```

Append to `tests/test_job_runner.py`:

```python
def test_run_job_dispatches_zhenzhen_and_moves_valid_output(project, monkeypatch):
    from character_workflow.lib import keys
    from character_workflow.lib.jobs import save_job
    from character_workflow.lib.schemas import Job, JobParams
    from datetime import datetime, timezone

    keys.add_key(keys.KeySpec(
        alias="zz",
        provider="zhenzhen",
        base_url="https://ai.t8star.org",
        access_key="zz-secret",
        secret_key=None,
        capabilities=["portrait", "promo", "turnaround"],
        models=[{"name": "GPT Image 2", "id": "gpt-image-2-all"}],
        routing_scope="general",
        routing_category=None,
        routing_hints=[],
        modalities=["image"],
        notes="",
        created_at="2026-05-28T00:00:00+08:00",
    ))
    job = Job(
        job_id="studio-zz-001",
        character_id="zz",
        prompt="fox",
        submitted_at=datetime.now(timezone.utc).isoformat(),
        model="gpt-image-2-all",
        params=JobParams(size="1024x1024", n=1),
        seed=None,
        output_paths=[],
        status=JobStatus.PENDING,
        error=None,
        namespace="studio",
        alias="zz",
        provider="zhenzhen",
    )
    save_job(job)

    def fake_dispatch(**kwargs):
        out = Path(kwargs["output_dir"]) / "v1.png"
        _write_png(out, width=4, height=4)
        return [str(out)]

    monkeypatch.setattr(job_runner, "dispatch", fake_dispatch)

    final = job_runner.run_job("studio-zz-001")

    assert final.status == JobStatus.DONE
    assert final.error is None
    assert len(final.output_paths) == 1
    assert Path(final.output_paths[0]).exists()
    assert "studio/studio-zz-001" in final.output_paths[0]
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_callers_dispatch.py::test_dispatch_routes_zhenzhen_alias_to_zhenzhen_render tests/test_job_runner.py::test_run_job_dispatches_zhenzhen_and_moves_valid_output -v
```

Expected: FAIL because dispatch does not import or route `zhenzhen`.

- [ ] **Step 3: Wire dispatch**

In `src/character_workflow/lib/callers/__init__.py`, update imports:

```python
from . import lovart, stubs, zhenzhen
```

Update `_provider_render`:

```python
    if provider == "zhenzhen":
        return zhenzhen.render
```

Update `__all__`:

```python
    "zhenzhen",
```

- [ ] **Step 4: Run tests**

Run:

```bash
uv run pytest tests/test_callers_dispatch.py::test_dispatch_routes_zhenzhen_alias_to_zhenzhen_render tests/test_job_runner.py::test_run_job_dispatches_zhenzhen_and_moves_valid_output -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/character_workflow/lib/callers/__init__.py tests/test_callers_dispatch.py tests/test_job_runner.py
git commit -m "callers: route zhenzhen through dispatch"
```

---

## Task 7: Add MJ Protocol Support

**Files:**
- Modify: `src/character_workflow/lib/callers/zhenzhen.py`
- Modify: `src/character_workflow/lib/callers/zhenzhen_protocols.py`
- Test: `tests/test_zhenzhen_caller.py`
- Test: `tests/test_zhenzhen_protocols.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/test_zhenzhen_protocols.py`:

```python
def test_mj_speed_segment_defaults_to_fast():
    assert zp.mj_speed_segment("turbo") == "mj-turbo"
    assert zp.mj_speed_segment("relax") == "mj-relax"
    assert zp.mj_speed_segment(None) == "mj-fast"
```

Append to `tests/test_zhenzhen_caller.py`:

```python
def test_render_mj_imagine_then_fetch(isolated_data_root, tmp_path, monkeypatch):
    _add_key()
    image_bytes = b"\x89PNG\r\n\x1a\n" + b"x" * 32
    calls = []

    def fake_post(url, **kwargs):
        calls.append(("POST", url, kwargs))
        return FakeResponse({"result": "mj-task-1"})

    def fake_get(url, **kwargs):
        calls.append(("GET", url, kwargs))
        return FakeResponse({
            "status": "SUCCESS",
            "image_url": "https://cdn.example.com/mj.png",
        })

    def fake_download(url, timeout):
        return FakeResponse({}, content=image_bytes)

    monkeypatch.setattr(zhenzhen.requests, "post", fake_post)
    monkeypatch.setattr(zhenzhen.requests, "get", fake_get)
    monkeypatch.setattr(zhenzhen, "_download_url", fake_download)

    paths = zhenzhen.render(
        prompt="castle --v 8.1 --ar 16:9",
        model="midjourney",
        alias="zz",
        output_dir=tmp_path,
        params={"mj_speed": "fast", "aspect_ratio": "16:9"},
        poll_interval=0,
        max_polls=1,
    )

    assert len(paths) == 1
    assert calls[0][1] == "https://ai.t8star.org/mj-fast/mj/submit/imagine"
    assert calls[1][1] == "https://ai.t8star.org/mj-fast/mj/task/mj-task-1/fetch"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_zhenzhen_protocols.py::test_mj_speed_segment_defaults_to_fast tests/test_zhenzhen_caller.py::test_render_mj_imagine_then_fetch -v
```

Expected: FAIL because MJ segment and caller path do not exist.

- [ ] **Step 3: Add MJ speed helper**

In `src/character_workflow/lib/callers/zhenzhen_protocols.py`, add:

```python
MJ_SPEED_MAP = {"turbo": "mj-turbo", "fast": "mj-fast", "relax": "mj-relax"}


def mj_speed_segment(speed: str | None) -> str:
    return MJ_SPEED_MAP.get(str(speed or "").lower(), "mj-fast")
```

- [ ] **Step 4: Add MJ caller branch**

In `src/character_workflow/lib/callers/zhenzhen.py`, add:

```python
def _write_single_remote_image(url: str, output_dir: Path) -> list[str]:
    response = _download_url(url)
    return [_write_image_bytes(output_dir, response.content, 1)]


def _submit_mj(
    *,
    api_key: str,
    base_url: str,
    prompt: str,
    params: dict[str, Any],
) -> tuple[str, str]:
    speed_seg = protocols.mj_speed_segment(params.get("mj_speed"))
    payload = protocols.build_mj_payload(
        prompt=prompt,
        base64_array=list(params.get("base64_array") or []),
        ar=params.get("aspect_ratio"),
        seed=params.get("seed"),
    )
    response = requests.post(
        f"{base_url}/{speed_seg}/mj/submit/imagine",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=600,
    )
    data = response.json()
    if not response.ok:
        raise ZhenzhenError(data.get("error") or data.get("description") or f"上游 HTTP {response.status_code}")
    task_id = data.get("result")
    if not isinstance(task_id, str) or not task_id:
        raise ZhenzhenError(f"MJ 未返回 task id: {data!r}")
    return task_id, speed_seg


def _poll_mj_task(
    *,
    api_key: str,
    base_url: str,
    task_id: str,
    speed_seg: str,
    output_dir: Path,
    max_polls: int,
    poll_interval: float,
) -> list[str]:
    for _ in range(max_polls):
        if poll_interval:
            time.sleep(poll_interval)
        response = requests.get(
            f"{base_url}/{speed_seg}/mj/task/{task_id}/fetch",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            timeout=180,
        )
        data = response.json()
        if not response.ok:
            raise ZhenzhenError(data.get("error") or data.get("description") or f"上游 HTTP {response.status_code}")
        status = str(data.get("status") or "").upper()
        image_url = data.get("image_url") or data.get("imageUrl")
        if status in ("SUCCESS", "DONE", "COMPLETED") and image_url:
            return _write_single_remote_image(image_url, output_dir)
        if status in ("FAILURE", "FAILED", "ERROR"):
            raise ZhenzhenError(str(data.get("fail_reason") or data.get("failReason") or "MJ 任务失败"))
    raise ZhenzhenError(f"MJ 任务轮询超时: {task_id}")
```

At the start of `render(...)`, after selecting `key`, add:

```python
    protocol = protocols.detect_image_protocol(model, params.get("param_kind"))
    if protocol == protocols.ImageProtocol.MJ:
        task_id, speed_seg = _submit_mj(
            api_key=key.access_key,
            base_url=_base_url(key),
            prompt=prompt,
            params=params,
        )
        zhenzhen_keys.remember_task_alias(task_id, key.alias)
        return _poll_mj_task(
            api_key=key.access_key,
            base_url=_base_url(key),
            task_id=task_id,
            speed_seg=speed_seg,
            output_dir=out_dir,
            max_polls=max_polls,
            poll_interval=poll_interval,
        )
```

- [ ] **Step 5: Run tests**

Run:

```bash
uv run pytest tests/test_zhenzhen_protocols.py::test_mj_speed_segment_defaults_to_fast tests/test_zhenzhen_caller.py::test_render_mj_imagine_then_fetch -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/character_workflow/lib/callers/zhenzhen.py src/character_workflow/lib/callers/zhenzhen_protocols.py tests/test_zhenzhen_caller.py tests/test_zhenzhen_protocols.py
git commit -m "callers: add zhenzhen midjourney protocol"
```

---

## Task 8: Add FAL Protocol Support

**Files:**
- Modify: `src/character_workflow/lib/callers/zhenzhen.py`
- Modify: `src/character_workflow/lib/callers/zhenzhen_protocols.py`
- Test: `tests/test_zhenzhen_caller.py`
- Test: `tests/test_zhenzhen_protocols.py`

- [ ] **Step 1: Write failing tests**

Append to `tests/test_zhenzhen_protocols.py`:

```python
def test_fal_response_url_rewrites_queue_domain():
    out = zp.fix_fal_response_url(
        "https://queue.fal.run/openai/gpt-image-2/requests/abc",
        base_url="https://ai.t8star.org",
        endpoint="openai/gpt-image-2",
        request_id="abc",
    )

    assert out == "https://ai.t8star.org/fal/openai/gpt-image-2/requests/abc"


def test_fal_response_url_builds_when_missing():
    out = zp.fix_fal_response_url(
        "",
        base_url="https://ai.t8star.org",
        endpoint="openai/gpt-image-2",
        request_id="abc",
    )

    assert out == "https://ai.t8star.org/fal/openai/gpt-image-2/requests/abc"
```

Append to `tests/test_zhenzhen_caller.py`:

```python
def test_render_fal_submit_then_query(isolated_data_root, tmp_path, monkeypatch):
    _add_key()
    image_bytes = b"\x89PNG\r\n\x1a\n" + b"x" * 32
    calls = []

    def fake_post(url, **kwargs):
        calls.append(("POST", url, kwargs))
        if url.endswith("/fal/openai/gpt-image-2"):
            return FakeResponse({
                "request_id": "req-1",
                "response_url": "https://queue.fal.run/openai/gpt-image-2/requests/req-1",
            })
        return FakeResponse({})

    def fake_get(url, **kwargs):
        calls.append(("GET", url, kwargs))
        return FakeResponse({"images": [{"url": "https://cdn.example.com/fal.png"}]})

    def fake_download(url, timeout):
        return FakeResponse({}, content=image_bytes)

    monkeypatch.setattr(zhenzhen.requests, "post", fake_post)
    monkeypatch.setattr(zhenzhen.requests, "get", fake_get)
    monkeypatch.setattr(zhenzhen, "_download_url", fake_download)

    paths = zhenzhen.render(
        prompt="fox",
        model="gpt-image-2-fal",
        alias="zz",
        output_dir=tmp_path,
        params={"quality": "medium", "fal_size": "square_hd"},
        poll_interval=0,
        max_polls=1,
    )

    assert len(paths) == 1
    assert calls[0][1] == "https://ai.t8star.org/fal/openai/gpt-image-2"
    assert calls[1][1] == "https://ai.t8star.org/fal/openai/gpt-image-2/requests/req-1"
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_zhenzhen_protocols.py::test_fal_response_url_rewrites_queue_domain tests/test_zhenzhen_protocols.py::test_fal_response_url_builds_when_missing tests/test_zhenzhen_caller.py::test_render_fal_submit_then_query -v
```

Expected: FAIL because FAL URL helper and caller path do not exist.

- [ ] **Step 3: Add protocol helpers**

In `src/character_workflow/lib/callers/zhenzhen_protocols.py`, add:

```python
FAL_REGISTRY = {
    "gpt-image-2-fal": {
        "endpoint": "openai/gpt-image-2",
        "edit_endpoint": "openai/gpt-image-2/edit",
        "param_kind": "gpt-fal",
        "max_refs": 5,
    },
    "nano-banana-pro-fal": {
        "endpoint": "fal-ai/nano-banana-pro/edit",
        "edit_endpoint": "fal-ai/nano-banana-pro/edit",
        "param_kind": "nbpro-fal",
        "max_refs": 8,
    },
    "nano-banana-2-fal": {
        "endpoint": "fal-ai/nano-banana-pro/edit",
        "edit_endpoint": "fal-ai/nano-banana-pro/edit",
        "param_kind": "nbpro-fal",
        "max_refs": 8,
    },
}


def fix_fal_response_url(
    response_url: str | None,
    *,
    base_url: str,
    endpoint: str,
    request_id: str,
) -> str:
    url = str(response_url or "")
    if "queue.fal.run" in url:
        url = url.replace("https://queue.fal.run", f"{base_url.rstrip('/')}/fal")
    if not url:
        url = f"{base_url.rstrip('/')}/fal/{endpoint}/requests/{request_id}"
    return url


def snap16(value: object, fallback: int) -> int:
    try:
        n = int(value)
    except Exception:
        return fallback
    if n <= 0:
        return fallback
    return max(256, min(3840, round(n / 16) * 16))
```

- [ ] **Step 4: Add FAL caller branch**

In `src/character_workflow/lib/callers/zhenzhen.py`, add:

```python
def _submit_fal(
    *,
    api_key: str,
    base_url: str,
    prompt: str,
    model: str,
    params: dict[str, Any],
) -> tuple[str, str]:
    reg = protocols.FAL_REGISTRY.get(model)
    if not reg:
        raise ZhenzhenError(f"未知的 FAL 模型: {model}")
    endpoint = reg["endpoint"]
    payload = {
        "prompt": prompt,
        "quality": str(params.get("quality") or "medium"),
        "num_images": max(1, min(4, int(params.get("n") or 1))),
        "output_format": str(params.get("format") or "png").lower(),
    }
    fal_size = params.get("fal_size")
    if fal_size and fal_size != "auto":
        payload["image_size"] = fal_size
    if params.get("sync") is True:
        payload["sync_mode"] = True

    response = requests.post(
        f"{base_url}/fal/{endpoint}",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=600,
    )
    data = response.json()
    if not response.ok:
        raise ZhenzhenError(data.get("error") or data.get("detail") or data.get("message") or f"FAL HTTP {response.status_code}")
    if isinstance(data.get("images"), list):
        return "__sync__", endpoint
    request_id = data.get("request_id")
    if not isinstance(request_id, str) or not request_id:
        raise ZhenzhenError(f"未获取到 request_id: {data!r}")
    response_url = protocols.fix_fal_response_url(
        data.get("response_url"),
        base_url=base_url,
        endpoint=endpoint,
        request_id=request_id,
    )
    return response_url, endpoint


def _poll_fal(
    *,
    api_key: str,
    response_url: str,
    output_dir: Path,
    max_polls: int,
    poll_interval: float,
) -> list[str]:
    for _ in range(max_polls):
        if poll_interval:
            time.sleep(poll_interval)
        response = requests.get(response_url, headers={"Authorization": f"Bearer {api_key}"}, timeout=180)
        data = response.json()
        if not response.ok:
            if data.get("status") in ("IN_QUEUE", "IN_PROGRESS"):
                continue
            raise ZhenzhenError(f"FAL Poll HTTP {response.status_code}: {response.text[:300]}")
        if isinstance(data.get("images"), list) and data["images"]:
            payload = {"data": [{"url": item.get("url")} for item in data["images"] if item.get("url")]}
            paths = _write_outputs(payload, output_dir)
            if paths:
                return paths
        status = str(data.get("status") or "").upper()
        if status in ("FAILED", "CANCELLED"):
            raise ZhenzhenError(str(data.get("error") or data.get("detail") or f"FAL {status}"))
    raise ZhenzhenError(f"FAL 任务轮询超时: {response_url}")
```

Inside `render(...)`, add the FAL branch after the MJ branch:

```python
    if protocol == protocols.ImageProtocol.FAL:
        response_url, _endpoint = _submit_fal(
            api_key=key.access_key,
            base_url=_base_url(key),
            prompt=prompt,
            model=model,
            params=params,
        )
        if response_url == "__sync__":
            raise ZhenzhenError("FAL 同步响应未归一化")
        zhenzhen_keys.remember_task_alias(response_url, key.alias)
        return _poll_fal(
            api_key=key.access_key,
            response_url=response_url,
            output_dir=out_dir,
            max_polls=max_polls,
            poll_interval=poll_interval,
        )
```

- [ ] **Step 5: Run tests**

Run:

```bash
uv run pytest tests/test_zhenzhen_protocols.py::test_fal_response_url_rewrites_queue_domain tests/test_zhenzhen_protocols.py::test_fal_response_url_builds_when_missing tests/test_zhenzhen_caller.py::test_render_fal_submit_then_query -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/character_workflow/lib/callers/zhenzhen.py src/character_workflow/lib/callers/zhenzhen_protocols.py tests/test_zhenzhen_caller.py tests/test_zhenzhen_protocols.py
git commit -m "callers: add zhenzhen fal protocol"
```

---

## Task 9: Add Web Key Form Controls

**Files:**
- Modify: `web/src/api/keys.ts`
- Modify: `web/src/pages/settings/KeyForm.tsx`
- Test: `web/src/pages/settings/Keys.test.tsx`

- [ ] **Step 1: Write failing frontend test**

Append to `web/src/pages/settings/Keys.test.tsx`:

```tsx
it('creates a Zhenzhen classified GPT image key', async () => {
  vi.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ secret_revealed: 'zz-secret' }),
  } as Response);

  render(<KeysPage />);
  fireEvent.click(screen.getByText('新建 Key'));
  fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'zhenzhen' } });
  fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: 'zz-gpt' } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'zz-secret' } });
  fireEvent.change(screen.getByLabelText('Key 类型'), { target: { value: 'classified' } });
  fireEvent.change(screen.getByLabelText('分类'), { target: { value: 'gpt_image' } });
  fireEvent.click(screen.getByText('保存'));

  await waitFor(() => expect(fetch).toHaveBeenCalled());
  const [, init] = vi.mocked(fetch).mock.calls[0];
  const body = JSON.parse(String(init?.body));
  expect(body).toMatchObject({
    alias: 'zz-gpt',
    provider: 'zhenzhen',
    base_url: 'https://ai.t8star.org',
    access_key: 'zz-secret',
    routing_scope: 'classified',
    routing_category: 'gpt_image',
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd web && pnpm test Keys.test.tsx -- --runInBand
```

Expected: FAIL because the Zhenzhen provider and routing controls do not exist.

- [ ] **Step 3: Extend frontend API types**

In `web/src/api/keys.ts`, add to `KeyCreatePayload` and key response types:

```ts
  routing_scope?: 'general' | 'classified';
  routing_category?: 'gpt_image' | 'nano_banana' | 'mj' | 'veo' | 'grok' | 'seedance' | 'suno' | null;
  routing_hints?: string[];
```

- [ ] **Step 4: Add KeyForm controls**

In `web/src/pages/settings/KeyForm.tsx`, add provider preset:

```tsx
{ value: 'zhenzhen', label: '贞贞工坊', kind: 'third_party', modalities: ['image', 'video', 'audio'], homepageUrl: 'https://ai.t8star.org', defaultBaseUrl: 'https://ai.t8star.org', defaultModels: [{ name: 'GPT Image 2', id: 'gpt-image-2-all' }, { name: 'Nano Banana Pro', id: 'nano-banana-pro' }, { name: 'Midjourney', id: 'midjourney' }] },
```

Add state near other `useState` calls:

```tsx
const [routingScope, setRoutingScope] = useState<'general' | 'classified'>(initial?.routing_scope ?? 'general');
const [routingCategory, setRoutingCategory] = useState<KeyCreatePayload['routing_category']>(initial?.routing_category ?? 'gpt_image');
```

Reset routing state in `changeProvider`:

```tsx
setRoutingScope('general');
setRoutingCategory('gpt_image');
```

Add fields to `createKey(...)` payload:

```tsx
routing_scope: provider === 'zhenzhen' ? routingScope : 'general',
routing_category: provider === 'zhenzhen' && routingScope === 'classified' ? routingCategory : null,
routing_hints: [],
```

Add JSX after the custom provider block:

```tsx
{provider === 'zhenzhen' && (
  <div className="grid grid-cols-2 gap-3">
    <label className="block">
      <span className="block text-sm mb-2 text-muted-foreground">Key 类型</span>
      <select
        aria-label="Key 类型"
        value={routingScope}
        onChange={e => setRoutingScope(e.target.value as 'general' | 'classified')}
        className={fieldClass}
      >
        <option value="general">通用 Key</option>
        <option value="classified">分类 Key</option>
      </select>
    </label>
    {routingScope === 'classified' && (
      <label className="block">
        <span className="block text-sm mb-2 text-muted-foreground">分类</span>
        <select
          aria-label="分类"
          value={routingCategory ?? 'gpt_image'}
          onChange={e => setRoutingCategory(e.target.value as KeyCreatePayload['routing_category'])}
          className={fieldClass}
        >
          <option value="gpt_image">GPT Image</option>
          <option value="nano_banana">Nano Banana</option>
          <option value="mj">Midjourney</option>
          <option value="veo">Veo</option>
          <option value="grok">Grok</option>
          <option value="seedance">Seedance</option>
          <option value="suno">Suno</option>
        </select>
      </label>
    )}
  </div>
)}
```

Update alias behavior so Zhenzhen can have multiple keys:

```tsx
setAlias(nextProvider === 'custom' || nextProvider === 'zhenzhen' ? '' : nextProvider);
```

Update submit alias:

```tsx
alias: provider === 'custom' || provider === 'zhenzhen' ? alias.trim() : provider,
```

Update `canSubmit`:

```tsx
&& ((provider !== 'custom' && provider !== 'zhenzhen') || (alias.trim() && baseUrl.trim()))
```

- [ ] **Step 5: Run frontend tests**

Run:

```bash
cd web && pnpm test Keys.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/api/keys.ts web/src/pages/settings/KeyForm.tsx web/src/pages/settings/Keys.test.tsx
git commit -m "web: add zhenzhen key routing controls"
```

---

## Task 10: Add Studio Integration Test for Zhenzhen Jobs

**Files:**
- Modify: `tests/test_studio_jobs.py`
- Modify: `tests/test_job_runner.py`

- [ ] **Step 1: Write failing API integration test**

Append to `tests/test_studio_jobs.py`:

```python
def test_create_studio_job_accepts_zhenzhen_key(client, monkeypatch):
    from viewer_server import routes as routes_module
    from character_workflow.lib import keys
    from character_workflow.lib.jobs import read_job

    keys.add_key(keys.KeySpec(
        alias="zz-general",
        provider="zhenzhen",
        base_url="https://ai.t8star.org",
        access_key="zz-secret",
        secret_key=None,
        capabilities=["portrait", "promo", "turnaround"],
        models=[{"name": "GPT Image 2", "id": "gpt-image-2-all"}],
        routing_scope="general",
        routing_category=None,
        routing_hints=[],
        modalities=["image"],
        notes="",
        created_at="2026-05-28T00:00:00+08:00",
    ))
    keys.set_default_alias("zz-general")
    monkeypatch.setattr(routes_module, "_run_studio_job_safely", lambda _job_id: None)

    resp = client.post("/api/studio/jobs", json={
        "prompt": "fox",
        "model": "gpt-image-2-all",
        "alias": "zz-general",
        "params": {"size": "2048x2048", "n": 1},
    })

    assert resp.status_code == 201, resp.text
    job = read_job(resp.json()["job_id"])
    assert job.provider == "zhenzhen"
    assert job.alias == "zz-general"
    assert job.namespace == "studio"
```

- [ ] **Step 2: Run test to verify current behavior**

Run:

```bash
uv run pytest tests/test_studio_jobs.py::test_create_studio_job_accepts_zhenzhen_key -v
```

Expected: PASS if earlier schema and route tasks are correct. If it fails, fix only the missing provider/schema path from earlier tasks.

- [ ] **Step 3: Add durable runner integration test**

Append to `tests/test_job_runner.py`:

```python
def test_zhenzhen_failed_dispatch_marks_job_failed(project, monkeypatch):
    from character_workflow.lib import keys
    from character_workflow.lib.jobs import save_job, read_job
    from character_workflow.lib.schemas import Job, JobParams
    from datetime import datetime, timezone

    keys.add_key(keys.KeySpec(
        alias="zz",
        provider="zhenzhen",
        base_url="https://ai.t8star.org",
        access_key="zz-secret",
        secret_key=None,
        capabilities=["portrait", "promo", "turnaround"],
        models=[{"name": "GPT Image 2", "id": "gpt-image-2-all"}],
        routing_scope="general",
        routing_category=None,
        routing_hints=[],
        modalities=["image"],
        notes="",
        created_at="2026-05-28T00:00:00+08:00",
    ))
    save_job(Job(
        job_id="studio-zz-fail",
        character_id="zz",
        prompt="fox",
        submitted_at=datetime.now(timezone.utc).isoformat(),
        model="gpt-image-2-all",
        params=JobParams(size="1024x1024", n=1),
        seed=None,
        output_paths=[],
        status=JobStatus.PENDING,
        error=None,
        namespace="studio",
        alias="zz",
        provider="zhenzhen",
    ))

    def fake_dispatch(**_kwargs):
        raise RuntimeError("upstream unavailable")

    monkeypatch.setattr(job_runner, "dispatch", fake_dispatch)

    with pytest.raises(job_runner.JobRunnerError):
        job_runner.run_job("studio-zz-fail")

    final = read_job("studio-zz-fail")
    assert final.status == JobStatus.FAILED
    assert "upstream unavailable" in final.error
```

- [ ] **Step 4: Run tests**

Run:

```bash
uv run pytest tests/test_studio_jobs.py::test_create_studio_job_accepts_zhenzhen_key tests/test_job_runner.py::test_zhenzhen_failed_dispatch_marks_job_failed -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_studio_jobs.py tests/test_job_runner.py
git commit -m "tests: cover zhenzhen studio job flow"
```

---

## Task 11: Remove Fake Provider Options or Mark Them Explicitly Unsupported

**Files:**
- Modify: `web/src/pages/settings/KeyForm.tsx`
- Modify: `src/character_workflow/lib/callers/stubs.py`
- Test: `web/src/pages/settings/Keys.test.tsx`
- Test: `tests/test_callers_dispatch.py`

- [ ] **Step 1: Write frontend expectation**

Update existing provider preset tests in `web/src/pages/settings/Keys.test.tsx` so the provider dropdown includes only providers with real backend paths:

```tsx
it('shows only providers with concrete backend paths', () => {
  render(<KeyForm onCreated={vi.fn()} onCancel={vi.fn()} />);

  const options = Array.from(screen.getByLabelText('供应商选择').querySelectorAll('option')).map(option => option.value);

  expect(options).toEqual(['openai', 'seedream', 'zhenzhen', 'custom']);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd web && pnpm test Keys.test.tsx
```

Expected: FAIL if `midjourney` and `nano_banana` remain as standalone fake providers.

- [ ] **Step 3: Remove fake standalone presets**

In `web/src/pages/settings/KeyForm.tsx`, set `PROVIDER_PRESETS` to concrete backend providers:

```tsx
const PROVIDER_PRESETS: ProviderPreset[] = [
  { value: 'openai', label: 'OpenAI', kind: 'official', modalities: ['image', 'llm'], homepageUrl: 'https://platform.openai.com', docsUrl: 'https://platform.openai.com/docs', apiKeyUrl: 'https://platform.openai.com/api-keys', defaultBaseUrl: 'https://api.openai.com/v1', defaultModels: [{ name: 'GPT Image 1', id: 'gpt-image-1' }] },
  { value: 'seedream', label: '火山引擎', kind: 'third_party', modalities: ['image'], homepageUrl: 'https://www.volcengine.com', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModels: [{ name: '图片 5.0', id: 'doubao-seedream-5-0-260128' }] },
  { value: 'zhenzhen', label: '贞贞工坊', kind: 'third_party', modalities: ['image', 'video', 'audio'], homepageUrl: 'https://ai.t8star.org', defaultBaseUrl: 'https://ai.t8star.org', defaultModels: [{ name: 'GPT Image 2', id: 'gpt-image-2-all' }, { name: 'Nano Banana Pro', id: 'nano-banana-pro' }, { name: 'Midjourney', id: 'midjourney' }] },
  { value: 'custom', label: '自定义 OpenAI-compatible', kind: 'custom', modalities: ['image'], defaultBaseUrl: '', defaultModels: [{ name: '', id: '' }] },
];
```

- [ ] **Step 4: Keep backend stubs as hard errors**

In `src/character_workflow/lib/callers/stubs.py`, keep explicit errors but make messages user-facing:

```python
def midjourney_render(**_kwargs) -> list[str]:
    raise NotImplementedError("midjourney standalone provider is not wired; use provider='zhenzhen' with model='midjourney'")


def nano_banana_render(**_kwargs) -> list[str]:
    raise NotImplementedError("nano_banana standalone provider is not wired; use provider='zhenzhen' with model='nano-banana-pro'")
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd web && pnpm test Keys.test.tsx
uv run pytest tests/test_callers_dispatch.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/settings/KeyForm.tsx web/src/pages/settings/Keys.test.tsx src/character_workflow/lib/callers/stubs.py tests/test_callers_dispatch.py
git commit -m "web: hide fake standalone image providers"
```

---

## Task 12: Documentation and Contract Update

**Files:**
- Modify: `docs/api-contract.md`
- Modify: `docs/superpowers/plans/2026-05-22-skill-distribution-completion-report.md` if it has stale provider claims
- Create: `docs/superpowers/specs/2026-05-28-zhenzhen-provider-backend.md`

- [ ] **Step 1: Write provider contract spec**

Create `docs/superpowers/specs/2026-05-28-zhenzhen-provider-backend.md`:

```markdown
# Zhenzhen Provider Backend Spec

## Summary

The backend supports `provider="zhenzhen"` for T8star/Zhenzhen-compatible image generation through `https://ai.t8star.org`.

## Key Model

Keys remain in `<data_root>/.config/keys.json`.

Zhenzhen keys use:

- `routing_scope="general"` for fallback keys
- `routing_scope="classified"` plus `routing_category` for model-specific keys
- `routing_category` values: `gpt_image`, `nano_banana`, `mj`, `veo`, `grok`, `seedance`, `suno`

## Effective Key Selection

1. Explicit alias wins.
2. Classified key matching model hint wins.
3. Default alias wins if it is a general Zhenzhen key.
4. First general Zhenzhen key wins.
5. If nothing matches, the caller raises a clear configuration error.

## Image Protocols

- GPT Image: multipart `POST /v1/images/edits?async=true`
- Nano Banana: JSON `POST /v1/images/generations?async=true` without refs, multipart edits with refs
- FAL: `POST /fal/{endpoint}` plus response URL polling
- MJ: `POST /{mj-speed}/mj/submit/imagine` plus task fetch polling

## Job Output

Callers write generated files to a temporary output directory. `job_runner` validates files and moves them into stable project paths.
```

- [ ] **Step 2: Update API contract**

In `docs/api-contract.md`, add a section under API Keys:

```markdown
### Zhenzhen Key Routing

`POST /api/keys` accepts optional routing metadata:

| field | type | meaning |
|---|---|---|
| `routing_scope` | `"general" | "classified"` | General fallback key or classified key |
| `routing_category` | string or null | `gpt_image`, `nano_banana`, `mj`, `veo`, `grok`, `seedance`, `suno` |
| `routing_hints` | string[] | Extra lowercase substrings that match model ids |

For `provider="zhenzhen"`, the runner picks keys by explicit alias first, then classified model hint, then general fallback.
```

- [ ] **Step 3: Run doc-adjacent verification**

Run:

```bash
rg -n "midjourney|nano_banana|zhenzhen|routing_scope|routing_category" docs src web tests
```

Expected: results show `zhenzhen` documented and fake standalone providers no longer presented as normal UI presets.

- [ ] **Step 4: Commit**

```bash
git add docs/api-contract.md docs/superpowers/specs/2026-05-28-zhenzhen-provider-backend.md
git commit -m "docs: document zhenzhen provider routing"
```

---

## Task 13: Final Verification

**Files:**
- No code files unless failures reveal scoped fixes.

- [ ] **Step 1: Run targeted backend tests**

Run:

```bash
uv run pytest \
  tests/test_keys.py \
  tests/test_keys_api.py \
  tests/test_zhenzhen_keys.py \
  tests/test_zhenzhen_protocols.py \
  tests/test_zhenzhen_refs.py \
  tests/test_zhenzhen_caller.py \
  tests/test_callers_dispatch.py \
  tests/test_job_runner.py \
  tests/test_studio_jobs.py \
  -v
```

Expected: PASS.

- [ ] **Step 2: Run frontend tests**

Run:

```bash
cd web && pnpm test Keys.test.tsx Studio.test.tsx Home.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run lint/build**

Run:

```bash
uv run ruff check src tests
cd web && pnpm lint
cd web && pnpm build
```

Expected:

- `ruff check` passes for touched files. If the repository still has pre-existing unrelated failures, record exact files and do not fix unrelated code.
- `pnpm lint` passes.
- `pnpm build` passes.

- [ ] **Step 4: Manual smoke with a real Zhenzhen key**

Use the running local server and Web UI:

1. Open Settings.
2. Create provider `贞贞工坊`, alias `zz-general`, type `通用 Key`, model `gpt-image-2-all`.
3. Set it as default.
4. Open Studio.
5. Submit prompt `一只橙色狐狸，白色背景，游戏角色设定图`.
6. Confirm the job reaches `done`.
7. Confirm output file exists under `<data_root>/studio/<job_id>/v1.png`.

Expected: image appears in Studio round list and job JSON contains `provider="zhenzhen"`.

- [ ] **Step 5: Commit final fixes**

If verification required small fixes:

```bash
git add <only-files-touched-for-zhenzhen-provider>
git commit -m "fix: stabilize zhenzhen provider integration"
```

If no fixes were required, do not create an empty commit.

---

## Self-Review

### Spec Coverage

- Key storage location: covered by keeping `<data_root>/.config/keys.json` and extending `KeySpec`.
- General/classified keys: covered in Task 1 and Task 2.
- `pickApiKey()` behavior: covered by `zhenzhen_keys.pick_key`.
- `ensureKey()` behavior: covered by classified-only tests and clear missing-key errors.
- `taskId -> apiKey` memory: adapted as safer `task_id -> alias` in Task 2 and used in Task 5.
- Three image protocols: GPT-size and banana-ratio in Task 3/5, MJ in Task 7, FAL in Task 8.
- Protocol layering: separate files for keys, protocols, refs, and caller.
- Image protocol builders/reference handling/async state machine: covered by Tasks 3, 4, 5, 7, and 8.

### Placeholder Scan

The plan avoids placeholder implementation steps. It intentionally excludes video/audio/RH/LLM from scope and states that they require separate plans.

### Type Consistency

- Provider string is consistently `zhenzhen`.
- Key routing fields are consistently `routing_scope`, `routing_category`, and `routing_hints`.
- Routing categories are consistently `gpt_image`, `nano_banana`, `mj`, `veo`, `grok`, `seedance`, and `suno`.
- Caller public entrypoint remains `render(...) -> list[str]`, matching existing dispatch expectations.

