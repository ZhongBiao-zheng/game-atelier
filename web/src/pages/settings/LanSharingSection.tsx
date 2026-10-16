import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, HelpCircle } from 'lucide-react';

import {
  createGatewayKey,
  fetchGateway,
  fetchGatewayUsage,
  revokeGatewayKey,
  updateGateway,
  type GatewayState,
  type GatewayUsageRow,
} from '@/api/gateway';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { estimateGenerationCost, formatGenerationCost } from '@/lib/generationCost';

const HINT = '同一局域网的同事在「API 密钥」里添加「局域网 Atelier」，填这里的地址和对应的网关密钥。'
  + '连接是明文 HTTP；首次开启时系统可能询问是否允许传入连接。';
const rowButton =
  'rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const primaryButton =
  'rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

interface PersonUsage { images: number; failed: number; cost: number; priced: boolean }

/** 本月按网关密钥汇总：费用优先用网关回传的实际费用，没有就按价表估；估不出的标「约」。 */
export function summarizeUsage(rows: GatewayUsageRow[]): Map<string, PersonUsage> {
  const people = new Map<string, PersonUsage>();
  for (const row of rows) {
    const person = people.get(row.key_id) ?? { images: 0, failed: 0, cost: 0, priced: true };
    person.images += row.n;
    if (row.status === 'failed') person.failed += 1;
    if (row.status === 'done') {
      const cost = row.actual_cost_cny ?? (row.provider && row.model_id ? estimateGenerationCost({
        provider: { provider: row.provider, baseUrl: row.base_url },
        model: { id: row.model_id },
        kind: 'image',
        count: row.n,
        size: row.size ?? undefined,
        quality: (row.quality ?? undefined) as 'low' | 'medium' | 'high' | 'auto' | undefined,
        resolution: row.resolution ?? undefined,
      }) : null);
      if (cost == null) person.priced = false;
      else person.cost += cost;
    }
    people.set(row.key_id, person);
  }
  return people;
}

export function LanSharingSection() {
  const [state, setState] = useState<GatewayState | null>(null);
  const [usage, setUsage] = useState<GatewayUsageRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [port, setPort] = useState('');
  const [newName, setNewName] = useState('');
  const [newLimit, setNewLimit] = useState('');
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<{ id: string; name: string } | null>(null);

  const reload = useCallback(async () => {
    const [next, rows] = await Promise.all([fetchGateway(), fetchGatewayUsage()]);
    setState(next);
    setPort(String(next.port));
    setUsage(rows);
  }, []);

  useEffect(() => {
    reload().catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [reload]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createKey() {
    const name = newName.trim();
    if (!name) return;
    const limit = newLimit.trim() === '' ? null : Number(newLimit);
    await run(async () => {
      const result = await createGatewayKey(name, limit);
      setCreated({ name, token: result.token });
      setNewName('');
      setNewLimit('');
    });
  }

  const people = useMemo(() => summarizeUsage(usage), [usage]);
  const portNumber = Number(port);
  const portChanged = state !== null && port !== String(state.port);
  const address = state?.status.running && state.status.addresses[0]
    ? `http://${state.status.addresses[0]}:${state.status.port}` : null;

  return (
    <>
      <div className="flex items-center gap-1.5">
        <h2 className="text-base font-medium text-foreground">局域网共享</h2>
        <button
          type="button"
          title={HINT}
          aria-label={HINT}
          className="text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <HelpCircle className="size-3.5" aria-hidden />
        </button>
      </div>
      <div className="min-w-0 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-foreground">让同事用本机的 KEY 出图</p>
            {address && (
              <p role="status" className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                <span aria-hidden className="size-1.5 rounded-full bg-[color:var(--status-done)]" />
                <span className="font-mono">{address}</span>
                <button
                  type="button"
                  aria-label="复制地址"
                  onClick={() => void navigator.clipboard?.writeText(address)}
                  className="rounded p-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Copy className="size-3.5" aria-hidden />
                </button>
              </p>
            )}
            {state?.status.error && <p className="mt-1 text-sm text-destructive">{state.status.error}</p>}
          </div>
          <Switch
            checked={Boolean(state?.enabled)}
            label="开启局域网共享"
            disabled={!state || busy}
            onChange={next => void run(() => updateGateway({ enabled: next }))}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            端口
            <Input
              aria-label="端口"
              inputMode="numeric"
              value={port}
              onChange={event => setPort(event.target.value.replace(/\D/g, ''))}
              className="h-8 w-24"
            />
          </label>
          {portChanged && (
            <button
              type="button"
              disabled={busy || !(portNumber >= 1024 && portNumber <= 65535)}
              onClick={() => void run(() => updateGateway({ port: portNumber }))}
              className={rowButton}
            >
              保存端口
            </button>
          )}
        </div>

        {Boolean(state?.keys.length) && (
          <ul aria-label="网关密钥" className="space-y-2">
            {state!.keys.map(key => {
              const person = people.get(key.id);
              return (
                <li key={key.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                  <div className="min-w-0">
                    <span className={`text-sm ${key.revoked_at ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{key.name}</span>
                    <p className="text-xs text-muted-foreground">
                      今日 {key.used_today}{key.daily_image_limit === null ? '' : ` / ${key.daily_image_limit}`} 张
                      {person && ` · 本月 ${person.images} 张`}
                      {person && person.cost > 0 && ` · ${person.priced ? '' : '约 '}${formatGenerationCost(person.cost)}`}
                      {person && person.failed > 0 && ` · 失败 ${person.failed}`}
                    </p>
                  </div>
                  {key.revoked_at
                    ? <span className="text-xs text-muted-foreground">已撤销</span>
                    : (
                      <button type="button" disabled={busy} onClick={() => setPendingRevoke(key)} className={rowButton}>
                        撤销
                      </button>
                    )}
                </li>
              );
            })}
          </ul>
        )}

        {created && (
          <div role="status" className="space-y-1 rounded-md border border-primary/40 px-3 py-2">
            <p className="text-sm text-foreground">发给 {created.name} 的网关密钥（只显示这一次）</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 break-all font-mono text-xs text-foreground">{created.token}</code>
              <button
                type="button"
                aria-label="复制网关密钥"
                onClick={() => void navigator.clipboard?.writeText(created.token)}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Copy className="size-3.5" aria-hidden />
              </button>
            </div>
          </div>
        )}

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={event => { event.preventDefault(); void createKey(); }}
        >
          <Input aria-label="使用人" placeholder="使用人" value={newName} maxLength={40}
            onChange={event => setNewName(event.target.value)} className="h-9 w-36" />
          <Input aria-label="每日上限（张）" placeholder="每日上限，留空不限" inputMode="numeric" value={newLimit}
            onChange={event => setNewLimit(event.target.value.replace(/\D/g, ''))} className="h-9 w-44" />
          <button type="submit" disabled={busy || !newName.trim()} className={primaryButton}>新建密钥</button>
        </form>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>

      <ConfirmDialog
        open={pendingRevoke !== null}
        title={`撤销 ${pendingRevoke?.name ?? ''} 的网关密钥？`}
        message="撤销后立即失效，对方会改用自己的 KEY。"
        confirmText="撤销"
        variant="destructive"
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          const target = pendingRevoke;
          setPendingRevoke(null);
          if (target) void run(() => revokeGatewayKey(target.id));
        }}
      />
    </>
  );
}
