import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  Check,
  FileAudio,
  FileImage,
  FileVideo,
  ImagePlus,
  LoaderCircle,
  Sparkles,
  Trash2,
  Type,
  Video,
} from 'lucide-react';
import { createContext, memo, useContext } from 'react';

import { canvasMediaUrl } from '@/api/canvas';
import { modelModality, type KeyView } from '@/api/keys';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CanvasGenerationNode, CanvasNode } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';

export type FlowNode = Node<{ domain: CanvasNode }, 'canvasNode'>;

export interface CanvasNodeContextValue {
  projectId: string;
  jobs: ReadonlyMap<string, Job>;
  referenceIds: ReadonlySet<string>;
  selectedId: string | null;
  selectNode: (id: string) => void;
  toggleReference: (id: string) => void;
}

export const CanvasNodeContext = createContext<CanvasNodeContextValue | null>(null);

function CanvasNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const context = useContext(CanvasNodeContext);
  if (!context) return null;
  const node = data.domain;
  const referenced = context.referenceIds.has(node.id);
  const activeJob = node.type === 'generation' && node.data.active_job_id
    ? context.jobs.get(node.data.active_job_id)
    : undefined;
  const selectedOutput = node.type === 'generation' && activeJob?.status === 'done'
    ? activeJob.output_paths[node.data.selected_output_index ?? 0]
    : undefined;

  return (
    <article
      className={cn(
        'group relative w-64 overflow-hidden rounded-lg border bg-card/95 text-foreground transition-colors shell-glow',
        selected ? 'border-primary' : referenced ? 'border-primary/50' : 'border-border',
      )}
      onClick={() => context.selectNode(node.id)}
    >
      {node.type === 'generation' && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {node.type === 'text' ? <Type className="size-3.5" /> : node.type === 'resource' ? mediaIcon(node.data.media_kind) : node.data.media_kind === 'image' ? <Sparkles className="size-3.5" /> : <Video className="size-3.5" />}
          {node.type === 'text' ? node.data.title || '文本' : node.type === 'resource' ? node.data.filename : node.data.media_kind === 'image' ? '图片生成' : '视频生成'}
        </span>
        {node.type === 'generation' && activeJob && <JobState status={activeJob.status} />}
      </header>
      <div className="min-h-32 bg-secondary/20">
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
          <div className="grid min-h-32 place-items-center px-4 text-center text-xs text-muted-foreground">
            {activeJob?.status === 'failed' ? activeJob.error || '生成失败' : activeJob?.status === 'pending' ? '正在生成…' : '选择节点，填写提示词后生成'}
          </div>
        )}
      </div>
      <button
        type="button"
        className={cn('nodrag absolute right-2 top-10 rounded-full border px-2 py-1 text-xs backdrop-blur-glass transition-colors', referenced ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-glass text-muted-foreground opacity-0 group-hover:opacity-100')}
        onClick={event => { event.stopPropagation(); context.toggleReference(node.id); }}
      >
        {referenced ? '已参考' : '设为参考'}
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </article>
  );
}

