import { Popover, PopoverAnchor } from '@/components/ui/popover';
import { CanvasSplitGridPopover } from './CanvasSplitGridPopover';
import { AnnotationFullscreen } from './annotation/AnnotationFullscreen';
import { CanvasNodeFlash, isConnectedNodeEntering, playCanvasNodeEntrance } from './canvasNodeAttention';
import { useFadePresence } from './useFadePresence';
import { useAnnotationToolbarSwap } from './annotation/useAnnotationToolbarSwap';
import { SharedGenerationStatus } from './SharedGenerationStatus';
import { PluginNodeBody, type PluginNodeInput } from '@/plugin-host/PluginNodeBody';
import { enabledPlugins, usePlugins } from '@/plugin-host/registry';
import {
  hostNodeType, isHostPluginId, useHostPluginBusy, type HostPluginApi, type HostPluginModule,
} from '@/plugin-host/hostPlugins';
import type { PluginCanvasAction, PluginMediaAction, PluginPackageLock } from '@/schema/plugins';
import { pluginIcon } from '@/components/ui/icons';
import { useAnnotationEditor } from './annotation/useAnnotationEditor';
import { AnnotationToolbar } from './annotation/AnnotationToolbar';
import { AnnotationEditingLayer } from './annotation/AnnotationEditingLayer';
import type { CanvasAnnotationController } from './annotation/useCanvasAnnotation';
import { AnnotationLayer } from './annotation/AnnotationLayer';
import { hasImageSizeSelection, imageSizeError, imageSizeMode } from '@/lib/imageSizeMode';
import { normalizeImagePixelSize } from '@/lib/studioSize';
import { promptVariableError, promptVariableParts, readablePromptVariables } from '@/lib/promptVariables';
import {
  Handle,
  NodeResizer,
  NodeToolbar,
  Position,
  useStore,
  useStoreApi,
  type Node,
  type ReactFlowState,
  type NodeProps,
  type OnResize,
  type OnResizeEnd,
} from '@xyflow/react';
import type { GroupRun } from '@/api/canvasGroupRuns';
import { AddIcon, AiIcon, AudioFileIcon, BrushIcon, ChatIcon, CheckIcon, ChevronRightIcon, CloseIcon, CompareIcon, DeleteIcon, DownloadIcon, EditIcon, ExchangeIcon, ExpandIcon, ExportFileIcon, HelpIcon, HideIcon, ImageFileIcon, LayersIcon, LoadingIcon, LockIcon, MoreIcon, MuteIcon, OutpaintIcon, ParamsIcon, PauseIcon, PlayIcon, ReplaceFileIcon, SaveAssetIcon, ShareIcon, ShowIcon, StopIcon, TextIcon, UnlockIcon, VideoFileIcon, VolumeIcon } from '@/components/ui/icons';
import {
  createContext, forwardRef, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo,
  useRef, useState,
  type ComponentType, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref,
  type RefObject,
} from 'react';
import { Reorder } from 'motion/react';
import { Collapse } from '@/components/ui/collapse';
import { animate, clearOnFinish, MOTION_DURATION, MOTION_EASE, MOTION_SPRING, MOTION_STAGGER, MOTION_NODE_PANEL_DELAY, motionAvailable, prefersReducedMotion, shakeOnError, stagger, useAnimateOnChange, type AnimationPlaybackControls } from '@/lib/motion';
import { RevealImage } from '@/components/ui/reveal-image';
import { createPortal } from 'react-dom';
import { Link } from 'wouter';

import {
  canvasDownloadUrl,
  canvasMediaUrl,
  canvasMediaUrlAtWidth,
  canvasThumbnailWidth,
  downloadCanvasLayers,
  type CanvasLayerExportFormat,
} from '@/api/canvas';
import { CanvasGroupFrame } from './CanvasGroupFrame';
import { CanvasAudioPlayer } from './CanvasAudioPlayer';
import { audioCapsOf } from '@/lib/audioCaps';
import { CanvasLayerStackList } from './CanvasLayerStackList';
import { CanvasLayerStackComposite } from './CanvasLayerStackPreview';
import { CanvasImageEditPanel } from './CanvasImageEditPanel';
import { CanvasFinalizationMenu } from './CanvasFinalizationMenu';
import { CanvasCompareSurface } from './CanvasCompareSurface';
import { canvasCompareFrame, canvasCompareSource, type CanvasCompareInputs, type CanvasCompareSource } from './canvasCompare';
import { CanvasImageEditSurface } from './CanvasImageEditSurface';
import type { CanvasMediaOperation, CanvasAnnotationDelivery, CanvasCompareNode, CanvasImageEditNode, CanvasMediaVersion } from '@/schema/canvas';
import type { KeyView } from '@/api/keys';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CanvasImageToolbarPreferencesDialog } from '@/components/canvas/CanvasImageToolbarPreferencesDialog';
import {
  LAYER_MAX_IMAGES_DEFAULT, LAYER_MAX_IMAGES_OPTIONS, layerDecompositionMaxOutputs,
  layerDecompositionModelChoices, supportsLayerMaxImages,
} from '@/components/canvas/canvasLayerDecomposition';
import {
  CanvasAudioSettings,
  CanvasMusicSettings,
  CanvasImageSettings,
  CanvasModelPicker,
  CanvasTextSettings,
  type CanvasModelChoice,
} from '@/components/canvas/CanvasGenerationControls';
import { CanvasPromptInput } from '@/components/canvas/CanvasPromptInput';
import { CanvasTextContentPanel } from '@/components/canvas/CanvasTextContentPanel';
import { defaultTextPanelTab, type CanvasTextRevisionInput } from '@/components/canvas/canvasTextRevision';
import { useTextPreviewWheel } from '@/components/canvas/canvasTextWheel';
import { useScrollFade } from '@/components/ui/scroll-fade';
import { compatibleWorkflowValues, workflowReferenceError } from '@/lib/workflowInputs';
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
import { formatCanvasBytes, formatCanvasImageInfo } from '@/components/canvas/canvasMediaFormatting';
import { useGenerationEstimate } from '@/lib/useGenerationEstimate';
import { localComfyUrl, useComfyStatus } from '@/lib/useComfyStatus';
import { formatGenerationCost } from '@/lib/generationCost';
import { CANVAS_SAVE_ASSET_TEXT, CANVAS_SHARE_TEXT, CANVAS_UPSCALE_TARGETS, IMAGE_TOOLBAR_INLINE_LIMIT, orderedCanvasImageTools } from '@/components/canvas/canvasImageToolbar';
import { isUploadedImageMaterialNode } from '@/components/canvas/canvasNodePanelInteraction';
import { providerForAlias, routeChannel, selectionImageCaps, storedAlias } from '@/lib/modelRoutes';
import { supportsImageQuality } from '@/lib/modelFamily';
import { VideoControls } from '@/components/studio/VideoControls';
import {
  videoReferenceLimitLabel,
  videoReferenceLimits,
  type VideoReferenceLimits,
} from '@/lib/videoControlCaps';
import { cn } from '@/lib/utils';
import { presentCanvasCandidates, type CanvasCandidateEntry } from '@/lib/canvasCandidates';
import { pendingResultStack } from '@/lib/canvasResultStacks';
import { useVideoFrame } from '@/lib/videoFrame';
import {
  canvasMentionMatches,
  labelCanvasMentionReferences,
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
  CanvasLayerStackNode,
  CanvasNode,
  CanvasPluginNode,
  CanvasPoint,
  CanvasSize,
  CanvasUiPreferences,
  CanvasUpscaleTarget,
  CanvasVideoFrameSlot,
} from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import type { JobErrorAction } from '@/lib/errorPresentation';
import {
  type CanvasMediaOperationPlaceholder,
  canvasNodeAcceptsInput,
  CANVAS_COMPARE_SLOTS,
  canvasNodeProvidesOutput,
  CANVAS_GENERATION_MODE_LABELS,
  CANVAS_MAX_NODE_SIZE,
  canvasGenerateBlock,
  canvasGenerationModelSupportsMode,
  canvasAudioFamily,
  canvasVideoEditCaps,
  normalizeCanvasAudioParams,
  normalizeCanvasImageParams,
  normalizeCanvasTextParams,
  normalizeCanvasVideoParams,
  supportsCanvasTextReasoning,
  resolveCanvasGenerationDraft,
  canvasNodeHasHideableContent,
  type CanvasPendingInput,
  canvasUpscaleAutoChoice,
} from '@/pages/canvasEditorModel';
import { isSavableCanvasVersion, isShareableCanvasVersion } from '@/pages/canvasTeamActions';
import { SwapIcon } from '@/components/ui/swap-icon';
import { SwapLabel } from '@/components/ui/swap-label';
import { EditableText } from '@/components/ui/editable-text';
import { Toggle } from '@/components/ui/toggle';
import { Slider } from '@/components/ui/slider';
import { Hint } from '@/components/ui/tooltip';
import { Label } from '@/components/ui/label';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';

export type CanvasFlowNode = Node<{ domain: CanvasNode }, 'canvasNode'>;
/** 本地媒体操作（抠图 / 裁剪 / 切图 / 放大）进行中的占位节点：不在文档里，结果节点落地即撤。 */
export type CanvasPlaceholderFlowNode = Node<Pick<CanvasMediaOperationPlaceholder, 'label' | 'leaving' | 'preview'>, 'canvasPlaceholder'>;
export type FlowNode = CanvasFlowNode | CanvasPlaceholderFlowNode;

export interface CanvasGenerationPanelContextValue {
  dismissedNodeId: string | null;
  narrowViewport: boolean;
  dismiss: (id: string) => void;
  /** 面板 portal 的落点（画布区域，position:relative）。缺省时退回 body + fixed 定位。 */
  surfaceRef?: RefObject<HTMLElement | null>;
}

export interface CanvasNodeContextValue {
  groupRuns?: ReadonlyMap<string, GroupRun>;
  groupSteps?: ReadonlyMap<string, GroupRun['steps'][number]>;
  refreshGroupRuns?: () => Promise<void>;
  projectCategories?: readonly string[];
  resolveFinalCategory?: (sha256: string) => string | null;
  finalizationRevision?: string;
  finalizeNode?: (node: CanvasContentNode, category: string | null) => Promise<void>;
  saveCategories?: (categories: string[]) => Promise<void>;
  annotationController?: CanvasAnnotationController;
  editWithAnnotation?: (id: string) => Promise<void>;
  projectId: string;
  layerParentByNodeId?: ReadonlyMap<string, { nodeId: string; title: string }>;
  /** 局部修改 / 扩图结果节点 → 产生它的编辑节点。 */
  editSourceByResultNodeId?: ReadonlyMap<string, CanvasImageEditNode>;
  locateNode?: (id: string) => void;
  focusVariableNodeId?: string | null;
  consumeVariableFocus?: () => void;
  materialReferences: readonly CanvasMaterialReference[];
  connectedMaterialNodeIdsByNodeId: ReadonlyMap<string, ReadonlySet<string>>;
  videoFrameNodeIdsByNodeId?: ReadonlyMap<string, Readonly<Partial<Record<CanvasVideoFrameSlot, string>>>>;
  pendingInputNodesByNodeId?: ReadonlyMap<string, readonly CanvasPendingInput[]>;
  mentionReferencesByNodeId: ReadonlyMap<string, readonly CanvasMentionReference[]>;
  /** 按 version_id 取内容。常量引用，不随版本表变化——原因见 CanvasEditor 里的说明。 */
  resolveVersion: (versionId: string | null | undefined) => CanvasContentVersion | undefined;
  /** 按 id 取当前文档里的节点。常量引用，同 resolveVersion。 */
  findNode?: (id: string) => CanvasNode | undefined;
  /** 当前文档里的全部节点。常量引用。 */
  listNodes?: () => readonly CanvasNode[];
  /** 已启用且已加载的宿主插件（ADR-0039）与交给它们的画布能力。插件关闭时不在表里。 */
  hostPlugins?: ReadonlyMap<string, HostPluginModule>;
  hostPluginApi?: HostPluginApi;
  keys: KeyView[];
  /** 生成节点选模型用：「自动」+ 真实 KEY。缺省时只有真实 KEY。 */
  generationProviders?: KeyView[];
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
  setAnnotationDelivery?: (sourceNodeId: string, targetNodeId: string, delivery: CanvasAnnotationDelivery) => void;
  reorderMaterialConnections?: (targetNodeId: string, orderedSourceIds: readonly string[]) => void;
  setVideoFrameConnections?: (
    targetNodeId: string,
    frames: Readonly<Record<CanvasVideoFrameSlot, string | null>>,
  ) => void;
  /** 生成提交在前端排队中的节点（前一个提交落地后自动提交）。 */
  queuedNodeIds?: ReadonlySet<string>;
  /** 节点失败态上的修复动作（按 error_code：更新密钥、更换模型、重试…）。 */
  runFailureAction?: (job: Job, action: JobErrorAction) => void;
  /** 本机能不能抠图（进画布时预取）；false 时工具条和配置候选里都不出现抠图。 */
  mattingAvailable?: boolean;
  /** 删除节点（走撤销栈并给撤销 toast），节点「更多」与右键菜单用。 */
  deleteNodes?: (nodeIds: ReadonlySet<string>) => void;
  /** 切换视频生成方式时搬已有连线：全能参考 ↔ 首尾帧槽位。 */
  convertVideoFrameConnections?: (targetNodeId: string, toFrameSlots: boolean, maxFrames: number) => void;
  selectNode: (id: string) => void;
  previewContent: (id: string, title: string, nodeId: string) => void;
  previewLayerStack: (nodeId: string) => void;
  selectCandidate: (id: string, versionId: string) => void;
  /** 结果组：成员 id → 封面 id。 */
  resultStackOwnerById?: ReadonlyMap<string, string>;
  /** 展开中的结果组（封面 id）。 */
  expandedResultStackIds?: ReadonlySet<string>;
  toggleResultStack?: (coverId: string) => void;
  /** 结果组刚展开时，成员挂载取一次自己的入场参数（从封面方向抽出）；平移回视口等其他挂载拿到 null。 */
  consumeResultStackEntrance?: (memberId: string) => CanvasStackMemberMotion | null;
  /** 节点上的图片某个版本已经解码并盖住旧版：编辑器据此放开按新比例改尺寸。 */
  reportMediaRevealed?: (nodeId: string, versionId: string) => void;
  /** 封面与该成员交换图片，连线跟着图片走。 */
  setResultStackCover?: (coverId: string, memberId: string) => void;
  reportError?: (message: string) => void;
  submitRun: (id: string) => Promise<unknown>;
  cancelRun: (runId: string) => Promise<void>;
  resumeMjEdit?: (runId: string) => Promise<void>;
  dismissCandidate: (runId: string, candidateId: string) => Promise<void>;
  updateNode: (id: string, updater: (node: CanvasNode) => CanvasNode) => void;
  previewNodeResize?: (id: string, layout: { position: CanvasPoint; size: CanvasSize }) => void;
  completeNodeResize?: (id: string, layout: { position: CanvasPoint; size: CanvasSize }) => void;
  renameNode: (id: string, title: string) => void;
  updateText: (id: string, text: string) => void;
  setTextEditing?: (id: string, editing: boolean) => void;
  createImageFromSource?: (id: string) => void;
  recordHistory: () => void;
  saveAsset: (node: CanvasContentNode) => Promise<void>;
  /** 分享生成结果到团队库；不传就不显示「分享」。 */
  shareResult?: (node: CanvasContentNode) => void;
  copyPrompt: (node: CanvasContentNode) => Promise<void>;
  reversePrompt: (node: CanvasContentNode) => Promise<void>;
  /** 文本节点「改写」：以当前正文为输入，结果写回本节点。 */
  submitTextRevision?: (nodeId: string, request: CanvasTextRevisionInput) => Promise<void>;
  createLayerDecomposition: (node: Extract<CanvasContentNode, { type: 'image' }>) => void;
  submitLayerDecomposition: (nodeId: string) => Promise<void>;
  /** 已完成的拆分节点改提示词重拆：新建一个拆分节点并提交。 */
  rerunLayerDecomposition?: (nodeId: string, settings: { alias: string; model: string; prompt: string; max_images?: number | null }) => Promise<void>;
  replaceLayerStackSource: (nodeId: string) => void;
  expandLayerStack: (nodeId: string) => void;
  recoverReversePromptConfig: (job: Job) => Promise<void>;
  reversePromptConfiguredNodeIds: ReadonlySet<string>;
  replaceMedia: (node: CanvasContentNode) => void;
  toggleFreeResize: (node: CanvasContentNode) => void;
  splitImage: (node: CanvasContentNode, operation: Extract<CanvasMediaOperation, { kind: 'split' }>) => void;
  openMediaOperation: (node: CanvasContentNode, tool: CanvasMediaTool) => void;
  removeBackground: (node: CanvasContentNode) => void;
  openMaskEdit: (node: CanvasContentNode, mode?: 'inpaint' | 'outpaint') => void;
  openImageEdit?: (nodeId: string) => void;
  submitImageEdit?: (nodeId: string) => Promise<boolean>;
  openAngle: (node: CanvasContentNode) => void;
  upscaleImage: (node: CanvasContentNode, target: CanvasUpscaleTarget) => void;
  createCompareNode?: (node: CanvasContentNode, source: CanvasCompareSource) => void;
  /** 图片工具栏里的插件动作：在图片旁建插件节点并连线。 */
  /** 插件在图片 / 视频工具栏「更多」里声明的动作：在素材右侧建插件节点并从素材连线。 */
  createPluginNodeFromMedia?: (node: CanvasContentNode, plugin: PluginPackageLock, action: PluginMediaAction) => void;
  /** 插件节点 → 当前连到它的输入。按图签名重算，引用稳定。 */
  pluginInputsByNodeId?: ReadonlyMap<string, readonly PluginNodeInput[]>;
  /** 把页面上还没保存的编辑落盘（插件调服务端之前用）。 */
  savePendingEdits?: () => Promise<void>;
  /** 对比节点 → before / after 两侧当前接入的图。按图签名重算，引用稳定。 */
  compareInputsByNodeId?: ReadonlyMap<string, CanvasCompareInputs>;
  swapCompareInputs?: (nodeId: string) => void;
  openCompare?: (nodeId: string) => void;
  editVideo: (node: CanvasContentNode) => void;
  saveImageToolbarPreferences: (value: CanvasImageToolbarPreferences) => Promise<void>;
  deleteNode: (id: string) => void;
}

export const CanvasNodeContext = createContext<CanvasNodeContextValue | null>(null);
const EMPTY_CANVAS_NODE_IDS: ReadonlySet<string> = new Set();
/** 连接点圆点：拖线吸附到有效接口（xyflow 给接口加 connectingto + valid）时放大到 125%，150ms。 */
const CANVAS_HANDLE_DOT_CLASS = 'canvas-node-handle-dot transition-[border-color,scale] duration-150 motion-safe:in-[.connectingto.valid]:scale-110';
const EMPTY_PLUGIN_INPUTS: readonly PluginNodeInput[] = [];
const EMPTY_HOST_PLUGINS: ReadonlyMap<string, HostPluginModule> = new Map();
const EMPTY_VIDEO_FRAME_NODE_IDS: Readonly<Partial<Record<CanvasVideoFrameSlot, string>>> = {};
const EMPTY_CANVAS_PENDING_INPUTS: readonly CanvasPendingInput[] = [];
const EMPTY_CANVAS_MENTION_REFERENCES: readonly CanvasMentionReference[] = [];

export function CanvasPlaceholderCard({ data }: NodeProps<CanvasPlaceholderFlowNode>) {
  const ref = useRef<HTMLDivElement>(null);
  const preview = data.preview;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !preview || !motionAvailable()) return;
    const reduced = prefersReducedMotion();
    const controls = clearOnFinish(animate(element, reduced ? { opacity: [0, 1] } : { opacity: [0, 1], scale: [0.94, 1] }, {
      duration: MOTION_DURATION.fast, delay: reduced ? 0 : preview.delay, ease: MOTION_EASE.out,
    }), element);
    return () => controls.stop();
  }, [preview]);
  return (
    <div
      className={cn('relative h-full transition-opacity duration-200', preview && 'rounded-lg border border-border bg-card', data.leaving && 'pointer-events-none opacity-0')}
      data-canvas-placeholder="true"
    >
      {!preview && <header className="absolute bottom-full left-0 right-0 flex items-center pb-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <ImageFileIcon size="sm" className="shrink-0" />
          <span className="min-w-0 truncate font-medium text-foreground">图片</span>
        </span>
        <span className="ml-2 flex shrink-0 items-center gap-1 text-xs font-medium text-[color:var(--status-running)]">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
          {data.label}
        </span>
      </header>}
      {preview ? <div ref={ref} role="img" aria-label={data.label} className="media-checker relative h-full overflow-hidden rounded-lg">
        <img alt="" draggable={false} src={preview.url} className="pointer-events-none absolute max-w-none" style={{
          width: `${100 / preview.width}%`, height: `${100 / preview.height}%`,
          left: `${-100 * preview.x / preview.width}%`, top: `${-100 * preview.y / preview.height}%`,
        }} />
      </div> : <article
        role="status"
        aria-busy="true"
        aria-label={`图片，${data.label}`}
        className="relative flex h-full flex-col items-center justify-center gap-3 overflow-hidden rounded-lg border border-border bg-card/95 px-5 text-center text-xs text-[color:var(--status-running)]"
      >
        <span data-canvas-generation-indicator="true" className="canvas-generation-indicator size-12" aria-hidden="true">
          <LoadingIcon size="lg" />
        </span>
        <span>{data.label}</span>
      </article>}
      <Handle type="target" position={Position.Left} className="canvas-node-handle" isConnectable={false} aria-label="处理中的节点">
        <span className={CANVAS_HANDLE_DOT_CLASS} aria-hidden="true" />
      </Handle>
    </div>
  );
}

