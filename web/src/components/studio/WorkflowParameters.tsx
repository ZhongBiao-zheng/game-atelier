import { useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import type { WorkflowInput } from '@/api/keys';
import type { JobParams } from '@/schema/jobs';
import { ControlButton } from './ControlButton';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToolbarPopover, type ToolbarPopoverMenuProps } from './ToolbarPopover';

export function WorkflowParameters({ inputs, params, onPatch, menuDirection = 'up', portalContainerRef }: {
  inputs: WorkflowInput[];
  params: JobParams;
  onPatch: (patch: JobParams) => void;
} & ToolbarPopoverMenuProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const fields = inputs.filter(input => !['prompt', 'image', 'mask'].includes(input.type));
  const values = params.workflow_inputs ?? {};
  const fixedSeed = fields.some(input => input.type === 'seed' && values[input.id] != null);
  const patchValue = (input: WorkflowInput, value: string | number | boolean | null) => onPatch({
    workflow_inputs: Object.fromEntries(fields.map(field => [field.id,
      field.id === input.id
        ? typeof value === 'number' && (input.type === 'int' || input.type === 'seed') ? Math.trunc(value) : value
        : values[field.id] ?? (field.type === 'seed' ? null : field.default)])),
    ...(input.type === 'seed' && value != null ? { n: 1 } : {}),
  });
  return <div ref={anchor} onKeyDown={event => {
    if (event.key !== 'Escape' || !open || event.defaultPrevented) return;
    event.stopPropagation();
    setOpen(false);
    anchor.current?.querySelector('button')?.focus();
  }}>
    <ControlButton active={open} aria-expanded={open} onClick={() => setOpen(!open)}><Settings2 size={14} aria-hidden />参数</ControlButton>
    <ToolbarPopover open={open} onClose={() => setOpen(false)} anchorRef={anchor} direction={menuDirection}
      portalContainerRef={portalContainerRef} autoFocus className="max-h-[65vh] w-80 overflow-y-auto rounded-xl border border-border bg-card p-4">
      <div className="space-y-4">
        {fields.map(input => {
          const value = values[input.id] ?? (input.type === 'seed' ? null : input.default);
          const id = `workflow-param-${input.id}`;
          return <div key={input.id} className="space-y-2">
            <Label htmlFor={id}>{input.label}</Label>
            {input.type === 'boolean' ? <Switch id={id} checked={value === true} onCheckedChange={checked => patchValue(input, checked)} />
              : input.type === 'select' ? <Select value={String(value ?? '')} onValueChange={value => {
                const option = input.options.find(option => String(option.value) === value);
                if (option) patchValue(input, option.value);
              }}><SelectTrigger id={id}><SelectValue /></SelectTrigger><SelectContent>{input.options.map(option => <SelectItem key={String(option.value)} value={String(option.value)}>{option.label}</SelectItem>)}</SelectContent></Select>
              : input.type === 'text' ? <Textarea id={id} value={String(value ?? '')} maxLength={40000} onChange={e => patchValue(input, e.target.value)} />
              : <>
                {input.type === 'seed' && <Label className="flex items-center gap-2 text-xs"><Switch checked={value != null} onCheckedChange={checked => patchValue(input, checked ? 0 : null)} />{value == null ? '随机' : '固定'}</Label>}
                {(input.type !== 'seed' || value != null) && <Input id={id} type="number" value={value == null ? '' : Number(value)} min={input.min ?? (input.type === 'seed' ? 0 : undefined)} max={input.max ?? (input.type === 'seed' ? Number.MAX_SAFE_INTEGER : undefined)} step={input.step ?? (input.type === 'float' ? 'any' : 1)} onChange={e => patchValue(input, e.target.value === '' ? null : Number(e.target.value))} />}
                {input.type !== 'seed' && input.min != null && input.max != null && <Slider aria-label={input.label} min={input.min} max={input.max} step={input.step ?? (input.type === 'float' ? 0.01 : 1)} value={[Number(value ?? input.min)]} onValueChange={([value]) => patchValue(input, value)} />}
              </>}
          </div>;
        })}
        <Label className="block space-y-2">张数<Select value={String(fixedSeed ? 1 : params.n ?? 1)} disabled={fixedSeed} onValueChange={value => onPatch({ n: Number(value) })}>
          <SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{[1, 2, 3, 4].map(n => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
        </Select></Label>
      </div>
    </ToolbarPopover>
  </div>;
}
