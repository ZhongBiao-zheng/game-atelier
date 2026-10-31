import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, X } from 'lucide-react';
import { applyUpdate, cancelUpdate, checkUpdate, fetchUpdateResult, fetchUpdateState, probeUpdateInstance, readPendingUpdate, savePendingUpdate, updateRecoveryExpired, updateNavigation, type PendingUpdate, type UpdateState } from '@/api/update';
import { ApiError } from '@/api/http';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { OPEN_CHANGELOG_EVENT } from '@/components/ChangelogButton';
import { Hint } from '@/components/ui/tooltip';

const reason = (error: unknown) => error instanceof ApiError ? error.reason ?? error.message : error instanceof Error ? error.message : '更新失败，请重试';
const releaseUrl = (version: string) => `https://github.com/ZhongBiao-zheng/game-atelier/releases/tag/v${encodeURIComponent(version)}`;
interface UpdateContextValue {
  state: UpdateState | null;
  mode: UpdateState['runtime_mode'];
  latest: string | null;
  requestApply: () => void;
  check: () => Promise<void>;
  checking: boolean;
}
const UpdateContext = createContext<UpdateContextValue | null>(null);

export function UpdateProvider({ children, runtimeMode, latestRelease }: {
  children: ReactNode; runtimeMode: 'source' | 'bundle'; latestRelease: string | null;
}) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [pending, setPending] = useState<PendingUpdate | null>(readPendingUpdate);
  const pendingRef = useRef(pending);
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const savePending = useCallback((value: PendingUpdate | null) => {
    pendingRef.current = value;
    setPending(value);
    savePendingUpdate(value);
  }, []);
  const finish = useCallback((message?: string) => {
    savePending(null);
    if (message) setMessage(message);
  }, [savePending]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const operation = pendingRef.current;
      let reachable = false;
      if (operation && updateRecoveryExpired(operation)) {
        finish('服务没有自动恢复，请双击启动器');
      } else {
        try {
          if (operation) {
            const instance = await probeUpdateInstance();
            reachable = true;
            if (!active) return;
            if (instance !== operation.instance) {
              savePending({ ...operation, instance, restartAt: operation.restartAt ?? Date.now() });
              updateNavigation.reload();
              return;
            }
            const result = await fetchUpdateResult(operation.id);
            if (!active) return;
            if (result?.update_id === operation.id && ['succeeded', 'failed', 'cancelled'].includes(result.status)) {
              finish(result.status === 'failed' ? result.reason || '更新失败，已恢复旧版本' : undefined);
            }
          }
          const next = await fetchUpdateState();
          if (!active) return;
          if (next && ['source', 'bundle', 'legacy_bundle'].includes(next.runtime_mode) && typeof next.current === 'string') {
            setState(next);
            const current = pendingRef.current;
            if (current && next.update_id === current.id && next.phase === 'restarting' && !current.restartAt) {
              savePending({ ...current, restartAt: next.restart_started_at ? next.restart_started_at * 1000 : Date.now() });
            } else if (current && next.update_id === current.id && next.phase === 'waiting' && current.restartAt !== null) {
              // A failed identity probe can be transient while the coordinator still drains jobs.
              savePending({ ...current, restartAt: null });
            }
          }
        } catch {
          // A brief restart may happen between two status polls. Start the recovery budget
          // on the first unreachable probe, not when the user begins waiting for jobs.
          const current = pendingRef.current;
          if (active && current && !reachable && !current.restartAt) savePending({ ...current, restartAt: Date.now() });
        }
      }
      if (active) timer = setTimeout(() => void poll(), pendingRef.current ? 2000 : 10_000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [finish, savePending, pending?.id]);

  async function apply() {
    if (submitting || !state?.to) return;
    setSubmitting(true);
    try {
      const instance = await probeUpdateInstance();
      const result = await applyUpdate();
      savePending({ id: result.update_id, instance, to: state.to, restartAt: null, service: state.service_mode });
      setState({ ...state, phase: 'waiting', update_id: result.update_id, maintenance: true });
      setConfirm(false);
    } catch (error) { setConfirm(false); setMessage(reason(error)); }
    finally { setSubmitting(false); }
  }
  async function cancel() {
    try { await cancelUpdate(); finish(); setState(current => current ? { ...current, phase: 'idle', maintenance: false } : current); }
    catch (error) { setMessage(reason(error)); }
  }
  async function check() {
    setChecking(true);
    try { setState(await checkUpdate()); }
    catch (error) { setMessage(reason(error)); }
    finally { setChecking(false); }
  }
  const mode = state?.runtime_mode ?? (runtimeMode === 'bundle' ? 'legacy_bundle' : 'source');
  // 结果到达后弹窗还在退场动画里：沿用最后一次的事务，否则会闪出「等待 0 个任务 / 正在更新到 …」。
  const shownPending = useRef(pending);
  if (pending) shownPending.current = pending;
  const shown = pending ?? shownPending.current;
  const restarting = Boolean(shown?.restartAt);
  return <UpdateContext.Provider value={{ state, mode, latest: latestRelease, requestApply: () => setConfirm(true), check, checking }}>
    {children}
    <Dialog open={confirm} onOpenChange={value => { if (!submitting) setConfirm(value); }}>
      <DialogContent>
        <DialogTitle>更新到 {state?.to}？</DialogTitle>
        <DialogDescription>服务会重启。</DialogDescription>
        {state?.to && <a className="text-sm text-primary hover:underline" href={releaseUrl(state.to)} target="_blank" rel="noopener noreferrer">查看更新内容</a>}
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={submitting} onClick={() => setConfirm(false)}>取消</Button><Button disabled={submitting} onClick={() => void apply()}>更新</Button></div>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(pending)}>
      <DialogContent hideClose data-connection-controls onEscapeKeyDown={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}>
        <DialogTitle>{restarting ? '正在重启…' : `等待 ${state?.waiting ?? 0} 个任务完成`}</DialogTitle>
        <DialogDescription>正在更新到 {shown?.to}…</DialogDescription>
        {!restarting && Boolean(state?.waiting_counts?.approvals) && <p className="text-sm text-muted-foreground">{state?.waiting_counts?.approvals} 个 Agent 操作待确认</p>}
        {!restarting && <div className="flex justify-end"><Button variant="outline" onClick={() => void cancel()}>取消更新</Button></div>}
      </DialogContent>
    </Dialog>
    {message && createPortal(<div data-connection-controls role="alert" className="fixed inset-x-3 bottom-6 z-50 mx-auto flex w-fit max-w-lg items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-sm">
      <span>{message}</span><Button variant="bare" type="button" data-connection-dismiss aria-label="关闭更新提示" className="rounded-sm p-1 text-muted-foreground hover:text-foreground" onClick={() => setMessage(null)}><X className="size-4" aria-hidden /></Button>
    </div>, document.body)}
  </UpdateContext.Provider>;
}

