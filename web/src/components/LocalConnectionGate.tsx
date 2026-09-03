import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { localConnection, useConnectionState } from '@/api/connection';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

export function LocalConnectionGate({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const connection = useConnectionState();
  const [activated, setActivated] = useState(false);
  const [epoch, setEpoch] = useState(0);
  // 用户点「取消」后弹窗收起、页面原样保留；重新连上后复位，下一次中断再弹。
  const [dismissed, setDismissed] = useState(false);
  const editing = !location.startsWith('/connection');
  const ready = connection.phase === 'ready';
  const busy = connection.phase === 'idle' || connection.phase === 'connecting';

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
  useEffect(() => { if (ready) { setActivated(true); setDismissed(false); } }, [ready]);

  async function reconnect() {
    setDismissed(false);
    await localConnection.start({ editing, takeover: connection.phase === 'editor_in_use' });
    if (localConnection.getSnapshot().phase === 'ready' && activated) setEpoch(value => value + 1);
  }

  const reconnectLabel = connection.phase === 'editor_in_use' ? '接管并加载' : activated ? '重新连接' : '重试连接';

  return (
    <>
      <div>{activated && <div key={epoch}>{children}</div>}</div>
      {!ready && !busy && dismissed && (
        <div className="fixed bottom-4 right-4 z-40 flex items-center gap-3 rounded-full border border-border bg-glass px-4 py-2 text-sm backdrop-blur-glass">
          <span className="text-muted-foreground">本机连接已暂停</span>
          <button type="button" onClick={() => void reconnect()} className="text-primary hover:underline">{reconnectLabel}</button>
        </div>
      )}
      <Dialog open={!ready && !dismissed}>
        <DialogContent hideClose onEscapeKeyDown={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}>
          <DialogTitle>{busy ? '连接本机工坊' : connection.phase === 'editor_in_use' ? '另一个页面正在编辑' : '本机连接已暂停'}</DialogTitle>
          <DialogDescription>
            {busy ? '正在连接本机服务…' : connection.message}
            {!busy && connection.phase === 'editor_in_use' && ' 接管后，旧页面将暂停编辑；它可能仍有未保存的内容。'}
          </DialogDescription>
          {!busy && <div className="flex flex-wrap justify-end gap-2">
            {!activated && editing && <Link href="/connection" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">仅管理连接</Link>}
            {activated && <button type="button" onClick={() => setDismissed(true)} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">取消</button>}
            <button type="button" onClick={() => void reconnect()} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">
              {reconnectLabel}
            </button>
          </div>}
        </DialogContent>
      </Dialog>
    </>
  );
}
