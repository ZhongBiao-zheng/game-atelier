import { useCallback, useState, type ReactNode } from 'react';

export interface MediaSize { width: number; height: number; duration?: number }

export function mediaRatio(size?: { width?: number | null; height?: number | null }): number {
  const { width, height } = size ?? {};
  return width && height && width > 0 && height > 0 && Number.isFinite(width / height) ? width / height : 1;
}

/** 同宽两列：累计高宽比，下一项放入当前较短的一列。 */
export function masonryColumns<T>(items: T[], ratio: (item: T) => number): [T[], T[]] {
  const columns: [T[], T[]] = [[], []];
  const heights = [0, 0];
  for (const item of items) {
    const column = heights[0] <= heights[1] ? 0 : 1;
    const value = ratio(item);
    columns[column].push(item);
    heights[column] += value > 0 && Number.isFinite(value) ? 1 / value : 1;
  }
  return columns;
}

export function AssetMasonry<T>({ items, itemKey, ratio, children }: {
  items: T[];
  itemKey: (item: T) => string;
  ratio: (item: T) => number;
  children: (item: T) => ReactNode;
}) {
  return <div className="grid grid-cols-2 items-start gap-2">
    {masonryColumns(items, ratio).map((column, index) => <div key={index} className="min-w-0 space-y-2">
      {column.map(item => <div key={itemKey(item)}>{children(item)}</div>)}
    </div>)}
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
