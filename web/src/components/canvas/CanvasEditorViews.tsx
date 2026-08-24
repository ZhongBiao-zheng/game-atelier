import { Handle, NodeResizer, Position, type Node, type NodeProps } from '@xyflow/react';
import { Check, ClipboardCopy, Crop, Download, Ellipsis, Eye, FileAudio, FileImage, FileUp, FileVideo, Grid2X2, Library, LoaderCircle, Lock, Paintbrush, Plus, RotateCcw, ScanText, Sparkles, Square, Trash2, Type, Unlock, ZoomIn } from 'lucide-react';
import { createContext, memo, useCallback, useContext, useEffect, useRef, useState, type Ref } from 'react';

import { canvasDownloadUrl, canvasMediaUrl } from '@/api/canvas';
import { modelModality, type KeyView } from '@/api/keys';
import { Button } from '@/components/ui/button';
import type { CanvasMediaTool } from '@/components/canvas/CanvasMediaOperationDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  jobsByResultNodeId: ReadonlyMap<string, Job[]>;
  submittingNodeIds: ReadonlySet<string>;
  mediaReplaceBusyNodeIds: ReadonlySet<string>;
  mediaReplaceError: { nodeId: string; message: string } | null;
  libraryBusy: boolean;
  selectNode: (id: string) => void;
  previewContent: (id: string, title: string, nodeId: string) => void;
  selectCandidate: (id: string, versionId: string) => void;
  submitRun: (id: string) => Promise<void>;
  retryRun: (id: string, runId: string, mode: 'original' | 'current', candidateId?: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  updateNode: (id: string, updater: (node: CanvasNode) => CanvasNode) => void;
  updateText: (id: string, text: string) => void;
  recordHistory: () => void;
  saveAsset: (node: CanvasContentNode) => Promise<void>;
  copyPrompt: (node: CanvasContentNode) => Promise<void>;
  reversePrompt: (node: CanvasContentNode) => Promise<void>;
  recoverReversePromptConfig: (job: Job) => Promise<void>;
  reversePromptConfiguredNodeIds: ReadonlySet<string>;
  replaceMedia: (node: CanvasContentNode) => void;
  toggleFreeResize: (node: CanvasContentNode) => void;
  openMediaOperation: (node: CanvasContentNode, tool: CanvasMediaTool) => void;
  openMaskEdit: (node: CanvasContentNode) => void;
  deleteNode: (id: string) => void;
}

export const CanvasNodeContext = createContext<CanvasNodeContextValue | null>(null);

