import { useRef, useState } from 'react';
import { Boxes, Check } from 'lucide-react';
import { ToolbarPopover } from '@/components/studio/ToolbarPopover';
import { cn } from '@/lib/utils';
import type {
  CanvasAgentCreationMode, CanvasAgentGenerationModel, CanvasAgentModelRef,
} from '@/schema/canvas';

type Kind = 'image' | 'video';
const KIND_LABELS: Record<Kind, string> = { image: '图片', video: '视频' };

const sameRef = (a: CanvasAgentModelRef, b: CanvasAgentModelRef) => a.alias === b.alias && a.model === b.model;

/**
 * 模型偏好：空列表 = 自动（Agent 从全部可用模型里挑）。某一类型一个都没选时，该类型按自动处理，
 * 与服务端 ModelScope.models 一致。
 */
export function CanvasAgentPreferencePicker({ models, mode, preferred, disabled, onChange }: {
  models: CanvasAgentGenerationModel[] | null;
  mode: CanvasAgentCreationMode;
  preferred: CanvasAgentModelRef[];
  disabled?: boolean;
  onChange: (preferred: CanvasAgentModelRef[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Kind>('image');
  const anchorRef = useRef<HTMLButtonElement>(null);
  const kinds: Kind[] = mode === 'all' ? ['image', 'video'] : [mode];
  const activeKind = kinds.includes(tab) ? tab : kinds[0];
  const auto = preferred.length === 0;
  const rows = (models ?? []).filter(item => item.kind === activeKind);
  const chosenOfKind = rows.filter(item => preferred.some(ref => sameRef(ref, item)));

  function toggleAuto() {
    // 关掉自动：先把全部模型勾上，再由用户去掉不想用的。
    onChange(auto ? (models ?? []).map(({ alias, model }) => ({ alias, model })) : []);
  }

  function toggle(item: CanvasAgentGenerationModel) {
    const ref = { alias: item.alias, model: item.model };
    // 自动状态下点某个模型 = 这一类型只用它。
    if (auto) { onChange([ref]); return; }
    const has = preferred.some(existing => sameRef(existing, ref));
    onChange(has ? preferred.filter(existing => !sameRef(existing, ref)) : [...preferred, ref]);
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        title={auto ? '模型偏好：自动' : `模型偏好：已选 ${preferred.length} 个`}
        aria-label="模型偏好"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40',
          !auto && 'text-primary',
        )}
      ><Boxes className="size-4" /></button>
      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        direction="up"
        align="start"
        aria-label="模型偏好"
        className="flex w-72 flex-col gap-2 rounded-xl border border-border bg-popover p-2 shell-glow"
      >
        <div className="flex items-center justify-between px-1">
          <p className="text-sm font-medium">模型偏好</p>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            自动
            <button
              type="button"
              role="switch"
              aria-checked={auto}
              aria-label="自动选择模型"
              onClick={toggleAuto}
              className={cn('relative h-5 w-9 rounded-full transition-colors', auto ? 'bg-primary' : 'bg-secondary')}
            >
              <span className={cn('absolute top-0.5 size-4 rounded-full bg-background transition-transform', auto ? 'translate-x-[1.125rem]' : 'translate-x-0.5')} />
            </button>
          </label>
        </div>
        {kinds.length > 1 && (
          <div role="tablist" aria-label="模型类型" className="grid grid-cols-2 gap-1 rounded-lg bg-secondary/60 p-0.5">
            {kinds.map(kind => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={kind === activeKind}
                onClick={() => setTab(kind)}
                className={cn('rounded-md py-1 text-xs text-muted-foreground', kind === activeKind && 'bg-background text-foreground')}
              >{KIND_LABELS[kind]}</button>
            ))}
          </div>
        )}
        <div role="listbox" aria-multiselectable aria-label={`${KIND_LABELS[activeKind]}模型`} className="max-h-64 overflow-y-auto">
          {!models && <p className="px-2 py-3 text-xs text-muted-foreground">读取中…</p>}
          {models && rows.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">没有可用的{KIND_LABELS[activeKind]}模型</p>}
          {rows.map(item => {
            const checked = !auto && chosenOfKind.some(ref => sameRef(ref, item));
            return (
              <button
                key={`${item.alias}/${item.model}`}
                type="button"
                role="option"
                aria-selected={checked}
                onClick={() => toggle(item)}
                className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-secondary', auto && 'text-muted-foreground')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs" title={item.model}>{item.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{item.alias}</span>
                </span>
                {checked && <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
        {!auto && chosenOfKind.length === 0 && rows.length > 0 && (
          <p className="px-1 text-xs text-muted-foreground">{KIND_LABELS[activeKind]}未选，按自动处理</p>
        )}
      </ToolbarPopover>
    </>
  );
}
