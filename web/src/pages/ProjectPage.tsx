import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Save } from 'lucide-react';

import { fetchExperience, saveExperience, type ProjectExperience } from '@/api/experience';
import {
  fetchGalleryProject,
  fetchGalleryScreens,
  type ProjectGalleryItem,
  type ProjectScreenItem,
} from '@/api/gallery';
import { fetchScreenCanonical } from '@/api/canonical';
import { fetchProjectWorkspaces, type ProjectWorkspaceSummary } from '@/api/workspaces';
import {
  fetchProjectVideos,
  setProjectVideoSelected,
  type ProjectVideoProduction,
} from '@/api/videos';
import type { ScreenCanonicalFile } from '@/schema/jobs';
import { ArtWorkspace } from '@/components/workshop/ArtWorkspace';
import { OverviewWorkspace } from '@/components/workshop/OverviewWorkspace';
import {
  ProjectWorkspaceNav,
  type WorkshopWorkspace,
} from '@/components/workshop/ProjectWorkspaceNav';
import { UiWorkspace } from '@/components/workshop/UiWorkspace';
import { VideoWorkspace } from '@/components/workshop/VideoWorkspace';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

export type { WorkshopWorkspace } from '@/components/workshop/ProjectWorkspaceNav';
export { ProjectWorkspaceNav } from '@/components/workshop/ProjectWorkspaceNav';

export function ProjectPage({
  projectId,
  workspace = 'overview',
  screenId,
  productionId,
  shotId,
  onBack,
}: {
  projectId: string;
  workspace?: WorkshopWorkspace;
  screenId?: string;
  productionId?: string;
  shotId?: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<ProjectExperience | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProjectWorkspaceSummary | null>(null);
  const [works, setWorks] = useState<ProjectGalleryItem[]>([]);
  const [screens, setScreens] = useState<ProjectScreenItem[]>([]);
  const [canonicalFile, setCanonicalFile] = useState<ScreenCanonicalFile>({ screens: {} });
  const [productions, setProductions] = useState<ProjectVideoProduction[]>([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setDraft(null);
    fetchExperience(projectId).then(value => {
      if (!cancelled) {
        setData(value);
        setDraft(value.worldview_md);
      }
    });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    setSummary(null);
    if (workspace !== 'overview' && workspace !== 'ui') return;
    let cancelled = false;
    fetchProjectWorkspaces(projectId)
      .then(value => { if (!cancelled) setSummary(value); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, workspace]);

  useEffect(() => {
    if (workspace !== 'art') return;
    let cancelled = false;
    setWorks([]);
    fetchGalleryProject(projectId)
      .then(value => { if (!cancelled) setWorks(value); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, workspace]);

  useEffect(() => {
    if (workspace !== 'ui') return;
    let cancelled = false;
    setScreens([]);
    setCanonicalFile({ screens: {} });
    Promise.all([
      fetchGalleryScreens(projectId),
      fetchScreenCanonical(projectId),
    ]).then(([screenItems, canonical]) => {
      if (!cancelled) {
        setScreens(screenItems);
        setCanonicalFile(canonical);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, workspace]);

  useEffect(() => {
    if (workspace !== 'video') return;
    let cancelled = false;
    setProductions([]);
    fetchProjectVideos(projectId)
      .then(value => { if (!cancelled) setProductions(value); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, workspace]);

  if (!data || draft === null) {
    return (
      <section className="grid h-full place-items-center bg-background">
        <p className="font-display text-display italic text-muted-foreground">加载中…</p>
      </section>
    );
  }

  const dirty = draft !== data.worldview_md;

  async function save() {
    setSaving(true);
    try {
      await saveExperience(projectId, draft!);
      setData(value => value ? { ...value, worldview_md: draft! } : value);
      setToast('已保存');
      window.setTimeout(() => setToast(null), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center justify-between border-b border-border/40 px-4 py-3.5 md:px-6">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="返回">
          <ArrowLeft className="size-4" />
          返回工坊
        </Button>
        {workspace === 'overview' && (
          <Button size="sm" onClick={save} disabled={saving || !dirty} title="保存项目经验">
            <Save className="size-3.5" />
            {saving ? '保存中…' : '保存'}
          </Button>
        )}
      </header>

      <div className="stable-scroll flex-1 space-y-6 overflow-y-auto px-4 py-5 md:px-8 md:py-6">
        <div className="space-y-5">
          <h1 className="font-display text-display italic text-foreground">{data.project.name}</h1>
          <dl className="grid grid-cols-[84px_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="uppercase tracking-label text-muted-foreground/70">slug</dt>
            <dd className="font-mono text-muted-foreground">{data.project.slug}</dd>
            <dt className="uppercase tracking-label text-muted-foreground/70">角色数</dt>
            <dd className="font-mono text-muted-foreground">{data.project.character_count}</dd>
          </dl>
          <ProjectWorkspaceNav projectId={projectId} workspace={workspace} />
        </div>

        <Separator className="opacity-50" />

        {toast && (
          <div role="status" className="flex items-center gap-2 rounded-md border border-[color:var(--status-done)]/30 bg-[color:var(--status-done)]/15 px-3 py-2 text-xs text-[color:var(--status-done)]">
            <CheckCircle2 className="size-3.5 shrink-0" />
            <span>{toast}</span>
          </div>
        )}

        {workspace === 'overview' && (
          <OverviewWorkspace data={data} draft={draft} summary={summary} onDraftChange={setDraft} />
        )}
        {workspace === 'art' && <ArtWorkspace projectId={projectId} works={works} />}
        {workspace === 'ui' && (
          <UiWorkspace
            projectId={projectId}
            screenId={screenId}
            summary={summary?.ui ?? null}
            screens={screens}
            canonicalFile={canonicalFile}
            onCanonicalChange={(file) => {
              setCanonicalFile(file);
              void fetchProjectWorkspaces(projectId)
                .then(setSummary)
                .catch(() => {});
            }}
          />
        )}
        {workspace === 'video' && (
          <VideoWorkspace
            projectId={projectId}
            productionId={productionId}
            shotId={shotId}
            productions={productions}
            onSelected={async (targetProductionId, targetShotId, path) => {
              await setProjectVideoSelected(projectId, targetProductionId, targetShotId, path);
              setProductions(await fetchProjectVideos(projectId));
            }}
          />
        )}
      </div>
    </section>
  );
}
