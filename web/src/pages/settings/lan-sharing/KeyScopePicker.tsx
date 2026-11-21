import { useRef, useState } from 'react';
import type { GatewayKey, GatewayKeyInput, GatewayOptions } from '@/api/gateway';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { HelpIcon } from '@/components/ui/icons';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Hint } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { KindBadge } from '../usage/KindBadge';
import { entryOf, sameScope, scopeGroups, scopeModelCount, toggleModel, toggleProvider, type Scope } from './keyScope';

export const reveal = 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100';

/** 成员行「模型」弹层（第 7 批）：最上面「全部模型」，下面按供应商分组列它的模型。 */
export function KeyScopePicker({ record, options, busy, onSave }: {
  record: GatewayKey; options: GatewayOptions; busy: boolean;
  onSave: (patch: Partial<GatewayKeyInput>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Scope>(null);
  const allRef = useRef<HTMLButtonElement>(null);
  // 旧主机（远程管理）不回 scope / providers：只提示更新，不发新字段。
  const providers = record.scope === undefined ? undefined : options.providers;
  // 新保存不允许空范围：草稿取消到空时提示，关闭 = 放弃这次修改（不保存）。旧数据转换出的空范围原样打开再关上不提示。
  const empty = Boolean(providers) && draft !== null && draft.length === 0 && !sameScope(draft, record.scope ?? null);
  const label = !providers ? '模型' : record.scope === null ? '全部模型'
    : record.scope.length === 0 ? '未选择模型' : `${scopeModelCount(record.scope, providers)} 个模型`;
  return <Popover open={open} onOpenChange={next => {
    if (next) setDraft(record.scope ?? null);
    else if (providers && !empty && !sameScope(draft, record.scope ?? null)) void onSave({ scope: draft });
    setOpen(next);
  }}>
    <Hint label="选择此密钥可用的模型"><PopoverTrigger asChild>
      <Button variant="outline" size="sm" disabled={busy} className={cn('h-7 rounded-full px-2.5 text-xs', record.scope === null ? `text-muted-foreground ${reveal}` : 'text-foreground')}>{label}</Button>
    </PopoverTrigger></Hint>
    <PopoverContent align="end" className="max-h-96 w-80 space-y-3 overflow-y-auto" aria-label="可用模型"
      onOpenAutoFocus={event => { if (allRef.current) { event.preventDefault(); allRef.current.focus(); } }}>
      {!providers ? <p className="text-xs text-muted-foreground">主机版本较旧，更新主机后才能设置</p> : <>
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5">全部模型
            <Hint label="勾选供应商即包含它以后新增的模型"><span tabIndex={0} aria-label="范围说明" className="text-muted-foreground"><HelpIcon size="sm" /></span></Hint>
          </Label>
          <Switch ref={allRef} aria-label="全部模型" checked={draft === null} onCheckedChange={all => setDraft(all ? null : [])} />
        </div>
        {draft !== null && scopeGroups(draft, providers).map(group => {
          const whole = entryOf(draft, group.alias)?.models === null;
          const listed = entryOf(draft, group.alias)?.models ?? [];
          return <section key={group.alias} aria-label={group.alias} className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className={cn('truncate text-sm font-medium', !group.enabled && 'text-muted-foreground')}>
                {group.alias}{!group.enabled && <span className="ml-1.5 text-xs font-normal">已停用</span>}
              </span>
              <Label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">全部
                <Checkbox aria-label={`${group.alias} 的全部模型`} checked={whole} disabled={!group.enabled && !whole}
                  onCheckedChange={() => setDraft(toggleProvider(draft, group.alias))} />
              </Label>
            </div>
            {group.models.map(model => {
              const checked = whole || listed.includes(model.id);
              return <Label key={model.id} className="flex items-center gap-2 pl-1">
                <Checkbox checked={checked} disabled={whole || (!group.enabled && !checked)}
                  onCheckedChange={() => setDraft(toggleModel(draft, group.alias, model.id))} />
                <span className="min-w-0 flex-1 truncate">{model.name}</span>
                {model.route_id && <KindBadge kind={model.modality} />}
              </Label>;
            })}
          </section>;
        })}
        {empty && <p role="alert" className="text-xs text-destructive">至少选一个模型</p>}
      </>}
    </PopoverContent>
  </Popover>;
}
