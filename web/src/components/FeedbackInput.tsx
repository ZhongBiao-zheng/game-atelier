import { useState } from 'react';
import { Send, CheckCircle2 } from 'lucide-react';
import { useClipboard } from '../hooks/useClipboard';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

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
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between">
        <span className="font-[var(--font-display)] italic text-base text-foreground/90">反馈</span>
        <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground/60">to AI</span>
      </div>
      <Textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="例如：2 号那张光线再阴一点"
        rows={3}
        className="resize-none text-[13px]"
      />
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={!text.trim()}>
          <Send className="size-3.5" />
          提交
        </Button>
      </div>
      {toast && (
        <div className="flex items-start gap-2 rounded-md border border-[color:var(--status-done)]/30 bg-[color:var(--status-done)]/15 px-3 py-2 text-xs text-[color:var(--status-done)]">
          <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}
