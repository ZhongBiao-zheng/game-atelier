import { useCallback, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { Star } from 'lucide-react';

import { fetchGalleryRecent, type GalleryItem } from '@/api/gallery';
import { useGalleryFavorites } from '@/hooks/useGalleryFavorites';
import { HomeDottedBackground } from '@/components/HomeDottedBackground';
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

  const GalleryCard = useCallback(({ item }: { item: GalleryItem }) => {
    const favorited = isFavorited(item.path);
    return (
      <Link href={galleryItemHref(item)}>
        <div className="group relative overflow-hidden rounded-2xl">
          {/* Pinterest 式瀑布流：图片直出、无边框无放大，hover 只淡入操作按钮 */}
          <img
            src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`}
            alt=""
            className="w-full block"
            loading="lazy"
          />

          {/* 收藏按钮：hover 淡入（已收藏常显），玻璃药丸取代描边框 */}
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); void toggleFavorite(item.path); }}
            title={favorited ? '取消收藏' : '收藏'}
            aria-label={favorited ? '取消收藏' : '收藏'}
            className={`absolute right-3 top-3 grid size-9 place-items-center rounded-full bg-scrim/80 backdrop-blur-glass transition-all duration-200 hover:bg-background/90 z-10 ${favorited ? 'text-primary opacity-100' : 'text-foreground opacity-0 group-hover:opacity-100'}`}
          >
            <Star className="size-4" aria-hidden />
          </button>
        </div>
      </Link>
    );
  }, [isFavorited, toggleFavorite]);

  return (
    <div className="px-8 pb-12" aria-label="作品集首页">

      {/* ========== Studio 区域 - canvas 波点（复刻 tapnow，光标高斯冷蓝发光）========== */}
      <section className="relative min-h-[520px] flex items-center justify-center">
        <HomeDottedBackground />
        <div className="relative z-10 w-full">
          <Studio compact />
        </div>
      </section>

      {/* 作品展示标题 */}
      <h2 className="mb-5 text-base font-medium text-foreground">作品展示</h2>

      {/* Loading 状态 */}
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

      {/* Error 状态 */}
      {state.kind === 'error' && (
        <div className="text-sm text-muted-foreground text-center py-12">
          暂时拿不到图片，刷新试试。
        </div>
      )}

      {/* 空状态 */}
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

      {/* 瀑布流作品展示：CSS columns 方案，无额外依赖 */}
      {state.kind === 'success' && state.items.length > 0 && (
        <div className="columns-2 sm:columns-3 lg:columns-4 2xl:columns-5 gap-6">
          {state.items.map((item) => (
            <div key={item.path} className="mb-6 break-inside-avoid">
              <GalleryCard item={item} />
            </div>
          ))}
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
