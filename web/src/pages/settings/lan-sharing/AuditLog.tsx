import { useEffect, useState } from 'react';
import { adminBase } from '@/api/gateway';
import { requestJson } from '@/api/http';
import { date } from './shared';
import { Button } from '@/components/ui/button';
interface Entry { time: string; actor_name: string; action: string; target_id: string; summary: Record<string, unknown> }
const actions: Record<string, string> = { 'member.create': '新建成员', 'member.update': '修改成员', 'member.revoke': '撤销成员', 'upstream.restore': '恢复供应商', 'route.reorder': '调整路由' };
export function AuditLog({ gatewayAlias }: { gatewayAlias?: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    requestJson<{ entries: Entry[] }>(`${gatewayAlias ? adminBase(gatewayAlias) : '/api/gateway'}/audit`, '读取操作日志')
      .then(data => { if (active) { setEntries(data.entries); setError(''); } })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [gatewayAlias, revision]);
  return <section className="space-y-3" aria-label="操作日志">
    <div className="flex items-center justify-between"><h3 className="text-sm font-medium">操作日志</h3><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>刷新</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!entries.length && !error && <p className="text-sm text-muted-foreground">暂无操作记录</p>}
    <ul className="divide-y divide-border">{entries.map((entry, index) => <li key={`${entry.time}:${index}`} className="space-y-2 py-3 text-xs">
      <div className="flex flex-wrap gap-3"><time className="text-muted-foreground">{date(entry.time)}</time><span>{entry.actor_name === 'local' ? '本机' : entry.actor_name}</span><span>{actions[entry.action] ?? entry.action}</span><span className="break-all text-muted-foreground">{entry.target_id}</span></div>
      <details><summary className="cursor-pointer text-muted-foreground">变更详情</summary><pre className="overflow-x-auto whitespace-pre-wrap break-all py-2 text-xs">{JSON.stringify(entry.summary, null, 2)}</pre></details>
    </li>)}</ul>
  </section>;
}
