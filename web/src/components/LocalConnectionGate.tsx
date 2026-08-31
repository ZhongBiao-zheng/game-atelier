import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { localConnection, useConnectionState } from '@/api/connection';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { LocalDraftExportContext, downloadLocalDraft, type LocalDraftFactory } from '@/components/LocalDraftExportContext';

export function LocalConnectionGate({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const connection = useConnectionState();
  const [activated, setActivated] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [copied, setCopied] = useState(false);
  const [draftFactory, setDraftFactory] = useState<LocalDraftFactory | null>(null);
  const registerDraft = useCallback((factory: LocalDraftFactory) => {
    setDraftFactory(() => factory);
    return () => setDraftFactory(current => current === factory ? null : current);
  }, []);
  const content = useRef<HTMLDivElement>(null);
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
  useEffect(() => { if (ready) setActivated(true); }, [ready]);

  async function reconnect() {
    await localConnection.start({ editing, takeover: connection.phase === 'editor_in_use' });
    if (localConnection.getSnapshot().phase === 'ready' && activated) setEpoch(value => value + 1);
  }

  async function copyDrafts() {
    const values = Array.from(content.current?.querySelectorAll('textarea, [contenteditable="true"]') ?? [])
      .map(element => element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '')
      .filter(value => value.trim());
    try {
      await navigator.clipboard.writeText(values.join('\n\n').slice(0, 250_000));
      setCopied(true);
    } catch { setCopied(false); }
  }

  return (
    <>
      <LocalDraftExportContext.Provider value={registerDraft}>
        <div ref={content}>{activated && <div key={epoch}>{children}</div>}</div>
      </LocalDraftExportContext.Provider>
      <Dialog open={!ready}>
        <DialogContent hideClose onEscapeKeyDown={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}>
          <DialogTitle>{busy ? '连接本机工坊' : connection.phase === 'editor_in_use' ? '另一个页面正在编辑' : '本机连接已暂停'}</DialogTitle>
          <DialogDescription>
            {busy ? '正在连接本机服务…' : connection.message}
            {!busy && connection.phase === 'editor_in_use' && ' 接管后，旧页面将暂停编辑；它可能仍有未保存的内容。'}
            {!busy && activated && ' 当前页面和草稿已保留。重新连接将加载服务端内容，请先复制需要保留的可见文本。'}
            {!busy && draftFactory && ' 画布可另存 JSON 草稿，包含节点和连线，不含媒体文件；它不是可直接导入的项目包。'}
          </DialogDescription>
          {!busy && <div className="flex flex-wrap justify-end gap-2">
            {!activated && editing && <Link href="/connection" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">仅管理连接</Link>}
            {draftFactory && <button type="button" onClick={() => {
              const snapshot = draftFactory();
              if (snapshot) downloadLocalDraft(snapshot);
            }} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">导出画布草稿</button>}
            {activated && <button type="button" onClick={() => void copyDrafts()} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
              {copied ? '已复制可见文本' : '复制可见草稿'}
            </button>}
            <button type="button" onClick={() => void reconnect()} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">
              {connection.phase === 'editor_in_use' ? '接管并加载' : activated ? '重新连接并加载' : '重试连接'}
            </button>
          </div>}
        </DialogContent>
      </Dialog>
    </>
  );
}
