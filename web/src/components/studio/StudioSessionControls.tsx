import { useRef, useState } from 'react';
import { listTrash, restoreTrash } from '@/api/trash';
import { Button } from '@/components/ui/button';
import { ChevronDownIcon, DeleteIcon, NewChatIcon } from '@/components/ui/icons';
import { Hint } from '@/components/ui/tooltip';
import { errorText } from '@/lib/errorText';
import { notify } from '@/lib/notify';
import { DEFAULT_STUDIO_SESSION_ID } from '@/pages/studioDraft';
import type { StudioComposerState } from './StudioComposer';
import { ToolbarPopover } from './ToolbarPopover';

const DEFAULT_TITLE = '默认对话';

/** 切换对话不清输入：每段对话的草稿由创作台按会话存取。 */
export function StudioSessionControls({ agent, disabled = false }: {
  agent: StudioComposerState['agent']; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const busy = disabled || agent.pending;
  function newChat() {
    agent.newSession();
    setOpen(false);
  }
  // 删除不确认：对话进回收站，作品留在默认对话，给 8 秒撤销。
  async function remove(sessionId: string, revision: number) {
    await agent.removeSession(sessionId, revision);
    const entry = await listTrash()
      .then(items => items.find(item => item.kind === 'conversation' && item.meta.session_id === sessionId))
      .catch(() => undefined);
    if (!entry) return;
    notify.undo('已删除对话，作品已移至默认对话', () => {
      void restoreTrash(entry.trash_id)
        .then(() => agent.selectSession(sessionId))
        .catch(error => notify.error(errorText(error)));
    });
  }
  const titleOf = (id: string, title: string) => id === DEFAULT_STUDIO_SESSION_ID ? DEFAULT_TITLE : title;
  const current = agent.session ?? agent.sessions.find(s => s.session_id === agent.selectedSessionId);
  const title = current ? titleOf(current.session_id, current.title)
    : agent.selectedSessionId === DEFAULT_STUDIO_SESSION_ID ? DEFAULT_TITLE : '新对话';
  return <div className="pointer-events-auto flex min-w-0 items-center gap-3">
    <Hint label="新对话"><Button variant="ghost" aria-label="新对话" disabled={busy} onClick={newChat}
      className="h-9 shrink-0 gap-1.5 rounded-full border border-primary/45 bg-primary/14 px-2.5 text-sm font-medium text-foreground hover:bg-primary/22 sm:pl-3 sm:pr-3.5">
      <NewChatIcon /><span className="max-sm:hidden">新对话</span></Button></Hint>
    <Button ref={anchor} variant="ghost" aria-label="切换对话" aria-expanded={open}
      className="h-9 min-w-0 shrink gap-1 rounded-full px-2 text-base font-semibold" onClick={() => setOpen(!open)}>
      <span className="max-w-60 truncate">{title}</span><ChevronDownIcon size="sm" className="text-muted-foreground" />
    </Button>
    <ToolbarPopover open={open} onClose={() => setOpen(false)} anchorRef={anchor} direction="down" autoFocus
      aria-label="对话列表" className="w-60 rounded-xl border border-border bg-card p-2" maxHeight={360}>
      <Button variant="ghost" size="sm" className="h-10 w-full justify-start" disabled={busy} onClick={newChat}>
        <NewChatIcon size="sm" />新对话
      </Button>
      {agent.sessions.map(item => <div key={item.session_id} className="group relative">
        <Button variant="ghost" size="sm" disabled={busy} aria-pressed={item.session_id === agent.selectedSessionId}
          className="h-10 w-full justify-start truncate pr-9 aria-pressed:bg-secondary aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-primary/60"
          onClick={() => { void agent.selectSession(item.session_id); setOpen(false); }}>
          {item.status === 'running' && <span aria-label="运行中" className="size-1.5 shrink-0 rounded-full bg-status-running" />}
          <span className="truncate">{titleOf(item.session_id, item.title)}</span>
        </Button>
        {item.session_id !== DEFAULT_STUDIO_SESSION_ID && <Hint label="删除对话"><Button variant="ghost" size="icon" disabled={busy}
          aria-label={`删除对话 ${item.title}`} onClick={() => void remove(item.session_id, item.revision)}
          className="absolute right-1 top-1 size-8 opacity-0 transition-[opacity,background-color,color] duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <DeleteIcon size="sm" /></Button></Hint>}
      </div>)}
    </ToolbarPopover>
  </div>;
}
