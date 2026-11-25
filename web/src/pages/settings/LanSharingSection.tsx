import { GatewaySharedLibraries } from './lan-sharing/GatewaySharedLibraries';
import { AuditLog } from './lan-sharing/AuditLog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Link } from 'wouter';
import { useCallback, useEffect, useState } from 'react';
import {
  fetchGateway,
  fetchGatewayOptions,
  fetchGatewayService,
  installGatewayService,
  revokeGatewayKey,
  resetGatewayKey,
  updateGateway,
  updateGatewayKey,
  type GatewayKey,
  type GatewayOptions,
  type GatewayService,
  type GatewayState,
} from '@/api/gateway';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Input } from '@/components/ui/input';
import { Disclosure } from '@/components/ui/disclosure';
import { Switch } from '@/components/ui/switch';
import { formatGenerationCost } from '@/lib/generationCost';
import { KeyInlineCreate } from './lan-sharing/KeyInlineCreate';
import { KeyRowActions, KeyRoleCell } from './lan-sharing/KeyRowActions';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { GatewayMemberToken } from './lan-sharing/GatewayMemberToken';
import { Tasks } from './lan-sharing/Tasks';
import { date, PERIODS } from './lan-sharing/shared';
import { Button } from '@/components/ui/button';
import { useRetained } from '@/components/ui/retained';
import { SwapLabel } from '@/components/ui/swap-label';
import { useCopyFeedback } from '@/lib/useCopyFeedback';
import { errorText } from '@/lib/errorText';

export const GATEWAY_HINT =
  '在成员行点「复制邀请」发给同事，同事在「添加供应商 → 团队网关」任一框里粘贴即可连接。连接使用明文 HTTP。同事连不上时检查防火墙：Windows 把当前网络设为「专用网络」，并在防火墙中允许 Atelier（Python）入站；macOS 首次开启时在弹窗中点「允许」。';
