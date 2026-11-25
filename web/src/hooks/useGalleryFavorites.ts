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

  // 每张图的保存串行：键在表里 = 这张图有请求在途；值 = 用户最后一次的意图（喜欢 / 取消）。
  const saving = useRef(new Map<string, boolean>());

  // 乐观更新：点下去心形立刻换态。服务端返回整份清单，但只合入这一张图的条目（确认或回滚都是），
  // 不动别的图：两张图的请求逆序回来时，先发的旧快照不会把后一张的状态盖掉。
  // 同一张图连点：在途时只记最新意图，请求回来后若意图变了再保存一次，最终落盘的是最后一次点击。
  // 读最新清单走 ref，toggleFavorite 身份稳定，作品卡的 memo 不会因为喜欢别的图而失效。
  const toggleFavorite = useCallback(async (path: string) => {
    const matches = (entry: string) => isGalleryFavorited(path, [entry]);
    const replaceEntries = (entries: string[]) =>
      setFavorites(current => [...current.filter(entry => !matches(entry)), ...entries]);
    // 在途时以最后一次意图为准取反：两次点击之间还没重渲染，ref 里的清单可能还是旧的。
    const pending = saving.current.get(path);
    const next = pending === undefined ? !latest.current.some(matches) : !pending;
    replaceEntries(next ? [path] : []);
    if (pending !== undefined) {
      saving.current.set(path, next);
      return;
    }
    // 服务端最后确认的这张图的条目（这张图没有请求在途，本地状态就是确认过的）：失败时回滚到这里。
    let confirmed = latest.current.filter(matches);
    saving.current.set(path, next);
    let intent = next;
    try {
      for (;;) {
        try {
          confirmed = (await setGalleryFavorite(path, intent)).filter(matches);
        } catch {
          replaceEntries(confirmed);
          return;
        }
        const wanted = saving.current.get(path) ?? intent;
        if (wanted === intent) {
          replaceEntries(confirmed);
          return;
        }
        intent = wanted;
      }
    } finally {
      saving.current.delete(path);
    }
  }, []);

  const isFavorited = useCallback((path: string) => isGalleryFavorited(path, favorites), [favorites]);

  return { favorites, toggleFavorite, isFavorited };
}