export function UpdateButton({ mobile = false }: { mobile?: boolean }) {
  const update = useContext(UpdateContext);
  if (!update) return null;
  const { state, mode, latest } = update;
  if (mode === 'bundle') return !mobile && state?.status === 'ready' && state.to ? <Hint label={`更新到 ${state.to}`}><Button variant="bare" type="button" onClick={update.requestApply}
    className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><ArrowUp className="size-3.5" aria-hidden />更新</Button></Hint> : null;
  if (!latest) return null;
  const wrapper = mobile ? 'flex justify-end px-3 pb-2 sm:hidden' : 'hidden sm:contents';
  if (mode === 'source') return <span className={wrapper}><Hint label="重新运行一键启动器即可更新"><Button variant="bare" type="button" onClick={() => window.dispatchEvent(new Event(OPEN_CHANGELOG_EVENT))}
    className="shrink-0 rounded-full px-3 py-2 text-xs text-primary hover:bg-secondary/60">新版本 {latest}</Button></Hint></span>;
  return <span className={wrapper}><a href={releaseUrl(latest)} target="_blank" rel="noopener noreferrer" className="shrink-0 rounded-full px-3 py-2 text-xs text-primary hover:bg-secondary/60">有新版本 {latest}</a></span>;
}

export function UpdateSettings() {
  const update = useContext(UpdateContext);
  if (!update || update.mode !== 'bundle') return null;
  const { state, checking } = update;
  const status = state?.status;
  const label = status === 'downloading' ? `正在下载${state?.bytes ? ` · ${(state.bytes / 1024 / 1024).toFixed(1)} MB` : ''}`
    : status === 'checking' || checking ? '正在检查…' : status === 'ready' ? `新版本 ${state?.to} 已就绪`
      : state?.reason || '已是最新版本';
  return <section id="updates" aria-labelledby="updates-title" className="space-y-2">
    <h2 id="updates-title" className="px-1 text-xs font-normal text-muted-foreground">版本更新</h2>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4.5 py-3.5">
      <div className="space-y-1"><p className="text-sm">{state?.current}</p><p className={`text-xs ${status === 'blocked' || status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>{label}</p></div>
      <Button variant="outline" size="sm" disabled={checking || status === 'checking' || status === 'downloading' || state?.maintenance} onClick={() => void update.check()}>重新检查</Button>
    </div>
  </section>;
}
