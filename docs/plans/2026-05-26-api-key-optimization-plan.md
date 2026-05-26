# API Key Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化 Web API Key 配置，使它能清楚管理官方和第三方图像/视频 API Key、多实例自定义供应商、模型别名与模型 ID，并移除创建后的明文 Key 弹窗。

**Architecture:** 保留当前 `keys.json` 的核心模型：每个 Key 仍由 `alias` 唯一标识，`provider` 表示供应商类型，`models` 表示该 Key 可用模型列表。新增轻量 metadata 字段来承载供应商官网、API 文档/获取 Key 链接、能力类型和自定义备注的删除迁移；前端用 provider preset 渲染官方/第三方模板，自定义供应商通过不同 `alias` 支持多个实例。

**Tech Stack:** React + TypeScript + Vitest + Testing Library；FastAPI + Pydantic v2 + pytest；现有 `keys.json` 文件存储；现有 `PromptInput`/首页输入框视觉语言。

---

## Context

当前实现已经完成一版 Key 表单改造，但仍有四个偏差：

1. 自定义供应商仍显示“备注”，且官网链接被拼进 `notes`，后端没有结构化字段。
2. “模型”区域对用户没有直接写明“模型别名”和“模型 ID”的区别。
3. 官方 provider 的实例不可重复，因为官方 provider 的 `alias` 被固定为 provider 值；自定义虽然理论上可多实例，但 UI 没明确表达为“配置名称/实例名称”。
4. 创建成功后仍打开 `RevealModal` 展示“新 Key 已创建”，用户要求删除该弹窗，只保留创建成功提示。

参考项目 `/Users/zhengzhongbiao/Documents/GitHub/拆解项目/T8-penguin-canvas` 的有效经验：

- Key 类型按用途分组：通用 Key、图像系列 Key、视频系列 Key。
- 输入框要呈现“已保存但脱敏”的状态，不默认把 Key 当账号密码。
- 提供官网/获取 APIKey 入口，作为字段旁的实例内容，而不是隐藏在备注里。
- 分类独立 Key 可选，未填可以 fallback 到通用 Key。

本项目不直接照搬 T8 的 `zhenzhenApiKey/gptImageApiKey/...` 固定字段，因为当前 Studio 已经围绕 `alias + model` 工作，后端 caller 也按 `alias` 查 Key。更小的改法是增强现有 `KeySpec`。

## Success Criteria

- 官方和第三方 provider 列表覆盖主流图像/视频入口：Lovart、OpenAI、Volcengine Seedream、Midjourney、Nano Banana、Runway、Kling、Veo、Seedance、自定义。
- 自定义 provider 可创建多个实例，UI 文案明确为“配置名称”，而不是让用户误以为只能有一个“custom”。
- 表单不再出现“备注”；官网链接、API 文档/获取 Key 链接是结构化字段。
- API Key 和 API 请求地址使用与首页输入框一致的圆角、半透明、提示文案和示例内容，不呈现账号/密码登录表单感。
- 模型行明确显示“模型别名”和“模型 ID”，并给出真实示例。
- 创建成功后不再展示 `RevealModal` 或“新 Key 已创建”，只显示轻量成功提示并刷新列表。
- `web pnpm test`、`web pnpm lint`、Python 相关 key/caller 测试通过。

## Files

- Modify: `src/character_workflow/lib/keys.py`
  - Extend `KeySpec` with optional structured metadata: `homepage_url`, `docs_url`, `api_key_url`, `modalities`.
  - Keep `notes` readable for backward compatibility but stop using it in new UI.
- Modify: `src/viewer_server/routes.py`
  - Extend `_KeyCreatePayload` and `_KeyPatchPayload`.
  - Preserve old keys and return new metadata in `/api/keys`.
- Modify: `src/character_workflow/lib/callers/openai_image.py`
  - Keep existing OpenAI-compatible image behavior.
  - Add tests for base URL normalization; only update code if tests reveal a gap.
- Modify: `web/src/api/keys.ts`
  - Mirror new metadata types and provider preset types.
- Modify: `web/src/pages/settings/KeyForm.tsx`
  - Replace notes UI.
  - Add provider preset metadata, official/third-party/custom flows, model alias/ID labels, homepage/API URL examples, success callback changes.
- Modify: `web/src/pages/settings/Keys.tsx`
  - Replace reveal modal flow with success toast/status.
  - Keep onboarding completion behavior coherent without the reveal modal.
- Modify: `web/src/components/keys/KeyCard.tsx`
  - Show provider display name, modality badges, homepage/docs links when available, and model count.
- Modify: `web/src/pages/settings/Keys.test.tsx`
  - Cover new form and success behavior.
