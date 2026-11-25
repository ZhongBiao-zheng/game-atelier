import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AgentProcessToggle } from '@/components/agent/AgentProcessToggle';
import { AgentMarkdown, AgentStreamingMarkdown, agentToolStatusLabel, useAgentToolLabels } from '@/components/agent/AgentMarkdown';
import { AgentSuggestions, parseAgentReply } from '@/components/agent/AgentSuggestions';
import { ArrowUpIcon, AttachIcon, CheckIcon, ChevronDownIcon, CloseIcon, ErrorIcon, ImageFileIcon, LoadingIcon, NewChatIcon, SkillIcon, StopIcon, TextFileIcon, ThinkingIcon, ToolIcon, VideoFileIcon } from '@/components/ui/icons';
import { canvasMediaUrl, getCanvasAgentBatchItems } from '@/api/canvas';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { CanvasAgentCreationMode, CanvasAgentMessage } from '@/schema/canvas';
import { CanvasAgentApprovalCard } from '@/components/agent/CanvasAgentApprovalCard';
import { CanvasAgentPlanList } from '@/components/agent/CanvasAgentPlanList';
import { CanvasAgentModeMenu } from '@/components/agent/CanvasAgentModeMenu';
import { CanvasAgentPermissionMenu } from '@/components/agent/CanvasAgentPermissionMenu';
import { agentUsageLabel } from '@/components/agent/canvasAgentUsage';
import { CanvasAgentModelPicker } from '@/components/agent/CanvasAgentModelPicker';
import { CanvasAgentPreferencePicker } from '@/components/agent/CanvasAgentPreferencePicker';
import { CanvasAgentReferenceThumb } from './CanvasAgentReferenceThumb';
import { buildCanvasAgentTimeline, isOutgoingMessage } from '@/components/agent/canvasAgentTimeline';
import { canvasAgentSetupNotice } from '@/components/agent/canvasAgentSetupNotice';
import { AGENT_PANEL_MAX_WIDTH, AGENT_PANEL_MIN_WIDTH, useAgentPanelWidth } from './useAgentPanelWidth';
import { CanvasAgentSkillPicker } from '@/components/agent/CanvasAgentSkillPicker';
import { useCanvasAgent } from '@/components/agent/useWorkspaceAgent';
import { Collapse } from '@/components/ui/collapse';
import { SwapIcon } from '@/components/ui/swap-icon';
import { SwapLabel } from '@/components/ui/swap-label';
import { Textarea } from '@/components/ui/textarea';
import { Hint } from '@/components/ui/tooltip';
import {
  animate, clearOnFinish, MOTION_DURATION, MOTION_EASE, prefersReducedMotion, useAnimateOnChange,
} from '@/lib/motion';

export interface CanvasAgentNodeRef {
  id: string;
  title: string;
  type: string;
  /** 图片节点的当前版本：有就显示缩略图。 */
  versionId?: string | null;
}

const ICON_BUTTON = 'grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40';

function NodeIcon({ type }: { type: string }) {
  if (type === 'image') return <ImageFileIcon size="sm" className="shrink-0" />;
  if (type === 'video') return <VideoFileIcon size="sm" className="shrink-0" />;
  return <TextFileIcon size="sm" className="shrink-0" />;
}

/** 空对话里的示例需求：点一下填进输入框（不直接发送，生成要花钱）。 */
const PRESETS: Record<CanvasAgentCreationMode, string[]> = {
  all: ['生成一只像素风格的小狗', '设计一个赛博朋克风格的女性角色立绘', '把选中的图片做成 5 秒的动态视频'],
  image: ['生成一只像素风格的小狗', '设计一组奇幻 RPG 的道具图标', '为选中的角色画正面、侧面、背面三视图'],
  video: ['把选中的图片做成 5 秒的动态视频', '生成一段像素风小狗奔跑的循环动画', '做一个角色登场的 5 秒镜头'],
};

/** 显示宽度 = 缩略图格子宽（w-20 = 80px）的 2 倍，留给高分屏。 */
const THUMB_DISPLAY_WIDTH = 160;

/** 列表距底不到这么多时算「在底部」：流式输出与新消息只在这时自动贴底，往上翻过就不再拽回来。 */
const STICK_TO_BOTTOM_PX = 24;

