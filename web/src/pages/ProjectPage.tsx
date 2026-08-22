import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useLocation } from 'wouter';

import { fetchExperience, saveExperience, type ProjectExperience } from '@/api/experience';
import {
  fetchGalleryScreens,
  fetchProjectGallery,
  type ProjectGalleryMedia,
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
import type { WorkshopWorkspace } from '@/components/workshop/workspaces';
import { UiWorkspace } from '@/components/workshop/UiWorkspace';
import { UiSchemeBar } from '@/components/workshop/UiSchemeBar';
import { VideoWorkspace } from '@/components/workshop/VideoWorkspace';
import { ProjectGallery } from '@/components/workshop/ProjectGallery';
import { Separator } from '@/components/ui/separator';

export type { WorkshopWorkspace } from '@/components/workshop/workspaces';

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
  const [data, setData] = useState<ProjectExperience | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProjectWorkspaceSummary | null>(null);
  const [works, setWorks] = useState<ProjectGalleryMedia[]>([]);
  const [screens, setScreens] = useState<ProjectScreenItem[]>([]);
  const [canonicalFile, setCanonicalFile] = useState<ScreenCanonicalFile>({ screens: {} });
  const [schemesFile, setSchemesFile] = useState<UiSchemesFile | null>(null);
  const [productions, setProductions] = useState<ProjectVideoProduction[] | null>(null);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [videoReferences, setVideoReferences] = useState<ProjectVideoReferenceCandidate[]>([]);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setDraft(null);
    setEditing(false);
    setSaveError(null);
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
    if (workspace !== 'ui' || !uiSchemeId) return;
    let cancelled = false;
    fetchProjectWorkspaces(projectId, uiSchemeId)
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
          `/workshop/${encodeURIComponent(projectId)}/ui/${encodeURIComponent(file.default_scheme_id)}`,
          { replace: true },
        );
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, setLocation, uiSchemeId, workspace]);

  useEffect(() => {
    if (workspace !== 'art') return;
    let cancelled = false;
    setWorks([]);
    fetchProjectGallery(projectId, 'art')
      .then(value => { if (!cancelled) setWorks(value.items); })
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
    setProductions(null);
    setVideoLoadError(null);
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
      .catch(() => {
        if (!cancelled) setVideoLoadError('无法读取当前项目的视频企划，请刷新页面重试。');
      });
    return () => { cancelled = true; };
  }, [projectId, workspace]);

  const dirty = data !== null && draft !== null && draft !== data.worldview_md;

  useEffect(() => {
    if (!editing || !dirty) return;
    const currentPath = window.location.pathname;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const warnOnLink = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!target || window.confirm('项目经验尚未保存，确定离开吗？')) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const warnOnHistoryNavigation = () => {
      if (window.location.pathname === currentPath) return;
      if (!window.confirm('项目经验尚未保存，确定离开吗？')) {
        window.history.forward();
      }
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    window.addEventListener('popstate', warnOnHistoryNavigation);
    document.addEventListener('click', warnOnLink, true);
    return () => {
      window.removeEventListener('beforeunload', warnBeforeUnload);
      window.removeEventListener('popstate', warnOnHistoryNavigation);
      document.removeEventListener('click', warnOnLink, true);
    };
  }, [dirty, editing]);

  if (!data || draft === null) {
    return (
      <section className="grid h-full place-items-center bg-background">
        <p className="font-display text-display italic text-muted-foreground">加载中…</p>
      </section>
    );
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await saveExperience(projectId, draft!);
      setData(value => value ? { ...value, worldview_md: draft! } : value);
      setEditing(false);
      setToast('已保存');
      window.setTimeout(() => setToast(null), 2000);
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex h-full flex-col overflow-hidden bg-background">
      <div className="stable-scroll flex-1 space-y-6 overflow-y-auto px-4 py-5 md:px-8 md:py-6">
        <div className="space-y-5">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-label text-muted-foreground">项目首页</p>
            <h1 className="font-display text-display italic text-foreground">{data.project.name}</h1>
          </div>
        </div>

        <Separator className="opacity-50" />

        {toast && (
          <div role="status" className="flex items-center gap-2 rounded-md border border-[color:var(--status-done)]/30 bg-[color:var(--status-done)]/15 px-3 py-2 text-xs text-[color:var(--status-done)]">
            <CheckCircle2 className="size-3.5 shrink-0" />
            <span>{toast}</span>
          </div>
        )}

        {workspace === 'overview' && (
          <div className="space-y-8">
            <OverviewWorkspace
              draft={draft}
              editing={editing}
              dirty={dirty}
              saving={saving}
              error={saveError}
              onDraftChange={setDraft}
              onEdit={() => setEditing(true)}
              onCancel={() => {
                setDraft(data.worldview_md);
                setSaveError(null);
                setEditing(false);
              }}
              onSave={() => void save()}
            />
            <Separator className="opacity-50" />
            <ProjectGallery projectId={projectId} />
          </div>
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
                setLocation(`/workshop/${encodeURIComponent(projectId)}/ui/${encodeURIComponent(created.id)}`);
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
            loadError={videoLoadError}
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
