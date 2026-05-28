# Web UI Cleanup & Provider Key Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除示例 Chips、升级尺寸选择面板样式、清理供应商列表仅保留图像类、新增火山引擎 API Key 并验证出图。

**Architecture:** 纯前端修改（React/TSX），无 schema 变更，无后端改动。T4 通过调用已有 `/api/keys` 和 `/api/studio/jobs` REST 端点完成 Key 创建和出图测试。

**Tech Stack:** React 18.3 · TypeScript 5.6 · Tailwind v4 · Vitest 2 · pnpm

---

## 文件地图

| 操作 | 路径 | 说明 |
|---|---|---|
| 修改 | `web/src/pages/Studio.tsx` | 删除 InspirationChips 引用、seedText 状态 |
| 删除 | `web/src/components/studio/InspirationChips.tsx` | 整个文件删除 |
| 修改 | `web/src/pages/Studio.test.tsx` | 更新 chips 相关测试断言 |
| 修改 | `web/src/components/studio/PromptInput.tsx` | 面板样式升级、添加 RatioIcon + 尺寸区、删除 ✦ |
| 修改 | `web/src/pages/settings/KeyForm.tsx` | 清理供应商列表、重命名 Seedream → 火山引擎 |

---

## Task 1: 删除示例 Chips（InspirationChips）

**Files:**
- Modify: `web/src/pages/Studio.tsx`
- Delete: `web/src/components/studio/InspirationChips.tsx`
- Modify: `web/src/pages/Studio.test.tsx`

- [ ] **Step 1: 修改 Studio.tsx — 删除 InspirationChips 导入和 seedText 状态**

将 `web/src/pages/Studio.tsx` 顶部替换：

```tsx
// 删除这一行：
import { InspirationChips } from '@/components/studio/InspirationChips';
```

将以下 state 声明删除：
```tsx
// 删除这一行：
const [seedText, setSeedText] = useState('');
```

- [ ] **Step 2: 修改 Studio.tsx — compact 模式删除 chips**

将 compact 模式的 JSX（当前第 84-107 行）替换：

```tsx
// 旧代码（compact 模式）：
if (compact) {
  return (
    <div className="py-8" aria-label="生图沙箱">
      <h1 className="text-xl sm:text-2xl leading-tight mb-6 sm:mb-8 max-w-[780px] mx-auto font-semibold">
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
```

```tsx
// 新代码（compact 模式）：
if (compact) {
  return (
    <div className="py-8" aria-label="生图沙箱">
      <h1 className="text-xl sm:text-2xl leading-tight mb-6 sm:mb-8 max-w-[780px] mx-auto font-semibold">
        描述你想生成的图片
      </h1>
      <PromptInput
        onSubmit={onSubmit}
        disabled={pending}
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
      <RoundList rounds={rounds} />
    </div>
  );
}
```

- [ ] **Step 3: 修改 Studio.tsx — 非 compact 模式删除 chips**

将非 compact 模式 feed 区域（当前第 115-123 行）替换：

```tsx
// 旧代码：
<div className="flex-1 min-h-0 overflow-y-auto py-6">
  {rounds.length === 0 ? (
    <div className="flex h-full items-center justify-center">
      <InspirationChips onPick={(t) => setSeedText(t)} />
    </div>
  ) : (
    <RoundList rounds={rounds} />
  )}
</div>
```

```tsx
// 新代码：
<div className="flex-1 min-h-0 overflow-y-auto py-6">
  <RoundList rounds={rounds} />
</div>
```

- [ ] **Step 4: 删除 InspirationChips.tsx 文件**

```bash
rm web/src/components/studio/InspirationChips.tsx
```

- [ ] **Step 5: 更新 Studio.test.tsx — 替换 chips 断言**

将 Studio.test.tsx 第 68-71 行的测试替换：

```tsx
// 旧测试：
it('shows inspiration chips when no rounds', () => {
  renderStudio();
  expect(screen.getByText(/soft cotton low-angle/)).toBeInTheDocument();
});
```

```tsx
// 新测试：
it('shows no example prompt chips when no rounds', () => {
  renderStudio();
  expect(screen.queryByText(/试试/)).not.toBeInTheDocument();
  expect(screen.queryByText(/soft cotton low-angle/)).not.toBeInTheDocument();
});
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow/web
pnpm test
```

