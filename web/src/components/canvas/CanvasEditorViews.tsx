import { Handle, NodeResizer, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react';
import { Check, ChevronRight, ClipboardCopy, Download, Ellipsis, Eye, FileAudio, FileImage, FileUp, FileVideo, Library, LoaderCircle, Lock, Maximize2, MessageSquare, Minus, Pause, Pencil, Play, Plus, RotateCcw, Sparkles, Square, Trash2, Type, Unlock, Volume2, VolumeX, X } from 'lucide-react';
import { createContext, memo, useCallback, useContext, useEffect, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';

import { canvasDownloadUrl, canvasMediaUrl } from '@/api/canvas';
import type { KeyView } from '@/api/keys';
import { Button } from '@/components/ui/button';
import { CanvasImageToolbarPreferencesDialog } from '@/components/canvas/CanvasImageToolbarPreferencesDialog';
import {
  CanvasAudioSettings,
  CanvasImageSettings,
  CanvasModelPicker,
  CanvasTextSettings,
  type CanvasModelChoice,
} from '@/components/canvas/CanvasGenerationControls';
import { CanvasPromptInput } from '@/components/canvas/CanvasPromptInput';
import type { CanvasMediaTool } from '@/components/canvas/CanvasMediaOperationDialog';
import {
  CanvasNodeRunBadge,
  CanvasNodeRunLiveRegion,
  CanvasNodeRunOverlay,
  canvasNodeRunState,
  isReversePromptJob,
} from '@/components/canvas/CanvasNodeRunStatus';
import { formatCanvasImageInfo } from '@/components/canvas/canvasMediaFormatting';
import { orderedCanvasImageTools } from '@/components/canvas/canvasImageToolbar';
import { isUploadedImageMaterialNode } from '@/components/canvas/canvasNodePanelInteraction';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { imageControlCaps } from '@/lib/imageControlCaps';
import { VideoControls } from '@/components/studio/VideoControls';
import { cn } from '@/lib/utils';
import { presentCanvasCandidates, type CanvasCandidateEntry } from '@/lib/canvasCandidates';
import { useVideoFrame } from '@/lib/videoFrame';
import {
  missingCanvasMentionIds,
  mentionKindLabel,
  type CanvasMaterialReference,
  type CanvasMentionReference,
} from '@/lib/canvasMentions';
import type {
  CanvasContentNode,
  CanvasContentVersion,
  CanvasGenerationDraft,
  CanvasImageQuickToolId,
  CanvasImageToolbarPreferences,
  CanvasNode,
  CanvasUiPreferences,
} from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import {
  canvasNodeAcceptsInput,
  canvasNodeProvidesOutput,
  canvasNodeProvidesContent,
  CANVAS_GENERATION_MODE_LABELS,
  canvasGenerationModelSupportsMode,
  canvasVideoEditCaps,
  normalizeCanvasAudioParams,
  normalizeCanvasImageParams,
  normalizeCanvasTextParams,
  normalizeCanvasVideoParams,
  supportsCanvasTextReasoning,
  switchCanvasGenerationDraft,
} from '@/pages/canvasEditorModel';

export type FlowNode = Node<{ domain: CanvasNode }, 'canvasNode'>;

export interface CanvasGenerationPanelContextValue {
  dismissedNodeId: string | null;
  viewportZoom: number;
  narrowViewport: boolean;
  dismiss: (id: string) => void;
}

export interface CanvasNodeContextValue {
  projectId: string;
  materialReferences: readonly CanvasMaterialReference[];
  connectedMaterialNodeIdsByNodeId: ReadonlyMap<string, ReadonlySet<string>>;
  mentionReferencesByNodeId: ReadonlyMap<string, readonly CanvasMentionReference[]>;
  contentVersions: Readonly<Record<string, CanvasContentVersion>>;
  keys: KeyView[];
  jobsByRunId: ReadonlyMap<string, Job>;
  jobsByResultNodeId: ReadonlyMap<string, Job[]>;
  submittingNodeIds: ReadonlySet<string>;
  mediaReplaceBusyNodeIds: ReadonlySet<string>;
  mediaReplaceError: { nodeId: string; message: string } | null;
  canvasUiPreferences: CanvasUiPreferences;
  canvasUiPreferencesError: string | null;
  showImageInfo: boolean;
  libraryBusy: boolean;
  generationPanel: CanvasGenerationPanelContextValue;
  setMaterialConnected: (sourceNodeId: string, targetNodeId: string, connected: boolean) => void;
  selectNode: (id: string) => void;
  previewContent: (id: string, title: string, nodeId: string) => void;
  selectCandidate: (id: string, versionId: string) => void;
  submitRun: (id: string) => Promise<void>;
  retryRun: (id: string, runId: string, mode: 'original' | 'current', candidateId?: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  dismissCandidate: (runId: string, candidateId: string) => Promise<void>;
  updateNode: (id: string, updater: (node: CanvasNode) => CanvasNode) => void;
  renameNode: (id: string, title: string) => void;
  updateText: (id: string, text: string) => void;
  createImageConfigFromText: (id: string) => void;
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
  openAngle: (node: CanvasContentNode) => void;
  editVideo: (node: CanvasContentNode) => void;
  saveImageToolbarPreferences: (value: CanvasImageToolbarPreferences) => Promise<void>;
  deleteNode: (id: string) => void;
}

export const CanvasNodeContext = createContext<CanvasNodeContextValue | null>(null);
const EMPTY_CANVAS_NODE_IDS: ReadonlySet<string> = new Set();

export function CanvasNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const context = useContext(CanvasNodeContext);
  const node = data.domain;
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isEditingText, setIsEditingText] = useState(false);
  const [titleDraft, setTitleDraft] = useState(node.title);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleTriggerRef = useRef<HTMLButtonElement>(null);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const contentSurfaceRef = useRef<HTMLElement>(null);
  const titleExitInProgress = useRef(false);
  const restoreTitleFocus = useRef(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarOverlayOpen, setToolbarOverlayOpen] = useState(false);
  const [candidateBatchExpanded, setCandidateBatchExpanded] = useState(false);
  const draft = generationDraft(node);
  const uploadedImageMaterial = Boolean(
    context && isUploadedImageMaterialNode(node, context.contentVersions),
  );
  const generationPanelVisible = Boolean(
    context
    && selected
    && draft
    && !uploadedImageMaterial
    && !context.generationPanel.narrowViewport
    && context.generationPanel.dismissedNodeId !== node.id,
  );
  const generationPanelWidth = 608;
  const viewportZoom = context?.generationPanel.viewportZoom;
  const generationPanelZoom = viewportZoom && Number.isFinite(viewportZoom) && viewportZoom > 0
    ? viewportZoom
    : 1;
  useEffect(() => {
    if (!isEditingTitle) setTitleDraft(node.title);
  }, [isEditingTitle, node.title]);
  useEffect(() => {
    if (!isEditingTitle) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [isEditingTitle]);
  useEffect(() => {
    if (!isEditingText) return;
    const editor = textEditorRef.current;
    editor?.focus();
    editor?.setSelectionRange(editor.value.length, editor.value.length);
  }, [isEditingText]);
  useEffect(() => {
    if (isEditingTitle) return;
    if (restoreTitleFocus.current) titleTriggerRef.current?.focus();
    restoreTitleFocus.current = false;
    titleExitInProgress.current = false;
  }, [isEditingTitle, node.title]);
  useEffect(() => {
    if (!selected && !toolbarOverlayOpen) return;
    const controls = toolbarControls(toolbarRef.current);
    const activeControl = controls.find(control => control === document.activeElement) ?? controls[0];
    updateToolbarTabStops(controls, activeControl);
  });
  if (!context) return null;
  const renameNode = context.renameNode;
  const content = contentForNode(node, context.contentVersions);
  const copyablePrompt = copyablePromptForNode(
    node,
    context.jobsByResultNodeId,
  );
  const compactMediaTools = (node.size?.width ?? 320) < 480;
  const replacingMedia = context.mediaReplaceBusyNodeIds.has(node.id);
  const submittingNode = context.submittingNodeIds.has(node.id);
  const nodeRunState = canvasNodeRunState(node, context.jobsByRunId);
  const nodeJob = nodeRunState.job;
  const reversePromptJob = nodeJob && isReversePromptJob(nodeJob) ? nodeJob : undefined;
  const reversePromptSucceeded = reversePromptJob?.canvas_run?.candidates.some(candidate => candidate.status === 'succeeded') ?? false;
  const imageCandidates = node.type === 'image'
    ? presentCanvasCandidates(context.jobsByResultNodeId.get(node.id) ?? []).current
    : [];

  function beginTitleEditing() {
    titleExitInProgress.current = false;
    restoreTitleFocus.current = false;
    setTitleDraft(node.title);
    setIsEditingTitle(true);
  }

  function finishTitleEditing(restoreFocus: boolean) {
    if (titleExitInProgress.current) return;
    titleExitInProgress.current = true;
    const title = titleDraft.trim();
    setTitleDraft(title || node.title);
    setIsEditingTitle(false);
    restoreTitleFocus.current = restoreFocus;
    if (title && title !== node.title) renameNode(node.id, title);
  }

  function cancelTitleEditing() {
    if (titleExitInProgress.current) return;
    titleExitInProgress.current = true;
    restoreTitleFocus.current = true;
    setTitleDraft(node.title);
    setIsEditingTitle(false);
  }

  function beginTextEditing() {
    if (!context || node.type !== 'text' || isEditingText) return;
    context.selectNode(node.id);
    context.recordHistory();
    setIsEditingText(true);
  }

  function finishTextEditing(restoreFocus: boolean) {
    setIsEditingText(false);
    if (restoreFocus) requestAnimationFrame(() => contentSurfaceRef.current?.focus());
  }

  function setTextScale(direction: -1 | 1) {
    if (!context || node.type !== 'text') return;
    const scales = ['xs', 'sm', 'base'] as const;
    const current = scales.indexOf(node.data.display.scale);
    const scale = scales[Math.max(0, Math.min(scales.length - 1, current + direction))];
    if (scale === node.data.display.scale) return;
    context.recordHistory();
    context.updateNode(node.id, candidate => candidate.type === 'text'
      ? { ...candidate, data: { ...candidate.data, display: { scale } } }
      : candidate);
  }

  return (
    <div
      className="canvas-node-shell group relative h-full w-full overflow-visible"
      data-selected={selected ? 'true' : 'false'}
    >
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
      <header className="absolute bottom-full left-0 right-0 flex items-center pb-2 text-xs text-muted-foreground">
        <span
          className="flex min-w-0 flex-1 items-center gap-1.5"
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onDoubleClick={event => {
            event.stopPropagation();
            if (isEditingTitle) return;
            event.preventDefault();
            beginTitleEditing();
          }}
        >
          {nodeIcon(node)}
          {isEditingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              maxLength={120}
              aria-label={`重命名节点 ${node.title}`}
              className="nodrag nowheel h-7 min-w-0 flex-1 border-0 border-b border-dashed border-input bg-transparent px-0 text-xs font-medium text-foreground outline-none focus-visible:border-ring"
              onChange={event => setTitleDraft(event.target.value)}
              onBlur={() => finishTitleEditing(false)}
              onKeyDown={event => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  finishTitleEditing(true);
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelTitleEditing();
                }
              }}
            />
          ) : (
            <button
              ref={titleTriggerRef}
              type="button"
              title="双击或按 Enter 重命名节点"
              aria-label={`重命名节点 ${node.title}`}
              className="nodrag min-w-0 truncate border-b border-dashed border-transparent text-left text-xs font-medium text-foreground transition-colors hover:border-current focus-visible:border-current focus-visible:outline-none"
              onKeyDown={event => {
                if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'F2') return;
                event.preventDefault();
                event.stopPropagation();
                beginTitleEditing();
              }}
            >
              {node.title}
            </button>
          )}
        </span>
        <CanvasNodeRunBadge state={nodeRunState} />
      </header>
      <NodeToolbar
        isVisible={selected || toolbarOverlayOpen}
        position={Position.Top}
        align="center"
        offset={32}
        className="nodrag nowheel"
      >
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label={`${node.title} 节点工具`}
          data-canvas-node-toolbar={node.id}
          className="flex items-center gap-1 rounded-xl border border-border bg-glass p-1 backdrop-blur-glass shell-glow"
          onFocusCapture={event => {
            const focused = (event.target as HTMLElement).closest<HTMLElement>('button, a[href]');
            updateToolbarTabStops(toolbarControls(event.currentTarget), focused);
          }}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onKeyDown={handleToolbarKeyDown}
        >
          {nodeRunState.status === 'error' && nodeJob?.canvas_run && (
            <MediaToolButton
              label={nodeRunState.reversePrompt ? '按原设置重试反推提示词' : `按原设置重试 ${node.title}`}
              disabled={submittingNode}
              onClick={() => void context.retryRun(node.id, nodeJob.canvas_run!.run_id, 'original')}
            >
              {submittingNode ? <LoaderCircle /> : <RotateCcw />}
            </MediaToolButton>
          )}
          {nodeRunState.status === 'loading' && nodeJob?.canvas_run && (
            <MediaToolButton
              label={nodeRunState.reversePrompt
                ? nodeJob.cancel_requested_at ? '正在停止反推提示词' : '停止反推提示词'
                : nodeJob.cancel_requested_at ? `正在停止 ${node.title}` : `停止 ${node.title} 的生成`}
              disabled={Boolean(nodeJob.cancel_requested_at)}
              onClick={() => void context.cancelRun(nodeJob.canvas_run!.run_id)}
            >
              {nodeJob.cancel_requested_at ? <LoaderCircle /> : <Square />}
            </MediaToolButton>
          )}
          {node.type === 'image' && content?.kind === 'image' ? (
            <>
              <ImageNodeToolbar
                node={node}
                compact={compactMediaTools}
                replacing={replacingMedia}
                submitting={submittingNode}
                copyablePrompt={copyablePrompt}
                context={context}
                onOverlayOpenChange={setToolbarOverlayOpen}
              />
              {reversePromptJob && reversePromptSucceeded && !context.reversePromptConfiguredNodeIds.has(node.id) && (
                <MediaToolButton
                  label="从反推文本创建图片配置"
                  disabled={submittingNode}
                  onClick={() => void context.recoverReversePromptConfig(reversePromptJob)}
                >
                  {submittingNode ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
                </MediaToolButton>
              )}
            </>
          ) : (
            <CanvasNodeToolbar
              node={node}
              content={content}
              replacing={replacingMedia}
              submitting={submittingNode}
              copyablePrompt={copyablePrompt}
              context={context}
              onEditText={beginTextEditing}
              onDecreaseText={() => setTextScale(-1)}
              onIncreaseText={() => setTextScale(1)}
            />
          )}
        </div>
      </NodeToolbar>
      {node.type === 'image' && imageCandidates.length > 0 && (
        <ImageCandidateBatch
          node={node}
          entries={imageCandidates}
          primaryVersionId={node.data.current_version_id}
          expanded={candidateBatchExpanded}
          disabled={submittingNode || nodeRunState.status === 'loading'}
          context={context}
          onToggle={() => setCandidateBatchExpanded(current => !current)}
        />
      )}
      <article
        ref={contentSurfaceRef}
        data-canvas-node-id={node.id}
        data-canvas-node-status={nodeRunState.status}
        role="group"
        tabIndex={0}
        aria-busy={replacingMedia || nodeRunState.status === 'loading'}
        aria-label={`选择节点 ${node.title}，${nodeRunState.label}`}
        className={cn(
          'relative h-full overflow-hidden rounded-lg border bg-card/95 text-foreground transition-colors shell-glow',
          selected ? 'border-primary' : 'border-border',
        )}
        onClick={event => {
          event.stopPropagation();
          context.selectNode(node.id);
        }}
        onDoubleClick={event => {
          event.stopPropagation();
          if (node.type === 'text') {
            beginTextEditing();
            return;
          }
          if (content) context.previewContent(content.version_id, node.title, node.id);
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
            isEditingText ? (
              <textarea
                ref={textEditorRef}
                aria-label={`编辑 ${node.title} 正文`}
                value={content?.kind === 'text' ? content.text : ''}
                placeholder="输入文本…"
                className={cn(
                  'nodrag nowheel block h-full min-h-32 w-full resize-none overflow-y-auto border-0 bg-transparent p-3 leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                  textScaleClass(node.data.display.scale),
                )}
                onChange={event => context.updateText(node.id, event.target.value)}
                onBlur={() => finishTextEditing(false)}
                onPointerDown={event => event.stopPropagation()}
                onDoubleClick={event => event.stopPropagation()}
                onKeyDown={event => {
                  event.stopPropagation();
                  if (event.key !== 'Escape') return;
                  event.preventDefault();
                  finishTextEditing(true);
                }}
              />
            ) : (
              <p className={cn(
                'h-full min-h-32 overflow-y-auto whitespace-pre-wrap p-3 leading-relaxed text-foreground',
                textScaleClass(node.data.display.scale),
              )}>
                {content?.kind === 'text' && content.text
                  ? content.text
                  : draft ? '双击输入文本，或填写下方生成设置' : '双击输入文本…'}
              </p>
            )
          )}
          {content && content.kind !== 'text' && (
            <MediaPreview
              kind={content.kind}
              src={canvasMediaUrl(context.projectId, content.version_id)}
              title={node.title}
              fit={node.type === 'image' || node.type === 'video' ? node.data.display.fit : 'contain'}
              freeResize={(node.type === 'image' || node.type === 'video') && node.data.display.free_resize}
            />
          )}
          {selected && uploadedImageMaterial && node.type === 'image' && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label={`替换图片 ${node.title}`}
              disabled={replacingMedia}
              className="nodrag absolute right-3 top-3 z-10"
              onPointerDown={event => event.stopPropagation()}
              onClick={event => {
                event.stopPropagation();
                context.replaceMedia(node);
              }}
            >
              {replacingMedia ? <LoaderCircle className="animate-spin" /> : <FileUp />}
              {replacingMedia ? '替换中' : '替换'}
            </Button>
          )}
          {node.type === 'image' && content?.kind === 'image' && context.showImageInfo && (
            <span className="pointer-events-none absolute bottom-3 right-3 z-10 max-w-[calc(100%-1.5rem)] truncate rounded-md border border-border bg-glass px-2 py-1 text-xs font-medium tabular-nums text-foreground backdrop-blur-glass">
              {formatCanvasImageInfo(content)}
            </span>
          )}
          {isCanvasContentNode(node) && node.type !== 'text' && !content && (
            <EmptyMediaSurface
              node={node}
              replacing={replacingMedia}
              onUpload={() => context.replaceMedia(node)}
            />
          )}
          {node.type === 'config' && (
            <CanvasConfigNodeSurface node={node} context={context} />
          )}
          {(node.type === 'group' || node.type === 'plugin') && !content && (
            <div className="grid min-h-44 place-items-center px-4 text-center text-xs text-muted-foreground">
              {node.type === 'group' ? '分组' : '插件节点'}
            </div>
          )}
        </div>
      </article>
      <CanvasNodeRunLiveRegion state={nodeRunState} />
      <CanvasNodeRunOverlay
        node={node}
        state={nodeRunState}
        hasContent={Boolean(content)}
        submitting={submittingNode}
        onRetry={(nodeId, runId) => void context.retryRun(nodeId, runId, 'original')}
      />
      {canvasNodeAcceptsInput(node) && (
        <Handle type="target" position={Position.Left} className="canvas-node-handle" aria-label="连接到此节点">
          <span className="canvas-node-handle-dot" aria-hidden="true" />
        </Handle>
      )}
      {canvasNodeProvidesOutput(node, context.contentVersions) && (
        <Handle
          type="source"
          position={Position.Right}
          className="canvas-node-handle"
          aria-label="从此节点连接"
        >
          <span className="canvas-node-handle-dot" aria-hidden="true" />
        </Handle>
      )}
      {generationPanelVisible && draft && (
        <div
          data-canvas-node-panel-anchor={node.id}
          className="absolute z-20"
          style={{
            left: '50%',
            top: `calc(100% + ${16 / generationPanelZoom}px)`,
            width: generationPanelWidth,
            marginLeft: -generationPanelWidth / 2,
            transform: `scale(${1 / generationPanelZoom})`,
            transformOrigin: 'top center',
          }}
        >
          <CanvasGenerationComposer
            node={node}
            draft={draft}
            context={context}
            onClose={() => context.generationPanel.dismiss(node.id)}
          />
        </div>
      )}
    </div>
  );
}

