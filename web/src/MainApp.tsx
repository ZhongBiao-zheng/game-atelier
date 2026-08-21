import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { LeftSidebar } from './components/LeftSidebar';
import { CharacterGallery } from './components/CharacterGallery';
import { ImageDetail } from './components/ImageDetail';
import { Lightbox } from './components/Lightbox';
import { Filmstrip } from './components/Filmstrip';
import { FirstRunConfig } from './components/FirstRunConfig';
import { ResizableDivider } from './components/ResizableDivider';
import { useSSE } from './hooks/useSSE';
import type { AssetSlot, CharacterEntry, ProjectsFile } from './schema/jobs';
import { ProjectPage, type WorkshopWorkspace } from './pages/ProjectPage';
import { WorkshopShell } from './components/workshop/WorkshopShell';
import { cn } from '@/lib/utils';
import { ProjectFolderPage, type ProjectFolderView } from '@/pages/ProjectFolderPage';
import { ProjectIndexPage } from '@/pages/ProjectIndexPage';
import { useWorkshopReturn, withWorkshopReturn } from '@/lib/workshopReturn';

const SIDEBAR = { key: 'workshop:sidebar-width', def: 264, min: 200, max: 400 };
const STRIP = { key: 'workshop:strip-width', def: 104, min: 72, max: 320, snap: 64 };

function loadWidth(
  cfg: { key: string; def: number; min: number; max: number },
  allowZero = false,
): number {
  const stored = window.localStorage.getItem(cfg.key);
  if (stored === null) return cfg.def;
  const raw = Number(stored);
  if (!Number.isFinite(raw)) return cfg.def;
  if (raw === 0) return allowZero ? 0 : cfg.def;
  return Math.min(cfg.max, Math.max(cfg.min, raw));
}

interface Config { image_storage_root: string }

interface MainAppProps {
  routedProjectId?: string;
  routedWorkspace?: WorkshopWorkspace;
  routedUiSchemeId?: string;
  routedScreenId?: string;
  routedProductionId?: string;
  routedShotId?: string;
  routedCharacterId?: string;
  routedAssetSlot?: AssetSlot;
  routedImageDetail?: { path: string; jobId: string };
  routedFolderId?: string;
  routedFolderView?: ProjectFolderView;
}

export function MainApp({
  routedProjectId,
  routedWorkspace,
  routedUiSchemeId,
  routedScreenId,
  routedProductionId,
  routedShotId,
  routedCharacterId,
  routedAssetSlot,
  routedImageDetail,
  routedFolderId,
  routedFolderView,
}: MainAppProps = {}) {
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(setConfig);
  }, []);

  if (config === null) {
    return (
      <div className="grid h-full place-items-center bg-background text-muted-foreground">
        <span className="font-display text-display italic">读取设置…</span>
      </div>
    );
  }
  if (!config.image_storage_root) {
    return <FirstRunConfig onSaved={root => setConfig({ image_storage_root: root })} />;
  }
  return (
    <div className="h-full">
      <ThreeColumnLayout
        routedProjectId={routedProjectId}
        routedWorkspace={routedWorkspace}
        routedUiSchemeId={routedUiSchemeId}
        routedScreenId={routedScreenId}
        routedProductionId={routedProductionId}
        routedShotId={routedShotId}
        routedCharacterId={routedCharacterId}
        routedAssetSlot={routedAssetSlot}
        routedImageDetail={routedImageDetail}
        routedFolderId={routedFolderId}
        routedFolderView={routedFolderView}
      />
    </div>
  );
}

