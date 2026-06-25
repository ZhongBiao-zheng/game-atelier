// web/src/pages/ProjectPage.tsx
import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Save } from 'lucide-react';
import { fetchExperience, saveExperience, type ProjectExperience } from '@/api/experience';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';

export function ProjectPage({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [data, setData] = useState<ProjectExperience | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    fetchExperience(projectId).then(d => { if (!cancel) { setData(d); setDraft(d.worldview_md); } });
    return () => { cancel = true; };
  }, [projectId]);

  if (!data || draft === null) {
    return (
      <section className="h-full bg-background grid place-items-center">
        <p className="font-display italic text-muted-foreground">加载中…</p>
      </section>
    );
  }

  const dirty = draft !== data.worldview_md;

  async function save() {
    setSaving(true);
    try {
      await saveExperience(projectId, draft!);
      setData(d => d ? { ...d, worldview_md: draft! } : d);
      setToast('已保存');
      window.setTimeout(() => setToast(null), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="h-full bg-background flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-6 py-3.5 border-b border-border/40 shrink-0">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="返回">
          <ArrowLeft className="size-4" />
          返回工坊
        </Button>
        <Button size="sm" onClick={save} disabled={saving || !dirty} title="保存项目经验">
          <Save className="size-3.5" />
          {saving ? '保存中…' : '保存'}
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6 max-w-3xl mx-auto w-full">
        <div>
          <h1 className="font-display text-display italic text-foreground">{data.project.name}</h1>
          <dl className="mt-3 grid grid-cols-[84px_1fr] gap-y-1.5 gap-x-3 text-xs">
            <dt className="uppercase tracking-label text-muted-foreground/70">slug</dt>
            <dd className="font-mono text-muted-foreground">{data.project.slug}</dd>
            <dt className="uppercase tracking-label text-muted-foreground/70">角色数</dt>
            <dd className="font-mono text-muted-foreground">{data.project.character_count}</dd>
          </dl>
        </div>

        <Separator className="opacity-50" />

        <div className="space-y-2">
          <label htmlFor="worldview" className="font-display italic text-base text-foreground/85 leading-none block">
            项目经验 / 世界观
          </label>
          <Textarea
            id="worldview"
            aria-label="项目经验 / 世界观"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="min-h-[360px] font-mono text-sm leading-[1.7] resize-y bg-card/50"
            spellCheck={false}
          />
        </div>

        {toast && (
          <div className="flex items-center gap-2 rounded-md border border-[color:var(--status-done)]/30 bg-[color:var(--status-done)]/15 px-3 py-2 text-xs text-[color:var(--status-done)]">
            <CheckCircle2 className="size-3.5 shrink-0" />
            <span>{toast}</span>
          </div>
        )}
      </div>
    </section>
  );
}
