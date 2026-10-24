import { useEffect, useState } from 'react';
import { fetchGatewayMembers, restoreGatewayMember, type GatewayMembers } from '@/api/gateway';
import { button, date } from './shared';
export function Members({ revision }: { revision: number }) {
  const [state, setState] = useState<GatewayMembers>({ members: [], unavailable_routes: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { let active = true; fetchGatewayMembers().then(data => { if (active) setState(data); }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, [revision]);
  async function restore(modality: string, alias: string) {
    setBusy(`${modality}:${alias}`); setError('');
    try { setState(await restoreGatewayMember(modality, alias)); } catch (e) { setError(String(e)); } finally { setBusy(''); }
  }
  return <section aria-label="供应商状态" className="space-y-3"><h3 className="text-sm font-medium">供应商状态</h3>
    {state.unavailable_routes.length > 0 && <p className="text-xs text-destructive">全部成员不可用：{state.unavailable_routes.map(r => r.name).join('、')}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {!state.members.length && <p className="text-xs text-muted-foreground">暂无欠费供应商</p>}
    {state.members.map(m => <div key={`${m.modality}:${m.alias}`} className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-2">
      <div className="min-w-0 space-y-1 text-xs"><p>{m.alias} · 欠费</p><p className="break-words text-muted-foreground">{m.route_ids.join('、')}</p><p className="text-muted-foreground">自 {date(m.since)} · 下次试探 {date(m.next_probe_at)}</p></div>
      <button className={button} disabled={Boolean(busy)} onClick={() => void restore(m.modality, m.alias)}>恢复</button>
    </div>)}
  </section>;
}
