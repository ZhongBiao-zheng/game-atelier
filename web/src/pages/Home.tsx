import { useCallback, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { Heart } from 'lucide-react';

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
  const colCount = useColumnCount();

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
      // 卡片容器本身非交互：导航链接与喜欢按钮作两个平级交互元素，
      // 不再用 <a> 套 <button>（非法嵌套交互），喜欢点击也无需 stopPropagation 兜底。
      <div className="group relative overflow-hidden rounded-2xl">
        {/* Pinterest 式瀑布流：图片直出、无边框无放大，hover 只淡入操作按钮 */}
        <Link
          href={galleryItemHref(item)}
          aria-label={`查看 ${item.character_id} 的${SLOT_LABEL[item.asset_slot]}`}
          className="block"
        >
          <img
            src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`}
            alt=""
            className="w-full block"
            loading="lazy"
          />
        </Link>

        {/* 喜欢按钮：与导航链接平级（不在 <a> 内），hover 淡入（已喜欢常显），玻璃药丸取代描边框 */}
        <button
          type="button"
          onClick={() => void toggleFavorite(item.path)}
          title={favorited ? '取消喜欢' : '喜欢'}
          aria-label={favorited ? '取消喜欢' : '喜欢'}
          className={`absolute left-3 top-3 grid size-9 place-items-center rounded-full bg-scrim/80 backdrop-blur-glass transition-all duration-200 hover:bg-background/90 z-10 ${favorited ? 'text-primary opacity-100' : 'text-foreground opacity-0 group-hover:opacity-100'}`}
        >
          <Heart className={`size-4 ${favorited ? 'fill-current' : ''}`} aria-hidden />
        </button>
      </div>
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

      {/* 瀑布流作品展示：round-robin 分列保证「行优先」阅读序——首横排从左到右就是排名前列
       *（CSS columns 是列优先，会把高分作品竖着塞进左栏；故改 JS 轮转分列 + flex 竖向堆叠）。 */}
      {state.kind === 'success' && state.items.length > 0 && (
        <div className="flex items-start gap-6">
          {distributeColumns(state.items, colCount).map((col, ci) => (
            <div key={ci} className="flex min-w-0 flex-1 flex-col gap-6">
              {col.map((item) => (
                <GalleryCard key={item.path} item={item} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 轮转分列：item i → 第 i%n 列。读首行即 items[0..n-1]（排名前列），列内再竖向堆叠保留瀑布流。 */
function distributeColumns(items: GalleryItem[], n: number): GalleryItem[][] {
  const cols: GalleryItem[][] = Array.from({ length: n }, () => []);
  items.forEach((item, i) => cols[i % n].push(item));
  return cols;
}

/** 响应式列数，对齐原 columns-* 断点（sm640=3 / lg1024=4 / 2xl1536=5，base=2）。 */
function columnCountForWidth(w: number): number {
  if (w >= 1536) return 5;
  if (w >= 1024) return 4;
  if (w >= 640) return 3;
  return 2;
}

function useColumnCount(): number {
  const [n, setN] = useState(() =>
    typeof window === 'undefined' ? 4 : columnCountForWidth(window.innerWidth),
  );
  useEffect(() => {
    const onResize = () => setN(columnCountForWidth(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return n;
}

/** 资产槽中文名，用于卡片导航链接的无障碍名（屏幕阅读器读出图片通向哪类资产）。 */
const SLOT_LABEL: Record<GalleryItem['asset_slot'], string> = {
  portrait: '立绘',
  promo: '美宣',
  turnaround: '三视图',
};

function galleryItemHref(item: GalleryItem): string {
  if (!item.job_id) {
    return `/character/${item.character_id}/${item.asset_slot}`;
  }
  return `/character/${item.character_id}/${item.asset_slot}/${item.job_id}/${encodeURIComponent(item.path)}`;
}
