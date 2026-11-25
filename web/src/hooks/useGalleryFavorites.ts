import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchGalleryFavorites, isGalleryFavorited, setGalleryFavorite } from '@/api/gallery';

/** 收藏态集中管理：挂载拉取 + 乐观 toggle + isFavorited 判定。多个用图组件复用，免各自重复。 */
export function useGalleryFavorites() {
  const [favorites, setFavorites] = useState<string[]>([]);
  const latest = useRef(favorites);
  latest.current = favorites;

  useEffect(() => {
    fetchGalleryFavorites().then(setFavorites).catch(() => {});
  }, []);

  // 乐观更新：点下去心形立刻换态，请求失败只回滚这一张，不动期间别处的改动。
  // 读最新清单走 ref，toggleFavorite 身份稳定，作品卡的 memo 不会因为喜欢别的图而失效。
  const toggleFavorite = useCallback(async (path: string) => {
    const matches = (entry: string) => isGalleryFavorited(path, [entry]);
    const removed = latest.current.filter(matches);
    const next = removed.length === 0;
    setFavorites(current => (next ? [...current, path] : current.filter(entry => !matches(entry))));
    try {
      setFavorites(await setGalleryFavorite(path, next));
    } catch {
      setFavorites(current => (next ? current.filter(entry => entry !== path) : [...current, ...removed]));
    }
  }, []);

  const isFavorited = useCallback((path: string) => isGalleryFavorited(path, favorites), [favorites]);

  return { favorites, toggleFavorite, isFavorited };
}
