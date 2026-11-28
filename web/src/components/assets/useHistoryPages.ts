import { useCallback, useEffect, useRef, useState } from 'react';
import { historyKey, listHistory, type HistoryItem, type HistoryKind } from '@/api/history';
import { errorText } from '@/lib/errorText';

/** Each filter has its own cursor and cancellation scope. Scroll and select-all share pending reads. */
export function useHistoryPages(kind: HistoryKind | 'all', query: string) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const state = useRef({ controller: new AbortController(), rows: [] as HistoryItem[],
    removed: new Set<string>(), cursor: undefined as string | null | undefined, pending: null as Promise<void> | null });

  const more = useCallback(async (all = false) => {
    const page = state.current;
    do {
      if (page.cursor === null || page.controller.signal.aborted) break;
      if (!page.pending) {
        setLoading(true);
        setError('');
        page.pending = listHistory(kind, query, page.cursor, page.controller.signal).then(result => {
          if (page.controller.signal.aborted) return;
          page.cursor = result.next_cursor;
          // 顶部插进过新结果时，下一页可能和已载入的行重叠：按 historyKey 去重。
          const loaded = new Set(page.rows.map(historyKey));
          page.rows = [...page.rows, ...result.items.filter(row => !page.removed.has(historyKey(row)) && !loaded.has(historyKey(row)))];
          setItems(page.rows);
        }).catch((err: Error) => {
          if (!page.controller.signal.aborted) {
            if (page.cursor === undefined) setItems([]);
            setError(errorText(err));
          }
          throw err;
        }).finally(() => {
          page.pending = null;
          if (!page.controller.signal.aborted) setLoading(false);
        });
      }
      await page.pending;
    } while (all);
    return page.controller.signal.aborted ? [] : page.rows;
  }, [kind, query]);

  const reload = useCallback(() => {
    state.current.controller.abort();
    const page = { controller: new AbortController(), rows: [], removed: new Set<string>(), cursor: undefined, pending: null };
    state.current = page;
    void more().catch(() => {});
  }, [more]);
  useEffect(() => {
    reload();
    return () => state.current.controller.abort();
  }, [reload]);

  /** 有任务出了结果：只重取第一页，按 historyKey 合并进已载入的行（新的放最前），已翻过的页与游标都留着。 */
  const refreshHead = useCallback(() => {
    const page = state.current;
    void listHistory(kind, query, undefined, page.controller.signal).then(result => {
      if (page.controller.signal.aborted || state.current !== page) return;
      const head = result.items.filter(row => !page.removed.has(historyKey(row)));
      const fresh = new Set(head.map(historyKey));
      page.rows = [...head, ...page.rows.filter(row => !fresh.has(historyKey(row)))];
      if (page.cursor === undefined) page.cursor = result.next_cursor;
      setItems(page.rows);
    }).catch(() => { /* 下一次完成事件或重开面板再取。 */ });
  }, [kind, query]);

  function removeOutputs(ids: Set<string>) {
    const page = state.current;
    for (const id of ids) page.removed.add(id);
    page.rows = page.rows.filter(item => !ids.has(historyKey(item)));
    setItems(page.rows);
  }
  return { items, more, reload, refreshHead, removeOutputs, loading, error, hasMore: state.current.cursor != null };
}
