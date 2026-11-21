import { useRef, useState } from 'react';
import type { GatewayKey, GatewayKeyInput, QuotaPeriod } from '@/api/gateway';
import { Button } from '@/components/ui/button';
import { HelpIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Hint } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { reveal } from './KeyScopePicker';
import { QUOTA_PERIODS } from './shared';

/** 成员行「额度」弹层（第 7 批）：一个金额 + 一个周期；金额清空即不限。 */
export function KeyQuotaPicker({ record, busy, onSave }: {
  record: GatewayKey; busy: boolean; onSave: (patch: Partial<GatewayKeyInput>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState<QuotaPeriod>('month');
  const [error, setError] = useState('');
  const errorId = `quota-error-${record.id}`;
  const amountRef = useRef<HTMLInputElement>(null);
  return <Popover open={open} onOpenChange={next => {
    if (next) {
      setAmount(record.quota ? String(record.quota.cap_cny) : '');
      setPeriod(record.quota?.period ?? 'month');
      setError('');
    } else if (record.quota !== undefined) {
      const cap = Number(amount);
      // 输入了读不成数字的内容（如「1e」「-」）时 value 是空串：按无效处理，不能当成「清空即不限」。
      const unreadable = amountRef.current?.validity.badInput ?? false;
      if (unreadable || (amount.trim() && (!Number.isFinite(cap) || cap <= 0 || cap > 1000000))) { setError('额度须大于 0 且不超过 100 万'); return; }
      const quota = amount.trim() ? { cap_cny: cap, period } : null;
      if (quota?.cap_cny !== record.quota?.cap_cny || quota?.period !== record.quota?.period) void onSave({ quota });
    }
    setOpen(next);
  }}>
    <Hint label="设置此密钥的消费额度"><PopoverTrigger asChild>
      <Button size="sm" variant="outline" disabled={busy} className={cn('h-7 rounded-full px-2.5 text-xs', record.quota === null ? `text-muted-foreground ${reveal}` : 'text-foreground')}>额度</Button>
    </PopoverTrigger></Hint>
    <PopoverContent align="end" aria-label="额度" className="w-72 space-y-3"
      onOpenAutoFocus={event => { if (amountRef.current) { event.preventDefault(); amountRef.current.focus(); } }}>
      {record.quota === undefined ? <p className="text-xs text-muted-foreground">主机版本较旧，更新主机后才能设置</p> : <>
      <Label className="flex items-center gap-1.5">额度（元）
        <Hint label="按主机时间计算；每周从周一起算"><span tabIndex={0} aria-label="额度说明" className="text-muted-foreground"><HelpIcon size="sm" /></span></Hint>
      </Label>
      <div className="flex items-center gap-2">
        <Input ref={amountRef} aria-label="额度金额" type="number" min="0.000001" max="1000000" step="any" placeholder="不限" className="min-w-0 flex-1"
          value={amount} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined}
          onChange={event => { setAmount(event.target.value); setError(''); }} />
        <Select value={period} onValueChange={value => setPeriod(value as QuotaPeriod)}>
          <SelectTrigger aria-label="额度周期" className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>{(Object.keys(QUOTA_PERIODS) as QuotaPeriod[]).map(value =>
            <SelectItem key={value} value={value}>{QUOTA_PERIODS[value]}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
      </>}
    </PopoverContent>
  </Popover>;
}