export function CanvasNodeCard({ data, selected, dragging = false }: NodeProps<CanvasFlowNode>) {
  const context = useContext(CanvasNodeContext);
  const setTextEditing = context?.setTextEditing;
  const node = data.domain;
  const [isEditingInlineText, setIsEditingInlineText] = useState(false);
  // 双击节点 / 工具条「编辑」：把光标交给面板「内容」页的正文。
  const [textFocusRequest, setTextFocusRequest] = useState(0);
  const textScrollFadeRef = useScrollFade<HTMLDivElement>();
  const textWheelRef = useTextPreviewWheel<HTMLDivElement>();
  const textPreviewRef = useCallback((element: HTMLDivElement | null) => {
    textScrollFadeRef(element);
    textWheelRef(element);
  }, [textScrollFadeRef, textWheelRef]);
  const contentSurfaceRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarOverlayOpen, setToolbarOverlayOpen] = useState(false);
  const [candidateBatchExpanded, setCandidateBatchExpanded] = useState(false);
  const pickTooltipRef = useRef<HTMLSpanElement>(null);
  const [materialPickPointer, setMaterialPickPointer] = useState<{ left: number; top: number } | null>(null);
  const draftKeys = context?.keys;
  const textPreference = context?.canvasUiPreferences.generation_defaults.text;
  const draft = useMemo(() => draftKeys
    ? resolveCanvasGenerationDraft(node, draftKeys, textPreference)
    : null, [node, draftKeys, textPreference]);
  const nodeContent = context ? contentForNode(node, context.resolveVersion) : undefined;
  const uploadedImageMaterial = Boolean(
    context && isUploadedImageMaterialNode(node, nodeContent),
  );
  const nodePanelAllowed = Boolean(
    context
    && !context.annotationController?.nodeId
    && selected
    && !context.multiSelectionActive
    && !context.generationPanel.narrowViewport
    && context.generationPanel.dismissedNodeId !== node.id
    // 结果组成员是这次生成的产物，不作为生成面板；要再生成就在封面上生成。
    && !context.resultStackOwnerById?.has(node.id),
  );
  const editSource = context?.editSourceByResultNodeId?.get(node.id);
  const editPanelVisible = nodePanelAllowed && Boolean(editSource);
  const generationPanelVisible = nodePanelAllowed && !editSource && Boolean(draft) && !uploadedImageMaterial;
  // 已完成的拆分节点：单击左侧图片区才弹重拆面板，取消选中即收起。
  const [layerComposerOpen, setLayerComposerOpen] = useState(false);
  useEffect(() => {
    if (!selected) setLayerComposerOpen(false);
  }, [selected]);
  const layerComposerVisible = nodePanelAllowed && layerComposerOpen
    && node.type === 'layer_stack' && Boolean(node.data.base_version_id);
  // 浮动面板进场由面板自己播；退场在这里留 150ms 淡出再卸载，与节点工具条同一节奏。
  const generationPanelPresence = useFadePresence(generationPanelVisible && Boolean(draft));
  const editPanelPresence = useFadePresence(editPanelVisible && Boolean(editSource));
  const layerComposerPresence = useFadePresence(layerComposerVisible);
  // 生成面板落在节点上方时会盖住标题栏与工具栏（含「上传附件」），这两样翻到节点下方去。
  const materialPickEligible = Boolean(context?.materialPick?.selectableNodeIds.has(node.id));
  const groupStep = context?.groupSteps?.get(node.id);
  const groupRun = groupStep ? [...(context?.groupRuns?.values() ?? [])].find(run => run.steps.includes(groupStep)) : undefined;
  // 整组执行里还没轮到的成员：按 run.steps 的顺序排队（已提交的那个由自己的生成徽章表示）。
  const groupQueue = groupRun?.status === 'running' ? groupRun.steps.filter(step => step.status === 'pending' && !step.job_id) : [];
  const groupQueuePosition = groupStep ? groupQueue.indexOf(groupStep) + 1 : 0;
  const groupHeader = useRef<HTMLElement>(null);
  useAnimateOnChange(groupStep?.status, status => { if (status === 'failed') shakeOnError(groupHeader.current); });
  const [shellElement, setShellElement] = useState<HTMLDivElement | null>(null);
  useEffect(() => () => setTextEditing?.(node.id, false), [node.id, setTextEditing]);
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

  // 视频与音频出了新结果（版本变化）时淡入；首次挂载与平移回视口重新挂载都不播。
  // 图片不走这里：CanvasCrossfadeImage 让旧图垫底，新图解码完再淡入。
  useAnimateOnChange(nodeContent?.kind === 'image' ? null : nodeContent?.version_id ?? null, versionId => {
    const media = versionId ? contentSurfaceRef.current?.querySelector('[data-canvas-media]') : null;
    if (!media) return;
    clearOnFinish(animate(media, { opacity: [0, 1], scale: [0.985, 1] }, { duration: MOTION_DURATION.slow, ease: MOTION_EASE.out }), media);
  });
  // 屏上已经画出来的图片版本：生成中的遮罩要撑到新图盖上来才撤，尺寸也等它一起变（见 reportMediaRevealed）。
  const [revealedVersionId, setRevealedVersionId] = useState<string | null>(null);
  const reportMediaRevealed = context?.reportMediaRevealed;
  const revealImageVersion = useCallback((versionId: string) => {
    setRevealedVersionId(versionId);
    reportMediaRevealed?.(node.id, versionId);
  }, [node.id, reportMediaRevealed]);
  // 结果组展开：成员从封面方向抽出来。只动内层外壳，不碰 xyflow 外层的定位 transform。
  const consumeResultStackEntrance = context?.consumeResultStackEntrance;
  useLayoutEffect(() => {
    const entrance = shellElement ? consumeResultStackEntrance?.(node.id) : null;
    if (!entrance || !shellElement) return;
    playStackMemberEntrance(shellElement, [entrance]);
  }, [consumeResultStackEntrance, node.id, shellElement]);
  // 新建节点（添加、上传、Agent 新放上来的、媒体处理结果）：外壳从略小处淡入，只挂载那一次。
  useLayoutEffect(() => {
    if (shellElement) playCanvasNodeEntrance(node.id, shellElement);
  }, [node.id, shellElement]);

  const annotating = context?.annotationController?.nodeId === node.id;
  const annotationToolbar = useAnnotationToolbarSwap(annotating);
  // 选中节点的工具条进出场各 150ms 淡变；xyflow 的 NodeToolbar 自己决定挂不挂，这里延迟卸载让淡出播完。
  const toolbarPresence = useFadePresence(Boolean(context)
    && !context?.multiSelectionActive && !(annotating && context?.annotationController?.fullscreen)
    && Boolean(selected || toolbarOverlayOpen));
  const annotation = node.type === 'image' && node.data.annotation?.version_id === node.data.current_version_id ? node.data.annotation : null;
  const annotationEditor = useAnnotationEditor({
    enabled: annotating, elements: annotation?.elements ?? [],
    width: nodeContent?.kind === 'image' ? nodeContent.width ?? 1024 : 1024,
    height: nodeContent?.kind === 'image' ? nodeContent.height ?? 1024 : 1024,
    onCommit: elements => context?.annotationController?.write(node.id, elements),
    onExit: () => context?.annotationController?.exit(),
    undo: () => context?.annotationController?.undo(), redo: () => context?.annotationController?.redo(),
    onError: message => context?.reportError?.(message),
  });
  if (!context) return null;
  if (node.type === 'group') return <CanvasGroupFrame node={node} context={context} selected={Boolean(selected)} />;
  const renameNode = context.renameNode;
  const content = nodeContent;
  // 拆分图层节点没有单一 content：尺寸取底图，大小是底图 + 全部图层文件之和。
  const layerStackInfo = (() => {
    if (node.type !== 'layer_stack') return null;
    const base = context.resolveVersion(node.data.base_version_id);
    if (base?.kind !== 'image' || !base.width || !base.height) return null;
    const bytes = node.data.layers.reduce((total, layer) => {
      const version = context.resolveVersion(layer.version_id);
      return total + (version?.kind === 'image' ? version.bytes : 0);
    }, base.bytes);
    return `${base.width} × ${base.height} · ${formatCanvasBytes(bytes)}`;
  })();
  const replacingMedia = context.mediaReplaceBusyNodeIds.has(node.id);
  const submittingNode = context.submittingNodeIds.has(node.id);
  const nodeRunState = canvasNodeRunState(node, context.jobsByRunId, context.jobsByResultNodeId);
  const nodeJob = nodeRunState.job;
  const emptyMediaNode = node.type !== 'text' && isCanvasContentNode(node) && !content
    ? node
    : null;
  const reversePromptJob = nodeJob && isReversePromptJob(nodeJob) ? nodeJob : undefined;
  const reversePromptSucceeded = reversePromptJob?.canvas_run?.candidates.some(candidate => candidate.status === 'succeeded') ?? false;
  const candidatePresentation = node.type === 'image'
    ? presentCanvasCandidates(context.jobsByResultNodeId.get(node.id) ?? [])
    : null;
  const groupOutput = Boolean(nodeJob?.canvas_run?.snapshot?.normalized_params?.group_run);
  const mediaCandidates = groupOutput ? [] : candidatePresentation?.current ?? [];
  const stackCoverId = context.resultStackOwnerById?.get(node.id) ?? null;
  const nodeRunning = submittingNode || nodeRunState.status === 'loading';
  // 结果组的总张数：已拆成节点的按成员数，最近一次生成还没拆的按这一批成功的张数。
  const resultStackTotal = (() => {
    if (node.type !== 'image' || nodeRunning) return 0;
    const pending = pendingResultStack(node, context.jobsByResultNodeId.get(node.id));
    const members = pending
      ? pending.versionIds.length
      : [...(context.resultStackOwnerById ?? new Map<string, string>()).values()].filter(id => id === node.id).length;
    return members ? members + 1 : 0;
  })();
  // 已隐藏的节点照样给出「显示」。
  const compareInputs = node.type === 'compare' ? context.compareInputsByNodeId?.get(node.id) : undefined;
  const hasHideableContent = canvasNodeHasHideableContent(node, content, Boolean(compareInputs?.before || compareInputs?.after));

  // 正文只在面板「内容」页里编辑：节点卡只做预览，长文在小框里读写不便（2026-11-27 试用反馈）。
  function beginTextEditing() {
    if (!context || node.type !== 'text') return;
    context.selectNode(node.id);
    setTextFocusRequest(request => request + 1);
  }

  function toggleHidden() {
    if (!context) return;
    context.recordHistory();
    context.updateNode(node.id, candidate => ({ ...candidate, hidden: !candidate.hidden }));
  }

  // 遮盖内容是固定按钮，排在「更多」之前；图片节点的遮盖、保存与分享收在「更多」里（U2）。
  const fixedToolbarButtons = (
    <>
      {isCanvasContentNode(node) && node.type !== 'image' && isSavableCanvasVersion(content) && (
        <MediaToolButton label={`保存 ${node.title}`} text={CANVAS_SAVE_ASSET_TEXT} onClick={() => void context.saveAsset(node)}>
          <SaveAssetIcon />
        </MediaToolButton>
      )}
      {isCanvasContentNode(node) && node.type !== 'image' && context.shareResult && isShareableCanvasVersion(content) && (
        <MediaToolButton label={`分享 ${node.title}`} text={CANVAS_SHARE_TEXT} onClick={() => context.shareResult?.(node)}>
          <ShareIcon />
        </MediaToolButton>
      )}
      {/* 遮盖后由内容区右上的「显示」按钮恢复，工具条上不再重复一个。 */}
      {hasHideableContent && !node.hidden && <MediaToolButton
        label={`遮盖 ${node.title} 的内容`}
        text="遮盖内容"
        onClick={toggleHidden}
      >
        <HideIcon />
      </MediaToolButton>}
    </>
  );

  return (
    <div
      ref={setShellElement}
      className="canvas-node-shell group relative h-full w-full overflow-visible"
      data-selected={selected ? 'true' : 'false'}
      onPointerMove={showHandleOnHoveredSide}
      onPointerLeave={hideHoverHandles}
    >
      <CanvasNodeFlash nodeId={node.id} />
      <NodeResizer
        isVisible={selected && !stackCoverId && !annotating && !context.multiSelectionActive && !replacingMedia}
        keepAspectRatio={(node.type === 'image' && !node.data.display.free_resize) || node.type === 'image_edit'}
        minWidth={node.type === 'text' ? 220 : node.type === 'layer_stack' ? 560 : 240}
        minHeight={node.type === 'text' ? 120 : node.type === 'layer_stack' ? 320 : 150}
        maxWidth={CANVAS_MAX_NODE_SIZE}
        maxHeight={CANVAS_MAX_NODE_SIZE}
        color="var(--primary)"
        handleClassName="canvas-node-resize-handle"
        lineClassName="canvas-node-resize-line"
        onResizeStart={handleResizeStart}
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
      />
      <header ref={groupHeader} className="absolute bottom-full left-0 right-0 flex items-center pb-2 text-xs text-muted-foreground">
        <span
          className="flex min-w-0 flex-1 items-center gap-1.5"
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
        >
          {nodeIcon(node)}
          <EditableText
            value={node.title}
            maxLength={120}
            size="sm"
            triggerLabel={`重命名节点 ${node.title}`}
            className="nodrag min-w-0 font-medium text-foreground"
            onSave={title => renameNode(node.id, title)}
          />
        </span>
        {context.layerParentByNodeId?.get(node.id) && (
          <Hint label={context.layerParentByNodeId.get(node.id)!.title}><Button variant="bare"
            type="button"
            className="nodrag ml-2 flex shrink-0 items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={`定位父图层：${context.layerParentByNodeId.get(node.id)!.title}`}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation();
              context.locateNode?.(context.layerParentByNodeId!.get(node.id)!.nodeId);
            }}
          ><LayersIcon size="sm" aria-hidden="true" />父图层</Button></Hint>
        )}
        {layerStackInfo && (
          <span className="ml-2 shrink-0 truncate tabular-nums" aria-label={`图层栈尺寸 ${layerStackInfo}`}>
            {layerStackInfo}
          </span>
        )}
        {groupStep?.status !== 'done' && <CanvasNodeRunBadge state={nodeRunState} />}
        {groupQueuePosition > 0 && <span className="content-swap-in ml-2 shrink-0 rounded-full bg-secondary px-1.5 text-xs tabular-nums text-muted-foreground">排队第 {groupQueuePosition} 位</span>}
        {groupStep?.status === 'done' && <CheckIcon size="sm" role="img" aria-label="整体执行已完成"
          className={cn(groupRun?.status === 'done' ? 'group-run-finished' : 'content-swap-in', 'ml-1 text-status-done')} />}
      </header>
      <NodeToolbar
        isVisible={toolbarPresence.mounted}
        position={annotationToolbar.annotating ? Position.Bottom : Position.Top}
        align="center"
        offset={annotationToolbar.annotating ? 12 : 32}
        data-phase={toolbarPresence.phase}
        className={cn('nodrag canvas-toolbar-presence', annotationToolbar.className)}
      >
        {annotationToolbar.annotating && context.annotationController ? <CanvasAnnotationToolbarBounds nodeId={node.id}><AnnotationToolbar editor={annotationEditor}
          undo={context.annotationController.undo} redo={context.annotationController.redo}
          canUndo={context.annotationController.canUndo} canRedo={context.annotationController.canRedo}
          onExpand={context.annotationController.expand}
          onEdit={context.editWithAnnotation ? () => void context.editWithAnnotation?.(node.id) : undefined} busy={submittingNode} /></CanvasAnnotationToolbarBounds> : <div
          ref={toolbarRef}
          role="toolbar"
          aria-label={`${node.title} 节点工具`}
          data-canvas-node-toolbar={node.id}
          className={cn(
            'flex items-center gap-1 rounded-xl border border-border bg-glass p-1 backdrop-blur-glass shell-glow',
            canvasDragChromeClass(dragging, 'down'),
          )}
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
                ? nodeJob.cancel_requested_at ? '反推提示词停止中…' : '停止反推提示词'
                : nodeJob.cancel_requested_at ? `${node.title} 停止中…` : `停止 ${node.title} 的生成`}
              text="停止"
              disabled={Boolean(nodeJob.cancel_requested_at)}
              onClick={() => void context.cancelRun(nodeJob.canvas_run!.run_id)}
            >
              <SwapIcon swapKey={Boolean(nodeJob.cancel_requested_at)}>{nodeJob.cancel_requested_at ? <LoadingIcon /> : <StopIcon />}</SwapIcon>
            </MediaToolButton>
          )}
          {node.type !== 'image_edit' && nodeJob?.status === 'failed' && Boolean(nodeJob.params.evolink_state?.poll_paused) && nodeJob.canvas_run && (
            <MediaToolButton label="继续查询 MJ 原任务（不重新下单）" text="继续查询" onClick={() => void context.resumeMjEdit?.(nodeJob.canvas_run!.run_id)}><ShowIcon /></MediaToolButton>
          )}
          {emptyMediaNode ? (
            <MediaToolButton
              label={`上传${CANVAS_GENERATION_MODE_LABELS[emptyMediaNode.type]}`}
              text="上传素材"
              disabled={replacingMedia}
              onClick={() => context.replaceMedia(emptyMediaNode)}
            >
              <SwapIcon swapKey={Boolean(replacingMedia)}>{replacingMedia ? <LoadingIcon className="animate-spin" /> : <ReplaceFileIcon />}</SwapIcon>
            </MediaToolButton>
          ) : node.type === 'image' ? (
              <ImageNodeToolbar
                node={node}
                content={content}
                replacing={replacingMedia}
                // 排队中的节点也禁用提交类工具（AI高清等），不让同一操作重复入队。
                submitting={submittingNode || Boolean(context.queuedNodeIds?.has(node.id))}
                context={context}
                trailing={(
                  <>
                    {reversePromptJob && reversePromptSucceeded && !context.reversePromptConfiguredNodeIds.has(node.id) && (
                      <MediaToolButton
                        label="用反推文本生成图片"
                        text="生成图片"
                        disabled={submittingNode}
                        onClick={() => void context.recoverReversePromptConfig(reversePromptJob)}
                      >
                        <SwapIcon swapKey={Boolean(submittingNode)}>{submittingNode ? <LoadingIcon className="animate-spin" /> : <AiIcon />}</SwapIcon>
                      </MediaToolButton>
                    )}
                  </>
                )}
                onSave={isSavableCanvasVersion(content) ? () => void context.saveAsset(node) : undefined}
                onShare={context.shareResult && isShareableCanvasVersion(content) ? () => context.shareResult?.(node) : undefined}
                onToggleHidden={hasHideableContent || node.hidden ? toggleHidden : undefined}
                onOverlayOpenChange={setToolbarOverlayOpen}
              />
          ) : (
            <CanvasNodeToolbar
              node={node}
              content={content}
              replacing={replacingMedia}
              submitting={submittingNode || nodeRunState.status === 'loading'}
              context={context}
              onEditText={beginTextEditing}
            />
          )}
          {(emptyMediaNode || node.type !== 'image') && fixedToolbarButtons}
          {!emptyMediaNode && node.type === 'video' && content?.kind === 'video' && (
            <PluginVideoActionsMenu node={node} context={context} onOverlayOpenChange={setToolbarOverlayOpen} />
          )}
        </div>}
      </NodeToolbar>
      {context.annotationController && content?.kind === 'image' && <AnnotationFullscreen
        open={annotating && context.annotationController.fullscreen}
        title={node.title} src={canvasMediaUrl(context.projectId, content.version_id)} width={content.width ?? 1024} height={content.height ?? 1024}
        editor={annotationEditor} onCollapse={context.annotationController.collapse}
        undo={context.annotationController.undo} redo={context.annotationController.redo}
        canUndo={context.annotationController.canUndo} canRedo={context.annotationController.canRedo}
        onEdit={context.editWithAnnotation ? () => void context.editWithAnnotation?.(node.id) : undefined} busy={submittingNode} />}
      {node.type === 'image' && resultStackTotal > 1 && (
        <ResultStackChrome
          total={resultStackTotal}
          expanded={Boolean(context.expandedResultStackIds?.has(node.id))}
          onToggle={() => context.toggleResultStack?.(node.id)}
        />
      )}
      {stackCoverId && node.type === 'image' && content?.kind === 'image' && !context.multiSelectionActive && (
        <Hint label="设为封面"><Button variant="ghost" size="icon"
          type="button"
          aria-label={`将 ${node.title} 设为封面`}
          className="nodrag absolute bottom-2 left-2 z-20 size-8 rounded-full border-border bg-glass text-muted-foreground backdrop-blur-glass hover:text-foreground"
          onPointerDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            context.setResultStackCover?.(stackCoverId, node.id);
          }}
        >
          <CheckIcon aria-hidden="true" />
        </Button></Hint>
      )}
      {node.type === 'image' && resultStackTotal === 0 && mediaCandidates.length > 0 && (
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
          'relative h-full overflow-hidden rounded-lg border text-foreground transition-colors',
          node.type === 'image' && content?.kind === 'image' ? 'bg-transparent' : 'bg-card/95',
          // 16px 模糊投影只给选中的节点：几十个节点各带一层大半径阴影，平移缩放时每帧都要重绘。
          selected ? 'border-primary shell-glow' : 'border-border',
          annotating && 'annotation-active',
          context.materialPick && materialPickEligible && 'cursor-copy hover:border-primary focus-visible:border-primary',
          context.materialPick && !materialPickEligible && 'cursor-default',
        )}
        onClick={event => {
          if (!context.materialPick && (event.shiftKey || event.metaKey || event.ctrlKey)) return;
          event.stopPropagation();
          context.selectNode(node.id);
        }}
        onPointerEnter={event => {
          if (materialPickEligible) setMaterialPickPointer({ left: event.clientX + 14, top: event.clientY + 14 });
        }}
        onPointerMove={event => {
          if (pickTooltipRef.current) {
            pickTooltipRef.current.style.transform = `translate3d(${event.clientX + 14}px, ${event.clientY + 14}px, 0)`;
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
          if (isControlDoubleClick(event)) return;
          if (node.type === 'text') {
            if (nodeRunState.status === 'loading') return;
            beginTextEditing();
            return;
          }
          if (node.type === 'layer_stack') return;
          if (node.type === 'compare') context.openCompare?.(node.id);
          else if (node.type === 'image_edit') context.openImageEdit?.(node.id);
          else if (content) context.previewContent(content.version_id, node.title, node.id);
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
            ref={pickTooltipRef}
            className="pointer-events-none fixed left-0 top-0 z-30 max-w-64 truncate rounded-md border border-border bg-glass px-2 py-1 text-xs font-medium text-foreground backdrop-blur-glass shell-glow"
            style={{ transform: `translate3d(${materialPickPointer.left}px, ${materialPickPointer.top}px, 0)` }}
          >
            选择 {node.title}
          </span>,
          document.body,
        )}
        <SharedGenerationStatus run={node.collab_run} />
        {context.mediaReplaceError?.nodeId === node.id && (
          <p
            role="alert"
            className="absolute inset-x-2 top-2 z-20 line-clamp-3 break-words rounded-md border border-destructive/40 bg-card/95 px-2 py-1.5 text-xs leading-relaxed text-destructive"
          >
            {canvasNodeRunDisplayError(context.mediaReplaceError.message, '替换失败，请稍后重试')}
          </p>
        )}
        {node.hidden && (
          <Hint label="显示内容"><Button variant="ghost" size="icon"
            type="button"
            aria-label={`显示 ${node.title} 的内容`}
            className="nodrag absolute right-2 top-2 z-20 size-8 rounded-full border-border bg-glass text-muted-foreground backdrop-blur-glass hover:text-foreground"
            onPointerDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation();
              toggleHidden();
            }}
          ><ShowIcon aria-hidden="true" /></Button></Hint>
        )}
        <div
          data-canvas-node-hidden={node.hidden ? 'true' : undefined}
          // 打码与取消打码 200ms 过渡（模糊与外扩）；减弱动态效果时全局只留透明度与颜色过渡，这里直接切。
          className={cn('h-full transition-[filter,transform] duration-200', node.type === 'image' && content?.kind === 'image' ? 'bg-transparent' : 'bg-secondary/20', node.type === 'text' ? 'min-h-32'
            : node.type === 'image' && content?.kind === 'image' ? 'min-h-0' : 'min-h-44', node.hidden && 'canvas-node-hidden', node.hidden && (node.type === 'text' || hostNodeType(context.hostPlugins ?? EMPTY_HOST_PLUGINS, node)?.textContent) && 'canvas-node-hidden-text')}
        >
          {node.type === 'text' && (
            content?.kind === 'text' && (isEditingInlineText || promptVariableParts(content.text).some(part => part.kind === 'variable')) ? (
              <div className="nodrag nowheel h-full overflow-y-auto" onPointerDown={event => event.stopPropagation()} onBlur={event => {
                if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setIsEditingInlineText(false);
              }}>
                <CanvasPromptInput
                  value={content.text}
                  references={EMPTY_CANVAS_MENTION_REFERENCES}
                  mentionsEnabled={false}
                  autoFocusVariables={context.focusVariableNodeId === node.id}
                  onFocus={() => {
                    setIsEditingInlineText(true);
                    context.recordHistory();
                    if (context.focusVariableNodeId === node.id) context.consumeVariableFocus?.();
                  }}
                  onEditingChange={editing => setTextEditing?.(node.id, editing)}
                  onChange={text => context.updateText(node.id, text)}
                  className="h-full"
                />
              </div>
            ) : (
              // 预览：指针在正文上时滚轮滚正文（不论是否选中），放得下时交还画布。读全文、改字在面板「内容」页。
              <div ref={textPreviewRef} data-canvas-text-preview="true" className="scroll-fade-y no-scrollbar h-full min-h-32 overflow-y-auto">
                <p className={cn(
                  'whitespace-pre-wrap break-words p-3 leading-relaxed text-foreground',
                  textScaleClass(node.data.display.scale),
                )}>
                  {content?.kind === 'text' && content.text
                    ? content.text
                    : draft ? '双击输入文本，或填写下方生成设置' : '双击输入文本…'}
                </p>
              </div>
            )
          )}
          {content && content.kind !== 'text' && content.pending_shared_original && (
            <div className="relative grid size-full place-items-center">
              {content.kind === 'image' && <img src={canvasMediaUrlAtWidth(context.projectId,content.version_id,512)}
                alt="" className="absolute inset-0 size-full object-contain" onError={event=>{event.currentTarget.hidden=true;}} />}
              <p role="status" className="relative rounded-md bg-card/90 px-2 py-1 text-sm text-muted-foreground">等待房主补齐原件</p>
            </div>
          )}
          {content && content.kind !== 'text' && !content.pending_shared_original && (
            <CanvasNodeMediaPreview
              projectId={context.projectId} version={content} cardWidth={node.size?.width ?? 320}
              title={node.title}
              fit={node.type === 'image' || node.type === 'video' ? node.data.display.fit : 'contain'}
              freeResize={(node.type === 'image' || node.type === 'video') && node.data.display.free_resize}
              onReady={content.kind === 'image' ? () => revealImageVersion(content.version_id) : undefined}
            />
          )}
          {content?.frozen_generation?.inputs.some(input => {
            const reference = input.version_id ? context.resolveVersion(input.version_id) : undefined;
            return reference && reference.kind !== 'text' && reference.pending_shared_original;
          }) && <span role="status" className="pointer-events-none absolute left-2 top-2 rounded bg-card/90 px-2 py-1 text-xs text-muted-foreground">等待房主补齐参考原件</span>}
          {node.type === 'image' && content?.kind === 'image' && context.resolveFinalCategory?.(content.sha256) && (
            <span className="pointer-events-none absolute left-2 top-2 z-10 max-w-[calc(100%-1rem)] truncate rounded-md border border-border bg-[var(--canvas-chip)] px-2 py-1 text-xs">
              定稿 · {context.resolveFinalCategory(content.sha256)}
            </span>
          )}
          {annotating && !context.annotationController?.fullscreen && node.type === 'image' && content?.kind === 'image' && <AnnotationEditingLayer
            editor={annotationEditor} width={content.width ?? 1024} height={content.height ?? 1024}
            fit={node.data.display.free_resize ? 'fill' : node.data.display.fit} />}
          {node.type === 'image' && content?.kind === 'image' && node.data.annotation
            && node.data.annotation.version_id === node.data.current_version_id && node.data.annotation.elements.length > 0 && <>
            {(!annotating || context.annotationController?.fullscreen) && node.data.annotation.visible && <AnnotationLayer elements={node.data.annotation.elements}
              imageWidth={content.width ?? 1024} imageHeight={content.height ?? 1024}
              fit={node.data.display.free_resize ? 'fill' : node.data.display.fit}
              className="pointer-events-none absolute inset-0 size-full" />}
            <Toggle size="sm" aria-label="显示标注" pressed={node.data.annotation.visible}
              className="nodrag nopan absolute right-2.5 top-2.5 z-10 h-7 gap-1.5 border-border bg-glass px-2 text-xs font-normal backdrop-blur-glass data-[state=on]:bg-glass"
              onPointerDown={event => event.stopPropagation()}
              onClick={event => event.stopPropagation()}
              onPressedChange={() => {
                context.recordHistory();
                context.updateNode(node.id, current => current.type === 'image' && current.data.annotation
                  ? { ...current, data: { ...current.data, annotation: { ...current.data.annotation, visible: !current.data.annotation.visible } } } : current);
              }}>
              <EditIcon /><span>标注 {node.data.annotation.elements.length}</span>
            </Toggle>
          </>}
          {node.type === 'image' && content?.kind === 'image' && context.showImageInfo
            && (node.size?.height ?? 176) >= 96 && (node.size?.width ?? 320) >= 160 && (
            <span className="pointer-events-none absolute bottom-2 right-2 z-10 max-w-[calc(100%-1rem)] truncate rounded-md border border-border bg-[var(--canvas-chip)] px-2 py-1 text-xs tabular-nums text-foreground">
              {formatCanvasImageInfo(content)}
            </span>
          )}
          {isCanvasContentNode(node) && node.type !== 'text' && !content && (
            <EmptyMediaSurface node={node} />
          )}
          {node.type === 'layer_stack' && (
            <CanvasLayerStackSurface node={node} context={context} onOpenComposer={() => setLayerComposerOpen(true)} />
          )}
          {node.type === 'compare' && <CanvasCompareNodeBody node={node} context={context} />}
          {node.type === 'image_edit' && <CanvasImageEditSurface node={node} projectId={context.projectId}
            source={context.resolveVersion(node.data.source_version_id) as CanvasMediaVersion | undefined} />}
          {node.type === 'plugin' && <PluginNodeContent node={node} context={context} selected={Boolean(selected)} />}
        </div>
      </article>
      <CanvasNodeRunLiveRegion state={nodeRunState} />
      <CanvasNodeRunOverlay
        state={nodeRunState}
        // 图片节点以「屏上已经有图」为准：首次生成的新图还在解码时，整张生成中卡片继续盖着。
        hasContent={content?.kind === 'image'
          ? revealedVersionId !== null
          : Boolean(content || node.type === 'image_edit' || (node.type === 'layer_stack' && node.data.base_version_id))}
        holdUntilReady={content?.kind === 'image' && revealedVersionId !== content.version_id}
        onFailureAction={groupStep?.job_id === nodeJob?.job_id && nodeJob?.canvas_run?.snapshot?.normalized_params?.group_run
          && nodeRunState.failureAction?.kind === 'retry' ? undefined : context.runFailureAction}
      />
      {node.type === 'compare' && CANVAS_COMPARE_SLOTS.map(slot => (
        <Handle key={slot} id={slot} type="target" position={Position.Left} className="canvas-node-handle"
          style={{ top: slot === 'before' ? '35%' : '65%' }} aria-label={`连接到 ${slot === 'before' ? 'Before' : 'After'}`}>
          <span className={CANVAS_HANDLE_DOT_CLASS} aria-hidden="true" />
        </Handle>
      ))}
      {(canvasNodeAcceptsInput(node) || node.type === 'layer_stack' || node.type === 'image_edit') && (
        <Handle type="target" isConnectable={node.type !== 'image_edit'} position={Position.Left} data-magnetic-side="left" className="canvas-node-handle canvas-creation-handle" aria-label="连接到此节点">
          <span className="canvas-magnetic-anchor" aria-hidden="true"><span className={CANVAS_HANDLE_DOT_CLASS}><AddIcon size="sm" /></span></span>
        </Handle>
      )}
      {(canvasNodeProvidesOutput(node) || node.type === 'image_edit' || (node.type === 'layer_stack'
        && (node.data.base_material_node_id || node.data.layers.some(layer => layer.material_node_id)))) && (
        <Handle
          type="source"
          isConnectable={node.type !== 'layer_stack' && node.type !== 'image_edit'}
          position={Position.Right}
          data-magnetic-side="right"
          className="canvas-node-handle canvas-creation-handle"
          aria-label="从此节点连接"
        >
          <span className="canvas-magnetic-anchor" aria-hidden="true"><span className={CANVAS_HANDLE_DOT_CLASS}><AddIcon size="sm" /></span></span>
        </Handle>
      )}
      {generationPanelPresence.mounted && draft && context && (
        <CanvasNodeFloatingPanel
          nodeId={node.id}
          anchor={shellElement}
          surfaceRef={context.generationPanel.surfaceRef}
          hiddenWhileDragging={dragging}
          leaving={generationPanelPresence.phase === 'leaving'}
        >
          {node.type === 'text' ? (
            <CanvasTextNodePanel
              node={node}
              draft={draft}
              context={context}
              focusRequest={textFocusRequest}
              onClose={() => context.generationPanel.dismiss(node.id)}
            />
          ) : (
            <CanvasGenerationComposer
              node={node}
              draft={draft}
              context={context}
              onClose={() => context.generationPanel.dismiss(node.id)}
            />
          )}
        </CanvasNodeFloatingPanel>
      )}
      {editPanelPresence.mounted && editSource && context && (
        <CanvasNodeFloatingPanel
          nodeId={node.id}
          anchor={shellElement}
          surfaceRef={context.generationPanel.surfaceRef}
          hiddenWhileDragging={dragging}
          leaving={editPanelPresence.phase === 'leaving'}
        >
          <CanvasImageEditPanel node={node} edit={editSource} context={context}
            onClose={() => context.generationPanel.dismiss(node.id)} />
        </CanvasNodeFloatingPanel>
      )}
      {layerComposerPresence.mounted && node.type === 'layer_stack' && context && (
        <CanvasNodeFloatingPanel
          nodeId={node.id}
          anchor={shellElement}
          surfaceRef={context.generationPanel.surfaceRef}
          hiddenWhileDragging={dragging}
          leaving={layerComposerPresence.phase === 'leaving'}
        >
          <CanvasLayerStackComposer node={node} context={context} onClose={() => setLayerComposerOpen(false)} />
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
  side: 'below';
}

/** 面板跟随节点底边，碰到可视区边缘时停在边缘。 */
export function placeCanvasGenerationPanel(
  anchor: CanvasPanelRect,
  bounds: CanvasPanelRect,
  panelHeight: number,
): CanvasPanelPlacement {
  const gap = CANVAS_GENERATION_PANEL_GAP;
  const width = Math.min(CANVAS_GENERATION_PANEL_WIDTH, Math.max(1, bounds.width - gap * 2));
  const maxHeight = Math.max(160, bounds.height - gap * 2);
  const height = Math.min(panelHeight > 0 ? panelHeight : maxHeight, maxHeight);
  const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));
  const left = clamp(anchor.left + anchor.width / 2 - width / 2, bounds.left + gap, bounds.right - gap - width);
  const top = clamp(anchor.bottom + gap, bounds.top + gap, bounds.bottom - gap - height);
  return { left, top, width, maxHeight, side: 'below' };
}