function ImageCandidateBatch({
  node,
  entries,
  primaryVersionId,
  expanded,
  disabled,
  context,
  onToggle,
}: {
  node: Extract<CanvasContentNode, { type: 'image' }>;
  entries: CanvasCandidateEntry[];
  primaryVersionId: string | null;
  expanded: boolean;
  disabled: boolean;
  context: CanvasNodeContextValue;
  onToggle: () => void;
}) {
  const primary = entries.find(entry => entry.candidate.version_id === primaryVersionId) ?? entries[0];
  const others = entries.filter(entry => entry.candidate.candidate_id !== primary.candidate.candidate_id);
  const primaryTerminalFailure = primary.candidate.status === 'failed' || primary.candidate.status === 'canceled';

  return (
    <div
      data-testid="canvas-candidate-stack"
      data-expanded={expanded ? 'true' : 'false'}
      className="nodrag nowheel pointer-events-none absolute inset-0 overflow-visible"
    >
      {!expanded && entries.length > 1 && entries.slice(1, 4).map((entry, index) => (
        <span
          key={entry.candidate.candidate_id}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-lg border border-border bg-card"
          style={{ transform: `translate(${10 + index * 6}px, ${5 + index * 4}px) rotate(${index + 1}deg)` }}
        />
      ))}
      {expanded && entries.length > 1 && others.map((entry, index) => (
        <ImageCandidateCard
          key={entry.candidate.candidate_id}
          node={node}
          entry={entry}
          index={index}
          disabled={disabled}
          context={context}
        />
      ))}
      {primaryTerminalFailure && !disabled && (
        <CandidateFailureActions
          number={primary.candidate.index + 1}
          onRetry={() => void context.retryRun(
            node.id,
            primary.job.canvas_run!.run_id,
            'original',
            primary.candidate.candidate_id,
          )}
          onDismiss={() => void context.dismissCandidate(
            primary.job.canvas_run!.run_id,
            primary.candidate.candidate_id,
          )}
        />
      )}
      {entries.length > 1 && (
        <button
          type="button"
          className="pointer-events-auto absolute right-2 top-2 z-20 inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-glass px-3 text-xs font-medium text-foreground backdrop-blur-glass transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={`${expanded ? '收起' : '展开'} ${entries.length} 个候选结果`}
          aria-expanded={expanded}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            onToggle();
          }}
        >
          {entries.length} 个候选
          <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function ImageCandidateCard({
  node,
  entry,
  index,
  disabled,
  context,
}: {
  node: Extract<CanvasContentNode, { type: 'image' }>;
  entry: CanvasCandidateEntry;
  index: number;
  disabled: boolean;
  context: CanvasNodeContextValue;
}) {
  const { candidate } = entry;
  const horizontalOffset = index + 1;
  const version = candidate.version_id ? context.contentVersions[candidate.version_id] : undefined;
  const terminalFailure = candidate.status === 'failed' || candidate.status === 'canceled';
  return (
    <section
      role="group"
      aria-label={`候选 ${candidate.index + 1}`}
      className="pointer-events-auto absolute top-0 z-20 h-full overflow-hidden rounded-lg border border-border bg-card shell-glow"
      style={{
        left: `calc(${horizontalOffset * 100}% + ${horizontalOffset * 16}px)`,
        width: '100%',
      }}
      onPointerDown={event => event.stopPropagation()}
      onDoubleClick={event => {
        event.stopPropagation();
        if (version) context.previewContent(version.version_id, `${node.title} · 候选 ${candidate.index + 1}`, node.id);
      }}
    >
      {version?.kind === 'image'
        ? <MediaPreview kind="image" src={canvasMediaUrl(context.projectId, version.version_id)} />
        : (
          <div className="grid size-full min-h-44 place-items-center px-4 text-center text-xs text-muted-foreground">
            {candidate.status === 'pending'
              ? <LoaderCircle className="animate-spin" aria-label={`候选 ${candidate.index + 1} 生成中`} />
              : candidate.error || (candidate.status === 'canceled' ? '已停止' : '结果待同步')}
          </div>
        )}
      <span className="absolute left-2 top-2 rounded-md border border-border bg-glass px-2 py-1 text-xs text-muted-foreground backdrop-blur-glass">
        {candidate.index + 1}
      </span>
      {!disabled && version?.kind === 'image' && (
        <button
          type="button"
          aria-label={`将候选 ${candidate.index + 1} 设为主结果`}
          title="设为主结果"
          className="absolute bottom-2 left-2 grid size-8 place-items-center rounded-full border border-border bg-glass text-muted-foreground backdrop-blur-glass transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={event => {
            event.stopPropagation();
            context.selectCandidate(node.id, version.version_id);
          }}
        >
          <Check className="size-4" aria-hidden="true" />
        </button>
      )}
      {terminalFailure && !disabled && (
        <CandidateFailureActions
          number={candidate.index + 1}
          onRetry={() => void context.retryRun(
            node.id,
            entry.job.canvas_run!.run_id,
            'original',
            candidate.candidate_id,
          )}
          onDismiss={() => void context.dismissCandidate(
            entry.job.canvas_run!.run_id,
            candidate.candidate_id,
          )}
        />
      )}
    </section>
  );
}

