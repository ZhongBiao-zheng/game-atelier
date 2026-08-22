import { useEffect, useState } from 'react';
import { Film, ImageIcon, LayoutPanelTop, PanelsTopLeft } from 'lucide-react';
import { Link } from 'wouter';

import {
  fetchCharacterWorkspace,
  type CharacterRelatedObject,
  type CharacterWorkspaceData,
} from '@/api/characters';
import type { AssetSlot } from '@/schema/jobs';

const SLOT_META: Record<AssetSlot, { label: string; icon: typeof ImageIcon }> = {
  portrait: { label: '立绘', icon: ImageIcon },
  promo: { label: '美宣', icon: PanelsTopLeft },
  turnaround: { label: '三视图', icon: LayoutPanelTop },
};

export function CharacterWorkspace({
  projectId,
  characterId,
}: {
  projectId: string;
  characterId: string;
}) {
  const [data, setData] = useState<CharacterWorkspaceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchCharacterWorkspace(projectId, characterId)
      .then(value => {
        if (!value?.character || !Array.isArray(value.assets) || !Array.isArray(value.related) || !Array.isArray(value.recent_media)) {
          throw new Error('角色工作台返回了无效数据');
        }
        if (!cancelled) setData(value);
      })
      .catch(reason => { if (!cancelled) setError((reason as Error).message); });
    return () => { cancelled = true; };
  }, [characterId, projectId]);

  if (error) return <p role="alert" className="p-8 text-sm text-destructive">{error}</p>;
  if (!data) return <p role="status" className="p-8 text-sm text-muted-foreground">正在读取角色工作台…</p>;

  return (
    <main className="stable-scroll h-full overflow-y-auto px-4 py-5 md:px-8 md:py-6">
      <div className="space-y-8">
        <header>
          <p className="text-xs uppercase tracking-label text-muted-foreground/70">Character Workspace</p>
          <h1 className="mt-2 font-display text-display italic text-foreground">{data.character.name}</h1>
          {data.character.derivative && (
            <p className="mt-2 text-xs text-muted-foreground">
              角色衍生 · 来源 {data.character.derivative.source_character_name}
            </p>
          )}
        </header>

        <CharacterWorks media={data.recent_media} />

        <section className="space-y-3" aria-label="角色资产地图">
          <h2 className="text-base font-medium text-foreground">资产地图</h2>
          <div className="divide-y divide-border rounded-lg border border-border bg-card/30">
            {data.assets.map(asset => {
              const meta = SLOT_META[asset.slot];
              const Icon = meta.icon;
              return (
                <Link
                  key={asset.slot}
                  href={`/workshop/${encodeURIComponent(projectId)}/art/characters/${encodeURIComponent(characterId)}/${asset.slot}`}
                  className="flex items-center gap-3 px-4 py-4 transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{meta.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {asset.count} 个版本 · {asset.canonical ? '已定稿' : '未定稿'}
                  </span>
                </Link>
              );
            })}
            <RelatedCategory
              label="相关 UI"
              projectId={projectId}
              items={data.related.filter(item => item.target.kind === 'ui')}
            />
            <RelatedCategory
              label="相关视频"
              projectId={projectId}
              items={data.related.filter(item => item.target.kind === 'video')}
            />
          </div>
        </section>
      </div>
    </main>
  );
}

function RelatedCategory({
  label,
  projectId,
  items,
}: {
  label: string;
  projectId: string;
  items: CharacterRelatedObject[];
}) {
  const Icon = label === '相关 UI' ? PanelsTopLeft : Film;
  return (
    <details>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{items.length} 个关联</span>
      </summary>
      {items.length > 0 ? (
        <div className="divide-y divide-border border-t border-border bg-background/25 pl-4">
          {items.map(item => (
            <RelatedRow key={relatedKey(item)} projectId={projectId} item={item} />
          ))}
        </div>
      ) : (
        <p className="border-t border-border px-11 py-3 text-xs text-muted-foreground">暂无关联作品</p>
      )}
    </details>
  );
}

function CharacterWorks({ media }: { media: CharacterWorkspaceData['recent_media'] }) {
  return (
    <section className="space-y-3" aria-label="角色作品">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-medium text-foreground">作品</h2>
        <span className="font-mono text-xs text-muted-foreground">定稿与最近作品</span>
      </div>
      {media.length > 0 ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {media.map(item => (
            <figure key={item.path} className="w-52 shrink-0 space-y-2">
              {item.media_type === 'video' ? (
                <video src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`} controls preload="metadata" className="aspect-[3/4] w-full rounded-lg border border-border bg-card object-cover" />
              ) : (
                <img src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`} alt="" className="aspect-[3/4] w-full rounded-lg border border-border bg-card object-cover" />
              )}
              <figcaption className="truncate text-xs text-muted-foreground">{item.detail}</figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-card/20 px-5 py-8 text-sm text-muted-foreground">
          这个角色还没有作品。
        </div>
      )}
    </section>
  );
}

function RelatedRow({ projectId, item }: { projectId: string; item: CharacterRelatedObject }) {
  const href = item.target.kind === 'ui'
    ? `/workshop/${encodeURIComponent(projectId)}/ui/${encodeURIComponent(item.target.scheme_id)}/screens/${encodeURIComponent(item.target.screen_id)}`
    : `/workshop/${encodeURIComponent(projectId)}/video/${encodeURIComponent(item.target.production_id)}`;
  const Icon = item.target.kind === 'ui' ? PanelsTopLeft : Film;
  return (
    <Link href={href} className="flex items-center gap-3 px-4 py-4 transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{item.title}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{item.detail}</span>
      </span>
      <span className="text-xs text-muted-foreground">{item.source === 'auto' ? '自动关联' : item.source === 'both' ? '自动 + 手动' : '手动关联'}</span>
    </Link>
  );
}

function relatedKey(item: CharacterRelatedObject): string {
  return item.target.kind === 'ui'
    ? `ui:${item.target.scheme_id}:${item.target.screen_id}`
    : `video:${item.target.production_id}`;
}
