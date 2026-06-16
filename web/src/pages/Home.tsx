import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { Star } from 'lucide-react';

import { fetchGalleryRecent, type GalleryItem } from '@/api/gallery';
import { useGalleryFavorites } from '@/hooks/useGalleryFavorites';
import { Studio } from './Studio';

type State =
  | { kind: 'loading' }
  | { kind: 'success'; items: GalleryItem[] }
  | { kind: 'error' };

export function Home() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const { toggleFavorite, isFavorited } = useGalleryFavorites();

  useEffect(() => {
    let cancel = false;
    fetchGalleryRecent(24)
      .then((items) => !cancel && setState({ kind: 'success', items }))
      .catch(() => !cancel && setState({ kind: 'error' }));
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <div className="px-8 pb-12" aria-label="作品集首页">
      <section className="min-h-[520px] flex items-center justify-center">
        <div className="w-full">
          <Studio compact />
        </div>
      </section>

      <h2 className="mb-5 text-base font-medium text-foreground">作品展示</h2>

      {state.kind === 'loading' && (
        <div className="columns-2 sm:columns-3 lg:columns-4 2xl:columns-5 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              data-skeleton
              className="mb-6 break-inside-avoid bg-card/40 rounded-lg"
              style={{ height: 200 + (i % 3) * 80 }}
            />
          ))}
        </div>
      )}

      {state.kind === 'error' && (
        <div className="text-sm text-muted-foreground text-center py-12">
          暂时拿不到图片，刷新试试。
        </div>
      )}

      {state.kind === 'success' && state.items.length === 0 && (
        <div className="text-center py-12">
          <p className="font-display text-display italic text-foreground/70">
            工坊还空着。
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            在终端跑{' '}
            <code className="font-mono text-foreground/80 bg-card px-1.5 py-0.5 rounded">
              /game-atelier:character &lt;名字&gt;
            </code>{' '}
            开始第一个角色。
          </p>
        </div>
      )}

      {state.kind === 'success' && state.items.length > 0 && (
        <div className="columns-2 sm:columns-3 lg:columns-4 2xl:columns-5 gap-6">
          {state.items.map((item) => {
            const favorited = isFavorited(item.path);
            return (
            <Link
              key={`${item.path}-${item.filename}`}
              href={galleryItemHref(item)}
              className="group relative mb-6 block break-inside-avoid"
            >
              <img
                src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`}
                alt=""
                className="w-full rounded-lg border border-border hover:border-input transition-all duration-150 hover:scale-[1.02]"
                loading="lazy"
              />
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void toggleFavorite(item.path); }}
                title={favorited ? '取消收藏' : '收藏'}
                aria-label={favorited ? '取消收藏' : '收藏'}
                className={`absolute right-2 top-2 grid size-8 place-items-center rounded-full border border-border bg-scrim backdrop-blur-glass transition-opacity hover:bg-background/90 ${favorited ? 'text-primary opacity-100' : 'text-white opacity-0 group-hover:opacity-100'}`}
              >
                <Star className="size-4" aria-hidden />
              </button>
            </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function galleryItemHref(item: GalleryItem): string {
  if (!item.job_id) {
    return `/character/${item.character_id}/${item.asset_slot}`;
  }
  return `/character/${item.character_id}/${item.asset_slot}/${item.job_id}/${encodeURIComponent(item.path)}`;
}