/** 没有 matchMedia 的环境（jsdom）不播 vanilla animate，与 lib/motion 的约定一致。 */
function motionAvailable() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/** 新到达的一项（不是打开面板、切会话时已有的历史）挂载时轻轻淡入并上移 4px；减弱动态效果时只淡入。 */
function useArrival<T extends HTMLElement>(arriving: boolean) {
  const ref = useRef<T>(null);
  const arrivingOnMount = useRef(arriving);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!arrivingOnMount.current || !element || !motionAvailable()) return;
    const keyframes = prefersReducedMotion() ? { opacity: [0, 1] } : { opacity: [0, 1], y: [4, 0] };
    clearOnFinish(animate(element, keyframes, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }), element);
  }, []);
  return ref;
}

function ProcessImages({ projectId, images }: { projectId: string; images: CanvasAgentMessage['references'] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {images.map(ref => (
        <img
          key={ref.reference_id}
          src={canvasMediaUrl(projectId, ref.version_id!, THUMB_DISPLAY_WIDTH)}
          alt={ref.title}
          loading="lazy"
          className="size-20 rounded-md border border-border object-cover"
        />
      ))}
    </div>
  );
}

/** 已结束一轮的中间过程：默认收起成一行，可展开；生成出的图收起时也露在外面。
 *  一轮刚结束时（arriving）这一行从 0 高度展开出来，不整块冒出。 */
const ProcessGroup = memo(function ProcessGroup({ projectId, messages, steps, arriving }: {
  projectId: string;
  messages: CanvasAgentMessage[];
  steps: number;
  arriving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(!arriving);
  useEffect(() => { setEntered(true); }, []);
  const images = messages.flatMap(message => message.role === 'tool'
    ? message.references.filter(ref => ref.kind === 'content' && ref.version_id) : []);
  return (
    <Collapse open={entered}>
      <div className="flex flex-col gap-2">
        <AgentProcessToggle label={`处理过程 · ${steps} 步`} open={open} onToggle={() => setOpen(value => !value)} />
        <Collapse open={open}>
          <div className="flex flex-col gap-3 border-l border-border pl-3">
            {messages.map(message => <Message key={message.message_id} projectId={projectId} message={message} arriving={false} />)}
          </div>
        </Collapse>
        {images.length > 0 && (
          <Collapse open={!open}>
            <ProcessImages projectId={projectId} images={images} />
          </Collapse>
        )}
      </div>
    </Collapse>
  );
});

/** memo：流式输出每来一块面板都会重渲染，历史消息的引用不变就跳过，不重新解析 Markdown。 */
const Message = memo(function Message({ projectId, message, arriving }: {
  projectId: string;
  message: CanvasAgentMessage;
  arriving: boolean;
}) {
  const labels = useAgentToolLabels();
  const ref = useArrival<HTMLDivElement>(arriving);
  if (message.role === 'user') {
    // 刚发出、服务端还没收下：先半透明显示，收下后换成正式的那条。
    const sending = isOutgoingMessage(message);
    return (
      <div ref={ref} aria-busy={sending || undefined} className={cn('flex flex-col items-end gap-1 transition-opacity', sending && 'opacity-60')}>
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-secondary px-3 py-2 text-sm">{message.text}</p>
        {message.title && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground"><SkillIcon size="sm" />{message.title}</span>
        )}
        {message.references.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap items-center justify-end gap-1.5">
            {message.references.map(ref => ref.version_id ? (
              <CanvasAgentReferenceThumb
                key={ref.reference_id}
                projectId={projectId}
                nodeId={ref.node_id ?? ref.reference_id}
                versionId={ref.version_id}
                title={ref.title}
              />
            ) : (
              <span key={ref.reference_id} className="truncate rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{ref.title}</span>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (message.role === 'tool') {
    const label = labels[message.title ?? ''] ?? message.title;
    const images = message.references.filter(ref => ref.kind === 'content' && ref.version_id);
    return (
      <div ref={ref} className="flex gap-2 text-xs text-muted-foreground">
        <ToolIcon size="sm" className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-line break-words">
            <span className="text-foreground/80">{label}</span>
            {message.text && message.text !== label && <span className="ml-1.5">{message.text}</span>}
          </p>
          {images.length > 0 && (
            <div className="mt-1.5">
              <ProcessImages projectId={projectId} images={images} />
            </div>
          )}
        </div>
      </div>
    );
  }
  if (message.role === 'error') {
    return <p ref={ref} role="alert" className="text-xs text-destructive">{message.text}</p>;
  }
  if (message.role === 'system') {
    return <p ref={ref} className="text-xs text-muted-foreground">{message.text}</p>;
  }
  return (
    <div ref={ref} className="flex flex-col gap-1">
      {message.reasoning_summary && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">思考过程</summary>
          <p className="mt-1 whitespace-pre-wrap break-words border-l border-border pl-2">{message.reasoning_summary}</p>
        </details>
      )}
      {message.text && <AgentMarkdown text={parseAgentReply(message.text).body} />}
    </div>
  );
});

/** 一轮刚结束：最后一段流式文字盖在最终回复上同位淡出，最终回复淡入（底边对齐——流式文字的末段就是最终回复）。 */
function SettlingReply({ streamed, children }: { streamed: string; children: ReactNode }) {
  const replyRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!replyRef.current || !streamRef.current) return;
    clearOnFinish(animate(replyRef.current, { opacity: [0, 1] }, { duration: MOTION_DURATION.base, ease: MOTION_EASE.out }), replyRef.current);
    animate(streamRef.current, { opacity: [1, 0] }, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle });
  }, []);
  return (
    <div className="grid">
      <div ref={replyRef} className="col-start-1 row-start-1 self-end">{children}</div>
      <div ref={streamRef} aria-hidden="true" className="pointer-events-none col-start-1 row-start-1 self-end">
        <AgentMarkdown text={parseAgentReply(streamed).body || streamed} />
      </div>
    </div>
  );
}

