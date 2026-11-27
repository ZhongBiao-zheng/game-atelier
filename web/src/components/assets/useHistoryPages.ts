import { useCallback, useEffect, useRef, useState } from 'react';
import { listHistory, type HistoryItem, type HistoryKind } from '@/api/history';

/** Each filter has its own cursor and cancellation scope. Scroll and select-all share pending reads. */
export function useHistoryPages(kind: HistoryKind | 'all', query: string) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const state = useRef({ controller: new AbortController(), rows: [] as HistoryItem[],
    cursor: undefined as string | null | undefined, pending: null as Promise<void> | null });

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
          page.rows = [...page.rows, ...result.items];
          setItems(page.rows);
        }).catch((err: Error) => {
          if (!page.controller.signal.aborted) setError(err.message);
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

  useEffect(() => {
    const page = { controller: new AbortController(), rows: [], cursor: undefined, pending: null };
    state.current = page;
    void more().catch(() => {});
    return () => page.controller.abort();
  }, [more]);

  function removeJobs(ids: Set<string>) {
    const page = state.current;
    page.rows = page.rows.filter(item => !ids.has(item.job_id));
    setItems(page.rows);
  }
  return { items, more, removeJobs, loading, error, hasMore: state.current.cursor != null };
}
