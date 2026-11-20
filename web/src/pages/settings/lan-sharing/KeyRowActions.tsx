import { useState } from 'react';
import { MoreIcon } from '@/components/ui/icons';
import type { GatewayKey, GatewayKeyInput, GatewayOptions, LimitPeriod } from '@/api/gateway';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Hint } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { PERIODS } from './shared';
import { KeyScopePicker } from './KeyScopePicker';

const reveal = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100';
export function KeyRowActions({ record, options, busy, onSave, onRename, onReset, onRevoke }: {
  record: GatewayKey; options: GatewayOptions; busy: boolean;
  onSave: (patch: Partial<GatewayKeyInput>) => Promise<boolean>;
  onRename: () => void; onReset: () => void; onRevoke: () => void;
}) {
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [limitError, setLimitError] = useState('');
  const [limitsOpen, setLimitsOpen] = useState(false);
  return <div className="flex items-center justify-end gap-1 whitespace-nowrap">
    <KeyScopePicker record={record} options={options} busy={busy} onSave={onSave} />
    <Popover open={limitsOpen} onOpenChange={open => {
      if (open) { setLimits(Object.fromEntries(record.limits.map(l => [l.period, String(l.cap_cny)]))); setLimitError(''); }
      else {
        const next = (Object.keys(PERIODS) as LimitPeriod[]).filter(p => limits[p]?.trim()).map(period => ({ period, cap_cny: Number(limits[period]) }));
        if (next.some(l => !Number.isFinite(l.cap_cny) || l.cap_cny <= 0 || l.cap_cny > 1000000)) { setLimitError('额度须大于 0 且不超过 100 万'); return; }
        if (JSON.stringify(next) !== JSON.stringify(record.limits)) void onSave({ limits: next });
      }
      setLimitsOpen(open);
    }}>
      <Hint label="设置此密钥的消费额度"><PopoverTrigger asChild><Button size="sm" variant="outline" disabled={busy} className={cn('h-7 rounded-full px-2.5 text-xs', record.limits.length === 0 ? `text-muted-foreground ${reveal}` : 'text-foreground')}>额度</Button></PopoverTrigger></Hint>
      <PopoverContent align="end" aria-label="额度" className="space-y-3">
        {(Object.keys(PERIODS) as LimitPeriod[]).map(period => <Label key={period} className="flex items-center justify-between gap-2">{PERIODS[period]}（元）
          <Input aria-label={`${PERIODS[period]}限额`} type="number" min="0.000001" max="1000000" step="any" placeholder="不限" className="w-32" value={limits[period] ?? ''} aria-invalid={Boolean(limitError)} aria-describedby={limitError ? `limit-error-${record.id}` : undefined} onChange={event => { setLimits({ ...limits, [period]: event.target.value }); setLimitError(''); }} />
        </Label>)}
        {limitError && <p id={`limit-error-${record.id}`} role="alert" className="text-xs text-destructive">{limitError}</p>}
      </PopoverContent>
    </Popover>
    <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-8" aria-label={`${record.name} 的更多操作`} disabled={busy}><MoreIcon /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuItem onSelect={onRename}>重命名</DropdownMenuItem><DropdownMenuItem onSelect={onReset}>重置密钥</DropdownMenuItem><DropdownMenuItem destructive onSelect={onRevoke}>撤销</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  </div>;
}


export function KeyRoleCell({ record, busy, onSave }: {
  record: GatewayKey; busy: boolean; onSave: (patch: Partial<GatewayKeyInput>) => Promise<boolean>;
}) {
  if (record.revoked_at) return <>{record.role === 'admin' ? '管理员' : '成员'}</>;
  return <Select value={record.role ?? 'member'} onValueChange={role => { void onSave({ role: role as 'member' | 'admin' }); }} disabled={busy}>
    <SelectTrigger aria-label={`${record.name} 的角色`} size="sm" variant="inline"><SelectValue /></SelectTrigger>
    <SelectContent><SelectItem value="member">成员</SelectItem><SelectItem value="admin">管理员</SelectItem></SelectContent>
  </Select>;
}
