import { useLayoutEffect, useRef, useState } from 'react';
import { modelModality, type ModelModality } from '@/api/keys';
import { modelCatalog, modelDisplayName, sortModels } from '@/lib/modelCatalog';
import { useModelPickerMetrics, type ModelPickerChoice } from '@/lib/useModelPickerMetrics';
import type { JobParams } from '@/schema/jobs';
import { ModelBrandIcon } from './ModelBrandIcon';

export function ModelPickerList({ choices, selected, initialKind, sections = false, params = {}, onSelect }: {
  choices: ModelPickerChoice[];
  selected: string;
  initialKind?: ModelModality;
  sections?: boolean;
  params?: Partial<Record<'image' | 'video', JobParams>>;
  onSelect: (choice: ModelPickerChoice) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headers = useRef<Partial<Record<ModelModality, HTMLElement | null>>>({});
  const target = useRef<{ kind: ModelModality; top: number } | null>(null);
  const { durations, prices } = useModelPickerMetrics(choices, params);
  const groups = (['image', 'video', 'text', 'audio'] as const).map(kind => ({
    kind, choices: sortModels(choices.filter(choice => modelModality(choice.model, choice.key) === kind)
      .map(choice => ({ ...choice, id: choice.model.id }))),
  })).filter(group => group.choices.length);
  const [active, setActive] = useState(initialKind ?? groups[0]?.kind);
  const tabs = sections && groups.length > 1;
  function sectionTop(kind: ModelModality) {
    const container = scrollRef.current, header = headers.current[kind];
    if (!container || !header) return 0;
    return header.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  }
  function goTo(kind: ModelModality, smooth = true) {
    const container = scrollRef.current;
    if (!container) return;
    const top = Math.max(0, Math.min(sectionTop(kind), container.scrollHeight - container.clientHeight));
    setActive(kind);
    target.current = smooth ? { kind, top } : null;
    container.scrollTo?.({ top, behavior: smooth ? 'smooth' : 'instant' });
  }
  useLayoutEffect(() => { if (sections && initialKind) goTo(initialKind, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const flat = groups.flatMap(group => group.choices);
  return <div className="flex min-h-0 flex-1 flex-col gap-2">
    {tabs && <div role="tablist" aria-label="模型类型" className="grid shrink-0 grid-cols-2 rounded-lg bg-popover p-0.5">
      {groups.map(group => <button key={group.kind} type="button" role="tab" aria-selected={active === group.kind}
        tabIndex={active === group.kind ? 0 : -1}
        onClick={() => goTo(group.kind)}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            const next = groups[(groups.indexOf(group) + 1) % groups.length];
            goTo(next.kind);
            const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
            buttons?.[groups.indexOf(next)].focus({ preventScroll: true });
          }
        }}
        className="rounded-md px-3 py-2 text-xs hover:bg-secondary/60 aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-primary/50">
        {group.kind === 'image' ? 'Image' : 'Video'}
      </button>)}
    </div>}
    <div ref={scrollRef} role="listbox" aria-label="选择模型列表" tabIndex={-1}
      data-testid="model-picker-scroll" className="min-h-0 overflow-y-auto overscroll-contain rounded-lg bg-popover p-1"
      onWheel={() => { target.current = null; }} onTouchStart={() => { target.current = null; }}
      onScroll={() => {
        const container = scrollRef.current;
        if (!container || !sections) return;
        if (target.current) {
          if (Math.abs(container.scrollTop - target.current.top) < 2) target.current = null;
          return;
        }
        const atBottom = container.scrollTop > 0
          && container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
        const current = atBottom ? groups[groups.length - 1]
          : [...groups].reverse().find(group => sectionTop(group.kind) <= container.scrollTop + 8);
        if (current) setActive(current.kind);
      }}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        target.current = null;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        buttons[next]?.focus();
      }}>
      {groups.map(group => <section key={group.kind} className="flex flex-col gap-1">
        {sections && <div ref={element => { headers.current[group.kind] = element; }} className="px-3 pb-2 pt-3 text-xs uppercase tracking-label text-muted-foreground">
          {group.kind === 'image' ? 'Image' : 'Video'}
        </div>}
        {group.choices.map(choice => {
          const id = `${choice.key.alias}:${choice.model.id}`;
          const entry = modelCatalog(choice.model.id);
          const media = group.kind === 'image' || group.kind === 'video';
          const seconds = media ? durations[id] : null, cost = media ? prices[id] : null;
          return <button key={id} type="button" role="option" aria-selected={selected === id}
            aria-label={modelDisplayName(choice.model)}
            tabIndex={selected === id || (!flat.some(item => `${item.key.alias}:${item.model.id}` === selected) && flat[0] === choice) ? 0 : -1}
            onClick={() => onSelect(choice)}
            className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary aria-selected:bg-secondary aria-selected:ring-1 aria-selected:ring-inset aria-selected:ring-primary/60">
            <span className={selected === id ? 'text-foreground' : 'text-muted-foreground'}><ModelBrandIcon brand={entry?.brand} /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{modelDisplayName(choice.model)}</span>
              {entry && <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">{entry.description}</span>}
              {(seconds != null || cost != null) && <span className="mt-2 flex justify-between gap-2 text-xs tabular-nums text-muted-foreground">
                {seconds != null && <span>{seconds > 90 ? `≈ ${Math.round(seconds / 60)}m` : `≈ ${Math.round(seconds)}s`}</span>}
                {cost != null && <span className="ml-auto">¥{cost.toFixed(2)}</span>}
              </span>}
            </span>
          </button>;
        })}
      </section>)}
      {!flat.length && <p className="px-3 py-2 text-sm text-muted-foreground">暂无可用模型</p>}
    </div>
  </div>;
}
