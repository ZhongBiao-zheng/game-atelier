import * as React from 'react';

import { cn } from '@/lib/utils';
import { Button } from './button';
import { ChevronDownIcon, ChevronUpIcon } from './icons';
import { InputGroup, InputGroupAddon, InputGroupInput } from './input-group';

interface NumberInputProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** 数字后的单位（如 s）。 */
  unit?: string;
  onValueChange: (value: number) => void;
  className?: string;
  'aria-label'?: string;
}

function clampToStep(value: number, min: number, max: number, step: number) {
  const snapped = min + Math.round((value - min) / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

const STEP_BUTTON = 'flex h-4 w-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';

/** 步进数字输入：右侧上下箭头与方向键按 step 增减；手输在回车或失焦时夹到 [min, max]，非数字还原。 */
export function NumberInput({ value, min, max, step = 1, unit, onValueChange, className, 'aria-label': ariaLabel }: NumberInputProps) {
  const [draft, setDraft] = React.useState<string | null>(null);

  const commit = (next: number) => {
    const clamped = clampToStep(next, min, max, step);
    setDraft(null);
    if (clamped !== value) onValueChange(clamped);
  };
  const commitDraft = () => {
    if (draft === null) return;
    const parsed = Number(draft.trim());
    if (draft.trim() === '' || !Number.isFinite(parsed)) setDraft(null);
    else commit(parsed);
  };

  return (
    <InputGroup className={cn('w-24 bg-popover', className)}>
      <InputGroupInput
        inputMode="numeric"
        role="spinbutton"
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        value={draft ?? String(value)}
        onChange={event => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={event => {
          if (event.key === 'Enter') commitDraft();
          else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            commit(value + (event.key === 'ArrowUp' ? step : -step));
          }
        }}
        className="text-right tabular-nums"
      />
      <InputGroupAddon align="inline-end" className="gap-1.5 pl-0 pr-1">
        {unit && <span className="ml-1 text-sm text-foreground">{unit}</span>}
        <div className="flex flex-col">
          <Button variant="bare" type="button" tabIndex={-1} aria-label="增加" disabled={value >= max}
            onClick={() => commit(value + step)} className={STEP_BUTTON}>
            <ChevronUpIcon size="sm" aria-hidden />
          </Button>
          <Button variant="bare" type="button" tabIndex={-1} aria-label="减少" disabled={value <= min}
            onClick={() => commit(value - step)} className={STEP_BUTTON}>
            <ChevronDownIcon size="sm" aria-hidden />
          </Button>
        </div>
      </InputGroupAddon>
    </InputGroup>
  );
}
