import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  ArrowUp,
  FileAudio,
  FileImage,
  FileVideo,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
  Type,
  Video,
} from 'lucide-react';
import { createContext, memo, useContext } from 'react';

import { canvasMediaUrl } from '@/api/canvas';
import { modelModality, type KeyView } from '@/api/keys';
import { Button } from '@/components/ui/button';
import { estimateCostYuan, isHkAggregator } from '@/lib/creditCost';
import { imageControlCaps, MJ_IMAGES_PER_TASK, type Quality } from '@/lib/imageControlCaps';
import { cn } from '@/lib/utils';
import type { CanvasGenerationNode, CanvasNode } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import { normalizeCanvasImageParams } from '@/pages/canvasEditorModel';

export type FlowNode = Node<{ domain: CanvasNode }, 'canvasNode'>;

export interface CanvasNodeContextValue {
  projectId: string;
  jobs: ReadonlyMap<string, Job>;
  keys: KeyView[];
  generatingId: string | null;
  selectNode: (id: string) => void;
  updateNode: (id: string, updater: (node: CanvasNode) => CanvasNode) => void;
  recordHistory: () => void;
  deleteNode: (id: string) => void;
  generate: (node: CanvasGenerationNode) => void;
}

export const CanvasNodeContext = createContext<CanvasNodeContextValue | null>(null);

export function CanvasNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const context = useContext(CanvasNodeContext);
  if (!context) return null;
  const node = data.domain;
  const activeJob = node.type === 'generation' && node.data.active_job_id
    ? context.jobs.get(node.data.active_job_id)
    : undefined;
  const selectedOutput = node.type === 'generation' && activeJob?.status === 'done'
    ? activeJob.output_paths[node.data.selected_output_index ?? 0]
    : undefined;

  return (
    <div
      className={cn(
        'canvas-node-shell group relative overflow-visible',
        node.type === 'text' ? 'w-64' : 'w-80',
      )}
      data-selected={selected ? 'true' : 'false'}
    >
      <header className="absolute bottom-full left-1 right-1 flex items-center justify-between gap-2 pb-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {node.type === 'text' ? <Type className="size-3.5 shrink-0" /> : node.type === 'resource' ? mediaIcon(node.data.media_kind) : node.data.media_kind === 'image' ? <Sparkles className="size-3.5 shrink-0" /> : <Video className="size-3.5 shrink-0" />}
          <span className="truncate">{nodeTitle(node)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {node.type === 'generation' && activeJob && <JobState status={activeJob.status} />}
          <button
            type="button"
            aria-label="删除节点"
            className="nodrag grid size-7 place-items-center rounded-full text-muted-foreground opacity-0 transition-[color,opacity,background-color] hover:bg-secondary hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-hover:opacity-100"
            onClick={event => {
              event.stopPropagation();
              context.deleteNode(node.id);
            }}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        </span>
      </header>
      <article
        className={cn(
          'relative overflow-hidden rounded-lg border bg-card/95 text-foreground transition-colors shell-glow',
          selected ? 'border-primary' : 'border-border',
        )}
        onClick={() => context.selectNode(node.id)}
      >
        <div className={cn('bg-secondary/20', node.type === 'text' ? 'min-h-32' : 'min-h-44')}>
          {node.type === 'text' && (
            <p className="line-clamp-5 whitespace-pre-wrap p-3 text-sm leading-relaxed text-foreground">
              {node.data.text || '选择节点后输入文本…'}
            </p>
          )}
          {node.type === 'resource' && <MediaPreview kind={node.data.media_kind} src={canvasMediaUrl(context.projectId, node.data)} />}
          {node.type === 'generation' && selectedOutput && (
            <MediaPreview kind={node.data.media_kind} src={canvasMediaUrl(context.projectId, { path: selectedOutput, job_id: activeJob?.job_id })} />
          )}
          {node.type === 'generation' && !selectedOutput && (
            <div className="grid min-h-44 place-items-center px-4 text-center text-xs text-muted-foreground">
              {activeJob?.status === 'failed' ? activeJob.error || '生成失败' : activeJob?.status === 'pending' ? '正在生成…' : '选择节点，填写提示词后生成'}
            </div>
          )}
        </div>
      </article>
      <Handle
        type="target"
        position={Position.Left}
        className="canvas-node-handle"
        aria-label="连接到此节点"
      >
        <span className="canvas-node-handle-dot"><Plus aria-hidden="true" /></span>
      </Handle>
      <Handle
        type="source"
        position={Position.Right}
        className="canvas-node-handle"
        aria-label="从此节点连接"
      >
        <span className="canvas-node-handle-dot"><Plus aria-hidden="true" /></span>
      </Handle>
      {node.type === 'generation' && selected && (
        <div className="absolute left-1/2 top-full z-20 w-[38rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 pt-6">
          <GenerationComposer node={node} activeJob={activeJob} context={context} />
        </div>
      )}
    </div>
  );
}

