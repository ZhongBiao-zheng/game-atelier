import { Handle, NodeResizer, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react';
import { Check, ClipboardCopy, Crop, Download, Ellipsis, Eye, FileAudio, FileImage, FileUp, FileVideo, Grid2X2, Library, LoaderCircle, Lock, MessageSquare, Orbit, Paintbrush, RotateCcw, ScanText, Sparkles, Square, Trash2, Type, Unlock, ZoomIn } from 'lucide-react';
import { createContext, memo, useCallback, useContext, useEffect, useRef, useState, type Ref } from 'react';

import { canvasDownloadUrl, canvasMediaUrl } from '@/api/canvas';
import { modelModality, type KeyView } from '@/api/keys';
import { Button } from '@/components/ui/button';
import { CanvasImageToolbarPreferencesDialog } from '@/components/canvas/CanvasImageToolbarPreferencesDialog';
import type { CanvasMediaTool } from '@/components/canvas/CanvasMediaOperationDialog';
import { formatCanvasImageInfo } from '@/components/canvas/canvasMediaFormatting';
import { orderedCanvasImageTools } from '@/components/canvas/canvasImageToolbar';
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
  canvasNodeHasCurrentContent,
  canvasNodeProvidesContent,
  canvasVideoEditCaps,
  normalizeCanvasImageParams,
  normalizeCanvasVideoParams,
  supportsCanvasVideoEdit,
} from '@/pages/canvasEditorModel';

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
  canvasUiPreferences: CanvasUiPreferences;
  canvasUiPreferencesError: string | null;
  showImageInfo: boolean;
  libraryBusy: boolean;
  selectNode: (id: string) => void;
  previewContent: (id: string, title: string, nodeId: string) => void;
  selectCandidate: (id: string, versionId: string) => void;
  submitRun: (id: string) => Promise<void>;
  retryRun: (id: string, runId: string, mode: 'original' | 'current', candidateId?: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  updateNode: (id: string, updater: (node: CanvasNode) => CanvasNode) => void;
  renameNode: (id: string, title: string) => void;
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
  openAngle: (node: CanvasContentNode) => void;
  editVideo: (node: CanvasContentNode) => void;
  saveImageToolbarPreferences: (value: CanvasImageToolbarPreferences) => Promise<void>;
  deleteNode: (id: string) => void;
}

export const CanvasNodeContext = createContext<CanvasNodeContextValue | null>(null);

