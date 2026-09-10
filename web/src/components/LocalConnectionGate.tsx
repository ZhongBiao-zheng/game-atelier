import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode, type SyntheticEvent } from 'react';
import { useLocation } from 'wouter';
import { localConnection, siteBaseForPort, useConnectionState } from '@/api/connection';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

export function LocalConnectionGate({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const connection = useConnectionState();
  const [activated, setActivated] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const management = location.startsWith('/connection');
  const editing = !viewOnly && !management;
  const ready = connection.phase === 'ready';
  const unpaired = connection.phase === 'unpaired';
  const busy = connection.phase === 'idle' || connection.phase === 'connecting' || connection.recovering;
  const blocked = !ready || (viewOnly && !management);

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

  function reconnect() {
    void localConnection.start({ editing });
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
      {unpaired && <SitePairingForm key={connection.generation} message={connection.message} />}
      {!activated && !unpaired && <main data-connection-controls className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <p role="status" className="text-sm text-pretty">{busy ? '正在启动工坊…' : '暂时无法连接工坊服务'}</p>
          {!busy && <>
            <p className="break-words text-sm text-pretty text-muted-foreground">{connection.message}</p>
            <div className="flex justify-center gap-2">
              <Button onClick={reconnect}>重试</Button>
              {localConnection.hosted && <Button variant="outline" onClick={() => void localConnection.disconnect()}>重新配对</Button>}
            </div>
          </>}
        </div>
      </main>}
      {activated && !unpaired && (!ready || (viewOnly && !management)) && <div
        data-connection-controls
        className="fixed inset-x-3 top-3 z-50 mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-3 rounded-lg border border-border bg-popover px-4 py-2 text-sm"
        style={{ marginTop: 'env(safe-area-inset-top)' }}>
        <div role="status" className="min-w-0 flex-1">
          <p className="text-pretty">{ready ? '只读 · 另一页面正在编辑' : busy ? '正在恢复工坊连接…' : '工坊服务连接已暂停'}</p>
          {!ready && <p className="text-xs text-pretty text-muted-foreground">{busy ? '暂时无法保存，请勿关闭页面。' : connection.message}</p>}
        </div>
        {ready ? <Button variant="outline" size="sm" onClick={() => setConfirmTakeover(true)}>接管编辑</Button>
          : !busy && <Button variant="outline" size="sm" onClick={reconnect}>重新连接</Button>}
      </div>}
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

const PORT_KEY = 'atelier-site-port';

/** 托管网站的配对页：只连用户填写的回环端口，配对码来自本机页面，不经 URL 传递。 */
function SitePairingForm({ message }: { message: string | null }) {
  const [port, setPort] = useState(() => { try { return sessionStorage.getItem(PORT_KEY) ?? '5174'; } catch { return '5174'; } });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(message);
  let localPage: string | null = null;
  try { localPage = `${siteBaseForPort(port)}/connection?site=${encodeURIComponent(window.location.origin)}`; } catch { /* 端口未填好前不给链接。 */ }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      try { sessionStorage.setItem(PORT_KEY, port); } catch { /* 存不了也不影响本次连接。 */ }
      await localConnection.pair({ port, code });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); }
  }

  const field = 'block w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
  return <main data-connection-controls className="flex min-h-dvh items-center justify-center p-6">
    <form onSubmit={event => void submit(event)} className="w-full max-w-sm space-y-5">
      <div className="space-y-1">
        <h1 className="font-display text-display">连接本机工坊</h1>
        <p className="text-sm text-muted-foreground">数据留在你的电脑上，网站只提供界面。</p>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>在本机启动工坊，打开{localPage
          ? <a href={localPage} target="_blank" rel="noreferrer" className="underline underline-offset-4">本机连接页</a>
          : '本机连接页'}生成配对码。</li>
        <li>把配对码填到下面。</li>
      </ol>
      <label className="block space-y-2 text-sm"><span>本机端口</span>
        <input inputMode="numeric" autoComplete="off" value={port} onChange={event => setPort(event.target.value.trim())} className={field} /></label>
      <label className="block space-y-2 text-sm"><span>配对码</span>
        <input autoFocus autoComplete="off" spellCheck={false} value={code} onChange={event => setCode(event.target.value)} className={`${field} font-mono`} /></label>
      {error && <p role="alert" className="text-sm text-pretty text-destructive">{error}</p>}
      <Button type="submit" disabled={busy || !code.trim()}>{busy ? '连接中…' : '连接'}</Button>
    </form>
  </main>;
}
