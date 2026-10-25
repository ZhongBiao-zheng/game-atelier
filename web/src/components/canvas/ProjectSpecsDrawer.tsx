import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { getCanvasSpecs, saveCanvasSpec, getCanvasLessons, reviewCanvasLesson, type CanvasLessons } from '@/api/canvas';

const PROJECT = 'project';
const LESSONS = 'lessons';

export function ProjectSpecsDrawer({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const storageKey = `canvas-spec-drafts:${projectId}`;
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<string[]>([]);
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
          await saveCanvasSpec(projectId, text, key === PROJECT ? undefined : key.slice(9));
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
    void Promise.all([getCanvasSpecs(projectId), getCanvasLessons(projectId)]).then(([specs, items]) => {
      if (disposed) return;
      let recovered: Record<string, string> = {};
      try {
        const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '{}');
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          recovered = Object.fromEntries(Object.entries(value).filter(([key, text]) =>
            typeof text === 'string' && (key === PROJECT || key.startsWith('category:'))));
        }
      } catch { /* Ignore invalid local storage. */ }
      drafts.current = recovered;
      setTexts({[PROJECT]: specs.project, ...Object.fromEntries(Object.entries(specs.categories).map(([key, text]) => [`category:${key}`, text])), ...recovered});
      setCategories(Object.keys(specs.categories));
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
      <DialogTitle>项目规范</DialogTitle>
      <div className="flex flex-wrap gap-1 pr-5" role="tablist" aria-label="规范类别">
        {[{key: PROJECT, label: '项目'}, ...categories.map(name => ({key: `category:${name}`, label: name})), {key: LESSONS, label: '经验'}].map(tab =>
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
        {preview ? <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-sm"><ReactMarkdown>{texts[active] || ''}</ReactMarkdown></div> : <textarea aria-label="规范正文" disabled={!ready} maxLength={40000} value={texts[active] || ''} onChange={event => change(event.target.value)} onCompositionStart={() => { composing.current = true; clearTimeout(timer.current); }} onCompositionEnd={() => { composing.current = false; schedule(); }} className="min-h-0 flex-1 resize-none rounded-lg border border-border bg-background p-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
      </>}
    </DialogContent>
  </Dialog>;
}
