import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FONT_PRESETS, STROKE_PRESETS } from './annotationModel';
import { cn } from '@/lib/utils';
import './annotation.css';
import { Slider } from '@/components/ui/slider';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
export function AnnotationSizePopover({ text, value, onChange }: {
  text: boolean; value: number; onChange: (value: number, preview?: boolean) => void;
}) {
  const label = text ? '字号' : '线宽';
  const dot = (n: number) => text ? 4 + (n - 12) / 3 : 3 + n * 1.1;
  return <Popover><Hint label={label}><PopoverTrigger asChild>
    <Button variant="bare" type="button" aria-label={label} className="flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground">
      <span>{label}</span><span className="tabular-nums text-foreground">{value}</span>
    </Button>
  </PopoverTrigger></Hint><PopoverContent data-annotation-controls side="top" sideOffset={10}
    className="nodrag nopan z-50 flex w-50 flex-col gap-2.5 rounded-xl border border-border bg-popover p-3"
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <div className="flex justify-between text-xs"><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{value}</span></div>
    <div className="flex gap-1">{(text ? FONT_PRESETS : STROKE_PRESETS).map(n => <Button variant="bare" key={n} type="button" aria-label={`${label} ${n}`}
      className={cn('grid h-8 flex-1 place-items-center rounded-md text-muted-foreground hover:bg-secondary', value === n && 'bg-secondary text-foreground')}
      onClick={() => onChange(n)}><span className="rounded-full bg-current" style={{ width: dot(n), height: dot(n) }} /></Button>)}</div>
    <Slider aria-label={`${label}调节`} min={text ? 12 : 1} max={text ? 72 : 24} step={1} value={[value]}
      onValueChange={([next]) => onChange(next, true)}
      onValueCommit={([next]) => onChange(next)} />
  </PopoverContent></Popover>;
}
