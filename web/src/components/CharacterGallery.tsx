import { useEffect, useState } from 'react';
import { X, AlertTriangle, ImageOff, Loader2 } from 'lucide-react';
import type { Job } from '../schema/jobs';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  characterId: string | null;
  detailMode: boolean;
  onSelectImage: (path: string, jobId: string) => void;
  sseSignal: number;
}

export function CharacterGallery({ characterId, detailMode, onSelectImage, sseSignal }: Props) {
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

  if (!characterId) return <Empty>请在左栏选择角色</Empty>;
  if (loading && jobs.length === 0) return <Skeleton cols={detailMode ? 2 : 4} />;

  const allImages: { path: string; jobId: string; status: Job['status'] }[] = [];
  jobs.forEach(j => j.output_paths.forEach(p => allImages.push({ path: p, jobId: j.job_id, status: j.status })));
  const failedJobs = jobs.filter(j => j.status === 'failed');
  const isRunning = jobs.some(j => j.status === 'running');
  const pendingConfirm = jobs.filter(j => j.status === 'pending_confirm');

  if (allImages.length === 0 && !isRunning && failedJobs.length === 0 && pendingConfirm.length === 0) {
    return <Empty>还没有出图，保存档案后触发第一轮</Empty>;
  }

  async function deleteImage(jobId: string, path: string) {
    if (!window.confirm(`删除这张图？\n${path}\n（磁盘文件也会删，不可恢复）`)) return;
    const r = await fetch(`/api/jobs/${jobId}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (!r.ok) { alert(`删除失败：HTTP ${r.status}`); return; }
    setJobs(js => js.map(j => j.job_id === jobId
      ? { ...j, output_paths: j.output_paths.filter(p => p !== path) }
      : j));
  }

  const cols = detailMode ? 2 : 4;
  const gridCols = cols === 2 ? 'grid-cols-2' : 'grid-cols-4';

  return (
    <main className="overflow-y-auto p-5 bg-background">
      {pendingConfirm.map(j => <ConfirmCard key={j.job_id} job={j} />)}

      <div className={cn('grid gap-3', gridCols)}>
        {allImages.map((img, i) => (
          <div key={i} className="group relative aspect-square">
            <button
              onClick={() => onSelectImage(img.path, img.jobId)}
              className="size-full overflow-hidden rounded-lg border border-border bg-card transition-all hover:border-primary/40 hover:shadow-lg cursor-pointer p-0"
            >
              <img
                src={`/api/raw?path=${encodeURIComponent(img.path)}&job_id=${encodeURIComponent(img.jobId)}`}
                alt=""
                className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
              />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); void deleteImage(img.jobId, img.path); }}
              title="删除这张图"
              className="absolute right-1.5 top-1.5 size-6 rounded-full bg-black/60 text-white grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm hover:bg-black/80 cursor-pointer border-0"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}

        {isRunning && Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={`s${i}`} />)}
        {failedJobs.map(j => <ErrorCard key={j.job_id} jobId={j.job_id} error={j.error || '未知错误'} />)}
      </div>
    </main>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex items-center justify-center p-5 text-sm text-muted-foreground bg-background">
      <div className="flex flex-col items-center gap-3">
        <ImageOff className="size-8 opacity-40" />
        <span>{children}</span>
      </div>
    </main>
  );
}

function Skeleton({ cols }: { cols: number }) {
  const gridCols = cols === 2 ? 'grid-cols-2' : 'grid-cols-4';
  return (
    <main className="p-5 bg-background">
      <div className={cn('grid gap-3', gridCols)}>
        {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    </main>
  );
}

function SkeletonCard() {
  return (
    <div className="relative aspect-square overflow-hidden rounded-lg border border-border bg-card animate-pulse">
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 text-xs text-[color:var(--status-running)]">
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
    <div className="mb-5 rounded-lg border border-[color:var(--status-running)]/40 bg-[color:var(--status-running)]/5 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-[color:var(--status-running)]">
          <span className="inline-block size-1.5 rounded-full bg-[color:var(--status-running)] animate-pulse" />
          即将出图 · 待确认
        </div>
        <span className="font-mono text-xs text-muted-foreground">{job.job_id}</span>
      </div>

      <dl className="text-xs leading-relaxed space-y-1">
        <Row label="模型 / 厂家">{job.model}{params.vendor ? ` · ${params.vendor}` : ''}</Row>
        <Row label="尺寸">{params.size || '默认'}</Row>
        <Row label="数量">{params.n ?? 1} 张</Row>
        <Row label="参考图">
          {refs.length
            ? <div className="space-y-0.5">{refs.map((p, i) => <div key={i} className="font-mono">{p}</div>)}</div>
            : '无'}
        </Row>
        <Row label="seed">{job.seed ?? '随机'}</Row>
        <Row label="中文 prompt">
          <pre className="whitespace-pre-wrap break-words font-sans bg-transparent">{job.prompt}</pre>
        </Row>
      </dl>

      <div className="mt-4 flex gap-2">
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
    <div className="grid grid-cols-[80px_1fr] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0">{children}</dd>
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
