import { useCallback, useEffect, useRef, useState } from 'react';
import { historyKey, listHistory, type HistoryItem, type HistoryKind } from '@/api/history';
import { errorText } from '@/lib/errorText';

/** 一页列表属于哪一个筛选（类型 + 搜索词）。 */
const filterKey = (kind: string, query: string) => `${kind}\n${query}`;

/** Each filter has its own cursor and cancellation scope. Scroll and select-all share pending reads. */
export function useHistoryPages(kind: HistoryKind | 'all', query: string) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const state = useRef({ controller: new AbortController(), filter: filterKey(kind, query), rows: [] as HistoryItem[],
    removed: new Set<string>(), cursor: undefined as string | null | undefined, pending: null as Promise<void> | null,
    head: { running: false, again: false } });

  const more = useCallback(async (all = false) => {
    const page = state.current;
    // 旧筛选的回调（筛选刚换、reload 还没跑）不往新列表里写。
    if (page.filter !== filterKey(kind, query)) return [];
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
    const page = { controller: new AbortController(), filter: filterKey(kind, query), rows: [], removed: new Set<string>(),
      cursor: undefined, pending: null, head: { running: false, again: false } };
    state.current = page;
    void more().catch(() => {});
  }, [more, kind, query]);
  useEffect(() => {
    reload();
    return () => state.current.controller.abort();
  }, [reload]);

  /** 有任务出了结果：只重取第一页，按 historyKey 合并进已载入的行（新的放最前），已翻过的页与游标都留着。
   *  SSE 重连不走这里（断线期间完成的旧任务可能落在任何一页），由调用方整表 reload。
   *  回调绑定发起时的那一页（筛选代号）：筛选换了、或这一页已被 reload 换掉，结果直接丢弃，
   *  不会把旧筛选的行写进新列表。同一页同时只跑一轮，期间的事件跑完再补一轮。 */
  const refreshHead = useCallback(() => {
    const page = state.current;
    if (page.filter !== filterKey(kind, query)) return;
    if (page.head.running) { page.head.again = true; return; }
    page.head.running = true;
    const run = (): Promise<void> => listHistory(kind, query, undefined, page.controller.signal).then(result => {
      if (page.controller.signal.aborted || state.current !== page) return;
      const head = result.items.filter(row => !page.removed.has(historyKey(row)));
      const fresh = new Set(head.map(historyKey));
      page.rows = [...head, ...page.rows.filter(row => !fresh.has(historyKey(row)))];
      if (page.cursor === undefined) page.cursor = result.next_cursor;
      setItems(page.rows);
    });
    const loop = (): void => {
      void run().catch(() => { /* 下一次完成事件、重连或重开面板再取。 */ }).finally(() => {
        if (page.head.again && state.current === page && !page.controller.signal.aborted) {
          page.head.again = false;
          loop();
          return;
        }
        page.head.running = false;
        page.head.again = false;
      });
    };
    loop();
  }, [kind, query]);

  function removeOutputs(ids: Set<string>) {
    const page = state.current;
    for (const id of ids) page.removed.add(id);
    page.rows = page.rows.filter(item => !ids.has(historyKey(item)));
    setItems(page.rows);
  }
  return { items, more, reload, refreshHead, removeOutputs, loading, error, hasMore: state.current.cursor != null };
}
