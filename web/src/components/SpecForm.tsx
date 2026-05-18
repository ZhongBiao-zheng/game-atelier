import { useEffect, useRef, useState } from 'react';
import { useClipboard } from '../hooks/useClipboard';

interface Props { characterId: string | null; sseSignal: number }

export function SpecForm({ characterId, sseSignal }: Props) {
  const [content, setContent] = useState('');
  const [serverContent, setServerContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'warn'; msg: string } | null>(null);
  const copyToClipboard = useClipboard();
  const autoSaveTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!characterId) return;
    fetch(`/api/spec/${characterId}`)
      .then(r => r.ok ? r.json() : { content: '' })
      .then(d => {
        setServerContent(d.content);
        // §5.4: don't overwrite dirty content — surface stale notice instead
        if (!dirty) { setContent(d.content); }
      });
    // dirty is intentionally excluded from deps: refetch should only run when
    // characterId or sseSignal change. Reading dirty via closure is fine here
    // because the effect won't fire on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, sseSignal]);

  // Reset state when switching characters
  useEffect(() => {
    setDirty(false);
    setToast(null);
  }, [characterId]);

  useEffect(() => {
    if (!dirty || !characterId) return;
    if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = window.setTimeout(() => {
      void save(false);
    }, 5000);
    return () => { if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, dirty, characterId]);

  async function save(triggerClipboard: boolean) {
    if (!characterId) return;
    const r = await fetch(`/api/spec/${characterId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!r.ok) { setToast({ kind: 'warn', msg: '保存失败' }); return; }
    setServerContent(content);
    setDirty(false);
    if (triggerClipboard) {
      const { success } = await copyToClipboard('继续');
      setToast(success
        ? { kind: 'ok', msg: '已保存，切到 CC 按 Cmd+V Enter' }
        : { kind: 'warn', msg: '保存成功，但剪贴板写入失败' });
    }
  }

  if (!characterId) return <section style={panelStyle}><p>请在左栏选择角色</p></section>;

  const stale = serverContent !== content && !dirty;  // server-side changed while not editing

  return (
    <section style={panelStyle}>
      <h2 style={{ fontSize: 'var(--fs-section)', marginBottom: 12 }}>规格表单</h2>
      {stale && (
        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--color-status-running)', marginBottom: 8 }}>
          文件已变更 <button style={{ padding: '2px 8px', fontSize: 'var(--fs-meta)' }}
                          onClick={() => { setContent(serverContent); }}>[刷新]</button>
        </div>
      )}
      <textarea
        value={content}
        onChange={e => { setContent(e.target.value); setDirty(true); }}
        style={{ width: '100%', height: 'calc(100% - 120px)', fontFamily: 'monospace', resize: 'none' }} />
      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => save(true)} disabled={!dirty}>保存</button>
        {dirty && <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--color-text-muted)' }}>· 未保存</span>}
      </div>
      {toast && (
        <div style={{
          marginTop: 12, padding: 8, borderRadius: 6,
          background: toast.kind === 'ok' ? 'var(--color-status-done)' : 'var(--color-status-running)',
          color: 'black',
        }}>{toast.msg}</div>
      )}
    </section>
  );
}

const panelStyle: React.CSSProperties = {
  borderLeft: '1px solid var(--color-border)',
  padding: 16, height: '100vh', overflow: 'auto',
};