- Modify: `tests/test_keys.py`
  - Cover metadata persistence and string-model backward compatibility.
- Modify: `tests/test_keys_api.py`
  - Cover API create/list metadata, duplicate alias behavior, no raw secret on list.
- Modify: `tests/test_callers_dispatch.py`
  - Ensure existing dispatch still works for image providers.

## Provider Preset Contract

Use this front-end preset table as the source for UI defaults. Backend should not rely on it for correctness.

```ts
type ApiModality = 'image' | 'video' | 'audio' | 'llm';

interface ProviderPreset {
  value: string;
  label: string;
  kind: 'official' | 'third_party' | 'custom';
  modalities: ApiModality[];
  homepageUrl?: string;
  docsUrl?: string;
  apiKeyUrl?: string;
  defaultBaseUrl?: string | null;
  defaultModels: { name: string; id: string }[];
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    value: 'lovart',
    label: 'Lovart',
    kind: 'official',
    modalities: ['image', 'video', 'audio'],
    homepageUrl: 'https://www.lovart.ai',
    defaultBaseUrl: null,
    defaultModels: [{ name: 'GPT Image 2', id: 'gpt-image-2' }],
  },
  {
    value: 'openai',
    label: 'OpenAI',
    kind: 'official',
    modalities: ['image', 'llm'],
    homepageUrl: 'https://platform.openai.com',
    docsUrl: 'https://platform.openai.com/docs',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModels: [{ name: 'GPT Image 1', id: 'gpt-image-1' }],
  },
  {
    value: 'seedream',
    label: 'Volcengine Seedream',
    kind: 'third_party',
    modalities: ['image'],
    homepageUrl: 'https://www.volcengine.com',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModels: [{ name: '图片 5.0', id: 'doubao-seedream-5-0-260128' }],
  },
  {
    value: 'midjourney',
    label: 'Midjourney',
    kind: 'third_party',
    modalities: ['image'],
    homepageUrl: 'https://www.midjourney.com',
    defaultBaseUrl: null,
    defaultModels: [{ name: 'Midjourney', id: 'midjourney' }],
  },
  {
    value: 'nano_banana',
    label: 'Nano Banana',
    kind: 'third_party',
    modalities: ['image'],
    defaultBaseUrl: null,
    defaultModels: [{ name: 'Nano Banana', id: 'nano-banana' }],
  },
  {
    value: 'runway',
    label: 'Runway',
    kind: 'third_party',
    modalities: ['video'],
    homepageUrl: 'https://runwayml.com',
    defaultBaseUrl: null,
    defaultModels: [{ name: 'Runway Gen', id: 'runway-gen' }],
  },
  {
    value: 'kling',
    label: 'Kling',
    kind: 'third_party',
    modalities: ['video'],
    homepageUrl: 'https://klingai.com',
    defaultBaseUrl: null,
    defaultModels: [{ name: 'Kling Video', id: 'kling-video' }],
  },
  {
    value: 'veo',
    label: 'Google Veo',
    kind: 'third_party',
    modalities: ['video'],
    homepageUrl: 'https://deepmind.google/technologies/veo/',
    defaultBaseUrl: null,
    defaultModels: [{ name: 'Veo', id: 'veo' }],
  },
  {
    value: 'seedance',
    label: 'Seedance',
    kind: 'third_party',
    modalities: ['video'],
    homepageUrl: 'https://www.volcengine.com',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModels: [{ name: 'Seedance', id: 'doubao-seedance-1-0-pro' }],
  },
  {
    value: 'custom',
    label: '自定义',
    kind: 'custom',
    modalities: ['image'],
    defaultBaseUrl: '',
    defaultModels: [{ name: '', id: '' }],
  },
];
```

## Task 1: Backend Key Metadata

**Files:**
- Modify: `src/character_workflow/lib/keys.py`
- Modify: `src/viewer_server/routes.py`
- Test: `tests/test_keys.py`
- Test: `tests/test_keys_api.py`

- [ ] **Step 1: Write failing unit tests for metadata persistence**

Add this test to `tests/test_keys.py`:

```python
def test_key_spec_persists_provider_metadata(isolated_data_root):
    spec = keys.KeySpec(
        alias="seedream-main",
        provider="seedream",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        access_key="ark-secret",
        secret_key=None,
        capabilities=["portrait"],
        models=[{"name": "图片 5.0", "id": "doubao-seedream-5-0-260128"}],
        homepage_url="https://www.volcengine.com",
        docs_url="https://www.volcengine.com/docs",
        api_key_url="https://console.volcengine.com/ark",
        modalities=["image"],
        notes="legacy note",
        created_at="2026-05-26T18:30:00+08:00",
    )

    keys.add_key(spec)
    row = keys.find_by_alias("seedream-main")

    assert row is not None
    assert row.homepage_url == "https://www.volcengine.com"
    assert row.docs_url == "https://www.volcengine.com/docs"
    assert row.api_key_url == "https://console.volcengine.com/ark"
    assert row.modalities == ["image"]
    assert row.notes == "legacy note"
```