export function LanSharingSection({ gatewayAlias }: { gatewayAlias?: string }) {
  const [tab, setTab] = useState('members');
  const [state, setState] = useState<GatewayState | null>(null);
  const [service, setService] = useState<GatewayService | null>(null);
  const [options, setOptions] = useState<GatewayOptions>({ providers: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 开关、端口这类网关设置的报错挂在状态卡片里，紧挨开关；成员操作的报错仍在成员表下面。
  const [settingsError, setSettingsError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installIssue, setInstallIssue] = useState<string | null>(null);
  const [installStarted, setInstallStarted] = useState(false);
  const [commandCopy, copyCommand] = useCopyFeedback();
  const [port, setPort] = useState('');
  const [editingPort, setEditingPort] = useState(false);
  // 复制地址：「已复制」1.5 秒后自动退回「复制」，失败给出可照做的提示。
  const [copyState, copyAddress] = useCopyFeedback();
  useEffect(() => { if (copyState === 'failed') setError('复制失败，请手动复制地址'); }, [copyState]);
  const [creating, setCreating] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<GatewayKey | null>(null);
  const [rename, setRename] = useState('');
  const shownRenaming = useRetained(renaming);
  const [pendingReset, setPendingReset] = useState<GatewayKey | null>(null);
  const [tokenVersion, setTokenVersion] = useState(0);
  const [createdTokens, setCreatedTokens] = useState<Record<string, string>>({});
  useEffect(() => { if (!highlight) return; const timer = window.setTimeout(() => setHighlight(null), 2000); return () => window.clearTimeout(timer); }, [highlight]);
  const [pendingRevoke, setPendingRevoke] = useState<GatewayKey | null>(null);
  const reload = useCallback(async () => {
    const [next, choices] = await Promise.all([fetchGateway(gatewayAlias), fetchGatewayOptions(gatewayAlias)]);
    setState(next);
    setOptions(choices);
  }, [gatewayAlias]);
  useEffect(() => {
    void reload().catch((e) => setError(errorText(e)));
  }, [reload]);
  useEffect(() => {
    if (gatewayAlias) return;
    void fetchGatewayService().then(setService).catch((e) => setError(errorText(e)));
  }, [gatewayAlias]);
  async function run(action: () => Promise<unknown>, target: 'members' | 'settings' = 'members') {
    const report = target === 'settings' ? setSettingsError : setError;
    setBusy(true);
    setError('');
    setSettingsError('');
    try {
      await action();
      await reload();
      return true;
    } catch (e) {
      report(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const refreshService = () => { void fetchGatewayService().then(setService).catch((e) => setSettingsError(errorText(e))); };
  const installService = async () => {
    setInstalling(true);
    setInstallIssue(null);
    try {
      await installGatewayService();
      setInstallStarted(true);
    } catch (e) {
      setInstallIssue(errorText(e));
    } finally {
      setInstalling(false);
    }
  };
  const finished = useCallback(() => {
    void reload().catch((e) => setError(errorText(e)));
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
            <h2 className="text-sm font-semibold">团队网关</h2>
            <span className={`rounded-full px-2 py-0.5 text-xs ${state?.enabled && state.status.running ? 'gateway-running' : 'bg-secondary text-muted-foreground'}`}>
              {!state ? '加载中…' : state.config_error ? '配置损坏' : !state.enabled ? '已关闭' : state.status.running ? '运行中' : state.status.error ? '启动失败' : '已关闭'}
            </span>
          </div>
          {state && !state.config_error && <p className="text-xs text-muted-foreground">{state.enabled
            ? <>{new Set((options.providers ?? []).filter(p => p.enabled).flatMap(p => p.models.map(m => m.route_id))).size} 个模型 · {state.keys.filter(key => !key.revoked_at).length} 位在用成员 · 本月全员花费 {formatGenerationCost(state.keys.reduce((sum, key) => sum + key.month_charged_cny, 0))}{state.quarantined_tasks ? ` · ${state.quarantined_tasks} 个损坏任务已隔离` : ''}</>
            : '开启后，同事可以用你的供应商出图，按成员限额记账'}</p>}
          {state?.config_error && <p className="break-all text-sm text-destructive">{state.config_error}</p>}
          {state?.enabled && state.status.error && <p className="text-sm text-destructive">{state.status.error}</p>}
          {settingsError && <p role="alert" className="text-sm text-destructive">{settingsError}</p>}
          </div>
        </div>
        {address && <div role="status" className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-xs">
          <span className="break-all font-mono">{address}</span>
          <Button variant="outline" size="sm" aria-label="复制地址" className="shrink-0" onClick={() => {
            setError('');
            copyAddress(address);
          }}><SwapLabel active={copyState === 'copied'} on="已复制" off="复制" /></Button>
        </div>}
        {state?.enabled && (editingPort ? (
          <form autoComplete="off" className="flex flex-wrap items-center gap-2" onSubmit={event => {
            event.preventDefault();
            if (busy || !(Number(port) >= 1024 && Number(port) <= 65535)) return;
            void run(() => updateGateway({ port: Number(port) }), 'settings').then(saved => {
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
        <Switch size="sm" aria-label="开启团队网关" checked={Boolean(state?.enabled)} disabled={!state || busy || Boolean(state.config_error)}
          onCheckedChange={enabled => void run(() => updateGateway({ enabled }), 'settings').then(saved => {
            if (saved) setEditingPort(false);
          })} />
      </section>}
      {!gatewayAlias && service && service.state !== 'unsupported' && <section aria-label="常驻服务" className="space-y-2 rounded-xl border border-border bg-card p-5 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p>常驻服务：{{ installed: '已安装，开机自动运行', not_installed: '未安装', needs_credentials: '还差一步', unknown: '状态读取失败' }[service.state]}</p>
          {service.state === 'not_installed' && !installStarted && <Button variant="outline" size="sm" disabled={installing} onClick={() => void installService()}>
            <SwapLabel active={installing} on="等待授权…" off="安装" /></Button>}
          {(installStarted || service.state === 'needs_credentials') && <Button variant="outline" size="sm" onClick={refreshService}>刷新状态</Button>}
        </div>
        {installStarted && service.state === 'not_installed' && <p className="text-muted-foreground">已打开安装窗口，按窗口提示完成</p>}
        {service.state === 'needs_credentials' && <p className="text-muted-foreground">在任务计划程序里打开 GameAtelier 的属性，选「不管用户是否登录都要运行」，保存时输入本机登录密码</p>}
        {installIssue && <p role="alert" className="text-destructive">{installIssue}</p>}
        {service.install_command && service.state !== 'installed' && (installIssue || service.state === 'unknown') && <Disclosure summary="复制命令手动安装">
          <div className="mt-2 flex items-start gap-2">
            <code className="block min-w-0 flex-1 break-all select-all text-muted-foreground">{service.install_command}</code>
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => copyCommand(service.install_command!)}>
              <SwapLabel active={commandCopy === 'copied'} on="已复制" off="复制" /></Button>
          </div>
        </Disclosure>}
      </section>}
      {/* 网关从没开过时没有成员和日志可看，不给页签。 */}
      {!gatewayAlias && (state?.enabled || (state?.keys.length ?? 0) > 0) && <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="成员管理页签">{[['members', '成员与任务'], ['audit', '操作日志']].map(([value, label]) => <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}</TabsList>
      </Tabs>}
      {tab === 'audit' ? <AuditLog gatewayAlias={gatewayAlias} /> : <div className="min-w-0 space-y-6">
        {state?.enabled && (
          <>
            <section aria-label="成员" className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">成员 <span className="font-normal text-muted-foreground">{state.keys.length}</span></h3>
                <Button variant="outline" size="sm" disabled={!state || busy} onClick={() => setCreating(true)}>
                  新建成员密钥
                </Button>
              </div>
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full min-w-160 text-left text-xs">
                  <thead className="text-muted-foreground">
                    <tr>
                      {['名称', '密钥', '角色', '额度', '本月花费', '最近使用', '操作'].map((h) => (
                        <th key={h} className="whitespace-nowrap px-4 py-3 font-normal">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="border-b border-border">
                    {state?.keys.map((key) => (
                      <tr key={`${gatewayAlias ?? 'local'}:${key.id}`} className={`group border-t border-border transition-colors duration-300 ${highlight === key.id ? "bg-secondary" : ""} ${key.revoked_at ? 'opacity-50' : ''}`}>
                        <td
                          className={`max-w-64 px-4 py-3 align-middle ${key.revoked_at ? 'text-muted-foreground' : ''}`}
                        >
                          <span className="block truncate">{key.name}</span>
                        </td>
                        <td className="px-4 py-3 align-middle">
                          {(!gatewayAlias || createdTokens[key.id]) && !key.revoked_at
                            ? <div className="flex items-center gap-1 whitespace-nowrap"><GatewayMemberToken key={`${key.id}:${tokenVersion}`} knownToken={createdTokens[key.id]} id={key.id} name={key.name} inviteAddress={gatewayAlias ? null : address} onError={setError} /></div>
                            : '—'}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-middle"><KeyRoleCell record={key} busy={busy} onSave={patch => run(() => updateGatewayKey(key.id, patch, ...(gatewayAlias ? [gatewayAlias] as const : [])))} /></td>
                        <td className="min-w-40 px-4 py-3 align-middle">
                          <div className="flex h-9 flex-col justify-center">
                            <QuotaBar record={key} />
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
                        <td className="w-px whitespace-nowrap px-4 py-3 align-middle">
                          {key.revoked_at ? (
                            '已撤销'
                          ) : (
                            <KeyRowActions record={key} options={options} busy={busy}
                              onSave={patch => run(() => updateGatewayKey(key.id, patch, ...(gatewayAlias ? [gatewayAlias] as const : [])))}
                              onRename={() => { setRename(key.name); setRenaming(key); }}
                              onReset={() => setPendingReset(key)} onRevoke={() => setPendingRevoke(key)} />
                          )}
                        </td>
                      </tr>
                    ))}
                    {creating && <tr className="border-t border-border"><td colSpan={7}><KeyInlineCreate gatewayAlias={gatewayAlias} onCancel={() => setCreating(false)} onCreated={(key, token) => {
                      setCreating(false); setHighlight(key.id); setCreatedTokens(current => ({ ...current, [key.id]: token }));
                      setState(current => current ? { ...current, keys: [...current.keys, key] } : current); finished();
                    }} /></td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            <Tasks onFinished={finished} gatewayAlias={gatewayAlias} />
            {!gatewayAlias && <GatewaySharedLibraries />}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>}
      {shownRenaming && <Dialog open={Boolean(renaming)} onOpenChange={open => { if (!open) setRenaming(null); }}><DialogContent aria-describedby={undefined}>
        <DialogTitle>重命名成员</DialogTitle><form autoComplete="off" className="space-y-3" onSubmit={event => { event.preventDefault();
          void run(() => updateGatewayKey(shownRenaming.id, { name: rename.trim() }, ...(gatewayAlias ? [gatewayAlias] as const : []))).then(ok => { if (ok) setRenaming(null); });
        }}><Input autoFocus aria-label="名称" value={rename} maxLength={40} onChange={event => setRename(event.target.value)} /><Button disabled={busy || !rename.trim()} type="submit">保存</Button></form>
      </DialogContent></Dialog>}
      <ConfirmDialog open={pendingReset !== null} title={`重置 ${pendingReset?.name ?? ''} 的密钥？`} message="原密钥立即失效，需要把新密钥交给对方。" confirmText="重置"
        onCancel={() => setPendingReset(null)} onConfirm={() => { const target = pendingReset; setPendingReset(null); if (target) void run(async () => {
          const result = await resetGatewayKey(target.id, gatewayAlias); setCreatedTokens(current => ({ ...current, [target.id]: result.token })); setTokenVersion(value => value + 1);
        }); }} />
      <ConfirmDialog
        open={pendingRevoke !== null}
        title={`撤销 ${pendingRevoke?.name ?? ''} 的网关密钥？`}
        message="撤销后立即失效，对方会改用自己的供应商。"
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


/** 成员行的额度：一个金额 + 一个周期（第 7 批）。旧主机（远程管理）不回 quota_status，显示「—」。 */
function QuotaBar({ record }: { record: GatewayKey }) {
  const quota = record.quota_status;
  if (quota === undefined) return <>—</>;
  if (quota === null) return <>不限额</>;
  const used = quota.used_cny + quota.reserved_cny;
  return (
    <div className={used / quota.cap_cny > 0.85 ? 'text-status-running' : 'text-primary'}>
      <p className="whitespace-nowrap tabular-nums">
        {PERIODS[quota.period]} {formatGenerationCost(used)} / {formatGenerationCost(quota.cap_cny)}
      </p>
      <progress aria-label={`${record.name}${PERIODS[quota.period]}额度`} max={quota.cap_cny}
        value={Math.min(used, quota.cap_cny)} className="gateway-quota h-1.5 w-full" />
    </div>
  );
}
