import { useEffect, useState } from 'react';
import type { Job } from '../schema/jobs';

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

  if (allImages.length === 0 && !isRunning && failedJobs.length === 0) {
    return <Empty>还没有出图，保存档案后触发第一轮</Empty>;
  }

  const cols = detailMode ? 2 : 4;
  return (
    <main style={{ padding: 16, overflowY: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>
        {allImages.map((img, i) => (
          <button key={i}
                  onClick={() => onSelectImage(img.path, img.jobId)}
                  style={{
                    padding: 0, background: 'var(--color-bg-elevated)',
                    border: '1px solid var(--color-border)', borderRadius: 8,
                    overflow: 'hidden', aspectRatio: '1', cursor: 'pointer',
                  }}>
            <img src={`/api/raw?path=${encodeURIComponent(img.path)}`}
                 alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </button>
        ))}
        {isRunning && Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={`s${i}`} />
        ))}
        {failedJobs.map(j => (
          <ErrorCard key={j.job_id} error={j.error || '未知错误'} jobId={j.job_id} />
        ))}
      </div>
    </main>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>
      {children}
    </main>
  );
}

function Skeleton({ cols }: { cols: number }) {
  return (
    <main style={{ padding: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>
        {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    </main>
  );
}

function SkeletonCard() {
  return (
    <div style={{
      aspectRatio: '1', background: 'var(--color-bg-elevated)',
      borderRadius: 8, position: 'relative', overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent)',
        animation: 'shimmer 1.5s infinite',
      }} />
      <div style={{ position: 'absolute', bottom: 8, left: 8, fontSize: 'var(--fs-meta)', color: 'var(--color-status-running)' }}>
        生成中…
      </div>
      <style>{`@keyframes shimmer {0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}`}</style>
    </div>
  );
}

function ErrorCard({ jobId }: { error: string; jobId: string }) {
  return (
    <div style={{
      aspectRatio: '1', background: 'var(--color-bg-elevated)',
      border: '1px solid var(--color-status-failed)', borderRadius: 8,
      padding: 12, display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center',
    }}>
      <div style={{ fontSize: 24 }}>⚠️</div>
      <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--color-status-failed)', margin: '4px 0' }}>
        出图失败
      </div>
      <a href="#" onClick={e => { e.preventDefault(); alert(`重试 ${jobId}：复制 prompt 后 Cmd+V`); }}
         style={{ fontSize: 'var(--fs-meta)', color: 'var(--color-accent)' }}>
        [重试]
      </a>
    </div>
  );
}
