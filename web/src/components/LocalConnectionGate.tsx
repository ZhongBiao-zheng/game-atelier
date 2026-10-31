import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { useLocation } from 'wouter';
import { localConnection, useConnectionState } from '@/api/connection';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Hint } from '@/components/ui/tooltip';

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
  const busy = connection.phase === 'idle' || connection.phase === 'connecting' || connection.recovering;
  const blocked = !ready || viewOnly;

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
      {!activated && <main data-connection-controls className="flex min-h-dvh items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <p role="status" className="text-sm text-pretty">{busy ? '正在启动Atelier…' : '暂时无法连接Atelier服务'}</p>
          {!busy && <>
            <p className="break-words text-sm text-pretty text-muted-foreground">{connection.message}</p>
            <div className="flex justify-center gap-2">
              <Button onClick={reconnect}>重试</Button>
            </div>
          </>}
        </div>
      </main>}
      {activated && !ready && <div
        data-connection-controls
        className="fixed inset-x-3 top-3 z-50 mx-auto flex w-fit max-w-full flex-wrap items-center justify-center gap-3 rounded-lg border border-border bg-popover px-4 py-2 text-sm"
        style={{ marginTop: 'env(safe-area-inset-top)' }}>
        <div role="status" className="min-w-0 flex-1">
          <p className="text-pretty">{busy ? '正在恢复Atelier连接…' : 'Atelier服务连接已暂停'}</p>
          <p className="text-xs text-pretty text-muted-foreground">{busy ? '暂时无法保存，请勿关闭页面。' : connection.message}</p>
        </div>
        {!busy && <Button variant="outline" size="sm" onClick={reconnect}>重新连接</Button>}
      </div>}
      {/* 只读是常驻状态而非故障：顶栏字标右侧的胶囊，不压导航。它必须留在 fieldset 之外
          （disabled fieldset 会连带禁用里面的按钮），所以用 fixed 对齐顶栏而不是渲染进顶栏。
          画布编辑器没有顶栏，仍居中。 */}
      {activated && ready && viewOnly && <Hint label="另一页面正在编辑"><div
        data-connection-controls
        className={`fixed z-50 flex h-10 items-center gap-2.5 rounded-full border border-border bg-glass pl-1.5 pr-1.5 text-sm backdrop-blur-glass sm:pl-3.5 ${immersiveCanvas ? 'inset-x-3 top-3 mx-auto w-fit' : 'left-20 top-2 sm:left-24 lg:left-32 lg:top-5'}`}
        style={{ marginTop: 'env(safe-area-inset-top)' }}>
        <span aria-hidden className="hidden size-1.5 rounded-full bg-status-running sm:block" />
        <p role="status" className="hidden sm:block">只读</p>
        {/* 手机宽度下字标与版本号之间只容得下两个字 */}
        <Button variant="secondary" size="sm" aria-label="接管编辑" className="h-7 rounded-full px-3 text-xs" onClick={() => setConfirmTakeover(true)}>
          <span className="sm:hidden">接管</span><span className="hidden sm:inline">接管编辑</span>
        </Button>
      </div></Hint>}
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
