// web/src/pages/ProjectPage.tsx
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, CheckCircle2, Save } from 'lucide-react';
import { fetchExperience, saveExperience, type ProjectExperience } from '@/api/experience';
import { fetchGalleryProject, type ProjectGalleryItem } from '@/api/gallery';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';

export function ProjectPage({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [data, setData] = useState<ProjectExperience | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [works, setWorks] = useState<ProjectGalleryItem[]>([]);

  useEffect(() => {
    let cancel = false;
    fetchExperience(projectId).then(d => { if (!cancel) { setData(d); setDraft(d.worldview_md); } });
    fetchGalleryProject(projectId).then(items => { if (!cancel) setWorks(items); }).catch(() => {});
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

      <div className="flex-1 overflow-y-auto stable-scroll px-8 py-6 space-y-6 w-full">
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

        {works.length > 0 && (
          <>
            <Separator className="opacity-50" />
            <div className="space-y-3" data-testid="project-works">
              <h2 className="font-display italic text-base text-foreground/85 leading-none">
                项目作品
              </h2>
              {/* 瀑布流混排（最新在前）：卡上标角色名+资产槽，点击进工坊角色大图。 */}
              {/* 自适应列数：column-width 模式——卡宽恒 ~14rem（对齐旧 max-w-3xl 三列时的卡宽），
                  容器多宽放多少列，宽度不够自动减列 */}
              <div className="columns-[14rem] gap-4">
                {works.map(item => (
                  <Link
                    key={item.path}
                    href={workHref(item)}
                    aria-label={`查看 ${item.character_name} 的${SLOT_LABEL[item.asset_slot]}`}
                    className="group relative mb-4 block break-inside-avoid overflow-hidden rounded-2xl"
                  >
                    <img
                      src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`}
                      alt=""
                      className="w-full block"
                      loading="lazy"
                    />
                    <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-scrim/80 px-3 py-2 text-xs text-white opacity-0 backdrop-blur-glass transition-opacity group-hover:opacity-100">
                      <span className="truncate">{item.character_name}</span>
                      <span className="shrink-0 text-white/60">{SLOT_LABEL[item.asset_slot]}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

const SLOT_LABEL: Record<ProjectGalleryItem['asset_slot'], string> = {
  portrait: '立绘',
  promo: '美宣',
  turnaround: '三视图',
};

function workHref(item: ProjectGalleryItem): string {
  if (!item.job_id) {
    return `/character/${item.character_id}/${item.asset_slot}`;
  }
  return `/character/${item.character_id}/${item.asset_slot}/${item.job_id}/${encodeURIComponent(item.path)}`;
}
