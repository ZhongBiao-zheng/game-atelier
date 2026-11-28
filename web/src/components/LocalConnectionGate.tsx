import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLocation } from 'wouter';
import { HEARTBEAT_MS, connectionNavigation, localConnection, useConnectionState, type ConnectionSnapshot } from '@/api/connection';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Hint } from '@/components/ui/tooltip';
import { StartupScreen } from '@/components/StartupScreen';
import { MOTION_DURATION, MOTION_EASE, motionAvailable } from '@/lib/motion';
import { notify } from '@/lib/notify';
import { cn } from '@/lib/utils';

/** 断线分级（规格 2.4）：1.5 秒内静默；之后中性胶囊「重连中…」；超过 15 秒或连续失败 4 次转警示并给「立即重试」。 */
const OUTAGE_QUIET_MS = 1500;
const OUTAGE_WARN_MS = 15_000;
const OUTAGE_WARN_FAILURES = 4;
type OutageLevel = 'none' | 'quiet' | 'reconnecting' | 'warning' | 'paused';

function useOutageLevel(connection: ConnectionSnapshot): OutageLevel {
  const outage = connection.phase !== 'ready' && connection.phase !== 'editor_in_use' && connection.outageSince != null;
  const paused = outage && !connection.recovering && connection.phase !== 'connecting';
  const [, tick] = useState(0);
  const since = connection.outageSince ?? 0;
  useEffect(() => {
    if (!outage || paused) return;
    const elapsed = Date.now() - since;
    const timers = [OUTAGE_QUIET_MS, OUTAGE_WARN_MS].filter(at => at > elapsed)
      .map(at => setTimeout(() => tick(value => value + 1), at - elapsed));
    return () => timers.forEach(clearTimeout);
  }, [outage, paused, since]);
  if (!outage) return 'none';
  if (paused) return 'paused';
  const elapsed = Date.now() - since;
  if (elapsed >= OUTAGE_WARN_MS || (connection.failures ?? 0) >= OUTAGE_WARN_FAILURES) return 'warning';
  return elapsed < OUTAGE_QUIET_MS ? 'quiet' : 'reconnecting';
}

