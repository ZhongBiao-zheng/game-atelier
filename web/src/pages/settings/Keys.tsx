import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CloseIcon, SearchIcon } from '@/components/ui/icons';

import { KeyCard, type KeyRow } from '@/components/keys/KeyCard';
import { ProviderRow, providerHost } from '@/components/keys/ProviderRow';
import { providerLabel } from '@/lib/providerLabels';
import { normalizeComfyUrl, useComfyStatuses } from '@/lib/useComfyStatus';
import { fetchGatewayMembers } from '@/api/gateway';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import { openOnboarding } from '@/lib/onboardingGuide';
import { KeyForm } from './KeyForm';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { errorText } from '@/lib/errorText';
import { listKeys, deleteKey, patchKey } from '@/api/keys';
import { fetchKeyLastUsed } from '@/api/usage';
import type { KeyCreatePayload } from '@/api/keys';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { CustomInterfacesSection } from './CustomInterfacesSection';
import { ProviderCatalogSection } from './ProviderCatalogSection';
import { presetInitial, type ProviderPreset } from './providerPresets';
import { Button } from '@/components/ui/button';
import { useRetained } from '@/components/ui/retained';
import { Collapse } from '@/components/ui/collapse';
import { Disclosure } from '@/components/ui/disclosure';
import { MOTION_DURATION, MOTION_EASE, motionAvailable, prefersReducedMotion } from '@/lib/motion';

/** 首次读取超过 250ms 才出骨架：本机毫秒级就绪时直接淡入内容，不闪骨架。 */
const SKELETON_DELAY_MS = 250;

interface Props {
  /** 首启向导复用同一个供应商表单。 */
  mode?: 'onboarding';
  onComplete?: () => void;
  embedded?: boolean;
}

