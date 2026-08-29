import {
  Handle,
  NodeResizer,
  NodeToolbar,
  Position,
  useStore,
  type Node,
  type ReactFlowState,
  type NodeProps,
  type OnResize,
  type OnResizeEnd,
} from '@xyflow/react';
import { ArrowLeftRight, Check, ChevronRight, ClipboardCopy, Download, Ellipsis, Eye, FileAudio, FileImage, FileUp, FileVideo, Library, LoaderCircle, Lock, Maximize2, MessageSquare, Minus, Pause, Pencil, Play, Plus, Sparkles, Square, Trash2, Type, Unlock, Volume2, VolumeX, X } from 'lucide-react';
import {
  createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef,
  useState,
  type FocusEvent as ReactFocusEvent, type ReactNode, type Ref, type RefObject,
} from 'react';
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
import {
  CanvasMaterialHoverDetail,
  type CanvasMaterialHoverState,
} from '@/components/canvas/CanvasMaterialHoverDetail';
import type { CanvasMediaTool } from '@/components/canvas/CanvasMediaOperationDialog';
import {
  CanvasNodeRunBadge,
  CanvasNodeRunLiveRegion,
  CanvasNodeRunOverlay,
  canvasNodeRunDisplayError,
  canvasNodeRunState,
  isReversePromptJob,
} from '@/components/canvas/CanvasNodeRunStatus';
import { formatCanvasImageInfo } from '@/components/canvas/canvasMediaFormatting';
import { orderedCanvasImageTools } from '@/components/canvas/canvasImageToolbar';
import { isUploadedImageMaterialNode } from '@/components/canvas/canvasNodePanelInteraction';
import { imageControlCaps } from '@/lib/imageControlCaps';
import { VideoControls } from '@/components/studio/VideoControls';
import {
  videoReferenceLimitLabel,
  videoReferenceLimits,
  type VideoReferenceLimits,
} from '@/lib/videoControlCaps';
import { cn } from '@/lib/utils';
import { presentCanvasCandidates, type CanvasCandidateEntry } from '@/lib/canvasCandidates';
import { useVideoFrame } from '@/lib/videoFrame';
import {
  canvasMentionMatches,
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
  CanvasPoint,
  CanvasSize,
  CanvasUiPreferences,
  CanvasVideoFrameSlot,
} from '@/schema/canvas';
import type { Job, JobParams } from '@/schema/jobs';
import {
  canvasNodeAcceptsInput,
  canvasNodeProvidesOutput,
  canvasNodeProvidesContent,
  CANVAS_GENERATION_MODE_LABELS,
  CANVAS_MAX_NODE_SIZE,
  canvasGenerateBlock,
  canvasGenerationModelSupportsMode,
  canvasVideoEditCaps,
  normalizeCanvasAudioParams,
  normalizeCanvasImageParams,
  normalizeCanvasTextParams,
  normalizeCanvasVideoParams,
  supportsCanvasTextReasoning,
  switchCanvasGenerationDraft,
  type CanvasPendingInput,
} from '@/pages/canvasEditorModel';

export type FlowNode = Node<{ domain: CanvasNode }, 'canvasNode'>;

export interface CanvasGenerationPanelContextValue {
  dismissedNodeId: string | null;
  narrowViewport: boolean;
  dismiss: (id: string) => void;
  /** 面板 portal 的落点（画布区域，position:relative）。缺省时退回 body + fixed 定位。 */
  surfaceRef?: RefObject<HTMLElement | null>;
}

