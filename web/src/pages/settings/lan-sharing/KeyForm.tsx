import { useState } from 'react';
import { createGatewayKey, updateGatewayKey, type GatewayKey, type GatewayOptions, type LimitPeriod } from '@/api/gateway';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { button, KINDS, PERIODS } from './shared';

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
        <button className={button} onClick={() => void navigator.clipboard.writeText(token)}>复制网关密钥</button>
      </div> : <form autoComplete="off" className="space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label className="block space-y-1 text-sm">名称<Input value={name} maxLength={40} required onChange={e => setName(e.target.value)} /></label>
        <label className="flex items-center justify-between text-sm">角色<select aria-label="角色" value={role} onChange={e => setRole(e.target.value as 'member' | 'admin')} className="rounded-md border border-input bg-background px-3 py-2"><option value="member">成员</option><option value="admin">管理员</option></select></label>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm">限额 <span title="留空表示不限额；多个窗口同时生效。金额包含运行中任务的预占。" tabIndex={0}>?</span></legend>
          {(Object.keys(PERIODS) as LimitPeriod[]).map(period => <label key={period} className="flex items-center justify-between gap-3 text-sm">{PERIODS[period]}（元）
            <Input aria-label={`${PERIODS[period]}限额`} type="number" min="0.000001" max="1000000" step="any" placeholder="不限" className="w-36" value={limits[period] ?? ''} onChange={e => setLimits({ ...limits, [period]: e.target.value })} />
          </label>)}
        </fieldset>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm">可用模型</legend>
          <div className="flex items-center justify-between text-sm">全部<Switch label="全部模型" checked={models === null} onChange={all => setModels(all ? null : [])} /></div>
          {models !== null && (['image', 'video', 'audio', 'text'] as const).map(kind => <div key={kind} className="space-y-1">
            <p className="text-xs text-muted-foreground">{KINDS[kind]}</p>
            {options.models.filter(m => m.modality === kind).map(m => <label key={`${kind}:${m.id}`} className="flex items-center gap-2 text-sm"><input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" type="checkbox" checked={models.includes(m.id)} onChange={() => setModels(toggle(models, m.id))} />{m.name}</label>)}
          </div>)}
          {models?.filter(id => !options.models.some(m => m.id === id)).map(id => <label key={id} className="flex items-center gap-2 text-sm"><input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" type="checkbox" checked onChange={() => setModels(toggle(models, id))} />{id}</label>)}
        </fieldset>
        <fieldset className="space-y-2"><legend className="mb-2 text-sm">可用供应商</legend>
          <div className="flex items-center justify-between text-sm">全部<Switch label="全部供应商" checked={aliases === null} onChange={all => setAliases(all ? null : [])} /></div>
          {aliases !== null && [...new Set([...options.aliases.map(a => a.alias), ...aliases])].map(alias => <label key={alias} className="flex items-center gap-2 text-sm"><input autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" type="checkbox" checked={aliases.includes(alias)} onChange={() => setAliases(toggle(aliases, alias))} />{alias}</label>)}
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <button type="submit" className={button} disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存'}</button>
      </form>}
    </DialogContent>
  </Dialog>;
}