export function CanvasAgentPanel({ projectId, selectedNodes, onClose, onUpload, onOpenKeySettings, className }: {
  projectId: string;
  /** 画布当前选中的节点：自动带进下一条消息，可逐个移除。 */
  selectedNodes: CanvasAgentNodeRef[];
  onClose: () => void;
  onUpload: () => void;
  /** 缺模型时「去设置」：跳到设置页的 Key 区块。 */
  onOpenKeySettings: () => void;
  className?: string;
}) {
  const labels = useAgentToolLabels();
  const agent = useCanvasAgent(projectId, true);
  const { session, streaming, tool, pending, loading, outgoing } = agent;
  const [text, setText] = useState('');
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [skill, setSkill] = useState<string | null>(null);
  const { width: panelWidth, startResize, resizeByKey } = useAgentPanelWidth();
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
  // 草稿里没设过权限时跟服务端默认一致：Auto。
  const autoMode = (settings.permission_mode ?? 'auto') === 'auto';
  const creationMode = settings.creation_mode ?? 'all';
  const setupNotice = canvasAgentSetupNotice({
    chatModels: agent.models?.models ?? null,
    generationModels: agent.generationModels,
    mode: creationMode,
    auto: settings.auto_models ?? true,
    preferred: settings.preferred_models ?? [],
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 正在读会话时既不是空对话也不是新内容：旧内容留着（降透明度），读完才决定显示什么。
  const empty = !loading && messages.length === 0 && !running && !awaiting && !outgoing;
  // 刚发出、服务端还没收下（消息显示为「发送中」）：底部先转起来。
  const sending = Boolean(outgoing) || messages.some(isOutgoingMessage);
  // 只有会话正常停下、最后一条是 Agent 回复时，才显示它末尾的推荐追问。
  const lastMessage = status === 'idle' ? messages.at(-1) : undefined;
  const suggestions = lastMessage?.role === 'assistant' ? parseAgentReply(lastMessage.text).suggestions : [];
  const usageLabel = session ? agentUsageLabel(agent.usage) : null;

  // 选中的节点变了：之前移除过的不再记着，免得重新选中却带不进来。
  const selectionKey = selectedNodes.map(node => node.id).join(',');
  useEffect(() => { setDismissed(new Set()); }, [selectionKey]);

  // 贴底：只有本来就在底部（距底 < 24px）时，新消息、流式文字、底部报错条或附件挤矮列表，才把列表拉回底部；
  // 往上翻看过的不拽回来。
  const stickToBottom = useRef(true);
  const followBottom = useCallback(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, []);
  useLayoutEffect(followBottom);
  // 列表变矮（底部报错条、附件出现）或内容变高（过程组展开、图片加载）都要跟住底部。
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const content = contentRef.current;
    if (!list || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(followBottom);
    observer.observe(list);
    observer.observe(content);
    return () => observer.disconnect();
  }, [followBottom]);

  // 读完会话（打开面板恢复上次的、或切到另一个会话）：列表整体淡入新内容，回到底部。
  useAnimateOnChange(loading, stillLoading => {
    const list = listRef.current;
    if (stillLoading || !list) return;
    stickToBottom.current = true;
    followBottom();
    clearOnFinish(animate(list, { opacity: [0, 1] }, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }), list, ['opacity']);
  }, { keepWhenReduced: true });

  // 哪些消息是新到达的：打开面板、切会话时已有的历史不算，只给之后到达的播入场。
  // 服务端收下的用户消息不算新到达——它刚以「发送中」出现过。
  const sessionKey = session?.session_id ?? 'draft';
  const seen = useRef<{ sessionKey: string; ids: Set<string> } | null>(null);
  const arriving = (message: CanvasAgentMessage) => seen.current?.sessionKey === sessionKey
    && !seen.current.ids.has(message.message_id)
    && (message.role !== 'user' || isOutgoingMessage(message));
  useLayoutEffect(() => {
    if (loading) return;
    const ids = new Set(messages.map(message => message.message_id));
    if (outgoing) ids.add(outgoing.id);
    seen.current = { sessionKey, ids };
  });

  // 一轮结束：流式文字与最终回复同位交叉淡化（见 SettlingReply）。
  const lastStreamed = useRef('');
  useEffect(() => { if (running && streaming) lastStreamed.current = streaming; }, [running, streaming]);
  const [settling, setSettling] = useState<{ text: string; messageId: string } | null>(null);
  useAnimateOnChange(running, (nowRunning, _was, reduced) => {
    const streamed = lastStreamed.current;
    lastStreamed.current = '';
    const final = messages.at(-1);
    if (nowRunning || reduced || !streamed || final?.role !== 'assistant') return;
    setSettling({ text: streamed, messageId: final.message_id });
  });
  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => setSettling(null), MOTION_DURATION.base * 1000);
    return () => window.clearTimeout(timer);
  }, [settling]);

  // 列表读到之后，只有列表里的模型能发（Key 里停用的文本模型不再可用）。
  const modelReady = !agent.models || Boolean(selectedModel);
  const canSend = text.trim().length > 0 && !running && !awaiting && !pending && modelReady;

  /** 发出去立刻清空输入、回到底部，消息先以「发送中」出现；失败时把文字、技能、带入的节点填回去
   *  （期间又打了字就不覆盖）。 */
  async function submit() {
    if (!canSend) return;
    const message = text.trim();
    const sentSkill = skill;
    const sentDismissed = dismissed;
    setText('');
    setSkill(null);
    // 发出去的节点不再自动带进下一条；重新选中才会再带。
    setDismissed(new Set(selectedNodes.map(node => node.id)));
    stickToBottom.current = true;
    const sent = await agent.send(message, attached.map(node => node.id), sentSkill);
    if (sent) return;
    setText(current => current || message);
    setSkill(current => current ?? sentSkill);
    setDismissed(sentDismissed);
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
      className={cn('fixed bottom-56 right-4 top-24 z-40 flex flex-col overflow-hidden rounded-xl border border-border bg-popover shell-glow', className)}
      style={{ width: `min(${panelWidth}px, calc(100vw - 2rem))` }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整 Agent 面板宽度"
        aria-valuenow={panelWidth}
        aria-valuemin={AGENT_PANEL_MIN_WIDTH}
        aria-valuemax={AGENT_PANEL_MAX_WIDTH}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeByKey}
        className="group absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize touch-none focus-visible:outline-none"
      >
        <span className="absolute inset-y-3 left-0.5 w-0.5 rounded-full bg-primary/0 transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary/60 group-active:bg-primary" />
      </div>
      <header className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="bare" type="button" className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-secondary">
              <span className="truncate">{session?.title ?? (loading ? '\u00a0' : '新对话')}</span>
              <ChevronDownIcon size="sm" className="shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="z-50 max-h-80 w-72 overflow-y-auto">
            {agent.sessions.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">还没有对话</p>}
            {agent.sessions.map(item => (
              <DropdownMenuItem key={item.session_id} onSelect={() => void agent.selectSession(item.session_id)} className="gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.session_id === session?.session_id && <CheckIcon size="sm" className="shrink-0" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {usageLabel && (
          <Hint label={usageLabel.detail}>
            <span aria-label={`本对话用量：${usageLabel.text}`} className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">{usageLabel.text}</span>
          </Hint>
        )}
        <Hint label="新对话"><Button variant="bare" type="button" aria-label="新对话" disabled={pending || running} onClick={() => void agent.newSession()} className={ICON_BUTTON}><NewChatIcon /></Button></Hint>
        <Hint label="关闭"><Button variant="bare" type="button" aria-label="关闭 Agent" onClick={onClose} className={ICON_BUTTON}><CloseIcon /></Button></Hint>
      </header>

      <CanvasAgentPlanList plan={agent.plan} running={running} />

      <div
        ref={listRef}
        aria-busy={loading || undefined}
        onScroll={event => {
          const list = event.currentTarget;
          stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < STICK_TO_BOTTOM_PX;
        }}
        className={cn('min-h-0 flex-1 overflow-y-auto px-3 py-3 transition-opacity', loading && session && 'opacity-50')}
      >
      <div ref={contentRef} className="flex min-h-full flex-col gap-3">
        {empty && (
          <div className="my-auto flex flex-col gap-3 px-1">
            <p className="font-display text-display leading-tight">想在画布上创作什么？</p>
            <div className="flex flex-col items-start gap-1.5">
              {PRESETS[creationMode].map(preset => (
                <Button variant="bare"
                  key={preset}
                  type="button"
                  onClick={() => { setText(preset); textareaRef.current?.focus(); }}
                  className="rounded-full border border-border px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                >{preset}</Button>
              ))}
            </div>
          </div>
        )}
        {buildCanvasAgentTimeline(messages, running || awaiting).map(block => {
          if (block.kind === 'process') {
            return <ProcessGroup key={block.id} projectId={projectId} messages={block.messages} steps={block.steps}
              arriving={block.messages.some(arriving)} />;
          }
          const item = <Message key={block.message.message_id} projectId={projectId} message={block.message}
            arriving={arriving(block.message) && settling?.messageId !== block.message.message_id} />;
          return settling?.messageId === block.message.message_id
            ? <SettlingReply key={block.message.message_id} streamed={settling.text}>{item}</SettlingReply>
            : item;
        })}
        {outgoing && (
          <Message projectId={projectId} arriving message={{
            role: 'user', title: outgoing.title, text: outgoing.text, reasoning_summary: null, references: [],
            turn_id: null, message_id: outgoing.id, sequence: 0, created_at: '',
          }} />
        )}
        <AgentSuggestions suggestions={suggestions} onPick={value => { setText(value); textareaRef.current?.focus(); }} />
        {running && streaming && <AgentStreamingMarkdown text={parseAgentReply(streaming).body || streaming} />}
        {/* 工具状态单独一行贴在底部：文字到达时原位换成完成态，不被清空。 */}
        {(running || sending) && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoadingIcon size="sm" aria-label="Agent 正在处理" className="animate-spin" />
            {tool && <SwapLabel active={tool.running}
              on={agentToolStatusLabel(tool.name, labels, true)}
              off={agentToolStatusLabel(tool.name, labels, false)} />}
          </p>
        )}
        {awaiting && session && (
          <CanvasAgentApprovalCard
            key={session.pending_approvals.map(item => item.call_id).join(',')}
            approvals={session.pending_approvals}
            labels={labels}
            disabled={pending}
            onDecide={(approved, items) => void agent.decide(approved, items)}
            loadBatchItems={callId => getCanvasAgentBatchItems(projectId, session.session_id, callId)}
          />
        )}
      </div>
      </div>

      {agent.error && (
        <p role="alert" className="mx-3 mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          <span className="min-w-0 flex-1 break-words">{agent.error}</span>
          <Button variant="bare" type="button" aria-label="关闭提示" onClick={agent.clearError}><CloseIcon size="sm" /></Button>
        </p>
      )}

      {setupNotice && (
        <p role="status" className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs text-muted-foreground">
          <ErrorIcon size="sm" className="shrink-0 text-primary" />
          <span className="min-w-0 flex-1 break-words">{setupNotice.text}</span>
          <Button variant="bare"
            type="button"
            onClick={() => setupNotice.action === 'settings'
              ? onOpenKeySettings()
              : void agent.updateSettings({ auto_models: true })}
            className="shrink-0 text-primary underline-offset-2 hover:underline"
          >{setupNotice.action === 'settings' ? '去设置' : '改为自动'}</Button>
        </p>
      )}

      <div className="m-2 mt-0 rounded-xl border border-border bg-background/60 focus-within:border-primary/60">
        {(attached.length > 0 || skill) && (
          <div className="flex flex-wrap gap-1 px-2 pt-2">
            {skill && (
              <span className="flex max-w-[12rem] items-center gap-1 rounded-full border border-primary/50 py-0.5 pl-2 pr-1 text-xs text-primary">
                <SkillIcon size="sm" className="shrink-0" />
                <span className="truncate">{skill}</span>
                <Button variant="bare" type="button" aria-label={`不用 Skill ${skill}`} onClick={() => setSkill(null)} className="rounded-full p-0.5 hover:bg-secondary"><CloseIcon size="sm" /></Button>
              </span>
            )}
            {attached.map(node => node.type === 'image' && node.versionId ? (
              <CanvasAgentReferenceThumb
                key={node.id}
                projectId={projectId}
                nodeId={node.id}
                versionId={node.versionId}
                title={node.title}
                onRemove={() => setDismissed(current => new Set(current).add(node.id))}
              />
            ) : (
              <span key={node.id} className="flex max-w-[10rem] items-center gap-1 rounded-full border border-border py-0.5 pl-2 pr-1 text-xs text-muted-foreground">
                <NodeIcon type={node.type} />
                <span className="truncate">{node.title}</span>
                <Button variant="bare" type="button" aria-label={`不带入 ${node.title}`} onClick={() => setDismissed(current => new Set(current).add(node.id))} className="rounded-full p-0.5 hover:bg-secondary hover:text-foreground"><CloseIcon size="sm" /></Button>
              </span>
            ))}
          </div>
        )}
        <Textarea variant="bare"
          ref={textareaRef}
          value={text}
          onChange={event => setText(event.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="描述你想在画布上做什么"
          aria-label="给 Agent 的消息"
          className="block max-h-48 min-h-[4.5rem] w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <Hint label="上传素材"><Button variant="bare" type="button" aria-label="上传素材" onClick={onUpload} className={ICON_BUTTON}><AttachIcon /></Button></Hint>
          <CanvasAgentSkillPicker
            skills={agent.skills}
            selected={skill}
            disabled={running || pending}
            onSelect={setSkill}
            onChanged={agent.reloadSkills}
          />
          <CanvasAgentModeMenu
            mode={creationMode}
            disabled={running || pending}
            onSelect={mode => void agent.updateSettings({ creation_mode: mode })}
          />
          <CanvasAgentPreferencePicker
            models={agent.generationModels}
            mode={creationMode}
            auto={settings.auto_models ?? true}
            preferred={settings.preferred_models ?? []}
            disabled={running || pending}
            onChange={update => void agent.updateSettings(update)}
          />
          <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
          <CanvasAgentModelPicker
            models={agent.models}
            alias={modelAlias}
            model={modelId}
            disabled={running || pending}
            onSelect={choice => void agent.updateSettings({ model: choice.model, model_alias: choice.alias })}
          />
          <Hint label={selectedModel?.reasoning === false ? '该模型不支持思考' : thinkingOn ? '思考：开' : '思考：关'}><Toggle
            aria-label="思考模式"
            pressed={thinkingOn}
            disabled={running || pending || selectedModel?.reasoning === false}
            onPressedChange={on => void agent.updateSettings({ effort: on ? 'high' : 'off' })}
            className={cn(ICON_BUTTON, 'min-w-7 px-0 data-[state=on]:bg-transparent data-[state=on]:text-primary')}
          ><ThinkingIcon /></Toggle></Hint>
          <CanvasAgentPermissionMenu
            auto={autoMode}
            confirmAbove={agent.confirmAbove}
            disabled={running || pending}
            onModeChange={mode => void agent.updateSettings({ permission_mode: mode })}
            onConfirmAboveChange={value => void agent.updateConfirmAbove(value)}
          />
          <span className="min-w-1 flex-1" />
          {/* 发送与停止是同一个按钮壳，图标与底色换态，不整颗换掉。 */}
          <Hint label={running ? '停止' : '发送'}><Button variant="bare"
            type="button"
            aria-label={running ? '停止' : '发送'}
            disabled={!running && !canSend}
            onClick={() => void (running ? agent.stop() : submit())}
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-full transition-[background-color,color,opacity] disabled:opacity-40',
              running ? 'bg-secondary text-foreground hover:bg-secondary/80' : 'bg-primary text-primary-foreground',
            )}
          >
            <SwapIcon swapKey={running}>{running ? <StopIcon size="sm" className="fill-current" /> : <ArrowUpIcon />}</SwapIcon>
          </Button></Hint>
        </div>
      </div>
    </aside>
  );
}
