import { useRef, useState } from 'react';
import { restoreTrash } from '@/api/trash';
import { Button } from '@/components/ui/button';
import { ChevronDownIcon, DeleteIcon, EditIcon, NewChatIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Hint } from '@/components/ui/tooltip';
import { errorText } from '@/lib/errorText';
import { notify } from '@/lib/notify';
import { shakeOnError } from '@/lib/motion';
import { DEFAULT_STUDIO_SESSION_ID } from '@/pages/studioDraft';
import type { StudioComposerState } from './StudioComposer';
import { ToolbarPopover } from './ToolbarPopover';

const DEFAULT_TITLE = '默认对话';
const DEFAULT_PLACEHOLDER_TITLES = new Set(['', '默认会话', '默认对话', '新对话']);

function displayTitle(id: string, title: string): string {
  if (id === DEFAULT_STUDIO_SESSION_ID && DEFAULT_PLACEHOLDER_TITLES.has(title.trim())) {
    return DEFAULT_TITLE;
  }
  return title;
}

/** 切换对话不清输入：每段对话的草稿由创作台按会话存取。 */
export function StudioSessionControls({ agent, disabled = false }: {
  agent: StudioComposerState['agent']; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; scope: 'header' | 'list'; draft: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // 改名请求期间先显示新名；删除点下就藏起那一行，失败再放回。
  const [pendingTitle, setPendingTitle] = useState<{ id: string; title: string } | null>(null);
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<HTMLButtonElement>(null);
  const busy = disabled || agent.pending;
  function newChat() {
    setEditing(null);
    agent.newSession();
    setOpen(false);
  }
  function startRename(id: string, currentTitle: string, scope: 'header' | 'list') {
    setEditing({ id, scope, draft: displayTitle(id, currentTitle) });
  }
  async function commitRename() {
    if (!editing || saving) return;
    const { id, draft } = editing;
    const trimmed = draft.trim();
    const original = agent.sessions.find(s => s.session_id === id)?.title
      ?? (agent.session?.session_id === id ? agent.session.title : '');
    setEditing(null);
    if (!trimmed || trimmed === displayTitle(id, original)) return;
    setSaving(true);
    setPendingTitle({ id, title: trimmed });
    try {
      await agent.renameSession(id, trimmed);
    } catch (error) {
      notify.error(errorText(error, '重命名失败'));
      shakeOnError(anchor.current);
    } finally {
      setSaving(false);
      setPendingTitle(null);
    }
  }
  // 删除不确认：对话进回收站，作品留在默认对话，给 8 秒撤销。
  async function remove(sessionId: string, revision: number) {
    setHiddenIds(ids => new Set(ids).add(sessionId));
    const trashId = await agent.removeSession(sessionId, revision);
    setHiddenIds(ids => { const next = new Set(ids); next.delete(sessionId); return next; });
    // undefined：删除失败（报错由 agent.error 显示），行已放回；null：没进回收站，无从撤销。
    if (!trashId) return;
    notify.undo('已删除对话，作品已移至默认对话', () => {
      void restoreTrash(trashId)
        .then(() => agent.selectSession(sessionId))
        .catch(error => notify.error(errorText(error)));
    });
  }
  const current = agent.session ?? agent.sessions.find(s => s.session_id === agent.selectedSessionId);
  const shownTitle = (id: string, value: string) => pendingTitle?.id === id ? pendingTitle.title : displayTitle(id, value);
  const title = current ? shownTitle(current.session_id, current.title)
    : agent.selectedSessionId === DEFAULT_STUDIO_SESSION_ID ? DEFAULT_TITLE : '新对话';
  const canRenameCurrent = Boolean(current) && !busy && !saving;

  return <div className="pointer-events-auto flex min-w-0 items-center gap-2">
    <Hint label="新对话"><Button variant="ghost" aria-label="新对话" disabled={busy} onClick={newChat}
      className="h-9 shrink-0 gap-1.5 rounded-full border border-primary/45 bg-primary/14 px-2.5 text-sm font-medium text-foreground hover:bg-primary/22 sm:pl-3 sm:pr-3.5">
      <NewChatIcon /><span className="max-sm:hidden">新对话</span></Button></Hint>
    {editing?.scope === 'header' ? (
      <Input
        autoFocus
        aria-label="编辑对话名称"
        value={editing.draft}
        onChange={event => setEditing(cur => cur ? { ...cur, draft: event.target.value } : null)}
        onBlur={() => void commitRename()}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void commitRename(); }
          if (event.key === 'Escape') { event.preventDefault(); setEditing(null); }
        }}
        className="h-9 w-48 text-sm font-medium"
      />
    ) : (
      <div className="group/title flex min-w-0 items-center gap-0.5">
        <Button ref={anchor} variant="ghost" aria-label="切换对话" aria-expanded={open}
          className="h-9 min-w-0 shrink gap-1 rounded-full px-2 text-base font-semibold" onClick={() => setOpen(!open)}>
          <span className="max-w-60 truncate">{title}</span><ChevronDownIcon size="sm" className="text-muted-foreground" />
        </Button>
        {canRenameCurrent && current && (
          <Hint label="重命名当前对话">
            <Button
              variant="ghost"
              size="icon"
              aria-label="重命名当前对话"
              onClick={() => startRename(current.session_id, current.title, 'header')}
              className="size-8 shrink-0 rounded-full text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-150 hover:text-foreground group-hover/title:opacity-100 group-focus-within/title:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <EditIcon size="sm" />
            </Button>
          </Hint>
        )}
      </div>
    )}
    <ToolbarPopover open={open} onClose={() => { setOpen(false); if (editing?.scope === 'list') setEditing(null); }}
      onEscapeKeyDown={event => {
        // 行内编辑先处理 Escape，避免弹层移回焦点触发失焦保存。
        if (editing?.scope === 'list') event.preventDefault();
      }}
      anchorRef={anchor} direction="down" autoFocus
      aria-label="对话列表" className="w-64 rounded-xl border border-border bg-card p-2" maxHeight={360}>
      <Button variant="ghost" size="sm" className="h-10 w-full justify-start" disabled={busy} onClick={newChat}>
        <NewChatIcon size="sm" />新对话
      </Button>
      {agent.sessions.filter(item => !hiddenIds.has(item.session_id)).map(item => {
        const label = shownTitle(item.session_id, item.title);
        const isEditingRow = editing?.scope === 'list' && editing.id === item.session_id;
        return (
          <div key={item.session_id} className="group relative">
            {isEditingRow ? (
              <div className="p-1">
                <Input
                  autoFocus
                  aria-label={`重命名 ${label}`}
                  value={editing.draft}
                  onChange={event => setEditing(cur => cur ? { ...cur, draft: event.target.value } : null)}
                  onBlur={() => void commitRename()}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void commitRename(); }
                    if (event.key === 'Escape') { event.preventDefault(); setEditing(null); }
                  }}
                  className="h-8 text-sm"
                />
              </div>
            ) : (
              <>
                <Button variant="ghost" size="sm" disabled={busy} aria-pressed={item.session_id === agent.selectedSessionId}
                  className={item.session_id === DEFAULT_STUDIO_SESSION_ID
                    ? 'h-10 w-full justify-start truncate pr-9 aria-pressed:bg-secondary aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-primary/60'
                    : 'h-10 w-full justify-start truncate pr-16 aria-pressed:bg-secondary aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-primary/60'}
                  onClick={() => { void agent.selectSession(item.session_id); setOpen(false); }}>
                  {item.status === 'running' && <span aria-label="运行中" className="size-1.5 shrink-0 rounded-full bg-status-running" />}
                  <span className="truncate">{label}</span>
                </Button>
                <div className="absolute right-1 top-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                  <Hint label="重命名对话"><Button variant="ghost" size="icon" disabled={busy || saving}
                    aria-label={`重命名对话 ${label}`} onClick={() => startRename(item.session_id, item.title, 'list')}
                    className="size-8">
                    <EditIcon size="sm" /></Button></Hint>
                  {item.session_id !== DEFAULT_STUDIO_SESSION_ID && <Hint label="删除对话"><Button variant="ghost" size="icon" disabled={busy}
                    aria-label={`删除对话 ${item.title}`} onClick={() => void remove(item.session_id, item.revision)}
                    className="size-8">
                    <DeleteIcon size="sm" /></Button></Hint>}
                </div>
              </>
            )}
          </div>
        );
      })}
    </ToolbarPopover>
  </div>;
}