export function CanvasNodeCard({ data, selected }: NodeProps<FlowNode>) {
  const context = useContext(CanvasNodeContext);
  const node = data.domain;
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(node.title);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleTriggerRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const titleExitInProgress = useRef(false);
  const restoreTitleFocus = useRef(false);
  const toolbarHideTimer = useRef<number | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarOffsetXRef = useRef(0);
  const toolbarOverlayOpenRef = useRef(false);
  const [toolbarActive, setToolbarActive] = useState(false);
  const [toolbarOverlayOpen, setToolbarOverlayOpen] = useState(false);
  const [toolbarPosition, setToolbarPosition] = useState(Position.Top);
  const [toolbarOffsetX, setToolbarOffsetX] = useState(0);
  const showToolbar = useCallback(() => {
    if (toolbarHideTimer.current !== null) window.clearTimeout(toolbarHideTimer.current);
    toolbarHideTimer.current = null;
    setToolbarActive(true);
  }, []);
  const scheduleToolbarHide = useCallback(() => {
    if (toolbarHideTimer.current !== null) window.clearTimeout(toolbarHideTimer.current);
    toolbarHideTimer.current = window.setTimeout(() => {
      toolbarHideTimer.current = null;
      if (!toolbarOverlayOpenRef.current) setToolbarActive(false);
    }, 120);
  }, []);
  const updateToolbarOverlayOpen = useCallback((open: boolean) => {
    toolbarOverlayOpenRef.current = open;
    setToolbarOverlayOpen(open);
    if (open) showToolbar();
    else scheduleToolbarHide();
  }, [scheduleToolbarHide, showToolbar]);
  useEffect(() => {
    if (!isEditingTitle) setTitleDraft(node.title);
  }, [isEditingTitle, node.title]);
  useEffect(() => {
    if (!isEditingTitle) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [isEditingTitle]);
  useEffect(() => {
    if (isEditingTitle) return;
    if (restoreTitleFocus.current) titleTriggerRef.current?.focus();
    restoreTitleFocus.current = false;
    titleExitInProgress.current = false;
  }, [isEditingTitle, node.title]);
  useEffect(() => () => {
    if (toolbarHideTimer.current !== null) window.clearTimeout(toolbarHideTimer.current);
  }, []);
  useEffect(() => {
    if (!selected && !toolbarActive && !toolbarOverlayOpen) return;
    const controls = toolbarControls(toolbarRef.current);
    const activeControl = controls.find(control => control === document.activeElement) ?? controls[0];
    updateToolbarTabStops(controls, activeControl);
  });
  useEffect(() => {
    if (!selected && !toolbarActive && !toolbarOverlayOpen) return;
    let frame = 0;
    const updatePlacement = () => {
      const shell = shellRef.current;
      const toolbar = toolbarRef.current;
      const toolbarAnchor = toolbar?.parentElement;
      if (!shell || !toolbar || !toolbarAnchor) return;
      const nodeRect = shell.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const anchorRect = toolbarAnchor.getBoundingClientRect();
      if (!nodeRect.width || !nodeRect.height || !toolbarRect.width || !toolbarRect.height) return;
      const margin = 16;
      const topSpace = nodeRect.top - margin;
      const bottomSpace = window.innerHeight - nodeRect.bottom - margin;
      const nextPosition = topSpace >= toolbarRect.height + 32 || topSpace >= bottomSpace
        ? Position.Top
        : Position.Bottom;
      if (nextPosition !== toolbarPosition) setToolbarPosition(nextPosition);

      const currentOffset = toolbarOffsetXRef.current;
      const baseLeft = anchorRect.left;
      const baseRight = anchorRect.right;
      let nextOffset = 0;
      if (baseLeft < margin) nextOffset = margin - baseLeft;
      if (baseRight + nextOffset > window.innerWidth - margin) {
        nextOffset -= baseRight + nextOffset - (window.innerWidth - margin);
      }
      if (Math.abs(nextOffset - currentOffset) >= 0.5) {
        toolbarOffsetXRef.current = nextOffset;
        setToolbarOffsetX(nextOffset);
      }
    };
    frame = window.requestAnimationFrame(updatePlacement);
    const observer = new MutationObserver(updatePlacement);
    if (toolbarRef.current?.parentElement) {
      observer.observe(toolbarRef.current.parentElement, {
        attributes: true,
        attributeFilter: ['style'],
      });
    }
    window.addEventListener('resize', updatePlacement);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', updatePlacement);
    };
  }, [selected, toolbarActive, toolbarOverlayOpen, toolbarPosition]);
  if (!context) return null;
  const renameNode = context.renameNode;
  const content = contentForNode(node, context.contentVersions);
  const hasCurrentContent = canvasNodeHasCurrentContent(node, context.contentVersions);
  const draft = generationDraft(node);
  const copyablePrompt = copyablePromptForNode(
    node,
    context.jobsByResultNodeId,
  );
  const compactMediaTools = (node.size?.width ?? 320) < 480;
  const replacingMedia = context.mediaReplaceBusyNodeIds.has(node.id);
  const submittingNode = context.submittingNodeIds.has(node.id);
  const nodeRunId = activeRunId(node);
  const nodeJob = nodeRunId ? context.jobsByRunId.get(nodeRunId) : undefined;
  const reversePromptJob = nodeJob && isReversePromptJob(nodeJob) ? nodeJob : undefined;
  const reversePromptRunning = reversePromptJob?.status === 'pending' || reversePromptJob?.status === 'pending_confirm';
  const reversePromptSucceeded = reversePromptJob?.canvas_run?.candidates.some(candidate => candidate.status === 'succeeded') ?? false;

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

  return (
    <div
      ref={shellRef}
      className="canvas-node-shell group relative h-full w-full overflow-visible"
      data-selected={selected ? 'true' : 'false'}
      onPointerEnter={showToolbar}
      onPointerLeave={scheduleToolbarHide}
      onFocusCapture={showToolbar}
      onBlurCapture={scheduleToolbarHide}
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
      <header className="absolute bottom-full left-1 right-1 flex items-center pb-2 text-xs text-muted-foreground">
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
              className="nodrag min-w-0 truncate border-b border-dashed border-transparent text-left text-xs font-medium text-muted-foreground transition-colors hover:border-current hover:text-foreground focus-visible:border-current focus-visible:text-foreground focus-visible:outline-none"
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
      </header>
      <NodeToolbar
        isVisible={selected || toolbarActive || toolbarOverlayOpen}
        position={toolbarPosition}
        align="center"
        offset={32}
        className="nodrag nowheel max-w-[calc(100vw-2rem)]"
      >
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label={`${node.title} 节点工具`}
          data-canvas-node-toolbar={node.id}
          className="flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-border bg-glass p-1 backdrop-blur-glass shell-glow"
          style={{ transform: `translateX(${toolbarOffsetX}px)` }}
          onPointerEnter={showToolbar}
          onPointerLeave={scheduleToolbarHide}
          onFocusCapture={event => {
            showToolbar();
            const focused = (event.target as HTMLElement).closest<HTMLElement>('button, a[href]');
            updateToolbarTabStops(toolbarControls(event.currentTarget), focused);
          }}
          onBlurCapture={scheduleToolbarHide}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onKeyDown={handleToolbarKeyDown}
        >
          {node.type === 'image' && content?.kind === 'image' ? (
            <>
              <ImageNodeToolbar
                node={node}
                compact={compactMediaTools}
                replacing={replacingMedia}
                submitting={submittingNode}
                copyablePrompt={copyablePrompt}
                context={context}
                onOverlayOpenChange={updateToolbarOverlayOpen}
              />
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
            </>
          ) : (
            <CanvasNodeToolbar
              node={node}
              content={content}
              replacing={replacingMedia}
              submitting={submittingNode}
              copyablePrompt={copyablePrompt}
              context={context}
            />
          )}
        </div>
      </NodeToolbar>
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
          {node.type === 'image' && content?.kind === 'image' && context.showImageInfo && (
            <span className="pointer-events-none absolute bottom-3 right-3 z-10 max-w-[calc(100%-1.5rem)] truncate rounded-md border border-border bg-glass px-2 py-1 text-xs font-medium tabular-nums text-foreground backdrop-blur-glass">
              {formatCanvasImageInfo(content)}
            </span>
          )}
          {node.type !== 'text' && !content && (
            <div className="grid min-h-44 place-items-center px-4 text-center text-xs text-muted-foreground">
              {node.type === 'config' ? '生成配置' : node.type === 'group' ? '分组' : '选择节点，填写下方生成设置'}
            </div>
          )}
        </div>
      </article>
      {canvasNodeAcceptsInput(node) && (
        <Handle type="target" position={Position.Left} className="canvas-node-handle" aria-label="连接到此节点">
          <span className="canvas-node-handle-dot" aria-hidden="true" />
        </Handle>
      )}
      {canvasNodeProvidesContent(node) && (
        <Handle
          type="source"
          position={Position.Right}
          isConnectable={hasCurrentContent}
          className={cn('canvas-node-handle', !hasCurrentContent && 'canvas-node-handle-disabled')}
          aria-label={hasCurrentContent ? '从此节点连接' : undefined}
          aria-hidden={!hasCurrentContent}
        >
          <span className="canvas-node-handle-dot" aria-hidden="true" />
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

function CanvasNodeToolbar({
  node,
  content,
  replacing,
  submitting,
  copyablePrompt,
  context,
}: {
  node: CanvasNode;
  content: CanvasContentVersion | undefined;
  replacing: boolean;
  submitting: boolean;
  copyablePrompt: string | null;
  context: CanvasNodeContextValue;
}) {
  const contentNode = isCanvasContentNode(node) ? node : null;
  const mediaNode = contentNode && contentNode.type !== 'text' ? contentNode : null;

  return (
    <>
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
    if (definition.id === 'replace') action = {
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
}: {
  node: CanvasNode;
  draft: CanvasGenerationDraft;
  context: CanvasNodeContextValue;
  embedded?: boolean;
}) {
  const editingExistingVideo = draft.mode === 'video'
    && node.type === 'video'
    && Boolean(node.data.current_version_id);
  const acceptsModel = (model: KeyView['models'][number], key: KeyView) => (
    modelModality(model, key) === draft.mode
    && (!editingExistingVideo || supportsCanvasVideoEdit(model.id, model.protocol))
  );
  const availableKeys = context.keys.filter(key => key.models.some(model => acceptsModel(model, key)));
  const selectedKey = context.keys.find(key => key.alias === draft.alias);
  const models = (selectedKey?.models ?? []).filter(model => acceptsModel(model, selectedKey!));
  const selectedModel = models.find(model => model.id === draft.model);
  const imageCaps = draft.mode === 'image' ? imageControlCaps(draft.model, selectedKey?.provider) : null;
  const rawVideoCaps = draft.mode === 'video'
    ? canvasVideoEditCaps(draft.model, selectedModel?.protocol)
    : null;
  const videoCaps = rawVideoCaps && editingExistingVideo
    ? { ...rawVideoCaps, modes: rawVideoCaps.modes.filter(mode => mode === 'omni') }
    : rawVideoCaps;
  const videoMode = videoCaps?.modes.includes('omni')
    && (editingExistingVideo || draft.params.frame_mode === 'auto')
    ? 'omni'
    : videoCaps?.modes[0] ?? 'firstlast';
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
            const selected = key?.models.find(item => acceptsModel(item, key));
            const model = selected?.id ?? '';
            updateDraft(current => ({
              ...current,
              alias: event.target.value || null,
              model,
              params: draft.mode === 'image'
                ? normalizeCanvasImageParams(model, key?.provider, current.params)
                : draft.mode === 'video'
                  ? normalizeCanvasVideoParams(model, selected?.protocol, current.params, editingExistingVideo)
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
              : draft.mode === 'video'
                ? normalizeCanvasVideoParams(
                    event.target.value,
                    models.find(model => model.id === event.target.value)?.protocol,
                    current.params,
                    editingExistingVideo,
                  )
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
        {draft.mode === 'image' && (
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
        {draft.mode === 'video' && videoCaps && (
          <VideoControls
            caps={videoCaps}
            mode={videoMode}
            duration={Number(draft.params.duration ?? videoCaps.durations[0] ?? 5)}
            resolution={String(draft.params.resolution ?? videoCaps.resolutions[0] ?? '720p')}
            ratio={String(draft.params.ratio ?? videoCaps.ratios[0] ?? '16:9')}
            quality={draft.params.mode === 'pro' ? 'pro' : 'std'}
            generateAudio={draft.params.generate_audio !== false}
            onModeChange={mode => updateDraft(current => ({
              ...current,
              params: { ...current.params, frame_mode: mode === 'omni' ? 'auto' : 'firstlast' },
              updated_at: new Date().toISOString(),
            }))}
            onDurationChange={duration => updateDraft(current => ({
              ...current,
              params: { ...current.params, duration },
              updated_at: new Date().toISOString(),
            }))}
            onResolutionChange={resolution => updateDraft(current => ({
              ...current,
              params: { ...current.params, resolution },
              updated_at: new Date().toISOString(),
            }))}
            onRatioChange={ratio => updateDraft(current => ({
              ...current,
              params: { ...current.params, ratio },
              updated_at: new Date().toISOString(),
            }))}
            onQualityChange={quality => updateDraft(current => ({
              ...current,
              params: { ...current.params, mode: quality },
              updated_at: new Date().toISOString(),
            }))}
            onGenerateAudioChange={generateAudio => updateDraft(current => ({
              ...current,
              params: { ...current.params, generate_audio: generateAudio },
              updated_at: new Date().toISOString(),
            }))}
          />
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
              disabled={submitting || !draft.prompt.trim() || !draft.alias || !selectedModel}
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
            disabled={submitting || !draft.prompt.trim() || !draft.alias || !selectedModel}
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
  onAngle,
  onEditVideo,
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
  onAngle?: () => void;
  onEditVideo?: () => void;
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
          {content?.kind === 'image' && onAngle && (
            <Button variant="ghost" size="icon" disabled={replaceMediaBusy || reversePromptBusy} aria-label={`多角度 ${node.title}`} onClick={onAngle}><Orbit /></Button>
          )}
          {content?.kind === 'video' && onEditVideo && (
            <Button variant="ghost" size="icon" disabled={replaceMediaBusy || reversePromptBusy} aria-label={`编辑视频 ${node.title}`} onClick={onEditVideo}><MessageSquare /></Button>
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
        maxLength={120}
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
