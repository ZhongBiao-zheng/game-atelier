import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import { FileAudio, FileImage, FileVideo, LoaderCircle, Plus, Sparkles, Trash2, Type } from 'lucide-react';
import { createContext, memo, useContext } from 'react';

import { canvasMediaUrl } from '@/api/canvas';
import { modelModality, type KeyView } from '@/api/keys';
import { Button } from '@/components/ui/button';
import { imageControlCaps } from '@/lib/imageControlCaps';
import { cn } from '@/lib/utils';
import type {
  CanvasContentNode,
  CanvasContentVersion,
  CanvasGenerationDraft,
  CanvasNode,
} from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import { normalizeCanvasImageParams } from '@/pages/canvasEditorModel';

export type FlowNode = Node<{ domain: CanvasNode }, 'canvasNode'>;

export interface CanvasNodeContextValue {
  projectId: string;
  contentVersions: Readonly<Record<string, CanvasContentVersion>>;
  keys: KeyView[];
  jobsByRunId: ReadonlyMap<string, Job>;
  submittingNodeIds: ReadonlySet<string>;
  selectNode: (id: string) => void;
  submitRun: (id: string) => Promise<void>;
  updateNode: (id: string, updater: (node: CanvasNode) => CanvasNode) => void;
  updateText: (id: string, text: string) => void;
  recordHistory: () => void;
  deleteNode: (id: string) => void;
}

export const CanvasNodeContext = createContext<CanvasNodeContextValue | null>(null);

export function CanvasNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const context = useContext(CanvasNodeContext);
  if (!context) return null;
  const node = data.domain;
  const content = contentForNode(node, context.contentVersions);
  const draft = generationDraft(node);

  return (
    <div className="canvas-node-shell group relative h-full w-full overflow-visible" data-selected={selected ? 'true' : 'false'}>
      <NodeResizer
        isVisible={selected}
        minWidth={node.type === 'text' ? 220 : 240}
        minHeight={node.type === 'text' ? 120 : 150}
        color="var(--primary)"
        handleClassName="canvas-node-resize-handle"
        lineClassName="canvas-node-resize-line"
        onResizeStart={context.recordHistory}
        onResizeEnd={(_, params) => context.updateNode(node.id, current => ({
          ...current,
          size: { width: params.width, height: params.height },
        }))}
      />
      <header className="absolute bottom-full left-1 right-1 flex items-center justify-between gap-2 pb-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {nodeIcon(node)}
          <span className="truncate">{node.title}</span>
        </span>
        <button
          type="button"
          aria-label="删除节点"
          className="nodrag grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition-[color,opacity,background-color] hover:bg-secondary hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-hover:opacity-100"
          onClick={event => {
            event.stopPropagation();
            context.deleteNode(node.id);
          }}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </header>
      <article
        role="button"
        tabIndex={0}
        aria-label={`选择节点 ${node.title}`}
        className={cn(
          'relative h-full overflow-hidden rounded-lg border bg-card/95 text-foreground transition-colors shell-glow',
          selected ? 'border-primary' : 'border-border',
        )}
        onClick={event => {
          event.stopPropagation();
          context.selectNode(node.id);
        }}
        onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          context.selectNode(node.id);
        }}
      >
        <div className={cn('h-full bg-secondary/20', node.type === 'text' ? 'min-h-32' : 'min-h-44')}>
          {node.type === 'text' && (
            <p className="line-clamp-5 whitespace-pre-wrap p-3 text-sm leading-relaxed text-foreground">
              {content?.kind === 'text' && content.text ? content.text : '选择节点后输入文本…'}
            </p>
          )}
          {content && content.kind !== 'text' && (
            <MediaPreview kind={content.kind} src={canvasMediaUrl(context.projectId, content.version_id)} />
          )}
          {node.type !== 'text' && !content && (
            <div className="grid min-h-44 place-items-center px-4 text-center text-xs text-muted-foreground">
              {node.type === 'config' ? '生成配置' : node.type === 'group' ? '分组' : '选择节点，填写下方生成设置'}
            </div>
          )}
        </div>
      </article>
      {acceptsInput(node) && (
        <Handle type="target" position={Position.Left} className="canvas-node-handle" aria-label="连接到此节点">
          <span className="canvas-node-handle-dot"><Plus aria-hidden="true" /></span>
        </Handle>
      )}
      {providesContent(node) && (
        <Handle type="source" position={Position.Right} className="canvas-node-handle" aria-label="从此节点连接">
          <span className="canvas-node-handle-dot"><Plus aria-hidden="true" /></span>
        </Handle>
      )}
      {selected && draft && (
        <div className="absolute left-1/2 top-full z-20 w-[38rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 pt-6">
          <GenerationComposer node={node} draft={draft} context={context} />
        </div>
      )}
    </div>
  );
}