- [ ] **Step 2: Write failing API test for metadata create/list**

Add this test to `tests/test_keys_api.py`:

```python
def test_create_key_persists_provider_metadata(client):
    payload = _make_payload("seedream-main")
    payload.update({
        "provider": "seedream",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "access_key": "ark-secret",
        "secret_key": None,
        "homepage_url": "https://www.volcengine.com",
        "docs_url": "https://www.volcengine.com/docs",
        "api_key_url": "https://console.volcengine.com/ark",
        "modalities": ["image"],
        "notes": "",
    })

    r1 = client.post("/api/keys", json=payload)
    assert r1.status_code == 201, r1.text

    row = client.get("/api/keys").json()["keys"][0]
    assert row["homepage_url"] == "https://www.volcengine.com"
    assert row["docs_url"] == "https://www.volcengine.com/docs"
    assert row["api_key_url"] == "https://console.volcengine.com/ark"
    assert row["modalities"] == ["image"]
    assert row["notes"] == ""
    assert row["access_key"] != "ark-secret"
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
uv run pytest tests/test_keys.py::test_key_spec_persists_provider_metadata tests/test_keys_api.py::test_create_key_persists_provider_metadata -q
```

Expected: FAIL because `KeySpec` and API payload models do not define the new metadata fields.

- [ ] **Step 4: Extend backend models**

In `src/character_workflow/lib/keys.py`, update `KeySpec`:

```python
class KeySpec(BaseModel):
    alias: str
    provider: Provider
    base_url: str | None = None
    access_key: str
    secret_key: str | None = None
    capabilities: list[Kind] = Field(default_factory=list)
    models: list[ModelSpec] = Field(default_factory=list)
    homepage_url: str | None = None
    docs_url: str | None = None
    api_key_url: str | None = None
    modalities: list[str] = Field(default_factory=list)
    notes: str = ""
    created_at: str
```

In `src/viewer_server/routes.py`, update `_KeyCreatePayload`:

```python
class _KeyCreatePayload(BaseModel):
    alias: str
    provider: str
    base_url: str | None = None
    access_key: str
    secret_key: str | None = None
    capabilities: list[str] = []
    models: list[keys.ModelSpec] = []
    homepage_url: str | None = None
    docs_url: str | None = None
    api_key_url: str | None = None
    modalities: list[str] = []
    notes: str = ""
    created_at: str | None = None
```

Update `_KeyPatchPayload`:

```python
class _KeyPatchPayload(BaseModel):
    base_url: str | None = None
    access_key: str | None = None
    secret_key: str | None = None
    capabilities: list[str] | None = None
    models: list[keys.ModelSpec] | None = None
    homepage_url: str | None = None
    docs_url: str | None = None
    api_key_url: str | None = None
    modalities: list[str] | None = None
    notes: str | None = None
```

Update `create_key` construction:

```python
spec = keys.KeySpec(
    alias=payload.alias,
    provider=payload.provider,
    base_url=payload.base_url,
    access_key=payload.access_key,
    secret_key=payload.secret_key,
    capabilities=payload.capabilities,
    models=payload.models,
    homepage_url=payload.homepage_url,
    docs_url=payload.docs_url,
    api_key_url=payload.api_key_url,
    modalities=payload.modalities,
    notes=payload.notes,
    created_at=payload.created_at or datetime.now(timezone.utc).isoformat(),
)
```

- [ ] **Step 5: Run backend metadata tests**

Run:

```bash
uv run pytest tests/test_keys.py::test_key_spec_persists_provider_metadata tests/test_keys_api.py::test_create_key_persists_provider_metadata -q
```

Expected: PASS.

- [ ] **Step 6: Commit backend metadata**

Run:

```bash
git add -- src/character_workflow/lib/keys.py src/viewer_server/routes.py tests/test_keys.py tests/test_keys_api.py
git commit -m "Extend key provider metadata"
```

## Task 2: Frontend API Types and Provider Presets

**Files:**
- Modify: `web/src/api/keys.ts`
- Modify: `web/src/pages/settings/KeyForm.tsx`
- Test: `web/src/pages/settings/Keys.test.tsx`

- [ ] **Step 1: Write failing test for provider choices and custom multiple instances**

Add this test to `web/src/pages/settings/Keys.test.tsx` under `describe('KeyForm', ...)`:

