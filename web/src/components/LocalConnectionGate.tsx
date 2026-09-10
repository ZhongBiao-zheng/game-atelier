import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useLocation } from 'wouter';
import { localConnection, useConnectionState } from '@/api/connection';
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
    const preventPaste = (event: ClipboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const preventShortcut = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.key === 'Tab' || event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && ['c', 'a'].includes(event.key.toLowerCase()))) return;
      if (['Enter', ' '].includes(event.key) && target?.closest('[data-connection-controls], [data-connection-dismiss]')) return;
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
      {!activated && <main data-connection-controls className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <p role="status" className="text-sm text-pretty">{busy ? '正在启动工坊…' : '暂时无法连接工坊服务'}</p>
          {!busy && <>
            <p className="break-words text-sm text-pretty text-muted-foreground">{connection.message}</p>
            <Button onClick={reconnect}>重试</Button>
          </>}
        </div>
      </main>}
      {activated && (!ready || (viewOnly && !management)) && <div
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