/** 画布外框上的常驻控件占了哪几条边。
 *
 *  只夹进视口还不够：面板贴着可视区下沿摆的时候，「开始生成」正好落在底部那两组控件底下
 *  （1280×720 实测），主操作点不到。按控件的实际矩形收缩可用区域，尺寸变了不用改这里。 */
export function canvasChromeInsetBounds(surface: HTMLElement): CanvasPanelRect {
  const bounds = surface.getBoundingClientRect();
  const edge = (selector: string) => surface.querySelector(selector)?.getBoundingClientRect() ?? null;
  const rail = edge('.canvas-tool-dock') ?? edge('.canvas-mobile-rail');
  const zoom = edge('.canvas-zoom-dock');
  const config = edge('.canvas-config-dock');
  const library = edge('.canvas-library-panel');
  const top = edge('.canvas-editor-top');
  const left = rail ? Math.max(bounds.left, rail.right) : bounds.left;
  const right = library ? Math.min(bounds.right, library.left) : bounds.right;
  const upper = top ? Math.max(bounds.top, top.bottom) : bounds.top;
  const lower = Math.min(bounds.bottom, zoom?.top ?? bounds.bottom, config?.top ?? bounds.bottom);
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

/** NodeToolbar keeps a fixed screen size; keep its controls reachable at the viewport edges. */
function CanvasAnnotationToolbarBounds({ nodeId, children }: { nodeId: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const transform = useStore(canvasFlowTransform);
  const geometrySelector = useCallback((state: ReactFlowState) => canvasNodeGeometry(state, nodeId), [nodeId]);
  const geometry = useStore(geometrySelector);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      element.style.translate = 'none';
      const rect = element.getBoundingClientRect();
      const dx = Math.max(16 - rect.left, Math.min(0, window.innerWidth - 16 - rect.right));
      const dy = Math.max(16 - rect.top, Math.min(0, window.innerHeight - 16 - rect.bottom));
      element.style.translate = dx || dy ? `${dx}px ${dy}px` : 'none';
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [geometry, transform]);
  return <div ref={ref} className="max-w-[calc(100vw-32px)] overflow-x-auto rounded-xl">{children}</div>;
}


/** 节点卡上的图要向服务端申请多宽的位图：卡片宽 × 画布缩放，缩小时按 100% 算。
 *
 *  selector 只返回档位，滚轮缩放时只有跨档的节点重渲染；缩小不降档，拉远一整片画布不会再
 *  补发一批小图请求。放大超过最大档位返回 null＝原图，所以只有放大看的那几张会解满分辨率。 */
function useCanvasImageBitmapWidth(cardWidth: number): number | null {
  const selector = useCallback(
    (state: ReactFlowState) => canvasThumbnailWidth(cardWidth * Math.max(state.transform[2], 1)),
    [cardWidth],
  );
  return useStore(selector);
}

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

/** 生成面板挂在画布区域上，不再挂在节点里面。
 *
 *  原实现是 React Flow 节点的子元素，靠 scale(1/zoom) 反缩放对抗画布缩放。两个后果：
 *  transform 默认绕中心缩放，当时 608px 的面板放大后向左右各溢出上百像素（1280×720 视口实测面板
 *  left=-77，提示词编辑区左边 64px 落在视口外，看不见也点不到）；而且它活在 transform 层里，
 *  夹视口这件事在那儿做不到——父级 transform 之后再 clamp 也夹不回来。
 *  portal 到 .canvas-editor-region（position:relative）之后：尺寸恒定不再受缩放影响，位置按节点
 *  的屏幕矩形算，文字也不再被分数倍缩放糊掉。
 *
 *  平移和缩放只更新外壳的 transform；进场动画单独写内层。 */
/** 拖动节点时工具条与生成面板朝节点方向收起（150ms，退场曲线），松手再浮现（200ms，进场曲线）。
 *  减弱动态效果时不位移，只淡变。
 *  静止时不留 translate / opacity：祖先上残留的 translate 会让面板里的 backdrop-blur 失效。 */
function canvasDragChromeClass(dragging: boolean, toward: 'up' | 'down') {
  return cn(
    'transition-[opacity,translate] motion-reduce:translate-y-0',
    dragging
      ? cn('pointer-events-none opacity-0 duration-150', toward === 'down' ? 'translate-y-2' : '-translate-y-2')
      : 'duration-200 ease-out',
  );
}

export function CanvasNodeFloatingPanel({
  nodeId,
  anchor,
  surfaceRef,
  hiddenWhileDragging = false,
  leaving = false,
  children,
}: {
  nodeId: string;
  hiddenWhileDragging?: boolean;
  /** 退场中：150ms 淡出，不再接收指针，播完由父级卸载。 */
  leaving?: boolean;
  /** 节点外壳的 DOM 节点。传元素而不是 ref：子组件的 layout effect 在父级 ref 挂上之前就跑，
   *  用 ref 会拿到 null，首帧永远定位不上。父级用 callback ref 把它变成 state 传下来。 */
  anchor: HTMLElement | null;
  surfaceRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Pick<CanvasPanelPlacement, 'width' | 'maxHeight'> | null>(null);
  const entranceStarted = useRef(false);
  const innerRef = useRef<HTMLDivElement>(null);
  const [createdFromHandle] = useState(() => isConnectedNodeEntering(nodeId));
  const flowStore = useStoreApi();
  const placed = placement !== null;
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!placed || !inner || entranceStarted.current) return;
    entranceStarted.current = true;
    const focusedAtStart = document.activeElement;
    const focusInput = () => {
      if (createdFromHandle && inner.isConnected && (document.activeElement === focusedAtStart || document.activeElement === document.body)) {
        inner.querySelector<HTMLElement>('[contenteditable="true"],textarea')?.focus({ preventScroll: true });
      }
    };
    if (!motionAvailable()) {
      const frame = requestAnimationFrame(focusInput);
      return () => cancelAnimationFrame(frame);
    }
    const reduced = prefersReducedMotion();
    const controls = clearOnFinish(animate(inner, reduced ? { opacity: [0, 1] }
      : { opacity: [0, 1], y: [-6, 0] }, {
      delay: createdFromHandle && !reduced ? MOTION_NODE_PANEL_DELAY : 0,
      duration: reduced ? MOTION_DURATION.fast : MOTION_DURATION.base, ease: MOTION_EASE.out,
    }), inner);
    let active = true;
    void controls.finished.then(() => { if (active) focusInput(); });
    return () => { active = false; controls.stop(); };
  }, [placed, createdFromHandle]);
  const geometrySelector = useCallback(
    (state: ReactFlowState) => hiddenWhileDragging ? '' : canvasNodeGeometry(state, nodeId),
    [nodeId, hiddenWhileDragging],
  );
  const geometry = useStore(geometrySelector);
  const surface = surfaceRef?.current ?? null;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!anchor || !panel || hiddenWhileDragging) return;
    // 外层节点不会随进场动效缩放。测量、视口原点和面板尺寸只在布局变化时重读。
    const shell = anchor.closest<HTMLElement>('.react-flow__node') ?? anchor;
    const measure = () => {
      const measured = surface && canvasChromeInsetBounds(surface);
      const bounds = measured?.width && measured.height ? measured : {
        left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
        width: window.innerWidth, height: window.innerHeight,
      };
      const rect = shell.getBoundingClientRect();
      const state = flowStore.getState();
      const [ox, oy, oz] = state.transform;
      const frame = state.domNode?.getBoundingClientRect();
      const origin = surface?.getBoundingClientRect();
      const fx = frame?.left ?? 0, fy = frame?.top ?? 0;
      const height = panel.offsetHeight;
      const base = placeCanvasGenerationPanel(rect, bounds, height);
      panel.style.left = `${base.left - (origin?.left ?? 0)}px`;
      panel.style.top = `${base.top - (origin?.top ?? 0)}px`;
      panel.style.removeProperty('transform');
      setPlacement(current => current?.width === base.width && current.maxHeight === base.maxHeight
        ? current : { width: base.width, maxHeight: base.maxHeight });
      return ([x, y, zoom]: readonly number[]) => {
        const scale = zoom / oz;
        const left = fx + x + (rect.left - fx - ox) * scale;
        const top = fy + y + (rect.top - fy - oy) * scale;
        const width = rect.width * scale, heightScaled = rect.height * scale;
        const moved = placeCanvasGenerationPanel({ left, top, width, height: heightScaled,
          right: left + width, bottom: top + heightScaled }, bounds, height);
        panel.style.transform = `translate3d(${moved.left - base.left}px, ${moved.top - base.top}px, 0)`;
      };
    };
    let follow = measure();
    const place = () => { follow = measure(); };
    const unsubscribe = flowStore.subscribe((state, previous) => {
      if (state.transform !== previous.transform) follow(state.transform);
    });
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    if (surface) observer.observe(surface);
    window.addEventListener('resize', place);
    return () => {
      unsubscribe();
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor, surface, flowStore, geometry, hiddenWhileDragging]);

  return createPortal(
    <div
      ref={panelRef}
      data-canvas-node-panel-anchor={nodeId}
      // 平移使用 transform，拖动收起使用独立的 translate。
      className={cn(canvasDragChromeClass(hiddenWhileDragging, 'up'),
        leaving && 'pointer-events-none opacity-0 transition-opacity duration-150')}
      style={{
        position: surface ? 'absolute' : 'fixed',
        width: placement?.width ?? CANVAS_GENERATION_PANEL_WIDTH,
        maxHeight: placement?.maxHeight,
        overflowY: 'auto',
        zIndex: surface ? 10 : 50,
        visibility: placement ? undefined : 'hidden',
      }}
    >
      <div ref={innerRef}>{children}</div>
    </div>,
    surface ?? document.body,
  );
}

