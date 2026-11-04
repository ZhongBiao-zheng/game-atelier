import { useEffect, useState } from 'react';
import { getManagedGatewayShares, stopManagedGatewayShare, type ManagedGatewayShares } from '@/api/gatewayLibraries';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { date } from './shared';
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;
export function GatewaySharedLibraries() {
  const [state, setState] = useState<ManagedGatewayShares | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const reload = () => { void getManagedGatewayShares().then(value => { if (alive) setState(value); }).catch(() => { if (alive) setError('读取失败'); }); };
    reload(); const timer = window.setInterval(reload, 30000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  return <section aria-label="同事共享" className="space-y-3">
    <div className="flex items-center justify-between"><h3 className="text-sm font-medium">同事共享</h3><span className="text-xs text-muted-foreground">合计 {bytes(state?.size_bytes ?? 0)}</span></div>
    {!state?.libraries.length && <p className="text-sm text-muted-foreground">暂无共享库</p>}
    {state?.libraries.map(library => <div key={library.id} className="flex items-center gap-3 border-b border-border py-3 text-sm">
      <span className="min-w-0 flex-1 truncate">{library.name} · {library.owner_name}</span>
      <span className="text-muted-foreground">{Object.values(library.counts).reduce((a, b) => a + b, 0)} 项 · {bytes(library.size_bytes)} · {date(library.updated_at)}</span>
      <Button size="sm" variant="ghost" onClick={() => setPending(library.id)}>停止共享</Button>
    </div>)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <ConfirmDialog open={pending !== null} title="停止这个共享库？" message="同事将无法继续浏览和使用，分享人需要重新开启共享。" confirmText="停止共享" onCancel={() => setPending(null)} onConfirm={() => {
      const id = pending; setPending(null); if (!id) return;
      void stopManagedGatewayShare(id).then(value => { setState(value); setError(null); }).catch(() => setError('停止共享失败'));
    }} />
  </section>;
}
