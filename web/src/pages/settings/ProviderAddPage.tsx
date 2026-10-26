import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Plus, Search } from 'lucide-react';
import { listKeys, type KeyView, type KeyCreatePayload } from '@/api/keys';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import { KeyForm } from './KeyForm';
import { PROVIDER_MONOGRAMS, PROVIDER_PRESETS, type ProviderPreset } from './providerPresets';

const GROUPS = [
  { kind: 'official', title: '供应商', description: '有自己的模型' },
  { kind: 'relay', title: '中转', description: '一个密钥，多家模型' },
  { kind: 'team', title: '团队', description: '同事开启的局域网共享' },
] as const;
const MODALITIES: Record<string, string> = { image: '图片', video: '视频', audio: '音频', llm: '文本' };

function host(url?: string | null) {
  try { return new URL(url || '').host; } catch { return ''; }
}

export function ProviderAddPage() {
  const [, navigate] = useLocation();
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [query, setQuery] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ preset: ProviderPreset; initial: Partial<KeyCreatePayload> } | null>(null);
  useEffect(() => {
    let active = true;
    void listKeys().then(data => { if (active) setKeys(data.keys); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, []);
  const open = (preset: ProviderPreset, baseUrl = preset.defaultBaseUrl) => {
    setSelected({ preset, initial: {
      provider: preset.value, alias: preset.kind === 'custom' ? '' : preset.label,
      base_url: baseUrl, models: preset.defaultModels, modalities: preset.modalities,
      homepage_url: preset.homepageUrl, docs_url: preset.docsUrl, api_key_url: preset.apiKeyUrl,
    } });
  };
  const custom = () => {
    try {
      const url = new URL(address.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      setError(null);
      open(PROVIDER_PRESETS.find(preset => preset.id === 'custom')!, address.trim());
    } catch { setError('请输入完整的 HTTP(S) API 请求地址'); }
  };
  const visible = PROVIDER_PRESETS.filter(preset => preset.kind !== 'custom'
    && preset.label.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="flex min-h-[560px] flex-col gap-7">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div aria-label="面包屑" className="flex items-center gap-1.5 text-sm">
        <Link href="/settings/providers" className="text-muted-foreground">供应商 /</Link><h1 className="text-sm font-semibold">添加</h1>
      </div>
      <div className="flex items-center gap-2">
        <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-muted-foreground focus-within:ring-1 focus-within:ring-ring">
          <Search className="size-3.5" aria-hidden />
          <input aria-label="查找供应商" placeholder="查找供应商" value={query} onChange={e => setQuery(e.target.value)}
            className="w-44 min-w-0 bg-transparent text-sm text-foreground outline-none" />
        </label>
        <Link href="/settings/providers" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-secondary">关闭</Link>
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {GROUPS.map(group => {
      const items = visible.filter(preset => preset.kind === group.kind);
      return items.length > 0 && <section key={group.kind} className="space-y-2.5">
        <div className="flex items-baseline gap-2.5"><h2 className="text-sm font-semibold">{group.title}</h2>
          <span className="text-xs text-muted-foreground">{group.description}</span></div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(220px,100%),1fr))] gap-2">
          {items.map(preset => {
            const added = keys.some(key => preset.value === 'custom'
              ? key.provider === 'custom' && host(key.base_url) === host(preset.defaultBaseUrl)
              : key.provider === preset.value);
            return <button key={preset.id} type="button" onClick={() => open(preset)}
              className="flex h-14 items-center gap-3 rounded-md border border-border bg-card px-3.5 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary font-mono text-xs">{PROVIDER_MONOGRAMS[preset.id]}</span>
              <span className="min-w-0 flex-1"><span className="block text-sm">{preset.label}</span>
                <span className="block text-xs text-muted-foreground">{preset.value === 'atelier' ? '模型由对方决定' : preset.id === 'evolink' ? 'Midjourney' : preset.modalities.map(modality => MODALITIES[modality] ?? modality).join(' · ')}</span>
              </span>
              {added && <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><span aria-hidden className="size-1.5 rounded-full bg-[color:var(--status-done)]" />已添加</span>}
            </button>;
          })}
        </div>
      </section>;
    })}
    {visible.length === 0 && <p className="text-sm text-muted-foreground">没有匹配的供应商</p>}
    <form onSubmit={e => { e.preventDefault(); custom(); }} className="mt-auto flex flex-wrap items-center gap-3 border-t border-border pt-5">
      <label htmlFor="custom-provider-address" className="flex items-center gap-1.5 text-sm font-medium text-primary"><Plus className="size-3.5" aria-hidden />自定义供应商</label>
      <input id="custom-provider-address" aria-label="自定义供应商地址" placeholder="任意 OpenAI 兼容地址，如 https://api.example.com/v1"
        value={address} onChange={e => setAddress(e.target.value)}
        className="h-10 min-w-0 flex-[1_1_360px] rounded-md border border-input bg-background px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      <button type="submit" disabled={!address.trim()} className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">继续</button>
    </form>
    {selected && <KeyForm presetId={selected.preset.id} initial={selected.initial} onCancel={() => setSelected(null)}
      onCreated={() => { window.dispatchEvent(new Event(KEYS_CHANGED_EVENT)); navigate('/settings/providers'); }} />}
  </div>;
}
