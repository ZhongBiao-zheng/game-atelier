import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { deleteTemplate, duplicateTemplate, listTemplates, renameTemplate, templateCoverUrl, type CanvasTemplate } from '@/api/templates';
import { restoreTrash } from '@/api/trash';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AddIcon, CopyIcon, DeleteIcon, EditIcon, GridIcon, MoreIcon } from '@/components/ui/icons';
import { errorText } from '@/lib/errorText';
import { MOTION_DURATION, MOTION_EASE, motionAvailable, prefersReducedMotion } from '@/lib/motion';
import { notify } from '@/lib/notify';
import { loadUiPrefs, saveUiPref } from '@/lib/uiPrefs';
import { TemplateNameDialog } from './TemplateNameDialog';

const reveal = 'opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100';
const scrollKey = 'asset-templates-scroll';

export function TemplatesPanel({ refreshKey, onAdd }: { refreshKey?: number; onAdd?: (id: string) => Promise<void> }) {
  const [items, setItems] = useState<CanvasTemplate[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CanvasTemplate | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const scrollTop = useRef<number | null>(null);
  const restoreTop = useRef<number | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([listTemplates(), loadUiPrefs()]).then(([page, prefs]) => {
      if (!active) return;
      restoreTop.current = scrollTop.current ?? Number(prefs?.[scrollKey] ?? 0);
      setItems(page.items);
      setError('');
    }).catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [reload, refreshKey]);
  useLayoutEffect(() => {
    if (list.current && restoreTop.current !== null) list.current.scrollTop = restoreTop.current;
    restoreTop.current = null;
  }, [items]);
  useEffect(() => () => { if (scrollTop.current !== null) void saveUiPref(scrollKey, scrollTop.current); }, []);

  async function action(run: () => Promise<unknown>) {
    setBusy(true);
    try { await run(); }
    catch (cause) { notify.error(errorText(cause)); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setDeletingId(id);
    try {
      const receipt = await deleteTemplate(id);
      setItems(current => current?.filter(item => item.id !== id) ?? null);
      setReload(value => value + 1);
      notify.undo('已移至回收站', () => { void action(async () => {
        await restoreTrash(receipt.trash_id);
        setReload(value => value + 1);
      }); });
    } finally {
      setDeletingId(null);
    }
  }
  if (error) return <div role="alert" className="p-3 text-sm">{error}
    <Button variant="ghost" onClick={() => setReload(value => value + 1)}>重试</Button></div>;
  if (!items) return null;
  const visibleItems = items.filter(item => item.id !== deletingId);
  const animated = motionAvailable();
  const reduced = prefersReducedMotion();
  return <div ref={list} onScroll={event => { scrollTop.current = event.currentTarget.scrollTop; }}
    className="min-h-0 flex-1 space-y-6 overflow-y-auto p-3">
    <section aria-label="我的"><h3 className="mb-2 text-sm font-medium">我的</h3>
      <div className="relative grid grid-cols-2 gap-2">
        <AnimatePresence initial={false} mode="popLayout">{visibleItems.map(item =>
          <motion.div key={item.id} layout={animated && !reduced ? 'position' : false}
            initial={animated ? 'hidden' : false} animate="shown" exit={animated ? 'hidden' : undefined}
            transition={cardTransition}>
            <TemplateCard item={item} busy={busy} reduced={reduced} onEdit={() => setEditing(item)}
              onAdd={onAdd && (() => void action(() => onAdd(item.id)))}
              onDuplicate={() => void action(async () => {
                await duplicateTemplate(item.id);
                setReload(value => value + 1);
              })}
              onDelete={() => void action(() => remove(item.id))} />
          </motion.div>
        )}</AnimatePresence>
      </div>
      {visibleItems.length === 0 && <div className="space-y-1 py-6 text-center">
        <p className="text-sm">还没有模板</p>
        <p className="text-xs text-muted-foreground">在画布里选中一个组，点「存为模板」</p>
      </div>}
    </section>
    <section aria-label="团队共享"><h3 className="mb-2 text-sm font-medium">团队共享</h3>
      <p className="py-3 text-center text-xs text-muted-foreground">还没有模板</p>
    </section>
    {editing && <TemplateNameDialog title="重命名" initialName={editing.name} onClose={() => setEditing(null)}
      onSave={async name => { await renameTemplate(editing.id, name); setReload(value => value + 1); }} />}
  </div>;
}


const cardTransition = { duration: MOTION_DURATION.slow, ease: MOTION_EASE.inOut };

function TemplateCard({ item, busy, reduced, onAdd, onEdit, onDuplicate, onDelete }: {
  item: CanvasTemplate; busy: boolean; reduced: boolean; onAdd?: () => void;
  onEdit: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const present = useIsPresent();
  return <motion.div className="overflow-hidden" transition={cardTransition}
    variants={{ shown: { opacity: 1, height: 'auto' }, hidden: reduced ? { opacity: 0 } : { opacity: 0, height: 0 } }}>
    <article aria-label={item.name} aria-hidden={!present} className="group media-edge relative isolate grid aspect-[4/3] place-items-center overflow-hidden rounded-md bg-muted">
      {item.cover ? <img className="absolute inset-0 size-full object-cover" alt="" loading="lazy" src={templateCoverUrl(item.id)} />
        : <GridIcon size="xl" className="text-muted-foreground" />}
      <span aria-hidden="true" className={`pointer-events-none absolute inset-0 bg-scrim transition-opacity ${reveal}`}
        style={{ transitionDuration: `${MOTION_DURATION.fast}s` }} />
      <span className="absolute bottom-1.5 left-1.5 max-w-[90%] truncate rounded-sm bg-scrim px-1.5 py-0.5 text-sm font-medium text-white">{item.name}</span>
      <span className="absolute right-1.5 top-1.5 rounded-sm bg-scrim px-1.5 py-0.5 text-xs tabular-nums text-white">{item.node_count} 个节点</span>
      {onAdd && <Button size="sm" className={`relative h-7 ${reveal}`} disabled={busy || !present}
        onClick={onAdd}><AddIcon />添加到画布</Button>}
      <DropdownMenu><DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={`${item.name} 更多操作`} disabled={busy || !present}
          className={`absolute left-1.5 top-1.5 size-6 rounded-full bg-scrim text-white data-[state=open]:opacity-100 ${reveal}`}><MoreIcon /></Button>
      </DropdownMenuTrigger><DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={onEdit}><EditIcon />重命名</DropdownMenuItem>
        <DropdownMenuItem onSelect={onDuplicate}><CopyIcon />创建副本</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={onDelete}><DeleteIcon />删除</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
    </article>
  </motion.div>;
}