期望：所有测试通过（6 个 Studio 测试 + Keys 测试全通过），无 TypeScript 错误。

```bash
pnpm lint
```

期望：tsc 退出码 0。

- [ ] **Step 7: Commit**

```bash
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow
git add web/src/pages/Studio.tsx web/src/components/studio/InspirationChips.tsx web/src/pages/Studio.test.tsx
git commit -m "studio: remove inspiration example chips"
```

---

## Task 2: 升级尺寸选择面板样式

面板新增：比例图标（SVG）、尺寸（W/H 像素）显示；删除 ✦ 符号。

**Files:**
- Modify: `web/src/components/studio/PromptInput.tsx`

- [ ] **Step 1: 更新 lucide-react 导入，添加 Link2**

将第 2 行：
```tsx
import { ArrowUp, Box, ImageIcon, Square, Building2 } from 'lucide-react';
```
替换为：
```tsx
import { ArrowUp, Box, ImageIcon, Square, Building2, Link2 } from 'lucide-react';
```

- [ ] **Step 2: 在文件末尾（ControlButton 之后）添加 RatioIcon 组件和 computePixelSize 辅助函数**

在文件末尾追加（在 `ControlButton` 函数后）：

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
  const [a, b] = ratio.split(':').map(Number);
  let w: number, h: number;
  if (a >= b) {
    w = box;
    h = Math.max(Math.round((b / a) * box), 4);
  } else {
    h = box;
    w = Math.max(Math.round((a / b) * box), 4);
  }
  const x = (box - w) / 2;
  const y = (box - h) / 2;
  return (
    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} fill="none">
      <rect x={x} y={y} width={w} height={h} rx="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function computePixelSize(ratio: string, resolution: '2K' | '4K'): { w: number; h: number } {
  const base = resolution === '4K' ? 4096 : 2048;
  if (ratio === '智能' || ratio === '1:1') return { w: base, h: base };
  const [a, b] = ratio.split(':').map(Number);
  if (a >= b) return { w: base, h: Math.round((b / a) * base) };
  return { w: Math.round((a / b) * base), h: base };
}
```

- [ ] **Step 3: 替换 openPanel === 'size' 的完整 JSX**

找到当前的 size panel（第 157-194 行）：

```tsx
      {openPanel === 'size' && (
        <div className="absolute left-0 sm:left-96 right-0 sm:right-8 top-full z-20 mt-3 rounded-2xl border border-border bg-popover p-8 shadow-2xl space-y-8">
          <section>
            <div className="mb-3 text-sm text-muted-foreground">选择比例</div>
            <div role="listbox" aria-label="选择比例" className="grid grid-cols-9 gap-1 rounded-2xl bg-secondary p-2">
              {RATIOS.map((item) => (
                <button
                  key={item}
                  type="button"
                  role="option"
                  aria-selected={ratio === item}
                  onClick={() => onRatioChange?.(item === '智能' ? '1:1' : item)}
                  className="rounded-lg px-2 py-3 text-center hover:bg-card aria-selected:bg-card"
                >
                  {item}
                </button>
              ))}
            </div>
          </section>
          <section>
            <div className="mb-3 text-sm text-muted-foreground">选择分辨率</div>
            <div role="listbox" aria-label="选择分辨率" className="grid grid-cols-2 gap-1 rounded-2xl bg-secondary p-1">
              {(['2K', '4K'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="option"
                  aria-selected={resolution === item}
                  onClick={() => onResolutionChange?.(item)}
                  className="rounded-lg px-4 py-4 text-lg hover:bg-card aria-selected:bg-card"
                >
                  {item === '2K' ? '高清 2K' : '超清 4K ✦'}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
```

替换为：

```tsx
      {openPanel === 'size' && (
        <div className="absolute left-0 sm:left-96 right-0 sm:right-8 top-full z-20 mt-3 rounded-2xl border border-border bg-popover shadow-2xl">
          <div className="p-6 space-y-6">
            <section>
              <div className="mb-3 text-sm text-muted-foreground">选择比例</div>
              <div role="listbox" aria-label="选择比例" className="grid grid-cols-9 gap-1 rounded-2xl bg-secondary p-2">
                {RATIOS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="option"
                    aria-selected={ratio === item || (item === '智能' && ratio === '1:1')}
                    onClick={() => onRatioChange?.(item === '智能' ? '1:1' : item)}
                    className="flex flex-col items-center gap-1.5 rounded-lg px-1 py-3 hover:bg-card aria-selected:bg-card transition-colors"
                  >
                    <RatioIcon ratio={item} />
                    <span className="text-xs">{item}</span>
                  </button>
                ))}
              </div>
            </section>
            <section>
              <div className="mb-3 text-sm text-muted-foreground">选择分辨率</div>
              <div role="listbox" aria-label="选择分辨率" className="grid grid-cols-2 gap-2 rounded-2xl bg-secondary p-2">
                {(['2K', '4K'] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="option"
                    aria-selected={resolution === item}
                    onClick={() => onResolutionChange?.(item)}
                    className="rounded-xl py-4 text-center text-base hover:bg-card aria-selected:bg-card transition-colors"
                  >
                    {item === '2K' ? '高清 2K' : '超清 4K'}
                  </button>
                ))}
              </div>
            </section>
            <section>
              <div className="mb-3 text-sm text-muted-foreground">尺寸</div>
              <div className="flex items-center gap-3">
                <div className="flex flex-1 items-center gap-3 rounded-xl bg-secondary px-4 py-3">
                  <span className="text-sm font-medium text-muted-foreground">W</span>
                  <span className="flex-1 text-center text-sm tabular-nums">{computePixelSize(ratio, resolution).w}</span>
                </div>
                <Link2 size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                <div className="flex flex-1 items-center gap-3 rounded-xl bg-secondary px-4 py-3">
                  <span className="text-sm font-medium text-muted-foreground">H</span>
                  <span className="flex-1 text-center text-sm tabular-nums">{computePixelSize(ratio, resolution).h}</span>
                </div>
                <span className="shrink-0 text-sm text-muted-foreground">PX</span>
              </div>
            </section>
          </div>
        </div>
      )}
```

- [ ] **Step 4: 更新底部控制按钮的分辨率显示（去掉高清/超清不一致）**

找到底部 ControlButton（当前第 90-96 行）：

```tsx
          <ControlButton
            aria-label="选择比例和分辨率"
            onClick={() => setOpenPanel(openPanel === 'size' ? null : 'size')}
          >
            <Square size={14} aria-hidden /> {ratio} <span className="text-muted-foreground">|</span> 高清 {resolution}
          </ControlButton>
```

替换为：

```tsx
          <ControlButton
            aria-label="选择比例和分辨率"
            onClick={() => setOpenPanel(openPanel === 'size' ? null : 'size')}
          >
            <Square size={14} aria-hidden /> {ratio} <span className="text-muted-foreground">|</span> {resolution === '2K' ? '高清 2K' : '超清 4K'}
          </ControlButton>
```

- [ ] **Step 5: 运行测试和类型检查**

```bash
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow/web
pnpm test
```

期望：所有测试通过。Studio.test.tsx 第 146 行 `getByRole('option', { name: /超清 4K/ })` 应匹配到 "超清 4K"（不含 ✦）。

```bash
pnpm lint
```

期望：tsc 退出码 0（Link2 import 有效，RatioIcon/computePixelSize 类型安全）。

- [ ] **Step 6: Commit**

```bash
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow
git add web/src/components/studio/PromptInput.tsx
git commit -m "studio: refresh size panel with ratio icons and pixel display"
```

---

## Task 3: 清理供应商列表（仅保留图像类）

**Files:**
- Modify: `web/src/pages/settings/KeyForm.tsx`

- [ ] **Step 1: 替换 PROVIDER_PRESETS 数组**

找到当前第 19-30 行的整个 `PROVIDER_PRESETS` 数组：

```tsx
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
```

替换为：

```tsx
const PROVIDER_PRESETS: ProviderPreset[] = [
  { value: 'openai', label: 'OpenAI', kind: 'official', modalities: ['image'], homepageUrl: 'https://platform.openai.com', docsUrl: 'https://platform.openai.com/docs', apiKeyUrl: 'https://platform.openai.com/api-keys', defaultBaseUrl: 'https://api.openai.com/v1', defaultModels: [{ name: 'GPT Image 1', id: 'gpt-image-1' }] },
  { value: 'seedream', label: '火山引擎', kind: 'third_party', modalities: ['image'], homepageUrl: 'https://www.volcengine.com', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModels: [{ name: '图片 5.0', id: 'doubao-seedream-5-0-260128' }] },
  { value: 'midjourney', label: 'Midjourney', kind: 'third_party', modalities: ['image'], homepageUrl: 'https://www.midjourney.com', defaultBaseUrl: null, defaultModels: [{ name: 'Midjourney', id: 'midjourney' }] },
  { value: 'nano_banana', label: 'Nano Banana', kind: 'third_party', modalities: ['image'], defaultBaseUrl: null, defaultModels: [{ name: 'Nano Banana', id: 'nano-banana' }] },
  { value: 'custom', label: '自定义', kind: 'custom', modalities: ['image'], defaultBaseUrl: '', defaultModels: [{ name: '', id: '' }] },
];
```

> 说明：
> - 删除：lovart、runway、kling、veo、seedance（均为视频或官方内部）
> - 保留：openai、seedream（重命名为火山引擎）、midjourney、nano_banana、custom
> - `value: 'seedream'` 保持不变（测试和现有数据依赖此值）

- [ ] **Step 2: 更新 KeyForm useState 初始默认值（从 lovart 改为 openai）**

找到当前第 46-51 行：

```tsx
  const [alias, setAlias] = useState(initial?.alias ?? initial?.provider ?? 'lovart');
  const [provider, setProvider] = useState(initial?.provider ?? 'lovart');
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? '');
  const [homepage, setHomepage] = useState(initial?.homepage_url ?? providerByValue(initial?.provider ?? 'lovart').homepageUrl ?? '');
  const [accessKey, setAccessKey] = useState(initial?.access_key ?? '');
  const [models, setModels] = useState<KeyModel[]>(initial?.models?.length ? initial.models : providerByValue(initial?.provider ?? 'lovart').defaultModels);
```

替换为：

```tsx
  const [alias, setAlias] = useState(initial?.alias ?? initial?.provider ?? 'openai');
  const [provider, setProvider] = useState(initial?.provider ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? '');
  const [homepage, setHomepage] = useState(initial?.homepage_url ?? providerByValue(initial?.provider ?? 'openai').homepageUrl ?? '');
  const [accessKey, setAccessKey] = useState(initial?.access_key ?? '');
  const [models, setModels] = useState<KeyModel[]>(initial?.models?.length ? initial.models : providerByValue(initial?.provider ?? 'openai').defaultModels);
```

- [ ] **Step 3: 运行测试确认通过**

```bash
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow/web
pnpm test
```

期望：所有 Keys.test.tsx 测试通过。关键说明：
- `provider: 'lovart'` 在 mockKey 里是 KeyCard 渲染的 API 响应数据，不依赖 PROVIDER_PRESETS，不影响
- `value: 'seedream'` 依然存在于 PROVIDER_PRESETS，所有选 seedream 的测试不变
- KeyForm 默认渲染改为 openai，但所有 KeyForm 测试均明确调用 `fireEvent.change(供应商选择)` 切换，不依赖默认值

```bash
pnpm lint
```

期望：tsc 退出码 0。

- [ ] **Step 4: Commit**

```bash
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow
git add web/src/pages/settings/KeyForm.tsx
git commit -m "keys: trim providers to image-only, rename Seedream to 火山引擎"
```

---

## Task 4: 新增火山引擎 API Key 并验证出图

**前提：** T1-T3 已 commit，dev server 已启动（`uv run python src/viewer_server/server.py start` + `cd web && pnpm dev`）

**Files:**
- 无代码文件修改；通过 API 调用和浏览器操作完成

- [ ] **Step 1: 确认 dev server 已启动**

```bash
# 终端 A（后台）
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow
uv run python src/viewer_server/server.py start
```

```bash
# 终端 B（后台）
cd /Users/zhengzhongbiao/WorkSpace/game-ui-ai-workflow/web
pnpm dev
```

访问 `http://localhost:5173` 确认页面加载。

- [ ] **Step 2: 通过 API 创建火山引擎 Key**

> viewer-server 默认端口 5174；Vite dev proxy 把 `/api/*` 转发到 5174。直接 POST 到 5174 端口。

```bash
curl -s -X POST http://localhost:5174/api/keys \
  -H 'Content-Type: application/json' \
  -d '{
    "alias": "seedream",
    "provider": "seedream",
    "base_url": "https://ark.cn-beijing.volces.com/api/v3",
    "access_key": "ark-d8f1e79c-06fc-49a3-a074-1c2aacb8b233-9749f",
    "secret_key": null,
    "capabilities": ["portrait", "promo", "turnaround"],
    "models": [{"name": "Doubao-Seedream-4.5", "id": "doubao-seedream-4-5-251128"}],
    "homepage_url": "https://www.volcengine.com",
    "docs_url": null,
    "api_key_url": null,
    "modalities": ["image"],
    "notes": ""
  }'
```

期望输出：`{"secret_revealed": "ark-d8f1e79c-..."}` — 包含 `secret_revealed` 字段即为成功。

- [ ] **Step 3: 验证 Key 已出现在列表**

```bash
curl -s http://localhost:5174/api/keys | python3 -m json.tool | grep -A3 '"alias": "seedream"'
```

期望：看到 `"alias": "seedream"` 且 `"provider": "seedream"` 的条目。

- [ ] **Step 4: 通过 Studio API 触发出图（小尺寸快速验证）**

```bash
curl -s -X POST http://localhost:5174/api/studio/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "一只橙色的猫坐在阳光下",
    "alias": "seedream",
    "model": "doubao-seedream-4-5-251128",
    "params": {
      "size": "1024x1024",
      "ratio": "1:1",
      "resolution": "2K"
    }
  }'
```

记录返回的 `job_id`，例如 `"job_id": "abc123"`。

- [ ] **Step 5: 轮询等待出图完成**

```bash
JOB_ID="<上一步的 job_id>"
for i in $(seq 1 30); do
  STATUS=$(curl -s http://localhost:5174/api/jobs/$JOB_ID | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('status','?'))")
  echo "[$i] status: $STATUS"
  if [ "$STATUS" = "done" ] || [ "$STATUS" = "failed" ]; then break; fi
  sleep 5
done
```

期望：最终 status = `done`，或 `failed` 时报出 error 字段（可判断是鉴权问题还是网络问题）。

- [ ] **Step 6: 确认出图路径存在（若成功）**

```bash
curl -s http://localhost:5174/api/jobs/$JOB_ID | python3 -c "import sys,json; j=json.load(sys.stdin); print(j.get('output_paths'), j.get('status'))"
```

期望：`status = done`，`output_paths` 包含至少一个文件路径。

> **若 status = failed：**
> - error 包含 "authentication" / "401" → API Key 无效或 base_url 错误
> - error 包含 "model not found" → model ID 有误
> - 记录 error 内容供排查

---

## 自我检查

### Spec 覆盖
- [x] T1: 删除主页 + 出图的"试试"示例 chips → Studio.tsx compact + 非 compact 均删除，InspirationChips 文件删除
- [x] T2: 尺寸面板样式 → RatioIcon + 尺寸区 + ✦ 删除
- [x] T3: 删除 Lovart/Seedance/Veo/Kling/Runway，Seedream 改名 → PROVIDER_PRESETS 更新
- [x] T4: 新增 Key + 测试 → curl 创建 + API 出图验证

### 类型检查
- RatioIcon props: `{ ratio: string }` ✓
- computePixelSize 返回: `{ w: number; h: number }` ✓
- Link2 从 lucide-react 导入: lucide-react 包含此 icon ✓
- `aria-selected={ratio === item || (item === '智能' && ratio === '1:1')}` — 智能选项的选中态正确处理 ✓

### 测试影响
- Studio.test.tsx line 68: 已在 T1 Step 5 更新
- Studio.test.tsx line 146 `/超清 4K/`: 去掉 ✦ 后匹配 "超清 4K" 仍通过 ✓
- Keys.test.tsx `value: 'seedream'`: PROVIDER_PRESETS 保留 `value: 'seedream'`，所有测试不变 ✓
- Keys.test.tsx `provider: 'lovart'` in mockKey: 是 KeyCard 渲染的 API 数据，不依赖 PROVIDER_PRESETS ✓
