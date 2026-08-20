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
import { useActiveCharacter } from './hooks/useActiveCharacter';
import type { AssetSlot, CharacterEntry, Project, ProjectsFile } from './schema/jobs';
import {
  ProjectPage,
  ProjectWorkspaceNav,
  type WorkshopWorkspace,
} from './pages/ProjectPage';
import { cn } from '@/lib/utils';

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

/** 兜底顺序与左栏一致：按项目顺序找第一个有成员的项目取其首个角色，否则未分类首个。 */
function pickFallbackCharacter(chars: CharacterEntry[], pf: ProjectsFile): CharacterEntry | null {
  for (const p of pf.projects) {
    const hit = chars.find(c => pf.assignments[c.id] === p.id);
    if (hit) return hit;
  }
  return chars[0] ?? null;
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
}: {
  routedProjectId?: string;
  routedWorkspace?: WorkshopWorkspace;
  routedScreenId?: string;
  routedProductionId?: string;
  routedShotId?: string;
  routedCharacterId?: string;
  routedAssetSlot?: AssetSlot;
  routedImageDetail?: { path: string; jobId: string };
}) {
  const [, setLocation] = useLocation();
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(
    routedCharacterId ? { id: routedCharacterId, name: '' } : null,
  );
  const [detailJob, setDetailJob] = useState<{ path: string; jobId: string } | null>(
    routedImageDetail ?? null,
  );
  const [openedProject, setOpenedProject] = useState<Project | null>(null);
  const [projectsFile, setProjectsFile] = useState<ProjectsFile | null>(null);
  const [artCharacterOpen, setArtCharacterOpen] = useState(Boolean(routedCharacterId));
  const [mobileRosterOpen, setMobileRosterOpen] = useState(false);
  const mobileRosterTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileRosterCloseRef = useRef<HTMLButtonElement>(null);
  const sseSignal = useSSE();
  const activeId = useActiveCharacter(sseSignal);
  const workspace = routedWorkspace ?? 'overview';

  useEffect(() => {
    let cancelled = false;
    fetch('/api/projects')
      .then(r => r.json() as Promise<ProjectsFile>)
      .then(pf => {
        if (cancelled) return;
        setProjectsFile(pf);
        if (
          routedProjectId
          && routedCharacterId
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
          setOpenedProject(null);
          return;
        }
        setOpenedProject(
          routedProjectId
            ? pf.projects.find(p => p.id === routedProjectId) ?? null
            : null,
        );
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
    setArtCharacterOpen(Boolean(routedCharacterId));
  }, [routedCharacterId, routedProjectId, routedWorkspace]);

  useEffect(() => {
    if (routedCharacterId && routedCharacterId !== selected?.id) {
      setSelected({ id: routedCharacterId, name: '' });
    }
  }, [routedCharacterId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 进入工坊：选活跃角色；指针为空或指向已不存在的角色时，兜底第一个项目的第一个角色
  useEffect(() => {
    if (routedCharacterId || selected || activeId === undefined || projectsFile === null) return;
    let cancelled = false;
    fetch('/api/characters')
      .then(r => r.json() as Promise<CharacterEntry[]>)
      .then(chars => {
        if (cancelled) return;
        const active = activeId ? chars.find(c => c.id === activeId) : undefined;
        const pick = active ?? pickFallbackCharacter(chars, projectsFile);
        if (pick) setSelected({ id: pick.id, name: pick.name });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeId, projectsFile, routedCharacterId, selected]);

  useEffect(() => {
    setDetailJob(routedImageDetail ?? null);
  }, [routedImageDetail?.jobId, routedImageDetail?.path]);

  useEffect(() => {
    if (!selected || selected.name) return;
    let cancelled = false;
    fetch('/api/characters')
      .then(r => r.json() as Promise<CharacterEntry[]>)
      .then(chars => {
        if (cancelled) return;
        const match = chars.find(c => c.id === selected.id);
        if (match) setSelected({ id: match.id, name: match.name });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selected]);

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // 弹性面板宽度：名册只 clamp 不收起；胶片带可收起为 0，lastStripW 记恢复宽度
  const [rosterW, setRosterW] = useState(() => loadWidth(ROSTER));
  const [stripW, setStripW] = useState(() => loadWidth(STRIP, true));
  const lastStripW = useRef(stripW > 0 ? stripW : STRIP.def);
  const [detailSlot, setDetailSlot] = useState<AssetSlot>(routedAssetSlot ?? 'portrait');

  useEffect(() => {
    if (routedAssetSlot) setDetailSlot(routedAssetSlot);
  }, [routedAssetSlot]);

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

  if (detailJob !== null) {
    return (
      <>
        <div
          // grid-rows minmax(0,1fr)：行高钉死为视口高，内容溢出由各栏内部滚动消化，
          // 否则隐式行按内容撑高、滚动落到外层 AppShell main（头部/侧栏跟着滚走）
          className="relative grid h-full grid-rows-[minmax(0,1fr)]"
          style={{ gridTemplateColumns: `${stripW}px minmax(0,1fr)` }}
        >
          {stripW > 0 && selected && (
            <Filmstrip
              characterId={selected.id}
              assetSlot={detailSlot}
              currentPath={detailJob.path}
              onSelect={(path, jobId) => setDetailJob({ path, jobId })}
              sseSignal={sseSignal}
            />
          )}
          <div className="col-start-2 min-w-0 min-h-0">
            <ImageDetail
              jobId={detailJob.jobId}
              path={detailJob.path}
              onBack={() => setDetailJob(null)}
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
              // 拖过 snap 阈值 = 立即收起定格：divider 随之卸载，pointerup 不会再来，
              // 所以收起必须在这里直接 commit（持久化 + 截断本次拖拽）
              onResize={w => (w === 0 ? commitStripW(0) : setStripW(w))}
              onCommit={commitStripW}
              label="调整胶片带宽度"
            />
          )}
        </div>
        {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      </>
    );
  }

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
            showCharacters={!openedProject || workspace === 'art'}
            activeProjectId={openedProject?.id ?? null}
            onSelect={(id, name) => {
              const projectId = projectsFile?.assignments[id];
              const project = projectsFile?.projects.find(p => p.id === projectId) ?? null;
              setOpenedProject(project);
              setSelected({ id, name });
              setArtCharacterOpen(true);
              closeMobileRoster();
              if (project) {
                setLocation(`/workshop/${encodeURIComponent(project.id)}/art/characters/${encodeURIComponent(id)}`);
              } else {
                setLocation(`/workshop/unassigned/characters/${encodeURIComponent(id)}`);
              }
            }}
            onOpenProject={(p) => {
              setOpenedProject(p);
              setArtCharacterOpen(false);
              closeMobileRoster();
              setLocation(`/workshop/${encodeURIComponent(p.id)}/overview`);
            }}
            onDelete={(id) => {
              if (selected?.id === id) setSelected(null);
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
          {openedProject && !(workspace === 'art' && artCharacterOpen && selected) ? (
            <ProjectPage
              projectId={openedProject.id}
              workspace={workspace}
              screenId={routedScreenId}
              productionId={routedProductionId}
              shotId={routedShotId}
              onBack={() => {
                setOpenedProject(null);
                setLocation('/workshop');
              }}
            />
          ) : openedProject && workspace === 'art' && artCharacterOpen && selected ? (
            <section className="flex h-full min-h-0 flex-col bg-background">
              <header className="shrink-0 border-b border-border/40 px-4 py-2.5 md:px-6">
                <div className="flex items-center gap-4">
                  <p className="hidden min-w-0 shrink truncate text-sm font-medium text-foreground/85 md:block">
                    {openedProject.name}
                  </p>
                  <div className="min-w-0 flex-1">
                    <ProjectWorkspaceNav projectId={openedProject.id} workspace="art" />
                  </div>
                </div>
              </header>
              <div className="min-h-0 flex-1">
                <CharacterGallery
                  characterId={selected.id}
                  characterName={selected.name}
                  initialTab={routedAssetSlot}
                  onSelectImage={(path, jobId, slot) => {
                    if (slot) setDetailSlot(slot);
                    setDetailJob({ path, jobId });
                  }}
                  sseSignal={sseSignal}
                />
              </div>
            </section>
          ) : (
            <CharacterGallery
              characterId={selected?.id ?? null}
              characterName={selected?.name ?? null}
              initialTab={routedAssetSlot}
              onSelectImage={(path, jobId, slot) => {
                if (slot) setDetailSlot(slot);
                setDetailJob({ path, jobId });
              }}
              sseSignal={sseSignal}
            />
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
