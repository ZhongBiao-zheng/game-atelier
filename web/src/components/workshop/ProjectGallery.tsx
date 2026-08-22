import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  EyeOff,
  Image,
  LoaderCircle,
  Play,
  RefreshCw,
} from 'lucide-react';
import { Link, useSearchParams } from 'wouter';

import {
  fetchProjectGallery,
  fetchProjectGalleryMedia,
  setGalleryHidden,
  type ProjectGalleryCategory,
  type ProjectGalleryMedia,
} from '@/api/gallery';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const FILTERS: Array<{ id: ProjectGalleryCategory; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'art', label: '美术' },
  { id: 'ui', label: 'UI' },
  { id: 'video', label: '视频' },
];

export function ProjectGallery({ projectId }: { projectId: string }) {
  const [category, setCategory] = useState<ProjectGalleryCategory>('all');
  const [items, setItems] = useState<ProjectGalleryMedia[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useSearchParams();
  const selectedPath = search.get('media');
  const [selected, setSelected] = useState<ProjectGalleryMedia | null>(null);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const [hiding, setHiding] = useState(false);
  const [hideError, setHideError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const selectedIndex = selected
    ? items.findIndex(item => item.path === selected.path)
    : -1;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItems([]);
    setNextCursor(null);
    fetchProjectGallery(projectId, category)
      .then(page => {
        if (cancelled) return;
        setItems(page.items);
        setNextCursor(page.next_cursor);
      })
      .catch(reason => { if (!cancelled) setError((reason as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [category, projectId, reloadKey]);

  useEffect(() => {
    if (!selectedPath) {
      setSelected(null);
      setSelectedError(null);
      return;
    }
    const existing = items.find(item => item.path === selectedPath);
    if (existing) {
      setSelected(existing);
      setSelectedError(null);
      return;
    }
    let cancelled = false;
    setSelected(null);
    setSelectedError(null);
    fetchProjectGalleryMedia(projectId, selectedPath)
      .then(item => { if (!cancelled) setSelected(item); })
      .catch(reason => { if (!cancelled) setSelectedError((reason as Error).message); });
    return () => { cancelled = true; };
  }, [items, projectId, selectedPath]);

  function select(item: ProjectGalleryMedia, trigger?: HTMLButtonElement) {
    if (trigger) previewTriggerRef.current = trigger;
    setSearch(previous => {
      const next = new URLSearchParams(previous);
      next.set('media', item.path);
      return next;
    });
  }

  function closePreview() {
    setSearch(previous => {
      const next = new URLSearchParams(previous);
      next.delete('media');
      return next;
    });
  }

  function selectAdjacent(offset: -1 | 1) {
    const item = items[selectedIndex + offset];
    if (item) select(item);
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchProjectGallery(projectId, category, nextCursor);
      setItems(current => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  async function hideSelected() {
    if (!selected) return;
    setHiding(true);
    setHideError(null);
    try {
      await setGalleryHidden(selected.path, true);
      setItems(current => current.filter(item => item.path !== selected.path));
      closePreview();
    } catch (reason) {
      setHideError((reason as Error).message);
    } finally {
      setHiding(false);
    }
  }

  return (
    <section aria-labelledby="project-gallery-heading" className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-label text-muted-foreground">项目画廊</p>
          <h2 id="project-gallery-heading" className="text-base font-medium text-foreground">
            最新作品
          </h2>
        </div>
        <div role="group" aria-label="筛选项目作品" className="flex flex-wrap gap-1 rounded-lg border border-border bg-card/40 p-1">
          {FILTERS.map(filter => (
            <Button
              key={filter.id}
              type="button"
              variant={category === filter.id ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={category === filter.id}
              onClick={() => setCategory(filter.id)}
            >
              {filter.label}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span>{error}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setReloadKey(value => value + 1)}>
            <RefreshCw className="size-4" aria-hidden />
            重试
          </Button>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" aria-label="正在读取项目画廊">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="aspect-[4/3] animate-pulse rounded-lg border border-border bg-secondary/30 motion-reduce:animate-none" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="grid min-h-64 place-items-center rounded-lg border border-dashed border-border bg-card/25 px-6 text-center">
          <div className="space-y-2">
            <Image className="mx-auto size-7 text-muted-foreground" aria-hidden />
            <p className="text-base font-medium text-foreground">还没有可展示的作品</p>
            <p className="text-sm text-muted-foreground">完成角色图片、UI 页面或视频后，会按最新时间出现在这里。</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {items.map(item => (
            <button
              key={item.path}
              type="button"
              onClick={event => select(item, event.currentTarget)}
              aria-label={`预览${item.title}，${item.detail}`}
              className="group overflow-hidden rounded-lg border border-border bg-card/35 text-left transition-colors hover:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className="relative block aspect-[4/3] overflow-hidden bg-secondary/30">
                {item.media_type === 'image' ? (
                  <img
                    src={mediaUrl(item.path)}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover transition-transform duration-150 motion-reduce:transition-none group-hover:scale-[1.02]"
                  />
                ) : (
                  <>
                    <video
                      src={mediaUrl(item.path)}
                      preload="metadata"
                      muted
                      playsInline
                      className="size-full object-cover"
                    />
                    <span className="absolute inset-0 grid place-items-center bg-scrim/20">
                      <span className="grid size-11 place-items-center rounded-full border border-white/30 bg-scrim/60 text-white">
                        <Play className="size-4 fill-current" aria-hidden />
                      </span>
                    </span>
                  </>
                )}
              </span>
              <span className="block space-y-0.5 px-3 py-2.5">
                <span className="block truncate text-sm font-medium text-foreground">{item.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />}
            {loadingMore ? '加载中…' : '加载更多'}
          </Button>
        </div>
      )}

      <Dialog open={Boolean(selectedPath)} onOpenChange={open => { if (!open) closePreview(); }}>
        <DialogContent
          className="max-h-[calc(100vh-2rem)] max-w-5xl overflow-y-auto p-0"
          onCloseAutoFocus={event => {
            event.preventDefault();
            previewTriggerRef.current?.focus();
          }}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>{selected?.title ?? '作品预览'}</DialogTitle>
            <DialogDescription>{selected?.detail ?? '正在读取项目作品'}</DialogDescription>
          </DialogHeader>
          {selectedError ? (
            <div className="p-6" role="alert">{selectedError}</div>
          ) : selected ? (
            <div className="grid min-h-0 md:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="grid min-h-64 place-items-center overflow-hidden bg-scrim/70 md:min-h-[32rem]">
                {selected.media_type === 'image' ? (
                  <img src={mediaUrl(selected.path)} alt={`${selected.title}，${selected.detail}`} className="max-h-[80vh] max-w-full object-contain" />
                ) : (
                  <video src={mediaUrl(selected.path)} controls playsInline preload="metadata" className="max-h-[80vh] max-w-full" />
                )}
              </div>
              <div className="flex flex-col gap-5 p-5">
                <div className="space-y-1 pr-8">
                  <p className="text-xs uppercase tracking-label text-muted-foreground">作品详情</p>
                  <h2 className="text-base font-medium text-foreground">{selected.title}</h2>
                  <p className="text-sm text-muted-foreground">{selected.detail}</p>
                </div>
                <dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">类型</dt>
                  <dd>{selected.media_type === 'image' ? '图片' : '视频'}</dd>
                  <dt className="text-muted-foreground">产出时间</dt>
                  <dd>{formatDate(selected.produced_at)}</dd>
                </dl>
                <div className="grid grid-cols-2 gap-2" aria-label="切换预览作品">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => selectAdjacent(-1)}
                    disabled={selectedIndex <= 0}
                  >
                    <ChevronLeft className="size-4" aria-hidden />
                    上一件
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => selectAdjacent(1)}
                    disabled={selectedIndex < 0 || selectedIndex >= items.length - 1}
                  >
                    下一件
                    <ChevronRight className="size-4" aria-hidden />
                  </Button>
                </div>
                <DialogFooter className="mt-auto sm:flex-col sm:items-stretch">
                  {hideError && <p role="alert" className="text-sm text-destructive">{hideError}</p>}
                  <Button type="button" variant="outline" onClick={() => void hideSelected()} disabled={hiding}>
                    <EyeOff className="size-4" aria-hidden />
                    {hiding ? '隐藏中…' : '从项目画廊隐藏'}
                  </Button>
                  <Button asChild>
                    <Link href={assetHref(projectId, selected)}>进入资产详情</Link>
                  </Button>
                </DialogFooter>
              </div>
            </div>
          ) : (
            <div className="grid min-h-64 place-items-center">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="加载作品" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function mediaUrl(path: string): string {
  return `/api/gallery/image?path=${encodeURIComponent(path)}`;
}

function assetHref(projectId: string, item: ProjectGalleryMedia): string {
  const project = encodeURIComponent(projectId);
  if (item.target.kind === 'art') {
    const base = `/workshop/${project}/art/characters/${encodeURIComponent(item.target.character_id)}/${item.target.asset_slot}`;
    return item.job_id ? `${base}/${encodeURIComponent(item.job_id)}/${encodeURIComponent(item.path)}` : base;
  }
  if (item.target.kind === 'ui') {
    return `/workshop/${project}/ui/${encodeURIComponent(item.target.scheme_id)}/screens/${encodeURIComponent(item.target.screen_id)}`;
  }
  return `/workshop/${project}/video/${encodeURIComponent(item.target.production_id)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}
