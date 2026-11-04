import { useEffect, useState } from 'react';
import { getManagedGatewayShares, stopManagedGatewayShare, type ManagedGatewayShares } from '@/api/gatewayLibraries';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { date } from './shared';
function bytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0;
  return `${unit === 0 ? value : (value / 1024 ** unit).toFixed(1)} ${units[unit]}`;
}
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
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-left text-xs" aria-label="同事共享库">
        <thead className="border-b border-border text-muted-foreground"><tr>
          {['库名', '分享人', '条目数', '占用', '更新时间', '操作'].map(label => <th key={label} className="whitespace-nowrap px-4 py-3 font-medium">{label}</th>)}
        </tr></thead>
        <tbody>
          {!state?.libraries.length && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">暂无共享库</td></tr>}
          {state?.libraries.map(library => <tr key={library.id} className="border-t border-border">
            <td className="px-4 py-3">{library.name}</td>
            <td className="whitespace-nowrap px-4 py-3">{library.owner_name}</td>
            <td className="px-4 py-3 tabular-nums">{Object.values(library.counts).reduce((a, b) => a + b, 0)}</td>
            <td className="whitespace-nowrap px-4 py-3 tabular-nums">{bytes(library.size_bytes)}</td>
            <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{date(library.updated_at)}</td>
            <td className="w-px whitespace-nowrap px-4 py-3"><Button size="sm" variant="outline" className="h-7 rounded-full px-2.5 text-xs" onClick={() => setPending(library.id)}>停止共享</Button></td>
          </tr>)}
        </tbody>
      </table>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <ConfirmDialog open={pending !== null} title="停止这个共享库？" message="同事将无法继续浏览和使用，分享人需要重新开启共享。" confirmText="停止共享" onCancel={() => setPending(null)} onConfirm={() => {
      const id = pending; setPending(null); if (!id) return;
      void stopManagedGatewayShare(id).then(value => { setState(value); setError(null); }).catch(() => setError('停止共享失败'));
    }} />
  </section>;
}
