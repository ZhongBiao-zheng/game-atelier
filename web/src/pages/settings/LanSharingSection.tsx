import { AuditLog } from './lan-sharing/AuditLog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Link } from 'wouter';
import { useCallback, useEffect, useState } from 'react';
import {
  fetchGateway,
  fetchGatewayOptions,
  fetchGatewayService,
  revokeGatewayKey,
  updateGateway,
  updateGatewayKey,
  type GatewayKey,
  type GatewayOptions,
  type GatewayService,
  type GatewayState,
} from '@/api/gateway';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { formatGenerationCost } from '@/lib/generationCost';
import { KeyForm } from './lan-sharing/KeyForm';
import { GatewayMemberName } from './lan-sharing/GatewayMemberName';
import { GatewayMemberToken } from './lan-sharing/GatewayMemberToken';
import { Tasks } from './lan-sharing/Tasks';
import { date, PERIODS } from './lan-sharing/shared';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

export const GATEWAY_HINT =
  '同事在「添加供应商 → Remote Atelier」填写地址和网关密钥。连接使用明文 HTTP。同事连不上时检查防火墙：Windows 把当前网络设为「专用网络」，并在防火墙中允许 Atelier（Python）入站；macOS 首次开启时在弹窗中点「允许」。';
export function LanSharingSection({ gatewayAlias }: { gatewayAlias?: string }) {
  const [tab, setTab] = useState('members');
  const [state, setState] = useState<GatewayState | null>(null);
  const [service, setService] = useState<GatewayService | null>(null);
  const [options, setOptions] = useState<GatewayOptions>({ models: [], aliases: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [port, setPort] = useState('');
  const [editingPort, setEditingPort] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [editing, setEditing] = useState<GatewayKey | null | undefined>(undefined);
  const [pendingRevoke, setPendingRevoke] = useState<GatewayKey | null>(null);
  const reload = useCallback(async () => {
    const [next, choices] = await Promise.all([fetchGateway(gatewayAlias), fetchGatewayOptions(gatewayAlias)]);
    setState(next);
    setOptions(choices);
  }, [gatewayAlias]);
  useEffect(() => {
    void reload().catch((e) => setError(String(e)));
  }, [reload]);
  useEffect(() => {
    if (gatewayAlias) return;
    void fetchGatewayService().then(setService).catch((e) => setError(String(e)));
  }, [gatewayAlias]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await reload();
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const finished = useCallback(() => {
    void reload().catch((e) => setError(String(e)));
  }, [reload]);
  const address =
    state?.enabled && state.status.running && state.status.addresses[0]
      ? `http://${state.status.addresses[0]}:${state.status.port}`
      : null;
  return (
    <>
      {!gatewayAlias && <section aria-label="网关状态" className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-card p-5">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-4">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${state?.enabled && state.status.running ? 'bg-status-done' : 'bg-subtle-foreground'}`} />
          <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">共享本机供应商</h2>
            <span className={`rounded-full px-2 py-0.5 text-xs ${state?.enabled && state.status.running ? 'gateway-running' : 'bg-secondary text-muted-foreground'}`}>
              {!state ? '读取中…' : !state.enabled ? '已关闭' : state.status.running ? '运行中' : state.status.error ? '启动失败' : '已关闭'}
            </span>
          </div>
          {state && <p className="text-xs text-muted-foreground">{state.enabled
            ? <>{options.models.length} 个模型 · {state.keys.filter(key => !key.revoked_at).length} 位在用成员 · 本月全员花费 {formatGenerationCost(state.keys.reduce((sum, key) => sum + key.month_charged_cny, 0))}</>
            : '开启后，同事可以用你的供应商出图，按成员限额记账'}</p>}
          {state?.enabled && state.status.error && <p className="text-sm text-destructive">{state.status.error}</p>}
          </div>
        </div>
        {address && <div role="status" className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-xs">
          <span className="break-all font-mono">{address}</span>
          <Button variant="outline" size="sm" aria-label="复制地址" className="shrink-0" onClick={async () => {
            setError('');
            try {
              await navigator.clipboard.writeText(address);
              setCopiedAddress(address);
            } catch {
              setCopiedAddress(null);
              setError('复制失败，请手动复制地址');
            }
          }}>{copiedAddress === address ? '已复制' : '复制'}</Button>
        </div>}
        {state?.enabled && (editingPort ? (
          <form autoComplete="off" className="flex flex-wrap items-center gap-2" onSubmit={event => {
            event.preventDefault();
            if (busy || !(Number(port) >= 1024 && Number(port) <= 65535)) return;
            void run(() => updateGateway({ port: Number(port) })).then(saved => {
              if (saved) setEditingPort(false);
            });
          }}>
            <Input aria-label="端口" value={port} inputMode="numeric" autoFocus disabled={busy}
              onChange={event => setPort(event.target.value.replace(/\D/g, ''))} className="w-24" />
            <Button variant="outline" size="sm" type="submit"
              disabled={busy || !(Number(port) >= 1024 && Number(port) <= 65535)}>保存端口</Button>
            <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => setEditingPort(false)}>取消</Button>
          </form>
        ) : (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => {
            setPort(String(state.port));
            setEditingPort(true);
          }}>改端口</Button>
        ))}
        <Switch size="sm" aria-label="开启局域网共享" checked={Boolean(state?.enabled)} disabled={!state || busy}
          onCheckedChange={enabled => void run(() => updateGateway({ enabled })).then(saved => {
            if (saved) setEditingPort(false);
          })} />
      </section>}
      {!gatewayAlias && service && service.state !== 'unsupported' && <section className="space-y-2 rounded-xl border border-border bg-card p-5 text-xs">
        <p>常驻服务：{{ installed: '已安装', not_installed: '未安装', needs_credentials: '待设置系统凭据', unknown: '状态读取失败' }[service.state]}</p>
        {service.state !== 'installed' && <code className="block break-all select-all text-muted-foreground">{service.install_command}</code>}
      </section>}
      {!gatewayAlias && <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="成员管理页签">{[['members', '成员与任务'], ['audit', '操作日志']].map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}</TabsList>
      </Tabs>}
      {tab === 'audit' ? <AuditLog gatewayAlias={gatewayAlias} /> : <div className="min-w-0 space-y-6">
        {state?.enabled && (
          <>
            <section aria-label="成员" className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">成员 <span className="font-normal text-muted-foreground">{state.keys.length}</span></h3>
                <Button variant="outline" size="sm" disabled={!state || busy} onClick={() => setEditing(null)}>
                  新建成员密钥
                </Button>
              </div>
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full min-w-160 text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      {['名称', '密钥', '角色', '本月额度', '本月花费', '最近使用', '操作'].map((h) => (
                        <th key={h} className="px-4 py-3 font-normal">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="border-b border-border">
                    {state?.keys.map((key) => (
                      <tr key={`${gatewayAlias ?? 'local'}:${key.id}`} className={`border-t border-border ${key.revoked_at ? 'opacity-50' : ''}`}>
                        <td
                          className={`max-w-64 px-4 py-3 align-middle ${key.revoked_at ? 'text-muted-foreground' : ''}`}
                        >
                          {key.revoked_at ? <Hint label={key.name}><span className="truncate">{key.name}</span></Hint>
                            : <GatewayMemberName name={key.name} disabled={busy}
                              onSave={name => run(() => updateGatewayKey(key.id, { name }, ...(gatewayAlias ? [gatewayAlias] as const : [])))} />}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {!gatewayAlias && !key.revoked_at
                            ? <div className="flex items-center gap-1 whitespace-nowrap"><GatewayMemberToken id={key.id} name={key.name} onError={setError} /></div>
                            : '—'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-middle">{key.role === 'admin' ? '管理员' : '成员'}</td>
                        <td className="min-w-40 px-4 py-3 align-middle">
                          <div className="flex h-9 flex-col justify-center">
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
                                          used / limit.cap_cny > 0.85 ? 'text-status-running' : 'text-primary'
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
                                          className="gateway-quota h-1.5 w-full"
                                        />
                                      </div>
                                    );
                                  })}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-middle tabular-nums">
                          <Link className="underline decoration-border underline-offset-4 hover:text-primary" href={gatewayAlias ? `/settings/relay-admin?alias=${encodeURIComponent(gatewayAlias)}&view=usage&member=${encodeURIComponent(key.id)}` : `/settings/usage?scope=team&member=${encodeURIComponent(key.id)}`}>
                            {formatGenerationCost(key.month_charged_cny)}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-middle text-muted-foreground">
                          {date(key.last_used_at)}
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {key.revoked_at ? (
                            '已撤销'
                          ) : (
                            <div className="flex items-center gap-2 whitespace-nowrap text-muted-foreground">
                              <Button variant="bare" className="rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50" disabled={busy} onClick={() => setEditing(key)}>
                                编辑
                              </Button>
                              <span aria-hidden>·</span>
                              <Button variant="bare"
                                className="rounded-sm hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                                disabled={busy}
                                onClick={() => setPendingRevoke(key)}
                              >
                                撤销
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <Tasks onFinished={finished} gatewayAlias={gatewayAlias} />
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>}
      {editing !== undefined && (
        <KeyForm
          gatewayAlias={gatewayAlias}
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
          if (target) void run(() => revokeGatewayKey(target.id, ...(gatewayAlias ? [gatewayAlias] as const : [])));
        }}
      />
    </>
  );
}
