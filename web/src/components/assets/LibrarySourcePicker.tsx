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
import { type LibraryItem, type LibraryCatalog, uploadItem, libraryWrite, listLibrary, itemThumb } from '@/api/library';

export type Source = { type: 'history'; row: HistoryItem } |
  { type: 'canvas'; project: string; version: string; title: string; url: string; kind: string; text?: string } |
  { type: 'library'; item: LibraryItem } |
  { type: 'upload'; file: File; url?: string };
export function sourceTitle(s: Source) {
  if (s.type === 'library') return s.item.title;
  return s.type === 'history' ? (s.row.title || s.row.prompt || s.row.filename) : s.type === 'upload' ? s.file.name : s.title;
}
export function sourceThumb(s: Source) {
  if (s.type === 'library') return s.item.kind === 'image' ? itemThumb(s.item.id) : undefined;
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
function sourceKey(s: Source) {
  if (s.type === 'history') return 'history/' + s.row.job_id + '/' + s.row.output_index;
  if (s.type === 'canvas') return 'canvas/' + s.project + '/' + s.version;
  return s.type === 'library' ? s.item.id : s.url;
}

interface Selection {
  onChoose: (s: Source) => void;
  selected: Source[];
}

function SourceTile({ item, selected, onChoose }: Selection & { item: Source }) {
  const thumb = sourceThumb(item);
  const text = item.type === 'history' ? item.row.text_preview : item.type === 'library' ? item.item.text_preview :
    item.type === 'canvas' ? item.text : undefined;
  const checked = selected.some(s => sourceKey(s) === sourceKey(item));
  return <Button variant="ghost" aria-pressed={checked} className="grid h-auto min-w-0 grid-cols-1 content-start gap-1 p-1 text-left aria-pressed:bg-primary/15"
    onClick={() => onChoose(item)}>
    <span className="relative grid aspect-square w-full place-items-center overflow-hidden rounded-sm bg-secondary">
      {thumb ? <img src={thumb} alt="" className="absolute inset-0 size-full object-cover" /> :
        <span className="line-clamp-2 whitespace-pre-line px-2 text-xs">{text || sourceTitle(item)}</span>}
    </span>
    <span className="w-full truncate text-xs">{sourceTitle(item)}</span>
  </Button>;
}

export function LibrarySourcePicker({ open, initial, onClose, onChoose, limit }: {
  open: boolean; initial: Tab; onClose: () => void; onChoose: (items: Source[]) => void; limit?: number;
}) {
  const [selected, setSelected] = useState<Source[]>([]);
  const [scope, setScope] = useState('mine');
  const [source, setSource] = useState<Tab | 'library'>(initial);
  useEffect(() => { if (open) { setSource(initial); setScope('mine'); setSelected([]); } }, [open, initial]);
  const choose = (s: Source) => setSelected(current => current.some(item => sourceKey(item) === sourceKey(s))
    ? current.filter(item => sourceKey(item) !== sourceKey(s)) : [...current, s]);
  return <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}><DialogContent>
    <DialogTitle>选择素材</DialogTitle>
    <Tabs value={scope} onValueChange={setScope}><TabsList aria-label="素材范围">
      <TabsTrigger value="mine">我的</TabsTrigger><TabsTrigger value="team">团队共享</TabsTrigger>
    </TabsList></Tabs>
    {scope === 'team' ? <p className="py-6 text-center text-sm text-muted-foreground">暂无共享素材</p> : <>
      <Select value={source} onValueChange={v => setSource(v as typeof source)}><SelectTrigger aria-label="素材来源"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="history">历史</SelectItem><SelectItem value="canvas">画布</SelectItem>
          <SelectItem value="library">我的文件夹</SelectItem></SelectContent></Select>
      {open && (source === 'library' ? <FolderSources onChoose={choose} selected={selected} /> : <SourceList tab={source} onChoose={choose} selected={selected} />)}
    </>}
    <Button disabled={!selected.length || (limit !== undefined && selected.length > limit)}
      onClick={() => { onChoose(selected); onClose(); }}>添加 {selected.length} 项</Button>
  </DialogContent></Dialog>;
}
function FolderSources({ onChoose, selected }: Selection) {
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
      {current?.item_ids.map(id => <SourceTile key={id} item={{ type: 'library', item: catalog!.items[id] }} selected={selected} onChoose={onChoose} />)}
    </div></>;
}
function SourceList({ tab, onChoose, selected }: Selection & { tab: Tab }) {
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
      setVersions(doc.nodes.flatMap(node => {
        const id = 'current_version_id' in node.data && node.data.current_version_id;
        const v = id && doc.content_versions[id];
        if (!v) return [];
        return [{ type: 'canvas' as const, project, version: v.version_id, kind: v.kind, title: node.title,
          text: v.kind === 'text' ? v.text : undefined, url: canvasMediaUrl(project, v.version_id, 128) }];
      }));
    }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [project, tab]);
  const rows: Source[] = tab === 'history' ? history.items.map(row => ({ type: 'history', row })) : versions;
  return <>{tab === 'canvas' && projects.length > 0 && <Select value={project} onValueChange={setProject}>
    <SelectTrigger aria-label="画布项目"><SelectValue /></SelectTrigger><SelectContent>{projects.map(p =>
      <SelectItem key={p.project_id} value={p.project_id}>{p.name}</SelectItem>)}</SelectContent></Select>}
    {(error || history.error) && <p role="alert">{error || history.error}</p>}
    <div className="grid max-h-[55vh] grid-cols-3 gap-1 overflow-y-auto">
      {rows.map(s => <SourceTile key={sourceKey(s)} item={s} selected={selected} onChoose={onChoose} />)}
      {tab === 'canvas' && !versions.length && !error && <p className="col-span-3 py-6 text-center text-sm text-muted-foreground">还没有内容</p>}
    </div>{tab === 'history' && history.hasMore && <Button variant="ghost" onClick={() => void history.more().catch(() => {})}>加载更多</Button>}
  </>;
}
