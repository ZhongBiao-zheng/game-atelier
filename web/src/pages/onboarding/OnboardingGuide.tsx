import { useEffect, useRef, useState } from 'react';
import { checkComfyUI } from '@/api/comfyui';
import { getChatGPTSubscription, listKeys, type ChatGPTSubscriptionStatus, type KeyCreatePayload, type KeyView } from '@/api/keys';
import { recordOnboardingEvent, type OnboardingPath } from '@/api/onboarding';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { Button } from '@/components/ui/button';
import { BackIcon, CheckIcon, ChevronRightIcon, ExternalLinkIcon, HelpIcon } from '@/components/ui/icons';
import { Hint } from '@/components/ui/tooltip';
import { useRetained } from '@/components/ui/retained';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import { RECOMMENDED_PROVIDERS, hasUsableModel, type GuideSource, type GuideStepId, type GuideVendor, type RecommendedProvider } from '@/lib/onboardingGuide';
import { cn } from '@/lib/utils';
import { KeyForm } from '@/pages/settings/KeyForm';
import { PROVIDER_PRESETS, presetInitial } from '@/pages/settings/providerPresets';

const COMFY_DEFAULT_URL = 'http://127.0.0.1:8188';

interface FormState {
  path: OnboardingPath;
  vendor?: GuideVendor;
  presetId?: string;
  initial?: Partial<KeyCreatePayload>;
  mode: 'create' | 'edit';
}

const presetById = (id: string) => PROVIDER_PRESETS.find(preset => preset.id === id);

function editInitial(key: KeyView): Partial<KeyCreatePayload> {
  return {
    alias: key.alias, enabled: key.enabled !== false, provider: key.provider, base_url: key.base_url,
    access_key: key.access_key, models: key.models, capabilities: key.capabilities,
    homepage_url: key.homepage_url ?? null, docs_url: key.docs_url ?? null, api_key_url: key.api_key_url ?? null,
    modalities: key.modalities ?? [], notes: key.notes,
  };
}

/** 连接第一个模型：推荐厂商分步获取 Key，或走 ChatGPT 订阅 / 本机 ComfyUI / 团队网关。
 *  每条路径最后都落到同一个 KeyForm；有可用模型即调用 onDone。 */
export function OnboardingGuide({ source, onDone }: { source: GuideSource; onDone: () => void }) {
  const [vendor, setVendor] = useState<RecommendedProvider | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  // 表单关闭后带着原内容播完退场；每份新表单换一个序号作 key，再打开同一条路径也是新表单。
  const shownForm = useRetained(form);
  const formSession = useRef<{ form: FormState | null; n: number }>({ form: null, n: 0 });
  if (form && form !== formSession.current.form) formSession.current = { form, n: formSession.current.n + 1 };
  const [opened, setOpened] = useState<Set<GuideStepId>>(new Set());
  const [subscription, setSubscription] = useState<ChatGPTSubscriptionStatus | null | 'error'>(null);
  const [comfy, setComfy] = useState<'checking' | 'running' | 'stopped'>('checking');

  useEffect(() => { void recordOnboardingEvent({ event: 'guide_opened', source }); }, [source]);
  useEffect(() => {
    let active = true;
    getChatGPTSubscription().then(status => { if (active) setSubscription(status); }, () => { if (active) setSubscription('error'); });
    checkComfyUI(COMFY_DEFAULT_URL).then(() => { if (active) setComfy('running'); }, () => { if (active) setComfy('stopped'); });
    return () => { active = false; };
  }, []);

  const choosePath = (path: OnboardingPath, next?: FormState) => {
    void recordOnboardingEvent({ event: 'path_selected', path });
    if (next) setForm(next);
  };
  const chooseVendor = (item: RecommendedProvider) => {
    void recordOnboardingEvent({ event: 'path_selected', path: 'key', vendor: item.presetId });
    setOpened(new Set());
    setVendor(item);
  };
  const openPreset = (path: OnboardingPath, presetId: string) => {
    const preset = presetById(presetId);
    choosePath(path, { path, presetId, initial: preset ? presetInitial(preset) : undefined, mode: 'create' });
  };
  const openStep = (item: RecommendedProvider, step: GuideStepId) => {
    setOpened(current => new Set(current).add(step));
    void recordOnboardingEvent({ event: 'step_opened', step, vendor: item.presetId });
  };
  const openKeyForm = (item: RecommendedProvider) => {
    const preset = presetById(item.presetId);
    void recordOnboardingEvent({ event: 'step_opened', step: 'key_form', vendor: item.presetId });
    if (preset) setForm({ path: 'key', vendor: item.presetId, presetId: preset.id, initial: presetInitial(preset), mode: 'create' });
  };

  /** 保存或关掉表单后重新判断：有可用模型就结束；ComfyUI 还没工作流就转到编辑态导入。 */
  const settle = async (saved: FormState | null) => {
    const { keys } = await listKeys().catch(() => ({ keys: [] as KeyView[] }));
    if (hasUsableModel(keys)) { onDone(); return; }
    if (saved?.path === 'comfyui' && saved.mode === 'create') {
      const created = keys.filter(key => key.provider === 'comfyui').sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];
      if (created) { setForm({ path: 'comfyui', initial: editInitial(created), mode: 'edit' }); return; }
    }
    setForm(null);
  };
  const onSaved = () => {
    if (!form) return;
    window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
    void recordOnboardingEvent({ event: 'provider_saved', path: form.path, ...(form.vendor ? { vendor: form.vendor } : {}) });
    void settle(form);
  };

  const subscriptionLine = subscription === null ? '加载中…' : subscription === 'error' || !subscription.available
    ? '未登录' : subscription.email ?? '已登录';
  const comfyLine = { checking: '检测中…', running: '运行中', stopped: '未运行' }[comfy];

  return (
    <div className="flex flex-col gap-6">
      {!vendor ? <>
        <ul aria-label="推荐" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {RECOMMENDED_PROVIDERS.map(item => {
            const preset = presetById(item.presetId);
            return preset && <li key={item.presetId}>
              <Button variant="bare" type="button" onClick={() => chooseVendor(item)}
                className="flex h-full w-full items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <BrandTile provider={{ provider: preset.value, base_url: preset.defaultBaseUrl }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-base font-medium">{preset.label}</span>
                    <span className="accent-pill rounded-sm px-1.5 py-0.5 text-xs font-medium">推荐</span>
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">{item.coverage}</span>
                </span>
                <ChevronRightIcon className="shrink-0 self-center text-muted-foreground" aria-hidden />
              </Button>
            </li>;
          })}
        </ul>
        <ul aria-label="其他方式" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <PathCard provider={{ provider: 'chatgpt' }} title="ChatGPT 订阅" status={subscriptionLine}
            onClick={() => openPreset('chatgpt', 'chatgpt')} />
          <PathCard provider={{ provider: 'comfyui' }} title="本机 ComfyUI" status={comfyLine}
            onClick={() => openPreset('comfyui', 'comfyui')} />
          <PathCard provider={{ provider: 'atelier' }} title="加入团队" status="同事的 Atelier"
            onClick={() => openPreset('gateway', 'atelier')} />
        </ul>
        <div>
          <Button variant="link" size="sm" type="button" className="h-auto px-0 text-muted-foreground hover:text-foreground"
            onClick={() => choosePath('other', { path: 'other', mode: 'create' })}>其他供应商</Button>
        </div>
      </> : <VendorSteps item={vendor} opened={opened} onBack={() => setVendor(null)}
        onOpenStep={step => openStep(vendor, step)} onPaste={() => openKeyForm(vendor)} />}
      {shownForm && <KeyForm
        key={formSession.current.n}
        open={Boolean(form)}
        presetId={shownForm.presetId}
        initial={shownForm.initial}
        mode={shownForm.mode}
        autoDetect={shownForm.path === 'key'}
        submitLabel={shownForm.mode === 'edit' ? '完成' : '保存并开始'}
        onCreated={onSaved}
        onCancel={() => { void settle(null); }}
      />}
    </div>
  );
}