export interface CanvasNodeContextValue {
  projectId: string;
  materialReferences: readonly CanvasMaterialReference[];
  connectedMaterialNodeIdsByNodeId: ReadonlyMap<string, ReadonlySet<string>>;
  videoFrameNodeIdsByNodeId?: ReadonlyMap<string, Readonly<Partial<Record<CanvasVideoFrameSlot, string>>>>;
  pendingInputNodesByNodeId?: ReadonlyMap<string, readonly CanvasPendingInput[]>;
  mentionReferencesByNodeId: ReadonlyMap<string, readonly CanvasMentionReference[]>;
  /** 按 version_id 取内容。常量引用，不随版本表变化——原因见 CanvasEditor 里的说明。 */
  resolveVersion: (versionId: string | null | undefined) => CanvasContentVersion | undefined;
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
  multiSelectionActive?: boolean;
  generationPanel: CanvasGenerationPanelContextValue;
  materialPick?: {
    targetNodeId: string;
    slot?: CanvasVideoFrameSlot;
    selectableNodeIds: ReadonlySet<string>;
  } | null;
  beginMaterialPick?: (request: {
    targetNodeId: string;
    slot?: CanvasVideoFrameSlot;
    selectableNodeIds: ReadonlySet<string>;
  }) => void;
  setMaterialConnected: (sourceNodeId: string, targetNodeId: string, connected: boolean) => void;
  setVideoFrameConnections?: (
    targetNodeId: string,
    frames: Readonly<Record<CanvasVideoFrameSlot, string | null>>,
  ) => void;
  selectNode: (id: string) => void;
  previewContent: (id: string, title: string, nodeId: string) => void;
  selectCandidate: (id: string, versionId: string) => void;
  reportError?: (message: string) => void;
  submitRun: (id: string) => Promise<void>;
  retryRun: (id: string, runId: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  dismissCandidate: (runId: string, candidateId: string) => Promise<void>;
  updateNode: (id: string, updater: (node: CanvasNode) => CanvasNode) => void;
  previewNodeResize?: (id: string, layout: { position: CanvasPoint; size: CanvasSize }) => void;
  completeNodeResize?: (id: string, layout: { position: CanvasPoint; size: CanvasSize }) => void;
  renameNode: (id: string, title: string) => void;
  updateText: (id: string, text: string) => void;
  setTextEditing?: (id: string, editing: boolean) => void;
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
const EMPTY_VIDEO_FRAME_NODE_IDS: Readonly<Partial<Record<CanvasVideoFrameSlot, string>>> = {};
const EMPTY_CANVAS_PENDING_INPUTS: readonly CanvasPendingInput[] = [];
const EMPTY_CANVAS_MENTION_REFERENCES: readonly CanvasMentionReference[] = [];

export function CanvasNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const context = useContext(CanvasNodeContext);
  const setTextEditing = context?.setTextEditing;
  const node = data.domain;
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isEditingText, setIsEditingText] = useState(false);
  const [titleDraft, setTitleDraft] = useState(node.title);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleTriggerRef = useRef<HTMLButtonElement>(null);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const textEditingExitRequested = useRef(false);
  const textSelectionRef = useRef<{
    start: number;
    end: number;
    direction: 'forward' | 'backward' | 'none';
  } | null>(null);
  const contentSurfaceRef = useRef<HTMLElement>(null);
  const titleExitInProgress = useRef(false);
  const restoreTitleFocus = useRef(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarOverlayOpen, setToolbarOverlayOpen] = useState(false);
  const [candidateBatchExpanded, setCandidateBatchExpanded] = useState(false);
  const [materialPickPointer, setMaterialPickPointer] = useState<{ left: number; top: number } | null>(null);
  const draft = generationDraft(node);
  const nodeContent = context ? contentForNode(node, context.resolveVersion) : undefined;
  const uploadedImageMaterial = Boolean(
    context && isUploadedImageMaterialNode(node, nodeContent),
  );
  const generationPanelVisible = Boolean(
    context
    && selected
    && !context.multiSelectionActive
    && draft
    && !(node.type === 'config' && draft.mode === 'text')
    && !uploadedImageMaterial
    && !context.generationPanel.narrowViewport
    && context.generationPanel.dismissedNodeId !== node.id,
  );
  const materialPickEligible = Boolean(context?.materialPick?.selectableNodeIds.has(node.id));
  const [shellElement, setShellElement] = useState<HTMLDivElement | null>(null);
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
    if (editor) rememberTextSelection(editor);
  }, [isEditingText]);
  useLayoutEffect(() => {
    if (!isEditingText || textEditingExitRequested.current) return;
    const editor = textEditorRef.current;
    if (!editor || window.document.activeElement === editor) return;
    // 保存回写可能替换 textarea DOM，旧节点不会再触发 blur。编辑会话仍有效时把焦点
    // 和选区交给新节点；普通输入时 activeElement 已经是 editor，不会触碰当前选区。
    editor.focus({ preventScroll: true });
    restoreTextSelection(editor);
  }, [isEditingText, node]);
  useEffect(() => {
    if (!isEditingText) return;
    const finishOnOutsidePointer = (event: PointerEvent) => {
      const surface = contentSurfaceRef.current;
      if (!surface || !(event.target instanceof Element) || surface.contains(event.target)) return;
      textEditingExitRequested.current = true;
      setTextEditing?.(node.id, false);
      setIsEditingText(false);
    };
    // blur 不能代表用户结束编辑：自动保存重渲染、切应用和输入法候选窗都可能让
    // textarea 短暂失焦。只响应用户明确点到编辑区外的 pointerdown。
    window.document.addEventListener('pointerdown', finishOnOutsidePointer, true);
    return () => window.document.removeEventListener('pointerdown', finishOnOutsidePointer, true);
  }, [isEditingText, node.id, setTextEditing]);
  useEffect(() => () => setTextEditing?.(node.id, false), [node.id, setTextEditing]);
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
  useEffect(() => {
    if (!context?.multiSelectionActive) return;
    setToolbarOverlayOpen(false);
    setCandidateBatchExpanded(false);
  }, [context?.multiSelectionActive]);
  useEffect(() => {
    if (!context?.materialPick || !materialPickEligible) setMaterialPickPointer(null);
  }, [context?.materialPick, materialPickEligible]);
  const recordNodeResizeHistory = context?.recordHistory;
  const previewNodeResize = context?.previewNodeResize;
  const completeNodeResize = context?.completeNodeResize;
  const handleResizeStart = useCallback(() => {
    recordNodeResizeHistory?.();
  }, [recordNodeResizeHistory]);
  const handleResize = useCallback<OnResize>((_, params) => {
    previewNodeResize?.(node.id, {
      position: { x: params.x, y: params.y },
      size: { width: params.width, height: params.height },
    });
  }, [node.id, previewNodeResize]);
  const handleResizeEnd = useCallback<OnResizeEnd>((_, params) => {
    completeNodeResize?.(node.id, {
      position: { x: params.x, y: params.y },
      size: { width: params.width, height: params.height },
    });
  }, [completeNodeResize, node.id]);

  function moveMaterialPickTooltip(clientX: number, clientY: number) {
    setMaterialPickPointer({
      left: clientX + 14,
      top: clientY + 14,
    });
  }
  if (!context) return null;
  const renameNode = context.renameNode;
  const content = nodeContent;
  const copyablePrompt = copyablePromptForNode(
    node,
    context.jobsByResultNodeId,
  );
  const replacingMedia = context.mediaReplaceBusyNodeIds.has(node.id);
  const submittingNode = context.submittingNodeIds.has(node.id);
  const nodeRunState = canvasNodeRunState(node, context.jobsByRunId);
  const nodeJob = nodeRunState.job;
  const emptyMediaNode = node.type !== 'text' && isCanvasContentNode(node) && !content
    ? node
    : null;
  const reversePromptJob = nodeJob && isReversePromptJob(nodeJob) ? nodeJob : undefined;
  const reversePromptSucceeded = reversePromptJob?.canvas_run?.candidates.some(candidate => candidate.status === 'succeeded') ?? false;
  const candidatePresentation = node.type === 'image' || node.type === 'video'
    ? presentCanvasCandidates(context.jobsByResultNodeId.get(node.id) ?? [])
    : null;
  const mediaCandidates = candidatePresentation
    ? node.type === 'video'
      ? [
          ...candidatePresentation.current,
          ...candidatePresentation.history.filter(entry => (
            entry.candidate.status === 'succeeded'
            && Boolean(entry.candidate.version_id)
            && !entry.candidate.dismissed_at
          )),
        ]
      : candidatePresentation.current
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
    textEditingExitRequested.current = false;
    textSelectionRef.current = null;
    setTextEditing?.(node.id, true);
    setIsEditingText(true);
  }

  function finishTextEditing(restoreFocus: boolean) {
    textEditingExitRequested.current = true;
    setTextEditing?.(node.id, false);
    setIsEditingText(false);
    if (restoreFocus) requestAnimationFrame(() => contentSurfaceRef.current?.focus());
  }

  function restoreTextEditingFocus() {
    requestAnimationFrame(() => {
      if (textEditingExitRequested.current) return;
      const editor = textEditorRef.current;
      editor?.focus({ preventScroll: true });
      if (editor) restoreTextSelection(editor);
    });
  }

  function rememberTextSelection(editor: HTMLTextAreaElement) {
    textSelectionRef.current = {
      start: editor.selectionStart,
      end: editor.selectionEnd,
      direction: editor.selectionDirection,
    };
  }

  function restoreTextSelection(editor: HTMLTextAreaElement) {
    const selection = textSelectionRef.current;
    if (!selection) return;
    const end = Math.min(selection.end, editor.value.length);
    const start = Math.min(selection.start, end);
    editor.setSelectionRange(start, end, selection.direction);
  }

  function handleTextEditorBlur(event: ReactFocusEvent<HTMLTextAreaElement>) {
    // Tab、辅助技术或弹窗把焦点明确移到另一个控件时结束编辑，避免形成焦点陷阱。
    // 自动保存替换 DOM、切换应用和输入法候选窗造成的临时失焦通常没有 relatedTarget。
    if (event.relatedTarget instanceof Element) {
      finishTextEditing(false);
      return;
    }
    restoreTextEditingFocus();
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
      ref={setShellElement}
      className="canvas-node-shell group relative h-full w-full overflow-visible"
      data-selected={selected ? 'true' : 'false'}
    >
      <NodeResizer
        isVisible={selected && !context.multiSelectionActive && !replacingMedia}
        keepAspectRatio={node.type === 'image' && !node.data.display.free_resize}
        minWidth={node.type === 'text' ? 220 : 240}
        minHeight={node.type === 'text' ? 120 : 150}
        maxWidth={CANVAS_MAX_NODE_SIZE}
        maxHeight={CANVAS_MAX_NODE_SIZE}
        color="var(--primary)"
        handleClassName="canvas-node-resize-handle"
        lineClassName="canvas-node-resize-line"
        onResizeStart={handleResizeStart}
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
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
        isVisible={
          !context.multiSelectionActive
          && (selected || toolbarOverlayOpen)
        }
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
          {emptyMediaNode ? (
            <MediaToolButton
              label={`上传${CANVAS_GENERATION_MODE_LABELS[emptyMediaNode.type]}`}
              text="上传附件"
              disabled={replacingMedia}
              onClick={() => context.replaceMedia(emptyMediaNode)}
            >
              {replacingMedia ? <LoaderCircle className="animate-spin" /> : <FileUp />}
            </MediaToolButton>
          ) : node.type === 'image' ? (
            <>
              <ImageNodeToolbar
                node={node}
                content={content}
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
              submitting={submittingNode || nodeRunState.status === 'loading'}
              copyablePrompt={copyablePrompt}
              context={context}
              onEditText={beginTextEditing}
              onDecreaseText={() => setTextScale(-1)}
              onIncreaseText={() => setTextScale(1)}
            />
          )}
        </div>
      </NodeToolbar>
      {(node.type === 'image' || node.type === 'video') && mediaCandidates.length > 0 && (
        <MediaCandidateBatch
          node={node}
          entries={mediaCandidates}
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
          context.materialPick && materialPickEligible && 'cursor-copy hover:border-primary focus-visible:border-primary',
          context.materialPick && !materialPickEligible && 'cursor-default',
        )}
        onClick={event => {
          event.stopPropagation();
          context.selectNode(node.id);
        }}
        onPointerMove={event => {
          if (context.materialPick && materialPickEligible) {
            moveMaterialPickTooltip(event.clientX, event.clientY);
          }
        }}
        onPointerLeave={() => setMaterialPickPointer(null)}
        onFocus={event => {
          if (!context.materialPick || !materialPickEligible) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          setMaterialPickPointer({ left: bounds.left + 12, top: bounds.top + 12 });
        }}
        onBlur={event => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          setMaterialPickPointer(null);
        }}
        onDoubleClick={event => {
          event.stopPropagation();
          if (node.type === 'text') {
            if (nodeRunState.status === 'loading') return;
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
        {materialPickPointer && createPortal(
          <span
            className="pointer-events-none fixed z-30 max-w-64 truncate rounded-md border border-border bg-glass px-2 py-1 text-xs font-medium text-foreground backdrop-blur-glass shell-glow"
            style={materialPickPointer}
          >
            选择 {node.title}
          </span>,
          document.body,
        )}
        {context.mediaReplaceError?.nodeId === node.id && (
          <p
            role="alert"
            className="absolute inset-x-2 top-2 z-20 line-clamp-3 break-words rounded-md border border-destructive/40 bg-card/95 px-2 py-1.5 text-xs leading-relaxed text-destructive"
          >
            {canvasNodeRunDisplayError(context.mediaReplaceError.message, '替换失败，请稍后重试')}
          </p>
        )}
        <div className={cn('h-full bg-secondary/20', node.type === 'text' ? 'min-h-32' : 'min-h-44')}>
          {node.type === 'text' && (
            isEditingText ? (
              <textarea
                ref={textEditorRef}
                aria-label={`编辑 ${node.title} 正文`}
                value={content?.kind === 'text' ? content.text : ''}
                disabled={nodeRunState.status === 'loading'}
                placeholder="输入文本…"
                className={cn(
                  'nodrag nowheel block h-full min-h-32 w-full resize-none overflow-y-auto border-0 bg-transparent p-3 leading-relaxed text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
                  textScaleClass(node.data.display.scale),
                )}
                onChange={event => {
                  rememberTextSelection(event.target);
                  context.updateText(node.id, event.target.value);
                }}
                onSelect={event => rememberTextSelection(event.currentTarget)}
                onBlur={handleTextEditorBlur}
                onPointerDown={event => event.stopPropagation()}
                onDoubleClick={event => event.stopPropagation()}
                onKeyDown={event => {
                  event.stopPropagation();
                  if (event.key === 'Tab') {
                    event.preventDefault();
                    finishTextEditing(true);
                    return;
                  }
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
              // 节点卡上的图按卡片宽度取缩略图。画布上一屏能有几十上百个节点，
              // 发原图等于让浏览器同时解出同样多张满分辨率位图。
              src={canvasMediaUrl(
                context.projectId,
                content.version_id,
                content.kind === 'image' ? node.size?.width ?? 320 : undefined,
              )}
              title={node.title}
              fit={node.type === 'image' || node.type === 'video' ? node.data.display.fit : 'contain'}
              freeResize={(node.type === 'image' || node.type === 'video') && node.data.display.free_resize}
            />
          )}
          {selected && !context.multiSelectionActive && uploadedImageMaterial && node.type === 'image' && (
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
            <EmptyMediaSurface node={node} />
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
        state={nodeRunState}
        hasContent={Boolean(content)}
      />
      {canvasNodeAcceptsInput(node) && (
        <Handle type="target" position={Position.Left} className="canvas-node-handle" aria-label="连接到此节点">
          <span className="canvas-node-handle-dot" aria-hidden="true" />
        </Handle>
      )}
      {canvasNodeProvidesOutput(node) && (
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
        <CanvasNodeFloatingPanel
          nodeId={node.id}
          anchor={shellElement}
          surfaceRef={context.generationPanel.surfaceRef}
        >
          <CanvasGenerationComposer
            node={node}
            draft={draft}
            context={context}
            onClose={() => context.generationPanel.dismiss(node.id)}
          />
        </CanvasNodeFloatingPanel>
      )}
    </div>
  );
}

export const CANVAS_GENERATION_PANEL_WIDTH = 608;
const CANVAS_GENERATION_PANEL_GAP = 16;

/** 只用到矩形的这几个数，写成最小接口好让放置逻辑纯函数化、能单测。 */
export interface CanvasPanelRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface CanvasPanelPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/** 生成面板只贴在节点正下方或正上方，视口坐标系。
 *
 *  横坐标永远按节点中心对齐，不再为了留在屏幕里而夹边、压窄或跳到节点左右。这样拖动节点时
 *  面板与节点的空间关系始终稳定；节点靠近画布边缘时允许面板自然超出可视范围。
 *
 *  垂直方向优先放下方，下方放不下再放上方；两边都放不下时选剩余空间更大的一侧。maxHeight
 *  仍负责限制超高内容并让面板内部滚动，不参与横向适配。 */
export function placeCanvasGenerationPanel(
  anchor: CanvasPanelRect,
  bounds: CanvasPanelRect,
  panelHeight: number,
): CanvasPanelPlacement {
  const gap = CANVAS_GENERATION_PANEL_GAP;
  const width = CANVAS_GENERATION_PANEL_WIDTH;
  const maxHeight = Math.max(160, bounds.height - gap * 2);
  const height = Math.min(panelHeight > 0 ? panelHeight : maxHeight, maxHeight);
  const alignedLeft = anchor.left + anchor.width / 2 - width / 2;

  const below = anchor.bottom + gap;
  if (below + height <= bounds.bottom - gap) {
    return { left: alignedLeft, top: below, width, maxHeight };
  }
  const above = anchor.top - gap - height;
  if (above >= bounds.top + gap) {
    return { left: alignedLeft, top: above, width, maxHeight };
  }

  const roomBelow = bounds.bottom - anchor.bottom;
  const roomAbove = anchor.top - bounds.top;
  return {
    left: alignedLeft,
    top: roomBelow >= roomAbove ? below : above,
    width,
    maxHeight,
  };
}

/** 画布外框上的常驻控件占了哪几条边。
 *
 *  只夹进视口还不够：面板贴着可视区下沿摆的时候，「开始生成」正好落在左下那组缩放控件底下
 *  （1280×720 实测），主操作点不到。按控件的实际矩形收缩可用区域，尺寸变了不用改这里。 */
function canvasChromeInsetBounds(surface: HTMLElement): CanvasPanelRect {
  const bounds = surface.getBoundingClientRect();
  const edge = (selector: string) => surface.querySelector(selector)?.getBoundingClientRect() ?? null;
  const rail = edge('.canvas-tool-dock') ?? edge('.canvas-mobile-rail');
  const zoom = edge('.canvas-zoom-dock');
  const library = edge('.canvas-library-panel');
  const top = edge('.canvas-editor-top');
  const left = rail ? Math.max(bounds.left, rail.right) : bounds.left;
  const right = library ? Math.min(bounds.right, library.left) : bounds.right;
  const upper = top ? Math.max(bounds.top, top.bottom) : bounds.top;
  const lower = zoom ? Math.min(bounds.bottom, zoom.top) : bounds.bottom;
  return {
    left,
    right,
    top: upper,
    bottom: lower,
    width: Math.max(0, right - left),
    height: Math.max(0, lower - upper),
  };
}

const canvasFlowTransform = (state: ReactFlowState) => state.transform;

/** 锚点节点自己的位置与尺寸，拼成字符串。
 *
 *  拖动节点和缩放节点都只改节点自己的几何，不改画布 transform——面板原来只订阅 transform，
 *  所以拖着节点走它会留在原地（画师报的第一个问题）。
 *
 *  返回字符串而不是 `{x, y, width, height}`：`useStore` 默认 Object.is 比较，返回对象等于
 *  每帧都是新引用，会让面板在平移、缩放、任何 store 变化时都重渲染一次。同类坑见
 *  CanvasEditor 里 edgeLookup 那段注释。 */
function canvasNodeGeometry(state: ReactFlowState, nodeId: string) {
  const node = state.nodeLookup.get(nodeId);
  if (!node) return '';
  const { x, y } = node.internals.positionAbsolute;
  return `${x},${y},${node.measured.width ?? 0},${node.measured.height ?? 0}`;
}

function samePlacement(a: CanvasPanelPlacement | null, b: CanvasPanelPlacement) {
  return a !== null
    && Math.abs(a.left - b.left) < 0.5
    && Math.abs(a.top - b.top) < 0.5
    && a.width === b.width
    && a.maxHeight === b.maxHeight;
}

/** 生成面板挂在画布区域上，不再挂在节点里面。
 *
 *  原实现是 React Flow 节点的子元素，靠 scale(1/zoom) 反缩放对抗画布缩放。两个后果：
 *  transform 默认绕中心缩放，608px 的面板放大后向左右各溢出上百像素（1280×720 视口实测面板
 *  left=-77，提示词编辑区左边 64px 落在视口外，看不见也点不到）；而且它活在 transform 层里，
 *  夹视口这件事在那儿做不到——父级 transform 之后再 clamp 也夹不回来。
 *  portal 到 .canvas-editor-region（position:relative）之后：尺寸恒定不再受缩放影响，位置按节点
 *  的屏幕矩形算，文字也不再被分数倍缩放糊掉。
 *
 *  位置状态留在本组件内：children 由父级 render 传进来，本组件因平移重新定位时 children 仍是
 *  同一个 element 引用，React 会跳过整棵子树，面板内容不会跟着每帧重渲染。 */
function CanvasNodeFloatingPanel({
  nodeId,
  anchor,
  surfaceRef,
  children,
}: {
  nodeId: string;
  /** 节点外壳的 DOM 节点。传元素而不是 ref：子组件的 layout effect 在父级 ref 挂上之前就跑，
   *  用 ref 会拿到 null，首帧永远定位不上。父级用 callback ref 把它变成 state 传下来。 */
  anchor: HTMLElement | null;
  surfaceRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CanvasPanelPlacement | null>(null);
  // 平移与缩放都改 transform，订阅它就不用起 rAF 常驻轮询。
  const transform = useStore(canvasFlowTransform);
  // 拖动 / 缩放这个节点本身不动 transform，得另外订阅节点自己的几何。
  const geometrySelector = useCallback(
    (state: ReactFlowState) => canvasNodeGeometry(state, nodeId),
    [nodeId],
  );
  const geometry = useStore(geometrySelector);
  const surface = surfaceRef?.current ?? null;

  const place = useCallback(() => {
    if (!anchor) return;
    const measured = surface ? canvasChromeInsetBounds(surface) : null;
    // 容器还没布局（宽或高为 0）时按视口算，否则面板会被夹成 240×160。
    const bounds: CanvasPanelRect = measured && measured.width > 0 && measured.height > 0
      ? measured
      : {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight,
      };
    const viewportPlacement = placeCanvasGenerationPanel(
      anchor.getBoundingClientRect(),
      bounds,
      panelRef.current?.offsetHeight ?? 0,
    );
    // portal 进容器时按容器坐标存，避免 render 阶段再读一次布局。
    // 原点用容器自身的矩形，不能用上面那个被控件收缩过的 bounds。
    const origin = surface?.getBoundingClientRect();
    const next = origin
      ? {
        ...viewportPlacement,
        left: viewportPlacement.left - origin.left,
        top: viewportPlacement.top - origin.top,
      }
      : viewportPlacement;
    setPlacement(current => samePlacement(current, next) ? current : next);
  }, [anchor, surface]);

  useLayoutEffect(() => {
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [geometry, place, transform]);

  return createPortal(
    <div
      ref={panelRef}
      data-canvas-node-panel-anchor={nodeId}
      style={{
        position: surface ? 'absolute' : 'fixed',
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        width: placement?.width ?? CANVAS_GENERATION_PANEL_WIDTH,
        maxHeight: placement?.maxHeight,
        overflowY: 'auto',
        zIndex: surface ? 10 : 50,
        visibility: placement ? undefined : 'hidden',
      }}
    >
      {children}
    </div>,
    surface ?? document.body,
  );
}

function MediaCandidateBatch({
  node,
  entries,
  primaryVersionId,
  expanded,
  disabled,
  context,
  onToggle,
}: {
  node: Extract<CanvasContentNode, { type: 'image' | 'video' }>;
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
  const primaryNumber = node.type === 'video' ? 1 : primary.candidate.index + 1;

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
        <MediaCandidateCard
          key={entry.candidate.candidate_id}
          node={node}
          entry={entry}
          index={index}
          number={node.type === 'video' ? index + 2 : entry.candidate.index + 1}
          disabled={disabled}
          context={context}
        />
      ))}
      {primaryTerminalFailure && !disabled && (
        <CandidateFailureActions
          number={primaryNumber}
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

function MediaCandidateCard({
  node,
  entry,
  index,
  number,
  disabled,
  context,
}: {
  node: Extract<CanvasContentNode, { type: 'image' | 'video' }>;
  entry: CanvasCandidateEntry;
  index: number;
  number: number;
  disabled: boolean;
  context: CanvasNodeContextValue;
}) {
  const { candidate } = entry;
  const horizontalOffset = index + 1;
  const version = context.resolveVersion(candidate.version_id);
  const terminalFailure = candidate.status === 'failed' || candidate.status === 'canceled';
  return (
    <section
      role="group"
      aria-label={`候选 ${number}`}
      className="pointer-events-auto absolute top-0 z-20 h-full overflow-hidden rounded-lg border border-border bg-card shell-glow"
      style={{
        left: `calc(${horizontalOffset * 100}% + ${horizontalOffset * 16}px)`,
        width: '100%',
      }}
      onPointerDown={event => event.stopPropagation()}
      onDoubleClick={event => {
        event.stopPropagation();
        if (version) context.previewContent(version.version_id, `${node.title} · 候选 ${number}`, node.id);
      }}
    >
      {version?.kind === node.type
        ? (
          <MediaPreview
            kind={version.kind}
            src={canvasMediaUrl(
              context.projectId,
              version.version_id,
              version.kind === 'image' ? node.size?.width ?? 320 : undefined,
            )}
            title={`${node.title} · 候选 ${number}`}
            fit={node.data.display.fit}
            freeResize={node.data.display.free_resize}
          />
        )
        : (
          <div className="grid size-full min-h-44 place-items-center px-4 text-center text-xs text-muted-foreground">
            {candidate.status === 'pending'
              ? <LoaderCircle className="animate-spin" aria-label={`候选 ${number} 生成中`} />
              : canvasNodeRunDisplayError(
                candidate.error,
                candidate.status === 'canceled' ? '已停止' : '结果待同步',
              )}
          </div>
        )}
      <span className="absolute left-2 top-2 rounded-md border border-border bg-glass px-2 py-1 text-xs text-muted-foreground backdrop-blur-glass">
        {number}
      </span>
      {!disabled && version?.kind === node.type && (
        <button
          type="button"
          aria-label={`将候选 ${number} 设为主结果`}
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
          number={number}
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
  onDismiss,
}: {
  number: number;
  onDismiss: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute bottom-2 right-2 z-20 flex items-center gap-1.5">
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
const CONFIG_OUTPUT_MODES = CONFIG_GENERATION_MODES.filter(({ mode }) => mode !== 'text');

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
  const textModeRemoved = draft.mode === 'text';
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
        className="nodrag nowheel grid grid-cols-3 gap-1 rounded-lg border border-border bg-background/50 p-1"
        onPointerDown={event => event.stopPropagation()}
        onClick={event => event.stopPropagation()}
        onKeyDown={handleModeKeys}
      >
        {CONFIG_OUTPUT_MODES.map(({ mode, label, icon: Icon }) => (
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
        {textModeRemoved ? (
          <p role="status" className="text-xs leading-relaxed text-muted-foreground">
            文本生成已合并到文本节点，请选择其它输出类型或删除此配置。
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">当前模型</p>
            <p aria-label="当前模型" className="mt-1 truncate text-sm font-medium text-foreground" title={selectedModel?.name ?? draft.model}>
              {selectedModel?.name ?? (draft.model || '未选择兼容模型')}
            </p>
          </>
        )}
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
          <MediaToolButton label={`编辑文本 ${node.title}`} disabled={submitting} onClick={onEditText}>
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
            disabled={content?.kind !== 'text'}
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
      {contentNode && canvasNodeProvidesContent(contentNode) && (content || mediaNode) && (
        <MediaToolButton
          label={`将 ${node.title} 存入资产库`}
          disabled={!content || context.libraryBusy}
          onClick={() => {
            if (content) void context.saveAsset(contentNode);
          }}
        >
          <Library />
        </MediaToolButton>
      )}
      {content && content.kind !== 'text' ? (
        <MediaToolLink
          label={`下载 ${node.title}`}
          href={canvasDownloadUrl(context.projectId, content.version_id)}
        >
          <Download />
        </MediaToolLink>
      ) : mediaNode ? (
        <MediaToolButton label={`下载 ${node.title}`} disabled onClick={() => undefined}>
          <Download />
        </MediaToolButton>
      ) : null}
      {contentNode && canvasNodeProvidesContent(contentNode) && (copyablePrompt || mediaNode) && (
        <MediaToolButton
          label={`复制 ${node.title} 的生成提示词`}
          disabled={!copyablePrompt}
          onClick={() => {
            if (copyablePrompt) void context.copyPrompt(contentNode);
          }}
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
      {node.type === 'video' && (
        <MediaToolButton
          label={`编辑视频 ${node.title}`}
          disabled={content?.kind !== 'video' || submitting || replacing}
          onClick={() => {
            if (content?.kind === 'video') context.editVideo(node);
          }}
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

/** 「开始生成」被引用问题挡住时给出的唯一一条说明。
 *  四类问题按优先级取第一条，不叠加解释——按钮灰着却不说原因，用户只能报「点了没反应」。 */
function referenceErrorMessage(problems: {
  missingMentionCount: number;
  frameModeHasMentions: boolean;
  missingVideoFrame: boolean;
  videoReferenceCapacityExceeded: boolean;
  pendingInputTitles: readonly string[];
}) {
  if (problems.frameModeHasMentions) return '首尾帧模式不支持 @ 引用，删掉提示词里的 @ 内容后再生成。';
  if (problems.missingVideoFrame) return '首帧或尾帧连接的节点已不是可用图片，重新连接后再生成。';
  if (problems.videoReferenceCapacityExceeded) return '已连接的参考素材超出该模型上限，减少连接后再生成。';
  // 排在 missingMentionCount 前面：一个「已连接但还没生成」的节点同样不在可用素材里，会被
  // 上一条误报成「引用指向已断开的素材」——那句话会把用户引去删引用，而真正该做的是先生成它。
  if (problems.pendingInputTitles.length) {
    const count = problems.pendingInputTitles.length;
    const names = problems.pendingInputTitles.slice(0, 3).map(title => `「${title}」`).join('、');
    const rest = count > 3 ? ` 等 ${count} 个节点` : '';
    return count === 1
      ? `${names}还没有内容，先把它生成出来，或断开这条连接。`
      : `${names}${rest}还没有内容，先把它们生成出来，或断开这些连接。`;
  }
  if (problems.missingMentionCount > 0) {
    return `提示词里有 ${problems.missingMentionCount} 处引用指向已断开的素材，删掉这些引用后再生成。`;
  }
  return null;
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
  run: () => void;
};

function ImageNodeToolbar({
  node,
  content,
  replacing,
  submitting,
  copyablePrompt,
  context,
  onOverlayOpenChange,
}: {
  node: Extract<CanvasContentNode, { type: 'image' }>;
  content: CanvasContentVersion | undefined;
  replacing: boolean;
  submitting: boolean;
  copyablePrompt: string | null;
  context: CanvasNodeContextValue;
  onOverlayOpenChange: (open: boolean) => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const onOverlayOpenChangeRef = useRef(onOverlayOpenChange);
  useEffect(() => {
    onOverlayOpenChangeRef.current = onOverlayOpenChange;
  }, [onOverlayOpenChange]);
  useEffect(() => () => onOverlayOpenChangeRef.current(false), []);
  const resizeUnlocked = node.data.display.free_resize;
  const uploadedImageMaterial = isUploadedImageMaterialNode(node, content);
  const imageContent = content?.kind === 'image' ? content : undefined;
  const currentVersionId = imageContent?.version_id;
  const definitions = orderedCanvasImageTools(context.canvasUiPreferences.image_toolbar.tool_ids);
  const actions = definitions.flatMap(definition => {
    const Icon = definition.icon;
    const common = { id: definition.id, text: definition.label };
    let action: ImageToolbarAction | null = null;
    if (definition.id === 'info') action = {
      ...common,
      label: currentVersionId ? `查看 ${node.title} 详情` : `查看 ${node.title} 设置`,
      icon: <Icon />,
      run: () => currentVersionId
        ? context.previewContent(currentVersionId, node.title, node.id)
        : context.selectNode(node.id),
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
      disabled: !currentVersionId || context.libraryBusy,
      run: () => {
        if (currentVersionId) void context.saveAsset(node);
      },
    };
    if (definition.id === 'download') action = {
      ...common,
      label: `下载 ${node.title}`,
      icon: <Icon />,
      disabled: !currentVersionId,
      href: currentVersionId ? canvasDownloadUrl(context.projectId, currentVersionId) : undefined,
      run: () => undefined,
    };
    if (definition.id === 'copyPrompt') action = {
      ...common,
      label: `复制 ${node.title} 的生成提示词`,
      icon: <Icon />,
      disabled: !copyablePrompt,
      run: () => {
        if (copyablePrompt) void context.copyPrompt(node);
      },
    };
    if (definition.id === 'reversePrompt') action = {
      ...common,
      label: `反推 ${node.title} 的提示词`,
      icon: submitting ? <LoaderCircle className="animate-spin" /> : <Icon />,
      disabled: !currentVersionId || submitting || replacing,
      run: () => {
        if (currentVersionId) void context.reversePrompt(node);
      },
    };
    if (definition.id === 'replace' && !uploadedImageMaterial) action = {
      ...common,
      label: currentVersionId ? `替换 ${node.title}` : `上传到 ${node.title}`,
      text: currentVersionId ? definition.label : '上传图片',
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
      disabled: !currentVersionId || submitting || replacing,
      run: () => {
        if (currentVersionId) context.openMaskEdit(node);
      },
    };
    if (definition.id === 'crop') action = {
      ...common,
      label: `裁剪 ${node.title}`,
      icon: <Icon />,
      disabled: !currentVersionId || replacing,
      run: () => {
        if (currentVersionId) context.openMediaOperation(node, 'crop');
      },
    };
    if (definition.id === 'split') action = {
      ...common,
      label: `切分 ${node.title}`,
      icon: <Icon />,
      disabled: !currentVersionId || replacing,
      run: () => {
        if (currentVersionId) context.openMediaOperation(node, 'split');
      },
    };
    if (definition.id === 'upscale') action = {
      ...common,
      label: `本地放大 ${node.title}`,
      icon: <Icon />,
      disabled: !currentVersionId || replacing,
      run: () => {
        if (currentVersionId) context.openMediaOperation(node, 'upscale');
      },
    };
    if (definition.id === 'angle') action = {
      ...common,
      label: `多角度 ${node.title}`,
      icon: <Icon />,
      disabled: !currentVersionId || submitting || replacing,
      run: () => {
        if (currentVersionId) context.openAngle(node);
      },
    };
    return action ? [action] : [];
  });

  function updateSettingsOpen(open: boolean) {
    setSettingsOpen(open);
    onOverlayOpenChange(open);
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
          onClick={action.run}
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
    ? imageControlCaps(
        draft.model,
        selectedKey?.provider,
        selectedModel?.protocol,
        selectedKey?.base_url,
      )
    : null;
  // 两层都要 memo：canvasVideoEditCaps 每次调用都返回新对象，展开一层又造一个新对象。
  // 下面那条纠偏 effect 依赖 videoCaps，不 memo 的话它每一次 render 都重跑，而它会 commit
  // 首尾帧连接。selectedModel 取自 context.keys 里的元素，引用本身是稳的。
  const rawVideoCaps = useMemo(
    () => draft.mode === 'video' && selectedModel
      ? canvasVideoEditCaps(draft.model, selectedModel.protocol)
      : null,
    [draft.mode, draft.model, selectedModel],
  );
  const videoCaps = useMemo(
    () => rawVideoCaps && editingExistingVideo
      ? { ...rawVideoCaps, modes: rawVideoCaps.modes.filter(mode => mode === 'omni') }
      : rawVideoCaps,
    [editingExistingVideo, rawVideoCaps],
  );
  const videoMode = videoCaps?.modes.includes('omni')
    && (editingExistingVideo || draft.params.frame_mode === 'auto')
    ? 'omni'
    : videoCaps?.modes[0] ?? 'firstlast';
  const usesVideoFrameSlots = draft.mode === 'video' && videoMode === 'firstlast';
  const selectedVideoReferenceLimits = videoCaps
    ? videoReferenceLimits(videoCaps, videoMode)
    : null;
  const videoFrames = context.videoFrameNodeIdsByNodeId?.get(node.id)
    ?? EMPTY_VIDEO_FRAME_NODE_IDS;
  const nodeRunState = canvasNodeRunState(node, context.jobsByRunId);
  const activeJob = nodeRunState.job;
  const runId = activeJob?.canvas_run?.run_id;
  const submitting = context.submittingNodeIds.has(node.id);
  const running = nodeRunState.status === 'loading';
  const textMode = draft.mode === 'text';
  const modeLabel = CANVAS_GENERATION_MODE_LABELS[draft.mode];
  const panelLabel = `${modeLabel}设置`;
  const mentionReferences = context.mentionReferencesByNodeId.get(node.id)
    ?? EMPTY_CANVAS_MENTION_REFERENCES;
  const mentionsEnabled = !usesVideoFrameSlots;
  const frameModeHasMentions = usesVideoFrameSlots && canvasMentionMatches(draft.prompt).length > 0;
  const missingMentionIds = mentionsEnabled
    ? missingCanvasMentionIds(draft.prompt, mentionReferences)
    : [];
  const missingVideoFrame = usesVideoFrameSlots && Object.values(videoFrames).some(sourceNodeId => (
    sourceNodeId && !context.materialReferences.some(reference => (
      reference.nodeId === sourceNodeId && reference.kind === 'image'
    ))
  ));
  const connectedMaterialNodeIds = context.connectedMaterialNodeIdsByNodeId.get(node.id)
    ?? EMPTY_CANVAS_NODE_IDS;
  const connectedVideoMediaCounts = context.materialReferences.reduce(
    (counts, reference) => {
      if (!connectedMaterialNodeIds.has(reference.nodeId) || reference.kind === 'text') return counts;
      counts[reference.kind] += 1;
      return counts;
    },
    { image: 0, video: 0, audio: 0 },
  );
  const videoReferenceCapacityExceeded = Boolean(
    draft.mode === 'video'
    && videoMode === 'omni'
    && selectedVideoReferenceLimits
    && (
      connectedVideoMediaCounts.image > selectedVideoReferenceLimits.images
      || connectedVideoMediaCounts.video > selectedVideoReferenceLimits.videos
      || connectedVideoMediaCounts.audio > selectedVideoReferenceLimits.audios
      || (
        selectedVideoReferenceLimits.mixedTotal !== undefined
        && connectedVideoMediaCounts.image
          + connectedVideoMediaCounts.video
          + connectedVideoMediaCounts.audio > selectedVideoReferenceLimits.mixedTotal
      )
    )
  );
  // 服务端在 all_connected 下把所有已连接节点无条件纳入，缺内容就整单 422。首尾帧模式下不带
  // slot 的连线会被服务端整体丢掉，所以那时这些空输入不构成问题。
  const pendingInputs = usesVideoFrameSlots
    ? EMPTY_CANVAS_PENDING_INPUTS
    : context.pendingInputNodesByNodeId?.get(node.id) ?? EMPTY_CANVAS_PENDING_INPUTS;
  const blockingPendingInputs = draft.input_policy === 'all_connected'
    ? pendingInputs
    : pendingInputs.filter(input => (
      canvasMentionMatches(draft.prompt).some(match => match.nodeId === input.nodeId)
    ));
  const referenceProblem = referenceErrorMessage({
    missingMentionCount: missingMentionIds.length,
    frameModeHasMentions,
    missingVideoFrame,
    videoReferenceCapacityExceeded,
    pendingInputTitles: blockingPendingInputs.map(input => input.title),
  });
  // 结构性问题优先，因为补引用也无法让一个没有模型或提示词的请求变得可提交。
  const generateBlock = canvasGenerateBlock({
    mode: draft.mode,
    modelChoiceCount: modelChoices.length,
    keyCount: context.keys.length,
    alias: draft.alias,
    modelSelected: Boolean(selectedModel),
    prompt: draft.prompt,
  });
  const blockedReason = generateBlock?.message ?? referenceProblem;

  useEffect(() => {
    if (!usesVideoFrameSlots || !videoCaps) return;
    if (videoCaps.maxFrames === 0 && (videoFrames.first_frame || videoFrames.last_frame)) {
      context.setVideoFrameConnections?.(node.id, { first_frame: null, last_frame: null });
      return;
    }
    if (videoCaps.maxFrames === 1 && videoFrames.last_frame) {
      context.setVideoFrameConnections?.(node.id, {
        first_frame: videoFrames.first_frame ?? null,
        last_frame: null,
      });
    }
  }, [
    context,
    node.id,
    usesVideoFrameSlots,
    videoCaps,
    videoFrames.first_frame,
    videoFrames.last_frame,
  ]);

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

  function submitGeneration() {
    if (blockedReason) {
      context.reportError?.(blockedReason);
      return;
    }
    if (activeJob && runId) {
      void context.retryRun(node.id, runId);
      return;
    }
    void context.submitRun(node.id);
  }

  return (
    <section
      aria-label={panelLabel}
      data-floating-node-panel="true"
      className={cn(
        'nodrag',
        embedded && 'nowheel',
        embedded ? 'canvas-mobile-generation' : 'overflow-hidden rounded-xl border border-border bg-glass p-3 backdrop-blur-glass shell-glow',
      )}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <div className="mb-1 flex min-w-0 items-center justify-between gap-2 px-1">
        <p className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
          <Sparkles className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="shrink-0">{textMode ? '文本' : `${modeLabel}生成`}</span>
          {!textMode && <span className="truncate text-muted-foreground">· {node.title}</span>}
        </p>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 rounded-full"
            aria-label={`关闭${panelLabel}`}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      {usesVideoFrameSlots && videoCaps ? (
        <CanvasVideoFrameConnections
          node={node}
          materials={context.materialReferences}
          frames={videoFrames}
          maxFrames={videoCaps.maxFrames}
          pickingSlot={context.materialPick?.targetNodeId === node.id
            ? context.materialPick.slot ?? null
            : null}
          onPreview={reference => context.previewContent(
            reference.versionId,
            reference.title,
            reference.nodeId,
          )}
          onBeginPick={(slot, selectableNodeIds) => context.beginMaterialPick?.({
            targetNodeId: node.id,
            slot,
            selectableNodeIds,
          })}
          onChange={frames => context.setVideoFrameConnections?.(
            node.id,
            frames,
          )}
        />
      ) : (
        <CanvasMaterialConnections
          node={node}
          materials={context.materialReferences}
          connectedNodeIds={context.connectedMaterialNodeIdsByNodeId.get(node.id) ?? EMPTY_CANVAS_NODE_IDS}
          limits={draft.mode === 'video' ? selectedVideoReferenceLimits : null}
          picking={context.materialPick?.targetNodeId === node.id
            && context.materialPick.slot === undefined}
          onPreview={reference => context.previewContent(
            reference.versionId,
            reference.title,
            reference.nodeId,
          )}
          onBeginPick={selectableNodeIds => context.beginMaterialPick?.({
            targetNodeId: node.id,
            selectableNodeIds,
          })}
          onConnectedChange={(sourceNodeId, connected) => context.setMaterialConnected(
            sourceNodeId,
            node.id,
            connected,
          )}
        />
      )}
      <CanvasPromptInput
        value={draft.prompt}
        references={mentionReferences}
        mentionsEnabled={mentionsEnabled}
        disabledMentionHint={usesVideoFrameSlots ? '首尾帧模式不使用 @' : undefined}
        onFocus={context.recordHistory}
        onChange={prompt => updateDraft(current => ({
          ...current,
          prompt,
          params: severCreationPromptAssetLink(current.params),
          updated_at: new Date().toISOString(),
        }))}
        onPreviewReference={reference => context.previewContent(
          reference.versionId,
          reference.title,
          reference.nodeId,
        )}
        placeholder={draft.mode === 'video'
          ? usesVideoFrameSlots
            ? '描述镜头运动与画面变化'
            : '描述镜头运动与画面变化，输入 @ 引用已连接内容'
          : draft.mode === 'audio'
            ? '输入需要朗读的文本，输入 @ 引用已连接内容'
            : draft.mode === 'text'
              ? '描述要创作的文案、脚本或内容，输入 @ 引用已连接内容'
              : '描述任何你想要生成的内容，输入 @ 引用已连接内容'}
      />
      {node.type === 'audio' && (
        <CandidateHistory
          nodeId={node.id}
          primaryVersionId={node.data.current_version_id}
          context={context}
          running={Boolean(running)}
          submitting={submitting}
        />
      )}
      <div className="mt-2 flex items-end gap-1.5 rounded-xl border border-border/70 bg-card/55 p-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <CanvasModelPicker
          choices={modelChoices}
          alias={draft.alias ?? null}
          model={draft.model}
          onSelect={({ key, model }) => {
            if (draft.mode === 'video') {
              const nextParams = normalizeCanvasVideoParams(
                model.id,
                model.protocol,
                draft.params,
                editingExistingVideo,
              );
              if (
                nextParams.frame_mode === 'auto'
                && (videoFrames.first_frame || videoFrames.last_frame)
              ) {
                context.setVideoFrameConnections?.(node.id, {
                  first_frame: null,
                  last_frame: null,
                });
              }
            }
            updateDraftWithHistory(current => ({
              ...current,
              alias: key.alias,
              model: model.id,
              params: draft.mode === 'image'
                ? normalizeCanvasImageParams(
                    model.id,
                    key.provider,
                    current.params,
                    model.protocol,
                    key.base_url,
                  )
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
                  context.keys.find(key => key.alias === current.alias)?.base_url,
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
            referenceLimitLabel={mode => videoReferenceLimitLabel(
              videoReferenceLimits(videoCaps, mode),
            )}
            onModeChange={mode => {
              if (mode === 'omni') {
                context.setVideoFrameConnections?.(node.id, {
                  first_frame: null,
                  last_frame: null,
                });
              }
              updateDraftWithHistory(current => ({
                ...current,
                params: { ...current.params, frame_mode: mode === 'omni' ? 'auto' : 'firstlast' },
              }));
            }}
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
        </div>
        {running && activeJob && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={Boolean(activeJob.cancel_requested_at)}
            onClick={() => void context.cancelRun(activeJob.canvas_run!.run_id)}
          >
            {activeJob.cancel_requested_at ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Square aria-hidden="true" />}
            {activeJob.cancel_requested_at ? '正在停止…' : '停止'}
          </Button>
        )}
        {!running && activeJob && runId && (
          <Button
            type="button"
            size="sm"
            className="shrink-0"
            disabled={submitting}
            onClick={submitGeneration}
          >
            {submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
            {submitting ? '提交中…' : '生成'}
          </Button>
        )}
        {!running && !activeJob && (
          <Button
            type="button"
            size="sm"
            className="shrink-0"
            disabled={submitting}
            onClick={submitGeneration}
          >
            {submitting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
            {submitting ? '提交中…' : textMode ? '生成' : '开始生成'}
          </Button>
        )}
      </div>
    </section>
  );
}

function CanvasVideoFrameConnections({
  node,
  materials,
  frames,
  maxFrames,
  pickingSlot,
  onPreview,
  onBeginPick,
  onChange,
}: {
  node: CanvasNode;
  materials: readonly CanvasMaterialReference[];
  frames: Readonly<Partial<Record<CanvasVideoFrameSlot, string>>>;
  maxFrames: 0 | 1 | 2;
  pickingSlot: CanvasVideoFrameSlot | null;
  onPreview: (reference: CanvasMaterialReference) => void;
  onBeginPick: (slot: CanvasVideoFrameSlot, selectableNodeIds: ReadonlySet<string>) => void;
  onChange: (frames: Readonly<Record<CanvasVideoFrameSlot, string | null>>) => void;
}) {
  const images = materials.filter(reference => (
    reference.kind === 'image' && reference.nodeId !== node.id
  ));
  if (maxFrames === 0) return null;
  const current = {
    first_frame: frames.first_frame ?? null,
    last_frame: frames.last_frame ?? null,
  };

  return (
    <div
      role="group"
      aria-label={`${node.title} 首尾帧`}
      className="mb-1 flex min-h-18 items-center gap-2 overflow-visible px-2 py-1"
    >
      <CanvasVideoFrameSlot
        label="首帧"
        selectedNodeId={current.first_frame}
        materials={images}
        picking={pickingSlot === 'first_frame'}
        tilt="left"
        onPreview={onPreview}
        onBeginPick={() => onBeginPick(
          'first_frame',
          new Set(images.map(reference => reference.nodeId)),
        )}
        onSelect={sourceNodeId => onChange({ ...current, first_frame: sourceNodeId })}
      />
      {maxFrames >= 2 && (
        <button
          type="button"
          aria-label="互换首尾帧"
          title="互换首尾帧"
          disabled={!current.first_frame && !current.last_frame}
          className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"
          onClick={() => onChange({
            first_frame: current.last_frame,
            last_frame: current.first_frame,
          })}
        >
          <ArrowLeftRight className="size-4" aria-hidden="true" />
        </button>
      )}
      {maxFrames >= 2 && (
        <CanvasVideoFrameSlot
          label="尾帧"
          selectedNodeId={current.last_frame}
          materials={images}
          picking={pickingSlot === 'last_frame'}
          tilt="right"
          onPreview={onPreview}
          onBeginPick={() => onBeginPick(
            'last_frame',
            new Set(images.map(reference => reference.nodeId)),
          )}
          onSelect={sourceNodeId => onChange({ ...current, last_frame: sourceNodeId })}
        />
      )}
    </div>
  );
}

function CanvasVideoFrameSlot({
  label,
  selectedNodeId,
  materials,
  picking,
  tilt,
  onPreview,
  onBeginPick,
  onSelect,
}: {
  label: string;
  selectedNodeId: string | null;
  materials: readonly CanvasMaterialReference[];
  picking: boolean;
  tilt: 'left' | 'right';
  onPreview: (reference: CanvasMaterialReference) => void;
  onBeginPick: () => void;
  onSelect: (sourceNodeId: string | null) => void;
}) {
  const selected = materials.find(reference => reference.nodeId === selectedNodeId);
  const rotate = tilt === 'left' ? '-rotate-3' : 'rotate-3';
  return (
    <div className={cn('relative size-14 shrink-0', rotate)}>
      <button
        type="button"
        disabled={materials.length === 0}
        aria-label={selected ? `预览${label} ${selected.title}` : `在画布选择${label}`}
        title={selected ? `预览${label}` : `在画布选择${label}`}
        className={cn(
          'grid size-14 place-items-center overflow-hidden rounded-lg border border-dashed bg-secondary/55 text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40',
          picking ? 'border-primary text-foreground' : 'border-border',
        )}
        onClick={() => selected ? onPreview(selected) : onBeginPick()}
      >
        {selected ? (
          <CanvasMaterialPreview reference={selected} />
        ) : (
          <span className="grid gap-0.5 text-center">
            <Plus className="mx-auto size-4" aria-hidden="true" />
            <span className="text-xs">{selectedNodeId ? '失效' : label}</span>
          </span>
        )}
      </button>
      {selectedNodeId && (
        <button
          type="button"
          aria-label={`移除${label}`}
          title={`移除${label}`}
          className="absolute -right-1 -top-1 z-10 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={() => onSelect(null)}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      )}
      {selected && (
        <span className="pointer-events-none absolute inset-x-1 bottom-1 rounded bg-background/80 px-1 text-center text-xs text-foreground">
          {label}
        </span>
      )}
    </div>
  );
}

function CanvasMaterialConnections({
  node,
  materials,
  connectedNodeIds,
  limits,
  picking,
  onPreview,
  onBeginPick,
  onConnectedChange,
}: {
  node: CanvasNode;
  materials: readonly CanvasMaterialReference[];
  connectedNodeIds: ReadonlySet<string>;
  limits?: VideoReferenceLimits | null;
  picking: boolean;
  onPreview: (reference: CanvasMaterialReference) => void;
  onBeginPick: (selectableNodeIds: ReadonlySet<string>) => void;
  onConnectedChange: (sourceNodeId: string, connected: boolean) => void;
}) {
  const choices = materials.filter(reference => reference.nodeId !== node.id);
  const connected = choices.filter(reference => connectedNodeIds.has(reference.nodeId));
  const connectedCounts = connected.reduce<Record<'image' | 'video' | 'audio', number>>(
    (counts, reference) => {
      if (reference.kind !== 'text') counts[reference.kind] += 1;
      return counts;
    },
    { image: 0, video: 0, audio: 0 },
  );
  const [hoveredMaterial, setHoveredMaterial] = useState<CanvasMaterialHoverState | null>(null);
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

  function unavailableReason(reference: CanvasMaterialReference): string | null {
    if (!limits || reference.kind === 'text' || connectedNodeIds.has(reference.nodeId)) return null;
    const mixedCount = connectedCounts.image + connectedCounts.video + connectedCounts.audio;
    if (limits.mixedTotal && mixedCount >= limits.mixedTotal) {
      return `混合参考素材最多 ${limits.mixedTotal} 个`;
    }
    const limit = reference.kind === 'image'
      ? limits.images
      : reference.kind === 'video'
        ? limits.videos
        : limits.audios;
    if (limit === 0) return `当前模型不支持参考${mentionKindLabel(reference.kind)}`;
    if (connectedCounts[reference.kind] >= limit) {
      return `最多选择 ${limit} 个${mentionKindLabel(reference.kind)}素材`;
    }
    return null;
  }

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
            <span key={reference.nodeId} className="relative size-12 shrink-0">
              <button
                type="button"
                aria-label={`查看已对接素材 ${reference.title}`}
                aria-describedby={detailVisible ? `canvas-material-detail-${reference.nodeId}` : undefined}
                className="relative grid size-12 place-items-center overflow-hidden rounded-lg border border-border bg-secondary/55 text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
              <button
                type="button"
                aria-label={`取消对接素材 ${reference.title}`}
                className="absolute -right-1 -top-1 z-10 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => onConnectedChange(reference.nodeId, false)}
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          aria-label={`为 ${node.title} 在画布选择素材`}
          title="在画布选择素材"
          disabled={!choices.some(reference => (
            !connectedNodeIds.has(reference.nodeId) && !unavailableReason(reference)
          ))}
          className={cn(
            'grid size-12 shrink-0 place-items-center rounded-lg border bg-secondary/55 text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40',
            picking ? 'border-primary text-foreground' : 'border-border',
          )}
          onClick={() => onBeginPick(new Set(choices.flatMap(reference => (
            !connectedNodeIds.has(reference.nodeId) && !unavailableReason(reference)
              ? [reference.nodeId]
              : []
          ))))}
        >
          <Plus className="size-5" aria-hidden="true" />
        </button>
      </div>
      {hoveredMaterial && <CanvasMaterialHoverDetail {...hoveredMaterial} />}
    </>
  );
}

function CanvasMaterialPreview({ reference }: { reference: CanvasMaterialReference }) {
  const videoFrame = useVideoFrame(
    reference.kind === 'video' ? reference.previewUrl ?? null : null,
    // 素材芯片只在生成面板打开时才挂载，没有创作台那样的「离屏就别解码」的门；
    // 第二个参数是 origin 那边给历史列表做懒加载加的（useVideoFrame(url, enabled)）。
    true,
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
        actionsDisabled={running || submitting}
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
            actionsDisabled={running || submitting}
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
  actionsDisabled,
}: {
  label: string;
  entries: CanvasCandidateEntry[];
  context: CanvasNodeContextValue;
  nodeId: string;
  primaryVersionId: string | null;
  actionsDisabled: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={label}>
      {entries.map(({ candidate }) => {
        const version = context.resolveVersion(candidate.version_id);
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
                ? <MediaPreview kind={version.kind} src={canvasMediaUrl(context.projectId, version.version_id, version.kind === 'image' ? 160 : undefined)} />
                : (
                <div className="grid min-h-20 place-items-center px-2 text-center text-xs text-muted-foreground">
                  {candidate.status === 'pending'
                    ? <LoaderCircle className="animate-spin" aria-label="候选生成中" />
                    : candidate.status === 'canceled'
                      ? canvasNodeRunDisplayError(candidate.error, '已停止')
                      : canvasNodeRunDisplayError(candidate.error, '结果待同步')}
                </div>
                )}
            <span className="absolute left-1.5 top-1.5 rounded bg-background/80 px-1.5 py-0.5 text-xs text-muted-foreground">
              {candidate.index + 1}
            </span>
            {!actionsDisabled && candidate.version_id && candidate.version_id !== primaryVersionId && (
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

export function AddMenuButton({ icon, title, description, onClick }: { icon: React.ReactNode; title: string; description?: string; onClick: () => void }) {
  return <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">{icon}</span><span className="min-w-0"><span className="block text-sm font-medium">{title}</span>{description && <span className="block truncate text-xs text-muted-foreground">{description}</span>}</span></button>;
}

function contentForNode(
  node: CanvasNode,
  resolveVersion: (versionId: string | null | undefined) => CanvasContentVersion | undefined,
) {
  if (!('current_version_id' in node.data)) return undefined;
  return resolveVersion(node.data.current_version_id);
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

export function severCreationPromptAssetLink(params: JobParams): JobParams {
  const next = { ...params };
  delete next.creation_prompt_asset_id;
  delete next.creation_prompt_version_id;
  delete next.creation_prompt_variable_values;
  return next;
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
}: {
  node: Exclude<CanvasContentNode, { type: 'text' }>;
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