```tsx
it('labels custom provider as a named configuration that supports multiple instances', () => {
  render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);

  fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'custom' } });

  expect(screen.getByLabelText('配置名称')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('例如：openrouter-image-main')).toBeInTheDocument();
  expect(screen.queryByLabelText('备注')).not.toBeInTheDocument();
  expect(screen.getByText('自定义供应商可以创建多个配置，请用不同配置名称区分额度、用途或上游。')).toBeInTheDocument();
});
```

- [ ] **Step 2: Write failing test for official provider metadata payload**

Add this test:

```tsx
it('creates a third-party image provider with structured metadata', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => ({ secret_revealed: 'ark-test' }),
  });
  globalThis.fetch = fetchMock as any;

  render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'seedream' } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'ark-test' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body).toMatchObject({
    alias: 'seedream',
    provider: 'seedream',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    access_key: 'ark-test',
    homepage_url: 'https://www.volcengine.com',
    modalities: ['image'],
    notes: '',
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
cd web && pnpm test -- KeyForm
```

Expected: FAIL because `KeyForm` still uses `供应商名称`/`备注` and does not submit structured metadata.

- [ ] **Step 4: Extend frontend API types**

In `web/src/api/keys.ts`, update types:

```ts
export type ApiModality = 'image' | 'video' | 'audio' | 'llm' | string;

export interface KeyView {
  alias: string;
  provider: string;
  base_url: string | null;
  access_key: string;
  secret_key: null;
  capabilities: string[];
  models: KeyModel[];
  homepage_url?: string | null;
  docs_url?: string | null;
  api_key_url?: string | null;
  modalities?: ApiModality[];
  notes: string;
  created_at: string;
  is_default: boolean;
}

export interface KeyCreatePayload {
  alias: string;
  provider: string;
  base_url?: string | null;
  access_key: string;
  secret_key?: string | null;
  capabilities: string[];
  models?: KeyModel[];
  homepage_url?: string | null;
  docs_url?: string | null;
  api_key_url?: string | null;
  modalities?: ApiModality[];
  notes?: string;
}
```

- [ ] **Step 5: Add provider preset table inside `KeyForm.tsx`**

Replace the current `PROVIDERS` and `DEFAULT_MODELS` with this compact preset structure:

```tsx
type ProviderKind = 'official' | 'third_party' | 'custom';
type ApiModality = 'image' | 'video' | 'audio' | 'llm';

interface ProviderPreset {
  value: string;
  label: string;
  kind: ProviderKind;
  modalities: ApiModality[];
  homepageUrl?: string;
  docsUrl?: string;
  apiKeyUrl?: string;
  defaultBaseUrl?: string | null;
  defaultModels: KeyModel[];
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { value: 'lovart', label: 'Lovart', kind: 'official', modalities: ['image', 'video', 'audio'], homepageUrl: 'https://www.lovart.ai', defaultBaseUrl: null, defaultModels: [{ name: 'GPT Image 2', id: 'gpt-image-2' }] },
  { value: 'openai', label: 'OpenAI', kind: 'official', modalities: ['image', 'llm'], homepageUrl: 'https://platform.openai.com', docsUrl: 'https://platform.openai.com/docs', apiKeyUrl: 'https://platform.openai.com/api-keys', defaultBaseUrl: 'https://api.openai.com/v1', defaultModels: [{ name: 'GPT Image 1', id: 'gpt-image-1' }] },
  { value: 'seedream', label: 'Volcengine Seedream', kind: 'third_party', modalities: ['image'], homepageUrl: 'https://www.volcengine.com', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModels: [{ name: '图片 5.0', id: 'doubao-seedream-5-0-260128' }] },
  { value: 'midjourney', label: 'Midjourney', kind: 'third_party', modalities: ['image'], homepageUrl: 'https://www.midjourney.com', defaultBaseUrl: null, defaultModels: [{ name: 'Midjourney', id: 'midjourney' }] },
  { value: 'nano_banana', label: 'Nano Banana', kind: 'third_party', modalities: ['image'], defaultBaseUrl: null, defaultModels: [{ name: 'Nano Banana', id: 'nano-banana' }] },
  { value: 'runway', label: 'Runway', kind: 'third_party', modalities: ['video'], homepageUrl: 'https://runwayml.com', defaultBaseUrl: null, defaultModels: [{ name: 'Runway Gen', id: 'runway-gen' }] },
  { value: 'kling', label: 'Kling', kind: 'third_party', modalities: ['video'], homepageUrl: 'https://klingai.com', defaultBaseUrl: null, defaultModels: [{ name: 'Kling Video', id: 'kling-video' }] },
  { value: 'veo', label: 'Google Veo', kind: 'third_party', modalities: ['video'], homepageUrl: 'https://deepmind.google/technologies/veo/', defaultBaseUrl: null, defaultModels: [{ name: 'Veo', id: 'veo' }] },
  { value: 'seedance', label: 'Seedance', kind: 'third_party', modalities: ['video'], homepageUrl: 'https://www.volcengine.com', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModels: [{ name: 'Seedance', id: 'doubao-seedance-1-0-pro' }] },
  { value: 'custom', label: '自定义', kind: 'custom', modalities: ['image'], defaultBaseUrl: '', defaultModels: [{ name: '', id: '' }] },
];

const providerByValue = (value: string) =>
  PROVIDER_PRESETS.find((preset) => preset.value === value) ?? PROVIDER_PRESETS[0];
```

