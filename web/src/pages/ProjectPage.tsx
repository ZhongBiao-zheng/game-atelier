import { useEffect, useState } from 'react';
import { CheckCircle2, Save } from 'lucide-react';
import { useLocation } from 'wouter';

import { fetchExperience, saveExperience, type ProjectExperience } from '@/api/experience';
import {
  fetchGalleryProject,
  fetchGalleryScreens,
  type ProjectGalleryItem,
  type ProjectScreenItem,
} from '@/api/gallery';
import { fetchScreenCanonical } from '@/api/canonical';
import {
  createUiScheme,
  fetchUiSchemes,
  setDefaultUiScheme,
  type UiSchemesFile,
} from '@/api/uiSchemes';
import { fetchProjectWorkspaces, type ProjectWorkspaceSummary } from '@/api/workspaces';
import {
  fetchProjectVideoReferences,
  fetchProjectVideos,
  setProjectVideoSelected,
  setProjectVideoReferences,
  type ProjectVideoReferenceCandidate,
  type ProjectVideoProduction,
} from '@/api/videos';
import type { ScreenCanonicalFile } from '@/schema/jobs';
import { ArtWorkspace } from '@/components/workshop/ArtWorkspace';
import { OverviewWorkspace } from '@/components/workshop/OverviewWorkspace';
import type { WorkshopWorkspace } from '@/components/workshop/ProjectWorkspaceNav';
import { UiWorkspace } from '@/components/workshop/UiWorkspace';
import { UiSchemeBar } from '@/components/workshop/UiSchemeBar';
import { VideoWorkspace } from '@/components/workshop/VideoWorkspace';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useWorkshopReturn, withWorkshopReturn } from '@/lib/workshopReturn';

export type { WorkshopWorkspace } from '@/components/workshop/ProjectWorkspaceNav';

