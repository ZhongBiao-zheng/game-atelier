import { useEffect, useState } from 'react';

import { KeyCard, type KeyRow } from '@/components/keys/KeyCard';
import { KeyForm } from './KeyForm';
import { listKeys, deleteKey, setDefaultKey } from '@/api/keys';
import type { KeyCreatePayload } from '@/api/keys';

interface Props {
  /** Backward-compat: onboarding flow passes mode="onboarding" + onComplete */
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

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listKeys();
      setKeys(resp.keys.map(toKeyRow(resp.default_alias)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const onCreated = () => {
    setShowForm(false);
    setEditingKey(null);
    setSuccessMessage('创建成功');
    void refresh();
    if (mode === 'onboarding' && onComplete) onComplete();
  };

  const onUpdated = () => {
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

  const content = (
    <>
      <div className="flex justify-between items-baseline mb-6">
        <h1
          className={embedded ? 'text-base font-medium text-foreground' : 'text-2xl text-foreground'}
          style={embedded ? undefined : { fontFamily: "'Instrument Serif', serif" }}
        >
          API Keys
        </h1>
        {!showForm && (
          <button
            type="button"
            onClick={openCreate}
            className="text-sm bg-primary text-primary-foreground rounded-md px-3 py-2 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ring-offset-2 ring-offset-background"
          >
            + 新建 Key
          </button>
        )}
      </div>

      {loading && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} data-skeleton className="h-28 w-full max-w-2xl bg-card/40 rounded-lg" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className="text-sm text-destructive">{error}</div>
      )}

      {successMessage && (
        <div className="mb-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700">
          {successMessage}
        </div>
      )}

      {!loading && !error && keys.length === 0 && !showForm && (
        <div className="text-center py-16">
          <p
            className="text-2xl italic text-foreground"
            style={{ fontFamily: "'Instrument Serif', serif" }}
          >
            还没有 API Key。
          </p>
          <button
            type="button"
            onClick={openCreate}
            className="mt-6 text-sm bg-primary text-primary-foreground rounded-md px-4 py-2 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            + 新建 Key
          </button>
        </div>
      )}

      {!loading && !error && keys.length > 0 && (
        <div className="space-y-3">
          {keys.map((k) => (
            <KeyCard
              key={k.alias}
              row={k}
              onSetDefault={async () => { await setDefaultKey(k.alias); void refresh(); }}
              onEdit={() => {
                setEditingKey(k);
                setShowForm(true);
              }}
              onDelete={async () => {
                const confirm = window.prompt(`输入 "${k.alias}" 确认删除`);
                if (confirm !== k.alias) return;
                await deleteKey(k.alias);
                void refresh();
              }}
            />
          ))}
        </div>
      )}

      {showForm && (
        <div className="mt-6 border border-border rounded-lg p-6">
          <h2
            className="text-lg mb-4 text-foreground"
            style={{ fontFamily: "'Instrument Serif', serif" }}
          >
            {editingKey ? '编辑 API Key' : '新增 API Key'}
          </h2>
          <KeyForm
            initial={editingKey ? toKeyFormInitial(editingKey) : undefined}
            mode={editingKey ? 'edit' : 'create'}
            onCreated={editingKey ? onUpdated : onCreated}
            onCancel={closeForm}
            submitLabel={editingKey ? '保存修改' : mode === 'onboarding' ? '保存并开始工作' : '保存'}
          />
        </div>
      )}
    </>
  );

  if (embedded) {
    return (
      <div className="rounded-lg border border-border bg-card/55 p-5">
        {content}
      </div>
    );
  }

  return (
    <div className="px-6 py-8 max-w-2xl mx-auto">
      {content}
    </div>
  );
}

function toKeyRow(defaultAlias: string | null) {
  return (k: {
    alias: string;
    provider: string;
    base_url?: string | null;
    access_key: string;
    models?: { name: string; id: string }[];
    capabilities?: string[];
    homepage_url?: string | null;
    docs_url?: string | null;
    api_key_url?: string | null;
    modalities?: string[];
    routing_scope?: 'general' | 'classified';
    routing_category?: string | null;
    routing_hints?: string[];
    notes?: string;
    is_default?: boolean;
    last_used_at?: string | null;
    created_at?: string | null;
  }): KeyRow => ({
    alias: k.alias,
    provider: k.provider,
    base_url: k.base_url ?? null,
    masked_secret: k.access_key ?? '****',
    models: k.models ?? [],
    capabilities: k.capabilities ?? [],
    homepage_url: k.homepage_url ?? null,
    docs_url: k.docs_url ?? null,
    api_key_url: k.api_key_url ?? null,
    modalities: k.modalities ?? [],
    routing_scope: k.routing_scope ?? 'general',
    routing_category: k.routing_category ?? null,
    routing_hints: k.routing_hints ?? [],
    notes: k.notes ?? '',
    is_default: k.alias === defaultAlias,
    last_used_at: k.last_used_at ?? null,
    created_at: k.created_at ?? null,
  });
}

function toKeyFormInitial(row: KeyRow): Partial<KeyCreatePayload> {
  return {
    alias: row.alias,
    provider: row.provider,
    base_url: row.base_url ?? null,
    access_key: row.masked_secret,
    capabilities: row.capabilities ?? ['portrait', 'promo', 'turnaround'],
    models: row.models ?? [],
    homepage_url: row.homepage_url ?? null,
    docs_url: row.docs_url ?? null,
    api_key_url: row.api_key_url ?? null,
    modalities: row.modalities ?? [],
    routing_scope: row.routing_scope ?? 'general',
    routing_category: row.routing_category ?? null,
    routing_hints: row.routing_hints ?? [],
    notes: row.notes ?? '',
  };
}
