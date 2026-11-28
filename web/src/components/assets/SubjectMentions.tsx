import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { requestJson } from '@/api/http';
import { itemThumb, LIBRARY_CHANGED, listLibrary, subjectToken, type LibrarySubject } from '@/api/library';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export const subjectPattern = /@\[subject:(sbj_[a-f0-9]{32}):([^\]\n]*)\]/g;
export function useSubjects(active: boolean) {
  const [rows, setRows] = useState<LibrarySubject[]>([]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const refresh = () => { void listLibrary(controller.signal).then(c => { if (!controller.signal.aborted) setRows(c.subjects.map(s => s.cover_item_id && c.items[s.cover_item_id]?.kind !== 'image' ? { ...s, cover_item_id: null } : s)); }).catch(() => {}); };
    refresh(); window.addEventListener(LIBRARY_CHANGED, refresh);
    return () => { controller.abort(); window.removeEventListener(LIBRARY_CHANGED, refresh); };
  }, [active]);
  return rows;
}
export function subjectChip(token: string, rows: LibrarySubject[]) {
  const match = Array.from(token.matchAll(subjectPattern))[0];
  const row = rows.find(s => s.id === match?.[1]);
  const span = document.createElement('span');
  span.setAttribute('contenteditable', 'false');
  span.tabIndex = 0;
  span.dataset.subjectToken = token;
  span.className = 'mx-0.5 inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 align-middle text-sm text-foreground' + (row ? '' : ' line-through');
  if (row?.cover_item_id) {
    const image = document.createElement('img'); image.alt = ''; image.src = itemThumb(row.cover_item_id);
    image.className = 'size-5 rounded-sm object-cover'; span.append(image);
  }
  let name = match?.[2] || '';
  try { name = decodeURIComponent(name); } catch { /* display the saved label */ }
  span.append(document.createTextNode('@' + (row?.name || name)));
  return span;
}
export function withSubjectChips(value: string, rows: LibrarySubject[], plain: (part: string) => Node[]) {
  const nodes: Node[] = [];
  let start = 0;
  for (const match of value.matchAll(subjectPattern)) {
    nodes.push(...plain(value.slice(start, match.index)), subjectChip(match[0], rows));
    start = match.index! + match[0].length;
  }
  return [...nodes, ...plain(value.slice(start))];
}
export function MentionTabs({ value, change }: { value: string; change: (v: string) => void }) {
  return <Tabs value={value} onValueChange={change}><TabsList aria-label="引用类型">
    <TabsTrigger value="all">全部</TabsTrigger><TabsTrigger value="subjects">主体</TabsTrigger>
  </TabsList></Tabs>;
}
export function SubjectFeedback({ prompt, model, explicit, rows, mode = 'image', frameMode }: { mode?: string; frameMode?: string; prompt: string; model?: string | null; explicit: number; rows: LibrarySubject[] }) {
  const [warnings, setWarnings] = useState<string[]>([]);
  const [hover, setHover] = useState<{ row: LibrarySubject; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!prompt.includes('@[subject:')) { setWarnings([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void requestJson<{ warnings: string[] }>('/api/library/subject-preview', '读取参考数量', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ prompt, model: model || '', explicit, mode, frame_mode: frameMode }),
      }).then(result => { if (!controller.signal.aborted) setWarnings(result.warnings); })
        .catch(() => { if (!controller.signal.aborted) setWarnings([]); });
    }, 180);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [prompt, model, explicit, rows, mode, frameMode]);
  useEffect(() => {
    if (!prompt.includes('@[subject:')) return;
    const over = (e: Event) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-subject-token]') : null;
      const row = el && rows.find(s => el.dataset.subjectToken?.startsWith('@[subject:' + s.id + ':'));
      if (el && row) { const r = el.getBoundingClientRect(); setHover({ row, x: r.left, y: r.top - 6 }); } else setHover(null);
    };
    const out = (e: MouseEvent) => { if (!(e.relatedTarget instanceof Element && e.relatedTarget.closest('[data-subject-token]'))) setHover(null); };
    document.addEventListener('mouseover', over); document.addEventListener('mouseout', out);
    return () => { document.removeEventListener('mouseover', over); document.removeEventListener('mouseout', out); };
  }, [rows, prompt]);
  return <>{warnings.map(v => <p key={v} className="text-xs text-muted-foreground">{v}</p>)}
    {hover && createPortal(<div role="tooltip" className="pointer-events-none fixed z-50 max-w-64 -translate-y-full rounded-md border border-border bg-popover p-2 text-xs"
      style={{ left: hover.x, top: hover.y }}><p className="line-clamp-2">{hover.row.description}</p>
      <span className="text-muted-foreground">{hover.row.item_ids.length} 个素材</span></div>, document.body)}
  </>;
}
export { subjectToken };
