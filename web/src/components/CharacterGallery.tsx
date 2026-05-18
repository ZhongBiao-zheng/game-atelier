import { useEffect, useState } from 'react';
import { X, AlertTriangle, Loader2 } from 'lucide-react';
import type { Job } from '../schema/jobs';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  characterId: string | null;
  characterName: string | null;
  detailMode: boolean;
  onSelectImage: (path: string, jobId: string) => void;
  sseSignal: number;
}

export function CharacterGallery({ characterId, characterName, detailMode, onSelectImage, sseSignal }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!characterId) return;
    setLoading(true);
    fetch(`/api/jobs`)
      .then(r => r.json() as Promise<Job[]>)
      .then(all => setJobs(all.filter(j => j.character_id === characterId)))
      .finally(() => setLoading(false));
  }, [characterId, sseSignal]);

  if (!characterId) return <EmptyShell title="请在左栏选择角色" subtitle="Atelier · 角色资产工坊" />;
  if (loading && jobs.length === 0) return <GalleryShell name={characterName} count={0} rounds={0} compact={detailMode}><Skeleton cols={detailMode ? 2 : 3} /></GalleryShell>;

  const allImages: { path: string; jobId: string; status: Job['status'] }[] = [];
  jobs.forEach(j => j.output_paths.forEach(p => allImages.push({ path: p, jobId: j.job_id, status: j.status })));
  const failedJobs = jobs.filter(j => j.status === 'failed');
  const isRunning = jobs.some(j => j.status === 'running');
  const pendingConfirm = jobs.filter(j => j.status === 'pending_confirm');

  async function deleteImage(jobId: string, path: string) {
    if (!window.confirm(`删除这张图？\n${path}\n（磁盘文件也会删，不可恢复）`)) return;
    const r = await fetch(`/api/jobs/${jobId}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (!r.ok) { alert(`删除失败：HTTP ${r.status}`); return; }
    setJobs(js => js.map(j => j.job_id === jobId
      ? { ...j, output_paths: j.output_paths.filter(p => p !== path) }
      : j));
  }

  const cols = detailMode ? 2 : 3;
  const gridCols = cols === 2 ? 'grid-cols-2' : 'grid-cols-3';
  const hasAny = allImages.length > 0 || isRunning || failedJobs.length > 0 || pendingConfirm.length > 0;

  return (
    <GalleryShell name={characterName} count={allImages.length} rounds={jobs.length} compact={detailMode}>
      {pendingConfirm.map(j => <ConfirmCard key={j.job_id} job={j} />)}

      {!hasAny && (
        <div className="py-16 text-center">
          <p className="font-[var(--font-display)] italic text-2xl text-foreground/70 mb-2">
            等待第一张作品
          </p>
          <p className="text-xs text-muted-foreground">保存档案后将触发首轮出图</p>
        </div>
      )}

      {hasAny && (
        <div className={cn('grid gap-4', gridCols)}>
          {allImages.map((img, i) => (
            <figure key={i} className="group relative aspect-square">
              <button
                onClick={() => onSelectImage(img.path, img.jobId)}
                className="size-full overflow-hidden rounded-lg border border-border/50 bg-card transition-all duration-200 hover:border-primary/60 hover:shadow-[0_0_0_1px_var(--primary)] cursor-pointer p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <img
                  src={`/api/raw?path=${encodeURIComponent(img.path)}&job_id=${encodeURIComponent(img.jobId)}`}
                  alt=""
                  className="size-full object-cover transition-opacity duration-300 group-hover:opacity-95"
                />
              </button>
              <figcaption className="pointer-events-none absolute bottom-2 left-2 font-mono text-[10px] tabular-nums tracking-wider text-foreground bg-background/75 backdrop-blur-sm px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                №{String(i + 1).padStart(2, '0')}
              </figcaption>
              <button
                onClick={(e) => { e.stopPropagation(); void deleteImage(img.jobId, img.path); }}
                title="删除这张图"
                aria-label="删除"
                className="absolute right-2 top-2 size-7 rounded-full bg-black/70 text-white grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm hover:bg-destructive cursor-pointer border-0"
              >
                <X className="size-3.5" />
              </button>
            </figure>
          ))}

          {isRunning && Array.from({ length: 2 }).map((_, i) => <SkeletonCard key={`s${i}`} />)}
          {failedJobs.map(j => <ErrorCard key={j.job_id} jobId={j.job_id} error={j.error || '未知错误'} />)}
        </div>
      )}
    </GalleryShell>
  );
}

function GalleryShell({
  name, count, rounds, children, compact = false,
}: { name: string | null; count: number; rounds: number; children: React.ReactNode; compact?: boolean }) {
  return (
    <main className="flex flex-col h-screen overflow-hidden">
      <header className={cn('border-b border-border/40', compact ? 'px-5 pt-5 pb-3' : 'px-8 pt-8 pb-5')}>
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className={cn('uppercase text-muted-foreground/70 mb-1', compact ? 'text-[9px] tracking-[0.2em]' : 'text-[10px] tracking-[0.22em]')}>
              gallery · 角色
            </div>
            <h1 className={cn(
              'font-[var(--font-display)] italic leading-[1.05] tracking-tight text-foreground truncate',
              compact ? 'text-xl' : 'text-[40px]',
            )}>
              {name ?? '—'}
            </h1>
          </div>
          {count > 0 && (
            <div className={cn('shrink-0 text-right font-mono tabular-nums text-muted-foreground leading-relaxed',
              compact ? 'text-[10px]' : 'text-xs')}>
              <div><span className="text-foreground/85">{count}</span> 图</div>
              <div><span className="text-foreground/85">{rounds}</span> 轮</div>
            </div>
          )}
        </div>
      </header>
      <div className={cn('flex-1 overflow-y-auto', compact ? 'px-4 py-4' : 'px-8 py-6')}>
        {children}
      </div>
    </main>
  );
}

function EmptyShell({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <main className="flex h-screen flex-col items-center justify-center px-8 text-center">
      <div className="space-y-3">
        <p className="font-[var(--font-display)] italic text-[40px] leading-[1.1] text-foreground/75">
          {title}
        </p>
        {subtitle && (
          <p className="text-[10px] uppercase tracking-[0.28em] text-muted-foreground/70">
            {subtitle}
          </p>
        )}
      </div>
    </main>
  );
}

function Skeleton({ cols }: { cols: number }) {
  const gridCols = cols === 2 ? 'grid-cols-2' : 'grid-cols-3';
  return (
    <div className={cn('grid gap-4', gridCols)}>
      {Array.from({ length: cols * 2 }).map((_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="relative aspect-square overflow-hidden rounded-lg border border-border/40 bg-card animate-pulse">
      <div className="absolute bottom-3 left-3 flex items-center gap-1.5 text-xs text-[color:var(--status-running)]">
        <Loader2 className="size-3 animate-spin" />
        生成中…
      </div>
    </div>
  );
}

function ConfirmCard({ job }: { job: Job }) {
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(kind: 'confirm' | 'cancel') {
    setBusy(kind);
    setError(null);
    try {
      const r = await fetch(`/api/jobs/${job.job_id}/${kind}`, { method: 'POST' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail || `HTTP ${r.status}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const params = job.params || {};
  const refs = (params.reference_images || []) as string[];

  return (
    <div className="mb-6 rounded-lg border border-[color:var(--status-running)]/40 bg-[color:var(--status-running)]/[0.06] p-5">
      <div className="flex items-baseline justify-between mb-4 gap-4">
        <div className="flex items-baseline gap-2.5 text-[color:var(--status-running)] min-w-0">
          <span className="inline-block size-2 rounded-full bg-[color:var(--status-running)] animate-pulse shadow-[0_0_8px_var(--status-running)] translate-y-[-2px] shrink-0" />
          <span className="font-[var(--font-display)] italic text-xl truncate">即将出图 · 待确认</span>
        </div>
        <span className="font-mono text-[10px] text-muted-foreground tracking-wider shrink-0">{job.job_id}</span>
      </div>

      <dl className="text-xs leading-relaxed space-y-1.5">
        <Row label="模型">{job.model}{params.vendor ? ` · ${params.vendor}` : ''}</Row>
        <Row label="尺寸">{params.size || '默认'}</Row>
        <Row label="数量">{params.n ?? 1} 张</Row>
        <Row label="参考图">
          {refs.length
            ? <div className="space-y-0.5">{refs.map((p, i) => <div key={i} className="font-mono text-muted-foreground">{p}</div>)}</div>
            : <span className="text-muted-foreground">无</span>}
        </Row>
        <Row label="seed">{job.seed ?? '随机'}</Row>
        <Row label="prompt">
          <pre className="whitespace-pre-wrap break-words font-sans bg-transparent text-foreground/90 leading-relaxed">{job.prompt}</pre>
        </Row>
      </dl>

      <div className="mt-5 flex gap-2">
        <Button size="sm" onClick={() => act('confirm')} disabled={busy !== null}>
          {busy === 'confirm' ? '推进中…' : '出图'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => act('cancel')} disabled={busy !== null}>
          {busy === 'cancel' ? '取消中…' : '取消'}
        </Button>
      </div>

      {error && (
        <div className="mt-3 text-xs text-destructive flex items-center gap-1.5">
          <AlertTriangle className="size-3.5" />
          {error}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-3">
      <dt className="text-muted-foreground text-[10px] uppercase tracking-[0.18em] mt-0.5">{label}</dt>
      <dd className="m-0 text-foreground/90">{children}</dd>
    </div>
  );
}

function ErrorCard({ jobId }: { error: string; jobId: string }) {
  return (
    <div className="flex aspect-square flex-col items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-center">
      <AlertTriangle className="size-7 text-destructive" />
      <div className="text-xs text-destructive font-medium">出图失败</div>
      <button
        onClick={() => alert(`重试 ${jobId}：复制 prompt 后 Cmd+V`)}
        className="text-xs text-primary hover:underline cursor-pointer bg-transparent border-0 p-0"
      >
        [重试]
      </button>
    </div>
  );
}