/** 展开后相邻候选卡之间的间距（画布坐标）。 */
const CANDIDATE_CARD_GAP = 16;

function splitCandidateEntries(entries: CanvasCandidateEntry[], primaryVersionId: string | null) {
  const primary = entries.find(entry => entry.candidate.version_id === primaryVersionId) ?? entries[0];
  const others = entries.filter(entry => entry.candidate.candidate_id !== primary.candidate.candidate_id);
  return { primary, others };
}

/** 结果组的「N 张」展开 / 收起按钮。 */
function ResultStackBadge({ total, expanded, onToggle }: { total: number; expanded: boolean; onToggle: () => void }) {
  return (
    <Button variant="bare"
      type="button"
      className="pointer-events-auto absolute right-2 top-2 z-20 inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-glass px-3 text-xs font-medium text-foreground backdrop-blur-glass transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      aria-label={`${expanded ? '收起' : '展开'} ${total} 张结果`}
      aria-expanded={expanded}
      onPointerDown={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {total} 张
      <ChevronRightIcon size="sm" className={cn('transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
    </Button>
  );
}

/** 一次出多张的成员（结果组节点、候选卡）从封面背后抽出 / 收回时的起点。
 *  位移只取「封面 → 成员」方向上的一小段（封顶 48px），离得再远也不横跨画布飞过来；
 *  成员间错开 20ms，总共不超过 100ms，八张图也不会拖成一长串。 */
export interface CanvasStackMemberMotion {
  x: number;
  y: number;
  delay: number;
}

const STACK_MEMBER_TRAVEL = 48;
const STACK_MEMBER_STAGGER = 0.02;
const STACK_MEMBER_STAGGER_CAP = 0.1;

export function canvasStackMemberMotion(cover: CanvasPoint, member: CanvasPoint, index: number): CanvasStackMemberMotion {
  const dx = member.x - cover.x;
  const dy = member.y - cover.y;
  const distance = Math.hypot(dx, dy);
  const ratio = distance > 0 ? Math.min(distance, STACK_MEMBER_TRAVEL) / distance : 0;
  return { x: -dx * ratio, y: -dy * ratio, delay: Math.min(index * STACK_MEMBER_STAGGER, STACK_MEMBER_STAGGER_CAP) };
}


/** 抽出：从封面方向 + 96% 缩放 + 透明进到原位。减弱动态效果时只淡入。 */
export function playStackMemberEntrance(elements: Element | Element[], motions: CanvasStackMemberMotion[]) {
  if (!motionAvailable()) return;
  const list = Array.isArray(elements) ? elements : [elements];
  const reduced = prefersReducedMotion();
  list.forEach((element, index) => {
    const motion = motions[index];
    if (!motion) return;
    const fade = { duration: MOTION_DURATION.base, ease: MOTION_EASE.out, delay: motion.delay };
    clearOnFinish(reduced
      ? animate(element, { opacity: [0, 1] }, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle, delay: motion.delay })
      : animate(element, { x: [motion.x, 0], y: [motion.y, 0], scale: [0.96, 1], opacity: [0, 1] },
        { ...MOTION_SPRING.snappy, delay: motion.delay, opacity: fade }), element);
  });
}

/** 收回：150ms 同步退回封面方向并淡出，不错开。返回 null 表示不播（直接收起）。 */
export function playStackMemberExit(elements: Element[], motions: CanvasStackMemberMotion[]): AnimationPlaybackControls[] | null {
  if (!motionAvailable() || elements.length === 0) return null;
  const reduced = prefersReducedMotion();
  const timing = { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle };
  return elements.map((element, index) => {
    const motion = motions[index] ?? { x: 0, y: 0, delay: 0 };
    return reduced
      ? animate(element, { opacity: 0 }, timing)
      : animate(element, { x: motion.x, y: motion.y, scale: 0.96, opacity: 0 }, timing);
  });
}

export function clearStackMemberMotion(elements: Element[]) {
  for (const element of elements) {
    if (!(element instanceof HTMLElement)) continue;
    element.style.removeProperty('opacity');
    element.style.removeProperty('transform');
  }
}

/** 收起后封面身后的叠层边框跟着成员收回一起淡回来。 */
function useStackBordersFadeIn(ref: RefObject<HTMLElement | null>, expanded: boolean) {
  useAnimateOnChange(expanded, open => {
    const borders = open ? [] : Array.from(ref.current?.querySelectorAll('[data-stack-border]') ?? []);
    if (borders.length) clearOnFinish(animate(borders, { opacity: [0, 1] }, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }), borders, ['opacity']);
  }, { keepWhenReduced: true });
}

/** 已拆成节点的结果组挂在封面上的外观：收起时身后叠几层边框，右上角是展开按钮。
 *  不加 nowheel：这一层没有自己的滚动内容，滚轮 / 双指要照常平移画布。 */
export function ResultStackChrome({ total, expanded, onToggle }: { total: number; expanded: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useStackBordersFadeIn(ref, expanded);
  return (
    <div
      ref={ref}
      data-testid="canvas-result-stack"
      data-expanded={expanded ? 'true' : 'false'}
      className="nodrag pointer-events-none absolute inset-0 overflow-visible"
    >
      {!expanded && Array.from({ length: Math.min(total - 1, 3) }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          data-stack-border
          className="pointer-events-none absolute inset-0 rounded-lg border border-border"
          style={{ transform: `translate(${10 + index * 6}px, ${5 + index * 4}px) rotate(${index + 1}deg)` }}
        />
      ))}
      <ResultStackBadge total={total} expanded={expanded} onToggle={onToggle} />
    </div>
  );
}

/** 候选卡排在主结果右边，起点都是向左退回主结果背后。 */
function candidateMotions(count: number) {
  return Array.from({ length: count }, (_, index) => canvasStackMemberMotion(
    { x: 0, y: 0 }, { x: (index + 1) * STACK_MEMBER_TRAVEL, y: 0 }, index,
  ));
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
  node: Extract<CanvasContentNode, { type: 'image' }>;
  entries: CanvasCandidateEntry[];
  primaryVersionId: string | null;
  expanded: boolean;
  disabled: boolean;
  context: CanvasNodeContextValue;
  onToggle: () => void;
}) {
  const { primary, others } = splitCandidateEntries(entries, primaryVersionId);
  const primaryTerminalFailure = primary.candidate.status === 'failed' || primary.candidate.status === 'canceled';
  const primaryNumber = primary.candidate.index + 1;
  const stackRef = useRef<HTMLDivElement>(null);
  // 收起时候选卡先退回主结果背后、淡出，播完再卸载；中途再展开就停在当前位置接着出来。
  const [cardsMounted, setCardsMounted] = useState(expanded);
  if (expanded && !cardsMounted) setCardsMounted(true);
  // 展开时候选卡与结果组成员同一套手势：从主结果背后抽出。
  useAnimateOnChange(expanded, open => {
    const cards = open ? Array.from(stackRef.current?.querySelectorAll<HTMLElement>('[data-candidate-card]') ?? []) : [];
    if (cards.length) playStackMemberEntrance(cards, candidateMotions(cards.length));
  }, { keepWhenReduced: true });
  useLayoutEffect(() => {
    if (expanded || !cardsMounted) return;
    const cards = Array.from(stackRef.current?.querySelectorAll<HTMLElement>('[data-candidate-card]') ?? []);
    const controls = playStackMemberExit(cards, candidateMotions(cards.length));
    if (!controls) {
      setCardsMounted(false);
      return;
    }
    let cancelled = false;
    void Promise.all(controls.map(control => control.finished)).then(() => {
      if (!cancelled) setCardsMounted(false);
    });
    return () => {
      cancelled = true;
      controls.forEach(control => control.stop());
      clearStackMemberMotion(cards);
    };
  }, [cardsMounted, expanded]);
  useStackBordersFadeIn(stackRef, expanded);

  return (
    <div
      ref={stackRef}
      data-testid="canvas-candidate-stack"
      data-expanded={expanded ? 'true' : 'false'}
      // 不加 nowheel：候选区没有自己的滚动内容，滚轮 / 双指要照常平移画布。
      className="nodrag pointer-events-none absolute inset-0 overflow-visible"
    >
      {!expanded && entries.length > 1 && entries.slice(1, 4).map((entry, index) => (
        <span
          key={entry.candidate.candidate_id}
          aria-hidden="true"
          data-stack-border
          className="pointer-events-none absolute inset-0 rounded-lg border border-border"
          style={{ transform: `translate(${10 + index * 6}px, ${5 + index * 4}px) rotate(${index + 1}deg)` }}
        />
      ))}
      {cardsMounted && entries.length > 1 && others.map((entry, index) => (
        <MediaCandidateCard
          key={entry.candidate.candidate_id}
          node={node}
          entry={entry}
          index={index}
          number={entry.candidate.index + 1}
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
      {entries.length > 1 && <ResultStackBadge total={entries.length} expanded={expanded} onToggle={onToggle} />}
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
  node: Extract<CanvasContentNode, { type: 'image' }>;
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
      data-candidate-card
      aria-label={`候选 ${number}`}
      className={cn('pointer-events-auto absolute top-0 z-20 h-full overflow-hidden rounded-lg border border-border shell-glow', version?.kind === 'image' ? 'bg-transparent' : 'bg-card')}
      style={{
        left: `calc(${horizontalOffset * 100}% + ${horizontalOffset * CANDIDATE_CARD_GAP}px)`,
        width: '100%',
      }}
      onPointerDown={event => event.stopPropagation()}
      onDoubleClick={event => {
        event.stopPropagation();
        if (isControlDoubleClick(event)) return;
        if (version) context.previewContent(version.version_id, `${node.title} · 候选 ${number}`, node.id);
      }}
    >
      {version?.kind === node.type
        ? (
          <CanvasNodeMediaPreview
            projectId={context.projectId} version={version} cardWidth={node.size?.width ?? 320}
            title={`${node.title} · 候选 ${number}`}
            fit={node.data.display.fit}
            freeResize={node.data.display.free_resize}
          />
        )
        : (
          <div className="grid size-full min-h-44 place-items-center px-4 text-center text-xs text-muted-foreground">
            {candidate.status === 'pending'
              ? <LoadingIcon className="animate-spin" aria-label={`候选 ${number} 生成中`} />
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
        <Hint label="设为主结果"><Button variant="bare"
          type="button"
          aria-label={`将候选 ${number} 设为主结果`}
          className="absolute bottom-2 left-2 grid size-8 place-items-center rounded-full border border-border bg-glass text-muted-foreground backdrop-blur-glass transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={event => {
            event.stopPropagation();
            context.selectCandidate(node.id, version.version_id);
          }}
        >
          <CheckIcon aria-hidden="true" />
        </Button></Hint>
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
      <Hint label="删除这个失败槽位"><Button variant="bare"
        type="button"
        aria-label={`删除候选 ${number}`}
        className="grid size-8 place-items-center rounded-full border border-border bg-glass text-muted-foreground backdrop-blur-glass transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onClick={event => {
          event.stopPropagation();
          onDismiss();
        }}
      >
        <DeleteIcon aria-hidden="true" />
      </Button></Hint>
    </div>
  );
}

/** 插件节点的内容：已启用、已加载的宿主插件由宿主直接渲染；其余走沙箱界面，或在插件关闭时显示占位。 */
function PluginNodeContent({ node, context, selected }: {
  node: CanvasPluginNode; context: CanvasNodeContextValue; selected: boolean;
}) {
  if (node.data.shared_placeholder) return <p className="p-3 text-xs text-muted-foreground">插件未声明共享字段 · 仅查看</p>;
  const hostType = hostNodeType(context.hostPlugins ?? EMPTY_HOST_PLUGINS, node);
  if (hostType && context.hostPluginApi) return <hostType.Body node={node} api={context.hostPluginApi} />;
  return <PluginNodeBody node={node} projectId={context.projectId} selected={selected}
    inputs={context.pluginInputsByNodeId?.get(node.id) ?? EMPTY_PLUGIN_INPUTS}
    resolveVersion={context.resolveVersion} updateNode={context.updateNode} recordHistory={context.recordHistory}
    savePendingEdits={context.savePendingEdits} />;
}

function CanvasNodeToolbar({
  node,
  content,
  replacing,
  submitting,
  context,
  onEditText,
}: {
  node: CanvasNode;
  content: CanvasContentVersion | undefined;
  replacing: boolean;
  submitting: boolean;
  context: CanvasNodeContextValue;
  onEditText: () => void;
}) {
  const contentNode = isCanvasContentNode(node) ? node : null;
  const [downloadingLayers, setDownloadingLayers] = useState<CanvasLayerExportFormat | null>(null);
  const plugins = usePlugins();
  // 文本节点工具栏上的插件按钮（清单 text_actions）：插件关闭时不出现。
  const pluginTextActions = useMemo(() => enabledPlugins(plugins).flatMap(plugin => (
    (plugin.contributes.text_actions ?? []).filter(action => action.action.kind === 'create_node')
      .map(action => ({ plugin, action, Icon: pluginIcon(action.icon) }))
  )), [plugins]);
  const layersReady = node.type === 'layer_stack' && Boolean(node.data.base_version_id)
    && !node.data.active_run_id && !submitting;

  const hostType = hostNodeType(context.hostPlugins ?? EMPTY_HOST_PLUGINS, node);
  if (hostType && node.type === 'plugin') return <>
    {hostType.toolbar(node).map(action => (
      <MediaToolButton key={action.id} label={action.label} text={action.text} onClick={action.onClick}><action.Icon /></MediaToolButton>
    ))}
  </>;

  if (node.type === 'image_edit') return <>
    <MediaToolButton label={`编辑 ${node.title}`} text="编辑" onClick={() => context.openImageEdit?.(node.id)}>{node.data.options.mode === 'outpaint' ? <OutpaintIcon /> : <BrushIcon />}</MediaToolButton>
    <MediaToolButton label={`生成 ${node.title}`} text="生成" disabled={submitting || !!node.data.active_run_id}
      onClick={() => { void context.submitImageEdit?.(node.id); }}><AiIcon /></MediaToolButton>
  </>;

  return (
    <>
      {node.type === 'text' && (
        <>
          <MediaToolButton label={`编辑文本 ${node.title}`} text="编辑" disabled={submitting} onClick={onEditText}>
            <EditIcon />
          </MediaToolButton>
          <MediaToolButton
            label={`用 ${node.title} 生成图片`}
            text="生成图片"
            disabled={content?.kind !== 'text'}
            onClick={() => context.createImageFromSource?.(node.id)}
          >
            <ImageFileIcon />
          </MediaToolButton>
          {context.createPluginNodeFromMedia && pluginTextActions.map(({ plugin, action, Icon }) => (
            <MediaToolButton key={`${plugin.id}:${action.id}`}
              label={`用 ${node.title} ${action.label}`}
              text={action.label}
              disabled={content?.kind !== 'text' || !content.text.trim()}
              onClick={() => contentNode && context.createPluginNodeFromMedia?.(contentNode, plugin, action)}
            >
              <Icon />
            </MediaToolButton>
          ))}
        </>
      )}
      {node.type === 'layer_stack' && (
        <>
          {([['zip', '下载全部图层', '下载图层', <DownloadIcon />], ['psd', '导出 PSD', 'PSD', <ExportFileIcon />]] as const).map(
            ([format, label, text, icon]) => (
              <MediaToolButton
                key={format}
                label={label}
                text={text}
                disabled={!layersReady || downloadingLayers !== null}
                onClick={() => {
                  setDownloadingLayers(format);
                  void downloadCanvasLayers(context.projectId, node.id, format)
                    .catch(error => context.reportError?.((error as Error).message))
                    .finally(() => setDownloadingLayers(null));
                }}
              >
                <SwapIcon swapKey={downloadingLayers === format}>{downloadingLayers === format ? <LoadingIcon className="animate-spin" /> : icon}</SwapIcon>
              </MediaToolButton>
            ),
          )}
          <MediaToolButton
            label="展开图层到画布并分组"
            text="展开图层"
            disabled={!layersReady}
            onClick={() => context.expandLayerStack(node.id)}
          >
            <LayersIcon />
          </MediaToolButton>
        </>
      )}
      {node.type === 'compare' && (
        <>
          <MediaToolButton label={`交换 ${node.title} 的前后`} text="交换" onClick={() => context.swapCompareInputs?.(node.id)}>
            <ExchangeIcon />
          </MediaToolButton>
          <MediaToolButton label={`全屏对比 ${node.title}`} text="全屏" onClick={() => context.openCompare?.(node.id)}>
            <ExpandIcon />
          </MediaToolButton>
        </>
      )}
      {node.type !== 'compare' && <MediaToolButton
        label={content || node.type === 'layer_stack' ? `查看 ${node.title} 详情` : `查看 ${node.title} 设置`}
        text={content || node.type === 'layer_stack' ? '查看' : '查看设置'}
        onClick={() => {
          if (node.type === 'layer_stack') context.previewLayerStack(node.id);
          else if (content) context.previewContent(content.version_id, node.title, node.id);
          else context.selectNode(node.id);
        }}
      >
        <ShowIcon />
      </MediaToolButton>}
      {/* 空的媒体节点走外层「上传素材」那一支，到这里的都已有内容。 */}
      {content && content.kind !== 'text' && (
        <MediaToolLink
          label={`下载 ${node.title}`}
          text="下载"
          href={canvasDownloadUrl(context.projectId, content.version_id)}
        >
          <DownloadIcon />
        </MediaToolLink>
      )}
      {node.type === 'video' && (
        <MediaToolButton
          label={`编辑视频 ${node.title}`}
          text="编辑视频"
          disabled={content?.kind !== 'video' || submitting || replacing}
          onClick={() => {
            if (content?.kind === 'video') context.editVideo(node);
          }}
        >
          <ChatIcon />
        </MediaToolButton>
      )}
    </>
  );
}

/** 视频节点工具栏的「更多」：只放已启用插件声明的视频动作，没有动作时不出现。
 *  按钮由宿主按清单画，点击前不运行插件代码。 */
function PluginVideoActionsMenu({ node, context, onOverlayOpenChange }: {
  node: Extract<CanvasContentNode, { type: 'video' }>;
  context: CanvasNodeContextValue;
  onOverlayOpenChange: (open: boolean) => void;
}) {
  const plugins = usePlugins();
  const actions = useMemo(() => enabledPlugins(plugins).flatMap(plugin => (
    plugin.contributes.video_actions.filter(action => action.action.kind === 'create_node')
      .map(action => ({ plugin, action, Icon: pluginIcon(action.icon) }))
  )), [plugins]);
  if (!context.createPluginNodeFromMedia || actions.length === 0) return null;
  return (
    <DropdownMenu onOpenChange={onOverlayOpenChange}>
      <DropdownMenuTrigger asChild>
        <MediaToolButton label={`${node.title} 的更多工具`} text="更多" onClick={() => undefined}>
          <MoreIcon />
        </MediaToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="nodrag min-w-40 [&_svg]:size-4"
        onPointerDown={event => event.stopPropagation()}>
        {actions.map(({ plugin, action, Icon }) => (
          <DropdownMenuItem key={`${plugin.id}:${action.id}`} className="gap-2"
            onSelect={() => context.createPluginNodeFromMedia?.(node, plugin, action)}>
            <Icon />{action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 节点上的按钮常被快速连点（连续切换显示 / 隐藏、连点下载），两次点击会凑成一次 dblclick；
 *  落在按钮或链接上的双击不算「双击节点」，不打开预览 / 进入编辑。 */
function isControlDoubleClick(event: React.MouseEvent<HTMLElement>) {
  const control = event.target instanceof Element ? event.target.closest('button, a[href]') : null;
  return Boolean(control && event.currentTarget.contains(control));
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

const MATTING_UNAVAILABLE_TOOL_IDS: ReadonlySet<CanvasImageQuickToolId> = new Set(['removeBackground']);
const DELETE_KEY_HINT = /Mac/i.test(navigator.userAgent) ? '⌫' : 'Delete';

/** AI高清某一档会用哪个模型：指定了就用指定的，否则按服务端同一规则自动选 Nano Banana。 */
function upscaleChoice(context: CanvasNodeContextValue, target: CanvasUpscaleTarget) {
  const tier = context.canvasUiPreferences.upscale.tiers[target];
  const selection = tier?.selection;
  const providers = context.generationProviders ?? context.keys;
  if (selection) {
    const key = providerForAlias(providers, selection.alias);
    const name = key?.models.find(model => model.id === selection.model)?.name ?? selection.model;
    return { key, alias: selection.alias ?? undefined, model: selection.model, name, quality: tier.quality };
  }
  const autoQuality = CANVAS_UPSCALE_TARGETS.find(item => item.id === target)?.autoQuality;
  const auto = autoQuality ? canvasUpscaleAutoChoice(context.keys) : null;
  return auto ? {
    key: auto.key, alias: auto.key.alias, model: auto.model.id,
    name: auto.model.name || auto.model.id, quality: tier?.quality ?? autoQuality,
  } : null;
}

/** 估价用的参数，与服务端提交（canvas_runs.submit_upscale_run → `_upscale_size_params`）逐项对齐：
 *  原图作为一张参考图随请求发出（有的渠道按参考图张数计价）；比例取渠道支持的最近比例；
 *  OpenRouter 带分辨率档；比例族只带质量；像素族按档位长边等比放大。 */
function upscaleEstimateParams(
  choice: NonNullable<ReturnType<typeof upscaleChoice>>,
  target: CanvasUpscaleTarget,
  width: number,
  height: number,
): Record<string, unknown> {
  const caps = selectionImageCaps(choice.key, choice.model);
  const params: Record<string, unknown> = { n: 1, reference_images: ['source'] };
  const ratios = caps.ratios.filter(ratio => ratio.includes(':'));
  if (width && height && ratios.length) {
    const aspect = Math.log(width / height);
    const distance = (ratio: string) => { const [a, b] = ratio.split(':').map(Number); return Math.abs(aspect - Math.log(a / b)); };
    params.ratio = ratios.reduce((best, ratio) => distance(ratio) < distance(best) ? ratio : best);
  }
  if (choice.quality && supportsImageQuality(choice.model)) params.quality = choice.quality;
  if (choice.key?.provider === 'openrouter') {
    return (caps.resolutions as readonly string[]).includes(target) ? { ...params, resolution: target } : params;
  }
  if (caps.sizeKind !== 'pixels' || !width || !height) return params;
  const scale = (CANVAS_UPSCALE_TARGETS.find(item => item.id === target)?.longEdge ?? 0) / Math.max(width, height);
  return { ...params, size_mode: 'custom', size: `${Math.max(1, Math.round(width * scale))}x${Math.max(1, Math.round(height * scale))}` };
}

/** 一档 AI高清的估价，与生成面板同一个估价接口；拿不到为 null。 */
function useUpscaleCost(
  context: CanvasNodeContextValue,
  target: CanvasUpscaleTarget,
  width: number,
  height: number,
  enabled: boolean,
) {
  const choice = upscaleChoice(context, target);
  return useGenerationEstimate(choice?.alias, choice?.model ?? '',
    choice ? upscaleEstimateParams(choice, target, width, height) : {}, enabled && Boolean(choice));
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
  /** 有菜单的按钮点击后展开选项，不直接执行 run。 */
  menu?: Array<{ id: string; title: string; detail: string; onSelect: () => void }>;
};

function ImageNodeToolbar({
  node,
  content,
  replacing,
  submitting,
  context,
  onSave,
  onShare,
  onToggleHidden,
  trailing,
  onOverlayOpenChange,
}: {
  node: Extract<CanvasContentNode, { type: 'image' }>;
  content: CanvasContentVersion | undefined;
  replacing: boolean;
  submitting: boolean;
  context: CanvasNodeContextValue;
  onSave?: () => void;
  onShare?: () => void;
  onToggleHidden?: () => void;
  /** 排在「更多」之前的固定按钮。 */
  trailing?: React.ReactNode;
  onOverlayOpenChange: (open: boolean) => void;
}) {
  // 已启用插件在清单里声明的图片动作：按钮是宿主按清单画的，点之前不运行插件代码。
  const plugins = usePlugins();
  // host_call（ADR-0041）只认白名单里的宿主插件：点了交给插件分块，不建节点。
  const pluginImageActions = useMemo(() => enabledPlugins(plugins).flatMap(plugin => (
    plugin.contributes.image_actions.filter(action => action.action.kind === 'create_node'
      || (action.action.kind === 'host_call' && plugin.runtime === 'host' && isHostPluginId(plugin.id)))
      .map(action => ({ plugin, action, Icon: pluginIcon(action.icon) }))
  )), [plugins]);
  const splitAnchor = useRef<HTMLButtonElement>(null);
  const splitOpenRef = useRef(false);
  const [splitOpen, setSplitOpen] = useState(false);
  function toggleSplit(open: boolean) {
    splitOpenRef.current = open;
    setSplitOpen(open);
    updateMenuOpen(open);
  }
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 「自定义工具条」从更多菜单里打开：菜单随后收起，不能把弹窗还开着的工具条一起收掉。
  const settingsOpenRef = useRef(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const onOverlayOpenChangeRef = useRef(onOverlayOpenChange);
  useEffect(() => {
    onOverlayOpenChangeRef.current = onOverlayOpenChange;
  }, [onOverlayOpenChange]);
  useEffect(() => () => onOverlayOpenChangeRef.current(false), []);
  const resizeUnlocked = node.data.display.free_resize;
  const imageContent = content?.kind === 'image' ? content : undefined;
  const currentVersionId = imageContent?.version_id;
  const sourceWidth = imageContent?.width ?? 0;
  const sourceHeight = imageContent?.height ?? 0;
  const upscalePriced = (target: CanvasUpscaleTarget) => Boolean(currentVersionId)
    && (CANVAS_UPSCALE_TARGETS.find(item => item.id === target)?.longEdge ?? 0) > Math.max(sourceWidth, sourceHeight);
  const upscaleCosts: Record<CanvasUpscaleTarget, number | null> = {
    '2K': useUpscaleCost(context, '2K', sourceWidth, sourceHeight, upscalePriced('2K')),
    '4K': useUpscaleCost(context, '4K', sourceWidth, sourceHeight, upscalePriced('4K')),
    '8K': useUpscaleCost(context, '8K', sourceWidth, sourceHeight, upscalePriced('8K')),
  };
  // 本机不支持抠图时不列抠图，后面的工具顺延（默认顺延出裁剪）。
  const definitions = orderedCanvasImageTools(context.canvasUiPreferences.image_toolbar.tool_ids)
    .filter(definition => definition.id !== 'removeBackground' || context.mattingAvailable !== false);
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
    if (definition.id === 'download') action = {
      ...common,
      label: `下载 ${node.title}`,
      icon: <Icon />,
      disabled: !currentVersionId,
      href: currentVersionId ? canvasDownloadUrl(context.projectId, currentVersionId) : undefined,
      run: () => undefined,
    };
    if (definition.id === 'resize') action = {
      ...common,
      label: resizeUnlocked ? `锁定 ${node.title} 比例` : `自由缩放 ${node.title}`,
      text: resizeUnlocked ? '锁定比例' : '自由缩放',
      icon: resizeUnlocked ? <LockIcon /> : <UnlockIcon />,
      disabled: replacing,
      run: () => context.toggleFreeResize(node),
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
      disabled: !imageContent?.width || !imageContent.height || replacing,
      run: () => toggleSplit(!splitOpenRef.current),
    };
    if (definition.id === 'upscale') {
      const longEdge = Math.max(imageContent?.width ?? 0, imageContent?.height ?? 0);
      const targets = CANVAS_UPSCALE_TARGETS.filter(target => target.longEdge > longEdge);
      action = {
        ...common,
        label: currentVersionId && targets.length === 0
          ? `${node.title} 已达 8K，无需放大`
          : `AI高清 ${node.title}`,
        icon: <Icon />,
        disabled: !currentVersionId || submitting || replacing || targets.length === 0,
        run: () => undefined,
        // 一次点击即提交计费重绘：菜单上写清用哪个模型、花多少钱。
        menu: targets.map(target => {
          const cost = upscaleCosts[target.id];
          const price = cost != null ? formatGenerationCost(cost) : '未计价';
          const model = upscaleChoice(context, target.id)?.name;
          return {
            id: target.id,
            title: target.id,
            detail: model ? `${model} · ${price}` : `长边 ${target.longEdge}px`,
            onSelect: () => context.upscaleImage(node, target.id),
          };
        }),
      };
    }
    if (definition.id === 'removeBackground') action = {
      ...common,
      label: `抠图 ${node.title}`,
      icon: <Icon />,
      disabled: !currentVersionId || replacing,
      run: () => {
        if (currentVersionId) context.removeBackground(node);
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
    settingsOpenRef.current = open;
    setSettingsOpen(open);
    onOverlayOpenChange(open);
  }

  // 菜单展开期间节点可能失去选中，工具栏要像设置弹窗一样保持可见。
  function updateMenuOpen(open: boolean) {
    onOverlayOpenChange(open || settingsOpenRef.current || splitOpenRef.current);
  }

  const layerActionDisabled = !currentVersionId || submitting || replacing;
  const compareSource = canvasCompareSource(imageContent, context.jobsByResultNodeId.get(node.id), context.resolveVersion);
  const editDisabled = !currentVersionId || submitting || replacing;
  const inpaintAction: ImageToolbarAction = {
    id: 'inpaint' as CanvasImageQuickToolId, label: `局部修改 ${node.title}`, text: '局部修改',
    icon: <BrushIcon />, disabled: editDisabled, run: () => context.openMaskEdit(node, 'inpaint'),
  };
  const inlineActions = [inpaintAction, ...actions.slice(0, IMAGE_TOOLBAR_INLINE_LIMIT)];
  const splitInline = inlineActions.some(action => action.id === 'split');
  const overflowActions: ImageToolbarAction[] = [
    ...actions.slice(IMAGE_TOOLBAR_INLINE_LIMIT),
    { id: 'annotate' as CanvasImageQuickToolId, label: `标注 ${node.title}`, text: '标注', icon: <EditIcon />,
      disabled: editDisabled, run: () => context.annotationController?.start(node) },
    { id: 'outpaint' as CanvasImageQuickToolId, label: `扩图 ${node.title}`, text: '扩图', icon: <OutpaintIcon />,
      disabled: editDisabled, run: () => context.openMaskEdit(node, 'outpaint') },
    { id: 'layers' as CanvasImageQuickToolId, label: `拆分 ${node.title} 的图层`, text: '拆分图层', icon: <LayersIcon />,
      disabled: layerActionDisabled, run: () => context.createLayerDecomposition(node) },
  ];

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
    <Popover open={splitOpen} onOpenChange={toggleSplit}>
      <PopoverAnchor virtualRef={splitAnchor} />
      {inlineActions.map(action => action.href ? (
        <MediaToolLink
          key={action.id}
          label={action.label}
          text={action.text}
          href={action.href}
        >
          <SwapIcon swapKey={action.text}>{action.icon}</SwapIcon>
        </MediaToolLink>
      ) : action.menu ? (
        <DropdownMenu key={action.id} onOpenChange={updateMenuOpen}>
          <DropdownMenuTrigger asChild>
            <MediaToolButton
              label={action.label}
              text={action.text}
              disabled={action.disabled}
              onClick={() => undefined}
            >
              <SwapIcon swapKey={action.text}>{action.icon}</SwapIcon>
            </MediaToolButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="center"
            className="nodrag min-w-36"
            onPointerDown={event => event.stopPropagation()}
          >
            {action.menu.map(item => (
              <DropdownMenuItem
                key={item.id}
                className="justify-between gap-4 tabular-nums"
                onSelect={item.onSelect}
              >
                <span>{item.title}</span>
                <span className="text-xs text-muted-foreground">{item.detail}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <MediaToolButton
          key={action.id}
          label={action.label}
          text={action.text}
          ref={action.id === 'split' ? splitAnchor : undefined}
          aria-haspopup={action.id === 'split' ? 'dialog' : undefined}
          aria-expanded={action.id === 'split' ? splitOpen : undefined}
          destructive={action.destructive}
          disabled={action.disabled}
          onClick={action.run}
        >
          <SwapIcon swapKey={action.text}>{action.icon}</SwapIcon>
        </MediaToolButton>
      ))}
      {onSave && (
        <MediaToolButton label={`保存 ${node.title}`} text={CANVAS_SAVE_ASSET_TEXT} onClick={onSave}><SaveAssetIcon /></MediaToolButton>
      )}
      {context.finalizeNode && <CanvasFinalizationMenu
        node={node} content={imageContent} context={context}
        disabled={!currentVersionId || replacing || submitting}
        onOverlayOpenChange={updateMenuOpen}
      />}
      {trailing}
      <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
      <DropdownMenu onOpenChange={updateMenuOpen}>
        <DropdownMenuTrigger asChild>
          <MediaToolButton ref={splitInline ? undefined : splitAnchor} label={`${node.title} 的更多工具`} text="更多" onClick={() => undefined}>
            <MoreIcon />
          </MediaToolButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="center"
          onCloseAutoFocus={event => { if (splitOpenRef.current) event.preventDefault(); }}
          className="nodrag min-w-40 [&_svg]:size-4"
          onPointerDown={event => event.stopPropagation()}
        >
          {overflowActions.map(action => action.menu ? (
            <DropdownMenuSub key={action.id}>
              <DropdownMenuSubTrigger disabled={action.disabled} aria-label={action.label} className="gap-2">
                {action.icon}{action.text}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-36" onPointerDown={event => event.stopPropagation()}>
                {action.menu.map(item => (
                  <DropdownMenuItem
                    key={item.id}
                    className="justify-between gap-4 tabular-nums"
                    onSelect={item.onSelect}
                  >
                    <span>{item.title}</span>
                    <span className="text-xs text-muted-foreground">{item.detail}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : action.href ? (
            <DropdownMenuItem key={action.id} asChild className="gap-2">
              <a href={action.href} aria-label={action.label}>{action.icon}{action.text}</a>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={action.id}
              aria-label={action.label}
              disabled={action.disabled}
              className="gap-2"
              onSelect={action.run}
            >
              {action.icon}{action.text}
            </DropdownMenuItem>
          ))}
          {compareSource && context.createCompareNode && (
            <DropdownMenuItem aria-label={`对比 ${node.title} 与原图`} disabled={replacing} className="gap-2"
              onSelect={() => context.createCompareNode?.(node, compareSource)}>
              <CompareIcon />对比
            </DropdownMenuItem>
          )}
          {onToggleHidden && (
            <DropdownMenuItem aria-label={node.hidden ? `显示 ${node.title} 的内容` : `遮盖 ${node.title} 的内容`}
              className="gap-2" onSelect={onToggleHidden}>
              {node.hidden ? <ShowIcon /> : <HideIcon />}{node.hidden ? '显示内容' : '遮盖内容'}
            </DropdownMenuItem>
          )}
          {onShare && (
            <DropdownMenuItem aria-label={`分享 ${node.title}`} className="gap-2" onSelect={onShare}>
              <ShareIcon />{CANVAS_SHARE_TEXT}
            </DropdownMenuItem>
          )}
          {content?.kind === 'image' && context.createPluginNodeFromMedia && pluginImageActions.length > 0 && <>
            <DropdownMenuSeparator />
            {pluginImageActions.map(({ plugin, action, Icon }) => (
              <PluginImageActionItem key={`${plugin.id}:${action.id}`} label={action.label} Icon={Icon}
                module={context.hostPlugins?.get(plugin.id)}
                onSelect={() => context.createPluginNodeFromMedia?.(node, plugin, action)} />
            ))}
          </>}
          <DropdownMenuSeparator />
          <DropdownMenuItem aria-label="配置图片快捷工具" className="gap-2" onSelect={openSettings}>
            <ParamsIcon />自定义工具条
          </DropdownMenuItem>
          {context.deleteNodes && <>
            <DropdownMenuSeparator />
            <DropdownMenuItem aria-label={`删除 ${node.title}`} className="gap-2 text-destructive"
              onSelect={() => context.deleteNodes?.(new Set([node.id]))}>
              <DeleteIcon />删除<span aria-hidden="true" className="ml-auto pl-4 font-mono text-xs text-muted-foreground">{DELETE_KEY_HINT}</span>
            </DropdownMenuItem>
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
      {imageContent?.width && imageContent.height ? <CanvasSplitGridPopover width={imageContent.width} height={imageContent.height}
        onReturnFocus={() => splitAnchor.current?.focus({ preventScroll: true })}
        onSubmit={operation => { toggleSplit(false); context.splitImage(node, operation); }}
        onCustom={() => { toggleSplit(false); context.openMediaOperation(node, 'split'); }} /> : null}
      <CanvasImageToolbarPreferencesDialog
        open={settingsOpen}
        value={context.canvasUiPreferences.image_toolbar}
        excludedToolIds={context.mattingAvailable === false ? MATTING_UNAVAILABLE_TOOL_IDS : undefined}
        saving={settingsSaving}
        error={settingsError}
        onOpenChange={updateSettingsOpen}
        onSave={value => void saveSettings(value)}
      />
    </Popover>
  );
}

/** 文本节点的面板：「内容」读全文、改字、让模型改写；「生成」是原来的生成设置。
 *  有正文默认「内容」，空节点默认「生成」（2026-11-27 飙哥定）。 */
function CanvasTextNodePanel({ node, draft, context, embedded = false, onClose, focusRequest = 0 }: {
  node: Extract<CanvasNode, { type: 'text' }>;
  draft: CanvasGenerationDraft;
  context: CanvasNodeContextValue;
  embedded?: boolean;
  onClose?: () => void;
  focusRequest?: number;
}) {
  const content = context.resolveVersion(node.data.current_version_id);
  const [tab, setTab] = useState(() => defaultTextPanelTab(content?.kind === 'text' ? content.text : null));
  // 改写要求放在这一层：切到「生成」再切回来，写好的要求还在。
  const [instruction, setInstruction] = useState('');
  useEffect(() => {
    if (focusRequest) setTab('content');
  }, [focusRequest]);
  const header = (
    <Segmented aria-label="文本面板" className="grid-cols-2">
      <SegmentedItem value="content" selected={tab === 'content'} onSelect={() => setTab('content')} className="px-4 text-xs">内容</SegmentedItem>
      <SegmentedItem value="generate" selected={tab === 'generate'} onSelect={() => setTab('generate')} className="px-4 text-xs">生成</SegmentedItem>
    </Segmented>
  );
  return tab === 'content' ? (
    <CanvasTextContentPanel node={node} draft={draft} context={context} header={header}
      embedded={embedded} onClose={onClose} focusRequest={focusRequest}
      instruction={instruction} onInstructionChange={setInstruction} />
  ) : (
    <CanvasGenerationComposer node={node} draft={draft} context={context} header={header}
      embedded={embedded} onClose={onClose} />
  );
}

export function CanvasGenerationComposer({
  node,
  draft,
  context,
  embedded = false,
  onClose,
  header,
}: {
  node: CanvasNode;
  draft: CanvasGenerationDraft;
  context: CanvasNodeContextValue;
  embedded?: boolean;
  onClose?: () => void;
  /** 面板顶部一行（文本节点的「内容 / 生成」切换）。 */
  header?: ReactNode;
}) {
  const editingExistingVideo = draft.mode === 'video'
    && Boolean(context.mentionReferencesByNodeId.get(node.id)?.some(reference => reference.kind === 'video'));
  const providers = context.generationProviders ?? context.keys;
  // 语音节点与音乐节点同为音频节点：按当前模型所属的族只列本族模型（没有选中模型时不限）。
  const draftKey = draft.mode === 'audio' ? providerForAlias(providers, draft.alias) : undefined;
  const draftModel = draftKey?.models.find(candidate => candidate.id === draft.model);
  const audioFamily = draftKey && draftModel ? canvasAudioFamily(draftKey, draftModel) ?? undefined : undefined;
  const acceptsModel = (model: KeyView['models'][number], key: KeyView) => (
    canvasGenerationModelSupportsMode(key, model, draft.mode, { editingExistingVideo, audioFamily })
  );
  const availableKeys = providers.filter(key => key.models.some(model => acceptsModel(model, key)));
  const modelChoices: CanvasModelChoice[] = availableKeys.flatMap(key => key.models
    .filter(model => acceptsModel(model, key))
    .map(model => ({ key, model })));
  const selectedKey = providerForAlias(providers, draft.alias);
  const models = (selectedKey?.models ?? []).filter(model => acceptsModel(model, selectedKey!));
  const selectedModel = models.find(model => model.id === draft.model);
  // 「自动」按组内第一个成员算参数（一期就是它出图）；图片可选范围取成员交集。
  const channel = selectedKey && selectedModel ? routeChannel(selectedKey, selectedModel) : null;
  const audioCaps = draft.mode === 'audio' && channel
    ? audioCapsOf(channel.model.id, channel.key.provider, channel.model.protocol, channel.model.declared)
    : null;
  const channelModelId = channel?.model.id ?? draft.model;
  const channelProtocol = channel?.model.protocol;
  const channelDeclared = channel?.model.declared;
  const imageCaps = draft.mode === 'image' && selectedModel
    ? selectionImageCaps(selectedKey, draft.model)
    : null;
  // 能估价的生成入口在按钮旁显示「约 x¥」（规格 2.5）；估价接口目前只按图片计价。
  const estimate = useGenerationEstimate(draft.alias ?? undefined, draft.model ?? '',
    draft.params as Record<string, unknown>, draft.mode === 'image' && Boolean(selectedModel));
  const { status: comfyStatus, recheck: recheckComfy } = useComfyStatus(
    draft.mode === 'image' ? localComfyUrl(selectedKey, selectedModel) : null,
  );
  const comfyStopped = comfyStatus === 'stopped';
  // 两层都要 memo：canvasVideoEditCaps 每次调用都返回新对象，展开一层又造一个新对象。
  // 下面那条纠偏 effect 依赖 videoCaps，不 memo 的话它每一次 render 都重跑，而它会 commit
  // 首尾帧连接。selectedModel 取自 context.keys 里的元素，引用本身是稳的。
  const rawVideoCaps = useMemo(
    () => draft.mode === 'video' && selectedModel
      ? canvasVideoEditCaps(channelModelId, channelProtocol, channelDeclared)
      : null,
    [draft.mode, channelModelId, channelProtocol, channelDeclared, selectedModel],
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
  const nodeRunState = canvasNodeRunState(node, context.jobsByRunId, context.jobsByResultNodeId);
  const activeJob = nodeRunState.job;
  const submitting = context.submittingNodeIds.has(node.id);
  const running = nodeRunState.status === 'loading';
  const queued = Boolean(context.queuedNodeIds?.has(node.id));
  const generationButtonState = running
    ? activeJob?.cancel_requested_at ? 'stopping' : 'running'
    : queued ? 'queued' : submitting ? 'submitting' : 'idle';
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const modeLabel = CANVAS_GENERATION_MODE_LABELS[draft.mode];
  const panelLabel = `${modeLabel}设置`;
  const mentionReferences = context.mentionReferencesByNodeId.get(node.id)
    ?? EMPTY_CANVAS_MENTION_REFERENCES;
  // 提示词摘要态 / 展开态（飙哥 2026-09-14）：已有内容时默认只露 3 行，点提示词或「展开」进编辑态；
  // 面板外点一下或 Esc 收回。收起由明确动作触发，不挂 blur——切窗口 / 输入法候选框夺焦都会误收。
  const panelRef = useRef<HTMLElement>(null);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const promptCollapsed = !promptExpanded && isLongCanvasPrompt(draft.prompt);
  useEffect(() => { setPromptExpanded(false); }, [node.id]);
  useEffect(() => {
    if (!promptExpanded) return;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>('[role="combobox"][aria-label="提示词"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || panel?.contains(target) || target.closest('[data-canvas-prompt-menu]')) return;
      setPromptExpanded(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [promptExpanded]);
  const materialReferences = context.materialReferences;
  const mentionsEnabled = !usesVideoFrameSlots;
  const frameModeHasMentions = usesVideoFrameSlots && canvasMentionMatches(draft.prompt).length > 0;
  const missingMentionIds = mentionsEnabled
    ? missingCanvasMentionIds(draft.prompt, mentionReferences)
    : [];
  const missingVideoFrame = usesVideoFrameSlots && Object.values(videoFrames).some(sourceNodeId => (
    sourceNodeId && !materialReferences.some(reference => (
      reference.nodeId === sourceNodeId && reference.kind === 'image'
    ))
  ));
  const connectedMaterialNodeIds = context.connectedMaterialNodeIdsByNodeId.get(node.id)
    ?? EMPTY_CANVAS_NODE_IDS;
  const connectedVideoMediaCounts = materialReferences.reduce(
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
  // 所有普通连接都参与；首尾帧槽位单独校验，额外普通连接必须移除。
  const pendingInputs = usesVideoFrameSlots
    ? EMPTY_CANVAS_PENDING_INPUTS
    : context.pendingInputNodesByNodeId?.get(node.id) ?? EMPTY_CANVAS_PENDING_INPUTS;
  const referenceProblem = usesVideoFrameSlots && connectedMaterialNodeIds.size > 0
    ? '首尾帧模式请移除普通参考连接，使用首帧或尾帧槽位。'
    : !usesVideoFrameSlots && Object.values(videoFrames).some(Boolean)
      ? '请先移除首尾帧连接，再使用全能参考。'
      : referenceErrorMessage({
    missingMentionCount: missingMentionIds.length,
    frameModeHasMentions,
    missingVideoFrame,
    videoReferenceCapacityExceeded,
    pendingInputTitles: pendingInputs.map(input => input.title),
  });
  // 结构性问题优先，因为补引用也无法让一个没有模型或提示词的请求变得可提交。
  const generateBlock = canvasGenerateBlock({
    mode: draft.mode,
    modelChoiceCount: modelChoices.length,
    keyCount: context.keys.length,
    alias: selectedKey?.alias ?? draft.alias,
    modelSelected: Boolean(selectedModel),
    prompt: draft.prompt,
    allowEmptyPrompt: selectedModel?.workflow_inputs != null && !selectedModel.workflow_inputs.some(input => input.type === 'prompt'),
    connectedInputCount: mentionReferences.length,
  });
  const workflowWithoutPrompt = selectedModel?.workflow_inputs != null
    && !selectedModel.workflow_inputs.some(input => input.type === 'prompt');
  const workflowReferenceProblem = workflowReferenceError(selectedModel?.workflow_inputs,
    connectedVideoMediaCounts.image, Boolean(draft.params.mask_image));
  const blockedReason = generateBlock?.message
    ?? (workflowWithoutPrompt ? null : promptVariableError(draft.prompt)) ?? referenceProblem ?? workflowReferenceProblem;

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
    context.updateNode(node.id, current => withGenerationDraft(current, updater(generationDraft(current) ?? draft)));
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
    const sizeError = draft.mode === 'image' ? imageSizeError(draft.params, draft.model) : null;
    // 提交不成（参数不合法、被挡、服务端拒绝）时按钮原位微抖（Q14），报错条照旧说原因。
    if (sizeError) {
      context.reportError?.(sizeError);
      shakeOnError(submitButtonRef.current);
      return;
    }
    if (blockedReason) {
      context.reportError?.(blockedReason);
      shakeOnError(submitButtonRef.current);
      return;
    }
    void context.submitRun(node.id).then(outcome => {
      const status = (outcome as { status?: string } | undefined)?.status;
      if (status && status !== 'submitted') shakeOnError(submitButtonRef.current);
    });
  }

  return (
    <section
      ref={panelRef}
      aria-label={panelLabel}
      data-floating-node-panel="true"
      className={cn(
        'nodrag relative',
        embedded && 'nowheel',
        embedded ? 'canvas-mobile-generation' : 'overflow-hidden rounded-xl border border-border bg-glass p-3 backdrop-blur-glass shell-glow',
      )}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      // 捕获阶段：提示词编辑器自己会吃掉 Escape（关 @ 菜单）；菜单开着时让它先关，否则收面板。
      onKeyDownCapture={event => {
        if (event.key !== 'Escape' || !promptExpanded) return;
        if (document.querySelector('[data-canvas-prompt-menu]')) return;
        setPromptExpanded(false);
        (document.activeElement as HTMLElement | null)?.blur();
      }}
    >
      {onClose && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 z-10 size-7 rounded-full"
          aria-label={`关闭${panelLabel}`}
          onClick={onClose}
        >
          <CloseIcon aria-hidden="true" />
        </Button>
      )}
      {header && <div className="mb-2 flex items-center pr-8">{header}</div>}
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
      ) : null}
      {(!usesVideoFrameSlots || connectedMaterialNodeIds.size > 0) && (
        <CanvasMaterialConnections
          node={node}
          materials={materialReferences}
          connectedReferences={mentionReferences.filter(reference => connectedMaterialNodeIds.has(reference.nodeId))}
          imageLabels={selectedModel?.workflow_inputs?.filter(input => input.type === 'image').map(input => input.label)}
          connectedNodeIds={context.connectedMaterialNodeIdsByNodeId.get(node.id) ?? EMPTY_CANVAS_NODE_IDS}
          limits={draft.mode === 'video' ? selectedVideoReferenceLimits : imageCaps?.maxRefImages != null ? { images: imageCaps.maxRefImages, videos: 0, audios: 0 } : null}
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
          annotationLayerAvailable={draft.mode === 'image' && !!imageCaps?.complexities}
          onAnnotationDeliveryChange={context.setAnnotationDelivery
            ? (sourceNodeId, delivery) => context.setAnnotationDelivery?.(sourceNodeId, node.id, delivery)
            : undefined}
          onReorder={context.reorderMaterialConnections
            ? orderedNodeIds => context.reorderMaterialConnections?.(node.id, orderedNodeIds)
            : undefined}
        />
      )}
      {/* 摘要态 ↔ 编辑态：一块收起、一块展开，高度在 300ms 里从三行过渡到编辑框，不瞬跳。 */}
      <Collapse open={promptCollapsed}>
        <Button variant="bare"
          type="button"
          aria-label="展开提示词"
          className="block w-full rounded-md px-3 pb-1 pt-3 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setPromptExpanded(true)}
        >
          {/* padding 不能放在 line-clamp 元素上：-webkit-box 会把第 4 行露进 padding 区。 */}
          <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
            {canvasPromptSummary(draft.prompt, mentionReferences)}
          </p>
          <span className="block text-right text-xs text-muted-foreground">展开</span>
        </Button>
      </Collapse>
      <Collapse open={!promptCollapsed}>
      <CanvasPromptInput
        disabled={selectedModel?.workflow_inputs != null && !selectedModel.workflow_inputs.some(input => input.type === 'prompt')}
        value={selectedModel?.workflow_inputs != null && !selectedModel.workflow_inputs.some(input => input.type === 'prompt') ? '' : draft.prompt}
        references={mentionReferences}
        mentionsEnabled={mentionsEnabled}
        disabledMentionHint={usesVideoFrameSlots ? '首尾帧模式不使用 @' : undefined}
        className="max-h-[50vh]"
        onSubmit={running || submitting || queued ? undefined : submitGeneration}
        onFocus={context.recordHistory}
        // 用独立 key：node.id 那把在合并任务结果时还兼作「正文有本地未存改动」的判据，
        // 结果节点自己就带生成面板，改下一轮提示词不能让刚出的图被当成本地正文挡在外面。
        onEditingChange={editing => context.setTextEditing?.(`prompt:${node.id}`, editing)}
        onChange={prompt => updateDraft(current => ({
          ...current,
          prompt,
          params: current.params,
          updated_at: new Date().toISOString(),
        }))}
        onPreviewReference={reference => context.previewContent(
          reference.versionId,
          reference.title,
          reference.nodeId,
        )}
        placeholder={selectedModel?.workflow_inputs != null && !selectedModel.workflow_inputs.some(input => input.type === 'prompt') ? '此工作流无需提示词' : draft.mode === 'video'
          ? usesVideoFrameSlots
            ? '描述镜头运动与画面变化'
            : '描述镜头运动与画面变化，输入 @ 引用已连接内容'
          : draft.mode === 'audio'
            ? audioCaps?.family === 'music'
              ? '描述风格、情绪、乐器，输入 @ 引用已连接内容'
              : '输入需要朗读的文本，输入 @ 引用已连接内容'
            : draft.mode === 'text'
              ? '描述要创作的文案、脚本或内容，输入 @ 引用已连接内容'
              : '描述任何你想要生成的内容，输入 @ 引用已连接内容'}
      />
      </Collapse>
      {isCanvasContentNode(node) && (node.type === 'audio' || context.jobsByResultNodeId.get(node.id)?.some(job => job.canvas_run?.snapshot?.normalized_params?.group_run)) && (
        <CandidateHistory
          nodeId={node.id}
          primaryVersionId={node.data.current_version_id}
          context={context}
          running={Boolean(running)}
          submitting={submitting}
        />
      )}
      {!running && workflowReferenceProblem && <p role="status" className="mt-2 text-xs text-muted-foreground">{workflowReferenceProblem}</p>}
      <div className="mt-2 flex items-end gap-1.5 rounded-xl border border-border/70 bg-card/55 p-1.5">
        <div className={cn('flex min-w-0 flex-1 items-center gap-1.5', draft.mode === 'video' ? 'flex-nowrap' : 'flex-wrap')}>
          <CanvasModelPicker
          fit={draft.mode === 'video' ? 'content' : 'fill'}
          choices={modelChoices}
          params={draft.params}
          alias={draft.alias ?? null}
          model={draft.model}
          onSelect={({ key: chosenKey, model: chosenModel }) => {
            const { key, model } = routeChannel(chosenKey, chosenModel);
            const nextImageParams = draft.mode === 'image'
              ? normalizeCanvasImageParams(
                  model.id, key.provider, draft.params, key.base_url,
                  selectionImageCaps(chosenKey, chosenModel.id),
                ) : null;
            if (draft.mode === 'image') {
              const next = nextImageParams!;
              next.workflow_inputs = compatibleWorkflowValues(chosenModel.workflow_inputs, draft.params.workflow_inputs);
              const modeChanged = hasImageSizeSelection(draft.params) && imageSizeMode(next) !== imageSizeMode(draft.params);
              if (!modeChanged && imageSizeMode(next) === 'custom' && !imageSizeError(next, model.id)) {
                const normalized = normalizeImagePixelSize(next.size!, model.id, key.base_url);
                next.size = normalized;
                next.custom_size = normalized;
              }
            }
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
                context.convertVideoFrameConnections?.(node.id, false, 0);
              }
            }
            updateDraftWithHistory(current => ({
              ...current,
              alias: storedAlias(chosenKey),
              model: chosenModel.id,
              params: draft.mode === 'image'
                ? nextImageParams!
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
                      model.declared,
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
            workflowInputs={selectedModel?.workflow_inputs}
            model={channelModelId}
            baseUrl={channel?.key.base_url}
            params={draft.params}
            onPatch={patch => updateDraftWithHistory(current => {
              const merged = { ...current.params, ...patch };
              const currentKey = providerForAlias(providers, current.alias);
              const currentModel = currentKey?.models.find(model => model.id === current.model);
              const target = currentKey && currentModel ? routeChannel(currentKey, currentModel) : null;
              return {
                ...current,
                params: normalizeCanvasImageParams(
                  target?.model.id ?? current.model,
                  target?.key.provider,
                  merged,
                  target?.key.base_url,
                  currentKey && currentModel
                    ? selectionImageCaps(currentKey, currentModel.id) : undefined,
                ),
              };
            })}
          />
        )}
          {draft.mode === 'video' && videoCaps && (
          <VideoControls
            seed={draft.params.seed}
            onClearSeed={() => updateDraftWithHistory(current => ({
              ...current, params: { ...current.params, seed: undefined },
            }))}
            fit="fill"
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
              context.convertVideoFrameConnections?.(node.id, mode !== 'omni', videoCaps?.maxFrames ?? 2);
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
          {draft.mode === 'audio' && channel && audioCaps?.family === 'music' && (
          <CanvasMusicSettings
            caps={audioCaps}
            modelId={channel.model.id}
            params={draft.params}
            onPatch={patch => updateDraftWithHistory(current => ({
              ...current,
              params: normalizeCanvasAudioParams(
                channel.model.id,
                channel.key.provider,
                channel.model.protocol,
                { ...current.params, ...patch },
                channel.model.declared,
              ),
            }))}
          />
        )}
          {draft.mode === 'audio' && channel && audioCaps?.family === 'speech' && (
          <CanvasAudioSettings
            caps={audioCaps}
            params={draft.params}
            onPatch={patch => updateDraftWithHistory(current => ({
              ...current,
              params: normalizeCanvasAudioParams(
                channel.model.id,
                channel.key.provider,
                channel.model.protocol,
                { ...current.params, ...patch },
                channel.model.declared,
              ),
            }))}
          />
        )}
        </div>
        {!running && !workflowReferenceProblem && comfyStopped ? (
          <Hint label="点击重新检查连接">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              data-testid="canvas-comfy-stopped-hint"
              onClick={recheckComfy}
              className="h-auto shrink-0 gap-1.5 px-1.5 py-0.5 font-normal text-[color:var(--status-failed)] hover:text-[color:var(--status-failed)]"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
              ComfyUI 未启动
            </Button>
          </Hint>
        ) : !running && estimate != null && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">约 {formatGenerationCost(estimate)}</span>
        )}
        {/* 开始 ↔ 停止同一个按钮壳：底色随状态过渡，图标原位换态，不整块换一个按钮。 */}
        {running && !activeJob ? null : (
          <Button
            ref={submitButtonRef}
            type="button"
            size="sm"
            variant={running ? 'outline' : 'default'}
            className="shrink-0 transition-colors"
            disabled={running ? Boolean(activeJob?.cancel_requested_at) : submitting || queued || Boolean(workflowReferenceProblem)}
            onClick={running ? () => void context.cancelRun(activeJob!.canvas_run!.run_id) : submitGeneration}
          >
            <SwapIcon swapKey={generationButtonState}>
              {generationButtonState === 'stopping' || generationButtonState === 'submitting' || generationButtonState === 'queued'
                ? <LoadingIcon className="animate-spin" aria-hidden="true" />
                : generationButtonState === 'running' ? <StopIcon aria-hidden="true" /> : <AiIcon aria-hidden="true" />}
            </SwapIcon>
            {generationButtonState === 'stopping' ? '停止中…'
              : generationButtonState === 'running' ? '停止'
                : generationButtonState === 'queued' ? '排队中…'
                  : generationButtonState === 'submitting' ? '提交中…'
                    : '生成'}
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
        <Hint label="互换首尾帧"><Button variant="bare"
          type="button"
          aria-label="互换首尾帧"
          disabled={!current.first_frame && !current.last_frame}
          className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"
          onClick={() => onChange({
            first_frame: current.last_frame,
            last_frame: current.first_frame,
          })}
        >
          <ExchangeIcon aria-hidden="true" />
        </Button></Hint>
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
      <Hint label={selected ? `预览${label}` : `在画布选择${label}`}><Button variant="bare"
        type="button"
        disabled={materials.length === 0}
        aria-label={selected ? `预览${label} ${selected.title}` : `在画布选择${label}`}
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
            <AddIcon className="mx-auto" aria-hidden="true" />
            <span className="text-xs">{selectedNodeId ? '失效' : label}</span>
          </span>
        )}
      </Button></Hint>
      {selectedNodeId && (
        <Hint label={`移除${label}`}><Button variant="bare"
          type="button"
          aria-label={`移除${label}`}
          className="absolute -right-1 -top-1 z-10 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={() => onSelect(null)}
        >
          <CloseIcon size="sm" aria-hidden="true" />
        </Button></Hint>
      )}
      {selected && (
        <span className="pointer-events-none absolute inset-x-1 bottom-1 rounded bg-background/80 px-1 text-center text-xs text-foreground">
          {label}
        </span>
      )}
    </div>
  );
}

const INSTANT_LAYOUT = { layout: { duration: 0 } } as const;
/** 拖动排序时其余缩略图让位：无回弹的 snappy 弹簧，中途换方向带着速度接上。 */
const REORDER_LAYOUT = { layout: MOTION_SPRING.snappy } as const;

const ANNOTATION_DELIVERY_LABELS: Record<CanvasAnnotationDelivery, string> = {
  composite: '合成图',
  markup: '标注层',
};

/** 带标注参考的发送形式：合成图（原图烙上标注）或原图 + 标注层（GPT Image 2.6 markup）。 */
function AnnotationDeliveryMenu({ title, delivery, onChange }: {
  title: string;
  delivery: CanvasAnnotationDelivery;
  onChange: (delivery: CanvasAnnotationDelivery) => void;
}) {
  const Icon = delivery === 'markup' ? LayersIcon : EditIcon;
  return (
    <DropdownMenu>
      <Hint label={`标注 · ${ANNOTATION_DELIVERY_LABELS[delivery]}`}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon"
            type="button"
            aria-label={`${title} 的标注发送方式：${ANNOTATION_DELIVERY_LABELS[delivery]}`}
            className="absolute bottom-0 right-0 z-10 size-4 rounded-full border-primary bg-popover p-0 text-primary [&_svg]:size-2.5"
          >
            <Icon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="start" className="w-32">
        {(['composite', 'markup'] as const).map(value => (
          <DropdownMenuItem key={value} onSelect={() => onChange(value)}>
            <span className="flex-1">{ANNOTATION_DELIVERY_LABELS[value]}</span>
            {delivery === value && <CheckIcon size="sm" aria-hidden="true" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CanvasMaterialConnections({
  imageLabels,
  node,
  materials,
  connectedNodeIds,
  connectedReferences,
  limits,
  picking,
  onPreview,
  onBeginPick,
  onConnectedChange,
  onReorder,
  annotationLayerAvailable = false,
  onAnnotationDeliveryChange,
}: {
  node: CanvasNode;
  materials: readonly CanvasMaterialReference[];
  connectedNodeIds: ReadonlySet<string>;
  connectedReferences: readonly CanvasMentionReference[];
  imageLabels?: string[];
  limits?: VideoReferenceLimits | null;
  picking: boolean;
  onPreview: (reference: CanvasMaterialReference) => void;
  onBeginPick: (selectableNodeIds: ReadonlySet<string>) => void;
  onConnectedChange: (sourceNodeId: string, connected: boolean) => void;
  onReorder?: (orderedNodeIds: readonly string[]) => void;
  /** 目标模型与渠道能收 GPT Image 2.6 的 markup 标注层时，带标注参考可选「合成图 / 标注层」。 */
  annotationLayerAvailable?: boolean;
  onAnnotationDeliveryChange?: (sourceNodeId: string, delivery: CanvasAnnotationDelivery) => void;
}) {
  const choices = materials.filter(reference => reference.nodeId !== node.id);
  // 拖动期间只动本地顺序（编号跟着实时变），松手才写回文档，一次拖拽一条撤销记录。
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const draggedRef = useRef(false);
  // Reorder.Item 常开 layout 动画（排序靠它测量，关不掉）：画布平移 / 缩放时缩略图的屏幕位置一变，
  // 它就补间追过去，像果冻一样拖在后面、甚至飞出节点。不在拖动排序时补间时长为 0，直接到位。
  const [dragging, setDragging] = useState(false);
  const referenceById = new Map(connectedReferences.map(reference => [reference.nodeId, reference]));
  const connected = dragOrder
    ? labelCanvasMentionReferences(dragOrder.flatMap(id => referenceById.get(id) ?? []))
    : connectedReferences;
  const updateDragOrder = (order: string[]) => {
    dragOrderRef.current = order;
    setDragOrder(order);
  };
  const finishDrag = () => {
    const order = dragOrderRef.current;
    dragOrderRef.current = null;
    setDragOrder(null);
    setDragging(false);
    if (order) onReorder?.(order);
    // 松手那一下还会触发一次 click，别把它当成「查看素材」。
    window.setTimeout(() => { draggedRef.current = false; }, 0);
  };
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
        <Reorder.Group
          as="div"
          axis="x"
          values={connected.map(reference => reference.nodeId)}
          onReorder={updateDragOrder}
          className="flex shrink-0 items-center gap-2"
        >
        {connected.map(reference => {
          const detailVisible = hoveredMaterial?.reference.nodeId === reference.nodeId;
          return (
            <Reorder.Item
              key={reference.nodeId}
              as="span"
              value={reference.nodeId}
              drag={onReorder && connected.length > 1 ? 'x' : false}
              transition={dragging ? REORDER_LAYOUT : INSTANT_LAYOUT}
              whileDrag={{ zIndex: 20 }}
              onDragStart={() => {
                draggedRef.current = true;
                setDragging(true);
                setHoveredMaterial(null);
                dragOrderRef.current = connected.map(item => item.nodeId);
              }}
              onDragEnd={finishDrag}
              className={cn('relative size-12 shrink-0', onReorder && connected.length > 1 && 'cursor-grab active:cursor-grabbing')}
            >
              <Hint label={`${reference.label} · ${reference.title}`}><Button variant="bare"
                type="button"
                aria-label={`查看已对接素材 ${reference.title}`}
                aria-describedby={detailVisible ? `canvas-material-detail-${reference.nodeId}` : undefined}
                className="relative grid size-12 place-items-center overflow-hidden rounded-lg border border-border bg-secondary/55 text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onMouseEnter={event => showMaterialDetail(reference, event.currentTarget)}
                onMouseLeave={() => setHoveredMaterial(null)}
                onFocus={event => showMaterialDetail(reference, event.currentTarget)}
                onBlur={() => setHoveredMaterial(null)}
                onClick={() => { if (!draggedRef.current) onPreview(reference); }}
              >
                <CanvasMaterialPreview reference={reference} />
                {reference.annotated && !(annotationLayerAvailable && onAnnotationDeliveryChange) && <Hint label="带标注"><span className="absolute bottom-0 right-0 z-10 grid size-3.5 place-items-center rounded-full border border-primary bg-popover text-primary"><EditIcon size="sm" /></span></Hint>}
                <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 text-xs text-foreground">
                  {reference.kind === 'image' ? imageLabels?.[connected.filter(item => item.kind === 'image').findIndex(item => item.nodeId === reference.nodeId)] ?? reference.label : reference.label}
                </span>
              </Button></Hint>
              {reference.annotated && annotationLayerAvailable && onAnnotationDeliveryChange && (
                <AnnotationDeliveryMenu
                  title={reference.title}
                  delivery={reference.annotationDelivery === 'composite' ? 'composite' : 'markup'}
                  onChange={delivery => onAnnotationDeliveryChange(reference.nodeId, delivery)}
                />
              )}
              <Button variant="bare"
                type="button"
                aria-label={`取消对接素材 ${reference.title}`}
                className="absolute -right-1 -top-1 z-10 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => onConnectedChange(reference.nodeId, false)}
              >
                <CloseIcon size="sm" aria-hidden="true" />
              </Button>
            </Reorder.Item>
          );
        })}
        </Reorder.Group>
        {(imageLabels == null || connected.filter(reference => reference.kind === 'image').length < imageLabels.length) && <Hint label="在画布选择素材"><Button variant="bare"
          type="button"
          aria-label={`为 ${node.title} 在画布选择素材`}
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
          <AddIcon size="lg" aria-hidden="true" />
        </Button></Hint>}
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
    ? VideoFileIcon
    : reference.kind === 'audio'
      ? AudioFileIcon
      : TextIcon;
  return <Icon aria-hidden="true" />;
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
      {node.type === 'text' ? (
        <CanvasTextNodePanel
          embedded
          node={node}
          draft={draft}
          context={context}
          onClose={() => context.generationPanel.dismiss(node.id)}
        />
      ) : (
        <CanvasGenerationComposer
          embedded
          node={node}
          draft={draft}
          context={context}
          onClose={() => context.generationPanel.dismiss(node.id)}
        />
      )}
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
  const jobs = context.jobsByResultNodeId.get(nodeId) ?? [];
  const { current, history } = presentCanvasCandidates(jobs);
  const known = new Set([...current, ...history].map(entry => entry.candidate.version_id));
  const previous = [...new Set(jobs.map(job => job.canvas_run?.snapshot?.normalized_params?.group_run?.previous_version_id))]
    .filter((id): id is string => !!id && !known.has(id) && !!context.resolveVersion(id));
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
      {history.length + previous.length > 0 && (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none py-1">历史候选 · {history.length + previous.length}</summary>
          {previous.map(id => <Button key={id} size="sm" variant="ghost"
            disabled={running || submitting || id === primaryVersionId}
            onClick={() => context.selectCandidate(nodeId, id)}>
            {new Date(context.resolveVersion(id)!.created_at).toLocaleString()} · 执行前版本
          </Button>)}
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
  const gridRef = useRef<HTMLDivElement>(null);
  const readyKey = entries.filter(({ candidate }) => candidate.version_id).map(({ candidate }) => candidate.candidate_id).join('|');
  const seenReady = useRef<Set<string> | null>(null);
  // 候选出图完成时依次浮现；打开面板时已有的结果不播。
  useLayoutEffect(() => {
    const ready = readyKey ? readyKey.split('|') : [];
    const seen = seenReady.current;
    seenReady.current = new Set(ready);
    if (!seen || prefersReducedMotion()) return;
    const fresh = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-candidate-id]') ?? [])
      .filter(element => ready.includes(element.dataset.candidateId ?? '') && !seen.has(element.dataset.candidateId ?? ''));
    if (!fresh.length) return;
    clearOnFinish(
      animate(fresh, { opacity: [0, 1], scale: [0.96, 1] }, { duration: MOTION_DURATION.slow, ease: MOTION_EASE.out, delay: stagger(MOTION_STAGGER) }),
      fresh,
    );
  }, [readyKey]);

  return (
    <div ref={gridRef} className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={label}>
      {entries.map(({ candidate }) => {
        const version = context.resolveVersion(candidate.version_id);
        return (
          <div
            key={candidate.candidate_id}
            data-candidate-id={candidate.candidate_id}
            className={cn(
              'relative min-h-20 overflow-hidden rounded-md border bg-secondary/30',
              candidate.version_id === primaryVersionId ? 'border-primary' : 'border-border',
            )}
          >
            {version?.kind === 'text'
              ? <p className="line-clamp-4 min-h-20 whitespace-pre-wrap p-2 text-xs leading-relaxed text-foreground">{readablePromptVariables(version.text)}</p>
              : version
                ? <MediaPreview kind={version.kind} src={canvasMediaUrl(context.projectId, version.version_id, version.kind === 'image' ? 160 : undefined)} />
                : (
                <div className="grid min-h-20 place-items-center px-2 text-center text-xs text-muted-foreground">
                  {candidate.status === 'pending'
                    ? <LoadingIcon className="animate-spin" aria-label="候选生成中" />
                    : candidate.status === 'canceled'
                      ? canvasNodeRunDisplayError(candidate.error, '已停止')
                      : canvasNodeRunDisplayError(candidate.error, '结果待同步')}
                </div>
                )}
            <span className="absolute left-1.5 top-1.5 rounded bg-background/80 px-1.5 py-0.5 text-xs text-muted-foreground">
              {candidate.index + 1}
            </span>
            {!actionsDisabled && candidate.version_id && candidate.version_id !== primaryVersionId && (
              <Hint label="设为主结果"><Button variant="bare"
                type="button"
                aria-label={`将候选 ${candidate.index + 1} 设为主结果`}
                className="absolute bottom-1.5 left-1.5 grid size-7 place-items-center rounded-full border border-border bg-background/90 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => context.selectCandidate(nodeId, candidate.version_id!)}
              >
                <CheckIcon size="sm" aria-hidden="true" />
              </Button></Hint>
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
  return <Hint label={label}><Button variant="bare" ref={buttonRef} type="button" aria-label={label} aria-pressed={active} aria-expanded={expanded} aria-controls={controlsId} aria-haspopup={controlsId && popup ? popup : undefined} disabled={disabled} onClick={onClick} className={cn('grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-30', active && 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground')}>{children}</Button></Hint>;
}

// forwardRef + 透传其余属性：作为 Radix DropdownMenuTrigger 的 asChild 子元素时要接住它注入的
// ref 与 onPointerDown / onKeyDown / aria-* 才能展开菜单。
const MediaToolButton = forwardRef<HTMLButtonElement, {
  label: string;
  text: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children' | 'disabled'>>(
  function MediaToolButton(
    { label, text, destructive = false, disabled = false, onClick, children, className, ...rest },
    ref,
  ) {
    // U2：节点工具条一律纯图标，名字放在 Hint 里（aria-label 仍是带节点名的完整说法）。
    return (
      <Hint label={text || label}><Button variant="bare"
        {...rest}
        ref={ref}
        type="button"
        aria-label={label}
        disabled={disabled}
        className={cn(
          'nodrag grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-30',
          destructive && 'hover:text-destructive',
          className,
        )}
        onClick={event => {
          event.stopPropagation();
          onClick();
        }}
      >
        <span aria-hidden="true" className="[&_svg]:size-3.5">{children}</span>
      </Button></Hint>
    );
  },
);

function MediaToolLink({ label, text, href, children }: {
  label: string;
  text: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Hint label={text || label}><a
      href={href}
      aria-label={label}
      className="nodrag grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onClick={event => event.stopPropagation()}
    >
      <span aria-hidden="true" className="[&_svg]:size-3.5">{children}</span>
    </a></Hint>
  );
}

/** 宿主插件在添加菜单里的调用型入口（清单 canvas_actions，ADR-0041）；插件关闭时不出现。 */
export function PluginCanvasActionItems({ hostPlugins, onRun, layout = 'menu' }: {
  hostPlugins: ReadonlyMap<string, HostPluginModule>;
  onRun: (plugin: PluginPackageLock, action: PluginCanvasAction) => void;
  /** menu：窄屏的「添加节点」菜单；toolbar：宽屏左侧工具栏（宽屏没有添加菜单）。 */
  layout?: 'menu' | 'toolbar';
}) {
  const plugins = usePlugins();
  return <>
    {enabledPlugins(plugins)
      .filter(plugin => plugin.runtime === 'host' && isHostPluginId(plugin.id) && (plugin.contributes.canvas_actions ?? []).length > 0)
      .map(plugin => <PluginCanvasActionGroup key={plugin.id} plugin={plugin} module={hostPlugins.get(plugin.id)} onRun={onRun} layout={layout} />)}
  </>;
}

function PluginCanvasActionGroup({ plugin, module, onRun, layout }: {
  plugin: PluginPackageLock;
  module: HostPluginModule | undefined;
  onRun: (plugin: PluginPackageLock, action: PluginCanvasAction) => void;
  layout: 'menu' | 'toolbar';
}) {
  const busy = useHostPluginBusy(module);
  return <>
    {(plugin.contributes.canvas_actions ?? []).map(action => {
      const Icon = pluginIcon(action.icon);
      if (layout === 'toolbar') {
        return <ToolButton key={`${plugin.id}:${action.id}`} label={busy ? `${action.label}（上一个请求处理中…）` : action.label}
          popup={false} disabled={busy} onClick={() => onRun(plugin, action)}><Icon /></ToolButton>;
      }
      return <AddMenuButton key={`${plugin.id}:${action.id}`} icon={<Icon />} title={action.label}
        description={plugin.description} disabledReason={busy ? '上一个请求处理中…' : undefined}
        onClick={() => onRun(plugin, action)} />;
    })}
  </>;
}

/** 图片「更多」菜单里的插件动作；宿主插件的调用型动作在处理中时置灰。 */
function PluginImageActionItem({ label, Icon, module, onSelect }: {
  label: string; Icon: ComponentType; module: HostPluginModule | undefined; onSelect: () => void;
}) {
  const busy = useHostPluginBusy(module);
  return <DropdownMenuItem className="gap-2" disabled={busy} onSelect={onSelect}><Icon />{label}</DropdownMenuItem>;
}

export function AddMenuButton({ icon, title, description, onClick, disabledReason }: { icon: React.ReactNode; title: string; description?: string; onClick: () => void; disabledReason?: string }) {
  return <Hint label={disabledReason}><Button variant="bare" type="button" role="menuitem" onClick={onClick} disabled={Boolean(disabledReason)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"><span className="grid size-9 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">{icon}</span><span className="min-w-0"><span className="block text-sm font-medium">{title}</span>{description && <span className="block truncate text-xs text-muted-foreground">{description}</span>}</span></Button></Hint>;
}

function contentForNode(
  node: CanvasNode,
  resolveVersion: (versionId: string | null | undefined) => CanvasContentVersion | undefined,
) {
  if (!('current_version_id' in node.data)) return undefined;
  return resolveVersion(node.data.current_version_id);
}

function generationDraft(node: CanvasNode): CanvasGenerationDraft | null {
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
  return draft?.prompt.trim() ? readablePromptVariables(draft.prompt) : null;
}

function withGenerationDraft(node: CanvasNode, draft: CanvasGenerationDraft): CanvasNode {
  if (node.type === 'text') return { ...node, data: { ...node.data, generation_draft: draft } };
  if (node.type === 'image') return { ...node, data: { ...node.data, generation_draft: draft } };
  if (node.type === 'video') return { ...node, data: { ...node.data, generation_draft: draft } };
  if (node.type === 'audio') return { ...node, data: { ...node.data, generation_draft: draft } };
  if (node.type === 'plugin') return { ...node, data: { ...node.data, generation_draft: draft } };
  return node;
}

function nodeIcon(node: CanvasNode) {
  if (node.type === 'image_edit') return node.data.options.mode === 'outpaint'
    ? <OutpaintIcon size="sm" className="shrink-0" /> : <BrushIcon size="sm" className="shrink-0" />;
  if (node.type === 'text') return <TextIcon size="sm" className="shrink-0" />;
  if (node.type === 'image') return <ImageFileIcon size="sm" className="shrink-0" />;
  if (node.type === 'video') return <VideoFileIcon size="sm" className="shrink-0" />;
  if (node.type === 'audio') return <AudioFileIcon size="sm" className="shrink-0" />;
  if (node.type === 'layer_stack') return <LayersIcon size="sm" className="shrink-0" />;
  return <AiIcon size="sm" className="shrink-0" />;
}

export function CanvasLayerStackSurface({
  node,
  context,
  onOpenComposer,
}: {
  node: CanvasLayerStackNode;
  context: CanvasNodeContextValue;
  onOpenComposer?: () => void;
}) {
  const [hoveredLayerId, setHoveredLayerId] = useState<string | null>(null);
  const helpId = useId();
  const choices = useMemo(() => layerDecompositionModelChoices(context.keys), [context.keys]);
  const source = context.resolveVersion(node.data.source_version_id);
  const sourceImage = source?.kind === 'image' ? source : undefined;
  const base = context.resolveVersion(node.data.base_version_id);
  const baseImage = base?.kind === 'image' ? base : undefined;
  const layoutWidth = node.data.layout_size?.width ?? baseImage?.width;
  const layoutHeight = node.data.layout_size?.height ?? baseImage?.height;
  const selectedChoice = choices.find(choice => (
    choice.key.alias === node.data.alias && choice.model.id === node.data.model
  ));
  const busy = Boolean(node.data.active_run_id) || context.submittingNodeIds.has(node.id);
  const sourceNodeId = [...(context.connectedMaterialNodeIdsByNodeId.get(node.id) ?? [])][0];
  const replacingSource = Boolean(
    sourceNodeId && context.mediaReplaceBusyNodeIds.has(sourceNodeId),
  );

  function updateDraft(patch: Partial<Pick<CanvasLayerStackNode['data'], 'alias' | 'model' | 'prompt' | 'resolution' | 'max_images'>>) {
    context.updateNode(node.id, candidate => candidate.type === 'layer_stack'
      ? { ...candidate, data: { ...candidate.data, ...patch, error: null } }
      : candidate);
  }

  function updateVisibility(layerId: string | null, visible: boolean) {
    context.recordHistory();
    context.updateNode(node.id, candidate => {
      if (candidate.type !== 'layer_stack') return candidate;
      if (layerId === null) {
        return { ...candidate, data: { ...candidate.data, base_visible: visible } };
      }
      return {
        ...candidate,
        data: {
          ...candidate.data,
          layers: candidate.data.layers.map(layer => (
            layer.id === layerId ? { ...layer, visible } : layer
          )),
        },
      };
    });
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="relative flex min-w-0 flex-1 items-center justify-center p-3"
        onClick={baseImage ? onOpenComposer : undefined}>
        {baseImage && layoutWidth && layoutHeight ? (
          <CanvasLayerStackComposite node={node} projectId={context.projectId}
            resolveVersion={context.resolveVersion} hoveredLayerId={hoveredLayerId} />
        ) : sourceImage ? (
          <img
            src={canvasMediaUrl(context.projectId, sourceImage.version_id, 1024)}
            alt="待拆分图片"
            draggable={false}
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="text-xs text-[color:var(--status-failed)]">来源图片不可用</span>
        )}
        {!baseImage && sourceImage && (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label="替换待拆分图片"
            disabled={busy || replacingSource}
            className="nodrag absolute right-3 top-3 size-8"
            onClick={event => {
              event.stopPropagation();
              context.replaceLayerStackSource(node.id);
            }}
          >
            {replacingSource
              ? <LoadingIcon className="animate-spin" aria-hidden="true" />
              : <ReplaceFileIcon aria-hidden="true" />}
          </Button>
        )}
      </div>
      <div className="w-72 shrink-0 border-l border-border">
        {baseImage ? (
          <CanvasLayerStackList node={node} context={context} disabled={busy}
            onVisibility={updateVisibility} onHover={setHoveredLayerId} />
        ) : (
          <div className="relative flex h-full flex-col gap-3 overflow-y-auto p-4" aria-label="图层拆分设置">
            <div className="absolute right-2 top-2 z-10">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="图层拆分使用说明"
                aria-describedby={helpId}
                className="peer nodrag size-7 rounded-full text-muted-foreground hover:text-foreground"
                onClick={event => event.stopPropagation()}
              >
                <HelpIcon aria-hidden="true" />
              </Button>
              <p
                id={helpId}
                role="tooltip"
                className="pointer-events-none invisible absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-foreground peer-hover:visible peer-focus-visible:visible"
              >
                比例跟随原图。留空会自动识别主要图层。也可以明确要求：对输入图进行精确图层分离，识别并独立拆分标题文字、辅助文案、主体与装饰元素；调整指定文字图层和元素位置，同时保持原始画面风格、光影、色调和质感不变。
              </p>
            </div>
            <Label className="space-y-2 pr-7 text-xs text-muted-foreground">
              <span>模型</span>
              <span className="nodrag flex">
                <CanvasModelPicker
                  choices={choices}
                  alias={node.data.alias}
                  model={node.data.model ?? ''}
                  menuDirection="down"
                  onSelect={choice => {
                    context.recordHistory();
                    updateDraft({ alias: choice.key.alias, model: choice.model.id });
                  }}
                />
              </span>
            </Label>
            <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              <span>提示词</span>
              {busy ? (
                <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 text-sm leading-relaxed text-muted-foreground">
                  {node.data.prompt || '未填写提示词'}
                </p>
              ) : (
                // 与生成面板共用编辑器：编辑会话期间不自动保存、不被远端合并覆盖，双击不冒泡到节点。
                <div className="nodrag nowheel max-h-40 overflow-y-auto rounded-md border border-border text-foreground"
                  onPointerDown={event => event.stopPropagation()}
                  onDoubleClick={event => event.stopPropagation()}>
                  <CanvasPromptInput
                    value={node.data.prompt}
                    references={EMPTY_CANVAS_MENTION_REFERENCES}
                    mentionsEnabled={false}
                    placeholder={`上传单张图片，分离图中元素，最高支持${layerDecompositionMaxOutputs(node.data.model)}张输出`}
                    onFocus={context.recordHistory}
                    onEditingChange={editing => context.setTextEditing?.(`prompt:${node.id}`, editing)}
                    onChange={prompt => updateDraft({ prompt: prompt.slice(0, 4000) })}
                  />
                </div>
              )}
            </div>
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <span>分辨率</span>
              <Segmented aria-label="选择拆分分辨率" className="grid grid-cols-4 rounded-lg bg-popover p-0.5">
                {(['auto', '1K', '1.5K', '2K'] as const).map(resolution => (
                  <SegmentedItem key={resolution} value={String(resolution)} selected={node.data.resolution === resolution} disabled={busy} onSelect={() => {
                      if (node.data.resolution === resolution) return;
                      context.recordHistory();
                      updateDraft({ resolution });
                    }} className="nodrag h-8 rounded-md px-1 text-center text-sm text-foreground transition-colors hover:bg-secondary/60 disabled:opacity-50">
                    {resolution === 'auto' ? '智能' : resolution}
                  </SegmentedItem>
                ))}
              </Segmented>
            </div>
            {supportsLayerMaxImages(node.data.model) && (
              <LayerMaxImagesPicker
                value={node.data.max_images ?? LAYER_MAX_IMAGES_DEFAULT}
                disabled={busy}
                onSelect={maxImages => {
                  if ((node.data.max_images ?? LAYER_MAX_IMAGES_DEFAULT) === maxImages) return;
                  context.recordHistory();
                  updateDraft({ max_images: maxImages });
                }}
              />
            )}
            {node.data.error && (
              <p role="alert" className="line-clamp-3 text-xs leading-relaxed text-[color:var(--status-failed)]">
                {canvasNodeRunDisplayError(node.data.error, '图层拆分失败，请重试')}
              </p>
            )}
            <div className="mt-auto flex items-center justify-end gap-2">
              {choices.length ? (
                <Button
                  type="button"
                  className="nodrag"
                  disabled={!selectedChoice || busy || !sourceImage}
                  onClick={() => void context.submitLayerDecomposition(node.id)}
                >
                  <SwapIcon swapKey={Boolean(busy)}>{busy ? <LoadingIcon className="animate-spin" aria-hidden="true" /> : <LayersIcon aria-hidden="true" />}</SwapIcon>
                  <SwapLabel active={Boolean(busy)} on="拆分中…" off="开始拆分" />
                </Button>
              ) : (
                <Button asChild variant="outline" size="sm" className="nodrag">
                  <Link href="/settings/providers">配置模型</Link>
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 已完成拆分节点的重拆面板：提示词与模型只存在面板里，提交时新建一个拆分节点，原节点的记录不动。 */
/** Seedream 5.5 图层拆分的「最多图层」：含底图的总张数，越大拆得越细，费用按实际输出张数计。 */
function LayerMaxImagesPicker({
  value,
  disabled,
  onSelect,
}: {
  value: number;
  disabled?: boolean;
  onSelect: (maxImages: number) => void;
}) {
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      <span>最多图层</span>
      <Segmented aria-label="选择最多图层" className="grid grid-cols-4 rounded-lg bg-popover p-0.5">
        {LAYER_MAX_IMAGES_OPTIONS.map(option => (
          <SegmentedItem key={option} value={String(option)} selected={value === option} disabled={disabled}
            onSelect={() => onSelect(option)}
            className="nodrag h-8 rounded-md px-1 text-center text-sm tabular-nums text-foreground transition-colors hover:bg-secondary/60 disabled:opacity-50">
            {option}
          </SegmentedItem>
        ))}
      </Segmented>
    </div>
  );
}

function CanvasLayerStackComposer({
  node,
  context,
  onClose,
}: {
  node: CanvasLayerStackNode;
  context: CanvasNodeContextValue;
  onClose: () => void;
}) {
  const choices = useMemo(() => layerDecompositionModelChoices(context.keys), [context.keys]);
  const [prompt, setPrompt] = useState(node.data.prompt);
  const [selection, setSelection] = useState({ alias: node.data.alias, model: node.data.model });
  const [maxImages, setMaxImages] = useState(node.data.max_images ?? LAYER_MAX_IMAGES_DEFAULT);
  const [submitting, setSubmitting] = useState(false);
  const selectedChoice = choices.find(choice => (
    choice.key.alias === selection.alias && choice.model.id === selection.model
  )) ?? choices[0];
  const maxImagesSupported = supportsLayerMaxImages(selectedChoice?.model.id);

  async function submit() {
    if (!selectedChoice || !context.rerunLayerDecomposition) return;
    setSubmitting(true);
    try {
      await context.rerunLayerDecomposition(node.id, {
        alias: selectedChoice.key.alias,
        model: selectedChoice.model.id,
        prompt: prompt.slice(0, 4000),
        max_images: maxImagesSupported ? maxImages : null,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      aria-label="重新拆分图层"
      data-floating-node-panel="true"
      className="nodrag relative overflow-hidden rounded-xl border border-border bg-glass p-3 backdrop-blur-glass shell-glow"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 z-10 size-7 rounded-full"
        aria-label="关闭重新拆分图层"
        onClick={onClose}
      >
        <CloseIcon aria-hidden="true" />
      </Button>
      <CanvasPromptInput
        value={prompt}
        references={EMPTY_CANVAS_MENTION_REFERENCES}
        mentionsEnabled={false}
        className="max-h-[50vh]"
        placeholder={`上传单张图片，分离图中元素，最高支持${layerDecompositionMaxOutputs(selectedChoice?.model.id)}张输出`}
        onChange={setPrompt}
      />
      {maxImagesSupported && (
        <div className="mt-2">
          <LayerMaxImagesPicker value={maxImages} disabled={submitting} onSelect={setMaxImages} />
        </div>
      )}
      <div className="mt-2 flex items-end gap-1.5 rounded-xl border border-border/70 bg-card/55 p-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <CanvasModelPicker
            choices={choices}
            alias={selectedChoice?.key.alias ?? null}
            model={selectedChoice?.model.id ?? ''}
            onSelect={choice => setSelection({ alias: choice.key.alias, model: choice.model.id })}
          />
        </div>
        {choices.length ? (
          <Button type="button" size="sm" className="shrink-0" disabled={submitting} onClick={() => void submit()}>
            <SwapIcon swapKey={submitting}>{submitting ? <LoadingIcon className="animate-spin" aria-hidden="true" /> : <LayersIcon aria-hidden="true" />}</SwapIcon>
            {submitting ? '提交中…' : '开始拆分'}
          </Button>
        ) : (
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link href="/settings/providers">配置模型</Link>
          </Button>
        )}
      </div>
    </section>
  );
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
  const Icon = node.type === 'image' ? ImageFileIcon : node.type === 'video' ? VideoFileIcon : AudioFileIcon;
  return (
    <div className="grid min-h-44 place-items-center p-4 text-center text-muted-foreground">
      <div className="flex flex-col items-center gap-3">
        <span className="grid size-12 place-items-center rounded-lg bg-secondary/60">
          <Icon size="xl" className="opacity-50" aria-hidden="true" />
        </span>
        <span className="text-xs">空{label}节点</span>
      </div>
    </div>
  );
}

/** 节点上的图换版本（生成完成、重新生成、撤销）时旧图留在底下，新图解码完成后在上面淡入，
 *  淡入播完再卸掉旧图，全程不露出画布。已在缓存里的图（平移回视口、撤销回旧版）直接显示，不播。
 *  旧图改按 cover 铺满：新版本比例不同时节点尺寸与淡入同帧变化，contain 会在两侧露出透明边。 */
function CanvasCrossfadeImage({ src, alt, fitClassName, className, onReady }: {
  src: string;
  alt: string;
  fitClassName: string;
  className?: string;
  onReady?: () => void;
}) {
  const [layers, setLayers] = useState<readonly string[]>([src]);
  // 每层各记解码状态：撤销回一张还挂着、早已解完的旧图时，它重新到顶不会再触发一次解码回调。
  const [readyLayers, setReadyLayers] = useState<ReadonlySet<string>>(() => new Set());
  if (layers[layers.length - 1] !== src) setLayers([...layers.filter(layer => layer !== src), src]);
  const topReady = readyLayers.has(src);
  const latestOnReady = useRef(onReady);
  latestOnReady.current = onReady;
  // 顶层换了身份（含换回已就绪的旧层）就按当前版本上报，节点尺寸跟着屏上的图走。
  useEffect(() => {
    if (topReady) latestOnReady.current?.();
  }, [topReady, src]);
  const settled = topReady && layers.length > 1;
  useEffect(() => {
    if (!settled) return;
    const timer = window.setTimeout(() => {
      setLayers(current => current[current.length - 1] === src ? [src] : current);
      setReadyLayers(current => current.has(src) && current.size > 1 ? new Set([src]) : current);
    }, MOTION_DURATION.base * 1000);
    return () => window.clearTimeout(timer);
  }, [settled, src]);
  const markReady = useCallback((layer: string) => {
    setReadyLayers(current => current.has(layer) ? current : new Set([...current, layer]));
  }, []);
  return (
    <div data-canvas-media className={cn('relative size-full', className)}>
      {layers.map(layer => {
        const top = layer === src;
        return (
          <RevealImage
            key={layer}
            src={layer}
            alt={top ? alt : ''}
            aria-hidden={top ? undefined : true}
            loading="lazy"
            decoding="async"
            draggable={false}
            className={cn(
              'media-checker block size-full select-none',
              // 新图在文档流里且排在后面，叠在绝对定位的旧图上面。
              top ? cn('relative', fitClassName) : 'absolute inset-0 object-cover',
              className,
            )}
            onReady={() => markReady(layer)}
          />
        );
      })}
    </div>
  );
}

/** 缩略图跨档时只更新媒体，兄弟节点的生成表单无需重渲染。 */
function CanvasNodeMediaPreview({ projectId, version, cardWidth, ...props }:
  Omit<Parameters<typeof MediaPreview>[0], 'kind' | 'src'> & {
    projectId: string; version: CanvasMediaVersion; cardWidth: number;
  }) {
  const bitmapWidth = useCanvasImageBitmapWidth(cardWidth);
  const src = version.kind === 'image' ? canvasMediaUrlAtWidth(projectId, version.version_id, bitmapWidth)
    : canvasMediaUrl(projectId, version.version_id);
  return <MediaPreview {...props} kind={version.kind} src={src} />;
}

function MediaPreview({
  kind,
  src,
  title = '',
  fit = 'contain',
  freeResize = false,
  compact = false,
  onReady,
}: {
  kind: 'image' | 'video' | 'audio';
  src: string;
  title?: string;
  fit?: 'contain' | 'cover';
  freeResize?: boolean;
  compact?: boolean;
  /** 图片：这一版解码完成、已盖住旧版时回调。 */
  onReady?: () => void;
}) {
  const { mediaRef, resolvedSrc } = useLazyMedia(src);
  const videoElement = useRef<HTMLVideoElement | null>(null);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoMuted, setVideoMuted] = useState(false);
  const [videoVolume, setVideoVolume] = useState(1);
  // 视频首帧解出来之前保持透明，避免先闪一块黑底；首帧到了 150ms 淡入（Q15）。
  // Safari 在 preload=metadata 下可能不派发 loadeddata：拿到元数据 300ms 后仍没首帧也显示出来。
  const [videoFrameSrc, setVideoFrameSrc] = useState<string | null>(null);
  const videoFrameTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (videoFrameTimer.current !== null) window.clearTimeout(videoFrameTimer.current);
  }, []);
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
  // 原生全屏下 <video> 没开 controls，空格不会自己播放/暂停；只在本节点的视频占着全屏时接管空格。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const video = videoElement.current;
      if (!video || document.fullscreenElement !== video) return;
      if (event.key !== ' ' && event.code !== 'Space') return;
      event.preventDefault();
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
  if (kind === 'image') return (
    <CanvasCrossfadeImage
      src={src}
      alt={title}
      fitClassName={freeResize ? 'object-fill' : fit === 'cover' ? 'object-cover' : 'object-contain'}
      className={compact ? 'max-h-48 rounded-md' : undefined}
      onReady={onReady}
    />
  );
  if (kind === 'video') {
    const mediaLabel = title || '视频';
    return (
      <div data-canvas-media className={cn('relative size-full', compact && 'max-h-48')}>
        <video
          ref={videoRef}
          src={resolvedSrc}
          playsInline
          preload={resolvedSrc ? 'metadata' : 'none'}
          data-canvas-media-controls="video"
          className={cn(
            'size-full transition-opacity duration-150',
            freeResize ? 'object-fill' : fit === 'cover' ? 'object-cover' : 'object-contain',
            compact && 'max-h-48 rounded-md',
            motionAvailable() && videoFrameSrc !== resolvedSrc && 'opacity-0',
          )}
          onLoadedData={() => setVideoFrameSrc(resolvedSrc)}
          onError={() => setVideoFrameSrc(resolvedSrc)}
          onClick={event => event.preventDefault()}
          onDoubleClick={stopCanvasInteraction}
          onPlay={() => setVideoPlaying(true)}
          onPause={() => setVideoPlaying(false)}
          onEnded={() => setVideoPlaying(false)}
          onLoadedMetadata={event => {
            const loadedSrc = resolvedSrc;
            if (videoFrameTimer.current !== null) window.clearTimeout(videoFrameTimer.current);
            videoFrameTimer.current = window.setTimeout(() => setVideoFrameSrc(loadedSrc), 300);
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
          className="nodrag absolute bottom-2 left-2 right-2 z-10 flex items-center gap-1 rounded-lg border border-border bg-glass px-1.5 py-1 text-foreground backdrop-blur-glass"
          onPointerDown={stopCanvasInteraction}
          onDoubleClick={stopCanvasInteraction}
          onClick={stopCanvasInteraction}
          onKeyDown={stopCanvasInteraction}
        >
          <Button variant="bare"
            type="button"
            aria-label={`${videoPlaying ? '暂停' : '播放'} ${mediaLabel}`}
            className="grid size-7 shrink-0 place-items-center rounded-full transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={toggleVideoPlayback}
          >
            <SwapIcon swapKey={videoPlaying}>
              {videoPlaying
                ? <PauseIcon aria-hidden="true" />
                : <PlayIcon aria-hidden="true" />}
            </SwapIcon>
          </Button>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatMediaTime(videoCurrentTime)}</span>
          <Slider
            aria-label="视频播放进度"
            min={0}
            max={videoDuration || 0}
            step={0.01}
            value={[Math.min(videoCurrentTime, videoDuration || 0)]}
            // 进度条不显示滑钮（飙哥 2026-09-14），滑钮缩成 0 只保留拖拽与键盘。
            className="min-w-0 flex-1 py-1.5 [&_[role=slider]]:size-0 [&_[role=slider]]:border-0"
            onValueChange={([next]) => seekVideo(next)}
          />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            -{formatMediaTime(Math.max(0, videoDuration - videoCurrentTime))}
          </span>
          {/* 命名 group：节点卡片自己就是 .group，裸 group-hover 会在悬停整个节点时把音量弹出来。 */}
          <div className="group/volume relative shrink-0">
            <Button variant="bare"
              type="button"
              aria-label={`${videoMuted ? '取消静音' : '静音'} ${mediaLabel}`}
              className="grid size-7 place-items-center rounded-full transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={toggleVideoMuted}
            >
              <SwapIcon swapKey={videoMuted || videoVolume === 0}>
                {videoMuted || videoVolume === 0
                  ? <MuteIcon aria-hidden="true" />
                  : <VolumeIcon aria-hidden="true" />}
              </SwapIcon>
            </Button>
            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 pb-1 opacity-0 transition-opacity group-focus-within/volume:pointer-events-auto group-focus-within/volume:opacity-100 group-hover/volume:pointer-events-auto group-hover/volume:opacity-100">
              <div className="grid h-24 w-7 place-items-center rounded-lg border border-border bg-glass py-2 backdrop-blur-glass">
                <Slider
                  aria-label="视频音量"
                  orientation="vertical"
                  min={0}
                  max={1}
                  step={0.05}
                  value={[videoMuted ? 0 : videoVolume]}
                  onValueChange={([next]) => setVolume(next)}
                />
              </div>
            </div>
          </div>
          <Button variant="bare"
            type="button"
            aria-label={`全屏播放 ${mediaLabel}`}
            className="grid size-7 shrink-0 place-items-center rounded-full transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={showVideoFullscreen}
          >
            <ExpandIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
    );
  }
  return <CanvasAudioPlayer src={resolvedSrc} title={title} mediaRef={mediaRef} />;
}

/** 提示词超过约 3 行才进摘要态；短提示词直接给编辑器，少一次点击。 */
export function isLongCanvasPrompt(prompt: string): boolean {
  const text = prompt.trim();
  return text.length > 120 || (text.match(/\n/g)?.length ?? 0) >= 3;
}

/** 摘要态用纯文本：@[node:id] 换成 @标签，其它原样。 */
export function canvasPromptSummary(prompt: string, references: readonly { nodeId: string; label: string }[]): string {
  const labelById = new Map(references.map(reference => [reference.nodeId, reference.label]));
  return prompt.replace(/@\[node:([^\]]+)\]/g, (token, nodeId: string) => {
    const label = labelById.get(nodeId);
    return label ? `@${label}` : token;
  });
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
    && previous.dragging === next.dragging
    && previous.data.domain === next.data.domain
  )),
  canvasPlaceholder: CanvasPlaceholderCard,
};

/** 只露指针所在一侧的连接点。直接写 DOM 属性而不走 state：pointermove 每帧都来，进 React 就是整节点重渲染。 */
function showHandleOnHoveredSide(event: ReactPointerEvent<HTMLDivElement>) {
  const shell = event.currentTarget;
  const rect = shell.getBoundingClientRect();
  const side = event.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
  if (shell.dataset.hoverSide !== side) shell.dataset.hoverSide = side;
}

function hideHoverHandles(event: ReactPointerEvent<HTMLDivElement>) {
  delete event.currentTarget.dataset.hoverSide;
}

function CanvasCompareNodeBody({ node, context }: {
  node: CanvasCompareNode; context: CanvasNodeContextValue;
}) {
  const bitmapWidth = useCanvasImageBitmapWidth(node.size?.width ?? 320);
  const inputs = context.compareInputsByNodeId?.get(node.id);
  const beforeVersionId = inputs?.before?.versionId ?? null;
  const afterVersionId = inputs?.after?.versionId ?? null;
  const frame = inputs?.after && afterVersionId
    ? canvasCompareFrame(beforeVersionId, context.resolveVersion(afterVersionId),
      context.jobsByResultNodeId.get(inputs.after.nodeId), versionId => context.resolveVersion(versionId))
    : null;
  const afterVersion = afterVersionId ? context.resolveVersion(afterVersionId) : undefined;
  const afterSize = afterVersion?.kind === 'image' && afterVersion.width && afterVersion.height
    ? { width: afterVersion.width, height: afterVersion.height } : null;
  return <CanvasCompareSurface projectId={context.projectId} title={node.title} beforeVersionId={beforeVersionId}
    afterVersionId={afterVersionId} afterSize={afterSize} frame={frame} bitmapWidth={bitmapWidth} />;
}