export function CanvasNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const context = useContext(CanvasNodeContext);
  if (!context) return null;
  const node = data.domain;
  const content = contentForNode(node, context.contentVersions);
  const draft = generationDraft(node);
  const copyablePrompt = copyablePromptForNode(
    node,
    context.jobsByResultNodeId,
  );
  const compactMediaTools = (node.size?.width ?? 320) < 480;
  const replacingMedia = context.mediaReplaceBusyNodeIds.has(node.id);
  const imageResizeUnlocked = node.type === 'image' && node.data.display.free_resize;
  const submittingNode = context.submittingNodeIds.has(node.id);
  const nodeRunId = activeRunId(node);
  const nodeJob = nodeRunId ? context.jobsByRunId.get(nodeRunId) : undefined;
  const reversePromptJob = nodeJob && isReversePromptJob(nodeJob) ? nodeJob : undefined;
  const reversePromptRunning = reversePromptJob?.status === 'pending' || reversePromptJob?.status === 'pending_confirm';
  const reversePromptSucceeded = reversePromptJob?.canvas_run?.candidates.some(candidate => candidate.status === 'succeeded') ?? false;

  return (
    <div className="canvas-node-shell group relative h-full w-full overflow-visible" data-selected={selected ? 'true' : 'false'}>
      <NodeResizer
        isVisible={selected && !replacingMedia}
        keepAspectRatio={node.type === 'image' && !node.data.display.free_resize}
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
        <span className="flex shrink-0 items-center gap-1">
          {content && providesContent(node) && (
            <button
              type="button"
              disabled={context.libraryBusy}
              aria-label={`将 ${node.title} 存入资产库`}
              className="nodrag grid size-7 place-items-center rounded-full text-muted-foreground opacity-0 transition-[color,opacity,background-color] hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-30 group-focus-within:opacity-100 group-hover:opacity-100"
              onClick={event => {
                event.stopPropagation();
                void context.saveAsset(node);
              }}
            >
              <Library className="size-3.5" aria-hidden="true" />
            </button>
          )}
          {content && (
            <button
              type="button"
              title={`查看 ${node.title} 详情`}
              aria-label={`查看 ${node.title} 详情`}
              className="nodrag grid size-7 place-items-center rounded-full text-muted-foreground opacity-0 transition-[color,opacity,background-color] hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-focus-within:opacity-100 group-hover:opacity-100"
              onClick={event => {
                event.stopPropagation();
                context.previewContent(content.version_id, node.title, node.id);
              }}
            >
              <Eye className="size-3.5" aria-hidden="true" />
            </button>
          )}
          {content && content.kind !== 'text' && (
            <a
              href={canvasDownloadUrl(context.projectId, content.version_id)}
              title={`下载 ${node.title}`}
              aria-label={`下载 ${node.title}`}
              className="nodrag grid size-7 place-items-center rounded-full text-muted-foreground opacity-0 transition-[color,opacity,background-color] hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-focus-within:opacity-100 group-hover:opacity-100"
              onClick={event => event.stopPropagation()}
            >
              <Download className="size-3.5" aria-hidden="true" />
            </a>
          )}
          {copyablePrompt && providesContent(node) && (
            <button
              type="button"
              title={`复制 ${node.title} 的生成提示词`}
              aria-label={`复制 ${node.title} 的生成提示词`}
              className="nodrag grid size-7 place-items-center rounded-full text-muted-foreground opacity-0 transition-[color,opacity,background-color] hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-focus-within:opacity-100 group-hover:opacity-100"
              onClick={event => {
                event.stopPropagation();
                void context.copyPrompt(node);
              }}
            >
              <ClipboardCopy className="size-3.5" aria-hidden="true" />
            </button>
          )}
          {node.type === 'image' && content?.kind === 'image' && !compactMediaTools && (
            <MediaToolButton
              label={`反推 ${node.title} 的提示词`}
              disabled={submittingNode || replacingMedia}
              onClick={() => void context.reversePrompt(node)}
            >
              {submittingNode ? <LoaderCircle className="animate-spin" /> : <ScanText />}
            </MediaToolButton>
          )}
          {content && content.kind !== 'text' && providesContent(node) && (!compactMediaTools || node.type !== 'image') && (
            <MediaToolButton
              label={`替换 ${node.title}`}
              disabled={replacingMedia}
              onClick={() => context.replaceMedia(node)}
            >
              {replacingMedia ? <LoaderCircle className="animate-spin" /> : <FileUp />}
            </MediaToolButton>
          )}
          {node.type === 'image' && content?.kind === 'image' && (
            compactMediaTools ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    title={`更多 ${node.title} 图片工具`}
                    aria-label={`更多 ${node.title} 图片工具`}
                    className="nodrag grid size-7 place-items-center rounded-full text-muted-foreground opacity-0 transition-[color,opacity,background-color] hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                    onClick={event => event.stopPropagation()}
                  >
                    <Ellipsis className="size-3.5" aria-hidden="true" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onClick={event => event.stopPropagation()}>
                  <MediaToolMenuItem label={`反推 ${node.title} 的提示词`} disabled={submittingNode || replacingMedia} onSelect={() => void context.reversePrompt(node)}>{submittingNode ? <LoaderCircle className="animate-spin" /> : <ScanText />}</MediaToolMenuItem>
                  <MediaToolMenuItem label={`替换 ${node.title}`} disabled={replacingMedia} onSelect={() => context.replaceMedia(node)}>{replacingMedia ? <LoaderCircle className="animate-spin" /> : <FileUp />}</MediaToolMenuItem>
                  <MediaToolMenuItem label={imageResizeUnlocked ? `锁定 ${node.title} 比例` : `自由缩放 ${node.title}`} disabled={replacingMedia} onSelect={() => context.toggleFreeResize(node)}>{imageResizeUnlocked ? <Lock /> : <Unlock />}</MediaToolMenuItem>
                  <MediaToolMenuItem label={`裁剪 ${node.title}`} disabled={replacingMedia} onSelect={() => context.openMediaOperation(node, 'crop')}><Crop /></MediaToolMenuItem>
                  <MediaToolMenuItem label={`局部编辑 ${node.title}`} disabled={submittingNode || replacingMedia} onSelect={() => context.openMaskEdit(node)}><Paintbrush /></MediaToolMenuItem>
                  <MediaToolMenuItem label={`切分 ${node.title}`} disabled={replacingMedia} onSelect={() => context.openMediaOperation(node, 'split')}><Grid2X2 /></MediaToolMenuItem>
                  <MediaToolMenuItem label={`本地放大 ${node.title}`} disabled={replacingMedia} onSelect={() => context.openMediaOperation(node, 'upscale')}><ZoomIn /></MediaToolMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <>
                <MediaToolButton label={imageResizeUnlocked ? `锁定 ${node.title} 比例` : `自由缩放 ${node.title}`} disabled={replacingMedia} onClick={() => context.toggleFreeResize(node)}>{imageResizeUnlocked ? <Lock /> : <Unlock />}</MediaToolButton>
                <MediaToolButton label={`裁剪 ${node.title}`} disabled={replacingMedia} onClick={() => context.openMediaOperation(node, 'crop')}><Crop /></MediaToolButton>
                <MediaToolButton label={`局部编辑 ${node.title}`} disabled={submittingNode || replacingMedia} onClick={() => context.openMaskEdit(node)}><Paintbrush /></MediaToolButton>
                <MediaToolButton label={`切分 ${node.title}`} disabled={replacingMedia} onClick={() => context.openMediaOperation(node, 'split')}><Grid2X2 /></MediaToolButton>
                <MediaToolButton label={`本地放大 ${node.title}`} disabled={replacingMedia} onClick={() => context.openMediaOperation(node, 'upscale')}><ZoomIn /></MediaToolButton>
              </>
            )
          )}
          {reversePromptJob && reversePromptRunning && (
            <MediaToolButton
              label="停止反推提示词"
              disabled={Boolean(reversePromptJob.cancel_requested_at)}
              onClick={() => void context.cancelRun(reversePromptJob.canvas_run!.run_id)}
            >
              {reversePromptJob.cancel_requested_at ? <LoaderCircle className="animate-spin" /> : <Square />}
            </MediaToolButton>
          )}
          {reversePromptJob && !reversePromptRunning && !reversePromptSucceeded && (
            <MediaToolButton
              label="按原设置重试反推提示词"
              disabled={submittingNode}
              onClick={() => void context.retryRun(node.id, reversePromptJob.canvas_run!.run_id, 'original')}
            >
              {submittingNode ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
            </MediaToolButton>
          )}
          {reversePromptJob && reversePromptSucceeded && !context.reversePromptConfiguredNodeIds.has(node.id) && (
            <MediaToolButton
              label="从反推文本创建图片配置"
              disabled={submittingNode}
              onClick={() => void context.recoverReversePromptConfig(reversePromptJob)}
            >
              {submittingNode ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
            </MediaToolButton>
          )}
          <button
            type="button"
            aria-label="删除节点"
            className="nodrag grid size-7 place-items-center rounded-full text-muted-foreground opacity-0 transition-[color,opacity,background-color] hover:bg-secondary hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-focus-within:opacity-100 group-hover:opacity-100"
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
        data-canvas-node-id={node.id}
        role="button"
        tabIndex={0}
        aria-busy={replacingMedia}
        aria-label={`选择节点 ${node.title}`}
        className={cn(
          'relative h-full overflow-hidden rounded-lg border bg-card/95 text-foreground transition-colors shell-glow',
          selected ? 'border-primary' : 'border-border',
        )}
        onClick={event => {
          event.stopPropagation();
          context.selectNode(node.id);
        }}
        onDoubleClick={event => {
          if (!content) return;
          event.stopPropagation();
          context.previewContent(content.version_id, node.title, node.id);
        }}
        onKeyDown={event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          context.selectNode(node.id);
        }}
      >
        {context.mediaReplaceError?.nodeId === node.id && (
          <p role="alert" className="absolute inset-x-2 top-2 z-20 rounded-md border border-destructive/40 bg-card/95 px-2 py-1.5 text-xs text-destructive">
            {context.mediaReplaceError.message}
          </p>
        )}
        <div className={cn('h-full bg-secondary/20', node.type === 'text' ? 'min-h-32' : 'min-h-44')}>
          {node.type === 'text' && (
            <p className="line-clamp-5 whitespace-pre-wrap p-3 text-sm leading-relaxed text-foreground">
              {content?.kind === 'text' && content.text
                ? content.text
                : reversePromptRunning
                  ? '正在分析图片并整理提示词…'
                  : reversePromptJob?.status === 'failed'
                    ? reversePromptJob.error || '反推提示词失败，可从节点工具栏重试'
                : draft ? '选择节点，填写下方生成设置' : '选择节点后输入文本…'}
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
        <div className="absolute left-1/2 top-full z-20 hidden w-[38rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 pt-6 md:block">
          <CanvasGenerationComposer node={node} draft={draft} context={context} />
        </div>
      )}
    </div>
  );
}

