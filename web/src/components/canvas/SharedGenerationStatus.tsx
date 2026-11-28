import { AnimatePresence, motion } from 'motion/react';
import { LoadingIcon, WarningIcon } from '@/components/ui/icons';
import { Hint } from '@/components/ui/tooltip';
import { MOTION_DURATION, MOTION_EASE, motionAvailable } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { CanvasNode } from '@/schema/canvas';

/** 共享生成的进度胶囊：转圈 + 「生成中…」，发起人与错误原因放进 Hint。完成后淡出，结果节点自己的进场接住反馈。 */
export function SharedGenerationStatus({ run }: { run: CanvasNode['collab_run'] }) {
  const shown = run && run.status !== 'done' ? run : null;
  const fade = { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle };
  return <AnimatePresence initial={false}>
    {shown && <motion.span key="collab-run" role="status"
      initial={motionAvailable() ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade }}
      exit={motionAvailable() ? { opacity: 0, transition: fade } : undefined}
      className={cn('absolute bottom-2 left-2 z-20 flex max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md border bg-card/95 px-2 py-1.5 text-xs',
        shown.status === 'pending'
          ? 'border-[color:var(--status-running)]/30 text-[color:var(--status-running)]'
          : 'border-[color:var(--status-failed)]/30 text-[color:var(--status-failed)]')}>
      {shown.status === 'pending'
        ? <span className="canvas-generation-indicator size-5 shrink-0" aria-hidden="true"><LoadingIcon size="lg" /></span>
        : <WarningIcon size="sm" aria-hidden="true" />}
      <Hint label={[`由${shown.initiated_by}发起`, shown.error].filter(Boolean).join('：')}>
        <span tabIndex={0} className="truncate">
          {shown.status === 'pending' ? '生成中…' : shown.status === 'interrupted' ? '生成中断' : '生成失败'}
          <span className="sr-only">，由{shown.initiated_by}发起{shown.error && '：' + shown.error}</span>
        </span>
      </Hint>
    </motion.span>}
  </AnimatePresence>;
}
