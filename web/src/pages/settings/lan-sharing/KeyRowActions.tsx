import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { GatewayKey, GatewayKeyInput, GatewayOptions, LimitPeriod } from '@/api/gateway';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Hint } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { PERIODS } from './shared';

const reveal = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100';
export function KeyRowActions({ record, options, busy, onSave, onRename, onReset, onRevoke }: {
  record: GatewayKey; options: GatewayOptions; busy: boolean;
  onSave: (patch: Partial<GatewayKeyInput>) => Promise<boolean>;
  onRename: () => void; onReset: () => void; onRevoke: () => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [aliases, setAliases] = useState<string[] | null>(null);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [limitError, setLimitError] = useState('');
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(v => v !== value) : [...values, value];
  return <div className="flex items-center justify-end gap-1 whitespace-nowrap">
    <Popover onOpenChange={open => {
      if (open) { setModels(record.allowed_models); setAliases(record.allowed_aliases); }
      else if (JSON.stringify([models, aliases]) !== JSON.stringify([record.allowed_models, record.allowed_aliases]))
        void onSave({ allowed_models: models, allowed_aliases: aliases });
    }}>
      <Hint label="选择此密钥可用的模型和供应商"><PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={busy} className={cn(record.allowed_models === null && record.allowed_aliases === null && reveal)}>
          {record.allowed_models === null ? '全部模型' : `${record.allowed_models.length} 个模型`}
        </Button>
      </PopoverTrigger></Hint>
      <PopoverContent align="end" className="max-h-96 space-y-3 overflow-y-auto" aria-label="模型与供应商">
        <Label className="flex items-center justify-between">全部模型<Switch aria-label="全部模型" checked={models === null} onCheckedChange={all => setModels(all ? null : [])} /></Label>
        {models !== null && [...new Set([...options.models.map(m => m.id), ...models])].map(id => <Label key={id} className="flex items-center gap-2"><Checkbox checked={models.includes(id)} onCheckedChange={() => setModels(toggle(models, id))} />{options.models.find(m => m.id === id)?.name ?? id}</Label>)}
        <Label className="flex items-center justify-between border-t border-border pt-3">全部供应商<Switch aria-label="全部供应商" checked={aliases === null} onCheckedChange={all => setAliases(all ? null : [])} /></Label>
        {aliases !== null && [...new Set([...options.aliases.map(a => a.alias), ...aliases])].map(alias => <Label key={alias} className="flex items-center gap-2"><Checkbox checked={aliases.includes(alias)} onCheckedChange={() => setAliases(toggle(aliases, alias))} />{alias}</Label>)}
      </PopoverContent>
    </Popover>
    <Popover onOpenChange={open => {
      if (open) { setLimits(Object.fromEntries(record.limits.map(l => [l.period, String(l.cap_cny)]))); setLimitError(''); }
      else {
        const next = (Object.keys(PERIODS) as LimitPeriod[]).filter(p => limits[p]?.trim()).map(period => ({ period, cap_cny: Number(limits[period]) }));
        if (next.some(l => !Number.isFinite(l.cap_cny) || l.cap_cny <= 0 || l.cap_cny > 1000000)) { setLimitError('额度须大于 0 且不超过 100 万'); return; }
        if (JSON.stringify(next) !== JSON.stringify(record.limits)) void onSave({ limits: next });
      }
    }}>
      <Hint label="设置此密钥的消费额度"><PopoverTrigger asChild><Button size="sm" variant="ghost" disabled={busy} className={cn(record.limits.length === 0 && reveal)}>额度</Button></PopoverTrigger></Hint>
      <PopoverContent align="end" aria-label="额度" className="space-y-3">
        {(Object.keys(PERIODS) as LimitPeriod[]).map(period => <Label key={period} className="flex items-center justify-between gap-2">{PERIODS[period]}（元）
          <Input aria-label={`${PERIODS[period]}限额`} type="number" min="0.000001" max="1000000" step="any" placeholder="不限" className="w-32" value={limits[period] ?? ''} onChange={event => setLimits({ ...limits, [period]: event.target.value })} />
        </Label>)}
      </PopoverContent>
    </Popover>
    {limitError && <Hint label={limitError}><span role="alert" className="text-xs text-destructive">额度无效</span></Hint>}
    <Select value={record.role ?? 'member'} onValueChange={role => { void onSave({ role: role as 'member' | 'admin' }); }} disabled={busy}>
      <Hint label="设置成员或管理员权限"><SelectTrigger aria-label={`${record.name} 的角色`} size="sm" className={cn('w-auto', record.role !== 'admin' && reveal)}><SelectValue /></SelectTrigger></Hint>
      <SelectContent><SelectItem value="member">成员</SelectItem><SelectItem value="admin">管理员</SelectItem></SelectContent>
    </Select>
    <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-8" aria-label={`${record.name} 的更多操作`} disabled={busy}><MoreHorizontal /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuItem onSelect={onRename}>重命名</DropdownMenuItem><DropdownMenuItem onSelect={onReset}>重置密钥</DropdownMenuItem><DropdownMenuItem destructive onSelect={onRevoke}>撤销</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