function CandidateFailureActions({
  number,
  onRetry,
  onDismiss,
}: {
  number: number;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute bottom-2 right-2 z-20 flex items-center gap-1.5">
      <button
        type="button"
        aria-label={`重试候选 ${number}`}
        title="按原设置重试这个候选"
        className="grid size-8 place-items-center rounded-full border border-border bg-glass text-muted-foreground backdrop-blur-glass transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onClick={event => {
          event.stopPropagation();
          onRetry();
        }}
      >
        <RotateCcw className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={`删除候选 ${number}`}
        title="删除这个失败槽位"
        className="grid size-8 place-items-center rounded-full border border-border bg-glass text-muted-foreground backdrop-blur-glass transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onClick={event => {
          event.stopPropagation();
          onDismiss();
        }}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

const CONFIG_GENERATION_MODES = [
  { mode: 'text', label: CANVAS_GENERATION_MODE_LABELS.text, icon: Type },
  { mode: 'image', label: CANVAS_GENERATION_MODE_LABELS.image, icon: FileImage },
  { mode: 'video', label: CANVAS_GENERATION_MODE_LABELS.video, icon: FileVideo },
  { mode: 'audio', label: CANVAS_GENERATION_MODE_LABELS.audio, icon: FileAudio },
] as const;

