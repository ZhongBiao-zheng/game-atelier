import { useCallback, useEffect, useState } from 'react';

import { fetchGalleryHidden, isGalleryHidden, setGalleryHidden } from '@/api/gallery';

/** 隐藏态集中管理：挂载拉取 + 乐观 toggle + isHidden 判定。与 useGalleryFavorites 同构。 */
export function useGalleryHidden() {
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([]);

  useEffect(() => {
    fetchGalleryHidden().then(setHiddenPaths).catch(() => {});
  }, []);

  const toggleHidden = useCallback(
    async (path: string) => {
      const next = !isGalleryHidden(path, hiddenPaths);
      try {
        setHiddenPaths(await setGalleryHidden(path, next));
      } catch {
        /* 网络抖动静默吞掉，下次拉取自愈 */
      }
    },
    [hiddenPaths],
  );

  const isHidden = useCallback((path: string) => isGalleryHidden(path, hiddenPaths), [hiddenPaths]);

  return { hiddenPaths, toggleHidden, isHidden };
}
