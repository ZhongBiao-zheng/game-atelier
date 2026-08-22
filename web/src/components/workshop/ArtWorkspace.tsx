import { Link } from 'wouter';

import type { ProjectGalleryMedia } from '@/api/gallery';
import type { AssetSlot } from '@/schema/jobs';

const SLOT_LABEL: Record<AssetSlot, string> = {
  portrait: '立绘',
  promo: '美宣',
  turnaround: '三视图',
};

export function ArtWorkspace({
  projectId,
  works,
}: {
  projectId: string;
  works: ProjectGalleryMedia[];
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
        {works.map(item => item.target.kind === 'art' && (
          <Link
            key={item.path}
            href={workHref(projectId, item)}
            aria-label={`查看 ${item.title} 的${SLOT_LABEL[item.target.asset_slot]}`}
            className="group relative mb-4 block break-inside-avoid overflow-hidden rounded-2xl"
          >
            <img
              src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`}
              alt=""
              className="block w-full"
              loading="lazy"
            />
            <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-scrim/80 px-3 py-2 text-xs text-white opacity-0 backdrop-blur-glass transition-opacity group-hover:opacity-100">
              <span className="truncate">{item.title}</span>
              <span className="shrink-0 text-white/60">{SLOT_LABEL[item.target.asset_slot]}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function workHref(projectId: string, item: ProjectGalleryMedia): string {
  if (item.target.kind !== 'art') return `/workshop/${encodeURIComponent(projectId)}/art`;
  const base = `/workshop/${encodeURIComponent(projectId)}/art/characters/${encodeURIComponent(item.target.character_id)}/${item.target.asset_slot}`;
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
            在左侧资产库新建或选择角色后，开始立绘、美宣或三视图。
          </p>
        </div>
        <code className="inline-flex rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">
          /game-atelier:character
        </code>
      </div>
    </section>
  );
}
