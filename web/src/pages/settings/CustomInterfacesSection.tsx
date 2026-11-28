import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { deleteHttpProtocol, listHttpProtocols } from '@/api/httpProtocols';
import type { HttpProtocolKind, HttpProtocolRow } from '@/schema/httpProtocols';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { useRetained, useRetainedSession } from '@/components/ui/retained';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AddIcon, ChevronRightIcon, MoreIcon } from '@/components/ui/icons';
import { CustomInterfaceDialog } from './CustomInterfaceDialog';
import { errorText } from '@/lib/errorText';
import { MOTION_DURATION, MOTION_EASE, motionAvailable, prefersReducedMotion } from '@/lib/motion';

const KIND_LABELS = { image: '图片', video: '视频', audio: '音频' } as const;

/** 供应商页底部的自定义接口列表（ADR-0036）。没有模板时也保留标题与「新建」，入口不藏在供应商弹窗里。 */
export function CustomInterfacesSection() {
  const [rows, setRows] = useState<HttpProtocolRow[]>([]);
  const [editing, setEditing] = useState<HttpProtocolRow | null>(null);
  const [creating, setCreating] = useState<HttpProtocolKind | null>(null);
  const [deleting, setDeleting] = useState<HttpProtocolRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastError = useRef<string | null>(null);
  if (error) lastError.current = error;
  const canAnimate = motionAvailable();
  const reduced = prefersReducedMotion();
  // 弹窗关闭后沿用最后一份内容播完退场。
  const shownEditing = useRetainedSession(editing);
  const shownCreating = useRetainedSession(creating);
  const shownDeleting = useRetained(deleting);

  useEffect(() => {
    let active = true;
    const load = () => listHttpProtocols()
      .then(result => { if (active) setRows(result.protocols ?? []); })
      .catch(e => { if (active) setError(errorText(e)); });
    void load();
    window.addEventListener(KEYS_CHANGED_EVENT, load);
    return () => { active = false; window.removeEventListener(KEYS_CHANGED_EVENT, load); };
  }, []);

  const remove = async (row: HttpProtocolRow) => {
    setDeleting(null);
    setError(null);
    try {
      await deleteHttpProtocol(row.id);
      window.dispatchEvent(new Event(KEYS_CHANGED_EVENT));
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section aria-label="自定义接口" className="space-y-2 border-t border-border pt-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">自定义接口</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" size="sm" type="button" className="px-3"><AddIcon size="sm" aria-hidden />新建</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(Object.keys(KIND_LABELS) as HttpProtocolKind[]).map(kind => (
              <DropdownMenuItem key={kind} onSelect={() => setCreating(kind)}>{KIND_LABELS[kind]}接口</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Collapse open={Boolean(error)} appear>
        <p role="alert" className="text-sm text-destructive">{error ?? lastError.current}</p>
      </Collapse>
      <Collapse open={rows.length > 0}>
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          <AnimatePresence initial={false}>
            {rows.map(row => (
              <motion.li
                key={row.id}
                initial={canAnimate ? (reduced ? { opacity: 0 } : { opacity: 0, height: 0 }) : false}
                animate={canAnimate ? { opacity: 1, height: 'auto' } : undefined}
                exit={canAnimate ? (reduced
                  ? { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } }
                  : { opacity: 0, height: 0, transition: { duration: MOTION_DURATION.base, ease: MOTION_EASE.inOut } }) : undefined}
                transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE.out }}
                className="overflow-hidden"
              >
                {/* 与供应商行同一写法：整行点开编辑，删除收在行尾「更多」。 */}
                <div className="group/row flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-secondary/40">
                  <Button variant="bare" type="button" aria-label={`编辑 ${row.name}`} onClick={() => setEditing(row)}
                    className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                    <span className="block truncate text-sm">{row.name}</span>
                    <span className={`block text-xs ${row.available ? 'text-muted-foreground' : 'text-destructive'}`}>
                      {row.available
                        ? `${row.kind ? KIND_LABELS[row.kind] : ''} · ${row.used_by.length ? `${row.used_by.length} 个模型` : '未使用'}`
                        : row.error}
                    </span>
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" type="button" aria-label={`${row.name} 的更多操作`}
                      className="size-7 text-muted-foreground hover:text-foreground"><MoreIcon size="sm" aria-hidden /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem destructive disabled={row.used_by.length > 0} onSelect={() => setDeleting(row)}>
                        删除{row.used_by.length > 0 && <span className="ml-auto pl-3 text-xs text-muted-foreground">使用中</span>}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <span aria-hidden onClick={() => setEditing(row)} className="cursor-pointer p-1 text-muted-foreground transition-colors duration-150 group-hover/row:text-foreground">
                    <ChevronRightIcon size="sm" className="transition-transform duration-150 motion-safe:group-hover/row:translate-x-0.5" />
                  </span>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      </Collapse>
      {shownEditing && <CustomInterfaceDialog key={`edit-${shownEditing.session}`} open={Boolean(editing)}
        identifier={shownEditing.value.id} kind={shownEditing.value.kind ?? 'image'}
        onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
      {shownCreating && <CustomInterfaceDialog key={`create-${shownCreating.session}`} open={Boolean(creating)}
        identifier={null} kind={shownCreating.value}
        onClose={() => setCreating(null)} onSaved={() => setCreating(null)} />}
      {shownDeleting && <ConfirmDialog open={Boolean(deleting)} title={`删除「${shownDeleting.name}」？`} message="删除后不能恢复。"
        confirmText="删除" variant="destructive" onConfirm={() => void remove(shownDeleting)} onCancel={() => setDeleting(null)} />}
    </section>
  );
}
