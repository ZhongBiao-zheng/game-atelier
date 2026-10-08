import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUp, Brain, Check, ChevronDown, FileImage, FileText, FileVideo, Loader2, Paperclip,
  ShieldCheck, Square, SquarePen, Wrench, X, Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { CanvasAgentMessage } from '@/schema/canvas';
import { CanvasAgentModelPicker } from './CanvasAgentModelPicker';
import { useCanvasAgent } from './useCanvasAgent';

export interface CanvasAgentNodeRef {
  id: string;
  title: string;
  type: string;
}

// 与服务端 canvas_agent_runtime.READ_LABELS 同名同字：只读工具的消息正文就是这个标签，相同则不重复显示。
const TOOL_LABELS: Record<string, string> = {
  get_canvas: '读取画布',
  list_models: '查看可用模型',
  apply_changes: '修改画布',
  run_generation: '生成',
  get_run: '查询生成进度',
  read_media: '读取媒体信息',
};

const ICON_BUTTON = 'grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40';

function NodeIcon({ type }: { type: string }) {
  if (type === 'image') return <FileImage className="size-3.5 shrink-0" />;
  if (type === 'video') return <FileVideo className="size-3.5 shrink-0" />;
  return <FileText className="size-3.5 shrink-0" />;
}

function Message({ message }: { message: CanvasAgentMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-secondary px-3 py-2 text-sm">{message.text}</p>
        {message.references.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1">
            {message.references.map(ref => (
              <span key={ref.reference_id} className="truncate rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{ref.title}</span>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (message.role === 'tool') {
    const label = TOOL_LABELS[message.title ?? ''] ?? message.title;
    return (
      <div className="flex gap-2 text-xs text-muted-foreground">
        <Wrench className="mt-0.5 size-3.5 shrink-0" />
        <p className="min-w-0 whitespace-pre-line break-words">
          <span className="text-foreground/80">{label}</span>
          {message.text && message.text !== label && <span className="ml-1.5">{message.text}</span>}
        </p>
      </div>
    );
  }
  if (message.role === 'error') {
    return <p role="alert" className="text-xs text-destructive">{message.text}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {message.reasoning_summary && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">思考过程</summary>
          <p className="mt-1 whitespace-pre-wrap break-words border-l border-border pl-2">{message.reasoning_summary}</p>
        </details>
      )}
      {message.text && <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>}
    </div>
  );
}

export function CanvasAgentPanel({ projectId, selectedNodes, onClose, onUpload, className }: {
  projectId: string;
  /** 画布当前选中的节点：自动带进下一条消息，可逐个移除。 */
  selectedNodes: CanvasAgentNodeRef[];
  onClose: () => void;
  onUpload: () => void;
  className?: string;
}) {
  const agent = useCanvasAgent(projectId, true);
  const { session, streaming, activeTool, pending } = agent;
  const [text, setText] = useState('');
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const status = session?.status ?? 'idle';
  const running = status === 'running';
  const awaiting = status === 'awaiting_approval';
  const attached = selectedNodes.filter(node => !dismissed.has(node.id));
  const messages = session?.messages ?? [];
  // 没有会话时显示本地草稿设置（发第一条消息时写进新会话）。
  const settings = session ?? agent.draft;
  const modelAlias = settings.model_alias ?? null;
  const modelId = settings.model ?? null;
  const selectedModel = agent.models?.models.find(item => item.alias === modelAlias && item.model === modelId);
  const thinkingOn = Boolean(settings.effort && settings.effort !== 'off');
  const autoMode = settings.permission_mode === 'auto';

  // 选中的节点变了：之前移除过的不再记着，免得重新选中却带不进来。
  const selectionKey = selectedNodes.map(node => node.id).join(',');
  useEffect(() => { setDismissed(new Set()); }, [selectionKey]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length, streaming, status]);

  const canSend = text.trim().length > 0 && !running && !awaiting && !pending;

  async function submit() {
    if (!canSend) return;
    const sent = await agent.send(text.trim(), attached.map(node => node.id));
    if (!sent) return;
    setText('');
    // 发出去的节点不再自动带进下一条；重新选中才会再带。
    setDismissed(new Set(selectedNodes.map(node => node.id)));
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  return (
    <aside
      id="canvas-agent-panel"
      aria-label="画布 Agent"
      className={cn('fixed bottom-56 right-4 top-24 z-40 flex w-[min(25rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover shell-glow', className)}
    >
      <header className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-secondary">
              <span className="truncate">{session?.title ?? '新对话'}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
            {agent.sessions.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">还没有对话</p>}
            {agent.sessions.map(item => (
              <DropdownMenuItem key={item.session_id} onSelect={() => void agent.selectSession(item.session_id)} className="gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.session_id === session?.session_id && <Check className="size-3.5 shrink-0" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" title="新对话" aria-label="新对话" disabled={pending || running} onClick={() => void agent.newSession()} className={ICON_BUTTON}><SquarePen className="size-4" /></button>
        <button type="button" title="关闭" aria-label="关闭 Agent" onClick={onClose} className={ICON_BUTTON}><X className="size-4" /></button>
      </header>

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {messages.map(message => <Message key={message.message_id} message={message} />)}
        {running && streaming && <p className="whitespace-pre-wrap break-words text-sm">{streaming}</p>}
        {running && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-label="Agent 正在处理" className="size-3.5 animate-spin" />
            {activeTool && `${TOOL_LABELS[activeTool] ?? activeTool}…`}
          </p>
        )}
        {awaiting && session && (
          <div className="flex flex-col gap-2 rounded-lg border border-primary/40 p-3">
            {session.pending_approvals.map(item => (
              <div key={item.call_id} className="text-xs">
                <p className="font-medium text-foreground">{TOOL_LABELS[item.tool] ?? item.tool}</p>
                <p className="mt-0.5 whitespace-pre-line break-words text-muted-foreground">{item.summary}</p>
              </div>
            ))}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => void agent.decide(false)}>拒绝</Button>
              <Button size="sm" disabled={pending} onClick={() => void agent.decide(true)}>执行</Button>
            </div>
          </div>
        )}
      </div>

      {agent.error && (
        <p role="alert" className="mx-3 mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          <span className="min-w-0 flex-1 break-words">{agent.error}</span>
          <button type="button" aria-label="关闭提示" onClick={agent.clearError}><X className="size-3.5" /></button>
        </p>
      )}

      <div className="m-2 mt-0 rounded-xl border border-border bg-background/60 focus-within:border-primary/60">
        {attached.length > 0 && (
          <div className="flex flex-wrap gap-1 px-2 pt-2">
            {attached.map(node => (
              <span key={node.id} className="flex max-w-[10rem] items-center gap-1 rounded-full border border-border py-0.5 pl-2 pr-1 text-xs text-muted-foreground">
                <NodeIcon type={node.type} />
                <span className="truncate">{node.title}</span>
                <button type="button" aria-label={`不带入 ${node.title}`} onClick={() => setDismissed(current => new Set(current).add(node.id))} className="rounded-full p-0.5 hover:bg-secondary hover:text-foreground"><X className="size-3" /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="描述你想在画布上做什么"
          aria-label="给 Agent 的消息"
          className="block max-h-48 min-h-[4.5rem] w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <button type="button" title="上传素材" aria-label="上传素材" onClick={onUpload} className={ICON_BUTTON}><Paperclip className="size-4" /></button>
          <CanvasAgentModelPicker
            models={agent.models}
            alias={modelAlias}
            model={modelId}
            disabled={running || pending}
            onSelect={choice => void agent.updateSettings({ model: choice.model, model_alias: choice.alias })}
          />
          <button
            type="button"
            title={selectedModel?.reasoning === false ? '该模型不支持思考' : thinkingOn ? '思考：开' : '思考：关'}
            aria-label="思考模式"
            aria-pressed={thinkingOn}
            disabled={running || pending || selectedModel?.reasoning === false}
            onClick={() => void agent.updateSettings({ effort: thinkingOn ? 'off' : 'high' })}
            className={cn(ICON_BUTTON, thinkingOn && 'text-primary')}
          ><Brain className="size-4" /></button>
          <button
            type="button"
            title={autoMode ? 'Auto：新增内容自动执行，改动已有内容才确认' : '审查：每一步都先确认'}
            aria-label="权限模式"
            disabled={running || pending}
            onClick={() => void agent.updateSettings({ permission_mode: autoMode ? 'review' : 'auto' })}
            className="flex h-8 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            {autoMode ? <Zap className="size-3.5 text-primary" /> : <ShieldCheck className="size-3.5" />}
            {autoMode ? 'Auto' : '审查'}
          </button>
          <span className="flex-1" />
          {running ? (
            <button type="button" title="停止" aria-label="停止" onClick={() => void agent.stop()} className="grid size-8 place-items-center rounded-full bg-secondary text-foreground hover:bg-secondary/80"><Square className="size-3.5 fill-current" /></button>
          ) : (
            <button type="button" title="发送" aria-label="发送" disabled={!canSend} onClick={() => void submit()} className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"><ArrowUp className="size-4" /></button>
          )}
        </div>
      </div>
    </aside>
  );
}
