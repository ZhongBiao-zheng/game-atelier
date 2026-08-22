import { useCallback, useEffect, useState } from 'react';

import { fetchGalleryHidden, isGalleryHidden, setGalleryHidden } from '@/api/gallery';

/** 角色图库、创作台与工坊共用同一隐藏 sidecar，避免各页面产生冲突的展示状态。 */
export function useGalleryHidden() {
  const [hiddenPaths, setHiddenPaths] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [updatingPath, setUpdatingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGalleryHidden()
      .then((paths) => {
        setHiddenPaths(paths);
        setLoaded(true);
      })
      .catch(() => setError('读取项目画廊展示状态失败，请稍后再试。'));
  }, []);

  const toggleHidden = useCallback(
    async (path: string) => {
      const next = !isGalleryHidden(path, hiddenPaths);
      setUpdatingPath(path);
      setError(null);
      try {
        setHiddenPaths(await setGalleryHidden(path, next));
      } catch {
        setError('更新项目画廊展示状态失败，请稍后再试。');
      } finally {
        setUpdatingPath(null);
      }
    },
    [hiddenPaths],
  );

  const isHidden = useCallback((path: string) => isGalleryHidden(path, hiddenPaths), [hiddenPaths]);

  return { hiddenPaths, loaded, updatingPath, error, toggleHidden, isHidden };
}
