import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { HistoryReference } from '@/api/history';
import { downloadLibrary, itemCard, itemThumb, subjectToken, libraryWrite, LIBRARY_CHANGED, listLibrary,
  type LibraryCatalog, type LibraryFolder, type LibrarySubject } from '@/api/library';
import { restoreTrash } from '@/api/trash';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AddIcon, BackIcon, FavoriteIcon, FolderIcon, MoreIcon } from '@/components/ui/icons';
import { FileInput } from '@/components/ui/file-input';
import { Input } from '@/components/ui/input';
import { useRetainedSession } from '@/components/ui/retained';
import { errorText } from '@/lib/errorText';
import { MOTION_DURATION, MOTION_EASE, prefersReducedMotion } from '@/lib/motion';
import { notify } from '@/lib/notify';
import { AssetItemList } from './HistoryPanel';
import { FolderPicker } from './FolderPicker';
import { LibrarySourcePicker, saveSource, type Source } from './LibrarySourcePicker';
import { SubjectSheet } from './SubjectSheet';

type Group = LibraryFolder | LibrarySubject;
type Action = 'open' | 'edit' | 'move' | 'copy' | 'download' | 'delete';
const position = { top: 0, kind: 'all' as const, q: '' };
const noop = () => {};
export function LibraryPanel({ target, onTarget, onReference, onCanvas, onSubject }: {
  onCanvas?: (items: HistoryReference[]) => Promise<void>; onSubject?: (token: string) => void;
  target: string | null; onTarget: (id: string | null) => void; onReference: (items: HistoryReference[]) => Promise<void>;
}) {
  const [data, setData] = useState<LibraryCatalog | null>(null);
  const [error, setError] = useState('');
  const [landed, setLanded] = useState('');
  const [direction, setDirection] = useState(1);
  const [allSubjects, setAllSubjects] = useState(false);
  const [editor, setEditor] = useState<{ subject?: LibrarySubject } | null>(null);
  const retained = useRetainedSession(editor);
  const [form, setForm] = useState<{ id?: string; parent?: string } | null>(null);
  const [name, setName] = useState('');
  const [move, setMove] = useState<LibraryFolder | null>(null);
  const [source, setSource] = useState<'history' | 'canvas' | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const n = ++generation.current;
    listLibrary().then(result => { if (n === generation.current) { setData(result); setError(''); } })
      .catch(e => { if (n === generation.current) setError(errorText(e)); });
  }, []);
  useEffect(() => { reload(); window.addEventListener(LIBRARY_CHANGED, reload);
    return () => { window.removeEventListener(LIBRARY_CHANGED, reload); };
  }, [reload]);
  useEffect(() => { if (landed) { const id = setTimeout(() => setLanded(''), 1500); return () => clearTimeout(id); } }, [landed]);
  const folders = data?.folders || [];
  const subjects = data?.subjects || [];
  const group = folders.find(f => f.id === target) || subjects.find(s => s.id === target);
  const items = useMemo(() => group && data ? group.item_ids.map(id => itemCard(data.items[id])) : [], [data, group]);
  const pages = useMemo(() => ({ items, more: async () => items, reload, removeOutputs: reload, error, loading: !data, hasMore: false }), [items, reload, error, data]);
  const childFolders = folders.filter(f => !f.system && (f.parent_id || null) === (group?.id || null));
  const reduced = prefersReducedMotion();
  const navigate = (id: string | null, back = false) => { setDirection(back ? -1 : 1); onTarget(id); };
  const openForm = (id?: string, parent?: string, initial = '') => { setName(initial); setForm({ id, parent }); };
  async function perform(fn: () => Promise<unknown>) { try { await fn(); } catch (e) { notify.error(errorText(e)); } }
  async function action(key: Action, group: Group) {
    if (key === 'open') navigate(group.id);
    if (key === 'edit') {
      if ('handle' in group) setEditor({ subject: group }); else openForm(group.id, undefined, group.name);
    }
    if (key === 'move' && 'parent_id' in group) setMove(group);
    if (key === 'copy') setLanded((await libraryWrite<Group>(group.id + '/copy', {})).id);
    if (key === 'download') await downloadLibrary([group.id], group.name);
    if (key === 'delete') {
      const result = await libraryWrite<{ trash_id: string }>(group.id, undefined, 'DELETE');
      notify.undo('已删除 ' + group.name, () => void perform(async () => { await restoreTrash(result.trash_id); reload(); }));
    }
  }
  async function createFolder() {
    if (!form || !name.trim()) return;
    const row = form.id ? await libraryWrite<Group>(form.id, { name }, 'PATCH') :
      await libraryWrite<Group>('folders', { name, parent_id: form.parent });
    setForm(null); setLanded(row.id);
  }
  async function add(s: Source) { if (group) await saveSource(group.id, s); }
  const row = (g: Group, card = false) => <GroupRow key={g.id} group={g} hasImage={'cover_item_id' in g && !!g.cover_item_id && data?.items[g.cover_item_id]?.kind === 'image'} card={card} highlight={landed === g.id}
    onAction={key => void perform(() => action(key, g))} />;
  const section = 'mb-2 text-xs font-medium text-muted-foreground';
  return <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
    {error && <p role="alert" className="p-3 text-sm">{error}<Button variant="ghost" onClick={reload}>重试</Button></p>}
    <AnimatePresence initial={false} mode="wait">
      <motion.div key={group?.id || 'home'} initial={{ opacity: 0, x: reduced ? 0 : direction * 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
        transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE.out }} className="flex min-h-0 flex-1 flex-col">
        {group ? <>
          <div className="flex items-center gap-1 border-b border-border p-2"><Button variant="ghost" size="icon" aria-label="返回"
            onClick={() => navigate('parent_id' in group ? group.parent_id : null, true)}><BackIcon /></Button>
            <span className="truncate text-sm">素材库 · {group.name}</span>
            {'handle' in group && onSubject && <Button variant="ghost" size="sm" onClick={() => onSubject(subjectToken(group))}>用作参考</Button>}
            {'handle' in group && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setEditor({ subject: group })}>编辑</Button>}
          </div>
          <div className="flex flex-wrap gap-1 p-2"><Button variant="ghost" size="sm" onClick={() => input.current?.click()}>本地上传</Button>
            <Button variant="ghost" size="sm" onClick={() => setSource('history')}>从历史选</Button>
            <Button variant="ghost" size="sm" onClick={() => setSource('canvas')}>从画布选</Button>
            {'parent_id' in group && !group.parent_id && !group.system && <Button variant="ghost" size="sm" onClick={() => openForm(undefined, group.id)}><AddIcon />文件夹</Button>}
            <FileInput ref={input} multiple onChange={e => { const files = Array.from(e.target.files || []); e.target.value = '';
              void perform(async () => { for (const file of files) await add({ type: 'upload', file }); }); }} /></div>
          <div className="px-3">{childFolders.map(f => row(f))}</div>
          <AssetItemList onCanvas={onCanvas} library pages={pages} position={position} onScrollTop={noop} onReference={onReference} />
        </> : <div className="space-y-6 overflow-y-auto p-4">
          <Button variant="ghost" className="flex h-auto w-full justify-start gap-2 p-1" onClick={() => navigate('favorites')}><FavoriteIcon />收藏
            <span className="text-xs text-muted-foreground">{folders.find(f => f.system)?.item_ids.length || 0}</span>
            <span className="ml-auto flex gap-1">{folders.find(f => f.system)?.item_ids.slice(-4).reverse().map(id =>
              data?.items[id]?.kind === 'image' ? <img key={id} src={itemThumb(id)} alt="" className="size-8 rounded-sm object-cover" /> : <FolderIcon key={id} />)}</span>
          </Button>
          <section><div className="flex justify-between"><h3 className={section}>主体</h3>{subjects.length > 3 && <Button size="sm" variant="ghost" onClick={() => setAllSubjects(!allSubjects)}>全部</Button>}</div>
            <div className={'flex gap-2 ' + (allSubjects ? 'flex-wrap' : 'overflow-x-auto')}><Button variant="outline" className="size-16 shrink-0 border-dashed" aria-label="新建主体" onClick={() => setEditor({})}><AddIcon /></Button>
              {subjects.map(s => row(s, true))}</div></section>
          <section><h3 className={section}>我的文件夹</h3>
            <AnimatePresence initial={false}>{childFolders.map(f => row(f))}</AnimatePresence>
            <Button size="sm" variant="ghost" onClick={() => openForm()}><AddIcon />新建文件夹</Button></section>
          <section><h3 className={section}>团队共享</h3><p className="text-sm text-muted-foreground">暂无共享素材</p></section>
        </div>}
      </motion.div>
    </AnimatePresence>
    <Dialog open={!!form} onOpenChange={v => { if (!v) setForm(null); }}><DialogContent><DialogTitle>{form?.id ? '重命名' : '新建文件夹'}</DialogTitle>
      <form autoComplete="off" className="grid gap-4" onSubmit={e => { e.preventDefault(); void perform(createFolder); }}><Input autoFocus aria-label="文件夹名称" value={name} maxLength={160} onChange={e => setName(e.target.value)} />
        <Button disabled={!name.trim()}>保存</Button></form></DialogContent></Dialog>
    <FolderPicker open={!!move} root onClose={() => setMove(null)} allowed={f => !f.parent_id && f.id !== move?.id && !folders.some(c => c.parent_id === move?.id)}
      onChoose={async f => { if (move) await libraryWrite(move.id, { parent_id: f.id || null }, 'PATCH'); }} />
    {retained && <SubjectSheet items={data?.items || {}} key={retained.session} open={!!editor} subject={retained.value.subject} onClose={() => setEditor(null)} onSaved={setLanded} />}
    <LibrarySourcePicker open={!!source} initial={source || 'history'} onClose={() => setSource(null)} onChoose={s => void perform(() => add(s))} />
  </div>;
}
function GroupRow({ group, hasImage, card, highlight, onAction }: { group: Group; hasImage: boolean; card: boolean; highlight: boolean; onAction: (key: Action) => void }) {
  const [menu, setMenu] = useState(false);
  return <motion.div layout={!prefersReducedMotion()} exit={{ opacity: 0, height: prefersReducedMotion() ? 'auto' : 0 }}
    transition={{ duration: MOTION_DURATION.slow, ease: MOTION_EASE.inOut }}
    className={'relative flex items-center overflow-hidden rounded-md transition-colors ' + (highlight ? 'bg-primary/15 ' : '') + (card ? 'w-16 shrink-0 flex-col' : '')}
    onContextMenu={e => { e.preventDefault(); setMenu(true); }}>
    <Button variant="ghost" className={card ? 'h-auto w-16 flex-col gap-1 p-0' : 'min-w-0 flex-1 justify-start px-1'} onClick={() => onAction('open')}>
      {card && 'cover_item_id' in group ? <span className="grid size-16 place-items-center overflow-hidden rounded-md bg-secondary">
        {hasImage && group.cover_item_id ? <img alt="" className="size-full object-cover" src={itemThumb(group.cover_item_id)} /> : group.name.slice(0, 1)}</span> : <FolderIcon />}
      <span className="truncate">{group.name}</span>{!card && <span className="ml-auto text-xs text-muted-foreground">{group.item_ids.length}</span>}
    </Button>
    <DropdownMenu open={menu} onOpenChange={setMenu}><DropdownMenuTrigger asChild><Button aria-label={group.name + ' 更多操作'} variant="ghost" size="icon"
      className={card ? 'absolute right-0 top-0 size-6 rounded-full bg-popover' : 'size-7'}><MoreIcon /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => onAction('open')}>打开</DropdownMenuItem><DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onAction('edit')}>{card ? '编辑' : '重命名'}</DropdownMenuItem>
        {!card && <DropdownMenuItem onSelect={() => onAction('move')}>移动到…</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => onAction('copy')}>创建副本</DropdownMenuItem><DropdownMenuSeparator />
        <DropdownMenuItem disabled>共享给团队</DropdownMenuItem><DropdownMenuItem onSelect={() => onAction('download')}>下载</DropdownMenuItem>
        <DropdownMenuSeparator /><DropdownMenuItem destructive onSelect={() => onAction('delete')}>删除</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
  </motion.div>;
}