function ThreeColumnLayout({
  routedProjectId,
  routedWorkspace,
  routedUiSchemeId,
  routedScreenId,
  routedProductionId,
  routedShotId,
  routedCharacterId,
  routedAssetSlot,
  routedImageDetail,
  routedFolderId,
  routedFolderView,
}: {
  routedProjectId?: string;
  routedWorkspace?: WorkshopWorkspace;
  routedUiSchemeId?: string;
  routedScreenId?: string;
  routedProductionId?: string;
  routedShotId?: string;
  routedCharacterId?: string;
  routedAssetSlot?: AssetSlot;
  routedImageDetail?: { path: string; jobId: string };
  routedFolderId?: string;
  routedFolderView?: ProjectFolderView;
}) {
  const [, setLocation] = useLocation();
  const returnContext = useWorkshopReturn();
  const [characterName, setCharacterName] = useState('');
  const [projectsFile, setProjectsFile] = useState<ProjectsFile | null>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [folderLabel, setFolderLabel] = useState<string | null>(null);
  const mobileNavigationTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileNavigationCloseRef = useRef<HTMLButtonElement>(null);
  const sseSignal = useSSE();
  const workspace = routedWorkspace ?? 'overview';
  const openedProject = routedProjectId
    ? projectsFile?.projects.find(project => project.id === routedProjectId) ?? null
    : null;
  const selected = routedCharacterId
    ? { id: routedCharacterId, name: characterName }
    : null;

  useEffect(() => {
    let cancelled = false;
    fetch('/api/projects')
      .then(r => r.json() as Promise<ProjectsFile>)
      .then(pf => {
        if (cancelled) return;
        setProjectsFile(pf);
        if (
          routedCharacterId
          && pf.assignments[routedCharacterId] !== routedProjectId
        ) {
          const actualProjectId = pf.assignments[routedCharacterId];
          const ownerExists = pf.projects.some(project => project.id === actualProjectId);
          setLocation(
            withWorkshopReturn(characterWorkshopPath(
              ownerExists ? actualProjectId : undefined,
              routedCharacterId,
              routedAssetSlot,
              routedImageDetail,
            ), returnContext),
            { replace: true },
          );
          return;
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [
    routedAssetSlot,
    routedCharacterId,
    routedImageDetail,
    routedProjectId,
    returnContext,
    setLocation,
    sseSignal,
  ]);

  useEffect(() => {
    if (!routedCharacterId) {
      setCharacterName('');
      return;
    }
    let cancelled = false;
    fetch('/api/characters')
      .then(r => r.json() as Promise<CharacterEntry[]>)
      .then(chars => {
        if (cancelled) return;
        const match = chars.find(c => c.id === routedCharacterId);
        setCharacterName(match?.name ?? routedCharacterId);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [routedCharacterId, sseSignal]);

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const [sidebarW, setSidebarW] = useState(() => loadWidth(SIDEBAR));
  const [stripW, setStripW] = useState(() => loadWidth(STRIP, true));
  const lastStripW = useRef(stripW > 0 ? stripW : STRIP.def);
  const detailSlot = routedAssetSlot ?? 'portrait';
  const handleFolderChange = useCallback((folder: { name: string } | null) => {
    setFolderLabel(folder?.name ?? null);
  }, []);

  useEffect(() => {
    setFolderLabel(null);
  }, [routedFolderId]);

  const commitSidebarW = useCallback((w: number) => {
    setSidebarW(w);
    window.localStorage.setItem(SIDEBAR.key, String(w));
  }, []);
  const commitStripW = useCallback((w: number) => {
    setStripW(w);
    if (w > 0) lastStripW.current = w;
    window.localStorage.setItem(STRIP.key, String(w));
  }, []);

  function openMobileNavigation() {
    setMobileNavigationOpen(true);
    window.requestAnimationFrame(() => mobileNavigationCloseRef.current?.focus());
  }

  function closeMobileNavigation() {
    setMobileNavigationOpen(false);
    window.requestAnimationFrame(() => mobileNavigationTriggerRef.current?.focus());
  }

  function openImage(path: string, jobId: string, slot?: AssetSlot) {
    if (!selected) return;
    setLocation(withWorkshopReturn(characterWorkshopPath(
      openedProject?.id,
      selected.id,
      slot ?? detailSlot,
      { path, jobId },
    ), returnContext));
  }

  const projectContent = openedProject && routedFolderId ? (
    <ProjectFolderPage
      projectId={openedProject.id}
      folderId={routedFolderId}
      view={routedFolderView ?? 'overview'}
      onFolderChange={handleFolderChange}
    />
  ) : routedImageDetail && selected ? (
    <div
      className="relative grid h-full grid-rows-[minmax(0,1fr)]"
      style={{ gridTemplateColumns: `${stripW}px minmax(0,1fr)` }}
    >
      {stripW > 0 && (
        <Filmstrip
          characterId={selected.id}
          assetSlot={detailSlot}
          currentPath={routedImageDetail.path}
          onSelect={(path, jobId) => openImage(path, jobId, detailSlot)}
          sseSignal={sseSignal}
        />
      )}
      <div className="col-start-2 min-h-0 min-w-0">
        <ImageDetail
          jobId={routedImageDetail.jobId}
          path={routedImageDetail.path}
          onBack={() => setLocation(withWorkshopReturn(characterWorkshopPath(
            openedProject?.id,
            selected.id,
            detailSlot,
          ), returnContext))}
          onLightbox={setLightboxSrc}
          stripCollapsed={stripW === 0}
          onExpandStrip={() => commitStripW(lastStripW.current)}
        />
      </div>
      {stripW > 0 && (
        <ResizableDivider
          key="strip-divider"
          width={stripW}
          min={STRIP.min}
          max={STRIP.max}
          snap={STRIP.snap}
          onResize={w => (w === 0 ? commitStripW(0) : setStripW(w))}
          onCommit={commitStripW}
          label="调整胶片带宽度"
        />
      )}
    </div>
  ) : openedProject && workspace === 'art' && selected ? (
    <CharacterGallery
      characterId={selected.id}
      characterName={selected.name}
      initialTab={routedAssetSlot}
      onSelectImage={openImage}
      sseSignal={sseSignal}
    />
  ) : openedProject ? (
    <ProjectPage
      projectId={openedProject.id}
      workspace={workspace}
      uiSchemeId={routedUiSchemeId}
      screenId={routedScreenId}
      productionId={routedProductionId}
      shotId={routedShotId}
    />
  ) : selected ? (
    <CharacterGallery
      characterId={selected.id}
      characterName={selected.name}
      initialTab={routedAssetSlot}
      onSelectImage={openImage}
      sseSignal={sseSignal}
    />
  ) : null;
  const shellObjectLabel = selected?.name
    || (routedScreenId ? `页面 ${routedScreenId}` : null)
    || (routedShotId ? `镜头 ${routedShotId}` : null)
    || (routedProductionId ? `视频企划 ${routedProductionId}` : null);

  if (!routedProjectId && !routedCharacterId) {
    return (
      <ProjectIndexPage
        onOpenProject={projectId => setLocation(`/workshop/${encodeURIComponent(projectId)}/overview`)}
      />
    );
  }

  if (projectsFile && routedProjectId && !openedProject) {
    return (
      <section className="grid h-full place-items-center bg-background px-6 text-center">
        <div className="max-w-md space-y-3">
          <p className="text-xs uppercase tracking-label text-muted-foreground">项目不存在</p>
          <h1 className="font-display text-display italic text-foreground">找不到这个项目</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            项目可能已经删除，或当前链接使用了失效的项目编号。
          </p>
          <a
            href="/workshop"
            className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            返回全部项目
          </a>
        </div>
      </section>
    );
  }

  return (
    <>
      <div
        className="relative grid h-full grid-cols-1 grid-rows-[minmax(0,1fr)] min-[769px]:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]"
        style={{ '--sidebar-width': `${sidebarW}px` } as CSSProperties}
      >
        {mobileNavigationOpen && (
          <button
            type="button"
            aria-label="关闭项目导航"
            onClick={closeMobileNavigation}
            className="fixed inset-0 z-40 bg-scrim/70 min-[769px]:hidden"
          />
        )}
        <div className={cn(
          'fixed inset-y-0 left-0 z-50 w-[min(86vw,320px)] min-w-0 min-h-0 bg-background transition-transform duration-200 min-[769px]:static min-[769px]:z-auto min-[769px]:w-auto min-[769px]:translate-x-0',
          mobileNavigationOpen ? 'translate-x-0' : '-translate-x-full',
        )}>
          <div className="flex h-10 items-center justify-end border-b border-border px-2 min-[769px]:hidden">
            <button
              ref={mobileNavigationCloseRef}
              type="button"
              onClick={closeMobileNavigation}
              className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              关闭
            </button>
          </div>
          <div className="h-[calc(100%-2.5rem)] min-[769px]:h-full">
            <LeftSidebar
              sseSignal={sseSignal}
              selectedId={selected?.id}
              activeProjectId={openedProject?.id ?? null}
              workspace={workspace}
              currentFolderId={routedFolderId}
              onSelect={(id, name, projectIdOverride) => {
                const projectId = projectIdOverride ?? projectsFile?.assignments[id];
                const project = projectsFile?.projects.find(p => p.id === projectId) ?? null;
                setCharacterName(name);
                closeMobileNavigation();
                if (project) {
                  setLocation(`/workshop/${encodeURIComponent(project.id)}/art/characters/${encodeURIComponent(id)}`);
                } else {
                  setLocation(`/workshop/unassigned/characters/${encodeURIComponent(id)}`);
                }
              }}
              onNavigate={closeMobileNavigation}
              onDelete={(id) => {
                if (selected?.id === id) setLocation('/workshop');
              }}
            />
          </div>
        </div>
        <div className="col-start-1 flex min-h-0 min-w-0 flex-col min-[769px]:col-start-2">
          <div className="shrink-0 border-b border-border/40 px-3 py-2 min-[769px]:hidden">
            <button
              ref={mobileNavigationTriggerRef}
              type="button"
              onClick={openMobileNavigation}
              aria-expanded={mobileNavigationOpen}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              打开项目导航
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {projectContent ? (
              <WorkshopShell
                project={openedProject}
                workspace={routedFolderId ? undefined : workspace}
                sectionLabel={routedFolderId ? '文件夹' : undefined}
                objectLabel={routedFolderId ? folderLabel : shellObjectLabel}
              >
                {projectContent}
              </WorkshopShell>
            ) : null}
          </div>
        </div>
        <ResizableDivider
          key="sidebar-divider"
          width={sidebarW}
          min={SIDEBAR.min}
          max={SIDEBAR.max}
          onResize={setSidebarW}
          onCommit={commitSidebarW}
          label="调整项目栏宽度"
          className="hidden min-[769px]:block"
        />
      </div>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}

function characterWorkshopPath(
  projectId: string | undefined,
  characterId: string,
  assetSlot?: AssetSlot,
  imageDetail?: { path: string; jobId: string },
): string {
  const owner = projectId
    ? `${encodeURIComponent(projectId)}/art`
    : 'unassigned';
  const base = `/workshop/${owner}/characters/${encodeURIComponent(characterId)}`;
  if (!assetSlot) return base;
  const slotPath = `${base}/${assetSlot}`;
  if (!imageDetail) return slotPath;
  return `${slotPath}/${encodeURIComponent(imageDetail.jobId)}/${encodeURIComponent(imageDetail.path)}`;
}