function VendorSteps({ item, opened, onBack, onOpenStep, onPaste }: {
  item: RecommendedProvider;
  opened: ReadonlySet<GuideStepId>;
  onBack: () => void;
  onOpenStep: (step: GuideStepId) => void;
  onPaste: () => void;
}) {
  const preset = presetById(item.presetId);
  return (
    <>
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" type="button" aria-label="返回" onClick={onBack}><BackIcon /></Button>
        {preset && <BrandTile provider={{ provider: preset.value, base_url: preset.defaultBaseUrl }} />}
        <span className="text-base font-medium">{preset?.label}</span>
      </div>
      <ol aria-label="获取 Key 步骤" className="flex flex-col gap-2">
        {item.steps.map((step, index) => {
          const done = opened.has(step.id);
          const current = !done && item.steps.slice(0, index).every(prev => opened.has(prev.id));
          return (
            <StepRow key={step.id} index={index + 1} label={step.label} hint={step.hint} done={done} current={current}>
              <Button variant="outline" size="sm" asChild>
                <a href={step.url} target="_blank" rel="noreferrer" onClick={() => onOpenStep(step.id)}>
                  打开<ExternalLinkIcon aria-hidden />
                </a>
              </Button>
            </StepRow>
          );
        })}
        <StepRow index={item.steps.length + 1} label="粘贴 Key" hint={item.pasteHint}
          done={false} current={item.steps.every(step => opened.has(step.id))}>
          <Button size="sm" type="button" onClick={onPaste}>粘贴</Button>
        </StepRow>
      </ol>
    </>
  );
}

function BrandTile({ provider }: { provider: { provider?: string; base_url?: string | null } }) {
  return (
    <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary">
      <ProviderBrandIcon provider={provider} />
    </span>
  );
}

function PathCard({ provider, title, status, onClick }: {
  provider: { provider: string };
  title: string;
  status: string;
  onClick: () => void;
}) {
  return (
    <li>
      <Button variant="bare" type="button" onClick={onClick}
        className="flex h-full w-full items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:flex-col sm:items-start">
        <BrandTile provider={provider} />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{title}</span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">{status}</span>
        </span>
      </Button>
    </li>
  );
}

function StepRow({ index, label, hint, done, current, children }: {
  index: number;
  label: string;
  hint?: string;
  done: boolean;
  current: boolean;
  children: React.ReactNode;
}) {
  return (
    <li aria-current={current ? 'step' : undefined}
      className={cn('flex items-center gap-3 rounded-lg border bg-card px-4 py-3', current ? 'border-primary/40' : 'border-border')}>
      <span aria-hidden className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums',
        done ? 'bg-primary text-primary-foreground' : 'border border-border text-muted-foreground')}>
        {done ? <CheckIcon size="sm" /> : index}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">
        {label}
        {hint && <Hint label={hint}><span tabIndex={0} aria-label={`${label}说明`} className="inline-flex rounded-full text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><HelpIcon size="sm" /></span></Hint>}
      </span>
      {done && <span className="sr-only">已完成</span>}
      {children}
    </li>
  );
}
