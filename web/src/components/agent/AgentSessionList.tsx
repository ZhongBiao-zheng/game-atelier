import { Button } from '@/components/ui/button';
import { CheckIcon, DeleteIcon } from '@/components/ui/icons';
import { Hint } from '@/components/ui/tooltip';
import type { CanvasAgentStatus } from '@/schema/canvas';

export interface AgentSessionListItem {
  session_id: string;
  title: string;
  status: CanvasAgentStatus;
  revision: number;
}

/**
 * 对话列表（画布 Agent 与创作台共用）：运行中的对话标一个圆点，悬停露出删除。
 * 删除一点就删、不确认，调用方负责撤销 toast（对话进回收站，规格 2.1）。
 * keep：不能删的对话（创作台的默认对话）。
 */
export function AgentSessionList({ sessions, currentId, disabled, keep, onSelect, onDelete }: {
  sessions: AgentSessionListItem[];
  currentId: string | null;
  disabled?: boolean;
  keep?: string;
  onSelect: (sessionId: string) => void;
  onDelete: (item: AgentSessionListItem) => void;
}) {
  if (sessions.length === 0) return <p className="px-2 py-2 text-xs text-muted-foreground">还没有对话</p>;
  return <div role="list" aria-label="对话列表" className="flex flex-col">
    {sessions.map(item => <div key={item.session_id} role="listitem" className="group relative">
      <Button variant="ghost" size="sm" disabled={disabled} aria-current={item.session_id === currentId || undefined}
        onClick={() => onSelect(item.session_id)}
        className="h-9 w-full justify-start gap-2 pr-9 font-normal">
        {item.status === 'running' && <Hint label="运行中…"><span aria-label="运行中" className="size-1.5 shrink-0 rounded-full bg-status-running" /></Hint>}
        <span className="min-w-0 flex-1 truncate text-left">{item.title}</span>
        {item.session_id === currentId && <CheckIcon size="sm" className="shrink-0" />}
      </Button>
      {item.session_id !== keep && <Hint label="删除对话"><Button variant="ghost" size="icon" disabled={disabled}
        aria-label={`删除对话 ${item.title}`} onClick={() => onDelete(item)}
        className="absolute right-0.5 top-0.5 size-8 opacity-0 transition-[opacity,background-color,color] duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <DeleteIcon size="sm" />
      </Button></Hint>}
    </div>)}
  </div>;
}