export function CanvasGenerationComposer({
  node,
  draft,
  context,
  embedded = false,
}: {
  node: CanvasNode;
  draft: CanvasGenerationDraft;
  context: CanvasNodeContextValue;
  embedded?: boolean;
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
      aria-label={`${{ text: '文本', image: '图片', video: '视频', audio: '音频' }[draft.mode]}生成设置`}
      data-floating-node-panel="true"
      className={cn(
        'nodrag nowheel',
        embedded ? 'canvas-mobile-generation' : 'rounded-xl border border-border bg-glass p-4 backdrop-blur-glass shell-glow',
      )}
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
        placeholder={draft.mode === 'video'
          ? '描述镜头运动与画面变化'
          : draft.mode === 'audio'
            ? '输入需要朗读的文本'
            : draft.mode === 'text' ? '描述要创作的文案、脚本或内容' : '描述任何你想要生成的内容'}
      />
      <CandidateHistory
        nodeId={node.id}
        primaryVersionId={node.type === 'text' || node.type === 'image' || node.type === 'video' || node.type === 'audio'
          ? node.data.current_version_id : null}
        context={context}
        running={Boolean(running)}
        submitting={submitting}
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
        {(draft.mode === 'text' || draft.mode === 'image') && (
          <select
            aria-label="候选数"
            value={String(draft.params.n ?? 1)}
            onFocus={context.recordHistory}
            onChange={event => updateDraft(current => ({
              ...current,
              params: { ...current.params, n: Number(event.target.value) },
              updated_at: new Date().toISOString(),
            }))}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value} 个候选</option>)}
          </select>
        )}
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
        {draft.mode === 'audio' && (
          <>
            <select
              aria-label="声音"
              value={String(draft.params.voice ?? 'alloy')}
              onFocus={context.recordHistory}
              onChange={event => updateDraft(current => ({
                ...current,
                params: { ...current.params, voice: event.target.value },
                updated_at: new Date().toISOString(),
              }))}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar'].map(value => <option key={value}>{value}</option>)}
            </select>
            <select
              aria-label="音频格式"
              value={String(draft.params.response_format ?? 'mp3')}
              onFocus={context.recordHistory}
              onChange={event => updateDraft(current => ({
                ...current,
                params: { ...current.params, response_format: event.target.value },
                updated_at: new Date().toISOString(),
              }))}
              className="h-9 rounded-md border border-input bg-transparent px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {['mp3', 'wav', 'opus', 'aac', 'flac'].map(value => <option key={value}>{value}</option>)}
            </select>
          </>
        )}
        <span className="max-w-52 truncate text-xs text-muted-foreground" title={runStatus(activeJob)}>
          {runStatus(activeJob)}
        </span>
        {running && activeJob && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={Boolean(activeJob.cancel_requested_at)}
            onClick={() => void context.cancelRun(activeJob.canvas_run!.run_id)}
          >
            {activeJob.cancel_requested_at ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Square aria-hidden="true" />}
            {activeJob.cancel_requested_at ? '正在停止…' : '停止'}
          </Button>
        )}
        {!running && activeJob && runId && (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto"
              disabled={submitting}
              onClick={() => void context.retryRun(node.id, runId, 'original')}
            >
              <RotateCcw aria-hidden="true" />
              原设置重试
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={submitting || !draft.prompt.trim() || !draft.alias || !draft.model}
              onClick={() => void context.retryRun(node.id, runId, 'current')}
            >
              {submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
              {submitting ? '提交中…' : '当前设置再生成'}
            </Button>
          </>
        )}
        {!running && !activeJob && (
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            disabled={submitting || !draft.prompt.trim() || !draft.alias || !draft.model}
            onClick={() => void context.submitRun(node.id)}
          >
            {submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
            {submitting ? '提交中…' : '开始生成'}
          </Button>
        )}
      </div>
    </section>
  );
}

