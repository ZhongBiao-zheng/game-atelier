import { useState } from 'react';

interface Props { onSaved: (root: string) => void }

export function FirstRunConfig({ onSaved }: Props) {
  const [path, setPath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!path.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_storage_root: path.trim() }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.detail || `HTTP ${r.status}`);
      }
      onSaved(path.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ width: 480, padding: 32 }}>
        <h1 style={{ fontSize: 24, marginBottom: 8 }}>角色资产工作流</h1>
        <p style={{ color: 'var(--color-text-muted)', marginBottom: 24 }}>
          你的角色资产工作流管理台。先选一个目录存放出图。
        </p>
        <label style={{ display: 'block', fontSize: 'var(--fs-label)', marginBottom: 4 }}>图片存储目录</label>
        <input value={path} onChange={e => setPath(e.target.value)}
               placeholder="/Users/<you>/Pictures/character-assets"
               style={{ marginBottom: 12 }} />
        <button onClick={submit} disabled={!path.trim() || submitting} style={{ width: '100%' }}>
          {submitting ? '保存中…' : '开始使用'}
        </button>
        {error && <p style={{ color: 'var(--color-status-failed)', fontSize: 'var(--fs-meta)', marginTop: 8 }}>{error}</p>}
      </div>
    </div>
  );
}
