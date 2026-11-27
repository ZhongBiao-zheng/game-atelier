import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { CheckIcon, ChevronRightIcon } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';
import { providerLabel } from '@/lib/providerLabels';
import type { ComfyStatus } from '@/lib/useComfyStatus';
import type { KeyRow } from './KeyCard';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

export function providerHost(row: KeyRow) {
  try { return new URL(row.base_url || row.homepage_url || '').host; }
  catch { return ''; }
}

export function ProviderRow({ row, overdue, pending, saved = false, comfyStatus, onEdit, onToggle }: {
  row: KeyRow; overdue: boolean; pending: boolean; saved?: boolean;
  comfyStatus?: ComfyStatus;
  onEdit: () => void; onToggle: (enabled: boolean) => void;
}) {
  const enabled = row.enabled !== false;
  const elapsed = row.last_used_at ? Math.max(0, Date.now() - Date.parse(row.last_used_at)) : null;
  const days = elapsed === null ? null : Math.floor(elapsed / 86400000);
  const idle = elapsed !== null && elapsed > 30 * 86400000;
  const comfyLive = row.provider === 'comfyui' && enabled && !overdue ? comfyStatus : undefined;
  const status = !enabled ? '已停用' : overdue ? '欠费'
    : comfyLive === 'running' ? '运行中'
      : comfyLive === 'stopped' ? '未启动'
        : comfyLive === 'checking' ? '检查中…'
          : days === null ? '未用过' : idle ? `${days} 天未用` : '正常';
  const vendor = providerLabel(row.provider, row.alias);
  const tone = !enabled ? 'text-muted-foreground' : overdue ? 'text-[color:var(--status-failed)]'
    : comfyLive === 'running' ? 'text-[color:var(--status-done)]'
      : comfyLive === 'stopped' ? 'text-[color:var(--status-failed)]'
        : comfyLive === 'checking' ? 'text-muted-foreground'
          : days === null || idle ? 'text-muted-foreground' : 'text-[color:var(--status-done)]';
  const used = row.last_used_at ? new Date(row.last_used_at) : null;
  const today = used?.toDateString() === new Date().toDateString();
  const title = row.provider === 'chatgpt' ? vendor : row.alias;
  const rawType = row.provider === 'custom' ? '自定义' : vendor;
  const showType = rawType.trim().toLowerCase() !== title.trim().toLowerCase();
  const host = providerHost(row);
  // 启停是乐观的：整行立刻 200ms 淡到停用态，请求期间开关照常可点（aria-busy 标出保存中），失败由列表回滚。
  return <li aria-busy={pending || undefined} className={`flex flex-wrap items-center gap-3.5 px-4 py-3.5 transition-[opacity,background-color] duration-200 hover:bg-secondary/30 ${enabled ? '' : 'opacity-50'}`}>
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-medium"><ProviderBrandIcon provider={row} /></span>
    <Button variant="bare" type="button" aria-label={`编辑 ${row.alias}`} onClick={onEdit}
      className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium"><span className="truncate">{title}</span>
        {saved && <CheckIcon size="sm" role="img" aria-label="已保存" className="pop-in shrink-0 text-[color:var(--status-done)]" />}</span>
      <Hint label={row.base_url ?? ''}><span className="mt-1 block truncate text-xs text-muted-foreground">
        {[showType ? rawType : '', host, `${row.models?.length ?? 0} 个${row.provider === 'comfyui' ? '工作流' : '模型'}`].filter(Boolean).join(' · ')}
      </span></Hint>
    </Button>
    <div className="order-last flex w-full items-center justify-between gap-3 pl-13 text-xs sm:order-none sm:w-auto sm:pl-0">
      <span className="flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-muted-foreground">
        <span aria-hidden className={`size-1.5 rounded-full bg-current ${tone}`} />{status}
      </span>
      <Hint label={used?.toLocaleString('zh-CN')}><span className="whitespace-nowrap text-right text-muted-foreground sm:w-28">
        {!used ? '—' : today ? `今天 ${used.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
          : used.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}
      </span></Hint>
    </div>
    <Switch size="sm" checked={enabled} aria-label={`启用 ${row.alias}`} onCheckedChange={onToggle} />
    <Button variant="bare" type="button" aria-label={`打开 ${row.alias}`} onClick={onEdit}
      className="rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <ChevronRightIcon aria-hidden />
    </Button>
  </li>;
}
