import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { AddIcon, SearchIcon } from '@/components/ui/icons';
import { getChatGPTSubscription, type ChatGPTSubscriptionStatus, listKeys, type KeyView, type KeyCreatePayload } from '@/api/keys';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import { KeyForm } from './KeyForm';
import { PROVIDER_PRESETS, presetInitial, providerPresetId, type ProviderPreset } from './providerPresets';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Button } from '@/components/ui/button';
import { errorText } from '@/lib/errorText';
import { useRetained } from '@/components/ui/retained';

const GROUPS = [
  { kind: 'local', title: '本机', description: '' },
  { kind: 'official', title: '供应商', description: '有自己的模型' },
  { kind: 'relay', title: '中转', description: '一个密钥，多家模型' },
  { kind: 'subscription', title: '订阅', description: '' },
  { kind: 'team', title: '团队网关', description: '连接同事开启的团队网关' },
  { kind: 'custom', title: '自定义', description: '兼容 OpenAI 或任意第三方接口' },
] as const;
const MODALITIES: Record<string, string> = { image: '图片', video: '视频', audio: '音频', llm: '文本' };

export function ProviderAddPage() {
  const [, navigate] = useLocation();
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [subscription, setSubscription] = useState<ChatGPTSubscriptionStatus | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ preset: ProviderPreset; initial: Partial<KeyCreatePayload>; session: number } | null>(null);
  // 关闭后表单带着原内容播完退场；session 作 key，每次打开都是新表单。
  const shown = useRetained(selected);
  useEffect(() => {
    let active = true;
    void getChatGPTSubscription().then(data => { if (active) setSubscription(data); })
      .catch(error => { if (active) setSubscriptionError(errorText(error)); });
    void listKeys().then(data => { if (active) setKeys(data.keys); })
      .catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, []);
  const open = (preset: ProviderPreset, baseUrl = preset.defaultBaseUrl) => {
    setSelected(current => ({ preset, initial: presetInitial(preset, baseUrl), session: (current?.session ?? shown?.session ?? 0) + 1 }));
  };
  const visible = PROVIDER_PRESETS.filter(preset =>
    [preset.label, preset.kind === 'custom' ? '自定义供应商' : ''].join(' ').toLowerCase().includes(query.trim().toLowerCase()),
  );
  return <div className="flex min-h-[560px] flex-col gap-7">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div aria-label="面包屑" className="flex items-center gap-1.5 text-sm">
        <Link href="/settings/providers" className="text-muted-foreground">供应商 /</Link><h1 className="text-sm font-semibold">添加</h1>
      </div>
      <div className="flex items-center gap-2">
        <InputGroup className="w-56">
          <InputGroupAddon><SearchIcon aria-hidden /></InputGroupAddon>
          <InputGroupInput aria-label="查找供应商" placeholder="查找供应商" value={query} onChange={e => setQuery(e.target.value)} />
        </InputGroup>
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
            const isCustom = preset.id === 'custom';
            const added = !isCustom && keys.some(key => providerPresetId(key) === preset.id);
            return <Button variant="bare" key={preset.id} type="button" onClick={() => open(preset)}
              className="flex min-h-14 items-center gap-3 rounded-md border border-border bg-card px-3.5 py-2 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-xs">
                {isCustom ? <AddIcon size="sm" /> : <ProviderBrandIcon provider={{ provider: preset.value, base_url: preset.defaultBaseUrl }} />}
              </span>
              <span className="min-w-0 flex-1"><span className="block text-sm">{isCustom ? '自定义供应商' : preset.label}</span>
                <span className="block text-xs text-muted-foreground">{isCustom ? '填写请求地址与密钥' : preset.value === 'chatgpt' ? (subscriptionError ?? (!subscription ? '加载中…' : subscription.available ? [subscription.email, subscription.plan].filter(Boolean).join(' · ') : '请先在 Codex 里用 ChatGPT 登录')) : preset.value === 'atelier' ? '模型由对方决定' : preset.id === 'evolink' ? 'Midjourney' : preset.modalities.map(modality => MODALITIES[modality] ?? modality).join(' · ')}</span>
              </span>
              {added && <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><span aria-hidden className="size-1.5 rounded-full bg-[color:var(--status-done)]" />已添加</span>}
            </Button>;
          })}
        </div>
      </section>;
    })}
    {visible.length === 0 && <p className="text-sm text-muted-foreground">没有匹配的供应商</p>}
    {shown && <KeyForm key={shown.session} open={Boolean(selected)} presetId={shown.preset.id} initial={shown.initial} onCancel={() => setSelected(null)}
      autoDetect existingAliases={keys.map(key => key.alias)}
      onCreated={alias => { window.dispatchEvent(new Event(KEYS_CHANGED_EVENT)); navigate(`/settings/providers?saved=${encodeURIComponent(alias)}`); }} />}
  </div>;
}
