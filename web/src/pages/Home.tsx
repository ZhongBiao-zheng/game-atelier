import { memo, useEffect, useState } from 'react';
import { Link } from 'wouter';
import { FavoriteIcon } from '@/components/ui/icons';
import { RevealImage } from '@/components/ui/reveal-image';
import { SwapIcon } from '@/components/ui/swap-icon';

import { fetchGalleryRecent, type GalleryItem } from '@/api/gallery';
import { useGalleryFavorites } from '@/hooks/useGalleryFavorites';
import { HomeDottedBackground } from '@/components/HomeDottedBackground';
import { Studio } from './Studio';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

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

  return (
    <div className="relative isolate px-8 pb-12" aria-label="作品集首页">
      {/* 波点铺满整页（含作品墙），垫在所有内容下面 */}
      <HomeDottedBackground className="-z-10" />

      {/* ========== Studio 区域 ========== */}
      <section className="relative min-h-[520px] flex items-center justify-center">
        <div className="relative z-10 w-full">
          <Studio compact />
        </div>
      </section>

      {/* 作品展示标题 */}
      <h2 className="mb-5 text-base font-medium text-foreground">作品展示</h2>

      {/* Loading 状态 */}
      {state.kind === 'loading' && (
        <div className="flex items-start gap-6">
          {distributeColumns(SKELETON_HEIGHTS, colCount).map((col, ci) => (
            <div key={ci} className="flex min-w-0 flex-1 flex-col gap-6">
              {col.map((height, i) => (
                <div key={i} data-skeleton className="rounded-xl bg-card/40" style={{ height }} />
              ))}
            </div>
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
          <p className="text-sm text-muted-foreground">还没有作品</p>
        </div>
      )}

      {/* 瀑布流作品展示：round-robin 分列保证「行优先」阅读序——首横排从左到右就是排名前列
       *（CSS columns 是列优先，会把高分作品竖着塞进左栏；故改 JS 轮转分列 + flex 竖向堆叠）。 */}
      {state.kind === 'success' && state.items.length > 0 && (
        <div className="flex items-start gap-6">
          {distributeColumns(state.items, colCount).map((col, ci) => (
            <div key={ci} className="flex min-w-0 flex-1 flex-col gap-6">
              {col.map((item) => (
                <GalleryCard
                  key={item.path}
                  item={item}
                  favorited={isFavorited(item.path)}
                  onToggleFavorite={toggleFavorite}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 骨架高度：与作品墙同一套轮转分列、同圆角，载入后各列不换位。 */
const SKELETON_HEIGHTS = Array.from({ length: 6 }, (_, i) => 200 + (i % 3) * 80);

/** 作品卡。必须是模块顶层组件：在 Home 里用 useCallback 造组件，喜欢一变组件身份就变，整面墙卸载重挂。
 *  接口还不给宽高：载入前先按方形占位，拿到原图尺寸后换成真实比例，图片解码完再淡入。 */
const GalleryCard = memo(function GalleryCard({ item, favorited, onToggleFavorite }: {
  item: GalleryItem;
  favorited: boolean;
  onToggleFavorite: (path: string) => void;
}) {
  const [measured, setMeasured] = useState(false);
  return (
    // 卡片容器本身非交互：导航链接与喜欢按钮作两个平级交互元素，
    // 不再用 <a> 套 <button>（非法嵌套交互），喜欢点击也无需 stopPropagation 兜底。
    <div
      className={`media-edge group overflow-hidden rounded-xl ${measured ? '' : 'aspect-square bg-card/40'}`}
    >
      {/* Pinterest 式瀑布流：图片直出、无放大，只留内侧发丝边，hover 淡入操作按钮 */}
      <Link
        href={galleryItemHref(item)}
        aria-label={galleryItemAriaLabel(item)}
        className="block"
      >
        <RevealImage
          src={`/api/gallery/image?path=${encodeURIComponent(item.path)}`}
          alt=""
          className="media-checker w-full block"
          loading="lazy"
          onLoad={() => setMeasured(true)}
          onError={() => setMeasured(true)}
        />
      </Link>

      {/* 喜欢按钮：与导航链接平级（不在 <a> 内），hover 淡入（已喜欢常显）；不透明底，不给每张卡叠毛玻璃 */}
      <Hint label={favorited ? '取消喜欢' : '喜欢'}><Button variant="bare"
        type="button"
        onClick={() => onToggleFavorite(item.path)}
        aria-label={favorited ? '取消喜欢' : '喜欢'}
        className={`absolute left-3 top-3 z-10 grid size-9 place-items-center rounded-full bg-card transition-opacity duration-150 hover:bg-secondary ${favorited ? 'text-primary opacity-100' : 'text-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'}`}
      >
        <SwapIcon swapKey={favorited} variant="pop">
          <FavoriteIcon className={favorited ? 'fill-current' : ''} aria-hidden />
        </SwapIcon>
      </Button></Hint>
    </div>
  );
});

/** 轮转分列：item i → 第 i%n 列。读首行即 items[0..n-1]（排名前列），列内再竖向堆叠保留瀑布流。 */
function distributeColumns<T>(items: T[], n: number): T[][] {
  const cols: T[][] = Array.from({ length: n }, () => []);
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


function galleryItemAriaLabel(item: GalleryItem): string {
  return item.source === 'canvas' ? '查看所在画布' : '查看出图页';
}

function galleryItemHref(item: GalleryItem): string {
  if (item.source === 'canvas') {
    return item.canvas_project_id ? `/canvas/${encodeURIComponent(item.canvas_project_id)}` : '/canvas';
  }
  return item.job_id ? `/studio?job=${encodeURIComponent(item.job_id)}` : '/studio';
}
