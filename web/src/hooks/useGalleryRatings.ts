import { useCallback, useEffect, useState } from 'react';

import { fetchGalleryRatings, getGalleryRating, setGalleryRating } from '@/api/gallery';

/** 评分态集中管理：挂载拉取 + 乐观写 + getRating 判定。 */
export function useGalleryRatings() {
  const [ratings, setRatings] = useState<Record<string, number>>({});

  useEffect(() => {
    fetchGalleryRatings().then(setRatings).catch(() => {});
  }, []);

  const setRating = useCallback(async (path: string, rating: number) => {
    try {
      setRatings(await setGalleryRating(path, rating));
    } catch {
      /* 网络抖动静默吞掉，下次拉取自愈 */
    }
  }, []);

  const getRating = useCallback((path: string) => getGalleryRating(path, ratings), [ratings]);

  return { ratings, setRating, getRating };
}