export function KeysPage({ mode, onComplete, embedded = false }: Props = {}) {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastError = useRef<string | null>(null);
  if (error) lastError.current = error;
  const hasLoadedOnce = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [showForm, setShowForm] = useState(mode === 'onboarding');
  const [editingKey, setEditingKey] = useState<KeyRow | null>(null);
  const [formPreset, setFormPreset] = useState<{ preset: ProviderPreset; initial: Partial<KeyCreatePayload> } | null>(null);
  // 每次打开表单换一个会话号作 key：关闭后表单留着播完退场，再打开时状态从头来。
  const [formSession, setFormSession] = useState(0);
  // 刚保存的那一行原位打勾 2 秒（成功不发 toast，DESIGN.md「成功与失败」）。
  const [savedAlias, setSavedAlias] = useState<string | null>(() => new URLSearchParams(window.location.search).get('saved'));
  useEffect(() => {
    if (!savedAlias) return;
    const timer = window.setTimeout(() => setSavedAlias(null), 2000);
    return () => window.clearTimeout(timer);
  }, [savedAlias]);
  const [query, setQuery] = useState('');
  const [listMotion, setListMotion] = useState<'reveal' | 'instant'>('reveal');
  const [overdue, setOverdue] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [failedTicks, setFailedTicks] = useState<Record<string, number>>({});
  // 按加载时的启用状态分组：页面内刚关掉的行留在原位，开关点完不会跳走。
  const [closedAliases, setClosedAliases] = useState<Set<string>>(new Set());
  const [showClosed, setShowClosed] = useState(false);
  // 删除确认：删供应商不可恢复，给更轻的「改为停用」（规格 2.1）。
  const [deleting, setDeleting] = useState<{ row: KeyRow; fromForm: boolean } | null>(null);
  const shownDeleting = useRetained(deleting);
  const formView = useRetained(showForm ? { session: formSession, editing: editingKey, preset: formPreset } : null);
  // 用量页「未计价」带 ?edit=<供应商>&price=<模型> 进来：列表读回后直接打开那条，展开到单价框。
  const [deepLink] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return { edit: query.get('edit'), price: query.get('price') };
  });
  const deepLinkOpened = useRef(false);

  useEffect(() => {
    if (!loading) {
      setShowSkeleton(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const refresh = useCallback(async () => {
    // 只有首次加载进入 loading；后续保存/删除静默刷新，旧内容留在原地直接过渡到新状态，不闪骨架。
    if (!hasLoadedOnce.current) setLoading(true);
    setError(null);
    try {
      // 「最近使用」只是辅助列：读不到时显示「—」，不挡住供应商列表本身。
      const none: Record<string, string> = {};
      const [resp, lastUsed, statuses] = await Promise.all([
        listKeys(),
        embedded ? fetchKeyLastUsed().catch(() => none) : none,
        embedded ? fetchGatewayMembers().catch(() => null) : null,
      ]);
      setOverdue(new Set(statuses?.members.filter(member => member.reason === 'insufficient_balance').map(member => member.alias)));
      const rows = resp.keys
        .map((k) => toKeyRow({ ...k, last_used_at: lastUsed[k.alias] ?? null }))
        .sort((a, b) => Number(b.provider === 'atelier') - Number(a.provider === 'atelier'));
      setListMotion('reveal');
      setKeys(rows);
      setClosedAliases(new Set(rows.filter(row => !row.enabled).map(row => row.alias)));
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      hasLoadedOnce.current = true;
      setLoading(false);
    }
  }, [embedded]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (deepLinkOpened.current || !deepLink.edit) return;
    const target = keys.find(key => key.alias === deepLink.edit);
    if (!target) return;
    deepLinkOpened.current = true;
    openEdit(target);
  }, [keys]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSaved = (alias: string) => {
    window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
    setShowForm(false);
    setEditingKey(null);
    setFormPreset(null);
    setSavedAlias(alias);
    void refresh();
    if (mode === 'onboarding' && onComplete && !formView?.editing) onComplete();
  };

  const openCreate = () => {
    setEditingKey(null);
    setFormPreset(null);
    setFormSession(session => session + 1);
    setShowForm(true);
  };
  const openPreset = (preset: ProviderPreset) => {
    setEditingKey(null);
    setFormPreset({ preset, initial: presetInitial(preset) });
    setFormSession(session => session + 1);
    setShowForm(true);
  };
  const openEdit = (key: KeyRow) => {
    setEditingKey(key);
    setFormPreset(null);
    setFormSession(session => session + 1);
    setShowForm(true);
  };

  const closeForm = () => {
    if (editingKey?.provider === 'comfyui') void refresh();
    setShowForm(false);
    setEditingKey(null);
    setFormPreset(null);
  };

  const toggleKey = async (key: KeyRow, enabled: boolean) => {
    setPending(current => new Set(current).add(key.alias));
    setError(null);
    setKeys(current => current.map(row => row.alias === key.alias ? { ...row, enabled } : row));
    try {
      await patchKey(key.alias, { enabled });
      window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
    } catch (e) {
      setKeys(current => current.map(row => row.alias === key.alias ? { ...row, enabled: key.enabled } : row));
      setFailedTicks(current => ({ ...current, [key.alias]: (current[key.alias] ?? 0) + 1 }));
      setError(errorText(e));
    } finally {
      setPending(current => { const next = new Set(current); next.delete(key.alias); return next; });
    }
  };

  const comfyUrls = embedded
    ? keys.filter(key => key.provider === 'comfyui' && key.enabled !== false).map(key => normalizeComfyUrl(key.base_url))
    : [];
  const { statuses: comfyStatuses } = useComfyStatuses(comfyUrls);

  const filteredKeys = keys.filter(key => [key.alias, providerLabel(key.provider, key.alias),
    key.provider === 'custom' ? '自定义' : '', providerHost(key)].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const activeKeys = filteredKeys.filter(key => !closedAliases.has(key.alias));
  const closedKeys = filteredKeys.filter(key => closedAliases.has(key.alias));
  const closedOpen = showClosed || query.trim() !== '';
  const animateRows = listMotion === 'reveal';
  const reduced = prefersReducedMotion();
  const updateQuery = (next: string) => {
    setListMotion('instant');
    setQuery(next);
  };
  const providerRow = (key: KeyRow) => <ProviderRow key={key.alias} row={key} saved={savedAlias === key.alias}
    overdue={overdue.has(key.alias)} pending={pending.has(key.alias)}
    failedTick={failedTicks[key.alias] ?? 0}
    animateHeight={animateRows}
    comfyStatus={key.provider === 'comfyui' && key.enabled !== false ? (comfyStatuses[normalizeComfyUrl(key.base_url)] ?? 'checking') : undefined}
    onToggle={enabled => { void toggleKey(key, enabled); }}
    onEdit={() => openEdit(key)} />;

  const keyRows = keys.map((k) => (
    <KeyCard
      key={k.alias}
      row={k}
      saved={savedAlias === k.alias}
      onEdit={() => openEdit(k)}
      onDelete={() => setDeleting({ row: k, fromForm: false })}
    />
  ));

  const content = (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {!embedded && <h1 className="font-display text-display text-foreground">供应商</h1>}
        {embedded && <div aria-label="面包屑" className="flex items-center gap-1.5 text-sm">
          <span className="text-subtle-foreground">模型 /</span><h1 className="text-sm font-semibold">供应商</h1>
        </div>}
        <div className="flex flex-wrap items-center gap-2">
          {embedded ? (
            <InputGroup className="w-56">
              <InputGroupAddon><SearchIcon aria-hidden /></InputGroupAddon>
              <InputGroupInput ref={searchRef} aria-label="查找供应商" placeholder="查找供应商" value={query}
                onChange={event => updateQuery(event.target.value)} />
              <AnimatePresence>
                {query.length > 0 && (
                  <InputGroupAddon align="inline-end" className="px-1.5">
                    <motion.span
                      initial={motionAvailable() ? (reduced ? { opacity: 0 } : { opacity: 0, scale: 0.75 }) : false}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.75 }}
                      transition={{ duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }}
                      className="inline-flex"
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        type="button"
                        aria-label="清空查找"
                        onClick={() => { updateQuery(''); searchRef.current?.focus(); }}
                        className="size-6 rounded-sm border-0 text-muted-foreground hover:border-transparent hover:bg-secondary/70 hover:text-foreground hover:backdrop-blur-none"
                      >
                        <CloseIcon size="sm" aria-hidden />
                      </Button>
                    </motion.span>
                  </InputGroupAddon>
                )}
              </AnimatePresence>
            </InputGroup>
          ) : (
            <Button variant="default" type="button" onClick={openCreate}>
              + 新建供应商
            </Button>
          )}
        </div>
      </div>

      {loading && showSkeleton && (
        <div className="content-swap-in space-y-2">
          {[0, 1].map((i) => (
            <div key={i} data-skeleton className="h-12 w-full rounded-lg bg-card/40" />
          ))}
        </div>
      )}

      <Collapse open={!loading && Boolean(error)} appear>
        <div role="alert" className="pb-3 text-sm text-destructive">{error ?? lastError.current}</div>
      </Collapse>

      {!loading && (keys.length > 0 || !error) && (
        <div className="content-reveal space-y-8">
          <div className="space-y-3">
            {!(embedded && activeKeys.length === 0 && closedKeys.length > 0) && (
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                {keys.length === 0 ? (
                  embedded ? (
                    <div className="content-swap-in flex flex-wrap items-center justify-between gap-3 px-4 py-4 text-sm text-muted-foreground">
                      <span>还没有配置供应商，在下方选择一个开始接入</span>
                      <Button variant="outline" size="sm" type="button" onClick={() => openOnboarding('providers')}>引导配置</Button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-muted-foreground">
                      还没有配置供应商
                    </div>
                  )
                ) : (
                  <div className="divide-y divide-border">
                    {embedded ? (
                      <ul aria-label="供应商列表" className="divide-y divide-border">
                        <AnimatePresence initial={false}>
                          {activeKeys.map(providerRow)}
                        </AnimatePresence>
                        {filteredKeys.length === 0 && <li className="content-swap-in px-4 py-8 text-center text-sm text-muted-foreground">没有匹配的供应商</li>}
                      </ul>
                    ) : (
                      <>{keyRows}</>
                    )}
                  </div>
                )}
              </div>
            )}
            {embedded && (
              <Collapse open={closedKeys.length > 0}>
                <section aria-label="已关闭的供应商分组">
                  <Disclosure
                    open={closedOpen}
                    onOpenChange={setShowClosed}
                    triggerClassName="py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                    summary={<>已关闭的供应商<span className="ml-1 tabular-nums">{closedKeys.length}</span></>}
                  >
                    <div className="mt-2 overflow-hidden rounded-xl border border-border bg-card/60">
                      <ul aria-label="已关闭的供应商" className="divide-y divide-border">
                        <AnimatePresence initial={false}>
                          {closedKeys.map(providerRow)}
                        </AnimatePresence>
                      </ul>
                    </div>
                  </Disclosure>
                </section>
              </Collapse>
            )}
          </div>
          {embedded && <ProviderCatalogSection keys={keys} onSelect={openPreset} />}
          {embedded && <CustomInterfacesSection />}
        </div>
      )}

      {formView && (
        <KeyForm
          key={formView.session}
          open={showForm}
          presetId={formView.preset?.preset.id}
          initial={formView.editing ? toKeyFormInitial(formView.editing) : formView.preset?.initial}
          mode={formView.editing ? 'edit' : 'create'}
          autoDetect
          existingAliases={keys.map(key => key.alias)}
          focusPriceModel={formView.editing && formView.editing.alias === deepLink.edit ? deepLink.price ?? undefined : undefined}
          onCreated={onSaved}
          onCancel={closeForm}
          onDelete={formView.editing ? () => setDeleting({ row: formView.editing!, fromForm: true }) : undefined}
          submitLabel={formView.editing ? '保存修改' : mode === 'onboarding' ? '保存并开始工作' : '保存'}
        />
      )}
    </>
  );

  const removeKey = async (target: KeyRow, fromForm: boolean) => {
    setDeleting(null);
    try {
      await deleteKey(target.alias);
      if (fromForm) closeForm();
      window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
      void refresh();
    } catch (e) { setError(errorText(e)); }
  };
  const disableKey = (target: KeyRow, fromForm: boolean) => {
    setDeleting(null);
    if (fromForm) closeForm();
    void toggleKey(target, false);
  };
  const deleteDialog = shownDeleting && <AlertDialog open={Boolean(deleting)} onOpenChange={next => { if (!next) setDeleting(null); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>删除供应商「{shownDeleting.row.alias}」？</AlertDialogTitle>
        <AlertDialogDescription>删除后不能恢复，它的模型会从智能路由里移除。只是暂时不用可以改为停用。</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>取消</AlertDialogCancel>
        {shownDeleting.row.enabled !== false && <Button variant="outline" type="button"
          onClick={() => disableKey(shownDeleting.row, shownDeleting.fromForm)}>改为停用</Button>}
        <AlertDialogAction destructive onClick={event => { event.preventDefault(); void removeKey(shownDeleting.row, shownDeleting.fromForm); }}>删除</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;

  if (embedded) return <>{content}{deleteDialog}</>;

  return (
    <div className="px-6 py-8 max-w-3xl mx-auto">
      {content}
      {deleteDialog}
    </div>
  );
}

function toKeyRow(k: {
  alias: string;
  enabled?: boolean;
  provider: string;
  base_url?: string | null;
  billing_group?: string | null;
  access_key: string;
  models?: {
    name: string;
    id: string;
    modality?: 'text' | 'image' | 'video' | 'audio' | null;
    protocol?: string | null;
    input_modalities?: Array<'text' | 'image' | 'video' | 'audio'>;
  }[];
  capabilities?: string[];
  homepage_url?: string | null;
  docs_url?: string | null;
  api_key_url?: string | null;
  modalities?: string[];
  notes?: string;
  last_used_at?: string | null;
  created_at?: string | null;
  icon?: string | null;
  text_protocol?: string | null;
}): KeyRow {
  return {
    alias: k.alias,
    enabled: k.enabled !== false,
    provider: k.provider,
    base_url: k.base_url ?? null,
    billing_group: k.billing_group ?? null,
    masked_secret: k.access_key ?? '****',
    models: k.models ?? [],
    capabilities: k.capabilities ?? [],
    homepage_url: k.homepage_url ?? null,
    docs_url: k.docs_url ?? null,
    api_key_url: k.api_key_url ?? null,
    modalities: k.modalities ?? [],
    notes: k.notes ?? '',
    last_used_at: k.last_used_at ?? null,
    created_at: k.created_at ?? null,
    icon: k.icon ?? null,
    text_protocol: k.text_protocol ?? null,
  };
}

function toKeyFormInitial(row: KeyRow): Partial<KeyCreatePayload> {
  return {
    alias: row.alias,
    enabled: row.enabled !== false,
    provider: row.provider,
    base_url: row.base_url ?? null,
    billing_group: row.billing_group ?? null,
    access_key: row.masked_secret,
    capabilities: row.capabilities ?? ['portrait', 'promo', 'turnaround'],
    models: row.models ?? [],
    homepage_url: row.homepage_url ?? null,
    docs_url: row.docs_url ?? null,
    api_key_url: row.api_key_url ?? null,
    modalities: row.modalities ?? [],
    notes: row.notes ?? '',
    icon: row.icon ?? null,
    text_protocol: row.text_protocol ?? null,
  };
}
