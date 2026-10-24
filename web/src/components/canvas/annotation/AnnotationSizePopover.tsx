import * as Popover from '@radix-ui/react-popover';
import { FONT_PRESETS, STROKE_PRESETS } from './annotationModel';
import { cn } from '@/lib/utils';
import './annotation.css';
export function AnnotationSizePopover({ text, value, onChange }: {
  text: boolean; value: number; onChange: (value: number, preview?: boolean) => void;
}) {
  const label = text ? '字号' : '线宽';
  const dot = (n: number) => text ? 4 + (n - 12) / 3 : 3 + n * 1.1;
  return <Popover.Root><Popover.Trigger asChild>
    <button type="button" aria-label={label} title={label} className="flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">
      <span>{label}</span><span className="tabular-nums text-foreground">{value}</span>
    </button>
  </Popover.Trigger><Popover.Portal><Popover.Content data-annotation-controls side="top" sideOffset={10}
    className="nodrag nopan z-50 flex w-50 flex-col gap-2.5 rounded-xl border border-border bg-popover p-3"
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <div className="flex justify-between text-xs"><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{value}</span></div>
    <div className="flex gap-1">{(text ? FONT_PRESETS : STROKE_PRESETS).map(n => <button key={n} type="button" aria-label={`${label} ${n}`}
      className={cn('grid h-8 flex-1 place-items-center rounded-md text-muted-foreground hover:bg-secondary', value === n && 'bg-secondary text-foreground')}
      onClick={() => onChange(n)}><span className="rounded-full bg-current" style={{ width: dot(n), height: dot(n) }} /></button>)}</div>
    <input aria-label={`${label}调节`} className="annotation-range w-full" type="range" min={text ? 12 : 1} max={text ? 72 : 24} step={1} value={value}
      onChange={event => onChange(Number(event.target.value), true)}
      onPointerUp={event => onChange(Number(event.currentTarget.value))}
      onKeyUp={event => onChange(Number(event.currentTarget.value))} />
  </Popover.Content></Popover.Portal></Popover.Root>;
}
