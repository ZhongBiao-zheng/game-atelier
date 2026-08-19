import { useCallback, useEffect, useRef, useState } from 'react';
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
import { ProjectPage } from './pages/ProjectPage';

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
  routedCharacterId?: string;
  routedAssetSlot?: AssetSlot;
  routedImageDetail?: { path: string; jobId: string };
}

export function MainApp({ routedCharacterId, routedAssetSlot, routedImageDetail }: MainAppProps = {}) {
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
        routedCharacterId={routedCharacterId}
        routedAssetSlot={routedAssetSlot}
        routedImageDetail={routedImageDetail}
      />
    </div>
  );
}

function ThreeColumnLayout({
  routedCharacterId,
  routedAssetSlot,
  routedImageDetail,
}: {
  routedCharacterId?: string;
  routedAssetSlot?: AssetSlot;
  routedImageDetail?: { path: string; jobId: string };
}) {
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(
    routedCharacterId ? { id: routedCharacterId, name: '' } : null,
  );
  const [detailJob, setDetailJob] = useState<{ path: string; jobId: string } | null>(
    routedImageDetail ?? null,
  );
  const [openedProject, setOpenedProject] = useState<Project | null>(null);
  const sseSignal = useSSE();
  const activeId = useActiveCharacter(sseSignal);

  useEffect(() => {
    if (routedCharacterId && routedCharacterId !== selected?.id) {
      setSelected({ id: routedCharacterId, name: '' });
    }
  }, [routedCharacterId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 进入工坊：选活跃角色；指针为空或指向已不存在的角色时，兜底第一个项目的第一个角色
  useEffect(() => {
    if (routedCharacterId || selected || activeId === undefined) return;
    let cancelled = false;
    Promise.all([
      fetch('/api/characters').then(r => r.json() as Promise<CharacterEntry[]>),
      fetch('/api/projects').then(r => r.json() as Promise<ProjectsFile>),
    ])
      .then(([chars, pf]) => {
        if (cancelled) return;
        const active = activeId ? chars.find(c => c.id === activeId) : undefined;
        const pick = active ?? pickFallbackCharacter(chars, pf);
        if (pick) setSelected({ id: pick.id, name: pick.name });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeId, routedCharacterId, selected]);

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
        className="relative grid h-full grid-rows-[minmax(0,1fr)]"
        style={{ gridTemplateColumns: `${rosterW}px minmax(0,1fr)` }}
      >
        <div className="col-start-1 min-w-0 min-h-0">
          <LeftSidebar
            sseSignal={sseSignal}
            selectedId={selected?.id}
            onSelect={(id, name) => { setOpenedProject(null); setSelected({ id, name }); }}
            onOpenProject={(p) => setOpenedProject(p)}
            onDelete={(id) => {
              if (selected?.id === id) setSelected(null);
            }}
          />
        </div>
        <div className="col-start-2 min-w-0 min-h-0">
          {openedProject ? (
            <ProjectPage projectId={openedProject.id} onBack={() => setOpenedProject(null)} />
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
        <ResizableDivider
          key="roster-divider"
          width={rosterW}
          min={ROSTER.min}
          max={ROSTER.max}
          onResize={setRosterW}
          onCommit={commitRosterW}
          label="调整名册宽度"
        />
      </div>
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </>
  );
}