- [ ] **Step 6: Update provider switching and submit payload**

In `KeyForm.tsx`, make provider switch set base URL and models from preset:

```tsx
const changeProvider = (nextProvider: string) => {
  const preset = providerByValue(nextProvider);
  setProvider(nextProvider);
  setAlias(nextProvider === 'custom' ? '' : nextProvider);
  setBaseUrl(preset.defaultBaseUrl ?? '');
  setHomepage(preset.homepageUrl ?? '');
  setModels(preset.defaultModels);
  setUrlTest(null);
};
```

In `submit`, build payload with structured metadata:

```tsx
const preset = providerByValue(provider);
const result = await createKey({
  alias: provider === 'custom' ? alias.trim() : provider,
  provider,
  base_url: baseUrl.trim() || null,
  access_key: accessKey.trim(),
  secret_key: null,
  capabilities: ['portrait', 'promo', 'turnaround'],
  models: models
    .map((model) => ({ name: model.name.trim(), id: model.id.trim() }))
    .filter((model) => model.name && model.id),
  homepage_url: homepage.trim() || preset.homepageUrl || null,
  docs_url: preset.docsUrl ?? null,
  api_key_url: preset.apiKeyUrl ?? null,
  modalities: preset.modalities,
  notes: '',
});
onCreated(result.secret_revealed);
```

- [ ] **Step 7: Run frontend form tests**

Run:

```bash
cd web && pnpm test -- KeyForm
```

Expected: PASS.

- [ ] **Step 8: Commit frontend types and presets**

Run:

```bash
git add -- web/src/api/keys.ts web/src/pages/settings/KeyForm.tsx web/src/pages/settings/Keys.test.tsx
git commit -m "Add provider presets to key form"
```

## Task 3: Key Form UI Copy and Input Styling

**Files:**
- Modify: `web/src/pages/settings/KeyForm.tsx`
- Test: `web/src/pages/settings/Keys.test.tsx`

- [ ] **Step 1: Write failing test for model alias and model ID visible labels**

Add this test:

```tsx
it('visibly distinguishes model alias from model id', () => {
  render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);

  expect(screen.getByText('模型别名')).toBeInTheDocument();
  expect(screen.getByText('模型 ID')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('给人看的名字，例如：图片 5.0')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('请求里使用的 ID，例如：doubao-seedream-5-0-260128')).toBeInTheDocument();
});
```

- [ ] **Step 2: Write failing test for API URL example content**

Add this test:

```tsx
it('shows API request URL examples instead of account-password style copy', () => {
  render(<KeyForm onCreated={() => {}} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'custom' } });

  expect(screen.getByLabelText('API 请求地址')).toHaveAttribute(
    'placeholder',
    '例如：https://api.example.com/v1 或 https://ark.cn-beijing.volces.com/api/v3',
  );
  expect(screen.getByText('请求时会自动拼接 /images/generations；如果你填的是完整路径，也会直接使用。')).toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
cd web && pnpm test -- KeyForm
```

Expected: FAIL because the visible model column labels and new URL help text are absent.

- [ ] **Step 4: Update form labels and helper text**

In `KeyForm.tsx`, replace custom provider label:

```tsx
<label htmlFor="key-provider-name" className="block text-sm mb-2 text-muted-foreground">配置名称</label>
<input
  id="key-provider-name"
  value={alias}
  onChange={e => setAlias(e.target.value)}
  className={fieldClass}
  placeholder="例如：openrouter-image-main"
/>
<p className="mt-2 text-xs text-muted-foreground">
  自定义供应商可以创建多个配置，请用不同配置名称区分额度、用途或上游。
</p>
```

Remove the entire `key-notes` textarea block.

Update homepage label helper:

```tsx
<label htmlFor="key-homepage" className="block text-sm mb-2 text-muted-foreground">官网链接</label>
<input
  id="key-homepage"
  value={homepage}
  onChange={e => setHomepage(e.target.value)}
  className={fieldClass}
  placeholder="例如：https://platform.openai.com"
  autoComplete="off"
/>
```

