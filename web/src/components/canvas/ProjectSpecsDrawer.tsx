import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { getCanvasSpecs, saveCanvasSpec, getCanvasLessons, reviewCanvasLesson, type CanvasLessons } from '@/api/canvas';
import { getTeamSpecs, listTeamLibraries, saveTeamSpec } from '@/api/teamLibraries';
import type { TeamLibraryView } from '@/schema/teamLibrary';
import { cn } from '@/lib/utils';

const PROJECT = 'project';
const LESSONS = 'lessons';
// 团队规范的键：team:<库> 是团队整体规范，teamcat:<库>:<类别> 是团队类别规范（ADR-0031）。
const teamKey = (libraryId: string) => `team:${libraryId}`;
const teamCategoryKey = (libraryId: string, category: string) => `teamcat:${libraryId}:${category}`;
const isDraftKey = (key: string) => key === PROJECT || key.startsWith('category:') || key.startsWith('team:') || key.startsWith('teamcat:');

function saveKey(projectId: string, key: string, text: string) {
  if (key === PROJECT) return saveCanvasSpec(projectId, text);
  if (key.startsWith('category:')) return saveCanvasSpec(projectId, text, key.slice(9));
  if (key.startsWith('team:')) return saveTeamSpec(key.slice(5), text);
  const rest = key.slice(8);
  const colon = rest.indexOf(':');
  return saveTeamSpec(rest.slice(0, colon), text, rest.slice(colon + 1));
}

/** 本画布挂载且可达的团队库，同一个库只留一条。 */
function reachableLibraries(views: TeamLibraryView[]) {
  const seen = new Set<string>();
  return views.filter(view => view.reachable && !seen.has(view.library_id) && Boolean(seen.add(view.library_id)));
}