export function ProjectPage({
  projectId,
  workspace = 'overview',
  uiSchemeId,
  screenId,
  productionId,
  shotId,
}: {
  projectId: string;
  workspace?: WorkshopWorkspace;
  uiSchemeId?: string;
  screenId?: string;
  productionId?: string;
  shotId?: string;
}) {
  const [, setLocation] = useLocation();
  const returnContext = useWorkshopReturn();
  const [data, setData] = useState<ProjectExperience | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProjectWorkspaceSummary | null>(null);
  const [works, setWorks] = useState<ProjectGalleryItem[]>([]);
  const [screens, setScreens] = useState<ProjectScreenItem[]>([]);
  const [canonicalFile, setCanonicalFile] = useState<ScreenCanonicalFile>({ screens: {} });
  const [schemesFile, setSchemesFile] = useState<UiSchemesFile | null>(null);
  const [productions, setProductions] = useState<ProjectVideoProduction[]>([]);
  const [videoReferences, setVideoReferences] = useState<ProjectVideoReferenceCandidate[]>([]);
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
    if (workspace === 'ui' && !uiSchemeId) return;
    let cancelled = false;
    fetchProjectWorkspaces(projectId, workspace === 'ui' ? uiSchemeId : undefined)
      .then(value => { if (!cancelled) setSummary(value); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, workspace, uiSchemeId]);

  useEffect(() => {
    if (workspace !== 'ui') return;
    let cancelled = false;
    setSchemesFile(null);
    fetchUiSchemes(projectId).then(file => {
      if (cancelled) return;
      if (!Array.isArray(file.schemes) || file.schemes.length === 0 || !file.default_scheme_id) return;
      setSchemesFile(file);
      const exists = uiSchemeId && file.schemes.some(item => item.id === uiSchemeId);
      if (!exists) {
        setLocation(
          withWorkshopReturn(
            `/workshop/${encodeURIComponent(projectId)}/ui/${encodeURIComponent(file.default_scheme_id)}`,
            returnContext,
          ),
          { replace: true },
        );
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, returnContext, setLocation, uiSchemeId, workspace]);

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
    if (workspace !== 'ui' || !uiSchemeId) return;
    let cancelled = false;
    setScreens([]);
    setCanonicalFile({ screens: {} });
    Promise.all([
      fetchGalleryScreens(projectId, uiSchemeId),
      fetchScreenCanonical(projectId, uiSchemeId),
    ]).then(([screenItems, canonical]) => {
      if (!cancelled) {
        setScreens(screenItems);
        setCanonicalFile(canonical);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, uiSchemeId, workspace]);

  useEffect(() => {
    if (workspace !== 'video') return;
    let cancelled = false;
    setProductions([]);
    setVideoReferences([]);
    Promise.all([
      fetchProjectVideos(projectId),
      fetchProjectVideoReferences(projectId),
    ])
      .then(([videoItems, references]) => {
        if (!cancelled) {
          setProductions(videoItems);
          setVideoReferences(references);
        }
      })
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
      <div className="stable-scroll flex-1 space-y-6 overflow-y-auto px-4 py-5 md:px-8 md:py-6">
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <h1 className="font-display text-display italic text-foreground">{data.project.name}</h1>
            {workspace === 'overview' && (
              <Button size="sm" onClick={save} disabled={saving || !dirty} title="保存项目经验">
                <Save className="size-3.5" />
                {saving ? '保存中…' : '保存'}
              </Button>
            )}
          </div>
          <dl className="grid grid-cols-[84px_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="uppercase tracking-label text-muted-foreground/70">slug</dt>
            <dd className="font-mono text-muted-foreground">{data.project.slug}</dd>
            <dt className="uppercase tracking-label text-muted-foreground/70">角色数</dt>
            <dd className="font-mono text-muted-foreground">{data.project.character_count}</dd>
          </dl>
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
        {workspace === 'ui' && uiSchemeId && schemesFile && (
          <div className="space-y-6">
            <UiSchemeBar
              projectId={projectId}
              currentSchemeId={uiSchemeId}
              schemesFile={schemesFile}
              screens={uiCopyCandidates(summary?.ui.screen_items ?? [], screens)}
              onCreate={async (payload) => {
                const file = await createUiScheme(projectId, payload);
                setSchemesFile(file);
                const created = file.schemes.at(-1)!;
                setLocation(withWorkshopReturn(
                  `/workshop/${encodeURIComponent(projectId)}/ui/${encodeURIComponent(created.id)}`,
                  returnContext,
                ));
              }}
              onSetDefault={async (schemeId) => {
                setSchemesFile(await setDefaultUiScheme(projectId, schemeId));
              }}
            />
            <UiWorkspace
              projectId={projectId}
              schemeId={uiSchemeId}
              screenId={screenId}
              summary={summary?.ui ?? null}
              screens={screens}
              canonicalFile={canonicalFile}
              onCanonicalChange={(file) => {
                setCanonicalFile(file);
                void fetchProjectWorkspaces(projectId, uiSchemeId)
                  .then(setSummary)
                  .catch(() => {});
              }}
            />
          </div>
        )}
        {workspace === 'video' && (
          <VideoWorkspace
            projectId={projectId}
            productionId={productionId}
            shotId={shotId}
            productions={productions}
            referenceCandidates={videoReferences}
            onSelected={async (targetProductionId, targetShotId, path) => {
              await setProjectVideoSelected(projectId, targetProductionId, targetShotId, path);
              setProductions(await fetchProjectVideos(projectId));
            }}
            onReferences={async (targetProductionId, targetShotId, paths) => {
              await setProjectVideoReferences(
                projectId,
                targetProductionId,
                targetShotId,
                paths,
              );
              setProductions(await fetchProjectVideos(projectId));
            }}
          />
        )}
      </div>
    </section>
  );
}

function uiCopyCandidates(
  planned: Array<{ screen_id: string; name: string }>,
  versions: ProjectScreenItem[],
): Array<{ screen_id: string; name: string }> {
  const result = new Map(planned.map(item => [item.screen_id, item]));
  for (const version of versions) {
    if (!result.has(version.screen_id)) {
      result.set(version.screen_id, { screen_id: version.screen_id, name: version.screen_id });
    }
  }
  return [...result.values()];
}
