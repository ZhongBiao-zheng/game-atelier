import { LoaderCircle, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CanvasNode } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';

export type CanvasNodeRunStatus = 'idle' | 'loading' | 'success' | 'error';

export interface CanvasNodeRunState {
  status: CanvasNodeRunStatus;
  label: string;
  detail: string | null;
  job: Job | undefined;
  reversePrompt: boolean;
}

export function canvasNodeRunDisplayError(
  detail: string | null | undefined,
  fallback = '生成失败，请检查模型配置后重试',
): string {
  const friendly = detail?.split(/（原始报错[：:]/, 1)[0].replace(/\s+/g, ' ').trim();
  if (!friendly) return fallback;
  return friendly.length > 140 ? `${friendly.slice(0, 139)}…` : friendly;
}

export function canvasNodeRunState(
  node: CanvasNode,
  jobsByRunId: ReadonlyMap<string, Job>,
): CanvasNodeRunState {
  const runId = activeRunId(node);
  const mappedJob = runId ? jobsByRunId.get(runId) : undefined;
  const job = mappedJob?.canvas_run?.result_node_id === node.id ? mappedJob : undefined;
  if (!job) {
    return { status: 'idle', label: '待编辑', detail: null, job: undefined, reversePrompt: false };
  }
  const reversePrompt = isReversePromptJob(job);
  if (job.status === 'pending' || job.status === 'pending_confirm') {
    return {
      status: 'loading',
      label: job.cancel_requested_at ? '正在停止…' : reversePrompt ? '正在分析提示词' : '正在生成',
      detail: job.cancel_requested_at ? '已请求停止，上游可能仍在执行' : null,
      job,
      reversePrompt,
    };
  }
  if (job.status === 'done') {
    return {
      status: 'success',
      label: reversePrompt ? '分析完成' : '生成完成',
      detail: null,
      job,
      reversePrompt,
    };
  }
  if (job.status === 'partial') {
    return {
      status: 'success',
      label: '部分完成',
      detail: job.error ? canvasNodeRunDisplayError(job.error, '部分结果生成失败') : null,
      job,
      reversePrompt,
    };
  }
  if (job.status === 'failed') {
    return {
      status: 'error',
      label: reversePrompt ? '分析失败' : '生成失败',
      detail: canvasNodeRunDisplayError(
        job.error,
        reversePrompt ? '反推提示词失败，可按原设置重试' : '生成失败，可按原设置重试',
      ),
      job,
      reversePrompt,
    };
  }
  return {
    status: 'idle',
    label: '已停止',
    detail: job.error ? canvasNodeRunDisplayError(job.error, '已停止') : null,
    job,
    reversePrompt,
  };
}

export function CanvasNodeRunBadge({ state }: { state: CanvasNodeRunState }) {
  if (!state.job) return null;
  return (
    <span
      data-canvas-node-status-label={state.status}
      className={cn(
        'ml-2 flex shrink-0 items-center gap-1 text-xs font-medium',
        state.status === 'loading' && 'text-[color:var(--status-running)]',
        state.status === 'success' && 'text-[color:var(--status-done)]',
        state.status === 'error' && 'text-[color:var(--status-failed)]',
        state.status === 'idle' && 'text-[color:var(--status-pending)]',
      )}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {state.label}
    </span>
  );
}

export function CanvasNodeRunLiveRegion({ state }: { state: CanvasNodeRunState }) {
  if (!state.job) return null;
  return (
    <>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {state.status !== 'error' ? state.detail || state.label : ''}
      </span>
      {state.status === 'error' && (
        <span role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
          {state.detail || state.label}
        </span>
      )}
    </>
  );
}

export function CanvasNodeRunOverlay({
  node,
  state,
  hasContent,
  submitting,
  onRetry,
}: {
  node: CanvasNode;
  state: CanvasNodeRunState;
  hasContent: boolean;
  submitting: boolean;
  onRetry: (nodeId: string, runId: string) => void;
}) {
  if (state.status !== 'loading' && state.status !== 'error') return null;
  const compact = hasContent;
  return (
    <div
      className={cn(
        'nodrag nowheel pointer-events-none absolute z-20 flex min-w-0 overflow-hidden text-xs backdrop-blur-glass',
        compact
          ? 'bottom-2 left-2 max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-md border bg-card/95 px-2 py-1.5'
          : 'inset-0 flex-col items-center justify-center gap-3 rounded-lg bg-card/95 px-5 text-center',
        state.status === 'loading'
          ? 'border-[color:var(--status-running)]/30 text-[color:var(--status-running)]'
          : 'border-[color:var(--status-failed)]/30 text-[color:var(--status-failed)]',
      )}
    >
      {state.status === 'loading' && (
        <span
          data-canvas-generation-indicator="true"
          className={cn('canvas-generation-indicator shrink-0', compact ? 'size-5' : 'size-12')}
          aria-hidden="true"
        >
          <LoaderCircle className={compact ? 'size-3.5' : 'size-5'} />
        </span>
      )}
      <span
        className={cn(
          'min-w-0 max-w-full',
          compact ? 'truncate' : 'line-clamp-3 break-words leading-relaxed',
        )}
        title={state.detail || state.label}
      >
        {state.detail || state.label}
      </span>
      {!compact && state.status === 'error' && state.job?.canvas_run && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="pointer-events-auto"
          disabled={submitting}
          onClick={event => {
            event.stopPropagation();
            onRetry(node.id, state.job!.canvas_run!.run_id);
          }}
        >
          {submitting ? <LoaderCircle aria-hidden="true" /> : <RotateCcw aria-hidden="true" />}
          {submitting ? '提交中…' : '按原设置重试'}
        </Button>
      )}
    </div>
  );
}

export function isReversePromptJob(job: Job): boolean {
  return job.canvas_run?.snapshot.normalized_params.preset_id === 'canvas.reverse_prompt'
    && job.canvas_run.snapshot.normalized_params.preset_version === 1;
}

function activeRunId(node: CanvasNode): string | null {
  if (node.type === 'text' || node.type === 'image' || node.type === 'video' || node.type === 'audio') {
    return node.data.active_run_id;
  }
  return null;
}
