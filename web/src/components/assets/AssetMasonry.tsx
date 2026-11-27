import { useCallback, useRef, useState, type ReactNode } from 'react';

export interface MediaSize { width: number; height: number; duration?: number }

export function mediaRatio(size?: { width?: number | null; height?: number | null }): number {
  const { width, height } = size ?? {};
  return width && height && width > 0 && height > 0 && Number.isFinite(width / height) ? width / height : 1;
}

type Column = 0 | 1;

/** 同宽两列：累计高宽比，下一项放入当前较短的一列。placed 给出已摆好的项所在列，这些项不再挪动。 */
export function masonryColumns<T>(items: T[], ratio: (item: T) => number, placed?: (item: T) => Column | undefined): [T[], T[]] {
  const columns: [T[], T[]] = [[], []];
  const heights = [0, 0];
  for (const item of items) {
    const column = placed?.(item) ?? (heights[0] <= heights[1] ? 0 : 1);
    const value = ratio(item);
    columns[column].push(item);
    heights[column] += value > 0 && Number.isFinite(value) ? 1 / value : 1;
  }
  return columns;
}

/** 已摆好的卡片留在原列：尺寸后到、往后追加都不换列，只有列表本身变了（筛选、删除、插到前面）才整体重排。
 *  跨列移动在 React 里必然重挂，所以重排只发生在内容本来就整体换掉的时候。 */
function useStableColumns<T>(items: T[], itemKey: (item: T) => string, ratio: (item: T) => number): [T[], T[]] {
  const placement = useRef<{ keys: string[]; columns: Map<string, Column> }>({ keys: [], columns: new Map() });
  const keys = items.map(itemKey);
  const previous = placement.current;
  const appended = previous.keys.length <= keys.length && previous.keys.every((key, index) => keys[index] === key);
  const kept = appended ? previous.columns : new Map<string, Column>();
  const columns = masonryColumns(items, ratio, item => kept.get(itemKey(item)));
  // 同样的输入算出同样的结果，渲染期写入可重入（StrictMode 双渲染不会摆出两种布局）。
  const next = new Map<string, Column>();
  columns.forEach((column, index) => column.forEach(item => next.set(itemKey(item), index as Column)));
  placement.current = { keys, columns: next };
  return columns;
}

export function AssetMasonry<T>({ items, itemKey, ratio, children, compact = false }: {
  compact?: boolean;
  items: T[];
  itemKey: (item: T) => string;
  ratio: (item: T) => number;
  children: (item: T) => ReactNode;
}) {
  const [left, right] = useStableColumns(items, itemKey, ratio);
  return <div className={compact ? 'grid grid-cols-2 items-start gap-1' : 'grid grid-cols-2 items-start gap-2'}>
    <div className={compact ? 'min-w-0 space-y-1' : 'min-w-0 space-y-2'}>
      {left.map(item => <div key={itemKey(item)}>{children(item)}</div>)}
    </div>
    <div className={compact ? 'min-w-0 space-y-1' : 'min-w-0 space-y-2'}>
      {right.map(item => <div key={itemKey(item)}>{children(item)}</div>)}
    </div>
  </div>;
}

export function useMediaSizes() {
  const [sizes, setSizes] = useState<Record<string, MediaSize>>({});
  const measure = useCallback((key: string, size: MediaSize) => {
    setSizes(current => {
      const previous = current[key];
      if (previous?.width === size.width && previous.height === size.height && previous.duration === size.duration) return current;
      return { ...current, [key]: size };
    });
  }, []);
  return { sizes, measure };
}
