import { useMemo, useRef, useState } from 'react';
import { Boxes, Check } from 'lucide-react';
import { ToolbarPopover } from '@/components/studio/ToolbarPopover';
import { cn } from '@/lib/utils';
import type {
  CanvasAgentCreationMode, CanvasAgentGenerationModel, CanvasAgentModelRef,
} from '@/schema/canvas';

type Kind = 'image' | 'video';
const KINDS: Kind[] = ['image', 'video'];
const KIND_LABELS: Record<Kind, string> = { image: '图像', video: '视频' };

const sameRef = (a: CanvasAgentModelRef, b: CanvasAgentModelRef) => a.alias === b.alias && a.model === b.model;

/**
 * 模型偏好：自动 = Agent 从全部可用模型里挑。关掉自动后只能用勾选的模型（与服务端 ModelScope.models
 * 一致）：一个都没勾就不能生成。勾选结果在自动打开时也保留，再关掉时恢复。
 * 图像 / 视频两页始终都在（偏好与当前创作模式无关），页内按供应商（Key 别名）分组。
 */
export function CanvasAgentPreferencePicker({ models, mode, auto, preferred, disabled, onChange }: {
  models: CanvasAgentGenerationModel[] | null;
  mode: CanvasAgentCreationMode;
  auto: boolean;
  preferred: CanvasAgentModelRef[];
  disabled?: boolean;
  onChange: (update: { auto_models?: boolean; preferred_models?: CanvasAgentModelRef[] }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Kind | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  // 没手动切过页时跟着创作模式走：视频创作默认看视频页。
  const activeKind: Kind = tab ?? (mode === 'video' ? 'video' : 'image');
  const isChosen = (item: CanvasAgentModelRef) => preferred.some(ref => sameRef(ref, item));
  const chosenCount = (kind: Kind) => (models ?? []).filter(item => item.kind === kind && isChosen(item)).length;
  const rows = useMemo(() => (models ?? []).filter(item => item.kind === activeKind), [models, activeKind]);
  const groups = useMemo(() => {
    const byAlias = new Map<string, CanvasAgentGenerationModel[]>();
    for (const item of rows) byAlias.set(item.alias, [...(byAlias.get(item.alias) ?? []), item]);
    return [...byAlias.entries()];
  }, [rows]);

  function toggle(item: CanvasAgentGenerationModel) {
    const ref = { alias: item.alias, model: item.model };
    onChange({ preferred_models: isChosen(ref)
      ? preferred.filter(existing => !sameRef(existing, ref)) : [...preferred, ref] });
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        title={auto ? '模型偏好：自动' : `模型偏好：图像 ${chosenCount('image')} 个，视频 ${chosenCount('video')} 个`}
        aria-label="模型偏好"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40',
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
              onClick={() => onChange({ auto_models: !auto })}
              className={cn('relative h-5 w-9 rounded-full transition-colors', auto ? 'bg-primary' : 'bg-secondary')}
            >
              <span className={cn('absolute top-0.5 size-4 rounded-full bg-background transition-transform', auto ? 'translate-x-[1.125rem]' : 'translate-x-0.5')} />
            </button>
          </label>
        </div>
        <div role="tablist" aria-label="模型类型" className="grid grid-cols-2 gap-1 rounded-lg bg-secondary/60 p-0.5">
          {KINDS.map(kind => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={kind === activeKind}
              onClick={() => setTab(kind)}
              className={cn('rounded-md py-1 text-xs text-muted-foreground', kind === activeKind && 'bg-background text-foreground')}
            >
              {KIND_LABELS[kind]}
              {!auto && <span className="ml-1 tabular-nums text-muted-foreground">{chosenCount(kind)}</span>}
            </button>
          ))}
        </div>
        <div role="listbox" aria-multiselectable aria-label={`${KIND_LABELS[activeKind]}模型`} className="max-h-72 overflow-y-auto">
          {!models && <p className="px-2 py-3 text-xs text-muted-foreground">读取中…</p>}
          {models && rows.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">没有可用的{KIND_LABELS[activeKind]}模型</p>}
          {groups.map(([alias, items]) => (
            <div key={alias} role="group" aria-label={alias}>
              <p className="px-2 pb-1 pt-2 text-xs text-muted-foreground">{alias}</p>
              {items.map(item => {
                const checked = !auto && isChosen(item);
                return (
                  <button
                    key={`${item.alias}/${item.model}`}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    aria-disabled={auto}
                    disabled={auto}
                    onClick={() => toggle(item)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-secondary disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs" title={item.model}>{item.name}</span>
                    {checked && <Check className="size-3.5 shrink-0 text-primary" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {!auto && chosenCount(activeKind) === 0 && rows.length > 0 && (
          <p className="px-1 text-xs text-muted-foreground">未选{KIND_LABELS[activeKind]}模型，Agent 无法生成{KIND_LABELS[activeKind]}</p>
        )}
      </ToolbarPopover>
    </>
  );
}
