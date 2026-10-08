import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { ToolbarPopover } from '@/components/studio/ToolbarPopover';
import { cn } from '@/lib/utils';
import type { CanvasAgentChatModel, CanvasAgentChatModelList } from '@/schema/canvas';

/** 列表可能上千条（各 Key 的 /models 合起来）：只渲染前这么多条匹配项，靠搜索缩小。 */
const MAX_VISIBLE = 200;

export function CanvasAgentModelPicker({ models, alias, model, disabled, onSelect }: {
  models: CanvasAgentChatModelList | null;
  alias: string | null;
  model: string | null;
  disabled?: boolean;
  onSelect: (choice: CanvasAgentChatModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchorRef = useRef<HTMLButtonElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = models?.models ?? [];
    return needle
      ? all.filter(item => `${item.model} ${item.name} ${item.alias}`.toLowerCase().includes(needle))
      : all;
  }, [models, query]);

  const groups = useMemo(() => {
    const byAlias = new Map<string, CanvasAgentChatModel[]>();
    for (const item of matches.slice(0, MAX_VISIBLE)) {
      byAlias.set(item.alias, [...(byAlias.get(item.alias) ?? []), item]);
    }
    return [...byAlias.entries()];
  }, [matches]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={model ? `${alias} · ${model}` : '选择对话模型'}
        onClick={() => setOpen(value => !value)}
        className="flex h-8 min-w-0 max-w-[11rem] items-center gap-1 rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
      >
        <span className="truncate">{model ?? '选择模型'}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </button>
      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        direction="up"
        align="start"
        autoFocus
        aria-label="对话模型"
        className="flex w-72 flex-col rounded-xl border border-border bg-popover p-1.5 shell-glow"
      >
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索模型"
          aria-label="搜索模型"
          className="mb-1 h-8 rounded-md border border-border bg-background px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-primary"
        />
        <div role="listbox" aria-label="对话模型列表" className="max-h-72 overflow-y-auto">
          {!models && <p className="px-2 py-3 text-xs text-muted-foreground">读取中…</p>}
          {models && matches.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">没有匹配的模型</p>}
          {groups.map(([groupAlias, items]) => (
            <div key={groupAlias} role="group" aria-label={groupAlias}>
              <p className="px-2 pb-1 pt-2 text-xs text-muted-foreground">{groupAlias}</p>
              {items.map(item => {
                const selected = item.alias === alias && item.model === model;
                return (
                  <button
                    key={`${item.alias}/${item.model}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => { onSelect(item); setOpen(false); }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-secondary',
                      selected && 'text-primary',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.model}</span>
                    {selected && <Check className="size-3.5 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
          {matches.length > MAX_VISIBLE && (
            <p className="px-2 py-2 text-xs text-muted-foreground">还有 {matches.length - MAX_VISIBLE} 个，输入关键词缩小范围</p>
          )}
          {models?.errors.map(item => (
            <p key={item.alias} className="px-2 py-1 text-xs text-destructive">{item.alias}：{item.message}</p>
          ))}
        </div>
      </ToolbarPopover>
    </>
  );
}
