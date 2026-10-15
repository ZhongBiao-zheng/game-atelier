import { useState } from 'react';
import type { CanvasEditRegion } from '@/api/canvas';
import { Button } from '@/components/ui/button';

type Props = {
  regions: CanvasEditRegion[]; activeId: string; onActive: (id: string) => void;
  context: number; feather: number | null;
  onContext: (value: number) => void; onFeather: (value: number | null) => void;
  prompts: Record<string, string>; defaultPrompt: string;
  onPrompt: (id: string, text: string) => void; onGroups: (groups: number[][] | null) => void;
};

export function RegionalEditControls({ regions, activeId, onActive, context, feather,
  onContext, onFeather, prompts, defaultPrompt, onPrompt, onGroups }: Props) {
  const [checked, setChecked] = useState<string[]>([]);
  const active = regions.find(region => region.id === activeId) ?? regions[0];
  const selected = regions.filter(region => checked.includes(region.id));
  function regroup(groups: number[][] | null) { setChecked([]); onGroups(groups); }
  return <details className="space-y-2 text-xs" open>
    <summary className="cursor-pointer py-1 text-muted-foreground">区域调整</summary>
    <div className="flex flex-wrap items-center gap-1" aria-label="区域列表">
      {regions.map((region, index) => <div key={region.id} className="flex items-center gap-1">
        <input type="checkbox" aria-label={`合并选择区域 ${index + 1}`} checked={checked.includes(region.id)}
          className="accent-primary" onChange={event => setChecked(event.target.checked ? [...checked, region.id] : checked.filter(id => id !== region.id))} />
        <Button size="sm" variant={active?.id === region.id ? 'secondary' : 'ghost'} aria-pressed={active?.id === region.id}
          onClick={() => onActive(region.id)}>区域 {index + 1}</Button>
      </div>)}
    </div>
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant="ghost" disabled={selected.length < 2} onClick={() => regroup([
        selected.flatMap(region => region.components).sort((a, b) => a - b),
        ...regions.filter(region => !checked.includes(region.id)).map(region => region.components),
      ])}>合并所选</Button>
      <Button size="sm" variant="ghost" disabled={!active || active.components.length < 2} onClick={() => regroup(
        regions.flatMap(region => region.id === active?.id ? region.components.map(id => [id]) : [region.components]),
      )}>拆开此区</Button>
      <Button size="sm" variant="ghost" onClick={() => regroup(null)}>自动分区</Button>
    </div>
    <label className="flex items-center justify-between gap-2">周围范围
      <input aria-label="周围范围" className="w-28 accent-primary" type="range" min={0} max={1} step={.05}
        value={context} onChange={event => onContext(Number(event.target.value))} />
    </label>
    <label className="flex items-center justify-between gap-2">边缘融合
      <span className="flex items-center gap-1"><input aria-label="边缘融合" className="canvas-input w-16" type="number" min={0} max={32}
        placeholder="自动" value={feather ?? ''} onChange={event => onFeather(event.target.value === '' ? null : Math.max(0, Math.min(32, Number(event.target.value))))} />px</span>
    </label>
    {active && <>
      <p className="text-muted-foreground">{active.crop[2]} × {active.crop[3]} → {active.work_size[0]} × {active.work_size[1]}</p>
      <textarea aria-label="区域提示词" className="canvas-input min-h-16 resize-y" value={prompts[active.id] ?? ''}
        placeholder={defaultPrompt || '沿用统一提示词；留空自然修复'}
        onChange={event => onPrompt(active.id, event.target.value)} />
    </>}
  </details>;
}