function GenerationComposer({
  node,
  draft,
  context,
}: {
  node: CanvasNode;
  draft: CanvasGenerationDraft;
  context: CanvasNodeContextValue;
}) {
  const availableKeys = context.keys.filter(key => key.models.some(model => modelModality(model, key) === draft.mode));
  const selectedKey = context.keys.find(key => key.alias === draft.alias);
  const models = (selectedKey?.models ?? []).filter(model => modelModality(model, selectedKey) === draft.mode);
  const imageCaps = draft.mode === 'image' ? imageControlCaps(draft.model, selectedKey?.provider) : null;
  const runId = activeRunId(node);
  const activeJob = runId ? context.jobsByRunId.get(runId) : undefined;
  const submitting = context.submittingNodeIds.has(node.id);
  const running = activeJob?.status === 'pending' || activeJob?.status === 'pending_confirm';

  function updateDraft(updater: (current: CanvasGenerationDraft) => CanvasGenerationDraft) {
    context.updateNode(node.id, current => withGenerationDraft(current, updater(generationDraft(current)!)));
  }

  return (
    <section
      aria-label={`${draft.mode === 'image' ? '图片' : draft.mode === 'video' ? '视频' : '内容'}生成设置`}
      data-floating-node-panel="true"
      className="nodrag nowheel rounded-xl border border-border bg-glass p-4 backdrop-blur-glass shell-glow"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <textarea
        aria-label="提示词"
        rows={4}
        value={draft.prompt}
        onFocus={context.recordHistory}
        onChange={event => updateDraft(current => ({ ...current, prompt: event.target.value, updated_at: new Date().toISOString() }))}
        className="min-h-28 w-full resize-none bg-transparent px-1 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        placeholder={draft.mode === 'video' ? '描述镜头运动与画面变化' : '描述任何你想要生成的内容'}
      />
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-2">
        <select
          aria-label="密钥"
          value={draft.alias ?? ''}
          onFocus={context.recordHistory}
          onChange={event => {
            const key = context.keys.find(item => item.alias === event.target.value);
            const model = key?.models.find(item => modelModality(item, key) === draft.mode)?.id ?? '';
            updateDraft(current => ({
              ...current,
              alias: event.target.value || null,
              model,
              params: draft.mode === 'image'
                ? normalizeCanvasImageParams(model, key?.provider, current.params)
                : current.params,
              updated_at: new Date().toISOString(),
            }));
          }}
          className="h-9 max-w-28 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <option value="">选择密钥</option>
          {availableKeys.map(key => <option key={key.alias} value={key.alias}>{key.alias}</option>)}
        </select>
        <select
          aria-label="模型"
          value={draft.model}
          onFocus={context.recordHistory}
          onChange={event => updateDraft(current => ({
            ...current,
            model: event.target.value,
            params: draft.mode === 'image'
              ? normalizeCanvasImageParams(event.target.value, selectedKey?.provider, current.params)
              : current.params,
            updated_at: new Date().toISOString(),
          }))}
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <option value="">选择模型</option>
          {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
        </select>
        {draft.mode !== 'text' && draft.mode !== 'audio' && (
          <select
            aria-label="比例"
            value={String(draft.params.ratio ?? (draft.mode === 'image' ? '1:1' : '16:9'))}
            onFocus={context.recordHistory}
            onChange={event => updateDraft(current => ({
              ...current,
              params: { ...current.params, ratio: event.target.value },
              updated_at: new Date().toISOString(),
            }))}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {(imageCaps?.ratios ?? ['1:1', '16:9', '9:16', '4:3', '3:4']).map(value => <option key={value}>{value}</option>)}
          </select>
        )}
        <span className="max-w-52 truncate text-xs text-muted-foreground" title={runStatus(activeJob)}>
          {runStatus(activeJob)}
        </span>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={submitting || running || !draft.prompt.trim() || !draft.alias || !draft.model}
          onClick={() => void context.submitRun(node.id)}
        >
          {submitting || running
            ? <LoaderCircle className="animate-spin" aria-hidden="true" />
            : <Sparkles aria-hidden="true" />}
          {submitting ? '提交中…' : running ? '生成中…' : activeJob ? '再次生成' : '开始生成'}
        </Button>
      </div>
    </section>
  );
}

export function CanvasInspector({
  node,
  updateNode,
  updateText,
  recordHistory,
  deleteNode,
  projectId,
  contentVersions,
}: {
  node: CanvasContentNode;
  updateNode: (updater: (node: CanvasNode) => CanvasNode) => void;
  updateText: (text: string) => void;
  recordHistory: () => void;
  deleteNode: () => void;
  projectId: string;
  contentVersions: Readonly<Record<string, CanvasContentVersion>>;
}) {
  const content = contentForNode(node, contentVersions);
  return (
    <aside className="absolute inset-x-3 bottom-3 z-20 rounded-xl border border-border bg-glass p-3 backdrop-blur-glass shell-glow md:bottom-auto md:left-auto md:right-4 md:top-20 md:w-72">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium">{node.title}</p>
        <Button variant="ghost" size="icon" aria-label="删除选中节点" onClick={deleteNode}><Trash2 /></Button>
      </div>
      <input
        aria-label="节点标题"
        value={node.title}
        onFocus={recordHistory}
        onChange={event => updateNode(current => ({ ...current, title: event.target.value || '未命名节点' }))}
        className="canvas-input mb-2"
      />
      {node.type === 'text' && (
        <textarea
          aria-label="文本内容"
          rows={8}
          value={content?.kind === 'text' ? content.text : ''}
          onFocus={recordHistory}
          onChange={event => updateText(event.target.value)}
          className="canvas-input resize-y"
        />
      )}
      {content && content.kind !== 'text' && (
        <MediaPreview kind={content.kind} src={canvasMediaUrl(projectId, content.version_id)} compact />
      )}
    </aside>
  );
}

export function EditorMessage({ text, icon, action }: { text: string; icon?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="grid h-full place-items-center"><div className="flex items-center gap-2 text-sm text-muted-foreground">{icon}{text}{action}</div></div>;
}

export function ToolButton({ label, active, disabled, onClick, children }: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return <button type="button" title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick} className={cn('grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30', active && 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground')}>{children}</button>;
}

export function AddMenuButton({ icon, title, description, onClick }: { icon: React.ReactNode; title: string; description?: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">{icon}</span><span className="min-w-0"><span className="block text-sm font-medium">{title}</span>{description && <span className="block truncate text-xs text-muted-foreground">{description}</span>}</span></button>;
}

function contentForNode(node: CanvasNode, versions: Readonly<Record<string, CanvasContentVersion>>) {
  if (!('current_version_id' in node.data) || !node.data.current_version_id) return undefined;
  return versions[node.data.current_version_id];
}

function generationDraft(node: CanvasNode): CanvasGenerationDraft | null {
  if (node.type === 'config') return node.data.draft;
  if ('generation_draft' in node.data) return node.data.generation_draft;
  return null;
}

function withGenerationDraft(node: CanvasNode, draft: CanvasGenerationDraft): CanvasNode {
  if (node.type === 'config') return { ...node, data: { draft } };
  if (node.type === 'text') return { ...node, data: { ...node.data, generation_draft: draft } };
  if (node.type === 'image') return { ...node, data: { ...node.data, generation_draft: draft } };
  if (node.type === 'video') return { ...node, data: { ...node.data, generation_draft: draft } };
  if (node.type === 'audio') return { ...node, data: { ...node.data, generation_draft: draft } };
  if (node.type === 'plugin') return { ...node, data: { ...node.data, generation_draft: draft } };
  return node;
}

function activeRunId(node: CanvasNode): string | null {
  if (node.type === 'text' || node.type === 'image' || node.type === 'video' || node.type === 'audio') {
    return node.data.active_run_id;
  }
  return null;
}

function runStatus(job: Job | undefined): string {
  if (!job) return '配置已保存';
  if (job.status === 'pending' || job.status === 'pending_confirm') return '结果会自动回到节点';
  if (job.status === 'done') return '生成完成';
  return job.error || '生成失败';
}

function acceptsInput(node: CanvasNode) {
  return node.type !== 'group' && node.type !== 'plugin';
}

function providesContent(node: CanvasNode) {
  return node.type === 'text' || node.type === 'image' || node.type === 'video' || node.type === 'audio';
}

function nodeIcon(node: CanvasNode) {
  if (node.type === 'text') return <Type className="size-3.5 shrink-0" />;
  if (node.type === 'image') return <FileImage className="size-3.5 shrink-0" />;
  if (node.type === 'video') return <FileVideo className="size-3.5 shrink-0" />;
  if (node.type === 'audio') return <FileAudio className="size-3.5 shrink-0" />;
  return <Sparkles className="size-3.5 shrink-0" />;
}

function MediaPreview({ kind, src, compact = false }: { kind: 'image' | 'video' | 'audio'; src: string; compact?: boolean }) {
  if (kind === 'image') return <img src={src} alt="" loading="lazy" className={cn('size-full object-contain', compact && 'max-h-48 rounded-md')} />;
  if (kind === 'video') return <video src={src} controls={compact} muted={!compact} preload="metadata" className={cn('size-full object-contain', compact && 'max-h-48 rounded-md')} />;
  return <div className="grid size-full place-items-center p-3"><audio src={src} controls className="w-full" /></div>;
}

export const canvasNodeTypes = { canvasNode: memo(CanvasNodeCard) };
