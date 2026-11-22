import { useRef, useState } from 'react';
import { AutoModeIcon, ConfirmModeIcon } from '@/components/ui/icons';
import { ToolbarPopover } from '@/components/studio/ToolbarPopover';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { Hint } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** 与服务端 canvas_agent_cost.MAX_CONFIRM_ABOVE_CNY 一致。 */
const MAX_CONFIRM_ABOVE = 10_000;

/**
 * 权限：审查 = 每一步都先确认；Auto = 直接执行，只有单次估价超过确认金额的生成先确认
 * （服务端 canvas_agent_runtime.generation_over_threshold，未计价的不拦）。
 */
export function CanvasAgentPermissionMenu({ auto, confirmAbove, disabled, onModeChange, onConfirmAboveChange }: {
  auto: boolean;
  /** null：还没读到。 */
  confirmAbove: number | null;
  disabled?: boolean;
  onModeChange: (mode: 'review' | 'auto') => void;
  onConfirmAboveChange: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const hint = auto
    ? `Auto${confirmAbove === null ? '' : `：超过 ${confirmAbove}¥ 的生成先确认`}`
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
          auto && 'text-primary',
        )}
      >{auto ? <AutoModeIcon /> : <ConfirmModeIcon />}</Button></Hint>
      <ToolbarPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        direction="up"
        align="end"
        aria-label="权限模式"
        className="flex w-60 flex-col gap-2.5 rounded-xl border border-border bg-popover p-2 shell-glow"
      >
        <Segmented aria-label="权限模式" className="grid-cols-2 bg-secondary/60">
          <SegmentedItem value="review" selected={!auto} onSelect={() => onModeChange('review')}>审查</SegmentedItem>
          <SegmentedItem value="auto" selected={auto} onSelect={() => onModeChange('auto')}>Auto</SegmentedItem>
        </Segmented>
        {auto && confirmAbove !== null && (
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <span>超过</span>
            <NumberInput
              aria-label="确认金额"
              value={confirmAbove}
              min={0}
              max={MAX_CONFIRM_ABOVE}
              unit="¥"
              onValueChange={onConfirmAboveChange}
              className="w-24"
            />
            <span>的生成先确认</span>
          </div>
        )}
      </ToolbarPopover>
    </>
  );
}
