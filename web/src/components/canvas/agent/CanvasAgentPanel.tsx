import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  ArrowUp, Brain, Check, ChevronDown, ChevronRight, FileImage, FileText, FileVideo, Loader2, Paperclip,
  Puzzle, ShieldCheck, Square, SquarePen, Wrench, X, Zap,
} from 'lucide-react';
import { canvasMediaUrl } from '@/api/canvas';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { CanvasAgentCreationMode, CanvasAgentMessage } from '@/schema/canvas';
import { CanvasAgentModeMenu } from './CanvasAgentModeMenu';
import { CanvasAgentModelPicker } from './CanvasAgentModelPicker';
import { CanvasAgentPreferencePicker } from './CanvasAgentPreferencePicker';
import { CanvasAgentReferenceThumb } from './CanvasAgentReferenceThumb';
import { buildCanvasAgentTimeline } from './canvasAgentTimeline';
import { CanvasAgentSkillPicker } from './CanvasAgentSkillPicker';
import { useCanvasAgent } from './useCanvasAgent';

export interface CanvasAgentNodeRef {
  id: string;
  title: string;
  type: string;
  /** 图片节点的当前版本：有就显示缩略图。 */
  versionId?: string | null;
}

// 与服务端 canvas_agent_runtime.READ_LABELS 同名同字：只读工具的消息正文就是这个标签，相同则不重复显示。
const TOOL_LABELS: Record<string, string> = {
  get_canvas: '读取画布',
  list_models: '查看可用模型',
  apply_changes: '修改画布',
  run_generation: '生成',
  get_run: '查询生成进度',
  read_media: '读取媒体信息',
  wait_for_run: '等待生成结果',
  load_skill: '读取 Skill',
  read_skill_file: '读取 Skill 文件',
};

const ICON_BUTTON = 'grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40';

function NodeIcon({ type }: { type: string }) {
  if (type === 'image') return <FileImage className="size-3.5 shrink-0" />;
  if (type === 'video') return <FileVideo className="size-3.5 shrink-0" />;
  return <FileText className="size-3.5 shrink-0" />;
}

/** 模型回复常带 Markdown：标题压到正文字号，面板里只用 sm / xs 两档。 */
function AgentMarkdown({ text }: { text: string }) {
  return (
    <div className="break-words text-sm">
      <ReactMarkdown
        components={{
          h1: ({ node: _node, ...props }) => <p className="my-2 font-medium first:mt-0" {...props} />,
          h2: ({ node: _node, ...props }) => <p className="my-2 font-medium first:mt-0" {...props} />,
          h3: ({ node: _node, ...props }) => <p className="my-2 font-medium first:mt-0" {...props} />,
          p: ({ node: _node, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
          ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-0.5 pl-4" {...props} />,
          ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-0.5 pl-4" {...props} />,
          code: ({ node: _node, ...props }) => <code className="rounded bg-secondary px-1 text-xs" {...props} />,
          pre: ({ node: _node, ...props }) => <pre className="my-2 overflow-x-auto rounded-md bg-secondary p-2 text-xs" {...props} />,
          a: ({ node: _node, ...props }) => <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
        }}
      >{text}</ReactMarkdown>
    </div>
  );
}

/** 空对话里的示例需求：点一下填进输入框（不直接发送，生成要花钱）。 */
const PRESETS: Record<CanvasAgentCreationMode, string[]> = {
  all: ['生成一只像素风格的小狗', '设计一个赛博朋克风格的女性角色立绘', '把选中的图片做成 5 秒的动态视频'],
  image: ['生成一只像素风格的小狗', '设计一组奇幻 RPG 的道具图标', '为选中的角色画正面、侧面、背面三视图'],
  video: ['把选中的图片做成 5 秒的动态视频', '生成一段像素风小狗奔跑的循环动画', '做一个角色登场的 5 秒镜头'],
};

/** 显示宽度 = 缩略图格子宽（w-20 = 80px）的 2 倍，留给高分屏。 */
const THUMB_DISPLAY_WIDTH = 160;

/** 已结束一轮的中间过程：默认收起成一行，可展开；生成出的图收起时也露在外面。 */
function ProcessGroup({ projectId, messages, steps }: {
  projectId: string;
  messages: CanvasAgentMessage[];
  steps: number;
}) {
  const [open, setOpen] = useState(false);
  const images = messages.flatMap(message => message.role === 'tool'
    ? message.references.filter(ref => ref.kind === 'content' && ref.version_id) : []);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Wrench className="size-3.5" />
        处理过程 · {steps} 步
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-l border-border pl-3">
          {messages.map(message => <Message key={message.message_id} projectId={projectId} message={message} />)}
        </div>
      ) : images.length > 0 && (
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
      )}
    </div>
  );
}

