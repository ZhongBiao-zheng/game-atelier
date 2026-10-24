import { useEffect, useMemo, useState } from 'react';
import { fetchGatewayUsage, type GatewayUsageRow } from '@/api/gateway';
import { formatGenerationCost } from '@/lib/generationCost';
import { Input } from '@/components/ui/input';

export function summarizeUsage(rows: GatewayUsageRow[], group: 'person' | 'model' = 'person') {
  const result = new Map<string, { name: string; calls: number; success: number; failed: number; cost: number; unpriced: number }>();
  for (const row of rows) {
    const id = group === 'person' ? row.key_id : `${['image_edit', 'layer_split'].includes(row.kind) ? 'image' : row.kind}:${row.route_id}`;
    const item = result.get(id) ?? { name: group === 'person' ? row.key_name : row.route_id, calls: 0, success: 0, failed: 0, cost: 0, unpriced: 0 };
    item.calls++; item.success += Number(row.status === 'done'); item.failed += Number(row.status === 'failed');
    item.cost = Math.round((item.cost + row.charged_cny) * 1e6) / 1e6;
    item.unpriced += Number(row.estimated_cny == null && row.actual_cost_cny == null);
    result.set(id, item);
  }
  return result;
}
export function Usage({ revision }: { revision: number }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const [group, setGroup] = useState<'person' | 'model'>('person');
  const [rows, setRows] = useState<GatewayUsageRow[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; setError('');
    if (month) fetchGatewayUsage(month).then(data => { if (active) setRows(data); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [month, revision]);
  const summary = useMemo(() => summarizeUsage(rows, group), [rows, group]);
  return <section className="space-y-3" aria-label="用量">
    <div className="flex flex-wrap items-center gap-3"><h3 className="text-sm font-medium">用量</h3>
      <Input type="month" aria-label="用量月份" value={month} onChange={e => setMonth(e.target.value)} className="w-40" />
      <select aria-label="用量分组" value={group} onChange={e => setGroup(e.target.value as 'person' | 'model')} className="rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"><option value="person">按人</option><option value="model">按模型</option></select>
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <div className="overflow-x-auto"><table className="w-full text-left text-xs tabular-nums">
      <thead className="text-muted-foreground"><tr>{['名称', '次数', '成功', '失败', '金额', '未计价'].map(h => <th className="px-2 py-2 font-normal" key={h}>{h}</th>)}</tr></thead>
      <tbody>{[...summary].map(([id, row]) => <tr className="border-t border-border" key={id}><td className="max-w-48 truncate px-2 py-2" title={row.name}>{row.name}</td><td>{row.calls}</td><td>{row.success}</td><td>{row.failed}</td><td>{formatGenerationCost(row.cost)}</td><td>{row.unpriced} 次</td></tr>)}</tbody>
    </table>{!rows.length && <p className="py-3 text-xs text-muted-foreground">暂无用量</p>}</div>}
  </section>;
}
