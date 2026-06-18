import { useEffect, useState } from 'react';
import { ArrowLeft, Trash2, CheckCircle2, Copy, PanelLeftOpen, Save, Star } from 'lucide-react';
import type { Job, WebEditableJobPatch } from '../schema/jobs';
import { useGalleryFavorites } from '@/hooks/useGalleryFavorites';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';

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
  const { toggleFavorite, isFavorited } = useGalleryFavorites();

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
            variant="ghost"
            size="sm"
            onClick={() => void toggleFavorite(path)}
            title={isFavorited(path) ? '取消收藏' : '收藏'}
            className={isFavorited(path) ? 'text-primary' : undefined}
          >
            <Star className="size-3.5" />
            {isFavorited(path) ? '已收藏' : '收藏'}
          </Button>
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

      {/* 研究台双栏：图（左，居中）+ 档案（右 384px）——改 prompt 时图不离开视线 */}
      <div className="flex-1 grid grid-cols-[minmax(0,1fr)_384px] min-h-0">
        <div className="grid place-items-center overflow-auto p-8">
          <img
            src={`/api/gallery/image?path=${encodeURIComponent(path)}`}
            alt="大图"
            onClick={() => onLightbox?.(`/api/gallery/image?path=${encodeURIComponent(path)}`)}
            className="max-h-[72vh] max-w-full object-contain rounded-lg border border-border cursor-zoom-in"
            onError={(e) => {
              // 公开接口加载失败时，降级到 raw 接口尝试
              (e.target as HTMLImageElement).src = `/api/raw?path=${encodeURIComponent(path)}&job_id=${encodeURIComponent(jobId)}`;
            }}
          />
        </div>

        <aside className="border-l border-border overflow-y-auto px-6 py-6 space-y-6 min-w-0">
          <ImageIdChip characterId={job.character_id} path={path} />

          <Field label="prompt">
            <Textarea
              value={patch.prompt ?? job.prompt}
              onChange={e => setPatch({ ...patch, prompt: e.target.value })}
              className="min-h-[220px] font-mono text-sm leading-[1.7] resize-y bg-card/50"
              spellCheck={false}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
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

          <dl className="grid grid-cols-[84px_1fr] gap-y-2 gap-x-3 text-xs leading-relaxed">
            <dt className="text-xs uppercase tracking-label text-muted-foreground/70 mt-0.5">job_id</dt>
            <dd className="font-mono text-muted-foreground break-all">{job.job_id}</dd>

            <dt className="text-xs uppercase tracking-label text-muted-foreground/70 mt-0.5">submitted</dt>
            <dd className="font-mono text-muted-foreground break-all">{job.submitted_at}</dd>

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