type CandidateEntry = {
  job: Job;
  candidate: NonNullable<Job['canvas_run']>['candidates'][number];
};

function CandidateHistory({
  nodeId,
  primaryVersionId,
  context,
  running,
  submitting,
}: {
  nodeId: string;
  primaryVersionId: string | null;
  context: CanvasNodeContextValue;
  running: boolean;
  submitting: boolean;
}) {
  const entries: CandidateEntry[] = (context.jobsByResultNodeId.get(nodeId) ?? []).flatMap(job => (
    job.canvas_run?.candidates.map(candidate => ({ job, candidate })) ?? []
  ));
  if (!entries.length) return null;
  const currentByIndex = new Map<number, CandidateEntry>();
  for (const entry of entries) currentByIndex.set(entry.candidate.index, entry);
  const current = [...currentByIndex.values()].sort((a, b) => a.candidate.index - b.candidate.index);
  const currentIds = new Set(current.map(entry => entry.candidate.candidate_id));
  const history = entries.filter(entry => !currentIds.has(entry.candidate.candidate_id)).reverse();

  return (
    <div className="border-t border-border/70 py-3">
      <CandidateGrid
        label="当前候选结果"
        entries={current}
        context={context}
        nodeId={nodeId}
        primaryVersionId={primaryVersionId}
        retryDisabled={running || submitting}
      />
      {history.length > 0 && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none py-1">历史候选 · {history.length}</summary>
          <CandidateGrid
            label="历史候选结果"
            entries={history}
            context={context}
            nodeId={nodeId}
            primaryVersionId={primaryVersionId}
            retryDisabled={running || submitting}
          />
        </details>
      )}
    </div>
  );
}

