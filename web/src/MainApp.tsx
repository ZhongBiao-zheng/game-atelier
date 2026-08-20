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

// 弹性分界线参数（与方案 D 节同步）：名册不可收起（无 snap），胶片带 <64 收起
const ROSTER = { key: 'workshop:roster-width', def: 264, min: 200, max: 400 };
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
  const [characterName, setCharacterName] = useState('');
  const [projectsFile, setProjectsFile] = useState<ProjectsFile | null>(null);
  const [mobileRosterOpen, setMobileRosterOpen] = useState(false);
  const [folderLabel, setFolderLabel] = useState<string | null>(null);
  const mobileRosterTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileRosterCloseRef = useRef<HTMLButtonElement>(null);
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
            characterWorkshopPath(
              ownerExists ? actualProjectId : undefined,
              routedCharacterId,
              routedAssetSlot,
              routedImageDetail,
            ),
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

  // 弹性面板宽度：名册只 clamp 不收起；胶片带可收起为 0，lastStripW 记恢复宽度
  const [rosterW, setRosterW] = useState(() => loadWidth(ROSTER));
  const [stripW, setStripW] = useState(() => loadWidth(STRIP, true));
  const lastStripW = useRef(stripW > 0 ? stripW : STRIP.def);
  const detailSlot = routedAssetSlot ?? 'portrait';
  const handleFolderChange = useCallback((folder: { name: string } | null) => {
    setFolderLabel(folder?.name ?? null);
  }, []);

  useEffect(() => {
    setFolderLabel(null);
  }, [routedFolderId]);

  const commitRosterW = useCallback((w: number) => {
    setRosterW(w);
    window.localStorage.setItem(ROSTER.key, String(w));
  }, []);
  const commitStripW = useCallback((w: number) => {
    setStripW(w);
    if (w > 0) lastStripW.current = w;
    window.localStorage.setItem(STRIP.key, String(w));
  }, []);

  function openMobileRoster() {
    setMobileRosterOpen(true);
    window.requestAnimationFrame(() => mobileRosterCloseRef.current?.focus());
  }

  function closeMobileRoster() {
    setMobileRosterOpen(false);
    window.requestAnimationFrame(() => mobileRosterTriggerRef.current?.focus());
  }

  function openImage(path: string, jobId: string, slot?: AssetSlot) {
    if (!selected) return;
    setLocation(characterWorkshopPath(
      openedProject?.id,
      selected.id,
      slot ?? detailSlot,
      { path, jobId },
    ));
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
          onBack={() => setLocation(characterWorkshopPath(
            openedProject?.id,
            selected.id,
            detailSlot,
          ))}
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

  return (
    <>
      <div
        // 同上：行高钉死，名册/画廊各自内滚，头部与侧栏保持固定
        className="relative grid h-full grid-cols-1 grid-rows-[minmax(0,1fr)] min-[769px]:grid-cols-[var(--roster-width)_minmax(0,1fr)]"
        style={{ '--roster-width': `${rosterW}px` } as CSSProperties}
      >
        {mobileRosterOpen && (
          <button
            type="button"
            aria-label="关闭项目册"
            onClick={closeMobileRoster}
            className="fixed inset-0 z-40 bg-scrim/70 min-[769px]:hidden"
          />
        )}
        <div className={cn(
          'fixed inset-y-0 left-0 z-50 w-[min(86vw,320px)] min-w-0 min-h-0 bg-background transition-transform duration-200 min-[769px]:static min-[769px]:z-auto min-[769px]:w-auto min-[769px]:translate-x-0',
          mobileRosterOpen ? 'translate-x-0' : '-translate-x-full',
        )}>
          <div className="flex h-10 items-center justify-end border-b border-border px-2 min-[769px]:hidden">
            <button
              ref={mobileRosterCloseRef}
              type="button"
              onClick={closeMobileRoster}
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
              onSelect={(id, name) => {
                const projectId = projectsFile?.assignments[id];
                const project = projectsFile?.projects.find(p => p.id === projectId) ?? null;
                setCharacterName(name);
                closeMobileRoster();
                if (project) {
                  setLocation(`/workshop/${encodeURIComponent(project.id)}/art/characters/${encodeURIComponent(id)}`);
                } else {
                  setLocation(`/workshop/unassigned/characters/${encodeURIComponent(id)}`);
                }
              }}
              onOpenProject={(p) => {
                closeMobileRoster();
                setLocation(`/workshop/${encodeURIComponent(p.id)}/overview`);
              }}
              onNavigate={closeMobileRoster}
              onDelete={(id) => {
                if (selected?.id === id) setLocation('/workshop');
              }}
            />
          </div>
        </div>
        <div className="col-start-1 flex min-h-0 min-w-0 flex-col min-[769px]:col-start-2">
          <div className="shrink-0 border-b border-border/40 px-3 py-2 min-[769px]:hidden">
            <button
              ref={mobileRosterTriggerRef}
              type="button"
              onClick={openMobileRoster}
              aria-expanded={mobileRosterOpen}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              打开项目册
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
            ) : (
              <WorkshopLanding />
            )}
          </div>
        </div>
        <ResizableDivider
          key="roster-divider"
          width={rosterW}
          min={ROSTER.min}
          max={ROSTER.max}
          onResize={setRosterW}
          onCommit={commitRosterW}
          label="调整名册宽度"
          className="hidden min-[769px]:block"
        />
      </div>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}

function WorkshopLanding() {
  return (
    <section className="grid h-full place-items-center bg-background px-6 text-center">
      <div className="max-w-md space-y-3">
        <p className="text-xs uppercase tracking-label text-muted-foreground">项目目录</p>
        <h1 className="font-display text-display italic text-foreground">全部项目</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          从左侧进入一个项目；未归档的角色也会留在这里，随时可以继续制作或归入项目。
        </p>
      </div>
    </section>
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