Update API URL placeholder and helper:

```tsx
<input
  id="key-base-url"
  value={baseUrl}
  onChange={e => {
    setBaseUrl(e.target.value);
    setUrlTest(null);
  }}
  className={fieldClass}
  placeholder="例如：https://api.example.com/v1 或 https://ark.cn-beijing.volces.com/api/v3"
  autoComplete="off"
/>
<p className="mt-2 text-xs text-muted-foreground">
  请求时会自动拼接 /images/generations；如果你填的是完整路径，也会直接使用。
</p>
```

Update model section header:

```tsx
<div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs text-muted-foreground mb-2">
  <span>模型别名</span>
  <span>模型 ID</span>
  <span className="sr-only">操作</span>
</div>
```

Update model placeholders:

```tsx
placeholder="给人看的名字，例如：图片 5.0"
placeholder="请求里使用的 ID，例如：doubao-seedream-5-0-260128"
```

- [ ] **Step 5: Keep homepage input visual language aligned with homepage prompt**

Use the existing `fieldClass`, but adjust it once to be closer to `PromptInput`:

```tsx
const fieldClass = 'w-full rounded-2xl border border-input/70 bg-background/35 px-4 py-3 text-sm text-foreground shadow-inner shadow-black/5 placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/50';
```

For API Key input, use the same class and explicit API-key placeholder:

```tsx
<input
  id="key-access"
  type="password"
  value={accessKey}
  onChange={e => setAccessKey(e.target.value)}
  className={`${fieldClass} font-mono`}
  placeholder="粘贴 API Key，例如 sk-..."
  autoComplete="off"
/>
```

- [ ] **Step 6: Run frontend tests**

Run:

```bash
cd web && pnpm test -- KeyForm
```

Expected: PASS.

- [ ] **Step 7: Commit form copy and styling**

Run:

```bash
git add -- web/src/pages/settings/KeyForm.tsx web/src/pages/settings/Keys.test.tsx
git commit -m "Clarify key form model fields"
```

## Task 4: Remove Reveal Modal After Key Creation

**Files:**
- Modify: `web/src/pages/settings/Keys.tsx`
- Modify: `web/src/pages/settings/Keys.test.tsx`

- [ ] **Step 1: Write failing test for success-only creation feedback**

Add this test under `describe('KeysPage', ...)`:

```tsx
it('shows success feedback without revealing the created key', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ keys: [], default_alias: null }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ secret_revealed: 'sk-created-secret' }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        keys: [{ ...mockKey, alias: 'seedream', provider: 'seedream', access_key: 'sk...ret' }],
        default_alias: null,
      }),
    });
  globalThis.fetch = fetchMock as any;

  render(<KeysPage />);

  await waitFor(() => expect(screen.getByText(/还没有 API Key/)).toBeInTheDocument());
  fireEvent.click(screen.getAllByText('+ 新建 Key')[0]);
  fireEvent.change(screen.getByLabelText('供应商选择'), { target: { value: 'seedream' } });
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-created-secret' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(screen.getByText('创建成功')).toBeInTheDocument());
  expect(screen.queryByText('新 Key 已创建')).not.toBeInTheDocument();
  expect(screen.queryByText('sk-created-secret')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd web && pnpm test -- KeysPage
```

Expected: FAIL because `KeysPage` currently opens `RevealModal`.

- [ ] **Step 3: Replace reveal state with success message**

In `web/src/pages/settings/Keys.tsx`, remove:

```tsx
import { RevealModal } from '@/components/keys/RevealModal';
```

Replace state:

```tsx
const [revealSecret, setRevealSecret] = useState<string | null>(null);
```

with:

```tsx
const [successMessage, setSuccessMessage] = useState<string | null>(null);
```

Replace `onCreated`:

```tsx
const onCreated = () => {
  setShowForm(false);
  setSuccessMessage('创建成功');
  void refresh();
  if (mode === 'onboarding' && onComplete) onComplete();
};
```

Add success UI near the error block:

```tsx
{successMessage && (
  <div className="mb-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700">
    {successMessage}
  </div>
)}
```

Remove the entire `revealSecret && <RevealModal ... />` block.

Keep the `KeyForm` prop unchanged because it currently calls `onCreated(secret)`. TypeScript allows the parent callback to ignore the argument:

```tsx
<KeyForm
  onCreated={onCreated}
  onCancel={() => setShowForm(false)}
  submitLabel={mode === 'onboarding' ? '保存并开始工作' : '保存'}
/>
```

- [ ] **Step 4: Run frontend tests**

Run:

```bash
cd web && pnpm test -- KeysPage
```

Expected: PASS.

- [ ] **Step 5: Commit reveal removal**

Run:

```bash
git add -- web/src/pages/settings/Keys.tsx web/src/pages/settings/Keys.test.tsx
git commit -m "Use success toast for key creation"
```

## Task 5: Key Card Metadata Display

**Files:**
- Modify: `web/src/components/keys/KeyCard.tsx`
- Modify: `web/src/pages/settings/Keys.tsx`
- Test: `web/src/pages/settings/Keys.test.tsx`

- [ ] **Step 1: Write failing test for metadata display**

Add this test under `describe('KeysPage', ...)`:

```tsx
it('shows key provider metadata and model count on key cards', async () => {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      keys: [{
        ...mockKey,
        alias: 'seedream-main',
        provider: 'seedream',
        homepage_url: 'https://www.volcengine.com',
        docs_url: 'https://www.volcengine.com/docs',
        modalities: ['image'],
        models: [{ name: '图片 5.0', id: 'doubao-seedream-5-0-260128' }],
      }],
      default_alias: null,
    }),
  });

  render(<KeysPage />);

  await waitFor(() => expect(screen.getByText('seedream-main')).toBeInTheDocument());
  expect(screen.getByText('image')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '官网' })).toHaveAttribute('href', 'https://www.volcengine.com');
  expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute('href', 'https://www.volcengine.com/docs');
  expect(screen.getByText('1 个模型')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd web && pnpm test -- KeysPage
```

Expected: FAIL because `KeyCard` does not receive or render metadata.

- [ ] **Step 3: Extend `KeyRow` and mapping**

In `web/src/components/keys/KeyCard.tsx`, update interface:

```tsx
export interface KeyRow {
  alias: string;
  provider: string;
  masked_secret: string;
  models?: { name: string; id: string }[];
  homepage_url?: string | null;
  docs_url?: string | null;
  api_key_url?: string | null;
  modalities?: string[];
  is_default: boolean;
  last_used_at?: string | null;
  created_at?: string | null;
}
```

In `web/src/pages/settings/Keys.tsx`, update `toKeyRow` input and return:

```tsx
function toKeyRow(defaultAlias: string | null) {
  return (k: {
    alias: string;
    provider: string;
    access_key: string;
    models?: { name: string; id: string }[];
    homepage_url?: string | null;
    docs_url?: string | null;
    api_key_url?: string | null;
    modalities?: string[];
    is_default?: boolean;
    last_used_at?: string | null;
    created_at?: string | null;
  }): KeyRow => ({
    alias: k.alias,
    provider: k.provider,
    masked_secret: k.access_key ?? '****',
    models: k.models ?? [],
    homepage_url: k.homepage_url ?? null,
    docs_url: k.docs_url ?? null,
    api_key_url: k.api_key_url ?? null,
    modalities: k.modalities ?? [],
    is_default: k.alias === defaultAlias,
    last_used_at: k.last_used_at ?? null,
    created_at: k.created_at ?? null,
  });
}
```

- [ ] **Step 4: Render metadata in `KeyCard`**

Add this below the masked secret:

```tsx
{row.modalities && row.modalities.length > 0 && (
  <div className="flex flex-wrap gap-1">
    {row.modalities.map((modality) => (
      <span
        key={modality}
        className="rounded-full border border-border bg-background/40 px-2 py-0.5 text-[11px] text-muted-foreground"
      >
        {modality}
      </span>
    ))}
  </div>
)}
{(row.homepage_url || row.docs_url || row.api_key_url) && (
  <div className="flex flex-wrap gap-3 text-xs">
    {row.homepage_url && (
      <a className="text-muted-foreground hover:text-primary" href={row.homepage_url} target="_blank" rel="noreferrer">官网</a>
    )}
    {row.docs_url && (
      <a className="text-muted-foreground hover:text-primary" href={row.docs_url} target="_blank" rel="noreferrer">文档</a>
    )}
    {row.api_key_url && (
      <a className="text-muted-foreground hover:text-primary" href={row.api_key_url} target="_blank" rel="noreferrer">获取 Key</a>
    )}
  </div>
)}
```

- [ ] **Step 5: Run frontend tests**

Run:

```bash
cd web && pnpm test -- KeysPage
```

Expected: PASS.

- [ ] **Step 6: Commit key card metadata**

Run:

```bash
git add -- web/src/components/keys/KeyCard.tsx web/src/pages/settings/Keys.tsx web/src/pages/settings/Keys.test.tsx
git commit -m "Show provider metadata on key cards"
```

## Task 6: Compatibility Verification for Image and Video Providers