function GenerationComposer({
  node,
  activeJob,
  context,
}: {
  node: CanvasGenerationNode;
  activeJob?: Job;
  context: CanvasNodeContextValue;
}) {
  const availableKeys = context.keys.filter(key => (
    key.models.some(model => modelModality(model, key) === node.data.media_kind)
  ));
  const selectedKey = context.keys.find(key => key.alias === node.data.draft.alias);
  const models = (selectedKey?.models ?? []).filter(model => (
    modelModality(model, selectedKey) === node.data.media_kind
  ));
  const imageCaps = node.data.media_kind === 'image'
    ? imageControlCaps(node.data.draft.model, selectedKey?.provider)
    : null;
  const billableOutputCount = imageCaps?.family === 'midjourney'
    ? MJ_IMAGES_PER_TASK
    : 1;
  const estimatedCost = node.data.media_kind === 'image' && isHkAggregator(selectedKey?.base_url)
    ? estimateCostYuan({
      model: node.data.draft.model,
      quality: node.data.draft.params.quality as Quality | undefined,
      n: billableOutputCount,
    })
    : null;
  const updateNode = (updater: (current: CanvasNode) => CanvasNode) => context.updateNode(node.id, updater);
  const pending = context.generatingId === node.id || activeJob?.status === 'pending';

  return (
    <section
      aria-label={`${node.data.media_kind === 'image' ? '图片' : '视频'}生成设置`}
      data-floating-node-panel="true"
      className="nodrag nowheel rounded-xl border border-border bg-glass p-4 backdrop-blur-glass shell-glow"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <label className="block">
        <span className="sr-only">提示词</span>
        <textarea
          rows={4}
          value={node.data.draft.prompt}
          onFocus={context.recordHistory}
          onChange={event => updateNode(current => current.type === 'generation'
            ? { ...current, data: { ...current.data, draft: { ...current.data.draft, prompt: event.target.value } } }
            : current)}
          className="min-h-28 w-full resize-none bg-transparent px-1 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={node.data.media_kind === 'image' ? '描述任何你想要生成的内容' : '描述镜头运动与画面变化'}
        />
      </label>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-2">
        <select
          aria-label="密钥"
          value={node.data.draft.alias ?? ''}
          onFocus={context.recordHistory}
          onChange={event => {
            const key = context.keys.find(item => item.alias === event.target.value);
            const model = key?.models.find(item => modelModality(item, key) === node.data.media_kind)?.id ?? '';
            updateNode(current => current.type === 'generation'
              ? {
                ...current,
                data: {
                  ...current.data,
                  draft: {
                    ...current.data.draft,
                    alias: event.target.value,
                    model,
                    params: current.data.media_kind === 'image'
                      ? normalizeCanvasImageParams(model, key?.provider, current.data.draft.params)
                      : current.data.draft.params,
                  },
                },
              }
              : current);
          }}
          className="h-9 max-w-28 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <option value="">选择密钥</option>
          {availableKeys.map(key => <option key={key.alias} value={key.alias}>{key.alias}</option>)}
        </select>
        <select
          aria-label="模型"
          value={node.data.draft.model}
          onFocus={context.recordHistory}
          onChange={event => updateNode(current => current.type === 'generation'
            ? {
              ...current,
              data: {
                ...current.data,
                draft: {
                  ...current.data.draft,
                  model: event.target.value,
                  params: current.data.media_kind === 'image'
                    ? normalizeCanvasImageParams(event.target.value, selectedKey?.provider, current.data.draft.params)
                    : current.data.draft.params,
                },
              },
            }
            : current)}
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <option value="">选择模型</option>
          {models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
        </select>
        <select
          aria-label="比例"
          value={String(node.data.draft.params.ratio ?? (node.data.media_kind === 'image' ? '1:1' : '16:9'))}
          onFocus={context.recordHistory}
          onChange={event => updateGenerationParam(updateNode, 'ratio', event.target.value)}
          className="h-9 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {(imageCaps?.ratios ?? ['1:1', '16:9', '9:16', '4:3', '3:4']).map(value => <option key={value}>{value}</option>)}
        </select>
        {imageCaps?.showResolution && (
          <select
            aria-label="分辨率"
            value={String(node.data.draft.params.resolution ?? imageCaps.resolutions[0])}
            onFocus={context.recordHistory}
            onChange={event => updateGenerationParam(updateNode, 'resolution', event.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {imageCaps.resolutions.map(value => <option key={value}>{value}</option>)}
          </select>
        )}
        {imageCaps?.qualities && (
          <select
            aria-label="质量"
            value={String(node.data.draft.params.quality ?? imageCaps.qualities[0])}
            onFocus={context.recordHistory}
            onChange={event => updateGenerationParam(updateNode, 'quality', event.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {imageCaps.qualities.map(value => <option key={value}>{value}</option>)}
          </select>
        )}
        {node.data.media_kind === 'video' && (
          <select
            aria-label="时长"
            value={Number(node.data.draft.params.duration ?? 5)}
            onFocus={context.recordHistory}
            onChange={event => updateGenerationParam(updateNode, 'duration', Number(event.target.value))}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {[5, 10].map(value => <option key={value} value={value}>{value} 秒</option>)}
          </select>
        )}
        {estimatedCost != null && (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">约 ¥{estimatedCost.toFixed(2)}</span>
        )}
        <button
          type="button"
          aria-label="开始生成"
          title={node.data.job_ids.length ? '再次生成' : '开始生成'}
          disabled={pending}
          onClick={() => context.generate(node)}
          className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </div>

      {node.data.job_ids.length > 1 && (
        <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span>生成轮次</span>
          <select
            aria-label="生成轮次"
            value={node.data.active_job_id ?? node.data.job_ids.at(-1) ?? ''}
            onFocus={context.recordHistory}
            onChange={event => updateNode(current => current.type === 'generation'
              ? { ...current, data: { ...current.data, active_job_id: event.target.value, selected_output_index: 0 } }
              : current)}
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {[...node.data.job_ids].reverse().map((jobId, reverseIndex) => {
              const row = context.jobs.get(jobId);
              return <option key={jobId} value={jobId}>第 {node.data.job_ids.length - reverseIndex} 轮 · {row?.status === 'done' ? '完成' : row?.status === 'failed' ? '失败' : '生成中'}</option>;
            })}
          </select>
        </label>
      )}
      {activeJob?.status === 'failed' && <p role="alert" className="mt-2 text-xs text-destructive">{activeJob.error || '生成失败'}</p>}
      {activeJob?.status === 'done' && activeJob.output_paths.length > 1 && (
        <div className="mt-2 grid grid-cols-4 gap-2" aria-label="选择生成结果">
          {activeJob.output_paths.map((path, index) => (
            <button
              type="button"
              key={path}
              aria-label={`选择结果 ${index + 1}`}
              aria-pressed={(node.data.selected_output_index ?? 0) === index}
              onClick={() => {
                context.recordHistory();
                updateNode(current => current.type === 'generation'
                  ? { ...current, data: { ...current.data, selected_output_index: index } }
                  : current);
              }}
              className={cn('overflow-hidden rounded-md border', (node.data.selected_output_index ?? 0) === index ? 'border-primary' : 'border-border')}
            >
              {node.data.media_kind === 'image' ? (
                <img src={canvasMediaUrl(context.projectId, { path, job_id: activeJob.job_id })} alt="" loading="lazy" className="aspect-square w-full object-cover" />
              ) : (
                <video src={canvasMediaUrl(context.projectId, { path, job_id: activeJob.job_id })} muted preload="metadata" className="aspect-square w-full object-cover" />
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

type InspectorNode = Exclude<CanvasNode, CanvasGenerationNode>;

export function CanvasInspector({
  node,
  updateNode,
  recordHistory,
  deleteNode,
  projectId,
}: {
  node: InspectorNode;
  updateNode: (updater: (node: CanvasNode) => CanvasNode) => void;
  recordHistory: () => void;
  deleteNode: () => void;
  projectId: string;
}) {
  return (
    <aside className="absolute inset-x-3 bottom-3 z-30 max-h-[46vh] overflow-y-auto rounded-xl border border-border bg-glass p-4 backdrop-blur-glass shell-glow md:inset-x-auto md:bottom-4 md:right-4 md:top-20 md:w-80 md:max-h-none">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-label text-muted-foreground">节点设置</p>
          <h2 className="mt-1 text-base font-medium">{nodeTitle(node)}</h2>
        </div>
        <Button variant="ghost" size="icon" className="size-9 text-muted-foreground hover:text-destructive" aria-label="删除节点" onClick={deleteNode}>
          <Trash2 aria-hidden="true" />
        </Button>
      </div>

      {node.type === 'text' ? (
        <div className="space-y-3">
          <Field label="标题">
            <input
              value={node.data.title ?? ''}
              onFocus={recordHistory}
              onChange={event => updateNode(current => current.type === 'text' ? { ...current, data: { ...current.data, title: event.target.value } } : current)}
              className="canvas-input"
            />
          </Field>
          <Field label="正文">
            <textarea
              rows={7}
              value={node.data.text}
              onFocus={recordHistory}
              onChange={event => updateNode(current => current.type === 'text' ? { ...current, data: { ...current.data, text: event.target.value } } : current)}
              className="canvas-input resize-y"
              placeholder="写下脚本、提示词或创作备注…"
            />
          </Field>
        </div>
      ) : (
        <div className="space-y-3">
          <MediaPreview kind={node.data.media_kind} src={canvasMediaUrl(projectId, node.data)} compact />
          <p className="break-all text-xs text-muted-foreground">{node.data.filename}</p>
        </div>
      )}
    </aside>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1.5 text-xs text-muted-foreground"><span>{label}</span>{children}</label>;
}

export function ToolButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn('grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30', active && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground')}
    >
      <span className="[&>svg]:size-5">{children}</span>
    </button>
  );
}

export function AddMenuButton({ icon, title, description, onClick }: { icon: React.ReactNode; title: string; description?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground [&>svg]:size-4">{icon}</span>
      <span className="min-w-0"><span className="block text-sm font-medium text-foreground">{title}</span>{description && <span className="block truncate text-xs text-muted-foreground">{description}</span>}</span>
    </button>
  );
}

export function MediaPreview({ kind, src, compact = false }: { kind: 'image' | 'video' | 'audio'; src: string; compact?: boolean }) {
  if (kind === 'image') return <img src={src} alt="" loading="lazy" draggable={false} className={cn('w-full object-cover', compact ? 'max-h-44 rounded-lg' : 'h-44')} />;
  if (kind === 'video') return <video src={src} controls={compact} muted={!compact} preload="metadata" playsInline className={cn('w-full object-cover', compact ? 'max-h-44 rounded-lg' : 'h-44')} />;
  return <div className="grid min-h-24 place-items-center gap-2 p-4 text-muted-foreground"><FileAudio className="size-7" /><audio src={src} controls className="nodrag w-full" /></div>;
}

export function JobState({ status }: { status: Job['status'] }) {
  const label = status === 'done' ? '完成' : status === 'failed' ? '失败' : '生成中';
  return <span className={cn('rounded-full px-2 py-0.5', status === 'done' ? 'bg-status-done/15 text-status-done' : status === 'failed' ? 'bg-status-failed/15 text-status-failed' : 'bg-status-running/15 text-status-running')}>{label}</span>;
}

export function EditorMessage({ icon, text, action }: { icon?: React.ReactNode; text: string; action?: React.ReactNode }) {
  return <div className="grid h-full place-items-center bg-background"><div className="flex flex-col items-center gap-4 text-sm text-muted-foreground">{icon}{text}{action}</div></div>;
}

function updateGenerationParam(
  updateNode: (updater: (node: CanvasNode) => CanvasNode) => void,
  key: string,
  value: unknown,
) {
  updateNode(current => current.type === 'generation'
    ? { ...current, data: { ...current.data, draft: { ...current.data.draft, params: { ...current.data.draft.params, [key]: value } } } }
    : current);
}

function nodeTitle(node: CanvasNode) {
  if (node.type === 'text') return node.data.title || '文本';
  if (node.type === 'resource') return node.data.filename;
  return node.data.media_kind === 'image' ? '图片生成' : '视频生成';
}

export function mediaIcon(kind: 'image' | 'video' | 'audio') {
  if (kind === 'image') return <FileImage className="size-3.5" />;
  if (kind === 'video') return <FileVideo className="size-3.5" />;
  return <FileAudio className="size-3.5" />;
}

export const canvasNodeTypes = { canvasNode: memo(CanvasNodeCard) };
