import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { ChevronRight } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { providerLabel } from '@/lib/providerLabels';
import type { KeyRow } from './KeyCard';

export function providerHost(row: KeyRow) {
  try { return new URL(row.base_url || row.homepage_url || '').host; }
  catch { return ''; }
}

export function ProviderRow({ row, overdue, pending, onEdit, onToggle }: {
  row: KeyRow; overdue: boolean; pending: boolean;
  onEdit: () => void; onToggle: (enabled: boolean) => void;
}) {
  const enabled = row.enabled !== false;
  const elapsed = row.last_used_at ? Math.max(0, Date.now() - Date.parse(row.last_used_at)) : null;
  const days = elapsed === null ? null : Math.floor(elapsed / 86400000);
  const idle = elapsed !== null && elapsed > 30 * 86400000;
  const status = !enabled ? '已停用' : overdue ? '欠费'
    : days === null ? '未用过' : idle ? `${days} 天未用` : '正常';
  const vendor = providerLabel(row.provider, row.alias);
  const tone = !enabled ? 'text-muted-foreground' : overdue ? 'text-[color:var(--status-failed)]'
    : days === null || idle ? 'text-muted-foreground' : 'text-[color:var(--status-done)]';
  const used = row.last_used_at ? new Date(row.last_used_at) : null;
  const today = used?.toDateString() === new Date().toDateString();
  return <li className={`flex flex-wrap items-center gap-3.5 px-4 py-3.5 hover:bg-secondary/30 ${enabled ? '' : 'opacity-50'}`}>
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-medium"><ProviderBrandIcon provider={row} /></span>
    <button type="button" aria-label={`编辑 ${row.alias}`} onClick={onEdit}
      className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <span className="block truncate text-sm font-medium">{row.provider === 'chatgpt' ? vendor : row.alias}</span>
      <span className="mt-1 block truncate text-xs text-muted-foreground" title={row.base_url ?? ''}>
        {[row.provider === 'custom' ? '自定义' : vendor, providerHost(row), `${row.models?.length ?? 0} 个模型`].filter(Boolean).join(' · ')}
      </span>
    </button>
    <div className="order-last flex w-full items-center justify-between gap-3 pl-[52px] text-xs sm:order-none sm:w-auto sm:pl-0">
      <span className="flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-muted-foreground">
        <span aria-hidden className={`size-1.5 rounded-full bg-current ${tone}`} />{status}
      </span>
      <span className="whitespace-nowrap text-right text-muted-foreground sm:w-28" title={used?.toLocaleString('zh-CN')}>
        {!used ? '—' : today ? `今天 ${used.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
          : used.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}
      </span>
    </div>
    <Switch compact checked={enabled} disabled={pending} label={`启用 ${row.alias}`} onChange={onToggle} />
    <button type="button" aria-label={`打开 ${row.alias}`} onClick={onEdit}
      className="rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <ChevronRight className="size-4" aria-hidden />
    </button>
  </li>;
}
