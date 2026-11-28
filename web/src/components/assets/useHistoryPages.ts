import { useCallback, useEffect, useRef, useState } from 'react';
import { historyKey, listHistory, type HistoryItem, type HistoryKind } from '@/api/history';

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
          page.rows = [...page.rows, ...result.items.filter(row => !page.removed.has(historyKey(row)))];
          setItems(page.rows);
        }).catch((err: Error) => {
          if (!page.controller.signal.aborted) {
            if (page.cursor === undefined) setItems([]);
            setError(err.message);
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

  function removeOutputs(ids: Set<string>) {
    const page = state.current;
    for (const id of ids) page.removed.add(id);
    page.rows = page.rows.filter(item => !ids.has(historyKey(item)));
    setItems(page.rows);
  }
  return { items, more, reload, removeOutputs, loading, error, hasMore: state.current.cursor != null };
}
