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
  return (
    <main style={{ padding: 16, overflowY: 'auto' }}>
      {pendingConfirm.map(j => <ConfirmCard key={j.job_id} job={j} />)}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>
        {allImages.map((img, i) => (
          <div key={i} style={{ position: 'relative', aspectRatio: '1' }}>
            <button
              onClick={() => onSelectImage(img.path, img.jobId)}
              style={{
                padding: 0, background: 'var(--color-bg-elevated)',
                border: '1px solid var(--color-border)', borderRadius: 8,
                overflow: 'hidden', width: '100%', height: '100%', cursor: 'pointer',
              }}>
              <img src={`/api/raw?path=${encodeURIComponent(img.path)}&job_id=${encodeURIComponent(img.jobId)}`}
                   alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); void deleteImage(img.jobId, img.path); }}
              title="删除这张图"
              style={{
                position: 'absolute', top: 6, right: 6,
                width: 24, height: 24, borderRadius: '50%',
                background: 'rgba(0,0,0,0.6)', color: 'white',
                border: 'none', cursor: 'pointer', fontSize: 14, lineHeight: 1,
              }}>×</button>
          </div>
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
      // SSE 自动会重新拉 jobs，组件自然消失
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const params = job.params || {};
  const refs = (params.reference_images || []) as string[];

  return (
    <div style={{
      border: '1px solid var(--color-status-running)',
      borderRadius: 8, padding: 16, marginBottom: 16,
      background: 'var(--color-bg-elevated)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <strong style={{ color: 'var(--color-status-running)' }}>即将出图 · 待确认</strong>
        <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--color-text-muted)' }}>{job.job_id}</span>
      </div>
      <dl style={{ fontSize: 'var(--fs-meta)', lineHeight: 1.7, margin: 0 }}>
        <Row label="模型 / 厂家">{job.model}{params.vendor ? ` · ${params.vendor}` : ''}</Row>
        <Row label="尺寸">{params.size || '默认'}</Row>
        <Row label="数量">{params.n ?? 1} 张</Row>
        <Row label="参考图">{refs.length ? refs.map((p, i) => <div key={i} style={{ fontFamily: 'monospace' }}>{p}</div>) : '无'}</Row>
        <Row label="seed">{job.seed ?? '随机'}</Row>
        <Row label="中文 prompt">
          <pre style={{
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0,
            fontFamily: 'inherit', background: 'transparent',
          }}>{job.prompt}</pre>
        </Row>
      </dl>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={() => act('confirm')} disabled={busy !== null}>
          {busy === 'confirm' ? '推进中…' : '出图'}
        </button>
        <button onClick={() => act('cancel')} disabled={busy !== null}>
          {busy === 'cancel' ? '取消中…' : '取消'}
        </button>
      </div>
      {error && (
        <div style={{ marginTop: 8, color: 'var(--color-status-failed)', fontSize: 'var(--fs-meta)' }}>
          {error}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 12, marginBottom: 4 }}>
      <dt style={{ color: 'var(--color-text-muted)' }}>{label}</dt>
      <dd style={{ margin: 0 }}>{children}</dd>
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