/** 浏览器报告的联网状态：本机断网时与「Atelier 服务无响应」「单个供应商故障」分开提示。 */
function useOnline() {
  const [online, setOnline] = useState(() => window.navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(window.navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}
export function LocalConnectionGate({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const connection = useConnectionState();
  const [activated, setActivated] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const immersiveCanvas = /^\/canvas\/[^/]+$/.test(location);
  const editing = !viewOnly;
  const ready = connection.phase === 'ready';
  const level = useOutageLevel(connection);
  const online = useOnline();
  // 启动页：自动重连到警示级或已暂停才露错误与「重试」，之前一律「启动中…」。
  const startupFailed = level === 'warning' || level === 'paused';
  const blocked = !ready || viewOnly;
  const showViewOnly = activated && ready && viewOnly;
  const viewOnlyAnchor = useWordmarkAnchor(showViewOnly && !immersiveCanvas);

  useLayoutEffect(() => { void localConnection.start({ editing }); }, [editing]);
  useEffect(() => {
    const release = () => localConnection.dispose();
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) localConnection.pause('页面已从历史恢复，请重新连接并核对最新内容。');
    };
    window.addEventListener('pagehide', release);
    window.addEventListener('pageshow', restored);
    return () => {
      window.removeEventListener('pagehide', release);
      window.removeEventListener('pageshow', restored);
      localConnection.dispose();
    };
  }, []);
  useEffect(() => { if (ready) setActivated(true); }, [ready]);
  // 服务换了实例且自动接上：轻提示一次，不打断。
  const reconnects = connection.reconnects ?? 0;
  useEffect(() => { if (reconnects > 0) notify.info('Cobrush 服务已重连'); }, [reconnects]);
  useEffect(() => {
    // 页面回到前台、网络恢复时不等退避计时，立刻再试一次。
    const retry = () => { if (window.document.visibilityState === 'visible') localConnection.retryNow(); };
    window.document.addEventListener('visibilitychange', retry);
    window.addEventListener('online', retry);
    return () => {
      window.document.removeEventListener('visibilitychange', retry);
      window.removeEventListener('online', retry);
    };
  }, []);
  const outageNotice = activated && level !== 'none' && level !== 'quiet';
  useEffect(() => {
    if (!blocked) return;
    // 画布的系统菜单粘贴可能以 body 为目标，不能只依赖 React 子树捕获。
    // 连接控件内的输入框（配对码 / 端口）是唯一放行的键入与粘贴目标。
    const controlInput = (target: Element | null) => Boolean(target?.closest('[data-connection-controls]') && target?.matches('input, textarea'));
    const preventPaste = (event: ClipboardEvent) => {
      if (controlInput(event.target instanceof Element ? event.target : null)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const preventShortcut = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.key === 'Tab' || event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && ['c', 'a'].includes(event.key.toLowerCase()))) return;
      if (['Enter', ' '].includes(event.key) && target?.closest('[data-connection-controls], [data-connection-dismiss]')) return;
      if (controlInput(target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener('paste', preventPaste, true);
    window.addEventListener('keydown', preventShortcut, true);
    return () => {
      window.removeEventListener('paste', preventPaste, true);
      window.removeEventListener('keydown', preventShortcut, true);
    };
  }, [blocked]);
  useEffect(() => {
    if (connection.phase === 'editor_in_use') {
      setViewOnly(true);
      void localConnection.start({ editing: false });
    }
  }, [connection.phase]);

  useEffect(() => {
    // 只读页面在前台时定期看一眼编辑权是否空出来（对方关闭或租约过期），空了就自动恢复编辑；
    // 持有编辑权的页面回到前台时立刻续约。后台页面不抢编辑权。
    let cancelled = false;
    const visible = () => window.document.visibilityState === 'visible';
    const acquire = async () => {
      if (visible() && await localConnection.acquireIfFree() && !cancelled) setViewOnly(false);
    };
    const shown = () => {
      if (!visible()) return;
      if (viewOnly) void acquire(); else localConnection.renewNow();
    };
    window.document.addEventListener('visibilitychange', shown);
    const timer = viewOnly && ready ? setInterval(() => { void acquire(); }, HEARTBEAT_MS) : undefined;
    return () => {
      cancelled = true;
      window.document.removeEventListener('visibilitychange', shown);
      clearInterval(timer);
    };
  }, [viewOnly, ready]);

  function reconnect() {
    if (connection.recovering) localConnection.retryNow();
    else void localConnection.start({ editing });
  }
  function takeover() {
    setConfirmTakeover(false);
    setViewOnly(false);
    void localConnection.start({ editing: true, takeover: true });
  }
  // 表单禁用之外还要阻止画布拖动、快捷键和富文本输入；保留原生滚动与文本选取。
  const safeClose = (event: SyntheticEvent) => event.target instanceof Element && Boolean(event.target.closest('[data-connection-dismiss]'));
  const stopEditing = blocked ? (event: SyntheticEvent) => { if (!safeClose(event)) event.stopPropagation(); } : undefined;
  const preventEditing = blocked ? (event: SyntheticEvent) => {
    if (!safeClose(event)) { event.preventDefault(); event.stopPropagation(); }
  } : undefined;

  return (
    <>
      <fieldset disabled={blocked} className="m-0 min-w-0 border-0 p-0"
        aria-busy={!ready} onPointerDownCapture={stopEditing} onKeyDownCapture={stopEditing}
        onClickCapture={preventEditing} onChangeCapture={preventEditing}
        onBeforeInputCapture={preventEditing} onDropCapture={preventEditing} onSubmitCapture={preventEditing}>
        {activated && children}
      </fieldset>
      {!activated && <StartupScreen label={startupFailed ? '暂时无法连接 Cobrush 服务' : '启动中…'}>
        {startupFailed && <>
          <p className="break-words text-sm text-pretty text-muted-foreground">{connection.message}</p>
          <div className="flex justify-center gap-2">
            <Button onClick={reconnect}>重试</Button>
          </div>
        </>}
      </StartupScreen>}
      <AnimatePresence>
        {outageNotice ? <OutageCapsule key="outage" level={level} connection={connection} onRetry={reconnect} />
          : activated && ready && !online && <StatusCapsule key="offline" tone="warning"><p role="status">网络已断开</p></StatusCapsule>}
      </AnimatePresence>
      {/* 只读是常驻状态而非故障：顶栏字标右侧的胶囊，不压导航。它必须留在 fieldset 之外
          （disabled fieldset 会连带禁用里面的按钮），所以用 fixed 贴在字标实际的右边缘后面，而不是渲染进顶栏。
          画布编辑器没有顶栏，仍居中。 */}
      <AnimatePresence>
      {showViewOnly && <Hint key="view-only" label="另一页面正在编辑"><motion.div
        data-connection-controls
        // 与断线胶囊同一套进退场：200ms 落位淡入，150ms 淡出。
        initial={motionAvailable() ? { opacity: 0, y: -4 } : false}
        animate={{ opacity: 1, y: 0, transition: { duration: MOTION_DURATION.base, ease: MOTION_EASE.out } }}
        exit={motionAvailable() ? { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } } : undefined}
        className={`fixed z-50 flex h-10 items-center gap-2.5 rounded-full border border-border bg-glass pl-1.5 pr-1.5 text-sm backdrop-blur-glass sm:pl-3.5 ${immersiveCanvas ? 'inset-x-3 top-3 mx-auto w-fit' : viewOnlyAnchor ? '' : 'left-20 top-2 sm:left-24 lg:left-32 lg:top-5'}`}
        style={viewOnlyAnchor && !immersiveCanvas ? { left: viewOnlyAnchor.left, top: viewOnlyAnchor.top } : { marginTop: 'env(safe-area-inset-top)' }}>
        <span aria-hidden className="hidden size-1.5 rounded-full bg-status-running sm:block" />
        <p role="status" className="hidden sm:block">只读</p>
        {/* 手机宽度下字标与右侧按钮之间只容得下两个字 */}
        <Button variant="secondary" size="sm" aria-label="接管编辑" className="h-7 rounded-full px-3 text-xs" onClick={() => setConfirmTakeover(true)}>
          <span className="sm:hidden">接管</span><span className="hidden sm:inline">接管编辑</span>
        </Button>
      </motion.div></Hint>}
      </AnimatePresence>
      <Dialog open={confirmTakeover} onOpenChange={setConfirmTakeover}>
        <DialogContent data-connection-controls onOpenAutoFocus={event => { event.preventDefault(); cancelRef.current?.focus(); }}>
          <DialogTitle>接管编辑？</DialogTitle>
          <DialogDescription>接管后，另一页面将暂停编辑。它可能仍有未保存的内容。</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button ref={cancelRef} variant="outline" onClick={() => setConfirmTakeover(false)}>取消</Button>
            <Button onClick={takeover}>接管编辑</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 顶栏字标右边缘后 12px、与字标垂直居中的位置（胶囊高 40px）；字标随窗口宽度、字体加载、桌面版标题栏避让变化时跟着重算。
 *  找不到字标（没有顶栏）时返回 null。 */
function useWordmarkAnchor(active: boolean) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    let cleanup = () => {};
    const attach = (mark: HTMLElement) => {
      const place = () => {
        const rect = mark.getBoundingClientRect();
        setAnchor(current => {
          const next = { left: Math.round(rect.right + 12), top: Math.round(rect.top + rect.height / 2 - 20) };
          return current && current.left === next.left && current.top === next.top ? current : next;
        });
      };
      place();
      const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
      resizes?.observe(mark);
      window.addEventListener('resize', place);
      cleanup = () => { resizes?.disconnect(); window.removeEventListener('resize', place); };
    };
    const found = document.querySelector<HTMLElement>('.brand-wordmark');
    if (found) attach(found);
    else {
      // 只读可能在顶栏挂上之前就成立（启动接力、换页）：等字标出现再定位，不落回固定偏移。
      setAnchor(null);
      const watcher = new MutationObserver(() => {
        const mark = document.querySelector<HTMLElement>('.brand-wordmark');
        if (!mark) return;
        watcher.disconnect();
        attach(mark);
      });
      watcher.observe(document.body, { childList: true, subtree: true });
      cleanup = () => watcher.disconnect();
    }
    return () => cleanup();
  }, [active]);
  return active ? anchor : null;
}

function StatusCapsule({ tone, children }: { tone: 'neutral' | 'warning'; children: ReactNode }) {
  return <motion.div
    data-connection-controls
    initial={{ opacity: 0, y: -4 }}
    animate={{ opacity: 1, y: 0, transition: { duration: MOTION_DURATION.base, ease: MOTION_EASE.out } }}
    exit={{ opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } }}
    className={cn(
      'fixed inset-x-3 top-3 z-50 mx-auto flex min-h-9 w-fit max-w-full flex-wrap items-center justify-center gap-2.5 rounded-full border bg-popover py-1 pl-3.5 pr-1 text-sm',
      tone === 'warning' ? 'border-status-running/50 text-foreground' : 'border-border text-muted-foreground',
    )}
    style={{ marginTop: 'env(safe-area-inset-top)' }}>
    <span aria-hidden className={cn('size-1.5 rounded-full', tone === 'warning' ? 'bg-status-running' : 'bg-status-pending')} />
    {children}
  </motion.div>;
}

