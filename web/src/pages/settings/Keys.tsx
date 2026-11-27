import { useCallback, useEffect, useRef, useState } from 'react';
import { AddIcon, ChevronRightIcon, SearchIcon } from '@/components/ui/icons';
import { Link } from 'wouter';

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
import { Button } from '@/components/ui/button';
import { useRetained } from '@/components/ui/retained';
import { Collapse } from '@/components/ui/collapse';

interface Props {
  /** 首启向导复用同一个供应商表单。 */
  mode?: 'onboarding';
  onComplete?: () => void;
  embedded?: boolean;
}

export function KeysPage({ mode, onComplete, embedded = false }: Props = {}) {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(mode === 'onboarding');
  const [editingKey, setEditingKey] = useState<KeyRow | null>(null);
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
  const [overdue, setOverdue] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  // 按加载时的启用状态分组：页面内刚关掉的行留在原位，开关点完不会跳走。
  const [closedAliases, setClosedAliases] = useState<Set<string>>(new Set());
  const [showClosed, setShowClosed] = useState(false);
  // 删除确认：删供应商不可恢复，给更轻的「改为停用」（规格 2.1）。
  const [deleting, setDeleting] = useState<{ row: KeyRow; fromForm: boolean } | null>(null);
  const shownDeleting = useRetained(deleting);
  const formView = useRetained(showForm ? { session: formSession, editing: editingKey } : null);
  // 用量页「未计价」带 ?edit=<供应商>&price=<模型> 进来：列表读回后直接打开那条，展开到单价框。
  const [deepLink] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return { edit: query.get('edit'), price: query.get('price') };
  });
  const deepLinkOpened = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
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
      setKeys(rows);
      setClosedAliases(new Set(rows.filter(row => !row.enabled).map(row => row.alias)));
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
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
    setSavedAlias(alias);
    void refresh();
    if (mode === 'onboarding' && onComplete && !formView?.editing) onComplete();
  };

  const openCreate = () => {
    setEditingKey(null);
    setFormSession(session => session + 1);
    setShowForm(true);
  };
  const openEdit = (key: KeyRow) => {
    setEditingKey(key);
    setFormSession(session => session + 1);
    setShowForm(true);
  };

  const closeForm = () => {
    if (editingKey?.provider === 'comfyui') void refresh();
    setShowForm(false);
    setEditingKey(null);
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
  const providerRow = (key: KeyRow) => <ProviderRow key={key.alias} row={key} saved={savedAlias === key.alias}
    overdue={overdue.has(key.alias)} pending={pending.has(key.alias)}
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
          <span className="text-muted-foreground">模型 /</span><h1 className="text-sm font-semibold">供应商</h1>
        </div>}
        <div className="flex flex-wrap items-center gap-2">
        {embedded && <InputGroup className="w-56">
          <InputGroupAddon><SearchIcon aria-hidden /></InputGroupAddon>
          <InputGroupInput aria-label="查找供应商" placeholder="查找供应商" value={query}
            onChange={event => setQuery(event.target.value)} />
        </InputGroup>}
        {embedded ? <Link href="/settings/providers/new"
          className="flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <AddIcon size="sm" aria-hidden />添加供应商
        </Link> : <Button variant="default"
          type="button"
          onClick={openCreate}

        >
          + 新建供应商
        </Button>}
        </div>
      </div>

      {loading && (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} data-skeleton className="h-12 w-full bg-card/40 rounded-lg" />
          ))}
        </div>
      )}

      {!loading && error && <div className="text-sm text-destructive">{error}</div>}

      {!loading && (keys.length > 0 || !error) && (
        <div className="space-y-4">
        {!(embedded && activeKeys.length === 0 && closedKeys.length > 0) && <div className="overflow-hidden rounded-xl border border-border bg-card">
          {keys.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-muted-foreground">
              还没有配置供应商
              {embedded && <Button type="button" onClick={() => openOnboarding('providers')}>连接模型</Button>}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {embedded ? (
                <ul aria-label="供应商列表" className="divide-y divide-border">
                  {activeKeys.map(providerRow)}
                  {filteredKeys.length === 0 && <li className="px-4 py-10 text-center text-sm text-muted-foreground">没有匹配的供应商</li>}
                </ul>
              ) : (
                <>{keyRows}</>
              )}
            </div>
          )}
          </div>}
          {embedded && closedKeys.length > 0 && <section>
            <Button variant="bare" type="button" aria-expanded={closedOpen} onClick={() => setShowClosed(open => !open)}
              className="flex items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <ChevronRightIcon size="sm" className={`transition-transform duration-150 ${closedOpen ? 'rotate-90' : ''}`} aria-hidden />
              已关闭的供应商<span className="tabular-nums">{closedKeys.length}</span>
            </Button>
            <Collapse open={closedOpen}><div className="mt-2 overflow-hidden rounded-xl border border-border bg-card">
              <ul aria-label="已关闭的供应商" className="divide-y divide-border">{closedKeys.map(providerRow)}</ul>
            </div></Collapse>
          </section>}
          {embedded && <CustomInterfacesSection />}
        </div>
      )}

      {formView && (
        <KeyForm
          key={formView.session}
          open={showForm}
          initial={formView.editing ? toKeyFormInitial(formView.editing) : undefined}
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
