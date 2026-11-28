import { useCallback, useEffect, useRef, useState } from 'react';
import { historyKey, listHistory, type HistoryItem, type HistoryKind } from '@/api/history';
import { errorText } from '@/lib/errorText';

/** 重连补取最多往后翻几页去找与已载入行的重叠。 */
const HEAD_REFRESH_PAGE_LIMIT = 20;

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

  /** 有任务出了结果或 SSE 重连：从头往后翻页，补到与已载入的行重叠为止，再接回原来的游标——
   *  断线期间新增超过一页也不留缺口。新的放最前，已载入的行、已翻过的页与选中都保留。
   *  翻到 HEAD_REFRESH_PAGE_LIMIT 页仍没重叠，就改用这次取到的行和游标，原来的行之后翻页时再回来。
   *  同时只跑一轮；跑的过程中又来了事件，跑完再补一轮。 */
  const headRefresh = useRef<{ running: boolean; again: boolean }>({ running: false, again: false });
  const refreshHead = useCallback(() => {
    const gate = headRefresh.current;
    if (gate.running) { gate.again = true; return; }
    gate.running = true;
    const page = state.current;
    const run = async () => {
      const known = new Set(page.rows.map(historyKey));
      const fetched: HistoryItem[] = [];
      let cursor: string | undefined;
      let next: string | null = null;
      let overlapped = false;
      for (let count = 0; count < HEAD_REFRESH_PAGE_LIMIT; count++) {
        const result = await listHistory(kind, query, cursor, page.controller.signal);
        next = result.next_cursor;
        for (const row of result.items) {
          if (known.has(historyKey(row))) { overlapped = true; continue; }
          fetched.push(row);
        }
        // 原来一行都没有：取一页就够，游标就用这一页的。
        if (overlapped || next === null || !known.size) break;
        cursor = next;
      }
      if (page.controller.signal.aborted || state.current !== page) return;
      const head = fetched.filter(row => !page.removed.has(historyKey(row)));
      if (overlapped) {
        // 等待期间往下翻页追加的行与这批新行不会重叠，但仍按 historyKey 去重以防万一。
        const fresh = new Set(head.map(historyKey));
        page.rows = [...head, ...page.rows.filter(row => !fresh.has(historyKey(row)))];
        if (page.cursor === undefined) page.cursor = next;
      } else {
        // 没接上（原来是空的、翻到了底、或新增超过上限）：这次取到的就是从头开始的连续一段，换成它和它的游标；
        // 原来的行若还在，之后往下翻页时会再回来（追加时按 historyKey 去重）。
        page.rows = head;
        page.cursor = next;
      }
      setItems(page.rows);
    };
    void run().catch(() => { /* 下一次完成事件、重连或重开面板再取。 */ }).finally(() => {
      gate.running = false;
      if (gate.again) { gate.again = false; refreshHead(); }
    });
  }, [kind, query]);

  function removeOutputs(ids: Set<string>) {
    const page = state.current;
    for (const id of ids) page.removed.add(id);
    page.rows = page.rows.filter(item => !ids.has(historyKey(item)));
    setItems(page.rows);
  }
  return { items, more, reload, refreshHead, removeOutputs, loading, error, hasMore: state.current.cursor != null };
}
