import { useState } from 'react';
import { useClipboard } from '../hooks/useClipboard';

interface Props { characterId: string | null }

export function FeedbackInput({ characterId }: Props) {
  const [text, setText] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const copyToClipboard = useClipboard();

  async function submit() {
    if (!text.trim()) return;
    await fetch('/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, character_id: characterId }),
    });
    const { success } = await copyToClipboard('继续');
    setText('');
    setToast(success ? '已提交反馈，切到 CC 按 Cmd+V Enter' : '已提交反馈（剪贴板失败，手动复制"继续"）');
  }

  return (
    <div style={{ borderTop: '1px solid var(--color-border)', padding: 16 }}>
      <h3 style={{ fontSize: 'var(--fs-label)', marginBottom: 8, color: 'var(--color-text-muted)' }}>
        反馈
      </h3>
      <textarea value={text} onChange={e => setText(e.target.value)}
                placeholder="例如：2 号那张光线再阴一点" rows={3} />
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={submit} disabled={!text.trim()}>提交</button>
      </div>
      {toast && <div style={{ marginTop: 8, fontSize: 'var(--fs-meta)', color: 'var(--color-status-done)' }}>{toast}</div>}
    </div>
  );
}
