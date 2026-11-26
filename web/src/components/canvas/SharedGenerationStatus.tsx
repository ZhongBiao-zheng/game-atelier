import type { CanvasNode } from '@/schema/canvas';

export function SharedGenerationStatus({ run }: { run: CanvasNode['collab_run'] }) {
  if (!run || run.status === 'done') return null;
  const message = run.status === 'pending' ? '生成中' : run.status === 'interrupted' ? '生成中断' : '生成失败';
  return <span role="status"
    className="pointer-events-none absolute inset-x-2 top-2 z-10 truncate rounded bg-card/95 px-2 py-1 text-xs text-foreground">
    {message} · 由{run.initiated_by}发起
    {run.error && <span className="block whitespace-normal text-muted-foreground">{run.error}</span>}
  </span>;
}
