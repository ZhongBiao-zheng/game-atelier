import { useMemo, useRef, useState } from 'react';
import { AddIcon, CheckIcon, ChevronDownIcon } from '@/components/ui/icons';
import { Link } from 'wouter';
import { ModelBrandIcon } from '@/components/ModelBrandIcon';
import { ProviderBrandIcon } from '@/components/ProviderBrandIcon';
import { ToolbarPopover } from '@/components/studio/ToolbarPopover';
import { modelBrand } from '@/lib/modelCatalog';
import { providerLabel } from '@/lib/providerLabels';
import { cn } from '@/lib/utils';
import type { CanvasAgentChatModel, CanvasAgentChatModelList } from '@/schema/canvas';
import { Input } from '@/components/ui/input';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

export function CanvasAgentModelPicker({ models, alias, model, triggerClassName, direction = 'up', disabled, onSelect }: {
  models: CanvasAgentChatModelList | null;
  alias: string | null;
  model: string | null;
  triggerClassName?: string;
  direction?: 'up' | 'down';
  disabled?: boolean;
  onSelect: (choice: CanvasAgentChatModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchorRef = useRef<HTMLButtonElement>(null);
  const current = models?.models.find(item => item.alias === alias && item.model === model);
  const activeModelId = current?.model ?? (!models ? model : null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = models?.models ?? [];
    return needle
      ? all.filter(item => `${item.model} ${item.name} ${item.alias} ${item.provider ?? ''}`.toLowerCase().includes(needle))
      : all;
  }, [models, query]);

  const groups = useMemo(() => {
    const byAlias = new Map<string, CanvasAgentChatModel[]>();
    for (const item of matches) {
      byAlias.set(item.alias, [...(byAlias.get(item.alias) ?? []), item]);
    }
    return [...byAlias.entries()];
  }, [matches]);

  return (
    <>
      <Hint label={current || (!models && model) ? `${alias} · ${model}` : '选择对话模型'}><Button variant="bare"
        ref={anchorRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className={cn(
          'flex h-7 min-w-0 max-w-44 items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50',
          open && 'bg-secondary text-foreground',
          triggerClassName,
        )}
      >
        {activeModelId && <ModelBrandIcon brand={modelBrand(activeModelId)} size="sm" />}
        {/* 记住的模型已不在列表里（Key 里停用了）：当作没选。 */}
        <span className="truncate">{(models ? current?.name : model) ?? '选择模型'}</span>
        <ChevronDownIcon size="sm" className="shrink-0 text-muted-foreground" />
      </Button></Hint>
      <ToolbarPopover
        open={open}
        onClose={() => { setOpen(false); setQuery(''); }}
        anchorRef={anchorRef}
        direction={direction}
        align="start"
        autoFocus
        maxHeight={400}
        aria-label="对话模型"
        className="flex w-80 flex-col gap-2 rounded-xl border border-border bg-card p-2"
      >
        <Input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索对话模型"
          aria-label="搜索模型"
        />
        <div role="listbox" aria-label="对话模型列表" className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-lg bg-popover p-1">
          {!models && <p className="px-3 py-3 text-xs text-muted-foreground">加载中…</p>}
          {models && models.models.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">没有可用的对话模型</p>}
          {models && models.models.length > 0 && matches.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">没有匹配的模型</p>}
          {groups.map(([groupAlias, items]) => {
            const head = items[0];
            const groupLabel = head?.provider ? providerLabel(head.provider, groupAlias) : groupAlias;
            return (
              <div key={groupAlias} role="group" aria-label={groupAlias} className="flex flex-col gap-0.5 pb-1">
                <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-xs text-muted-foreground">
                  <ProviderBrandIcon provider={head} size="sm" />
                  <span className="truncate">{groupLabel}</span>
                  {groupLabel !== groupAlias && <span className="truncate text-subtle-foreground">· {groupAlias}</span>}
                </div>
                {items.map(item => {
                  const selected = item.alias === alias && item.model === model;
                  return (
                    <Button variant="bare"
                      key={`${item.alias}/${item.model}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => { onSelect(item); setOpen(false); }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-inset aria-selected:ring-primary/60"
                    >
                      <span className={selected ? 'text-foreground' : 'text-muted-foreground'}>
                        <ModelBrandIcon brand={modelBrand(item.model)} size="md" />
                      </span>
                      <Hint label={item.model}>
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{item.name}</span>
                      </Hint>
                      {selected && <CheckIcon size="sm" className="shrink-0 text-primary" />}
                    </Button>
                  );
                })}
              </div>
            );
          })}
          {(models?.errors ?? []).map(item => (
            <p key={item.alias} className="px-2.5 py-1 text-xs text-destructive">{item.alias}：{item.message}</p>
          ))}
        </div>
        <Link
          href="/settings/providers"
          className="flex items-center gap-2 rounded-lg border-t border-border px-2.5 pt-2 pb-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
        >
          <AddIcon size="sm" className="shrink-0" aria-hidden="true" />添加模型
        </Link>
      </ToolbarPopover>
    </>
  );
}
