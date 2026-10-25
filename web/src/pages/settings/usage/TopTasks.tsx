import { Link } from 'wouter';
import type { UsageTask } from '@/schema/usage';
import { formatGenerationCost } from '@/lib/generationCost';
import { useVideoFrame } from '@/lib/videoFrame';
import { KindBadge } from './KindBadge';
import { chartColors } from './RankingCard';
function TaskContent({ task, color }: { task: UsageTask; color: string }) {
  const frame = useVideoFrame(task.kind === 'video' ? task.thumb_url : null, task.kind === 'video');
  const thumb = task.kind === 'video' ? frame : task.thumb_url;
  return (
    <>
      {thumb && (
        <img src={thumb} alt="" loading="lazy" className="size-12 shrink-0 rounded-md object-cover" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        {task.prompt && <p className="truncate text-sm">{task.prompt}</p>}
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <KindBadge kind={task.kind} />
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${color}`} />
          <span className="truncate" title={`${task.label} · ${task.model}`}>{task.label} · {task.model} · {task.source === 'lan' ? '局域网' : '本机 KEY'}</span>
        </div>
        <p className="text-xs text-muted-foreground">{new Date(task.at).toLocaleString('zh-CN')}</p>
      </div>
      <span className="shrink-0 text-sm tabular-nums">{task.cost_cny === null ? '未计价' : formatGenerationCost(task.cost_cny)}</span>
    </>
  );
}
export function TopTasks({ tasks }: { tasks: UsageTask[] }) {
  const models = [...new Set(tasks.map(task => task.model))];
  const rowClass = 'flex min-w-0 items-center gap-3 py-3';
  return (
    <section className="min-w-0 space-y-3 rounded-xl border border-border bg-card p-5">
      <h2 className="text-sm font-medium">最贵的任务</h2>
      <div className="divide-y divide-border">
        {tasks.map((task) =>
          task.href ? (
            <Link key={task.id} href={task.href} className={`${rowClass} hover:bg-secondary/30`}>
              <TaskContent task={task} color={chartColors[models.indexOf(task.model) % 5]} />
            </Link>
          ) : (
            <div key={task.id} className={rowClass}>
              <TaskContent task={task} color={chartColors[models.indexOf(task.model) % 5]} />
            </div>
          ),
        )}
      </div>
    </section>
  );
}