**Files:**
- Modify: `tests/test_callers_dispatch.py`
- Modify: `tests/test_studio_jobs.py`
- Modify only if needed: `src/character_workflow/lib/callers/__init__.py`
- Modify only if needed: `src/character_workflow/lib/studio_jobs.py`

- [ ] **Step 1: Add dispatch regression for new provider values**

Add this to `tests/test_callers_dispatch.py`:

```python
def test_video_provider_keys_can_be_stored_without_dispatch_regression(isolated_data_root):
    for provider in ["runway", "kling", "veo", "seedance"]:
        spec = KeySpec(
            alias=f"{provider}-main",
            provider=provider,
            base_url=None,
            access_key="video-secret",
            secret_key=None,
            capabilities=["promo"],
            models=[{"name": provider.title(), "id": provider}],
            modalities=["video"],
            notes="",
            created_at="2026-05-26T18:30:00Z",
        )
        keys.add_key(spec)

    assert keys.find_by_alias("runway-main").modalities == ["video"]
    assert keys.find_by_alias("kling-main").models[0].id == "kling"
```

- [ ] **Step 2: Run test to verify expected behavior**

Run:

```bash
uv run pytest tests/test_callers_dispatch.py::test_video_provider_keys_can_be_stored_without_dispatch_regression -q
```

Expected before Task 1 provider widening: FAIL if backend `Provider` literal rejects new values. Expected after widening provider support: PASS.

- [ ] **Step 3: Widen backend provider type if needed**

If Step 2 fails because `Provider` rejects video provider strings, update `src/character_workflow/lib/keys.py`:

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
]
```

Do not implement video caller dispatch in this task. The requirement here is API Key format compatibility, not video generation execution.

- [ ] **Step 4: Run relevant backend tests**

Run:

```bash
uv run pytest tests/test_keys.py tests/test_keys_api.py tests/test_callers_dispatch.py tests/test_studio_jobs.py -q
```

Expected: PASS for relevant tests. Existing full-suite unrelated failures should be documented if they appear outside these files.

- [ ] **Step 5: Commit provider compatibility**

Run:

```bash
git add -- src/character_workflow/lib/keys.py tests/test_callers_dispatch.py tests/test_studio_jobs.py
git commit -m "Allow video provider key records"
```

## Task 7: Final Verification

**Files:**
- No code changes unless verification reveals defects.

- [ ] **Step 1: Run frontend tests**

Run:

```bash
cd web && pnpm test
```

Expected: all frontend tests pass. Existing React `act(...)` warnings may remain if they are the known baseline.

- [ ] **Step 2: Run frontend lint**

Run:

```bash
cd web && pnpm lint
```

Expected: PASS.

- [ ] **Step 3: Run backend focused tests**

Run:

```bash
uv run pytest tests/test_keys.py tests/test_keys_api.py tests/test_callers_dispatch.py tests/test_studio_jobs.py tests/test_turn_start_keys.py -q
```

Expected: PASS.

- [ ] **Step 4: Check whitespace and dirty files**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` has no output. `git status --short` shows only files changed by this plan plus pre-existing unrelated dirty files.

- [ ] **Step 5: Commit final fixes if any**

Only if Step 1-4 required small fixes:

```bash
git add -- <exact files changed by final fixes>
git commit -m "Stabilize api key optimization"
```

## Non-Goals

- Do not add real remote API probing for every provider in this plan. That needs provider-specific endpoints, network access, timeout handling, and quota/error messaging.
- Do not migrate existing `keys.json` into T8-style fixed fields. Current `alias + provider + model` architecture is already used by Studio.
- Do not implement video generation callers in this plan. The key record can store video providers now; execution support should be a separate provider-caller plan.
- Do not remove `notes` from backend storage yet. Keep it for backward compatibility, but stop exposing it in the new form.

## Self-Review

- Spec coverage:
  - 主流图像/视频 API Key 格式：Task 2 provider presets + Task 6 provider widening.
  - 官方和第三方：Task 2.
  - 参考 T8：Context and provider metadata decisions.
  - 模型 ID/别名不清楚：Task 3.
  - 自定义可添加多个：Task 2/3 uses unique `alias` as 配置名称.
  - API 请求地址和 API Key 样式：Task 3.
  - 官网链接样式实例内容：Task 2/3 structured homepage/docs/api key URLs.
  - 去掉供应商备注：Task 3 removes notes textarea; Task 2 submits `notes: ''`.
  - 删除“新 Key 已创建”：Task 4 removes `RevealModal`.
- Placeholder scan: no `TBD`, no unspecified test steps, no “implement later”.
- Type consistency: metadata fields use snake_case across backend JSON and frontend API types; preset internals use camelCase and are mapped during submit.
