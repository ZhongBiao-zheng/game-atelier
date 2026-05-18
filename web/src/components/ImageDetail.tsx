import { useEffect, useState } from 'react';
import { ArrowLeft, Trash2, Copy, CheckCircle2 } from 'lucide-react';
import type { Job, WebEditableJobPatch } from '../schema/jobs';
import { useClipboard } from '../hooks/useClipboard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

interface Props { jobId: string; path: string; onBack: () => void }

const statusVariant: Record<string, 'secondary' | 'warning' | 'success' | 'destructive'> = {
  pending: 'secondary',
  running: 'warning',
  done: 'success',
  failed: 'destructive',
};

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

  if (!job) {
    return (
      <section className="h-screen border-l border-border flex items-center justify-center">
        <p className="text-sm text-muted-foreground">加载中…</p>
      </section>
    );
  }

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
    <section className="h-screen border-l border-border flex flex-col bg-background overflow-hidden">
      <header className="flex items-center justify-between px-5 py-3 border-b border-border">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="返回">
          <ArrowLeft className="size-4" />
          返回
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={deleteImage}
          title="删除这张图（磁盘也会删）"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
          删除
        </Button>
      </header>

      <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <img
            src={`/api/raw?path=${encodeURIComponent(path)}&job_id=${encodeURIComponent(jobId)}`}
            alt="大图"
            className="w-full max-h-[50vh] object-contain"
          />
        </div>

        <Field
          label="prompt"
          action={
            <Button size="sm" variant="secondary" onClick={copyAndTriggerRetry}>
              <Copy className="size-3.5" />
              复制 → 重出图
            </Button>
          }
        >
          <Textarea
            value={patch.prompt ?? job.prompt}
            onChange={e => setPatch({ ...patch, prompt: e.target.value })}
            className="min-h-[240px] font-mono text-[13px] leading-relaxed resize-y"
            spellCheck={false}
          />
        </Field>

        <Field label="model">
          <Input
            value={patch.model ?? job.model}
            onChange={e => setPatch({ ...patch, model: e.target.value })}
            className="font-mono text-[13px]"
          />
        </Field>

        <Field label="seed">
          <Input
            value={(patch.seed ?? job.seed ?? '') as string | number}
            onChange={e => setPatch({ ...patch, seed: e.target.value ? Number(e.target.value) : null })}
            className="font-mono text-[13px]"
          />
        </Field>

        <Separator />

        <div className="grid grid-cols-2 gap-4 text-[13px]">
          <MetaRow label="submitted_at" value={<span className="font-mono text-muted-foreground">{job.submitted_at}</span>} />
          <MetaRow
            label="status"
            value={<Badge variant={statusVariant[job.status] ?? 'secondary'}>{job.status}</Badge>}
          />
        </div>

        {toast && (
          <div className="flex items-start gap-2 rounded-md border border-[color:var(--status-done)]/30 bg-[color:var(--status-done)]/15 px-3 py-2 text-xs text-[color:var(--status-done)]">
            <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />
            <span>{toast}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function Field({ label, action, children }: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className={cn('text-xs uppercase tracking-wider text-muted-foreground font-medium')}>{label}</Label>
        {action}
      </div>
      {children}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      {value}
    </div>
  );
}
