import { Link } from 'wouter';
import { useCallback, useEffect, useState } from 'react';
import { Copy, HelpCircle } from 'lucide-react';
import {
  fetchGateway,
  fetchGatewayOptions,
  revokeGatewayKey,
  updateGateway,
  type GatewayKey,
  type GatewayOptions,
  type GatewayState,
} from '@/api/gateway';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { formatGenerationCost } from '@/lib/generationCost';
import { KeyForm } from './lan-sharing/KeyForm';
import { Tasks } from './lan-sharing/Tasks';
import { button, date, PERIODS } from './lan-sharing/shared';

const HINT =
  '同事在 API 密钥中添加局域网 Atelier，填写地址和网关密钥。连接使用明文 HTTP。同事连不上时检查防火墙：Windows 把当前网络设为「专用网络」，并在防火墙中允许 Atelier（Python）入站；macOS 首次开启时在弹窗中点「允许」。';
export function LanSharingSection() {
  const [state, setState] = useState<GatewayState | null>(null);
  const [options, setOptions] = useState<GatewayOptions>({ models: [], aliases: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [port, setPort] = useState('');
  const [editing, setEditing] = useState<GatewayKey | null | undefined>(undefined);
  const [pendingRevoke, setPendingRevoke] = useState<GatewayKey | null>(null);
  const reload = useCallback(async () => {
    const [next, choices] = await Promise.all([fetchGateway(), fetchGatewayOptions()]);
    setState(next);
    setOptions(choices);
    setPort(String(next.port));
  }, []);
  useEffect(() => {
    void reload().catch((e) => setError(String(e)));
  }, [reload]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const finished = useCallback(() => {
    void reload().catch((e) => setError(String(e)));
  }, [reload]);
  const address =
    state?.status.running && state.status.addresses[0]
      ? `http://${state.status.addresses[0]}:${state.status.port}`
      : null;
  return (
    <>
      <div className="flex items-center gap-1.5">
        <h2 className="text-base font-medium">局域网共享</h2>
        <button
          title={HINT}
          aria-label={HINT}
          className="text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <HelpCircle className="size-3.5" aria-hidden />
        </button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm">共享本机供应商</span>
          <Switch
            label="开启局域网共享"
            checked={Boolean(state?.enabled)}
            disabled={!state || busy}
            onChange={(enabled) => void run(() => updateGateway({ enabled }))}
          />
        </div>
      </div>
      <div className="min-w-0 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            {address && (
              <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-mono">{address}</span>
                <button
                  aria-label="复制地址"
                  className={button}
                  onClick={() => void navigator.clipboard.writeText(address)}
                >
                  <Copy className="size-3.5" />
                </button>
              </div>
            )}
            {state?.status.error && <p className="text-sm text-destructive">{state.status.error}</p>}
          </div>
        </div>
        {state?.enabled && (
          <>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                端口
                <Input
                  aria-label="端口"
                  value={port}
                  inputMode="numeric"
                  onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                  className="h-8 w-24"
                />
              </label>
              {state && port !== String(state.port) && (
                <button
                  className={button}
                  disabled={busy || !(Number(port) >= 1024 && Number(port) <= 65535)}
                  onClick={() => void run(() => updateGateway({ port: Number(port) }))}
                >
                  保存端口
                </button>
              )}
            </div>
            <section aria-label="网关密钥" className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">密钥</h3>
                <button className={button} disabled={!state || busy} onClick={() => setEditing(null)}>
                  新建密钥
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      {['名称', '本月额度', '本月花费', '最近使用', '操作'].map((h) => (
                        <th key={h} className="px-2 py-2 font-normal">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {state?.keys.map((key) => (
                      <tr key={key.id} className="border-t border-border">
                        <td
                          className={`max-w-32 truncate px-2 py-3 ${key.revoked_at ? 'text-muted-foreground line-through' : ''}`}
                          title={key.name}
                        >
                          {key.name}
                        </td>
                        <td className="min-w-40 space-y-2 px-2 py-3">
                          {!key.limits_status.some((limit) => limit.period === 'month')
                            ? '不限额'
                            : key.limits_status
                                .filter((limit) => limit.period === 'month')
                                .map((limit) => {
                                  const used = limit.used_cny + limit.reserved_cny;
                                  return (
                                    <div
                                      key={limit.period}
                                      className={
                                        used / limit.cap_cny > 0.9 ? 'text-[color:var(--status-running)]' : ''
                                      }
                                    >
                                      <p className="whitespace-nowrap tabular-nums">
                                        {PERIODS[limit.period]} {formatGenerationCost(used)} /{' '}
                                        {formatGenerationCost(limit.cap_cny)}
                                      </p>
                                      <progress
                                        aria-label={`${key.name}${PERIODS[limit.period]}额度`}
                                        max={limit.cap_cny}
                                        value={Math.min(used, limit.cap_cny)}
                                        className="h-1 w-full accent-current"
                                      />
                                    </div>
                                  );
                                })}
                        </td>
                        <td className="whitespace-nowrap px-2 tabular-nums">
                          <Link href={`/settings/usage?scope=team&member=${encodeURIComponent(key.id)}`}>
                            {formatGenerationCost(key.month_charged_cny)}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap px-2 text-muted-foreground">
                          {date(key.last_used_at)}
                        </td>
                        <td className="px-2">
                          {key.revoked_at ? (
                            '已撤销'
                          ) : (
                            <div className="flex gap-1">
                              <button className={button} disabled={busy} onClick={() => setEditing(key)}>
                                编辑
                              </button>
                              <button
                                className={button}
                                disabled={busy}
                                onClick={() => setPendingRevoke(key)}
                              >
                                撤销
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <Tasks onFinished={finished} />
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      {editing !== undefined && (
        <KeyForm
          record={editing}
          options={options}
          onClose={() => setEditing(undefined)}
          onSaved={finished}
        />
      )}
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
