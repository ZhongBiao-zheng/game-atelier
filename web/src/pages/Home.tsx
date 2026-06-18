import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { Star } from 'lucide-react';
import { Masonry } from 'masonic';

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
  const glowRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (!glowRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    glowRef.current.style.setProperty('--cx', `${e.clientX - rect.left}px`);
    glowRef.current.style.setProperty('--cy', `${e.clientY - rect.top}px`);
  }, []);

  const handleMouseLeave = useCallback(() => {
    glowRef.current?.style.setProperty('--cx', '-9999px');
    glowRef.current?.style.setProperty('--cy', '-9999px');
  }, []);

  useEffect(() => {
    let cancel = false;
    fetchGalleryRecent(24)
      .then((items) => !cancel && setState({ kind: 'success', items }))
      .catch(() => !cancel && setState({ kind: 'error' }));
    return () => {
      cancel = true;
    };
  }, []);

  // 瀑布流卡片渲染器（简洁边框 + 投影）
  const GalleryCard = useCallback(({ data: item }: { data: GalleryItem }) => {
    const favorited = isFavorited(item.path);
    return (
      <div className="p-1"> {/* 修复 masonic 裁剪问题 */}
        <Link href={galleryItemHref(item)} style={{ width: '100%' }}>
          {/* 简洁边框容器 */}
          <div className="group relative overflow-hidden rounded-2xl border border-border/60 transition-all duration-500 hover:border-primary/30 hover:translate-y-[-6px] hover:scale-[1.02] hover:shadow-[0_25px_50px_rgba(0,0,0,0.12),0_0_0_1px_rgba(212,165,116,0.08)]">

            {/* 顶部内发光（hover 时显示） */}
            <div className="absolute inset-[-1px] rounded-[inherit] opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none z-10" style={{
              background: 'linear-gradient(180deg, rgba(212, 165, 116, 0.2), transparent 50%)',
              padding: '1px',
              WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
              WebkitMaskComposite: 'xor',
              maskComposite: 'exclude',
            }} />

            {/* 图片 + 内边距，PNG 保持完全透明 */}
            <div className="p-3">
              <img
                src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`}
                alt=""
                className="w-full block rounded-xl transition-transform duration-700 group-hover:scale-105"
                style={{
                  filter: 'drop-shadow(0 4px 12px rgba(0, 0, 0, 0.08))',
                }}
                loading="lazy"
              />
            </div>

            {/* 收藏按钮 */}
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); void toggleFavorite(item.path); }}
              title={favorited ? '取消收藏' : '收藏'}
              aria-label={favorited ? '取消收藏' : '收藏'}
              className={`absolute right-4 top-4 grid size-9 place-items-center rounded-full border border-border/50 bg-scrim/80 backdrop-blur transition-all duration-300 hover:bg-background z-10 ${favorited ? 'text-primary opacity-100' : 'text-foreground opacity-0 group-hover:opacity-100'}`}
            >
              <Star className="size-4" aria-hidden />
            </button>
          </div>
        </Link>
      </div>
    );
  }, [isFavorited, toggleFavorite]);

  return (
    <div className="px-8 pb-12" aria-label="作品集首页">

      {/* ========== Studio 区域 - 保留原始发光波点效果 ========== */}
      <section
        className="relative min-h-[520px] flex items-center justify-center"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <div aria-hidden className="absolute inset-0 bg-dots pointer-events-none" />
        <div ref={glowRef} aria-hidden className="absolute inset-0 bg-dots-glow pointer-events-none" />
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

      {/* ✅ 瀑布流作品展示 - 玻璃质感卡片 */}
      {state.kind === 'success' && state.items.length > 0 && (
        <Masonry
          items={state.items}
          columnGutter={24}  // 列间距 24px
          rowGutter={24}     // 行间距 24px
          columnWidth={260}  // 最小列宽（放大30%）
          render={GalleryCard}
          overscanBy={2}      // 预渲染范围
        />
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
