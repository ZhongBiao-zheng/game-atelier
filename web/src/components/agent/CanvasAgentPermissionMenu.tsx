import { useRef, useState } from 'react';
import { AutoModeIcon, CheckIcon, ChevronDownIcon, ConfirmModeIcon } from '@/components/ui/icons';
import { ToolbarPopover } from '@/components/studio/ToolbarPopover';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { NumberInput } from '@/components/ui/number-input';
import { Hint } from '@/components/ui/tooltip';
import { SelectionHighlight } from '@/components/ui/selection-highlight';
import { formatGenerationCost } from '@/lib/generationCost';
import { cn } from '@/lib/utils';

/** 与服务端 canvas_agent_cost.MAX_CONFIRM_ABOVE_CNY 一致。 */
const MAX_CONFIRM_ABOVE = 10_000;

const PERMISSION_OPTIONS: {
  mode: 'auto' | 'review';
  label: string;
  description: string;
  Icon: typeof AutoModeIcon;
}[] = [
  { mode: 'auto', label: 'Auto', description: '自动执行，超额生成前先确认', Icon: AutoModeIcon },
  { mode: 'review', label: '审查', description: '每一步操作前都先确认', Icon: ConfirmModeIcon },
];

/**
 * Auto 模式下，服务端在本轮已提交、已预留与本次的合计估价超过确认金额时询问。
 */
export function CanvasAgentPermissionMenu({
  auto, confirmAbove, triggerClassName, direction = 'up', showLabel = false, disabled,
  onModeChange, onConfirmAboveChange,
}: {
  auto: boolean;
  /** null：还没读到。 */
  confirmAbove: number | null;
  triggerClassName?: string;
  direction?: 'up' | 'down';
  showLabel?: boolean;
  disabled?: boolean;
  onModeChange: (mode: 'review' | 'auto') => void;
  onConfirmAboveChange: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const hint = auto
    ? `Auto${confirmAbove === null ? '' : `：超过 ${formatGenerationCost(confirmAbove)} 先确认`}`
    : '审查：每一步都先确认';
  return (
    <>
      <Hint label={hint}><Button variant="bare"
        ref={anchorRef}
        type="button"
        aria-label={auto ? '权限模式：Auto' : '权限模式：审查'}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40',
          showLabel && 'flex w-auto gap-1.5 px-2.5 text-xs',
          open && 'bg-secondary text-foreground',
          triggerClassName,
        )}
      >
        {auto
          ? <AutoModeIcon size={showLabel ? 'sm' : 'md'} className="shrink-0 text-primary" />
          : <ConfirmModeIcon size={showLabel ? 'sm' : 'md'} className="shrink-0" />}
        {showLabel && <span>{auto ? 'Auto' : '审查'}</span>}
        {showLabel && <ChevronDownIcon size="sm" className="shrink-0 text-muted-foreground" />}
      </Button></Hint>
      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        direction={direction}
        align="end"
        aria-label="权限模式"
        className="flex w-64 flex-col gap-2 rounded-xl border border-border bg-card p-2"
      >
        <div role="radiogroup" aria-label="权限模式" className="relative isolate flex flex-col gap-1 rounded-lg bg-popover p-1">
          <SelectionHighlight className="rounded-lg" />
          {PERMISSION_OPTIONS.map(({ mode, label, description, Icon }) => {
            const selected = (mode === 'auto') === auto;
            return (
              <Button
                key={mode}
                variant="ghost"
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onModeChange(mode)}
                className={cn(
                  'h-auto w-full items-start justify-start gap-2.5 rounded-lg px-2.5 py-2 text-left font-normal hover:bg-secondary/60',
                  selected && 'hover:bg-transparent',
                )}
              >
                <Icon size="md" className={cn('mt-0.5 shrink-0', selected && mode === 'auto' ? 'text-primary' : 'text-muted-foreground')} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{label}</span>
                  <span className="block text-xs text-muted-foreground">{description}</span>
                </span>
                {selected && <CheckIcon size="sm" className="mt-0.5 shrink-0 text-primary" />}
              </Button>
            );
          })}
        </div>
        <Collapse open={auto && confirmAbove !== null}>
          {confirmAbove !== null && (
            <div className="flex items-center justify-between gap-2 border-t border-border px-1.5 pt-2 text-xs text-muted-foreground">
              <span>超过此金额先确认</span>
              <NumberInput
                aria-label="确认金额"
                value={confirmAbove}
                min={0}
                max={MAX_CONFIRM_ABOVE}
                unit="¥"
                onValueChange={onConfirmAboveChange}
                className="w-24"
              />
            </div>
          )}
        </Collapse>
      </ToolbarPopover>
    </>
  );
}
