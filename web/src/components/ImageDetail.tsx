import { useEffect, useState } from 'react';
import type { Job, WebEditableJobPatch } from '../schema/jobs';
import { useClipboard } from '../hooks/useClipboard';

interface Props { jobId: string; path: string; onBack: () => void }

export function ImageDetail({ jobId, path, onBack }: Props) {
  const [job, setJob] = useState<Job | null>(null);
  const [patch, setPatch] = useState<WebEditableJobPatch>({});
  const copyToClipboard = useClipboard();
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/jobs/${jobId}`).then(r => r.json()).then(setJob);
  }, [jobId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onBack();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onBack]);

  if (!job) return <section style={panelStyle}><p>加载中…</p></section>;

  async function copyAndTriggerRetry() {
    const promptToCopy = patch.prompt ?? job!.prompt;
    await fetch(`/api/prompt/${jobId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const { success } = await copyToClipboard(`继续\n${promptToCopy}`);
    setToast(success
      ? '已保存 + 剪贴板复制完成，切到 CC 按 Cmd+V Enter 重新出图'
      : '已保存，但剪贴板失败，请手动复制 prompt');
  }

  async function deleteImage() {
    if (!window.confirm(`删除这张图？\n${path}\n（磁盘文件也会删，不可恢复）`)) return;
    const r = await fetch(`/api/jobs/${jobId}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (!r.ok) { setToast(`删除失败：HTTP ${r.status}`); return; }
    onBack();
  }

  return (
    <section style={panelStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button onClick={onBack} aria-label="返回">← 返回</button>
        <button onClick={deleteImage} title="删除这张图（磁盘也会删）"
                style={{ color: 'var(--color-status-failed)' }}>
          删除
        </button>
      </div>
      <img src={`/api/raw?path=${encodeURIComponent(path)}&job_id=${encodeURIComponent(jobId)}`}
           alt="大图" style={{
             width: '100%', marginTop: 12, borderRadius: 8,
             maxHeight: '50vh', objectFit: 'contain',
             background: 'var(--color-bg-elevated)',
           }} />
      <div style={{ marginTop: 16 }}>
        <Field label="prompt" copyable onCopy={copyAndTriggerRetry}>
          <textarea value={patch.prompt ?? job.prompt}
                    onChange={e => setPatch({ ...patch, prompt: e.target.value })}
                    style={{
                      width: '100%', minHeight: 240, fontFamily: 'monospace',
                      resize: 'vertical', boxSizing: 'border-box',
                    }} />
        </Field>
        <Field label="model">
          <input value={patch.model ?? job.model}
                 onChange={e => setPatch({ ...patch, model: e.target.value })}
                 style={{ width: '100%', boxSizing: 'border-box' }} />
        </Field>
        <Field label="seed">
          <input value={(patch.seed ?? job.seed ?? '') as string | number}
                 onChange={e => setPatch({ ...patch, seed: e.target.value ? Number(e.target.value) : null })}
                 style={{ width: '100%', boxSizing: 'border-box' }} />
        </Field>
        <Field label="submitted_at">
          <span style={{ color: 'var(--color-text-muted)' }}>{job.submitted_at}</span>
        </Field>
        <Field label="status">
          <span style={{ color: `var(--color-status-${job.status})` }}>{job.status}</span>
        </Field>
      </div>
      {toast && <div style={{ marginTop: 12, padding: 8, background: 'var(--color-status-done)', borderRadius: 6, color: 'black' }}>{toast}</div>}
    </section>
  );
}

function Field({ label, copyable, onCopy, children }: {
  label: string; copyable?: boolean; onCopy?: () => void; children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <label style={{ fontSize: 'var(--fs-label)', color: 'var(--color-text-muted)' }}>{label}</label>
        {copyable && <button onClick={onCopy} style={{ fontSize: 'var(--fs-meta)', padding: '2px 8px' }}>复制 → 重出图</button>}
      </div>
      {children}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  borderLeft: '1px solid var(--color-border)',
  padding: 16, height: '100vh', overflow: 'auto',
};