/** 断线胶囊：重连中（中性）→ 无响应（警示 +「立即重试」）→ 已暂停（需要人处理）。 */
function OutageCapsule({ level, connection, onRetry }: { level: OutageLevel; connection: ConnectionSnapshot; onRetry: () => void }) {
  if (connection.versionConflict) {
    return <StatusCapsule tone="warning">
      <p role="status" className="text-pretty">{connection.message}</p>
      <Button variant="outline" size="sm" className="h-7 rounded-full" onClick={() => connectionNavigation.reload()}>刷新页面</Button>
      <Button size="sm" className="h-7 rounded-full" onClick={onRetry}>继续编辑</Button>
    </StatusCapsule>;
  }
  if (level === 'reconnecting') {
    return <StatusCapsule tone="neutral"><p role="status" className="pr-2.5">重连中…</p></StatusCapsule>;
  }
  const paused = level === 'paused';
  return <StatusCapsule tone="warning">
    <p role="status" className="text-pretty">{paused ? connection.message ?? 'Cobrush 服务连接已暂停' : 'Cobrush 服务无响应'}</p>
    <Button variant="outline" size="sm" className="h-7 rounded-full" onClick={onRetry}>{paused ? '重新连接' : '立即重试'}</Button>
  </StatusCapsule>;
}