function CanvasConfigNodeSurface({
  node,
  context,
}: {
  node: Extract<CanvasNode, { type: 'config' }>;
  context: CanvasNodeContextValue;
}) {
  const draft = node.data.draft;
  const selectedKey = context.keys.find(key => key.alias === draft.alias);
  const selectedModel = selectedKey?.models.find(model => model.id === draft.model);
  const references = context.mentionReferencesByNodeId.get(node.id) ?? [];
  const counts = references.reduce<Record<CanvasGenerationDraft['mode'], number>>((current, reference) => {
    current[reference.kind] += 1;
    return current;
  }, { text: 0, image: 0, video: 0, audio: 0 });

  function selectMode(mode: CanvasGenerationDraft['mode']) {
    context.selectNode(node.id);
    if (mode === draft.mode) return;
    context.recordHistory();
    context.updateNode(node.id, current => current.type === 'config'
      ? {
          ...current,
          data: {
            draft: switchCanvasGenerationDraft(context.keys, current.data.draft, mode, {
              preference: context.canvasUiPreferences.generation_defaults[mode],
            }),
          },
        }
      : current);
  }

  function handleModeKeys(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    if (!radios.length) return;
    const current = radios.indexOf(document.activeElement as HTMLButtonElement);
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const target = event.key === 'Home'
      ? radios[0]
      : event.key === 'End'
        ? radios.at(-1)
        : radios[(current + delta + radios.length) % radios.length];
    event.preventDefault();
    event.stopPropagation();
    target?.focus();
    target?.click();
  }

  return (
    <div className="flex min-h-44 flex-col justify-between gap-3 p-3">
      <div
        role="radiogroup"
        aria-label="生成类型"
        className="nodrag nowheel grid grid-cols-4 gap-1 rounded-lg border border-border bg-background/50 p-1"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        onKeyDown={handleModeKeys}
      >
        {CONFIG_GENERATION_MODES.map(({ mode, label, icon: Icon }) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={draft.mode === mode}
            aria-label={label}
            tabIndex={draft.mode === mode ? 0 : -1}
            className={cn(
              'flex min-w-0 flex-col items-center gap-1 rounded-md px-1 py-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              draft.mode === mode
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
            onClick={() => selectMode(mode)}
          >
            <Icon className="size-4" aria-hidden="true" />
            <span>{label}</span>
            <span
              aria-hidden="true"
              className={cn('h-0.5 w-4 rounded-full', draft.mode === mode ? 'bg-primary' : 'bg-transparent')}
            />
          </button>
        ))}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">当前模型</p>
        <p aria-label="当前模型" className="mt-1 truncate text-sm font-medium text-foreground" title={selectedModel?.name ?? draft.model}>
          {selectedModel?.name ?? (draft.model || '未选择兼容模型')}
        </p>
      </div>
      <div className="flex min-h-6 flex-wrap items-center gap-1.5" aria-label="连接输入摘要">
        {CONFIG_GENERATION_MODES.flatMap(({ mode, label }) => counts[mode] > 0
          ? [<span key={mode} className="rounded-md border border-border bg-secondary/60 px-2 py-1 text-xs text-muted-foreground">{label} {counts[mode]}</span>]
          : [])}
        {references.length === 0 && <span className="text-xs text-muted-foreground">暂无连接输入</span>}
      </div>
    </div>
  );
}

function CanvasNodeToolbar({
  node,
  content,
  replacing,
  submitting,
  copyablePrompt,
  context,
  onEditText,
  onDecreaseText,
  onIncreaseText,
}: {
  node: CanvasNode;
  content: CanvasContentVersion | undefined;
  replacing: boolean;
  submitting: boolean;
  copyablePrompt: string | null;
  context: CanvasNodeContextValue;
  onEditText: () => void;
  onDecreaseText: () => void;
  onIncreaseText: () => void;
}) {
  const contentNode = isCanvasContentNode(node) ? node : null;
  const mediaNode = contentNode && contentNode.type !== 'text' ? contentNode : null;

  return (
    <>
      {node.type === 'text' && (
        <>
          <MediaToolButton label={`编辑文本 ${node.title}`} onClick={onEditText}>
            <Pencil />
          </MediaToolButton>
          <MediaToolButton
            label={`减小 ${node.title} 字号`}
            disabled={node.data.display.scale === 'xs'}
            onClick={onDecreaseText}
          >
            <Minus />
          </MediaToolButton>
          <MediaToolButton
            label={`增大 ${node.title} 字号`}
            disabled={node.data.display.scale === 'base'}
            onClick={onIncreaseText}
          >
            <Plus />
          </MediaToolButton>
          <MediaToolButton
            label={`用 ${node.title} 生成图片`}
            disabled={content?.kind !== 'text' || !content.text.trim()}
            onClick={() => context.createImageConfigFromText(node.id)}
          >
            <FileImage />
          </MediaToolButton>
        </>
      )}
      <MediaToolButton
        label={content ? `查看 ${node.title} 详情` : `查看 ${node.title} 设置`}
        onClick={() => {
          if (content) context.previewContent(content.version_id, node.title, node.id);
          else context.selectNode(node.id);
        }}
      >
        <Eye />
      </MediaToolButton>
      {content && contentNode && canvasNodeProvidesContent(contentNode) && (
        <MediaToolButton
          label={`将 ${node.title} 存入资产库`}
          disabled={context.libraryBusy}
          onClick={() => void context.saveAsset(contentNode)}
        >
          <Library />
        </MediaToolButton>
      )}
      {content && content.kind !== 'text' && (
        <MediaToolLink
          label={`下载 ${node.title}`}
          href={canvasDownloadUrl(context.projectId, content.version_id)}
        >
          <Download />
        </MediaToolLink>
      )}
      {copyablePrompt && contentNode && canvasNodeProvidesContent(contentNode) && (
        <MediaToolButton
          label={`复制 ${node.title} 的生成提示词`}
          onClick={() => void context.copyPrompt(contentNode)}
        >
          <ClipboardCopy />
        </MediaToolButton>
      )}
      {mediaNode && (
        <MediaToolButton
          label={content ? `替换 ${node.title}` : `上传到 ${node.title}`}
          disabled={replacing}
          onClick={() => context.replaceMedia(mediaNode)}
        >
          {replacing ? <LoaderCircle className="animate-spin" /> : <FileUp />}
        </MediaToolButton>
      )}
      {node.type === 'video' && content?.kind === 'video' && (
        <MediaToolButton
          label={`编辑视频 ${node.title}`}
          disabled={submitting || replacing}
          onClick={() => context.editVideo(node)}
        >
          <MessageSquare />
        </MediaToolButton>
      )}
      <MediaToolButton
        label={`删除 ${node.title}`}
        destructive
        onClick={() => context.deleteNode(node.id)}
      >
        <Trash2 />
      </MediaToolButton>
    </>
  );
}

function isCanvasContentNode(node: CanvasNode): node is CanvasContentNode {
  return node.type === 'text'
    || node.type === 'image'
    || node.type === 'video'
    || node.type === 'audio';
}

function handleToolbarKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const controls = toolbarControls(event.currentTarget);
  if (!controls.length) return;
  const current = controls.indexOf(document.activeElement as HTMLElement);
  const target = event.key === 'Home'
    ? controls[0]
    : event.key === 'End'
      ? controls.at(-1)
      : event.key === 'ArrowRight'
        ? controls[(current + 1 + controls.length) % controls.length]
        : controls[(current - 1 + controls.length) % controls.length];
  event.preventDefault();
  event.stopPropagation();
  updateToolbarTabStops(controls, target);
  target?.focus();
}

