import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { Link, useLocation } from 'wouter';
import { SharedCanvasSettingsDialog } from '@/components/canvas/SharedCanvasSettingsDialog';
import { SharedCanvasList, SharedStatusButton, useSharedCanvases } from '@/components/canvas/SharedCanvasList';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { stopCollabShare } from '@/api/collab';
import type { CollabCard } from '@/schema/collab';
import { AddIcon, DeleteIcon, DownloadIcon, EditIcon, HideIcon, MoreIcon, RetryIcon, SearchIcon, ShowIcon, ShareIcon, UploadIcon } from '@/components/ui/icons';
import { fetchHiddenCanvasProjects, setCanvasProjectGalleryHidden } from '@/api/gallery';

import {
  canvasMediaUrl,
  commitCanvasPackage,
  createCanvasProject,
  deleteCanvasProject,
  exportCanvasProjects,
  getCanvasDocument,
  inspectCanvasPackage,
  listCanvasProjects,
  renameCanvasProject,
} from '@/api/canvas';
import { restoreTrash } from '@/api/trash';
import { SwapLabel } from '@/components/ui/swap-label';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { EditableText, type EditableTextHandle } from '@/components/ui/editable-text';
import type { CanvasProjectSummary } from '@/schema/canvas';
import { FileInput } from '@/components/ui/file-input';
import { RevealImage } from '@/components/ui/reveal-image';
import { errorText } from '@/lib/errorText';
import { clipName, notify } from '@/lib/notify';
import { MOTION_DURATION, MOTION_EASE, MOTION_SPRING, MOTION_STAGGER, motionAvailable, SKELETON_DELAY_MS } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { CANVAS_PROJECT_DISCARDED_EVENT, markFreshCanvasProject, UNTITLED_CANVAS_PROJECT_NAME } from './canvasFreshProject';

/** 导入后新卡片高亮这么久。 */
const IMPORTED_HIGHLIGHT_MS = 2400;

/** 读取超过这么久才出骨架：快的时候直接出卡片，不闪一下骨架。 */
/** 首屏卡片错峰淡入，总时长封顶。 */
const ENTRANCE_STAGGER_CAP = 0.15;

const CARD_ENTER: Transition = { duration: MOTION_DURATION.base, ease: MOTION_EASE.out };
const CARD_EXIT: Transition = { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle };

/** 卡片列表怎么动：读取、删除、重命名后重排时淡入淡出加让位（reveal）；按搜索词筛选是逐字的高频操作，直接换（instant）。 */
type ListMotion = 'reveal' | 'instant';


