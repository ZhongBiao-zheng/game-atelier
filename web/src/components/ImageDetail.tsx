import { useEffect, useState } from 'react';
import { ArrowLeft, Trash2, CheckCircle2, Copy, PanelLeftOpen, Save } from 'lucide-react';
import type { Job, WebEditableJobPatch } from '../schema/jobs';
import { useGalleryRatings } from '@/hooks/useGalleryRatings';
import { StarRating } from '@/components/StarRating';
import { formatBeijingTime } from '@/lib/time';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { apiError } from '@/api/http';

interface Props {
  jobId: string;
  path: string;
  onBack: () => void;
  onLightbox?: (src: string) => void;
  /** 胶片带已收起：header 最左浮出展开钮 */
  stripCollapsed?: boolean;
  onExpandStrip?: () => void;
}

export function ImageDetail({ jobId, path, onBack, onLightbox, stripCollapsed, onExpandStrip }: Props) {
  const [job, setJob] = useState<Job | null>(null);
  const [patch, setPatch] = useState<WebEditableJobPatch>({});
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<{
    open: boolean;
    title: string;
    message: string;
    detail?: string;
    variant: 'default' | 'destructive';
    onConfirm: () => void;
  } | null>(null);
  const { getRating, setRating } = useGalleryRatings();

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
      <section className="h-full bg-background flex items-center justify-center">
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
      if (!r.ok) { setToast((await apiError(r, '保存提示词改动')).message); return; }
      setJob(j => j ? { ...j, ...patch } : j);
      setPatch({});
      setToast('已保存');
      window.setTimeout(() => setToast(null), 2000);
    } finally {
      setSaving(false);
    }
  }

  function deleteImage() {
    setDialog({
      open: true,
      title: '删除这张图？',
      message: '磁盘文件也会被删除，不可恢复',
      detail: path,
      variant: 'destructive',
      onConfirm: async () => {
        setDialog(null);
        const r = await fetch(`/api/jobs/${jobId}/image?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
        if (!r.ok) { setToast((await apiError(r, '删除这张图')).message); return; }
        onBack();
      },
    });
  }

  return (
    <section className="h-full bg-background flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-6 py-3.5 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-2">
          {stripCollapsed && onExpandStrip && (
            <button
              onClick={onExpandStrip}
              aria-label="展开胶片带"
              title="展开胶片带"
              className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-transparent p-0 text-muted-foreground cursor-pointer transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <PanelLeftOpen className="size-3.5" />
            </button>
          )}
          <Button variant="ghost" size="sm" onClick={onBack} aria-label="返回">
            <ArrowLeft className="size-4" />
            返回画廊
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={saveChanges}
            disabled={saving || Object.keys(patch).length === 0}
            title="保存对提示词的修改"
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

      {/* 研究台双栏：图（左，居中）+ 档案（右 384px）——改 prompt 时图不离开视线 */}
      <div className="flex-1 grid grid-cols-[minmax(0,1fr)_384px] min-h-0">
        <div className="grid place-items-center overflow-auto p-8">
          {/*
           * 主端点用 gallery/image（路径根白名单），降级到 raw（job_id 白名单）。
           *
           * 动机：/api/gallery/recent 返回相对路径（characters/…/v2.png），
           * 而 /api/raw 历史上用 Path(path).resolve() 相对 CWD 解析，CWD 是 repo 根，
           * 解析结果与 job.output_paths 里的绝对路径（data root 下）对不上 → 403/404。
           * 这是 routes.py 的 bug，已在服务端修复（相对路径改为相对 data root 解析）。
           * 修复后 raw 主端点也能正常工作；保留 gallery/image 作为主端点是因为它对
           * 没有关联 job 的手动上传图（如 source 目录）也能提供服务，是更宽松的覆盖。
           * onError 降级保留作保险，应对 gallery 端点不覆盖的极端路径。
           */}
          <img
            src={`/api/gallery/image?path=${encodeURIComponent(path)}`}
            alt="大图"
            onClick={() => onLightbox?.(`/api/gallery/image?path=${encodeURIComponent(path)}`)}
            className="max-h-[72vh] max-w-full object-contain rounded-lg border border-border cursor-zoom-in"
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              const fallback = `/api/raw?path=${encodeURIComponent(path)}&job_id=${encodeURIComponent(jobId)}`;
              if (img.src !== fallback) img.src = fallback;
            }}
          />
        </div>

        <aside className="border-l border-border overflow-y-auto px-6 py-6 space-y-6 min-w-0" aria-label="图片详情">
          <ImageIdChip characterId={job.character_id} path={path} />

          <Field label="prompt">
            <Textarea
              value={patch.prompt ?? job.prompt}
              onChange={e => setPatch({ ...patch, prompt: e.target.value })}
              className="min-h-[220px] font-mono text-sm leading-[1.7] resize-y bg-card/50"
              spellCheck={false}
            />
          </Field>

          <Field label="你的评分">
            <StarRating value={getRating(path)} onChange={(v) => void setRating(path, v)} />
          </Field>

          <Separator className="opacity-50" />

          <dl className="grid grid-cols-[84px_1fr] gap-y-2 gap-x-3 text-xs leading-relaxed">
            <dt className="text-xs uppercase tracking-label text-muted-foreground/70 mt-0.5">job_id</dt>
            <dd className="font-mono text-muted-foreground break-all">{job.job_id}</dd>

            <dt className="text-xs uppercase tracking-label text-muted-foreground/70 mt-0.5">model</dt>
            <dd className="font-mono text-muted-foreground break-all">{job.model}</dd>

            <dt className="text-xs uppercase tracking-label text-muted-foreground/70 mt-0.5">submitted</dt>
            <dd className="font-mono text-muted-foreground break-all">{formatBeijingTime(job.submitted_at)}</dd>

            <dt className="text-xs uppercase tracking-label text-muted-foreground/70 mt-0.5">path</dt>
            <dd className="font-mono text-muted-foreground break-all">{path}</dd>
          </dl>

          {toast && (
            <div className="flex items-start gap-2 rounded-md border border-[color:var(--status-done)]/30 bg-[color:var(--status-done)]/15 px-3 py-2 text-xs text-[color:var(--status-done)]">
              <CheckCircle2 className="size-3.5 shrink-0 mt-0.5" />
              <span>{toast}</span>
            </div>
          )}
        </aside>
      </div>

      {dialog && (
        <ConfirmDialog
          open={dialog.open}
          title={dialog.title}
          message={dialog.message}
          detail={dialog.detail}
          variant={dialog.variant}
          onConfirm={dialog.onConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
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