export function CanvasInspector({
  node,
  jobs,
  keys,
  generating,
  referenced,
  updateNode,
  recordHistory,
  toggleReference,
  deleteNode,
  generate,
  projectId,
}: {
  node: CanvasNode;
  jobs: ReadonlyMap<string, Job>;
  keys: KeyView[];
  generating: boolean;
  referenced: boolean;
  updateNode: (updater: (node: CanvasNode) => CanvasNode) => void;
  recordHistory: () => void;
  toggleReference: () => void;
  deleteNode: () => void;
  generate: (node: CanvasGenerationNode) => void;
  projectId: string;
}) {
  const activeJob = node.type === 'generation' && node.data.active_job_id ? jobs.get(node.data.active_job_id) : undefined;
  const availableKeys = node.type === 'generation'
    ? keys.filter(key => key.models.some(model => modelModality(model, key) === node.data.media_kind))
    : [];

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

      {node.type === 'text' && (
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
      )}

      {node.type === 'resource' && (
        <div className="space-y-3">
          <MediaPreview kind={node.data.media_kind} src={canvasMediaUrl(projectId, node.data)} compact />
          <p className="break-all text-xs text-muted-foreground">{node.data.filename}</p>
        </div>
      )}

      {node.type === 'generation' && (
        <div className="space-y-3">
          <Field label="密钥">
            <select
              value={node.data.draft.alias ?? ''}
              onFocus={recordHistory}
              onChange={event => {
                const key = keys.find(item => item.alias === event.target.value);
                const model = key?.models.find(item => modelModality(item, key) === node.data.media_kind)?.id ?? '';
                updateNode(current => current.type === 'generation' ? { ...current, data: { ...current.data, draft: { ...current.data.draft, alias: event.target.value, model } } } : current);
              }}
              className="canvas-input"
            >
              <option value="">选择密钥</option>
              {availableKeys.map(key => <option key={key.alias} value={key.alias}>{key.alias} · {key.provider}</option>)}
            </select>
          </Field>
          <Field label="模型">
            <select
              value={node.data.draft.model}
              onFocus={recordHistory}
              onChange={event => updateNode(current => current.type === 'generation' ? { ...current, data: { ...current.data, draft: { ...current.data.draft, model: event.target.value } } } : current)}
              className="canvas-input"
            >
              <option value="">选择模型</option>
              {(keys.find(key => key.alias === node.data.draft.alias)?.models ?? [])
                .filter(model => modelModality(model, keys.find(key => key.alias === node.data.draft.alias)) === node.data.media_kind)
                .map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
            </select>
          </Field>
          <Field label="提示词">
            <textarea
              rows={5}
              value={node.data.draft.prompt}
              onFocus={recordHistory}
              onChange={event => updateNode(current => current.type === 'generation' ? { ...current, data: { ...current.data, draft: { ...current.data.draft, prompt: event.target.value } } } : current)}
              className="canvas-input resize-y"
              placeholder={node.data.media_kind === 'image' ? '描述想生成的画面…' : '描述镜头运动与画面变化…'}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="比例">
              <select
                value={String(node.data.draft.params.ratio ?? (node.data.media_kind === 'image' ? '1:1' : '16:9'))}
                onFocus={recordHistory}
                onChange={event => updateGenerationParam(updateNode, 'ratio', event.target.value)}
                className="canvas-input"
              >
                {['1:1', '16:9', '9:16', '4:3', '3:4'].map(value => <option key={value}>{value}</option>)}
              </select>
            </Field>
            {node.data.media_kind === 'image' ? (
              <Field label="数量">
                <select value={Number(node.data.draft.params.n ?? 1)} onFocus={recordHistory} onChange={event => updateGenerationParam(updateNode, 'n', Number(event.target.value))} className="canvas-input">
                  {[1, 2, 3, 4].map(value => <option key={value}>{value}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="时长">
                <select value={Number(node.data.draft.params.duration ?? 5)} onFocus={recordHistory} onChange={event => updateGenerationParam(updateNode, 'duration', Number(event.target.value))} className="canvas-input">
                  {[5, 10].map(value => <option key={value} value={value}>{value} 秒</option>)}
                </select>
              </Field>
            )}
          </div>
          {node.data.job_ids.length > 1 && (
            <Field label="生成轮次">
              <select
                value={node.data.active_job_id ?? node.data.job_ids.at(-1) ?? ''}
                onFocus={recordHistory}
                onChange={event => updateNode(current => current.type === 'generation'
                  ? { ...current, data: { ...current.data, active_job_id: event.target.value, selected_output_index: 0 } }
                  : current)}
                className="canvas-input"
              >
                {[...node.data.job_ids].reverse().map((jobId, reverseIndex) => {
                  const row = jobs.get(jobId);
                  return <option key={jobId} value={jobId}>第 {node.data.job_ids.length - reverseIndex} 轮 · {row?.status === 'done' ? '完成' : row?.status === 'failed' ? '失败' : '生成中'}</option>;
                })}
              </select>
            </Field>
          )}
          {activeJob?.status === 'failed' && <p role="alert" className="text-xs text-destructive">{activeJob.error || '生成失败'}</p>}
          {activeJob?.status === 'done' && activeJob.output_paths.length > 1 && (
            <div className="grid grid-cols-4 gap-2" aria-label="选择生成结果">
              {activeJob.output_paths.map((path, index) => (
                <button
                  type="button"
                  key={path}
                  aria-label={`选择结果 ${index + 1}`}
                  aria-pressed={(node.data.selected_output_index ?? 0) === index}
                  onClick={() => {
                    recordHistory();
                    updateNode(current => current.type === 'generation' ? { ...current, data: { ...current.data, selected_output_index: index } } : current);
                  }}
                  className={cn('overflow-hidden rounded-md border', (node.data.selected_output_index ?? 0) === index ? 'border-primary' : 'border-border')}
                >
                  {node.data.media_kind === 'image' ? (
                    <img src={canvasMediaUrl(projectId, { path, job_id: activeJob.job_id })} alt="" loading="lazy" className="aspect-square w-full object-cover" />
                  ) : (
                    <video src={canvasMediaUrl(projectId, { path, job_id: activeJob.job_id })} muted preload="metadata" className="aspect-square w-full object-cover" />
                  )}
                </button>
              ))}
            </div>
          )}
          <Button className="w-full" disabled={generating || activeJob?.status === 'pending'} onClick={() => void generate(node)}>
            {generating || activeJob?.status === 'pending' ? <><LoaderCircle className="animate-spin" />生成中…</> : <><Sparkles />{node.data.job_ids.length ? '再次生成' : '开始生成'}</>}
          </Button>
        </div>
      )}

      <Button variant="outline" className="mt-4 w-full" aria-pressed={referenced} onClick={toggleReference}>
        {referenced ? <><Check />已设为参考</> : <><ImagePlus />设为下次生成参考</>}
      </Button>
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
  if (kind === 'image') return <img src={src} alt="" loading="lazy" draggable={false} className={cn('w-full object-cover', compact ? 'max-h-44 rounded-lg' : 'h-40')} />;
  if (kind === 'video') return <video src={src} controls={compact} muted={!compact} preload="metadata" playsInline className={cn('w-full object-cover', compact ? 'max-h-44 rounded-lg' : 'h-40')} />;
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
