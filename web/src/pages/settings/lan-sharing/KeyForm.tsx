import { useState } from 'react';
import { createGatewayKey, updateGatewayKey, type GatewayKey, type GatewayOptions, type LimitPeriod } from '@/api/gateway';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { KINDS, PERIODS } from './shared';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

export function KeyForm({ record, options, onClose, onSaved, gatewayAlias }: {
  gatewayAlias?: string;
  record: GatewayKey | null; options: GatewayOptions; onClose: () => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState<'member' | 'admin'>(record?.role ?? 'member');
  const [name, setName] = useState(record?.name ?? '');
  const [limits, setLimits] = useState(Object.fromEntries(record?.limits.map(l => [l.period, String(l.cap_cny)]) ?? []) as Record<string, string>);
  const [models, setModels] = useState<string[] | null>(record?.allowed_models ?? null);
  const [aliases, setAliases] = useState<string[] | null>(record?.allowed_aliases ?? null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(v => v !== value) : [...values, value];
  async function save() {
    setBusy(true); setError('');
    try {
      const payload = { role, name: name.trim(), limits: (Object.keys(PERIODS) as LimitPeriod[])
        .filter(period => limits[period]?.trim()).map(period => ({ period, cap_cny: Number(limits[period]) })),
      allowed_models: models, allowed_aliases: aliases };
      if (record) { await updateGatewayKey(record.id, payload, ...(gatewayAlias ? [gatewayAlias] as const : [])); onSaved(); onClose(); }
      else { const result = await createGatewayKey(payload, ...(gatewayAlias ? [gatewayAlias] as const : [])); setToken(result.token); onSaved(); }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent aria-describedby={undefined} className="max-h-[85vh] overflow-y-auto">
      <DialogTitle>{record ? '编辑密钥' : '新建密钥'}</DialogTitle>
      {token ? <div className="space-y-3">
        <p className="text-sm">{gatewayAlias ? '网关密钥只显示这一次' : '网关密钥'}</p><code className="block break-all text-xs">{token}</code>
        <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(token)}>复制网关密钥</Button>
      </div> : <form autoComplete="off" className="space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}>
        <Label className="block space-y-1 text-sm">名称<Input value={name} maxLength={40} required onChange={e => setName(e.target.value)} /></Label>
        <Label className="flex items-center justify-between text-sm">角色<Select value={role} onValueChange={value => setRole(value as 'member' | 'admin')}>
          <SelectTrigger aria-label="角色" className="w-auto"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="member">成员</SelectItem><SelectItem value="admin">管理员</SelectItem></SelectContent>
        </Select></Label>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm">限额 <Hint label="留空表示不限额；多个窗口同时生效。金额包含运行中任务的预占。"><span tabIndex={0}>?</span></Hint></legend>
          {(Object.keys(PERIODS) as LimitPeriod[]).map(period => <Label key={period} className="flex items-center justify-between gap-3 text-sm">{PERIODS[period]}（元）
            <Input aria-label={`${PERIODS[period]}限额`} type="number" min="0.000001" max="1000000" step="any" placeholder="不限" className="w-36" value={limits[period] ?? ''} onChange={e => setLimits({ ...limits, [period]: e.target.value })} />
          </Label>)}
        </fieldset>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm">可用模型</legend>
          <div className="flex items-center justify-between text-sm">全部<Switch aria-label="全部模型" checked={models === null} onCheckedChange={all => setModels(all ? null : [])} /></div>
          {models !== null && (['image', 'video', 'audio', 'text'] as const).map(kind => <div key={kind} className="space-y-1">
            <p className="text-xs text-muted-foreground">{KINDS[kind]}</p>
            {options.models.filter(m => m.modality === kind).map(m => <Label key={`${kind}:${m.id}`} className="flex items-center gap-2 text-sm"><Checkbox checked={models.includes(m.id)} onCheckedChange={() => setModels(toggle(models, m.id))} />{m.name}</Label>)}
          </div>)}
          {models?.filter(id => !options.models.some(m => m.id === id)).map(id => <Label key={id} className="flex items-center gap-2 text-sm"><Checkbox checked onCheckedChange={() => setModels(toggle(models, id))} />{id}</Label>)}
        </fieldset>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm">可用供应商</legend>
          <div className="flex items-center justify-between text-sm">全部<Switch aria-label="全部供应商" checked={aliases === null} onCheckedChange={all => setAliases(all ? null : [])} /></div>
          {aliases !== null && [...new Set([...options.aliases.map(a => a.alias), ...aliases])].map(alias => <Label key={alias} className="flex items-center gap-2 text-sm"><Checkbox checked={aliases.includes(alias)} onCheckedChange={() => setAliases(toggle(aliases, alias))} />{alias}</Label>)}
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button variant="outline" size="sm" type="submit" disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存'}</Button>
      </form>}
    </DialogContent>
  </Dialog>;
}