function Message({ projectId, message }: { projectId: string; message: CanvasAgentMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-secondary px-3 py-2 text-sm">{message.text}</p>
        {message.title && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground"><Puzzle className="size-3" />{message.title}</span>
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
    const label = TOOL_LABELS[message.title ?? ''] ?? message.title;
    const images = message.references.filter(ref => ref.kind === 'content' && ref.version_id);
    return (
      <div className="flex gap-2 text-xs text-muted-foreground">
        <Wrench className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-line break-words">
            <span className="text-foreground/80">{label}</span>
            {message.text && message.text !== label && <span className="ml-1.5">{message.text}</span>}
          </p>
          {images.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
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
          )}
        </div>
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
      {message.text && <AgentMarkdown text={message.text} />}
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
  const [skill, setSkill] = useState<string | null>(null);
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const empty = messages.length === 0 && !running && !awaiting;

  // 选中的节点变了：之前移除过的不再记着，免得重新选中却带不进来。
  const selectionKey = selectedNodes.map(node => node.id).join(',');
  useEffect(() => { setDismissed(new Set()); }, [selectionKey]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length, streaming, status]);

  // 列表读到之后，只有列表里的模型能发（Key 里停用的文本模型不再可用）。
  const modelReady = !agent.models || Boolean(selectedModel);
  const canSend = text.trim().length > 0 && !running && !awaiting && !pending && modelReady;

  async function submit() {
    if (!canSend) return;
    const sent = await agent.send(text.trim(), attached.map(node => node.id), skill);
    if (!sent) return;
    setText('');
    setSkill(null);
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
          <DropdownMenuContent align="start" className="z-50 max-h-80 w-72 overflow-y-auto">
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
        {empty && (
          <div className="my-auto flex flex-col gap-3 px-1">
            <p className="font-display text-display leading-tight">想在画布上创作什么？</p>
            <div className="flex flex-col items-start gap-1.5">
              {PRESETS[creationMode].map(preset => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => { setText(preset); textareaRef.current?.focus(); }}
                  className="rounded-full border border-border px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                >{preset}</button>
              ))}
            </div>
          </div>
        )}
        {buildCanvasAgentTimeline(messages, running || awaiting).map(block => block.kind === 'message'
          ? <Message key={block.message.message_id} projectId={projectId} message={block.message} />
          : <ProcessGroup key={block.id} projectId={projectId} messages={block.messages} steps={block.steps} />)}
        {running && streaming && <AgentMarkdown text={streaming} />}
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
        {(attached.length > 0 || skill) && (
          <div className="flex flex-wrap gap-1 px-2 pt-2">
            {skill && (
              <span className="flex max-w-[12rem] items-center gap-1 rounded-full border border-primary/50 py-0.5 pl-2 pr-1 text-xs text-primary">
                <Puzzle className="size-3.5 shrink-0" />
                <span className="truncate">{skill}</span>
                <button type="button" aria-label={`不用 Skill ${skill}`} onClick={() => setSkill(null)} className="rounded-full p-0.5 hover:bg-secondary"><X className="size-3" /></button>
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
                <button type="button" aria-label={`不带入 ${node.title}`} onClick={() => setDismissed(current => new Set(current).add(node.id))} className="rounded-full p-0.5 hover:bg-secondary hover:text-foreground"><X className="size-3" /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
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
          <button type="button" title="上传素材" aria-label="上传素材" onClick={onUpload} className={ICON_BUTTON}><Paperclip className="size-4" /></button>
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
            aria-label={autoMode ? '权限模式：Auto' : '权限模式：审查'}
            disabled={running || pending}
            onClick={() => void agent.updateSettings({ permission_mode: autoMode ? 'review' : 'auto' })}
            className={cn(ICON_BUTTON, autoMode && 'text-primary')}
          >{autoMode ? <Zap className="size-4" /> : <ShieldCheck className="size-4" />}</button>
          <span className="min-w-1 flex-1" />
          {running ? (
            <button type="button" title="停止" aria-label="停止" onClick={() => void agent.stop()} className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-foreground hover:bg-secondary/80"><Square className="size-3.5 fill-current" /></button>
          ) : (
            <button type="button" title="发送" aria-label="发送" disabled={!canSend} onClick={() => void submit()} className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-40"><ArrowUp className="size-4" /></button>
          )}
        </div>
      </div>
    </aside>
  );
}
