import { useEffect, useState } from 'react';
import { ArrowLeft, Trash2, CheckCircle2, Copy, Save } from 'lucide-react';
import type { Job, WebEditableJobPatch } from '../schema/jobs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';

interface Props { jobId: string; path: string; onBack: () => void; onLightbox?: (src: string) => void }

export function ImageDetail({ jobId, path, onBack, onLightbox }: Props) {
  const [job, setJob] = useState<Job | null>(null);
  const [patch, setPatch] = useState<WebEditableJobPatch>({});
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
      <section className="h-full border-l border-border/60 bg-background flex items-center justify-center">
        <p className="font-[var(--font-display)] italic text-muted-foreground">加载中…</p>
      </section>
    );
  }

  async function saveChanges() {
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      const r = await fetch(`/api/prompt/${jobId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) { setToast(`保存失败：HTTP ${r.status}`); return; }
      setJob(j => j ? { ...j, ...patch } : j);
      setPatch({});
      setToast('已保存');
      window.setTimeout(() => setToast(null), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function deleteImage() {
    if (!window.confirm(`删除这张图？\n${path}\n（磁盘文件也会删，不可恢复）`)) return;
    const r = await fetch(`/api/jobs/${jobId}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (!r.ok) { setToast(`删除失败：HTTP ${r.status}`); return; }
    onBack();
  }

  return (
    <section className="h-full border-l border-border/60 bg-background flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border/40">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="返回">
          <ArrowLeft className="size-4" />
          返回画廊
        </Button>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={saveChanges}
            disabled={saving || Object.keys(patch).length === 0}
            title="保存对 prompt / model / seed 的修改"
          >
            <Save className="size-3.5" />
            {saving ? '保存中…' : '保存'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={deleteImage}
            title="删除这张图（磁盘也会删）"
            className="text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            删除
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="px-8 pt-8 pb-6 flex items-center justify-center bg-background">
          <div className="relative inline-block">
            <img
              src={`/api/raw?path=${encodeURIComponent(path)}&job_id=${encodeURIComponent(jobId)}`}
              alt="大图"
              onClick={() => onLightbox?.(`/api/raw?path=${encodeURIComponent(path)}&job_id=${encodeURIComponent(jobId)}`)}
              className="max-h-[68vh] max-w-full object-contain rounded-lg border border-border cursor-zoom-in"
            />
          </div>
        </div>

        <div className="px-8 pb-8 space-y-6 max-w-[760px] mx-auto w-full">
          <ImageIdChip characterId={job.character_id} path={path} />

          <Field label="prompt">
            <Textarea
              value={patch.prompt ?? job.prompt}
              onChange={e => setPatch({ ...patch, prompt: e.target.value })}
              className="min-h-[200px] font-mono text-sm leading-[1.7] resize-y bg-card/50"
              spellCheck={false}
            />
          </Field>

          <div className="grid grid-cols-2 gap-5">
            <Field label="model">
              <Input
                value={patch.model ?? job.model}
                onChange={e => setPatch({ ...patch, model: e.target.value })}
                className="font-mono text-sm"
              />
            </Field>

            <Field label="seed">
              <Input
                value={(patch.seed ?? job.seed ?? '') as string | number}
                onChange={e => setPatch({ ...patch, seed: e.target.value ? Number(e.target.value) : null })}
                className="font-mono text-sm"
              />
            </Field>
          </div>

          <Separator className="opacity-50" />

          <dl className="grid grid-cols-[100px_1fr] gap-y-2 gap-x-4 text-xs leading-relaxed">
            <dt className="text-xs uppercase tracking-label text-muted-foreground/70 mt-0.5">job_id</dt>
            <dd className="font-mono text-muted-foreground break-all">{job.job_id}</dd>

            <dt className="text-xs uppercase tracking-label text-muted-foreground/70 mt-0.5">submitted</dt>
            <dd className="font-mono text-muted-foreground">{job.submitted_at}</dd>

            <dt className="text-xs uppercase tracking-label text-muted-foreground/70 mt-0.5">path</dt>
            <dd className="font-mono text-muted-foreground break-all">{path}</dd>
          </dl>

          {toast && (
            <div className="flex items-start gap-2 rounded-md border border-[color:var(--status-done)]/30 bg-[color:var(--status-done)]/15 px-3 py-2 text-xs text-[color:var(--status-done)]">
              <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />
              <span>{toast}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ImageIdChip({ characterId, path }: { characterId: string; path: string }) {
  const [copied, setCopied] = useState(false);

  // 提取 characters/ 开头的相对路径，供 AI 理解图片来源
  const idx = path.indexOf('characters/');
  const relPath = idx >= 0 ? path.slice(idx) : `characters/${characterId}/.../${path.split('/').pop()}`;

  async function copy() {
    await navigator.clipboard.writeText(relPath).catch(() => null);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-label text-muted-foreground/70">图片路径</span>
      <div className="flex items-center gap-2">
        <code className="flex-1 min-w-0 font-mono text-xs text-foreground/85 bg-card/60 border border-border rounded-sm px-2.5 py-1.5 truncate">
          {relPath}
        </code>
        <Button size="sm" variant="ghost" onClick={copy} className="shrink-0 px-2">
          {copied
            ? <CheckCircle2 className="size-3.5 text-[color:var(--status-done)]" />
            : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <span className="font-display italic text-base text-foreground/85 leading-none block">{label}</span>
      {children}
    </div>
  );
}