function CandidateGrid({
  label,
  entries,
  context,
  nodeId,
  primaryVersionId,
  retryDisabled,
}: {
  label: string;
  entries: CandidateEntry[];
  context: CanvasNodeContextValue;
  nodeId: string;
  primaryVersionId: string | null;
  retryDisabled: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={label}>
      {entries.map(({ job, candidate }) => {
        const version = candidate.version_id ? context.contentVersions[candidate.version_id] : undefined;
        return (
          <div
            key={candidate.candidate_id}
            className={cn(
              'relative min-h-20 overflow-hidden rounded-md border bg-secondary/30',
              candidate.version_id === primaryVersionId ? 'border-primary' : 'border-border',
            )}
          >
            {version?.kind === 'text'
              ? <p className="line-clamp-4 min-h-20 whitespace-pre-wrap p-2 text-xs leading-relaxed text-foreground">{version.text}</p>
              : version
                ? <MediaPreview kind={version.kind} src={canvasMediaUrl(context.projectId, version.version_id)} />
                : (
                <div className="grid min-h-20 place-items-center px-2 text-center text-xs text-muted-foreground">
                  {candidate.status === 'pending'
                    ? <LoaderCircle className="animate-spin" aria-label="候选生成中" />
                    : candidate.status === 'canceled' ? candidate.error || '已停止' : candidate.error || '结果待同步'}
                </div>
                )}
            <span className="absolute left-1.5 top-1.5 rounded bg-background/80 px-1.5 py-0.5 text-xs text-muted-foreground">
              {candidate.index + 1}
            </span>
            {!retryDisabled && candidate.version_id && candidate.version_id !== primaryVersionId && (
              <button
                type="button"
                aria-label={`将候选 ${candidate.index + 1} 设为主结果`}
                title="设为主结果"
                className="absolute bottom-1.5 left-1.5 grid size-7 place-items-center rounded-full border border-border bg-background/90 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => context.selectCandidate(nodeId, candidate.version_id!)}
              >
                <Check className="size-3.5" aria-hidden="true" />
              </button>
            )}
            {!retryDisabled && job.canvas_run && (
              <button
                type="button"
                aria-label={`重试候选 ${candidate.index + 1}`}
                title="按原设置重试这个候选"
                className="absolute bottom-1.5 right-1.5 grid size-7 place-items-center rounded-full border border-border bg-background/90 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => void context.retryRun(
                  nodeId,
                  job.canvas_run!.run_id,
                  'original',
                  candidate.candidate_id,
                )}
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
    </div>
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
  mobileGeneration,
  onPreview,
  onSaveAsset,
  onCopyPrompt,
  onReversePrompt,
  onReplaceMedia,
  onToggleFreeResize,
  downloadHref,
  onCrop,
  onMaskEdit,
  onSplit,
  onUpscale,
  replaceMediaBusy = false,
  reversePromptBusy = false,
  saveAssetBusy = false,
}: {
  node: CanvasContentNode;
  updateNode: (updater: (node: CanvasNode) => CanvasNode) => void;
  updateText: (text: string) => void;
  recordHistory: () => void;
  deleteNode: () => void;
  projectId: string;
  contentVersions: Readonly<Record<string, CanvasContentVersion>>;
  mobileGeneration?: React.ReactNode;
  onPreview?: () => void;
  onSaveAsset?: () => void;
  onCopyPrompt?: () => void;
  onReversePrompt?: () => void;
  onReplaceMedia?: () => void;
  onToggleFreeResize?: () => void;
  downloadHref?: string;
  onCrop?: () => void;
  onMaskEdit?: () => void;
  onSplit?: () => void;
  onUpscale?: () => void;
  replaceMediaBusy?: boolean;
  reversePromptBusy?: boolean;
  saveAssetBusy?: boolean;
}) {
  const content = contentForNode(node, contentVersions);
  return (
    <aside className="canvas-inspector-panel absolute inset-x-3 bottom-3 z-20 rounded-xl border border-border bg-glass p-3 backdrop-blur-glass shell-glow md:bottom-auto md:left-auto md:right-4 md:top-20 md:w-72">
      <div className="mb-3 flex flex-col gap-2">
        <p className="truncate text-sm font-medium">{node.title}</p>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {content && onPreview && (
            <Button variant="ghost" size="icon" aria-label={`查看 ${node.title} 详情`} onClick={onPreview}><Eye /></Button>
          )}
          {content && content.kind !== 'text' && downloadHref && (
            <Button asChild variant="ghost" size="icon">
              <a href={downloadHref} aria-label={`下载 ${node.title}`}><Download /></a>
            </Button>
          )}
          {onCopyPrompt && (
            <Button variant="ghost" size="icon" aria-label={`复制 ${node.title} 的生成提示词`} onClick={onCopyPrompt}><ClipboardCopy /></Button>
          )}
          {content?.kind === 'image' && onReversePrompt && (
            <Button variant="ghost" size="icon" disabled={reversePromptBusy || replaceMediaBusy} aria-label={`反推 ${node.title} 的提示词`} onClick={onReversePrompt}>
              {reversePromptBusy ? <LoaderCircle className="animate-spin" /> : <ScanText />}
            </Button>
          )}
          {content && content.kind !== 'text' && onReplaceMedia && (
            <Button variant="ghost" size="icon" disabled={replaceMediaBusy} aria-label={`替换 ${node.title}`} onClick={onReplaceMedia}>
              {replaceMediaBusy ? <LoaderCircle className="animate-spin" /> : <FileUp />}
            </Button>
          )}
          {node.type === 'image' && content?.kind === 'image' && onToggleFreeResize && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={node.data.display.free_resize ? `锁定 ${node.title} 比例` : `自由缩放 ${node.title}`}
              disabled={replaceMediaBusy}
              onClick={onToggleFreeResize}
            >
              {node.data.display.free_resize ? <Lock /> : <Unlock />}
            </Button>
          )}
          {content?.kind === 'image' && onCrop && (
            <Button variant="ghost" size="icon" disabled={replaceMediaBusy} aria-label={`裁剪 ${node.title}`} onClick={onCrop}><Crop /></Button>
          )}
          {content?.kind === 'image' && onMaskEdit && (
            <Button variant="ghost" size="icon" disabled={replaceMediaBusy || reversePromptBusy} aria-label={`局部编辑 ${node.title}`} onClick={onMaskEdit}><Paintbrush /></Button>
          )}
          {content?.kind === 'image' && onSplit && (
            <Button variant="ghost" size="icon" disabled={replaceMediaBusy} aria-label={`切分 ${node.title}`} onClick={onSplit}><Grid2X2 /></Button>
          )}
          {content?.kind === 'image' && onUpscale && (
            <Button variant="ghost" size="icon" disabled={replaceMediaBusy} aria-label={`本地放大 ${node.title}`} onClick={onUpscale}><ZoomIn /></Button>
          )}
          {content && onSaveAsset && (
            <Button variant="ghost" size="icon" disabled={saveAssetBusy} aria-label={`将 ${node.title} 存入资产库`} onClick={onSaveAsset}><Library /></Button>
          )}
          <Button variant="ghost" size="icon" aria-label="删除选中节点" onClick={deleteNode}><Trash2 /></Button>
        </div>
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
      {mobileGeneration && (
        <div className="mt-3 border-t border-border/70 pt-3 md:hidden">
          {mobileGeneration}
        </div>
      )}
    </aside>
  );
}

export function EditorMessage({ text, icon, action }: { text: string; icon?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="grid h-full place-items-center"><div className="flex items-center gap-2 text-sm text-muted-foreground">{icon}{text}{action}</div></div>;
}

export function ToolButton({ label, active, disabled, onClick, children, buttonRef, expanded, controlsId, popup = 'menu' }: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  buttonRef?: Ref<HTMLButtonElement>;
  expanded?: boolean;
  controlsId?: string;
  popup?: 'menu' | 'dialog' | false;
}) {
  return <button ref={buttonRef} type="button" title={label} aria-label={label} aria-pressed={active} aria-expanded={expanded} aria-controls={controlsId} aria-haspopup={controlsId && popup ? popup : undefined} disabled={disabled} onClick={onClick} className={cn('grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30', active && 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground')}>{children}</button>;
}

function MediaToolButton({ label, disabled = false, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className="nodrag grid size-7 place-items-center rounded-full text-muted-foreground opacity-0 transition-[color,opacity,background-color] hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-30 group-focus-within:opacity-100 group-hover:opacity-100"
      onClick={event => {
        event.stopPropagation();
        onClick();
      }}
    >
      <span aria-hidden="true" className="[&>svg]:size-3.5">{children}</span>
    </button>
  );
}

function MediaToolMenuItem({ label, disabled = false, onSelect, children }: { label: string; disabled?: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <DropdownMenuItem aria-label={label} disabled={disabled} onSelect={onSelect}>
      <span aria-hidden="true" className="[&>svg]:size-4">{children}</span>
      {label}
    </DropdownMenuItem>
  );
}

export function AddMenuButton({ icon, title, description, onClick }: { icon: React.ReactNode; title: string; description?: string; onClick: () => void }) {
  return <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">{icon}</span><span className="min-w-0"><span className="block text-sm font-medium">{title}</span>{description && <span className="block truncate text-xs text-muted-foreground">{description}</span>}</span></button>;
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

export function copyablePromptForNode(
  node: CanvasNode,
  jobsByResultNodeId: ReadonlyMap<string, Job[]>,
): string | null {
  const history = jobsByResultNodeId.get(node.id) ?? [];
  const completed = [...history]
    .reverse()
    .find(job => (job.status === 'done' || job.status === 'partial') && job.canvas_run?.snapshot.final_prompt.trim());
  if (completed?.canvas_run?.snapshot.final_prompt) return completed.canvas_run.snapshot.final_prompt;
  if (history.length > 0) return null;
  const draft = generationDraft(node);
  return draft?.prompt.trim() ? draft.prompt : null;
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

export function isReversePromptJob(job: Job): boolean {
  return job.canvas_run?.snapshot.normalized_params.preset_id === 'canvas.reverse_prompt'
    && job.canvas_run.snapshot.normalized_params.preset_version === 1;
}

function runStatus(job: Job | undefined): string {
  if (!job) return '配置已保存';
  if (job.status === 'pending' || job.status === 'pending_confirm') {
    return job.cancel_requested_at ? '已请求停止，上游可能仍在执行' : '结果会自动回到节点';
  }
  if (job.status === 'done') return '生成完成';
  if (job.status === 'partial') return '部分结果完成';
  if (job.status === 'canceled') return job.error ? `已停止 · ${job.error}` : '已停止';
  return job.error || '生成失败';
}

function acceptsInput(node: CanvasNode) {
  return node.type !== 'group' && node.type !== 'plugin';
}

function providesContent(node: CanvasNode): node is CanvasContentNode {
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
  const { mediaRef, resolvedSrc } = useLazyMedia(src);
  if (kind === 'image') return <img src={src} alt="" loading="lazy" decoding="async" className={cn('size-full object-contain', compact && 'max-h-48 rounded-md')} />;
  if (kind === 'video') return <video ref={mediaRef} src={resolvedSrc} controls={compact} muted={!compact} playsInline preload={resolvedSrc ? 'metadata' : 'none'} className={cn('size-full object-contain', compact && 'max-h-48 rounded-md')} />;
  if (!compact) return <div ref={mediaRef} className="grid size-full place-items-center gap-2 p-3 text-xs text-muted-foreground"><FileAudio className="size-8" aria-hidden="true" /><span>音频素材</span></div>;
  return <div ref={mediaRef} className="grid size-full place-items-center p-3"><audio src={resolvedSrc} controls preload={resolvedSrc ? 'metadata' : 'none'} className="w-full" /></div>;
}

function useLazyMedia(src: string) {
  const mediaElement = useRef<HTMLElement | null>(null);
  const [resolvedSrc, setResolvedSrc] = useState('');
  const mediaRef = useCallback((element: HTMLElement | null) => {
    mediaElement.current = element;
  }, []);

  useEffect(() => {
    const element = mediaElement.current;
    if (!element) return;
    setResolvedSrc('');
    if (!('IntersectionObserver' in window)) {
      setResolvedSrc(src);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      setResolvedSrc(src);
      observer.disconnect();
    }, { rootMargin: '240px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [src]);

  return { mediaRef, resolvedSrc };
}

export const canvasNodeTypes = {
  canvasNode: memo(CanvasNodeCard, (previous, next) => (
    previous.selected === next.selected
    && previous.data.domain === next.data.domain
  )),
};
