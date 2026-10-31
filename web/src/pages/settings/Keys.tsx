import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Plus, Search } from 'lucide-react';
import { Link } from 'wouter';

import { KeyCard, type KeyRow } from '@/components/keys/KeyCard';
import { ProviderRow, providerHost } from '@/components/keys/ProviderRow';
import { providerLabel } from '@/lib/providerLabels';
import { fetchGatewayMembers } from '@/api/gateway';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import { KeyForm } from './KeyForm';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { listKeys, deleteKey, patchKey } from '@/api/keys';
import { fetchKeyLastUsed } from '@/api/usage';
import type { KeyCreatePayload } from '@/api/keys';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Button } from '@/components/ui/button';

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
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [overdue, setOverdue] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  // 按加载时的启用状态分组：页面内刚关掉的行留在原位，开关点完不会跳走。
  const [closedAliases, setClosedAliases] = useState<Set<string>>(new Set());
  const [showClosed, setShowClosed] = useState(false);
  const [dialog, setDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    variant: 'default' | 'destructive';
    onConfirm: () => void;
  } | null>(null);

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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [embedded]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreated = () => {
    window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
    setShowForm(false);
    setEditingKey(null);
    setSuccessMessage('创建成功');
    void refresh();
    if (mode === 'onboarding' && onComplete) onComplete();
  };

  const onUpdated = () => {
    window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
    setShowForm(false);
    setEditingKey(null);
    setSuccessMessage('已更新');
    void refresh();
  };

  const openCreate = () => {
    setEditingKey(null);
    setShowForm(true);
  };

  const closeForm = () => {
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(current => { const next = new Set(current); next.delete(key.alias); return next; });
    }
  };

  const filteredKeys = keys.filter(key => [key.alias, providerLabel(key.provider, key.alias),
    key.provider === 'custom' ? '自定义' : '', providerHost(key)].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const activeKeys = filteredKeys.filter(key => !closedAliases.has(key.alias));
  const closedKeys = filteredKeys.filter(key => closedAliases.has(key.alias));
  const closedOpen = showClosed || query.trim() !== '';
  const providerRow = (key: KeyRow) => <ProviderRow key={key.alias} row={key}
    overdue={overdue.has(key.alias)} pending={pending.has(key.alias)}
    onToggle={enabled => { void toggleKey(key, enabled); }}
    onEdit={() => { setEditingKey(key); setShowForm(true); }} />;

  const keyRows = keys.map((k) => (
    <KeyCard
      key={k.alias}
      row={k}
      onEdit={() => {
        setEditingKey(k);
        setShowForm(true);
      }}
      onDelete={() => {
        setDialog({
          open: true,
          title: '确认删除？',
          message: `"${k.alias}" 将被永久删除`,
          variant: 'destructive',
          onConfirm: async () => {
            setDialog(null);
            await deleteKey(k.alias);
            void refresh();
          },
        });
      }}
    />
  ));

  const content = (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {!embedded && <h1 className="font-display text-display text-foreground">API 密钥</h1>}
        {embedded && <div aria-label="面包屑" className="flex items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">模型 /</span><h1 className="text-sm font-semibold">供应商</h1>
        </div>}
        <div className="flex flex-wrap items-center gap-2">
        {embedded && <InputGroup className="w-56">
          <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
          <InputGroupInput aria-label="查找供应商" placeholder="查找供应商" value={query}
            onChange={event => setQuery(event.target.value)} />
        </InputGroup>}
        {embedded ? <Link href="/settings/providers/new"
          className="flex h-9 items-center gap-1.5 rounded-md border border-input px-3.5 text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <Plus className="size-3.5" aria-hidden />添加供应商
        </Link> : <Button variant="default"
          type="button"
          onClick={openCreate}

        >
          + 新建供应商
        </Button>}
        </div>
      </div>

      {successMessage && (
        <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
          <span className="size-1.5 rounded-full bg-[color:var(--status-done)]" aria-hidden />
          {successMessage}
        </div>
      )}

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
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              还没有配置供应商
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
              <ChevronRight className={`size-3.5 transition-transform duration-150 ${closedOpen ? 'rotate-90' : ''}`} aria-hidden />
              已关闭的供应商<span className="tabular-nums">{closedKeys.length}</span>
            </Button>
            {closedOpen && <div className="mt-2 overflow-hidden rounded-xl border border-border bg-card">
              <ul aria-label="已关闭的供应商" className="divide-y divide-border">{closedKeys.map(providerRow)}</ul>
            </div>}
          </section>}
          <div className="text-xs text-muted-foreground">
            密钥仅存本机 <span className="font-mono">&lt;数据目录&gt;/.config/keys.json</span>
          </div>
        </div>
      )}

      {showForm && (
        <KeyForm
          initial={editingKey ? toKeyFormInitial(editingKey) : undefined}
          mode={editingKey ? 'edit' : 'create'}
          onCreated={editingKey ? onUpdated : onCreated}
          onCancel={closeForm}
          onDelete={editingKey ? () => setDialog({
            open: true, title: '确认删除？', message: `"${editingKey.alias}" 将被永久删除`, variant: 'destructive',
            onConfirm: async () => {
              setDialog(null);
              try {
                await deleteKey(editingKey.alias);
                closeForm();
                window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
                void refresh();
              } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            },
          }) : undefined}
          submitLabel={editingKey ? '保存修改' : mode === 'onboarding' ? '保存并开始工作' : '保存'}
        />
      )}
    </>
  );

  if (embedded) {
    return (
      <>
        {content}
        {dialog && (
          <ConfirmDialog
            open={dialog.open}
            title={dialog.title}
            message={dialog.message}
            variant={dialog.variant}
            onConfirm={dialog.onConfirm}
            onCancel={() => setDialog(null)}
          />
        )}
      </>
    );
  }

  return (
    <div className="px-6 py-8 max-w-3xl mx-auto">
      {content}
      {dialog && (
        <ConfirmDialog
          open={dialog.open}
          title={dialog.title}
          message={dialog.message}
          variant={dialog.variant}
          onConfirm={dialog.onConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
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
  };
}
