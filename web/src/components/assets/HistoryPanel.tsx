import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { deleteHistoryOutputs, HISTORY_CHANGED, HISTORY_JOB_FINISHED, downloadHistory, historyKey, type HistoryItem, type HistoryReference } from '@/api/history';
import { request } from '@/api/http';
import { restoreTrash } from '@/api/trash';
import { useRetained } from '@/components/ui/retained';
import { Lightbox } from '@/components/Lightbox';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { CloseIcon, LoadingIcon, RetryIcon, SearchIcon } from '@/components/ui/icons';
import { Hint } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorText } from '@/lib/errorText';
import { MOTION_DURATION, MOTION_EASE, prefersReducedMotion } from '@/lib/motion';
import { notify } from '@/lib/notify';
import { loadUiPrefs, saveUiPref } from '@/lib/uiPrefs';
import { AssetMasonry } from './AssetMasonry';
import { HistoryCard, historyActions, historyRatio, type HistoryAction } from './HistoryCard';
import { readTeamMedia } from './teamAssetUse';
import { useHistoryPages } from './useHistoryPages';

const labels = { all: '全部', image: '图片', video: '视频', audio: '音频', text: '文本' };
type Kind = keyof typeof labels;
type Position = { kind: Kind; q: string; top: number };
type Reference = (items: HistoryReference[]) => Promise<void>;
const positionKey = 'asset-panel-position';
let lastWrite = Promise.resolve();

