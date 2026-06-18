import { useEffect, useState } from 'react';

import { KeyCard, type KeyRow } from '@/components/keys/KeyCard';
import { KeyForm } from './KeyForm';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { listKeys, deleteKey } from '@/api/keys';
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
  const [dialog, setDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    variant: 'default' | 'destructive';
    onConfirm: () => void;
  } | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listKeys();
      setKeys(resp.keys.map(toKeyRow));
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
      <div className={`mb-4 flex items-baseline ${embedded ? 'justify-end' : 'justify-between'}`}>
        {!embedded && (
          <h1 className="font-display text-display text-foreground">API 密钥</h1>
        )}
        <button
          type="button"
          onClick={openCreate}
          className="text-sm bg-primary text-primary-foreground rounded-md px-3 py-2 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ring-offset-2 ring-offset-background"
        >
          + 新建供应商
        </button>
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

      {!loading && error && (
        <div className="text-sm text-destructive">{error}</div>
      )}

      {!loading && !error && (
        <div className="overflow-hidden rounded-lg border border-border">
          {keys.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              还没有配置供应商，点「+ 新建供应商」接入第一个图像服务。
            </div>
          ) : (
            <div className="divide-y divide-border">
              {keys.map((k) => (
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
              ))}
            </div>
          )}
          <div className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            密钥仅存本机 <span className="font-mono">&lt;数据目录&gt;/.config/keys.json</span>，不会上传
          </div>
        </div>
      )}

      {showForm && (
        <KeyForm
          initial={editingKey ? toKeyFormInitial(editingKey) : undefined}
          mode={editingKey ? 'edit' : 'create'}
          onCreated={editingKey ? onUpdated : onCreated}
          onCancel={closeForm}
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
  provider: string;
  base_url?: string | null;
  access_key: string;
  models?: { name: string; id: string; modality?: 'image' | 'video' | null }[];
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
    provider: k.provider,
    base_url: k.base_url ?? null,
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
    provider: row.provider,
    base_url: row.base_url ?? null,
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
