import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Save, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useClipboard } from '../hooks/useClipboard';
import { FeedbackInput } from './FeedbackInput';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

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

  async function refresh() {
    if (!characterId) return;
    const r = await fetch(`/api/spec/${characterId}`);
    if (!r.ok) { setToast({ kind: 'warn', msg: '刷新失败' }); return; }
    const d = await r.json();
    setServerContent(d.content);
    setContent(d.content);
    setDirty(false);
  }

  if (!characterId) {
    return (
      <section className="h-screen border-l border-border flex items-center justify-center">
        <p className="text-sm text-muted-foreground">请在左栏选择角色</p>
      </section>
    );
  }

  const stale = serverContent !== content && !dirty;

  return (
    <section className="h-screen border-l border-border flex flex-col bg-background">
      <header className="flex items-center justify-between px-5 py-3 border-b border-border">
        <h2 className="text-[15px] font-semibold tracking-tight">规格表单</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          title="重新从磁盘读取（终端 Claude 改完档案后用）"
        >
          <RefreshCw className="size-3.5" />
          刷新
        </Button>
      </header>

      {stale && (
        <div className="mx-5 mt-3 flex items-center gap-2 rounded-md border border-[color:var(--status-running)]/30 bg-[color:var(--status-running)]/10 px-3 py-2 text-xs text-[color:var(--status-running)]">
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="flex-1">文件已变更</span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setContent(serverContent)}
          >
            采用磁盘版
          </Button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col px-5 py-4 gap-3">
        <Textarea
          value={content}
          onChange={e => { setContent(e.target.value); setDirty(true); }}
          className="flex-1 resize-none font-mono text-[13px] leading-relaxed"
          placeholder="角色规格 markdown…"
          spellCheck={false}
        />

        <div className="flex items-center gap-3">
          <Button onClick={() => save(true)} disabled={!dirty} size="sm">
            <Save className="size-3.5" />
            保存
          </Button>
          {dirty && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="inline-block size-1.5 rounded-full bg-[color:var(--status-running)]" />
              未保存
            </span>
          )}
        </div>

        {toast && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-md px-3 py-2 text-xs',
              toast.kind === 'ok'
                ? 'bg-[color:var(--status-done)]/15 border border-[color:var(--status-done)]/30 text-[color:var(--status-done)]'
                : 'bg-[color:var(--status-running)]/15 border border-[color:var(--status-running)]/30 text-[color:var(--status-running)]',
            )}
          >
            {toast.kind === 'ok'
              ? <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />
              : <AlertCircle className="size-3.5 shrink-0 mt-0.5" />}
            <span>{toast.msg}</span>
          </div>
        )}
      </div>

      <Separator />
      <div className="px-5 py-4">
        <FeedbackInput characterId={characterId} />
      </div>
    </section>
  );
}