function toolbarControls(toolbar: HTMLDivElement | null) {
  return toolbar
    ? Array.from(toolbar.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'))
    : [];
}

function updateToolbarTabStops(controls: HTMLElement[], active: HTMLElement | null | undefined) {
  controls.forEach(control => {
    control.tabIndex = control === active ? 0 : -1;
  });
}

type ImageToolbarAction = {
  id: CanvasImageQuickToolId;
  label: string;
  text: string;
  icon: React.ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  href?: string;
  run?: () => void;
};

function ImageNodeToolbar({
  node,
  compact,
  replacing,
  submitting,
  copyablePrompt,
  context,
  onOverlayOpenChange,
}: {
  node: Extract<CanvasContentNode, { type: 'image' }>;
  compact: boolean;
  replacing: boolean;
  submitting: boolean;
  copyablePrompt: string | null;
  context: CanvasNodeContextValue;
  onOverlayOpenChange: (open: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const menuOpenRef = useRef(false);
  const settingsOpenRef = useRef(false);
  const onOverlayOpenChangeRef = useRef(onOverlayOpenChange);
  useEffect(() => {
    onOverlayOpenChangeRef.current = onOverlayOpenChange;
  }, [onOverlayOpenChange]);
  useEffect(() => () => onOverlayOpenChangeRef.current(false), []);
  const resizeUnlocked = node.data.display.free_resize;
  const uploadedImageMaterial = isUploadedImageMaterialNode(node, context.contentVersions);
  const definitions = orderedCanvasImageTools(context.canvasUiPreferences.image_toolbar.tool_ids);
  const actions = definitions.flatMap(definition => {
    const Icon = definition.icon;
    const common = { id: definition.id, text: definition.label };
    let action: ImageToolbarAction | null = null;
    if (definition.id === 'info') action = {
      ...common,
      label: `查看 ${node.title} 详情`,
      icon: <Icon />,
      run: () => context.previewContent(node.data.current_version_id!, node.title, node.id),
    };
    if (definition.id === 'delete') action = {
      ...common,
      label: `删除 ${node.title}`,
      icon: <Icon />,
      destructive: true,
      run: () => context.deleteNode(node.id),
    };
    if (definition.id === 'saveAsset') action = {
      ...common,
      label: `将 ${node.title} 存入资产库`,
      icon: <Icon />,
      disabled: context.libraryBusy,
      run: () => void context.saveAsset(node),
    };
    if (definition.id === 'download') action = {
      ...common,
      label: `下载 ${node.title}`,
      icon: <Icon />,
      href: canvasDownloadUrl(context.projectId, node.data.current_version_id!),
    };
    if (definition.id === 'copyPrompt' && copyablePrompt) action = {
      ...common,
      label: `复制 ${node.title} 的生成提示词`,
      icon: <Icon />,
      run: () => void context.copyPrompt(node),
    };
    if (definition.id === 'reversePrompt') action = {
      ...common,
      label: `反推 ${node.title} 的提示词`,
      icon: submitting ? <LoaderCircle className="animate-spin" /> : <Icon />,
      disabled: submitting || replacing,
      run: () => void context.reversePrompt(node),
    };
    if (definition.id === 'replace' && !uploadedImageMaterial) action = {
      ...common,
      label: `替换 ${node.title}`,
      icon: replacing ? <LoaderCircle className="animate-spin" /> : <Icon />,
      disabled: replacing,
      run: () => context.replaceMedia(node),
    };
    if (definition.id === 'resize') action = {
      ...common,
      label: resizeUnlocked ? `锁定 ${node.title} 比例` : `自由缩放 ${node.title}`,
      text: resizeUnlocked ? '锁定比例' : '自由缩放',
      icon: resizeUnlocked ? <Lock /> : <Unlock />,
      disabled: replacing,
      run: () => context.toggleFreeResize(node),
    };
    if (definition.id === 'maskEdit') action = {
      ...common,
      label: `局部编辑 ${node.title}`,
      icon: <Icon />,
      disabled: submitting || replacing,
      run: () => context.openMaskEdit(node),
    };
    if (definition.id === 'crop') action = {
      ...common,
      label: `裁剪 ${node.title}`,
      icon: <Icon />,
      disabled: replacing,
      run: () => context.openMediaOperation(node, 'crop'),
    };
    if (definition.id === 'split') action = {
      ...common,
      label: `切分 ${node.title}`,
      icon: <Icon />,
      disabled: replacing,
      run: () => context.openMediaOperation(node, 'split'),
    };
    if (definition.id === 'upscale') action = {
      ...common,
      label: `本地放大 ${node.title}`,
      icon: <Icon />,
      disabled: replacing,
      run: () => context.openMediaOperation(node, 'upscale'),
    };
    if (definition.id === 'angle') action = {
      ...common,
      label: `多角度 ${node.title}`,
      icon: <Icon />,
      disabled: submitting || replacing,
      run: () => context.openAngle(node),
    };
    return action ? [action] : [];
  });

  function updateMenuOpen(open: boolean) {
    menuOpenRef.current = open;
    setMenuOpen(open);
    onOverlayOpenChange(open || settingsOpenRef.current);
  }

  function updateSettingsOpen(open: boolean) {
    settingsOpenRef.current = open;
    setSettingsOpen(open);
    onOverlayOpenChange(open || menuOpenRef.current);
  }

  function openSettings() {
    setSettingsError(context.canvasUiPreferencesError);
    updateSettingsOpen(true);
  }

  async function saveSettings(value: CanvasImageToolbarPreferences) {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      await context.saveImageToolbarPreferences(value);
      updateSettingsOpen(false);
    } catch (error) {
      setSettingsError((error as Error).message);
    } finally {
      setSettingsSaving(false);
    }
  }

  return (
    <>
      {compact ? (
        <DropdownMenu open={menuOpen} onOpenChange={updateMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={`更多 ${node.title} 图片工具`}
              aria-label={`更多 ${node.title} 图片工具`}
              className="nodrag grid size-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={event => event.stopPropagation()}
            >
              <Ellipsis className="size-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={event => event.stopPropagation()}>
            {actions.map(action => action.href ? (
              <DropdownMenuItem key={action.id} asChild>
                <a href={action.href} aria-label={action.label}>
                  <span aria-hidden="true" className="[&>svg]:size-4">{action.icon}</span>
                  {action.text}
                </a>
              </DropdownMenuItem>
            ) : (
              <MediaToolMenuItem
                key={action.id}
                label={action.label}
                text={action.text}
                destructive={action.destructive}
                disabled={action.disabled}
                onSelect={action.run!}
              >
                {action.icon}
              </MediaToolMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openSettings}>
              <Ellipsis className="size-4" aria-hidden="true" />
              配置快捷工具
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <>
          {actions.map(action => action.href ? (
            <MediaToolLink
              key={action.id}
              label={action.label}
              text={context.canvasUiPreferences.image_toolbar.show_labels ? action.text : undefined}
              href={action.href}
            >
              {action.icon}
            </MediaToolLink>
          ) : (
            <MediaToolButton
              key={action.id}
              label={action.label}
              text={context.canvasUiPreferences.image_toolbar.show_labels ? action.text : undefined}
              destructive={action.destructive}
              disabled={action.disabled}
              onClick={action.run!}
            >
              {action.icon}
            </MediaToolButton>
          ))}
          <MediaToolButton
            label="配置图片快捷工具"
            text={context.canvasUiPreferences.image_toolbar.show_labels ? '更多' : undefined}
            onClick={openSettings}
          >
            <Ellipsis />
          </MediaToolButton>
        </>
      )}
      <CanvasImageToolbarPreferencesDialog
        open={settingsOpen}
        value={context.canvasUiPreferences.image_toolbar}
        saving={settingsSaving}
        error={settingsError}
        onOpenChange={updateSettingsOpen}
        onSave={value => void saveSettings(value)}
      />
    </>
  );
}

export function CanvasGenerationComposer({
  node,
  draft,
  context,
  embedded = false,
  onClose,
}: {
  node: CanvasNode;
  draft: CanvasGenerationDraft;
  context: CanvasNodeContextValue;
  embedded?: boolean;
  onClose?: () => void;
}) {
  const editingExistingVideo = draft.mode === 'video'
    && node.type === 'video'
    && Boolean(node.data.current_version_id);
  const acceptsModel = (model: KeyView['models'][number], key: KeyView) => (
    canvasGenerationModelSupportsMode(key, model, draft.mode, { editingExistingVideo })
  );
  const availableKeys = context.keys.filter(key => key.models.some(model => acceptsModel(model, key)));
  const modelChoices: CanvasModelChoice[] = availableKeys.flatMap(key => key.models
    .filter(model => acceptsModel(model, key))
    .map(model => ({ key, model })));
  const selectedKey = context.keys.find(key => key.alias === draft.alias);
  const models = (selectedKey?.models ?? []).filter(model => acceptsModel(model, selectedKey!));
  const selectedModel = models.find(model => model.id === draft.model);
  const imageCaps = draft.mode === 'image' && selectedModel
    ? imageControlCaps(draft.model, selectedKey?.provider, selectedModel?.protocol)
    : null;
  const rawVideoCaps = draft.mode === 'video' && selectedModel
    ? canvasVideoEditCaps(draft.model, selectedModel?.protocol)
    : null;
  const videoCaps = rawVideoCaps && editingExistingVideo
    ? { ...rawVideoCaps, modes: rawVideoCaps.modes.filter(mode => mode === 'omni') }
    : rawVideoCaps;
  const videoMode = videoCaps?.modes.includes('omni')
    && (editingExistingVideo || draft.params.frame_mode === 'auto')
    ? 'omni'
    : videoCaps?.modes[0] ?? 'firstlast';
  const nodeRunState = canvasNodeRunState(node, context.jobsByRunId);
  const activeJob = nodeRunState.job;
  const runId = activeJob?.canvas_run?.run_id;
  const submitting = context.submittingNodeIds.has(node.id);
  const running = nodeRunState.status === 'loading';
  const modeLabel = CANVAS_GENERATION_MODE_LABELS[draft.mode];
  const mentionReferences = context.mentionReferencesByNodeId.get(node.id) ?? [];
  const missingMentionIds = missingCanvasMentionIds(draft.prompt, mentionReferences);
  const hasMissingMentions = missingMentionIds.length > 0;

  function updateDraft(updater: (current: CanvasGenerationDraft) => CanvasGenerationDraft) {
    context.updateNode(node.id, current => withGenerationDraft(current, updater(generationDraft(current)!)));
  }

  function updateDraftWithHistory(
    updater: (current: CanvasGenerationDraft) => CanvasGenerationDraft,
  ) {
    const preview = updater(draft);
    if (JSON.stringify(preview) === JSON.stringify(draft)) return;
    context.recordHistory();
    updateDraft(current => ({ ...updater(current), updated_at: new Date().toISOString() }));
  }

  return (
    <section
      aria-label={`${modeLabel}生成设置`}
      data-floating-node-panel="true"
      className={cn(
        'nodrag nowheel',
        embedded ? 'canvas-mobile-generation' : 'overflow-hidden rounded-xl border border-border bg-glass p-3 backdrop-blur-glass shell-glow',
      )}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <div className="mb-1 flex min-w-0 items-center justify-between gap-2 px-1">
        <p className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
          <Sparkles className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="shrink-0">{modeLabel}生成</span>
          <span className="truncate text-muted-foreground">· {node.title}</span>
        </p>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 rounded-full"
            aria-label={`关闭${modeLabel}生成设置`}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      <CanvasMaterialConnections
        node={node}
        materials={context.materialReferences}
        connectedNodeIds={context.connectedMaterialNodeIdsByNodeId.get(node.id) ?? EMPTY_CANVAS_NODE_IDS}
        onPreview={reference => context.previewContent(
          reference.versionId,
          reference.title,
          reference.nodeId,
        )}
        onConnectedChange={(sourceNodeId, connected) => context.setMaterialConnected(
          sourceNodeId,
          node.id,
          connected,
        )}
      />
      <CanvasPromptInput
        value={draft.prompt}
        references={mentionReferences}
        onFocus={context.recordHistory}
        onChange={prompt => updateDraft(current => ({ ...current, prompt, updated_at: new Date().toISOString() }))}
        onPreviewReference={reference => context.previewContent(
          reference.versionId,
          reference.title,
          reference.nodeId,
        )}
        placeholder={draft.mode === 'video'
          ? '描述镜头运动与画面变化，输入 @ 引用已连接内容'
          : draft.mode === 'audio'
            ? '输入需要朗读的文本，输入 @ 引用已连接内容'
            : draft.mode === 'text'
              ? '描述要创作的文案、脚本或内容，输入 @ 引用已连接内容'
              : '描述任何你想要生成的内容，输入 @ 引用已连接内容'}
      />
      <p
        role={hasMissingMentions ? 'alert' : undefined}
        className={cn(
          'min-h-5 px-3 pt-1 text-xs',
          hasMissingMentions ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {hasMissingMentions
          ? `${missingMentionIds.length} 个引用已断开，请重新连接或删除引用。`
          : mentionReferences.length
            ? `输入 @ 引用已连接内容 · ${mentionReferences.length} 项可用`
            : '连接文本、图片、视频或音频后，可输入 @ 引用。'}
      </p>
      {node.type !== 'image' && (
        <CandidateHistory
          nodeId={node.id}
          primaryVersionId={node.type === 'text' || node.type === 'video' || node.type === 'audio'
            ? node.data.current_version_id : null}
          context={context}
          running={Boolean(running)}
          submitting={submitting}
        />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xl border border-border/70 bg-card/55 p-1.5">
        <CanvasModelPicker
          choices={modelChoices}
          alias={draft.alias ?? null}
          model={draft.model}
          onSelect={({ key, model }) => {
            updateDraftWithHistory(current => ({
              ...current,
              alias: key.alias,
              model: model.id,
              params: draft.mode === 'image'
                ? normalizeCanvasImageParams(model.id, key.provider, current.params, model.protocol)
                : draft.mode === 'text'
                  ? normalizeCanvasTextParams(model.protocol, current.params)
                : draft.mode === 'video'
                  ? normalizeCanvasVideoParams(
                      model.id,
                      model.protocol,
                      current.params,
                      editingExistingVideo,
                    )
                  : normalizeCanvasAudioParams(
                      model.id,
                      key.provider,
                      model.protocol,
                      current.params,
                    ),
            }));
          }}
        />
        {draft.mode === 'text' && selectedModel && (
          <CanvasTextSettings
            supportsReasoning={supportsCanvasTextReasoning(selectedModel?.protocol)}
            params={draft.params}
            onPatch={patch => updateDraftWithHistory(current => ({
              ...current,
              params: normalizeCanvasTextParams(
                selectedModel?.protocol,
                { ...current.params, ...patch },
              ),
            }))}
          />
        )}
        {draft.mode === 'image' && imageCaps && (
          <CanvasImageSettings
            caps={imageCaps}
            model={draft.model}
            params={draft.params}
            onPatch={(patch, options) => updateDraftWithHistory(current => {
              const merged = { ...current.params, ...patch };
              if (options?.resetSize) delete merged.size;
              return {
                ...current,
                params: normalizeCanvasImageParams(
                  current.model,
                  context.keys.find(key => key.alias === current.alias)?.provider,
                  merged,
                  context.keys
                    .find(key => key.alias === current.alias)
                    ?.models.find(model => model.id === current.model)?.protocol,
                ),
              };
            })}
          />
        )}
        {draft.mode === 'video' && videoCaps && (
          <VideoControls
            caps={videoCaps}
            mode={videoMode}
            duration={Number(draft.params.duration ?? videoCaps.durations[0] ?? 5)}
            resolution={String(draft.params.resolution ?? videoCaps.resolutions[0] ?? '720p')}
            ratio={String(draft.params.ratio ?? videoCaps.ratios[0] ?? '16:9')}
            quality={draft.params.mode === 'pro' ? 'pro' : 'std'}
            generateAudio={draft.params.generate_audio !== false}
            watermark={draft.params.watermark === true}
            onModeChange={mode => updateDraftWithHistory(current => ({
              ...current,
              params: { ...current.params, frame_mode: mode === 'omni' ? 'auto' : 'firstlast' },
            }))}
            onDurationChange={duration => updateDraftWithHistory(current => ({
              ...current,
              params: { ...current.params, duration },
            }))}
            onResolutionChange={resolution => updateDraftWithHistory(current => ({
              ...current,
              params: { ...current.params, resolution },
            }))}
            onRatioChange={ratio => updateDraftWithHistory(current => ({
              ...current,
              params: { ...current.params, ratio },
            }))}
            onQualityChange={quality => updateDraftWithHistory(current => ({
              ...current,
              params: { ...current.params, mode: quality },
            }))}
            onGenerateAudioChange={generateAudio => updateDraftWithHistory(current => ({
              ...current,
              params: { ...current.params, generate_audio: generateAudio },
            }))}
            onWatermarkChange={watermark => updateDraftWithHistory(current => ({
              ...current,
              params: { ...current.params, watermark },
            }))}
          />
        )}
        {draft.mode === 'audio' && selectedKey && selectedModel && (
          <CanvasAudioSettings
            params={draft.params}
            onPatch={patch => updateDraftWithHistory(current => ({
              ...current,
              params: normalizeCanvasAudioParams(
                current.model,
                selectedKey.provider,
                selectedModel.protocol,
                { ...current.params, ...patch },
              ),
            }))}
          />
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
              disabled={submitting || hasMissingMentions || !draft.prompt.trim() || !draft.alias || !selectedModel}
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
            disabled={submitting || hasMissingMentions || !draft.prompt.trim() || !draft.alias || !selectedModel}
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

function CanvasMaterialConnections({
  node,
  materials,
  connectedNodeIds,
  onPreview,
  onConnectedChange,
}: {
  node: CanvasNode;
  materials: readonly CanvasMaterialReference[];
  connectedNodeIds: ReadonlySet<string>;
  onPreview: (reference: CanvasMaterialReference) => void;
  onConnectedChange: (sourceNodeId: string, connected: boolean) => void;
}) {
  const choices = materials.filter(reference => reference.nodeId !== node.id);
  const connected = choices.filter(reference => connectedNodeIds.has(reference.nodeId));
  const [hoveredMaterial, setHoveredMaterial] = useState<{
    reference: CanvasMaterialReference;
    left: number;
    top: number;
  } | null>(null);
  const showMaterialDetail = (
    reference: CanvasMaterialReference,
    target: HTMLElement,
  ) => {
    const bounds = target.getBoundingClientRect();
    setHoveredMaterial({
      reference,
      left: bounds.left + bounds.width / 2,
      top: bounds.top - 8,
    });
  };

  return (
    <>
      <div
        role="group"
        aria-label={`${node.title} 已对接素材`}
        className="mb-1 flex min-h-12 min-w-0 items-center gap-2 overflow-x-auto px-1 py-1"
      >
        {connected.map(reference => {
          const detailVisible = hoveredMaterial?.reference.nodeId === reference.nodeId;
          return (
            <button
              key={reference.nodeId}
              type="button"
              aria-label={`查看已对接素材 ${reference.title}`}
              aria-describedby={detailVisible ? `canvas-material-detail-${reference.nodeId}` : undefined}
              className="relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-secondary/55 text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onMouseEnter={event => showMaterialDetail(reference, event.currentTarget)}
              onMouseLeave={() => setHoveredMaterial(null)}
              onFocus={event => showMaterialDetail(reference, event.currentTarget)}
              onBlur={() => setHoveredMaterial(null)}
              onClick={() => onPreview(reference)}
            >
              <CanvasMaterialPreview reference={reference} />
              <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 text-xs text-foreground">
                {reference.title}
              </span>
            </button>
          );
        })}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`为 ${node.title} 对接素材`}
              title="选择画布素材"
              className="grid size-12 shrink-0 place-items-center rounded-lg border border-border bg-secondary/55 text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Plus className="size-5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="start" className="max-h-80 w-72 overflow-y-auto rounded-xl">
            <p className="px-2 pb-2 pt-1 text-xs font-medium text-muted-foreground">选择画布素材</p>
            {choices.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">画布上还没有可对接的素材。</p>
            ) : choices.map(reference => {
              const checked = connectedNodeIds.has(reference.nodeId);
              return (
                <DropdownMenuItem
                  key={reference.nodeId}
                  className="h-12 gap-2"
                  aria-label={`${checked ? '取消对接' : '对接'}素材 ${reference.title}`}
                  onSelect={event => {
                    event.preventDefault();
                    onConnectedChange(reference.nodeId, !checked);
                  }}
                >
                  <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-secondary text-muted-foreground">
                    <CanvasMaterialPreview reference={reference} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{reference.title}</span>
                    <span className="block text-xs text-muted-foreground">{mentionKindLabel(reference.kind)}</span>
                  </span>
                  {checked && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {hoveredMaterial && <CanvasMaterialHoverDetail {...hoveredMaterial} />}
    </>
  );
}

function CanvasMaterialHoverDetail({
  reference,
  left,
  top,
}: {
  reference: CanvasMaterialReference;
  left: number;
  top: number;
}) {
  return createPortal(
    <figure
      id={`canvas-material-detail-${reference.nodeId}`}
      role="tooltip"
      aria-label={`素材详情 ${reference.title}`}
      data-canvas-material-hover={reference.nodeId}
      className="pointer-events-none fixed z-50 w-64 overflow-hidden rounded-lg border border-border bg-card shell-glow"
      style={{ left, top, transform: 'translate(-50%, -100%)' }}
    >
      {reference.kind === 'image' && reference.previewUrl ? (
        <img
          src={reference.previewUrl}
          alt={reference.title}
          className="h-40 w-full bg-background object-contain"
        />
      ) : reference.kind === 'video' && reference.previewUrl ? (
        <video
          src={reference.previewUrl}
          aria-label={reference.title}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          className="h-40 w-full bg-black object-contain"
        />
      ) : reference.kind === 'text' ? (
        <div className="flex h-40 items-center px-4 text-sm leading-relaxed text-foreground">
          <p className="line-clamp-5">{reference.text || '空文本素材'}</p>
        </div>
      ) : (
        <div className="grid h-40 place-items-center bg-secondary/30 text-muted-foreground">
          {reference.kind === 'audio'
            ? <FileAudio className="size-8" aria-hidden="true" />
            : reference.kind === 'video'
              ? <FileVideo className="size-8" aria-hidden="true" />
              : <FileImage className="size-8" aria-hidden="true" />}
        </div>
      )}
      <figcaption className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{reference.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{mentionKindLabel(reference.kind)}</span>
      </figcaption>
    </figure>,
    document.body,
  );
}

function CanvasMaterialPreview({ reference }: { reference: CanvasMaterialReference }) {
  const videoFrame = useVideoFrame(
    reference.kind === 'video' ? reference.previewUrl ?? null : null,
  );
  if (reference.kind === 'image' && reference.previewUrl) {
    return (
      <img
        src={reference.previewUrl}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        className="size-full object-cover"
      />
    );
  }
  if (reference.kind === 'video' && videoFrame) {
    return (
      <img
        src={videoFrame}
        alt=""
        data-canvas-material-thumbnail={reference.nodeId}
        draggable={false}
        className="size-full bg-black object-cover"
      />
    );
  }
  const Icon = reference.kind === 'video'
    ? FileVideo
    : reference.kind === 'audio'
      ? FileAudio
      : Type;
  return <Icon className="size-4" aria-hidden="true" />;
}

export function CanvasMobileGenerationPanel({
  node,
  draft,
  context,
}: {
  node: CanvasNode;
  draft: CanvasGenerationDraft;
  context: CanvasNodeContextValue;
}) {
  return (
    <aside className="canvas-mobile-generation-panel absolute z-20 rounded-xl border border-border bg-glass p-3 backdrop-blur-glass shell-glow">
      <CanvasGenerationComposer
        embedded
        node={node}
        draft={draft}
        context={context}
        onClose={() => context.generationPanel.dismiss(node.id)}
      />
    </aside>
  );
}

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
  const { current, history } = presentCanvasCandidates(context.jobsByResultNodeId.get(nodeId) ?? []);
  if (!current.length && !history.length) return null;

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
  entries: CanvasCandidateEntry[];
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
            {!retryDisabled
              && job.canvas_run
              && (candidate.status === 'failed' || candidate.status === 'canceled')
              && (
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
  return <button ref={buttonRef} type="button" title={label} aria-label={label} aria-pressed={active} aria-expanded={expanded} aria-controls={controlsId} aria-haspopup={controlsId && popup ? popup : undefined} disabled={disabled} onClick={onClick} className={cn('grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-30', active && 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground')}>{children}</button>;
}

function MediaToolButton({ label, text, destructive = false, disabled = false, onClick, children }: {
  label: string;
  text?: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className={cn(
        'nodrag flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-30',
        text ? 'gap-1 px-2' : 'w-7',
        destructive && 'hover:text-destructive',
      )}
      onClick={event => {
        event.stopPropagation();
        onClick();
      }}
    >
      <span aria-hidden="true" className="[&>svg]:size-3.5">{children}</span>
      {text && <span className="text-xs">{text}</span>}
    </button>
  );
}

function MediaToolLink({ label, text, href, children }: {
  label: string;
  text?: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      title={label}
      aria-label={label}
      className={cn(
        'nodrag flex h-7 shrink-0 items-center justify-center whitespace-nowrap rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        text ? 'gap-1 px-2' : 'w-7',
      )}
      onClick={event => event.stopPropagation()}
    >
      <span aria-hidden="true" className="[&>svg]:size-3.5">{children}</span>
      {text && <span className="text-xs">{text}</span>}
    </a>
  );
}

function MediaToolMenuItem({ label, text = label, destructive = false, disabled = false, onSelect, children }: {
  label: string;
  text?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenuItem aria-label={label} destructive={destructive} disabled={disabled} onSelect={onSelect}>
      <span aria-hidden="true" className="[&>svg]:size-4">{children}</span>
      {text}
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

function nodeIcon(node: CanvasNode) {
  if (node.type === 'text') return <Type className="size-3.5 shrink-0" />;
  if (node.type === 'image') return <FileImage className="size-3.5 shrink-0" />;
  if (node.type === 'video') return <FileVideo className="size-3.5 shrink-0" />;
  if (node.type === 'audio') return <FileAudio className="size-3.5 shrink-0" />;
  return <Sparkles className="size-3.5 shrink-0" />;
}

function textScaleClass(scale: 'xs' | 'sm' | 'base') {
  if (scale === 'xs') return 'text-xs';
  if (scale === 'base') return 'text-base';
  return 'text-sm';
}

function EmptyMediaSurface({
  node,
  replacing,
  onUpload,
}: {
  node: Exclude<CanvasContentNode, { type: 'text' }>;
  replacing: boolean;
  onUpload: () => void;
}) {
  const label = node.type === 'image' ? '图片' : node.type === 'video' ? '视频' : '音频';
  const Icon = node.type === 'image' ? FileImage : node.type === 'video' ? FileVideo : FileAudio;
  return (
    <div className="grid min-h-44 place-items-center p-4 text-center text-muted-foreground">
      <div className="flex flex-col items-center gap-3">
        <span className="grid size-12 place-items-center rounded-lg bg-secondary/60">
          <Icon className="size-6 opacity-50" aria-hidden="true" />
        </span>
        <span className="text-xs">空{label}节点</span>
        <button
          type="button"
          aria-label={`上传${label}到 ${node.title}`}
          disabled={replacing}
          className="nodrag nowheel inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-transparent px-3 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"
          onClick={event => {
            event.stopPropagation();
            onUpload();
          }}
          onPointerDown={event => event.stopPropagation()}
          onDoubleClick={event => event.stopPropagation()}
        >
          {replacing ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <FileUp className="size-3.5" aria-hidden="true" />}
          上传{label}
        </button>
      </div>
    </div>
  );
}

function MediaPreview({
  kind,
  src,
  title = '',
  fit = 'contain',
  freeResize = false,
  compact = false,
}: {
  kind: 'image' | 'video' | 'audio';
  src: string;
  title?: string;
  fit?: 'contain' | 'cover';
  freeResize?: boolean;
  compact?: boolean;
}) {
  const { mediaRef, resolvedSrc } = useLazyMedia(src);
  const videoElement = useRef<HTMLVideoElement | null>(null);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoMuted, setVideoMuted] = useState(false);
  const [videoVolume, setVideoVolume] = useState(1);
  const stopCanvasInteraction = (event: React.SyntheticEvent) => event.stopPropagation();
  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    videoElement.current = element;
    mediaRef(element);
  }, [mediaRef]);
  const toggleVideoPlayback = () => {
    const video = videoElement.current;
    if (!video) return;
    if (videoPlaying) video.pause();
    else void video.play().catch(() => setVideoPlaying(false));
  };
  const seekVideo = (seconds: number) => {
    const video = videoElement.current;
    if (!video) return;
    video.currentTime = seconds;
    setVideoCurrentTime(seconds);
  };
  const setVolume = (volume: number) => {
    const video = videoElement.current;
    if (!video) return;
    video.volume = volume;
    video.muted = volume === 0;
    setVideoVolume(volume);
    setVideoMuted(volume === 0);
  };
  const toggleVideoMuted = () => {
    const video = videoElement.current;
    if (!video) return;
    video.muted = !video.muted;
    setVideoMuted(video.muted);
  };
  const showVideoFullscreen = () => {
    const video = videoElement.current;
    if (!video?.requestFullscreen) return;
    void video.requestFullscreen().catch(() => undefined);
  };
  if (kind === 'image') return (
    <img
      src={src}
      alt={title}
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cn(
        'size-full select-none',
        freeResize ? 'object-fill' : fit === 'cover' ? 'object-cover' : 'object-contain',
        compact && 'max-h-48 rounded-md',
      )}
    />
  );
  if (kind === 'video') {
    const mediaLabel = title || '视频';
    return (
      <div className={cn('relative size-full', compact && 'max-h-48')}>
        <video
          ref={videoRef}
          src={resolvedSrc}
          playsInline
          preload={resolvedSrc ? 'metadata' : 'none'}
          data-canvas-media-controls="video"
          className={cn(
            'size-full',
            freeResize ? 'object-fill' : fit === 'cover' ? 'object-cover' : 'object-contain',
            compact && 'max-h-48 rounded-md',
          )}
          onClick={event => event.preventDefault()}
          onDoubleClick={stopCanvasInteraction}
          onPlay={() => setVideoPlaying(true)}
          onPause={() => setVideoPlaying(false)}
          onEnded={() => setVideoPlaying(false)}
          onLoadedMetadata={event => {
            setVideoDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
            setVideoCurrentTime(event.currentTarget.currentTime);
            setVideoMuted(event.currentTarget.muted);
            setVideoVolume(event.currentTarget.volume);
          }}
          onTimeUpdate={event => setVideoCurrentTime(event.currentTarget.currentTime)}
          onVolumeChange={event => {
            setVideoMuted(event.currentTarget.muted);
            setVideoVolume(event.currentTarget.volume);
          }}
        />
        <div
          className="nodrag nowheel absolute bottom-2 left-2 right-2 z-10 flex items-center gap-2 rounded-lg border border-border bg-glass p-1.5 text-foreground backdrop-blur-glass"
          onPointerDown={stopCanvasInteraction}
          onDoubleClick={stopCanvasInteraction}
          onClick={stopCanvasInteraction}
          onKeyDown={stopCanvasInteraction}
        >
          <button
            type="button"
            aria-label={`${videoPlaying ? '暂停' : '播放'} ${mediaLabel}`}
            className="grid size-7 shrink-0 place-items-center rounded-full transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={toggleVideoPlayback}
          >
            {videoPlaying
              ? <Pause className="size-4" aria-hidden="true" />
              : <Play className="size-4" aria-hidden="true" />}
          </button>
          <input
            type="range"
            aria-label="视频播放进度"
            min={0}
            max={videoDuration || 0}
            step="any"
            value={Math.min(videoCurrentTime, videoDuration || 0)}
            className="min-w-0 flex-1 accent-primary"
            onChange={event => seekVideo(Number(event.currentTarget.value))}
          />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatMediaTime(videoCurrentTime)} / {formatMediaTime(videoDuration)}
          </span>
          <button
            type="button"
            aria-label={`${videoMuted ? '取消静音' : '静音'} ${mediaLabel}`}
            className="grid size-7 shrink-0 place-items-center rounded-full transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={toggleVideoMuted}
          >
            {videoMuted || videoVolume === 0
              ? <VolumeX className="size-4" aria-hidden="true" />
              : <Volume2 className="size-4" aria-hidden="true" />}
          </button>
          <input
            type="range"
            aria-label="视频音量"
            min={0}
            max={1}
            step={0.05}
            value={videoMuted ? 0 : videoVolume}
            className="w-16 accent-primary"
            onChange={event => setVolume(Number(event.currentTarget.value))}
          />
          <button
            type="button"
            aria-label={`全屏播放 ${mediaLabel}`}
            className="grid size-7 shrink-0 place-items-center rounded-full transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={showVideoFullscreen}
          >
            <Maximize2 className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="nodrag nowheel grid size-full place-items-center gap-3 p-4 text-xs text-muted-foreground">
      {!compact && <span className="flex items-center gap-2"><FileAudio className="size-5" aria-hidden="true" />音频素材</span>}
      <audio
        ref={mediaRef}
        src={resolvedSrc}
        controls
        preload={resolvedSrc ? 'metadata' : 'none'}
        data-canvas-media-controls="audio"
        className="w-full"
        onClick={stopCanvasInteraction}
        onDoubleClick={stopCanvasInteraction}
        onPointerDown={stopCanvasInteraction}
        onKeyDown={stopCanvasInteraction}
      />
    </div>
  );
}

function formatMediaTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, '0')}`;
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
