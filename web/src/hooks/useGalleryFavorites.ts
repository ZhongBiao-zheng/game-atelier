import { useCallback, useEffect, useState } from 'react';

import { fetchGalleryFavorites, isGalleryFavorited, setGalleryFavorite } from '@/api/gallery';

/** 收藏态集中管理：挂载拉取 + 乐观 toggle + isFavorited 判定。多个用图组件复用，免各自重复。 */
export function useGalleryFavorites() {
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    fetchGalleryFavorites().then(setFavorites).catch(() => {});
  }, []);

  const toggleFavorite = useCallback(
    async (path: string) => {
      const next = !isGalleryFavorited(path, favorites);
      try {
        setFavorites(await setGalleryFavorite(path, next));
      } catch {
        /* 网络抖动静默吞掉，下次拉取自愈 */
      }
    },
    [favorites],
  );

  const isFavorited = useCallback((path: string) => isGalleryFavorited(path, favorites), [favorites]);

  return { favorites, toggleFavorite, isFavorited };
}