export function dayLabel(value: string, now = new Date()) {
  const date = new Date(value);
  if (date.toDateString() === now.toDateString()) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日`;
}

export function HistoryPanel({ onReference }: { onReference: Reference }) {
  const [position, setPosition] = useState<Position | null>(null);
  const [search, setSearch] = useState(false);
  const [draft, setDraft] = useState('');
  const [composing, setComposing] = useState(false);
  const latest = useRef<Position | null>(null);
  const dirty = useRef(false);
  useEffect(() => {
    let active = true;
    void lastWrite.then(loadUiPrefs).then(prefs => {
      if (!active) return;
      const saved = prefs?.[positionKey] as Partial<Position> | null;
      const value = { kind: saved?.kind && Object.hasOwn(labels, saved.kind) ? saved.kind : 'all' as const,
        q: typeof saved?.q === 'string' ? saved.q : '', top: Math.max(0, Number(saved?.top) || 0) };
      latest.current = value;
      setPosition(value);
      setSearch(Boolean(value.q));
      setDraft(value.q);
    });
    return () => {
      active = false;
      const saved = latest.current;
      if (dirty.current && saved) lastWrite = lastWrite.then(() => saveUiPref(positionKey, saved));
    };
  }, []);
  function update(kind: Kind, q: string) {
    dirty.current = true;
    latest.current = { kind, q, top: 0 };
    setPosition(latest.current);
  }
  useEffect(() => {
    if (!position || composing || draft === position.q) return;
    const timer = window.setTimeout(() => update(position.kind, draft), 250);
    return () => window.clearTimeout(timer);
  }, [draft, position, composing]);
  function closeSearch() {
    setSearch(false);
    setDraft('');
    setComposing(false);
    if (position?.q) update(position.kind, '');
  }
  if (!position) return null;
  return <>
    <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
      <Select value={position.kind} onValueChange={value => update(value as Kind, position.q)}>
        <SelectTrigger aria-label="类型" className="w-auto gap-2 pl-0 border-transparent bg-transparent"><SelectValue /></SelectTrigger>
        <SelectContent>{Object.entries(labels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
      </Select>
      {search && <Input autoFocus aria-label="按提示词搜索" placeholder="按提示词搜索" value={draft}
        onCompositionStart={() => setComposing(true)} onCompositionEnd={event => { setDraft(event.currentTarget.value); setComposing(false); }}
        className="h-8 min-w-0 flex-1" onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
          event.preventDefault(); event.stopPropagation(); closeSearch();
        }} />}
      <Button variant="ghost" size="icon" aria-label={search ? '关闭搜索' : '搜索'} className="size-8 shrink-0"
        onClick={() => { if (search) closeSearch(); else setSearch(true); }}>
        {search ? <CloseIcon /> : <SearchIcon />}
      </Button>
    </div>
    <HistoryList position={position} onReference={onReference}
      onScrollTop={top => { dirty.current = true; latest.current = { ...position, top }; }} />
  </>;
}

function HistoryList({ position, onReference, onScrollTop }: {
  position: Position; onReference: Reference; onScrollTop: (top: number) => void;
}) {
  const { items, more, reload, removeOutputs, loading, error, hasMore } = useHistoryPages(position.kind, position.q);
  const [selection, setSelection] = useState(new Set<string>());
  const [preview, setPreview] = useState<HistoryItem | null>(null);
  const [previewRect, setPreviewRect] = useState<DOMRect | null>(null);
  const [text, setText] = useState('');
  const shownPreview = useRetained(preview?.kind === 'image' ? null : preview);
  const [removing, setRemoving] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);
  const anchor = useRef<string>();
  const list = useRef<HTMLDivElement>(null);
  const restore = useRef(position.top);
  const selectRequest = useRef(0);
  // 任务出结果后刷新：比刷新前最新一条还新的卡片在顶部淡入；首屏与翻页加载的不播。
  const arrivedAfter = useRef(Infinity);
  const latestItems = useRef(items);
  latestItems.current = items;
  // 撤销删除后回到原位的卡片：描边约 1.5 秒，不在可见区时滚过去。
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set());
  const revealedRestore = useRef(false);
  const selected = items.filter(item => selection.has(historyKey(item)));
  const groups = useMemo(() => {
    const days = new Map<string, HistoryItem[]>();
    for (const item of items) {
      const label = dayLabel(item.submitted_at);
      if (!days.has(label)) days.set(label, []);
      days.get(label)!.push(item);
    }
    return Array.from(days);
  }, [items]);

  useEffect(() => {
    clear();
    restore.current = position.top;
    if (list.current) list.current.scrollTop = 0;
  }, [position]);

  useEffect(() => {
    const refresh = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === list) return;
      restore.current = list.current?.scrollTop ?? 0;
      clear();
      reload();
    };
    // 新结果只追加在顶部：不清选择，滚动位置照旧。
    const arrive = () => {
      arrivedAfter.current = latestItems.current.reduce((newest, item) => Math.max(newest, Date.parse(item.submitted_at) || 0), 0);
      restore.current = list.current?.scrollTop ?? 0;
      reload();
    };
    window.addEventListener(HISTORY_CHANGED, refresh);
    window.addEventListener(HISTORY_JOB_FINISHED, arrive);
    return () => {
      window.removeEventListener(HISTORY_CHANGED, refresh);
      window.removeEventListener(HISTORY_JOB_FINISHED, arrive);
    };
  }, [reload]);

  useEffect(() => {
    if (!restored.size || revealedRestore.current) return;
    const first = items.find(item => restored.has(historyKey(item)));
    if (!first) return;
    revealedRestore.current = true;
    list.current?.querySelector(`[data-history-key="${CSS.escape(historyKey(first))}"]`)?.scrollIntoView({ block: 'nearest' });
    const timer = window.setTimeout(() => setRestored(new Set()), 1500);
    return () => window.clearTimeout(timer);
  }, [items, restored]);

  useLayoutEffect(() => {
    const el = list.current;
    if (!el || loading || error || !el.clientHeight) return;
    if (restore.current) {
      el.scrollTop = restore.current;
      if (hasMore && el.scrollTop + 1 < restore.current) { void more().catch(() => {}); return; }
      restore.current = 0;
    }
    if (hasMore && el.scrollHeight <= el.clientHeight) void more().catch(() => {});
  }, [items, loading, error, hasMore, more]);
  useEffect(() => {
    if (preview?.kind !== 'text') return;
    const controller = new AbortController();
    setText(preview.text_preview ?? '');
    void request(preview.url, '读取文本', { signal: controller.signal }).then(r => r.text()).then(value => {
      if (!controller.signal.aborted) setText(value);
    }).catch(err => { if (!controller.signal.aborted) notify.error(errorText(err)); });
    return () => controller.abort();
  }, [preview]);

  function clear() {
    selectRequest.current++;
    anchor.current = undefined;
    setSelection(new Set());
  }
  useEffect(() => {
    if (!selection.size) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault(); event.stopPropagation(); clear();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [selection.size, busy]);

  function toggle(item: HistoryItem, range: boolean) {
    if (busy) return;
    selectRequest.current++;
    const key = historyKey(item);
    const start = items.findIndex(row => historyKey(row) === anchor.current);
    const end = items.indexOf(item);
    setSelection(current => {
      const next = new Set(current);
      if (range && start >= 0) {
        for (const row of items.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(historyKey(row));
      } else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!range || start < 0) anchor.current = key;
    list.current?.focus({ preventScroll: true });
  }

  async function action(key: HistoryAction, rows: HistoryItem[]) {
    if (busy || !rows.length) return;
    setBusy(true);
    try {
      if (key === 'delete') { await remove(rows); return; }
      if (key === 'download') await downloadHistory(rows);
      else {
        await onReference(rows.map(row => ({
          kind: row.kind, read: () => readTeamMedia(row.url, { title: row.filename, mime_type: null }),
        })));
      }
      clear();
    } catch (err) { notify.error(errorText(err)); }
    finally { setBusy(false); }
  }
  async function remove(rows: HistoryItem[]) {
    const jobs = new Map<string, number[]>();
    for (const row of rows) {
      if (!jobs.has(row.job_id)) jobs.set(row.job_id, []);
      jobs.get(row.job_id)!.push(row.output_index);
    }
    const trashIds: string[] = [];
    const done = new Set<string>();
    try {
      for (const [id, slots] of jobs) {
        const result = await deleteHistoryOutputs(id, slots);
        trashIds.push(result.trash_id);
        for (const slot of slots) done.add(`${id}/${slot}`);
      }
    } catch (err) { notify.error(errorText(err)); }
    if (!done.size) return;
    setRemoving(done);
    await new Promise(resolve => setTimeout(resolve, MOTION_DURATION.slow * 1000));
    removeOutputs(done);
    setSelection(current => new Set([...current].filter(key => !done.has(key))));
    setRemoving(new Set());
    window.dispatchEvent(new CustomEvent(HISTORY_CHANGED, { detail: list }));
    notify.undo(`已删除 ${done.size} 项`, () => {
      void Promise.allSettled(trashIds.map(id => restoreTrash(id))).then(results => {
        if (results.some(result => result.status === 'fulfilled')) {
          revealedRestore.current = false;
          setRestored(new Set(done));
        }
        window.dispatchEvent(new Event(HISTORY_CHANGED));
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') notify.error(errorText(failure.reason));
      });
    });
  }

  return <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={list} tabIndex={0} role="region" aria-label="生成历史" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-16 rounded-b-xl outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      onScroll={event => {
        const el = event.currentTarget;
        if (!restore.current) onScrollTop(el.scrollTop);
        if (!error && hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 180) void more().catch(() => {});
      }}
      onKeyDown={event => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'a' || busy) return;
        event.preventDefault(); event.stopPropagation();
        const id = ++selectRequest.current;
        void more(true).then(rows => { if (id === selectRequest.current) setSelection(new Set(rows.map(historyKey))); }).catch(() => {});
      }}>
      {groups.map(([label, rows]) => <section key={label}>
        <h3 className="sticky top-0 z-10 bg-panel py-2 text-xs font-normal text-muted-foreground">{label}</h3>
        <AssetMasonry compact items={rows} itemKey={historyKey} ratio={historyRatio}>{row =>
          <HistoryCard item={row} selecting={selection.size > 0} checked={selection.has(historyKey(row))} busy={busy}
            removing={removing.has(historyKey(row))} onToggle={range => toggle(row, range)}
            arrived={Date.parse(row.submitted_at) > arrivedAfter.current} highlighted={restored.has(historyKey(row))}
            onPreview={rect => { setPreviewRect(rect); setPreview(row); }} onAction={key => void action(key, [row])} />
        }</AssetMasonry>
      </section>)}
      {loading && <LoadingIcon aria-label="加载中" className="delayed-reveal mx-auto my-4 animate-spin text-muted-foreground" />}
      {error && <div role="alert" className="p-3 text-sm">{error}<Button variant="ghost" size="icon" aria-label="重试" onClick={() => void more().catch(() => {})}><RetryIcon /></Button></div>}
      {!loading && !error && !items.length && <p className="py-8 text-center text-sm text-muted-foreground">{position.kind !== 'all' || position.q.trim() ? '没有匹配的记录' : '还没有生成记录'}</p>}
    </div>
    <AnimatePresence>{selection.size > 0 && <motion.div
      className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center"
      initial={{ opacity: 0, y: prefersReducedMotion() ? 0 : 8 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: prefersReducedMotion() ? 0 : 8, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } }} transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE.out }}>
      <div role="toolbar" aria-label="多选操作" className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border bg-popover px-2 py-1 shell-glow">
        <span className="px-2 text-xs tabular-nums">已选 {selection.size} 项</span>
        {historyActions.map(({ key, label, Icon }) => <Hint key={key} label={label}><Button variant="ghost" size="icon" className="size-8 rounded-full"
          disabled={busy} aria-label={label} onClick={() => void action(key, selected)}><Icon /></Button></Hint>)}
        <Button variant="ghost" size="icon" className="size-8 rounded-full" aria-label="退出多选" disabled={busy} onClick={clear}><CloseIcon /></Button>
      </div>
    </motion.div>}</AnimatePresence>
    {preview?.kind === 'image' && <HistoryLightbox item={preview} items={items} sourceRect={previewRect}
      onNavigate={row => { setPreviewRect(null); setPreview(row); }} onClose={() => setPreview(null)}
      onReference={row => void action('reference', [row])} onDelete={row => void action('delete', [row])} />}
    {shownPreview && <Dialog open={Boolean(preview && preview.kind !== 'image')} onOpenChange={open => { if (!open) setPreview(null); }}><DialogContent>
      <DialogTitle>{shownPreview.filename}</DialogTitle>
      {shownPreview.kind === 'video' ? <video controls autoPlay playsInline src={shownPreview.url} className="max-h-[70vh] w-full" />
        : shownPreview.kind === 'audio' ? <audio controls src={shownPreview.url} className="w-full" />
        : <pre className="max-h-[65vh] overflow-y-auto whitespace-pre-wrap font-sans text-sm">{text}</pre>}
    </DialogContent></Dialog>}
  </div>;
}

/** 历史里的大图：只在图片之间翻页，带「用作参考」「删除」，从被点的卡片飞入。 */
function HistoryLightbox({ item, items, sourceRect, onNavigate, onClose, onReference, onDelete }: {
  item: HistoryItem; items: HistoryItem[]; sourceRect: DOMRect | null;
  onNavigate: (item: HistoryItem) => void; onClose: () => void;
  onReference: (item: HistoryItem) => void; onDelete: (item: HistoryItem) => void;
}) {
  const images = items.filter(row => row.kind === 'image');
  const index = images.findIndex(row => historyKey(row) === historyKey(item));
  const previous = index > 0 ? images[index - 1] : undefined;
  const next = index >= 0 ? images[index + 1] : undefined;
  return <Lightbox src={item.url} sourceRect={sourceRect} meta={{ prompt: item.prompt }} downloadName={item.filename}
    preloadSrcs={[previous, next].flatMap(row => row ? [row.url] : [])}
    onPrevious={previous ? () => onNavigate(previous) : undefined}
    onNext={next ? () => onNavigate(next) : undefined}
    onUseAsReference={() => onReference(item)}
    onDelete={() => onDelete(item)}
    onClose={onClose} />;
}