export function ProjectSpecsDrawer({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const storageKey = `canvas-spec-drafts:${projectId}`;
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<string[]>([]);
  const [libraries, setLibraries] = useState<TeamLibraryView[]>([]);
  const [teamCategories, setTeamCategories] = useState<Record<string, string[]>>({});
  const [scope, setScope] = useState(PROJECT);
  const [active, setActive] = useState(PROJECT);
  const [preview, setPreview] = useState(false);
  const [lessons, setLessons] = useState<CanvasLessons>({pending: [], adopted: []});
  const [error, setError] = useState('');
  const [status, setStatus] = useState('加载中');
  const [ready, setReady] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const drafts = useRef<Record<string, string>>({});
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const remember = useCallback(() => {
    localStorage.setItem(storageKey, JSON.stringify(drafts.current));
  }, [storageKey]);
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    queue.current = queue.current.then(async () => {
      if (composing.current) return false;
      const pending = Object.entries(drafts.current);
      if (!pending.length) return true;
      setStatus('保存中');
      try {
        for (const [key, text] of pending) {
          await saveKey(projectId, key, text);
          if (drafts.current[key] === text) delete drafts.current[key];
          remember();
        }
        setStatus(Object.keys(drafts.current).length ? '未保存' : '已保存');
        setError('');
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : '保存失败');
        setStatus('未保存');
        return false;
      }
    });
    return queue.current;
  }, [projectId, remember]);
  useEffect(() => {
    let disposed = false;
    void Promise.all([getCanvasSpecs(projectId), getCanvasLessons(projectId)]).then(async ([specs, items]) => {
      // 团队库读不到不挡项目规范：没挂或读失败的库不出现在切换里。
      const mounted = await listTeamLibraries(projectId).then(reachableLibraries).catch(() => []);
      const teams = await Promise.all(mounted.map(library => getTeamSpecs(library.library_id).then(specs => ({ library, specs })).catch(() => null)));
      if (disposed) return;
      const loaded = teams.filter(team => team !== null);
      let recovered: Record<string, string> = {};
      try {
        const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '{}');
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          recovered = Object.fromEntries(Object.entries(value).filter(([key, text]) =>
            typeof text === 'string' && isDraftKey(key)));
        }
      } catch { /* Ignore invalid local storage. */ }
      drafts.current = recovered;
      setTexts({
        [PROJECT]: specs.project,
        ...Object.fromEntries(Object.entries(specs.categories).map(([key, text]) => [`category:${key}`, text])),
        ...Object.fromEntries(loaded.flatMap(({ library, specs: team }) => [
          [teamKey(library.library_id), team.team],
          ...Object.entries(team.categories).map(([name, text]) => [teamCategoryKey(library.library_id, name), text]),
        ])),
        ...recovered,
      });
      setCategories(Object.keys(specs.categories));
      setLibraries(loaded.map(team => team.library));
      setTeamCategories(Object.fromEntries(loaded.map(({ library, specs: team }) => [library.library_id, Object.keys(team.categories)])));
      setLessons(items);
      setStatus(Object.keys(recovered).length ? '未保存' : '已保存');
      setReady(true);
    }).catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; clearTimeout(timer.current); void flush(); };
  }, [projectId, storageKey, flush]);
  const schedule = () => {
    clearTimeout(timer.current);
    if (!composing.current) timer.current = setTimeout(() => { void flush(); }, 600);
  };
  const change = (text: string) => {
    setTexts(current => ({...current, [active]: text}));
    drafts.current[active] = text;
    try { remember(); } catch { setError('本机草稿存储不可用，请保存后再关闭'); }
    setStatus('未保存');
    schedule();
  };
  const switchTab = async (key: string) => {
    if (await flush()) { setActive(key); setPreview(false); }
  };
  const switchScope = async (next: string) => {
    if (next === scope || !await flush()) return;
    setScope(next);
    setActive(next === PROJECT ? PROJECT : teamKey(next));
    setPreview(false);
  };
  // 团队类别 = 本项目类别 ∪ 团队库已有类别：写一份新类别规范就在团队库里建出映射。
  const tabs = scope === PROJECT
    ? [{key: PROJECT, label: '项目'}, ...categories.map(name => ({key: `category:${name}`, label: name})), {key: LESSONS, label: '经验'}]
    : [{key: teamKey(scope), label: '团队'}, ...[...new Set([...categories, ...(teamCategories[scope] ?? [])])]
      .map(name => ({key: teamCategoryKey(scope, name), label: name}))];
  const review = async (index: number, adopt: boolean) => {
    if (!await flush()) return;
    setReviewing(true);
    try {
      setLessons(await reviewCanvasLesson(projectId, index, adopt));
      const specs = await getCanvasSpecs(projectId);
      setTexts(current => ({...current, [PROJECT]: specs.project}));
      setError('');
    } catch (e) { setError(String(e)); }
    finally { setReviewing(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) void flush().then(saved => { if (saved) onClose(); }); }}>
    <DialogContent className="left-auto right-0 top-0 flex h-dvh w-full max-w-xl translate-x-0 translate-y-0 flex-col rounded-r-none" aria-describedby={undefined}>
      <DialogTitle>规范</DialogTitle>
      {libraries.length > 0 && <div className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-md bg-secondary/50 p-1" role="radiogroup" aria-label="规范来源">
        {[{id: PROJECT, label: '本项目'}, ...libraries.map(library => ({id: library.library_id, label: library.name}))].map(item =>
          <button key={item.id} type="button" role="radio" aria-checked={scope === item.id} disabled={!ready || reviewing}
            onClick={() => void switchScope(item.id)}
            className={cn('h-7 shrink-0 truncate rounded-sm px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50',
              scope === item.id ? 'bg-popover text-foreground' : 'text-muted-foreground hover:text-foreground')}>
            {item.label}
          </button>)}
      </div>}
      <div className="flex flex-wrap gap-1 pr-5" role="tablist" aria-label="规范类别">
        {tabs.map(tab =>
          <Button key={tab.key} role="tab" aria-selected={active === tab.key} variant={active === tab.key ? 'secondary' : 'ghost'} size="sm" disabled={!ready || reviewing} onClick={() => void switchTab(tab.key)}>{tab.label}</Button>)}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error} <Button size="sm" variant="ghost" onClick={() => void flush()}>重试保存</Button></p>}
      {active === LESSONS ? <div className="min-h-0 flex-1 space-y-4 overflow-y-auto text-sm">
        <h3 className="text-muted-foreground">待审 · {lessons.pending.length}</h3>
        {lessons.pending.map((text, index) => <div key={index} className="rounded-lg border border-border p-3"><p className="whitespace-pre-wrap">{text}</p><div className="mt-2 flex gap-1"><Button size="sm" disabled={reviewing} onClick={() => void review(index, true)}>采纳</Button><Button size="sm" variant="ghost" disabled={reviewing} onClick={() => void review(index, false)}>删除</Button></div></div>)}
        <h3 className="text-muted-foreground">已采纳 · {lessons.adopted.length}</h3>
        {lessons.adopted.map((text, index) => <p key={index} className="whitespace-pre-wrap rounded-lg border border-border p-3">{text}</p>)}
      </div> : <>
        <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground" aria-live="polite">{status}</span><Button size="sm" variant="ghost" onClick={() => setPreview(value => !value)}>{preview ? '编辑' : '预览'}</Button></div>
        {preview ? <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-sm"><ReactMarkdown>{texts[active] || ''}</ReactMarkdown></div> : <textarea autoComplete="off" data-1p-ignore="" data-lpignore="true" data-form-type="other" aria-label="规范正文" disabled={!ready} maxLength={40000} value={texts[active] || ''} onChange={event => change(event.target.value)} onCompositionStart={() => { composing.current = true; clearTimeout(timer.current); }} onCompositionEnd={() => { composing.current = false; schedule(); }} className="min-h-0 flex-1 resize-none rounded-lg border border-border bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
      </>}
    </DialogContent>
  </Dialog>;
}
