import { Link } from 'wouter';

import type { ProjectGalleryItem } from '@/api/gallery';

const SLOT_LABEL: Record<ProjectGalleryItem['asset_slot'], string> = {
  portrait: '立绘',
  promo: '美宣',
  turnaround: '三视图',
};

export function ArtWorkspace({
  projectId,
  works,
}: {
  projectId: string;
  works: ProjectGalleryItem[];
}) {
  if (works.length === 0) {
    return (
      <EmptyArtWorkspace />
    );
  }
  return (
    <div className="space-y-3" data-testid="project-works">
      <h2 className="text-base font-medium leading-none text-foreground/85">全部美术作品</h2>
      <div className="columns-[14rem] gap-4">
        {works.map(item => (
          <Link
            key={item.path}
            href={workHref(projectId, item)}
            aria-label={`查看 ${item.character_name} 的${SLOT_LABEL[item.asset_slot]}`}
            className="group relative mb-4 block break-inside-avoid overflow-hidden rounded-2xl"
          >
            <img
              src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`}
              alt=""
              className="block w-full"
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
  );
}

function workHref(projectId: string, item: ProjectGalleryItem): string {
  const base = `/workshop/${encodeURIComponent(projectId)}/art/characters/${encodeURIComponent(item.character_id)}/${item.asset_slot}`;
  if (!item.job_id) return base;
  return `${base}/${encodeURIComponent(item.job_id)}/${encodeURIComponent(item.path)}`;
}

function EmptyArtWorkspace() {
  return (
    <section className="grid min-h-[320px] place-items-center rounded-lg border border-border bg-card/30 px-6 text-center">
      <div className="max-w-lg space-y-4">
        <div className="space-y-2">
          <h2 className="font-display text-display italic text-foreground/70">这个项目还没有美术作品</h2>
          <p className="text-sm text-muted-foreground">
            从项目册进入美术工作区，新建或选择角色后开始立绘、美宣或三视图。
          </p>
        </div>
        <code className="inline-flex rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">
          /game-atelier:character
        </code>
      </div>
    </section>
  );
}