export function CanvasProjectIndex({ onOpenProject }: { onOpenProject: (projectId: string) => void }) {
  const [, navigate] = useLocation();
  const [shared, setShared] = useState(() => new URLSearchParams(window.location.search).get('view') === 'shared');
  const peers = useSharedCanvases();
  const ownShares = peers.cards.filter(card => card.is_self);
  const [settings, setSettings] = useState<CanvasProjectSummary | null>(null);
  const [projects, setProjects] = useState<CanvasProjectSummary[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importedIds, setImportedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [hiddenOnHomeIds, setHiddenOnHomeIds] = useState<ReadonlySet<string>>(() => new Set());
  const importRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!importedIds.size) return;
    const timer = window.setTimeout(() => setImportedIds(new Set()), IMPORTED_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [importedIds]);
  const [listMotion, setListMotion] = useState<ListMotion>('reveal');
  // 加载中与为空是两态：读取超过 SKELETON_DELAY_MS 才出骨架，之前保持空白。
  const [showSkeleton, setShowSkeleton] = useState(false);
  useEffect(() => {
    if (!loading) {
      setShowSkeleton(false);
      return;
    }
    const timer = window.setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);
  // 首屏一批卡片错峰淡入；之后再出现的卡片（导入、重新读取）各自淡入，不再错峰。
  const firstReveal = useRef(true);
  useEffect(() => {
    if (!loading && projects.length > 0) firstReveal.current = false;
  }, [loading, projects.length]);
  // 错误条收回途中仍显示最后一条。
  const bannerError = actionError ?? loadError;
  const lastBannerError = useRef<string | null>(null);
  if (bannerError) lastBannerError.current = bannerError;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [list, hiddenIds] = await Promise.all([
        listCanvasProjects(),
        fetchHiddenCanvasProjects().catch(() => [] as string[]),
      ]);
      setProjects(list);
      setHiddenOnHomeIds(new Set(hiddenIds));
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const drop = (event: Event) => {
      const projectId = (event as CustomEvent<string>).detail;
      setProjects(current => current.filter(item => item.project_id !== projectId));
    };
    window.addEventListener(CANVAS_PROJECT_DISCARDED_EVENT, drop);
    return () => window.removeEventListener(CANVAS_PROJECT_DISCARDED_EVENT, drop);
  }, []);

  // D12：直接建「未命名项目」并进入，名字在画布顶栏改；什么都没做就离开的空项目由画布自动清掉。
  async function createProject() {
    setCreating(true);
    setActionError(null);
    try {
      const project = await createCanvasProject(UNTITLED_CANVAS_PROJECT_NAME);
      markFreshCanvasProject(project.project_id);
      onOpenProject(project.project_id);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setCreating(false);
    }
  }

  async function renameProjectInline(project: CanvasProjectSummary, name: string) {
    const renamed = await renameCanvasProject(project.project_id, name);
    setListMotion('reveal');
    setProjects(current => current
      .map(item => item.project_id === project.project_id ? { ...item, ...renamed } : item)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at)));
  }

  // D11：删除进回收站，不弹确认；撤销 toast 直接从回收站还原。
  async function deleteProject(project: CanvasProjectSummary) {
    setBusyProjectId(project.project_id);
    setActionError(null);
    try {
      const document = await getCanvasDocument(project.project_id);
      const trashId = await deleteCanvasProject(project.project_id, document.revision);
      setListMotion('reveal');
      setProjects(current => current.filter(item => item.project_id !== project.project_id));
      notify.undo(`已移至回收站：项目「${clipName(project.name)}」`, () => {
        void restoreTrash(trashId)
          .then(() => { setListMotion('reveal'); return load(); })
          .catch(error => notify.error(errorText(error)));
      });
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusyProjectId(null);
    }
  }

  async function handleExport(project: CanvasProjectSummary) {
    setBusyProjectId(project.project_id);
    setActionError(null);
    try {
      await exportCanvasProjects([project.project_id]);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setBusyProjectId(null);
    }
  }

  async function toggleHiddenOnHome(project: CanvasProjectSummary) {
    const nextHidden = !hiddenOnHomeIds.has(project.project_id);
    setHiddenOnHomeIds(current => {
      const next = new Set(current);
      if (nextHidden) next.add(project.project_id);
      else next.delete(project.project_id);
      return next;
    });
    try {
      const updated = await setCanvasProjectGalleryHidden(project.project_id, nextHidden);
      setHiddenOnHomeIds(new Set(updated));
      if (nextHidden) {
        notify.undo(`「${clipName(project.name)}」的作品不在首页展示`, () => {
          void setCanvasProjectGalleryHidden(project.project_id, false)
            .then(restored => setHiddenOnHomeIds(new Set(restored)))
            .catch(error => notify.error(errorText(error)));
        });
      }
    } catch (error) {
      setHiddenOnHomeIds(current => {
        const reverted = new Set(current);
        if (nextHidden) reverted.delete(project.project_id);
        else reverted.add(project.project_id);
        return reverted;
      });
      notify.error(errorText(error));
    }
  }

  // 校验通过直接导入：导入只新建项目，不覆盖也不计费，不再多确认一次。
  async function handlePackage(file: File) {
    setImporting(true);
    setActionError(null);
    try {
      const inspection = await inspectCanvasPackage(file);
      const imported = await commitCanvasPackage(inspection.token);
      setListMotion('reveal');
      await load();
      setImportedIds(new Set(imported.projects.map(project => project.project_id)));
      notify.info(`已导入 ${imported.projects.length} 个项目`);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setImporting(false);
    }
  }

  function openShared(card: CollabCard) {
    if (card.is_self) onOpenProject(card.project_id);
    else navigate(`/canvas/shared/${encodeURIComponent(card.peer_key)}/${encodeURIComponent(card.project_id)}`);
  }

  async function stopSharing(projectId: string) {
    try { await stopCollabShare(projectId); await peers.refresh(); }
    catch (error) { setActionError(errorText(error)); }
  }

  const filteredProjects = projects.filter(project =>
    project.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <section className="stable-scroll h-full overflow-y-auto bg-background">
      <div className="w-full px-4 py-8 sm:px-6 md:px-10 md:py-12">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-5">
          <div className="flex items-baseline gap-3">
            <h1 className="text-balance font-display text-display italic text-foreground">画布项目</h1>
            {!shared && !loading && projects.length > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">共 {projects.length} 个项目</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SharedStatusButton shares={ownShares} refresh={peers.refresh} />
            {!shared && <>{projects.length > 0 && (
              <InputGroup className="w-56">
                <InputGroupAddon><SearchIcon aria-hidden /></InputGroupAddon>
                <InputGroupInput
                  aria-label="搜索画布项目"
                  placeholder="搜索画布项目"
                  value={query}
                  onChange={event => {
                    setListMotion('instant');
                    setQuery(event.target.value);
                  }}
                />
              </InputGroup>
            )}
            <Button variant="ghost" asChild>
              <Link href="/settings/trash"><DeleteIcon aria-hidden="true" />回收站</Link>
            </Button>
            <Button variant="outline" disabled={importing} onClick={() => importRef.current?.click()}>
              <UploadIcon aria-hidden="true" /><SwapLabel active={importing} on="导入中…" off="导入项目包" />
            </Button>
            <Button disabled={creating} onClick={() => void createProject()}>
              <AddIcon aria-hidden="true" />新建项目
            </Button></>}
          </div>
          <FileInput
            ref={importRef}
            accept=".zip,application/zip"
            className="sr-only"
            aria-label="选择 Canvas 项目包"
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) void handlePackage(file);
              event.target.value = '';
            }}
          />
        </header>

        <Segmented aria-label="画布列表" className="mb-5 w-fit grid-cols-2">
          <SegmentedItem value="mine" className="px-4" selected={!shared} onSelect={() => setShared(false)}>我的画布</SegmentedItem>
          <SegmentedItem value="shared" className="px-4" selected={shared} onSelect={() => setShared(true)}>
            共享画布{peers.cards.length > 0 && <span className="ml-1 text-xs tabular-nums">{peers.cards.length}</span>}
          </SegmentedItem>
        </Segmented>
        {shared ? <SharedCanvasList {...peers} onOpen={openShared} /> : <>
        {/* 错误条从 0 高度展开、收回；外边距改成内层 padding，展开到底高度不跳。 */}
        <Collapse open={Boolean(bannerError)}>
          <div className="pb-6">
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <span>{bannerError ?? lastBannerError.current}</span>
              {loadError && (
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  <RetryIcon aria-hidden="true" />重试
                </Button>
              )}
            </div>
          </div>
        </Collapse>

        <div className="relative grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-busy={loading}>
          {loading && <span role="status" className="sr-only">加载中…</span>}
          {!loading && !loadError && projects.length === 0 && (
            <Button
              variant="ghost"
              disabled={creating}
              onClick={() => void createProject()}
              className="aspect-[16/10] h-auto flex-col gap-3 rounded-xl border-dashed border-foreground/20 font-normal text-muted-foreground hover:border-foreground/40 hover:text-foreground [&_svg]:size-7"
            >
              <AddIcon size="xl" aria-hidden="true" />
              <span className="text-sm">新建一个画布项目</span>
            </Button>
          )}
          {!loading && !loadError && projects.length > 0 && filteredProjects.length === 0 && (
            <p className="col-span-full py-12 text-center text-sm text-muted-foreground">没有匹配的画布项目</p>
          )}
          {loading && projects.length === 0 && showSkeleton
            && Array.from({ length: 3 }, (_, index) => <CanvasCardSkeleton key={index} />)}
          {/* 删除：被删的卡 150ms 淡出并让出位置（popLayout），其余卡片同时滑过去补位；按搜索词筛选直接换。 */}
          <AnimatePresence mode="popLayout" initial={false} custom={listMotion}>
            {filteredProjects.map((project, index) => (
              <motion.div
                key={project.project_id}
                layout={listMotion === 'reveal' ? 'position' : false}
                custom={listMotion}
                variants={CARD_VARIANTS}
                initial={listMotion === 'reveal' && motionAvailable() ? 'hidden' : false}
                animate="shown"
                exit="gone"
                transition={{
                  ...CARD_ENTER,
                  layout: MOTION_SPRING.snappy,
                  delay: firstReveal.current ? Math.min(index * MOTION_STAGGER, ENTRANCE_STAGGER_CAP) : 0,
                }}
              >
                <CanvasProjectCard
                  project={project}
                  hiddenOnHome={hiddenOnHomeIds.has(project.project_id)}
                  share={ownShares.find(card => card.project_id === project.project_id)}
                  onShare={() => setSettings(project)}
                  onStop={() => void stopSharing(project.project_id)}
                  onOpen={() => onOpenProject(project.project_id)}
                  onInlineRename={name => renameProjectInline(project, name)}
                  onToggleHiddenOnHome={() => void toggleHiddenOnHome(project)}
                  onExport={() => void handleExport(project)}
                  onDelete={() => void deleteProject(project)}
                  disabled={busyProjectId === project.project_id}
                  highlighted={importedIds.has(project.project_id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        </>}
        {settings && <SharedCanvasSettingsDialog key={settings.project_id} projectId={settings.project_id} name={settings.name}
          share={ownShares.find(card => card.project_id === settings.project_id)} onClose={() => setSettings(null)}
          onSaved={() => { setSettings(null); void peers.refresh(); }} />}
      </div>

    </section>
  );
}


/** 卡片进出场：进场 200ms 淡入上移 8px；删除 150ms 淡出微缩；筛选掉的直接消失。减弱动态效果时 MotionConfig 去掉位移与缩放。 */
const CARD_VARIANTS = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0 },
  gone: (mode: ListMotion) => mode === 'reveal'
    ? { opacity: 0, scale: 0.96, transition: CARD_EXIT }
    : { opacity: 0, transition: { duration: 0 } },
};


function CanvasProjectCard({
  project, share, onShare, onStop,
  hiddenOnHome,
  onOpen,
  onInlineRename,
  onToggleHiddenOnHome,
  onExport,
  onDelete,
  disabled,
  highlighted,
}: {
  project: CanvasProjectSummary;
  share?: CollabCard;
  onShare: () => void;
  onStop: () => void;
  hiddenOnHome: boolean;
  onOpen: () => void;
  onInlineRename: (name: string) => Promise<void>;
  onToggleHiddenOnHome: () => void;
  onExport: () => void;
  onDelete: () => void;
  disabled: boolean;
  highlighted: boolean;
}) {
  const titleEditorRef = useRef<EditableTextHandle>(null);

  function beginInlineRename() {
    titleEditorRef.current?.edit();
  }

  return (
    <article className={cn(
      'group relative overflow-hidden rounded-xl border border-border bg-card/45 transition-colors hover:border-input',
      highlighted && 'border-primary',
    )}>
      <Button variant="bare"
        type="button"
        disabled={disabled}
        aria-label={`打开画布项目 ${project.name}`}
        onClick={onOpen}
        className="block w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
      >
        {project.cover ? (
          <div className="media-edge overflow-hidden border-b border-border bg-secondary/30">
            <RevealImage
              src={canvasMediaUrl(project.project_id, project.cover.version_id, 360)}
              alt=""
              loading="lazy"
              className="media-checker aspect-[16/10] w-full object-cover"
            />
          </div>
        ) : (
          <div className="grid aspect-[16/10] place-items-center border-b border-border bg-secondary/30 px-4 text-center font-display text-display text-muted-foreground">
            <span className="line-clamp-2">{project.name}</span>
          </div>
        )}
      </Button>
      <div className="space-y-1 p-4 pr-14">
        <EditableText
          ref={titleEditorRef}
          value={project.name}
          size="lg"
          disabled={disabled}
          triggerLabel={`重命名画布项目 ${project.name}`}
          className="-ml-2 font-medium text-foreground"
          onSave={onInlineRename}
        />
        <p className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          <span>{project.node_count} 个节点 · {project.connection_count} 条连线 · {formatActivity(project.updated_at)}</span>
          {share && <span>共享中 · {share.online_count} 人在线</span>}
          {hiddenOnHome && <span className="inline-flex items-center gap-1 text-subtle-foreground"><HideIcon size="sm" aria-hidden="true" />不在首页展示</span>}
        </p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={disabled} variant="ghost" size="icon" aria-label={`管理画布项目 ${project.name}`} className="absolute bottom-2 right-2 size-11">
            <MoreIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => window.setTimeout(beginInlineRename, 0)}><EditIcon aria-hidden="true" />重命名</DropdownMenuItem>
          <DropdownMenuItem onSelect={onShare}><ShareIcon aria-hidden="true" />{share ? '共享设置' : '共享画布…'}</DropdownMenuItem>
          {share && <DropdownMenuItem onSelect={onStop}>停止共享</DropdownMenuItem>}
          <DropdownMenuItem onSelect={onToggleHiddenOnHome}>
            {hiddenOnHome ? <><ShowIcon aria-hidden="true" />在首页展示作品</> : <><HideIcon aria-hidden="true" />不在首页展示作品</>}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onExport}><DownloadIcon aria-hidden="true" />导出项目包</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={onDelete}><DeleteIcon aria-hidden="true" />删除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </article>
  );
}


function CanvasCardSkeleton() {
  return (
    // 骨架静态，不循环闪烁（DESIGN「不用自动 loop 动画」）。
    <div aria-hidden="true" className="content-swap-in overflow-hidden rounded-xl border border-border bg-card/40">
      <div className="aspect-[16/10] border-b border-border bg-secondary/40" />
      <div className="min-h-24 space-y-2 p-4">
        <div className="h-4 w-2/3 rounded-sm bg-secondary" />
        <div className="h-3 w-1/3 rounded-sm bg-secondary/70" />
      </div>
    </div>
  );
}


function formatActivity(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚编辑';
  return `编辑于 ${new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)}`;
}
