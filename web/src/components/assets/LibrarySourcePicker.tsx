import { useEffect, useState } from 'react';
import { canvasMediaUrl, getCanvasDocument, listCanvasProjects } from '@/api/canvas';
import type { HistoryItem } from '@/api/history';
import { FolderIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorText } from '@/lib/errorText';
import type { CanvasProject } from '@/schema/canvas';
import { useHistoryPages } from './useHistoryPages';
import { type LibraryItem, type LibraryCatalog, uploadItem, libraryWrite, listLibrary, itemUrl } from '@/api/library';

export type Source = { type: 'history'; row: HistoryItem } |
  { type: 'canvas'; project: string; version: string; title: string; url: string; kind: string } |
  { type: 'library'; item: LibraryItem } |
  { type: 'upload'; file: File; url?: string };
export function sourceTitle(s: Source) {
  if (s.type === 'library') return s.item.title;
  return s.type === 'history' ? s.row.filename : s.type === 'upload' ? s.file.name : s.title;
}
export function sourceThumb(s: Source) {
  if (s.type === 'library') return s.item.kind === 'image' ? itemUrl(s.item.id) : undefined;
  if (s.type === 'history') return s.row.kind === 'image' ? s.row.thumbnail_url : undefined;
  if (s.type === 'upload') return s.file.type.startsWith('image/') ? s.url : undefined;
  return s.kind === 'image' ? s.url : undefined;
}
export function saveSource(owner: string, s: Source) {
  if (s.type === 'library') return libraryWrite<LibraryItem>(s.item.id + '/copy', { target: owner });
  if (s.type === 'upload') return uploadItem(owner, s.file);
  return s.type === 'history' ? libraryWrite<LibraryItem>(owner + '/history', { job_id: s.row.job_id, output_index: s.row.output_index })
    : libraryWrite<LibraryItem>(owner + '/canvas', { project_id: s.project, version_id: s.version });
}
type Tab = 'history' | 'canvas';
export function LibrarySourcePicker({ open, initial, onClose, onChoose }: {
  open: boolean; initial: Tab; onClose: () => void; onChoose: (s: Source) => void;
}) {
  const [scope, setScope] = useState('mine');
  const [source, setSource] = useState<Tab | 'library'>(initial);
  useEffect(() => { if (open) { setSource(initial); setScope('mine'); } }, [open, initial]);
  const choose = (s: Source) => { onChoose(s); onClose(); };
  return <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}><DialogContent>
    <DialogTitle>选择素材</DialogTitle>
    <Tabs value={scope} onValueChange={setScope}><TabsList aria-label="素材范围">
      <TabsTrigger value="mine">我的</TabsTrigger><TabsTrigger value="team">团队共享</TabsTrigger>
    </TabsList></Tabs>
    {scope === 'team' ? <p className="py-6 text-center text-sm text-muted-foreground">暂无共享素材</p> : <>
      <Select value={source} onValueChange={v => setSource(v as typeof source)}><SelectTrigger aria-label="素材来源"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="history">历史</SelectItem><SelectItem value="canvas">画布</SelectItem>
          <SelectItem value="library">我的文件夹</SelectItem></SelectContent></Select>
      {open && (source === 'library' ? <FolderSources onChoose={choose} /> : <SourceList tab={source} onChoose={choose} />)}
    </>}
  </DialogContent></Dialog>;
}
function FolderSources({ onChoose }: { onChoose: (s: Source) => void }) {
  const [catalog, setCatalog] = useState<LibraryCatalog | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    listLibrary(controller.signal).then(setCatalog).catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, []);
  const current = catalog?.folders.find(f => f.id === folder);
  return <>{error && <p role="alert">{error}</p>}
    {current && <Button variant="ghost" onClick={() => setFolder(current.parent_id)}>返回 · {current.name}</Button>}
    <div className="grid max-h-[55vh] grid-cols-3 gap-1 overflow-auto">
      {catalog?.folders.filter(f => f.parent_id === folder).map(f => <Button variant="ghost" key={f.id}
        className="h-auto flex-col p-2" onClick={() => setFolder(f.id)}><FolderIcon />{f.name}</Button>)}
      {current?.item_ids.map(id => { const item = catalog!.items[id]; return <Button variant="ghost" key={id}
        className="h-auto flex-col overflow-hidden p-1" onClick={() => onChoose({ type: 'library', item })}>
        {item.kind === 'image' && <img src={itemUrl(id)} alt="" className="aspect-square w-full rounded-sm object-cover" />}
        <span className="w-full truncate text-xs">{item.title}</span></Button>; })}
    </div></>;
}
function SourceList({ tab, onChoose }: { tab: Tab; onChoose: (s: Source) => void }) {
  const history = useHistoryPages('all', '');
  const [projects, setProjects] = useState<CanvasProject[]>([]);
  const [project, setProject] = useState('');
  const [versions, setVersions] = useState<Source[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (tab !== 'canvas') return;
    let active = true;
    listCanvasProjects(true).then(rows => { if (active) { setProjects(rows); setProject(p => p || rows[0]?.project_id || ''); } })
      .catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [tab]);
  useEffect(() => {
    if (!project || tab !== 'canvas') return;
    let active = true;
    setVersions([]); setError('');
    getCanvasDocument(project).then(doc => {
      if (!active) return;
      setVersions(Object.values(doc.content_versions).map(v => ({ type: 'canvas', project, version: v.version_id, kind: v.kind,
        title: doc.nodes.find(n => 'current_version_id' in n.data && n.data.current_version_id === v.version_id)?.title || v.version_id,
        url: canvasMediaUrl(project, v.version_id) })));
    }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [project, tab]);
  const rows: Source[] = tab === 'history' ? history.items.map(row => ({ type: 'history', row })) : versions;
  return <>{tab === 'canvas' && projects.length > 0 && <Select value={project} onValueChange={setProject}>
    <SelectTrigger aria-label="画布项目"><SelectValue /></SelectTrigger><SelectContent>{projects.map(p =>
      <SelectItem key={p.project_id} value={p.project_id}>{p.name}</SelectItem>)}</SelectContent></Select>}
    {(error || history.error) && <p role="alert">{error || history.error}</p>}
    <div className="grid max-h-[55vh] grid-cols-3 gap-1 overflow-y-auto">
      {rows.map((s, i) => <Button variant="ghost" key={i} className="h-auto flex-col overflow-hidden p-1" onClick={() => onChoose(s)}>
        {sourceThumb(s) && <img src={sourceThumb(s)} alt="" className="aspect-square w-full rounded-sm object-cover" />}
        <span className="w-full truncate text-xs">{sourceTitle(s)}</span>
      </Button>)}
    </div>{tab === 'history' && history.hasMore && <Button variant="ghost" onClick={() => void history.more().catch(() => {})}>加载更多</Button>}
  </>;
}
