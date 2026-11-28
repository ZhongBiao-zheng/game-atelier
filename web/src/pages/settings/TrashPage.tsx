import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { emptyTrash, listTrash, purgeTrash, restoreTrash, TRASH_KIND_LABEL, type TrashEntry } from '@/api/trash';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useRetained } from '@/components/ui/retained';
import { errorText } from '@/lib/errorText';
import { notify } from '@/lib/notify';
import { formatBeijingTime } from '@/lib/time';
import { MOTION_DURATION, MOTION_EASE, motionAvailable, prefersReducedMotion } from '@/lib/motion';
import { SwapLabel } from '@/components/ui/swap-label';

/** 删一轮里的单张也记成 round，带 `output_slot`：单独标出来，不然和整轮删除长得一样。 */
function trashKindLabel(entry: TrashEntry): string {
  if (entry.kind === 'round' && typeof entry.meta.output_slot === 'number') return '单张结果';
  if (entry.kind === 'round' && Array.isArray(entry.meta.outputs)) return `${entry.meta.outputs.length} 项结果`;
  return TRASH_KIND_LABEL[entry.kind] ?? entry.kind;
}

type Pending = { scope: 'one'; entry: TrashEntry } | { scope: 'all' };

function TrashRow({ entry, busy, onRestore, onPurge }: {
  entry: TrashEntry;
  busy: boolean;
  onRestore: () => void;
  onPurge: () => void;
}) {
  // 还原或彻底删除后这一行 150ms 收起淡出，下面的行跟着上移；减弱动态效果时只淡出。
  const exit = { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle };
  return <motion.li
    exit={motionAvailable() ? (prefersReducedMotion() ? { opacity: 0, transition: exit } : { opacity: 0, height: 0, transition: exit }) : undefined}
    className="group/row overflow-hidden">
    <div className="flex items-center gap-4 py-3 group-first/row:pt-0 group-last/row:pb-0">
    <Badge variant="secondary" className="shrink-0">{trashKindLabel(entry)}</Badge>
    <div className="min-w-0 flex-1 space-y-1">
      <p className="truncate text-sm font-medium">{entry.label}</p>
      <p className="text-xs tabular-nums text-muted-foreground">
        {formatBeijingTime(entry.deleted_at)} · {entry.days_left > 0 ? `剩 ${entry.days_left} 天` : '即将清理'}
      </p>
    </div>
    <Button variant="outline" size="sm" type="button" disabled={busy} onClick={onRestore}>还原</Button>
    <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={onPurge}
      className="text-destructive hover:text-destructive">彻底删除</Button>
    </div>
  </motion.li>;
}

export function TrashPage() {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [emptying, setEmptying] = useState(false);
  const shown = useRetained(pending);

  useEffect(() => {
    let active = true;
    listTrash().then(items => { if (active) setEntries(items); })
      .catch(error => { if (active) setLoadError(errorText(error)); });
    return () => { active = false; };
  }, []);

  const setBusy = (id: string, busy: boolean) => setBusyIds(current => {
    const next = new Set(current);
    if (busy) next.add(id); else next.delete(id);
    return next;
  });
  const drop = (ids: ReadonlySet<string>) => setEntries(current => current?.filter(entry => !ids.has(entry.trash_id)) ?? current);

  async function restore(entry: TrashEntry) {
    setBusy(entry.trash_id, true);
    try {
      await restoreTrash(entry.trash_id);
      drop(new Set([entry.trash_id]));
    } catch (error) {
      notify.error(errorText(error));
    } finally {
      setBusy(entry.trash_id, false);
    }
  }

  async function confirmPurge() {
    if (!pending) return;
    const target = pending;
    setPending(null);
    try {
      if (target.scope === 'all') {
        setEmptying(true);
        await emptyTrash();
        setEntries([]);
      } else {
        setBusy(target.entry.trash_id, true);
        await purgeTrash(target.entry.trash_id);
        drop(new Set([target.entry.trash_id]));
      }
    } catch (error) {
      notify.error(errorText(error));
    } finally {
      if (target.scope === 'one') setBusy(target.entry.trash_id, false);
      else setEmptying(false);
    }
  }

  return <div className="min-w-0 space-y-5">
    {entries && entries.length > 0 && <div className="flex justify-end">
      <Button variant="outline" size="sm" type="button" disabled={emptying} onClick={() => setPending({ scope: 'all' })}>
        <SwapLabel active={emptying} on="清空中…" off="清空回收站" />
      </Button>
    </div>}
    {entries && entries.length === 0 && <div className="py-16 text-center">
      <p className="font-display text-display italic text-foreground/70">回收站是空的</p>
    </div>}
    {entries && entries.length > 0 && <ul aria-label="回收站" className="divide-y divide-border rounded-xl border border-border bg-card p-5">
      <AnimatePresence initial={false}>
        {entries.map(entry => <TrashRow key={entry.trash_id} entry={entry} busy={emptying || busyIds.has(entry.trash_id)}
          onRestore={() => void restore(entry)} onPurge={() => setPending({ scope: 'one', entry })} />)}
      </AnimatePresence>
    </ul>}
    {!entries && !loadError && <p role="status" className="delayed-reveal text-xs text-muted-foreground">加载中…</p>}
    {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
    <ConfirmDialog
      open={pending !== null}
      variant="destructive"
      title={shown?.scope === 'all' ? '清空回收站？' : `彻底删除「${shown?.scope === 'one' ? shown.entry.label : ''}」？`}
      message={shown?.scope === 'all' ? `${entries?.length ?? 0} 项将被永久删除，无法恢复。` : '删除后无法恢复。'}
      confirmText={shown?.scope === 'all' ? '清空回收站' : '彻底删除'}
      onConfirm={() => void confirmPurge()}
      onCancel={() => setPending(null)}
    />
  </div>;
}
