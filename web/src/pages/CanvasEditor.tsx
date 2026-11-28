import { copySharedNodes, reproduceFrozen } from '@/api/collabTransfer';
import { useRetained } from '@/components/ui/retained';
import { Lightbox } from '@/components/Lightbox';
import { FrozenGenerationDetails } from '@/components/canvas/FrozenGenerationDetails';
import { enabledPlugins, usePlugins } from '@/plugin-host/registry';
import { pluginInputsFromDocument } from '@/plugin-host/inputs';
import type { PluginCanvasAction, PluginMediaAction, PluginNodeContribution, PluginPackageLock } from '@/schema/plugins';
import { requestPluginPanel } from '@/plugin-host/panelRequests';
import { pluginIcon } from '@/components/ui/icons';
import { CanvasCopyForAgentItem } from '@/components/canvas/CanvasCopyForAgentItem';
import { flushSync } from 'react-dom';
import { markUnsavedChanges } from '@/api/connection';
import { createAnnotatedGeneration, ensureAnnotatedInputs, type AnnotationDocumentBridge } from '@/components/canvas/annotation/annotationRendering';
import { useCanvasAnnotation } from '@/components/canvas/annotation/useCanvasAnnotation';
import '@xyflow/react/dist/style.css';
import { readablePromptVariables } from '@/lib/promptVariables';

import {
  Background,
  BackgroundVariant,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type OnConnectEnd,
  type Viewport,
  type ReactFlowState,
  type XYPosition,
  useReactFlow,
  useStore,
  useStoreApi,
} from '@xyflow/react';
import { BrushIcon, AddImageIcon, AddIcon, AiIcon, AudioFileIcon, MusicFileIcon, BackIcon, BlankIcon, ChevronDownIcon, CloseIcon, CompareIcon, CopyIcon, DeleteIcon, DotGridIcon, DownloadIcon, EditIcon, ExpandIcon, GridIcon, HelpIcon, HideIcon, ImageFileIcon, InfoIcon, LayersIcon, LibraryIcon, LoadingIcon, MinimapIcon, MinusIcon, MoreIcon, ParamsIcon, RedoIcon, SelectIcon, SettingsIcon, ShowIcon, StopIcon, TextFileIcon, TextIcon, UndoIcon, UploadIcon, VideoFileIcon } from '@/components/ui/icons';
import { currentHostNodeType, isHostPluginId, loadHostPlugin, useHostPlugins, type HostPluginApi } from '@/plugin-host/hostPlugins';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';

import {
  cancelCanvasRun,
  resumeCanvasMjEdit,
  canvasDownloadUrl,
  canvasMediaUrlAtWidth,
  canvasThumbnailWidth,
  createCanvasReversePromptConfig,
  dismissCanvasCandidate,
  listCanvasJobs,
  listCanvasProjects,
  renameCanvasProject,
  discardEmptyCanvasProject,
  updateCanvasCategories,
  replaceCanvasNodeMedia,
  runCanvasMediaOperation,
  getCanvasMattingModel,
  downloadCanvasMattingModel,
  submitCanvasAngleRun,
  submitCanvasLayerDecomposition,
  submitCanvasUpscaleRun,
  submitCanvasRun,
  saveCanvasImageEdit,
  submitCanvasImageEdit,
  type CanvasImageEditSavePayload,
  submitCanvasReversePrompt,
  submitCanvasTextRevision,
  uploadCanvasMedia,
} from '@/api/canvas';
import { getCanvasUiPreferences, saveCanvasUiPreferences } from '@/api/canvasUi';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import { loadTokenDancePrices } from '@/api/usage';
import { listModelRoutes, type ModelRoute } from '@/api/models';
import { withAutoProvider } from '@/lib/modelRoutes';
import { useCanvasGroupRuns } from '@/hooks/useCanvasGroupRuns';
import { useCanvasJobSync } from '@/hooks/useCanvasJobSync';
import { canvasEdgeTypes, fadeOutCanvasEdge } from '@/components/canvas/CanvasConnectionEdge';
import { SwapIcon } from '@/components/ui/swap-icon';
import { flashCanvasEdges, flashCanvasNodes, markCanvasNodesEntering } from '@/components/canvas/canvasNodeAttention';
import { canvasHistoryAffectedNodes, canvasHistoryHint, canvasRectsIntersect, canvasRemoteNodeChanges, groupResultFrame, withGroupRunResults, type CanvasHistoryHint } from '@/pages/canvasHistoryAttention';
import { bindCanvasMagneticHandles } from '@/components/canvas/canvasMagneticInteraction';
import { CanvasConnectionLine, CanvasPendingConnection } from '@/components/canvas/CanvasConnectionLine';
import {
  AddMenuButton,
  PluginCanvasActionItems,
  CanvasMobileGenerationPanel,
  CanvasNodeContext,
  EditorMessage,
  ToolButton,
  canvasNodeTypes,
  canvasChromeInsetBounds,
  copyablePromptForNode,
  canvasStackMemberMotion,
  clearStackMemberMotion,
  playStackMemberExit,
  type CanvasNodeContextValue,
  type CanvasStackMemberMotion,
  type FlowNode,
} from '@/components/canvas/CanvasEditorViews';
import { AnimatePresence, cubicBezier, motion } from 'motion/react';
import { animate, clearOnFinish, MOTION_DURATION, MOTION_EASE, motionAvailable, prefersReducedMotion, type AnimationPlaybackControls } from '@/lib/motion';
import { canvasNodeRunDisplayError, canvasNodeRunState, isReversePromptJob } from '@/components/canvas/CanvasNodeRunStatus';
import { layerDecompositionModelChoices } from '@/components/canvas/canvasLayerDecomposition';
import { codePointRange, type CanvasTextRevisionInput } from '@/components/canvas/canvasTextRevision';
import { CanvasLayerStackPreview } from '@/components/canvas/CanvasLayerStackPreview';
import { CanvasThemeSelector } from '@/components/canvas/CanvasThemeSelector';
import {
  CanvasGenerationMetadata,
} from '@/components/canvas/CanvasGenerationMetadata';
import {
  CanvasGenerationPreferencesDialog,
  type CanvasGenerationPreferencesTab,
} from '@/components/canvas/CanvasGenerationPreferencesDialog';
import { ApiError } from '@/api/http';
import { rebaseOwnerHistory } from './canvas/sharedOwnerHistory';
import { useCollabRoom } from './canvas/useCollabRoom';
import { RoomPresence, RoomSelectionOverlay } from './canvas/RoomPresence';
import { SharedStatusButton, useSharedCanvases } from '@/components/canvas/SharedCanvasList';
import { SharedCanvasView } from './canvas/SharedCanvasView';
import { localCanvasTransport, type CanvasTransport } from './canvas/canvasTransport';
import type { CanvasMaskEditSubmission } from '@/components/canvas/ImageEditorShell';
import { CanvasInpaintEditor } from '@/components/canvas/CanvasInpaintEditor';
import { CanvasOutpaintEditor } from '@/components/canvas/CanvasOutpaintEditor';
import { initialEditFrame, savedImageEditError } from '@/components/canvas/imageEditGeometry';
import {
  CanvasAngleDialog,
  type CanvasAngleParams,
} from '@/components/canvas/CanvasAngleDialog';
import { CanvasMattingModelDialog } from '@/components/canvas/CanvasMattingModelDialog';
import {
  CanvasMediaOperationDialog,
  type CanvasMediaTool,
} from '@/components/canvas/CanvasMediaOperationDialog';
import { DEFAULT_CANVAS_UI_PREFERENCES } from '@/components/canvas/canvasImageToolbar';
import { canvasCompareFrame, type CanvasCompareInputs, type CanvasCompareSource } from '@/components/canvas/canvasCompare';
import { CanvasCompareSurface } from '@/components/canvas/CanvasCompareSurface';
import { formatCanvasBytes } from '@/components/canvas/canvasMediaFormatting';
import {
  generationPanelDismissalAfterNodeSelection,
  isUploadedImageMaterialNode,
  restoreCanvasNodeFocus,
} from '@/components/canvas/canvasNodePanelInteraction';
import type { HistoryKind } from '@/api/history';
import { AssetPanel } from '@/components/assets/AssetPanel';
import {
  type CreationAssetSaveRequest,
} from '@/components/assets/creationAssetPanelModel';
import { ProjectReferenceLibrary } from '@/components/assets/ProjectReferenceLibrary';
import { MediaPreview } from '@/components/assets/ProjectReferenceMedia';
import { ProjectSpecsDrawer } from '@/components/canvas/ProjectSpecsDrawer';
import { CanvasAgentPanel } from '@/components/canvas/agent/CanvasAgentPanel';
import { insertCreationAssetIntoCanvas, listCreationAssets, saveMediaCreationAssetFromPath, updateCreationAssetCategory } from '@/api/creationAssets';
import { adoptTeamAsset, listRelatedTeamAssets } from '@/api/teamLibraries';
import { TEAM_ASSET_DRAG_TYPE, readTeamAssetDrag } from '@/schema/teamLibrary';
import { CREATION_ASSET_DRAG_TYPE, readCreationAssetDrag } from '@/schema/creationAssets';
import { TeamShareDialog, type TeamShareDialogRequest } from '@/components/studio/TeamShareDialog';
import { TEAM_ASSET_ACTION_EVENT, type TeamAssetAction } from '@/lib/teamAssetActions';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { KEYS_CHANGED_EVENT } from '@/lib/announcements';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  CanvasConnection,
  CanvasContentNode,
  CanvasContentVersion,
  CanvasDocument,
  CanvasAnnotationDelivery,
  CanvasGenerationDefaults,
  CanvasGenerationDraft,
  CanvasImageToolbarPreferences,
  CanvasLayerStackNode,
  CanvasMattingModelStatus,
  CanvasMediaOperation,
  CanvasMediaVersion,
  CanvasImageEditNode,
  CanvasNode,
  CanvasPluginNode,
  CanvasInputConnection,
  CanvasPoint,
  CanvasSize,
  CanvasTextVersion,
  CanvasUiPreferences,
  CanvasUpscalePreferences,
  CanvasUpscaleTarget,
  CanvasVideoFrameSlot,
} from '@/schema/canvas';
import { assetMediaContent, type CreationAsset } from '@/schema/creationAssets';
import { DEFAULT_CANVAS_CATEGORIES, type CanvasProject } from '@/schema/canvas';
import type { Job, JobKind } from '@/schema/jobs';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

import {
  appendCanvasMentionToken,
  buildCanvasMaterialReferences,
  buildCanvasMentionReferences,
  removeCanvasMentionTokens,
} from '@/lib/canvasMentions';
import { shouldPreventCanvasHistoryNavigation } from '@/lib/canvasTrackpad';
import {
  CANVAS_LOCAL_VERSION_SHA,
  CANVAS_DEFAULT_NODE_SIZE,
  CANVAS_TEXT_NODE_DEFAULT_SIZE,
  acceptServerContentVersions,
  canvasConnectionCreationCapabilities,
  canvasUpstreamNodeTypesForTarget,
  isCanvasHandleTap,
  placeCanvasConnectedNode,
  canvasDeletionBlockedMessage,
  canvasMediaOperationPlaceholder,
  predictSplitGridPlaceholders,
  type CanvasMediaOperationPlaceholder,
  canvasNodeRenderZIndex,
  canvasNodeProvidesContent,
  canvasNodeAcceptsInput,
  canvasNodeProvidesOutput,
  canvasNodeRenderedSize,
  canCreateCanvasInputConnection,
  isCanvasCompareSlot,
  isCanvasVideoFrameSlot,
  normalizeCanvasCompareConnections,
  clampCanvasNodeSize,
  canvasPendingInputNodes,
  closestCanvasConnectionEndpoint,
  canvasGenerationDefaultFromDraft,
  canvasGenerationSlot,
  type CanvasAudioFamily,
  canvasNodeHasHideableContent,
  canvasCompareHasInput,
  createCanvasGenerationDraft,
  resolveCanvasGenerationDraft,
  createConnectedCanvasSurface,
  reorderCanvasInputConnections,
  layerStackSizeForCanvasVersion,
  normalizeCanvasVideoParams,
  normalizeCanvasGroups,
  expandCanvasLayerStack,
  syncLayerMaterials,
  layerMaterialNodeIds,
  placeCanvasNodeWithoutOverlap,
  restoreContentVersions,
  sizeLockedToCanvasVersion,
  supportsCanvasVideoEdit,
  syncDraftLayerStackSources,
  detachMissingImageEditNodes,
  restoreImageEditRunState,
  retainNewImageEditResults,
  canvasReadingOrder,
  expandCanvasInputSource,
  canvasModesRejectingSources,
  mergeRemoteCanvasDocument,
  canvasRoundUndoConflicts,
  canvasVideoFrameSlotMode,
  canvasInputConnectionRejection,
  canvasNodeActiveRunId,
} from './canvasEditorModel';
import { resolveRecipeModel } from './studioRecipe';
import { useCanvasAgentIndicator } from '@/components/canvas/useCanvasAgentIndicator';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { errorText } from '@/lib/errorText';
import { presentJobError, type JobErrorAction } from '@/lib/errorPresentation';
import { CanvasContextMenu, type CanvasContextMenuItem } from '@/components/canvas/CanvasContextMenu';
import {
  isFreshCanvasProject,
  openCanvasEditor,
  scheduleFreshCanvasProjectCleanup,
  settleFreshCanvasProject,
} from './canvasFreshProject';
import {
  canvasNodeSaveRequest,
  canvasNodeShareRequest,
  canvasReproduceNotices,
  placeCanvasNodeGroupWithoutOverlap,
} from './canvasTeamActions';
import { canvasLayerMaterialConnections, type CanvasLayerMaterialConnection } from './canvasLayerMaterialConnections';
import { FileInput } from '@/components/ui/file-input';
import { EditableText, type EditableTextHandle } from '@/components/ui/editable-text';
import { Toggle } from '@/components/ui/toggle';
import { Hint } from '@/components/ui/tooltip';
import {
  normalizeResultStacks,
  pendingResultStack,
  resultStackOwners,
  settleResultStack,
  swapResultStackCover,
} from '@/lib/canvasResultStacks';

interface CreateMenuState {
  screen: XYPosition;
  flow: XYPosition;
  /** 拖出连线的那个节点。 */
  sourceId?: string;
  /** 从输出侧拖出时要一起连进新节点的全部来源：起点在多选里就是整组，否则只有起点。 */
  sourceIds?: string[];
  sourceHandle?: 'source' | 'target';
  compareSlot?: 'before' | 'after';
  /** 拖线松手时指针的屏幕位置；列表贴着它摆，线接到列表靠来源那一侧的正中。 */
  pointer?: XYPosition;
}

interface MaterialPickState {
  targetNodeId: string;
  slot?: CanvasVideoFrameSlot;
  selectableNodeIds: ReadonlySet<string>;
}

interface PreviewState {
  sourceRect: DOMRect | null;
  nodeId: string;
  title: string;
  version: CanvasContentVersion;
}

interface MediaOperationState {
  nodeId: string;
  title: string;
  tool: CanvasMediaTool;
  version: CanvasMediaVersion;
}

interface MattingPromptState {
  nodeId: string;
  title: string;
  versionId: string;
  bytes: number;
}

interface MaskEditState {
  open: boolean;
  mode: 'inpaint' | 'outpaint';
  nodeId: string;
  title: string;
  version: CanvasMediaVersion;
}

interface AngleState {
  nodeId: string;
  title: string;
  version: CanvasMediaVersion;
}

interface MediaReplaceTarget {
  nodeId: string;
  title: string;
  kind: 'image' | 'video' | 'audio';
  hadContent: boolean;
  returnNodeId?: string;
}

interface ViewportSyncToken {
  projectId: string;
  viewport: Viewport;
}

interface LiveNodeLayout {
  nodeId: string;
  position: CanvasPoint;
  size: CanvasSize;
}

function materializeEmptyTextContent(document: CanvasDocument): {
  document: CanvasDocument;
  versionIds: Map<string, string>;
} {
  const versionIds = new Map<string, string>();
  const contentVersions = { ...document.content_versions };
  const nodes = document.nodes.map(node => {
    if (node.type !== 'text' || node.data.current_version_id) return node;
    const versionId = makeId('version');
    versionIds.set(node.id, versionId);
    contentVersions[versionId] = {
      version_id: versionId,
      kind: 'text',
      text: '',
      created_at: new Date().toISOString(),
      sha256: CANVAS_LOCAL_VERSION_SHA,
      origin: { kind: 'user_edit' },
    };
    return { ...node, data: { ...node.data, current_version_id: versionId } };
  });
  return {
    document: versionIds.size ? { ...document, nodes, content_versions: contentVersions } : document,
    versionIds,
  };
}

/** 逐条按对象引用缓存的签名片段。
 *
 *  签名原来是每次 render 现算一遍：给全部节点各建一个数组，再 JSON.stringify 整个结构。
 *  200 个节点时，打字每一次按键、拖动每一帧都要付这笔钱。节点对象本身是不可变的
 *  （commit 只重建被改的那个），所以片段可以挂在对象上，只有真变过的那条才重算。
 *
 *  片段用 JSON 而不是自己拼分隔符：标题是用户输入，JSON 的转义保证不同的图不会拼出同一个串。 */
const mentionNodeFragments = new WeakMap<CanvasNode, string>();
const mentionConnectionFragments = new WeakMap<CanvasConnection, string>();

function mentionNodeFragment(node: CanvasNode): string {
  const cached = mentionNodeFragments.get(node);
  if (cached !== undefined) return cached;
  const fragment = JSON.stringify(
    node.type === 'text' || node.type === 'image' || node.type === 'video' || node.type === 'audio'
        ? [
          node.id,
          node.title,
          node.type,
          node.data.current_version_id,
          node.data.generation_draft?.mode ?? null,
          node.type === 'image' ? node.data.annotation?.rendered_version_id ?? null : null,
          // 结果组成员表决定插件节点收到哪几张（expand_result_stack）。
          node.type === 'image' ? node.data.result_stack?.member_node_ids ?? null : null,
        ]
        // 分组的成员表必须进签名：它决定面板上看到哪几张参考图。漏了的话把节点拖进 / 拖出
        // 分组只换了分组这一个对象，签名值不变，下游 memo 一个都不重算，参考位要硬刷新才更新。
        : [node.id, node.title, node.type,
          node.type === 'group' ? node.data.member_node_ids : null],
  );
  mentionNodeFragments.set(node, fragment);
  return fragment;
}

function mentionConnectionFragment(connection: CanvasConnection): string {
  const cached = mentionConnectionFragments.get(connection);
  if (cached !== undefined) return cached;
  const fragment = JSON.stringify([
    connection.id, connection.source_node_id, connection.target_node_id,
    connection.role === 'input' && connection.annotated === true,
    connection.role === 'input' ? connection.annotation_delivery ?? null : null,
    connection.role === 'input' ? connection.slot ?? null : null,
  ]);
  mentionConnectionFragments.set(connection, fragment);
  return fragment;
}

export function canvasMentionGraphSignature(document: CanvasDocument | null): string {
  if (!document) return '';
  const nodes = document.nodes.map(mentionNodeFragment).join(',');
  const connections = document.connections
    .filter(connection => connection.role === 'input')
    .map(mentionConnectionFragment)
    .join(',');
  return `${nodes}|${connections}`;
}

/** Agent 一轮对画布的改动：每次落盘一步（落盘前后的本页文档），撤销时只反转这些步骤。 */
interface ExternalRound {
  steps: Array<{ before: CanvasDocument; after: CanvasDocument }>;
  /** 这一轮在撤销栈里占的那一步（第一次落盘前的文档）。 */
  stackSnapshot: CanvasDocument;
  pastLength: number;
  deleted: number;
  toastId: string | number;
  /** 本页 Agent 还在跑：之后的落盘并进这一轮。 */
  open: boolean;
}

interface CanvasClipboardPayload {
  source?: {kind: 'remote'; peerKey: string; projectId: string};
  schema_version: 1;
  source_project_id: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
}

// 鼠标中键（button 1）拖动平移。原来是空数组 —— 任何鼠标键都不触发拖动平移，画布只能靠
// 触控板双指滑动或 Space/Ctrl+拖动移动，用鼠标的画师在空白处按中键完全没反应。左键留给
// selectionOnDrag 框选，右键留给上下文菜单，所以这里只放中键。
const CANVAS_MOUSE_PAN_BUTTONS: number[] = [1];
// 滚轮语义必须按输入设备分：鼠标滚轮要缩放，触控板双指滑动要平移。两者用的是同一个 wheel
// 事件、deltaMode 也都是 0，运行时区分不了，所以只能按平台近似（macOS 触控板优先，其余鼠标
// 优先）。捏合缩放走 zoomOnPinch，两个平台都保留。
const CANVAS_WHEEL_ZOOMS = !/Mac/i.test(navigator.userAgent);
// 删除节点的按键也得按平台分。macOS 键盘上那个「delete」键发出来的是 Backspace（物理上没有
// 独立的 Delete 键），所以 mac 必须收 Backspace；Windows / Linux 有独立 Delete 键，而 Backspace
// 在那边就是纯粹的「退格」—— 画师在文本节点里打错字按退格，整个节点直接没了（2026-08-27 实测
// 反馈，节点连内容一起消失）。所以 mac 收两个键，其余平台只收 Delete。
const CANVAS_DELETE_KEYS: readonly string[] = /Mac/i.test(navigator.userAgent)
  ? ['Delete', 'Backspace']
  : ['Delete'];
const CANVAS_NODE_CLIPBOARD_TYPE = 'application/x-game-atelier-canvas-nodes';
const CANVAS_MIN_ZOOM = 0.08;
const CANVAS_MAX_ZOOM = 5;
// xyflow 默认只认 Meta/Control，Shift 归 selectionKeyCode（框选）。框选已经由 selectionOnDrag
// 接管，所以把 Shift 也并进多选键、并把 selectionKeyCode 置空，和快捷键面板写的「Shift / ⌘ 点击」对齐。
const CANVAS_MULTI_SELECT_KEYS = ['Shift', 'Meta', 'Control'];
type CanvasLibraryMode = 'assets' | 'prompts' | 'team';

interface CanvasNoticeAction { label: string; run: () => void }

const TOOL_NOTICE_MS = 1800;
/** 撤销 / 重做的边缘胶囊停留时长（Q7）。 */
const CANVAS_HISTORY_HINT_MS = 1500;
/** 读得比这快就不显示加载转圈（Q12：延迟 300ms 后显示）。 */
const CANVAS_LOADING_DELAY_MS = 300;
/** 屏上 A→B 的视口平移用 in-out 曲线（与 --ease-atelier-in-out 同值）。 */
const CANVAS_VIEWPORT_EASE_IN_OUT = cubicBezier(...MOTION_EASE.inOut);
/** 带动作或多条的提示要留出读完、点按钮的时间。 */
const TOOL_NOTICE_LONG_MS = 6000;
const REPRODUCE_CONFLICT_MESSAGE = '画布已更新，请重试';
const CANVAS_SAVE_FAILED_LEAVE_MESSAGE = '自动保存失败，现在离开会丢掉未保存的改动。';
const SAVE_RETRY_QUIET_MS = 1500;
const SAVE_RETRY_STUCK_MS = 15_000;
const SAVE_RETRY_STUCK_ATTEMPTS = 4;
const SAVE_RETRY_DELAYS_MS = [1000, 3000, 10_000];
const SAVE_RETRY_PROBE_MS = 10_000;

const CANVAS_CHROME_BUTTON_CLASS = 'grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

// 模块级常量：xyflow 按引用比较 props，内联对象会让它每次渲染都当成变更。
const CANVAS_PRO_OPTIONS = { hideAttribution: true };

export function CanvasEditor(props: {
  transport?: CanvasTransport;
  projectId: string;
  onBack: () => void;
  onSwitchProject: (projectId: string) => void;
}) {
  const transport = props.transport ?? localCanvasTransport;
  return <ReactFlowProvider>{transport.kind === 'remote'
    ? <SharedCanvasView transport={transport} projectId={props.projectId} onBack={props.onBack} zoomDock={<ReadOnlyZoomDock />} />
    : <CanvasEditorInner key={props.projectId} {...props} />}</ReactFlowProvider>;
}

function ReadOnlyZoomDock() {
  const flow = useReactFlow();
  return <CanvasZoomDock assetControl={null} minimapToggle={null} onZoomIn={() => void flow.zoomIn()}
    onZoomOut={() => void flow.zoomOut()} onResetZoom={() => void flow.zoomTo(1)} onFitView={() => void flow.fitView()} />;
}

function CanvasEditorInner({
  projectId,
  onBack,
  onSwitchProject,
}: {
  projectId: string;
  onBack: () => void;
  onSwitchProject: (projectId: string) => void;
}) {
  const narrowViewport = useNarrowCanvasViewport();
  const [, setLocation] = useLocation();
  const [document, setDocument] = useState<CanvasDocument | null>(null);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [referencePreview, setReferencePreview] = useState<CreationAsset | null>(null);
  const [specsOpen, setSpecsOpen] = useState(false);
  const [projects, setProjects] = useState<CanvasProject[]>([]);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [routes, setRoutes] = useState<ModelRoute[]>([]);
  // 生成节点选模型用的厂商列表 =「自动」+ 真实 KEY；局部编辑、分层、AI高清等单项工具仍只用真实 KEY。
  const providers = useMemo(() => withAutoProvider(keys, routes), [keys, routes]);
  const latestProviders = useRef(providers);
  useEffect(() => { latestProviders.current = providers; }, [providers]);
  // 公告「快速添加」等别处改了密钥的模型列表：只刷新列表，不动节点上已选的模型。
  useEffect(() => {
    const refresh = () => {
      void listKeys().then(resp => setKeys(resp.keys.filter(key => key.enabled !== false).sort((left, right) => (
        Number(Boolean(right.is_default)) - Number(Boolean(left.is_default))
      )))).catch(() => undefined);
      void listModelRoutes().then(setRoutes).catch(() => undefined);
    };
    window.addEventListener(KEYS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(KEYS_CHANGED_EVENT, refresh);
  }, []);
  // 路由列表单独读：只决定有没有「自动」项，读不到或慢都不挡画布打开。
  useEffect(() => {
    let cancelled = false;
    void listModelRoutes().then(rows => { if (!cancelled) setRoutes(rows); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const [canvasUiPreferences, setCanvasUiPreferences] = useState<CanvasUiPreferences>(DEFAULT_CANVAS_UI_PREFERENCES);
  // 本机能不能抠图：进画布时问一次，不支持就不在工具条上露出抠图（点了才报错的入口不该出现）。
  const [mattingAvailable, setMattingAvailable] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => getCanvasMattingModel())
      .then(status => { if (!cancelled) setMattingAvailable(status?.available !== false); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const [canvasUiPreferencesError, setCanvasUiPreferencesError] = useState<string | null>(null);
  const [libraryMode, setLibraryMode] = useState<CanvasLibraryMode | null>(null);
  // 宽屏（≥1280px）资产库与 Agent 面板并列：资产库靠左、Agent 靠右。窄屏仍共用右侧一个位置，
  // 打开资产库时 Agent 面板只是藏起来，不卸载（等待中的确认卡、流式回复都还在），关掉资产库就回来。
  const wideViewport = useWideCanvasViewport();
  const [agentOpen, setAgentOpen] = useState(false);
  const agentHidden = agentOpen && Boolean(libraryMode) && !wideViewport;
  function toggleAgent() {
    setAddOpen(false);
    setCreateMenu(null);
    if (agentOpen && !agentHidden) { setAgentOpen(false); return; }
    if (!libraryMode || wideViewport) { setAgentOpen(true); return; }
    closeLibrary(); setAgentOpen(true);
  }
  // 提示条的「看看」等延后回调会在旧渲染的闭包里跑，判断面板开没开要读当前值。
  const [creationAssetSaveRequest, setCreationAssetSaveRequest] = useState<CreationAssetSaveRequest | null>(null);
  const [submittingNodeIds, setSubmittingNodeIds] = useState<Set<string>>(() => new Set());
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set());
  // 供异步回调读当前选择用：后台自动动作要判断「用户是不是已经去点别的了」。
  const latestSelectedNodeIds = useRef(selectedNodeIds);
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<Set<string>>(() => new Set());
  const [dismissedGenerationPanelNodeId, setDismissedGenerationPanelNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [connectionInProgress, setConnectionInProgress] = useState(false);
  const [materialPick, setMaterialPick] = useState<MaterialPickState | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [createMenu, setCreateMenu] = useState<CreateMenuState | null>(null);
  // 右键菜单：nodeId 为空是画布空白处，否则是节点（作用于当前选择）。
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flow: XYPosition; nodeId: string | null } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [generationPreferencesOpen, setGenerationPreferencesOpen] = useState(false);
  const [generationPreferencesTab, setGenerationPreferencesTab] = useState<CanvasGenerationPreferencesTab>('image');
  const [generationPreferencesSaving, setGenerationPreferencesSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 只对当前这条 error 生效：message 不匹配就不渲染按钮，换了别的错误自然失效。
  const [errorAction, setErrorAction] = useState<{ message: string; label: string; run: () => void } | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  // 服务换新版本时，有未落盘的画布改动就不自动刷新页面（规格 D3）。
  useEffect(() => {
    markUnsavedChanges('canvas-editor', saveState !== 'saved');
    return () => markUnsavedChanges('canvas-editor', false);
  }, [saveState]);
  const [saveErrorDetail, setSaveErrorDetail] = useState<string | null>(null);
  // 自动保存失败后的退避重试（规格 2.4）：0–1.5s 静默；之后显示中性胶囊「保存重试中…」；
  // 超过 15s 或连续失败 4 次转警示色并给「立即重试」，后台每 10s 继续试。
  const [saveRetryPhase, setSaveRetryPhase] = useState<'none' | 'quiet' | 'retrying' | 'stuck'>('none');
  const saveFailure = useRef<{ since: number; attempts: number } | null>(null);
  const saveRetryTimer = useRef<number | null>(null);
  const saveRetryPhaseTimer = useRef<number | null>(null);
  const [activePreview, setPreview] = useState<PreviewState | null>(null);
  const dialogPreview = activePreview?.version.kind === 'image' ? null : activePreview;
  const retainedDialogPreview = useRetained(dialogPreview);
  const preview = activePreview ?? retainedDialogPreview;
  const [compareViewId, setCompareViewId] = useState<string | null>(null);
  const [layerPreviewId, setLayerPreviewId] = useState<string | null>(null);
  const [mediaOperation, setMediaOperation] = useState<MediaOperationState | null>(null);
  const [mediaOperationBusy, setMediaOperationBusy] = useState(false);
  const [mediaPlaceholders, setMediaPlaceholders] = useState<CanvasMediaOperationPlaceholder[]>([]);
  const mediaPlaceholdersRef = useRef<CanvasMediaOperationPlaceholder[]>([]);
  const updateMediaPlaceholders = useCallback((next: CanvasMediaOperationPlaceholder[]) => {
    mediaPlaceholdersRef.current = next;
    setMediaPlaceholders(next);
  }, []);
  // 框选期间 React Flow 会把与选中节点相连的边一并选中，边上的剪刀就冒出来了。
  // 边的选中只认点击，框选期间到达的 select 变更一律丢弃。
  const selectionRectActive = useRef(false);
  // 框选命中由我们自己按文档几何算，不用 xyflow 的 getNodesInside：它把没测量过连接点的节点
  // （onlyRenderVisibleElements 下从没渲染过的屏外节点）一律当成「在框内」，随手一框就选中一大片。
  // 框选期间节点设为不可选，让 xyflow 那一路选不出任何东西。只改 xyflow 的内部节点，不进 flowNodes：
  // 原来翻 selectable 会让 flowNodes 整体重建两次（开始、结束各一次），每个节点外壳都跟着重渲染。
  const sweepUnsubscribe = useRef<(() => void) | null>(null);
  // 展开中的结果组（封面 id）。只是界面状态，刷新后全部收起。
  const [expandedResultStackIds, setExpandedResultStackIds] = useState<ReadonlySet<string>>(() => new Set());
  const [mediaOperationError, setMediaOperationError] = useState<string | null>(null);
  const [mattingPrompt, setMattingPrompt] = useState<MattingPromptState | null>(null);
  const [mattingDownloading, setMattingDownloading] = useState(false);
  const [maskEdit, setMaskEdit] = useState<MaskEditState | null>(null);
  const [maskEditBusy, setMaskEditBusy] = useState(false);
  const [maskEditError, setMaskEditError] = useState<string | null>(null);
  const [angleState, setAngleState] = useState<AngleState | null>(null);
  const [angleBusy, setAngleBusy] = useState(false);
  const [angleError, setAngleError] = useState<string | null>(null);
  const [mediaReplaceTarget, setMediaReplaceTarget] = useState<MediaReplaceTarget | null>(null);
  const [mediaReplaceBusyNodeIds, setMediaReplaceBusyNodeIds] = useState<Set<string>>(() => new Set());
  const [mediaReplaceError, setMediaReplaceError] = useState<{ nodeId: string; message: string } | null>(null);
  // 撤销 / 重做改动全在视口外时，边缘显示 1.5s 的「已撤销 · 左侧 2 处」。
  const [historyHint, setHistoryHint] = useState<CanvasHistoryHint | null>(null);
  const historyHintTimer = useRef<number | null>(null);
  const [toolNotice, setToolNotice] = useState<string | null>(null);
  const [toolNoticeAction, setToolNoticeAction] = useState<CanvasNoticeAction | null>(null);
  const [shareRequest, setShareRequest] = useState<TeamShareDialogRequest | null>(null);
  const [libraryPanelKey, setLibraryPanelKey] = useState(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceMediaRef = useRef<HTMLInputElement>(null);
  const editorRegionRef = useRef<HTMLElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const assetLibraryTriggerRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const openGenerationPreferences = useCallback((tab: CanvasGenerationPreferencesTab) => {
    setGenerationPreferencesTab(tab);
    setGenerationPreferencesOpen(true);
  }, []);
  const flowNodeCache = useRef(new Map<string, {
    node: CanvasNode;
    selected: boolean;
    liveLayout: LiveNodeLayout | undefined;
    hidden: boolean;
    stackMember: boolean;
    shownVersionId: string | null;
    flowNode: FlowNode;
  }>());
  // 图片节点屏上已经画出来的版本（节点卡在新图解码完成时上报）。版本刚换、新图还没盖上来时，
  // 节点尺寸先按屏上那一版算：按新比例改尺寸与新图淡入同帧发生，旧图不会先被拉成新比例。
  // 第一次见到的节点按当前版本记，打开画布、新建节点都不压尺寸。
  const revealedImageVersions = useRef(new Map<string, string | null>());
  const [revealRevision, setRevealRevision] = useState(0);
  const reportMediaRevealed = useCallback((nodeId: string, versionId: string) => {
    const revealed = revealedImageVersions.current;
    if (revealed.get(nodeId) === versionId) return;
    revealed.set(nodeId, versionId);
    setRevealRevision(value => value + 1);
  }, []);
  const flowEdgeCache = useRef(new Map<string, {
    connection: CanvasConnection;
    active: boolean;
    selected: boolean;
    sourceTitle: string;
    targetTitle: string;
    source: string;
    target: string;
    flowEdge: Edge;
  }>());
  const flowEdgesRef = useRef<Edge[]>([]);
  const [liveNodeLayout, setLiveNodeLayout] = useState<LiveNodeLayout | null>(null);
  const pendingLiveNodeLayout = useRef<LiveNodeLayout | null>(null);
  const activeResizeNodeId = useRef<string | null>(null);
  const resizePreviewFrame = useRef<number | null>(null);
  const dirtyVersion = useRef(0);
  const saveBeforePanelFocus = useRef(false);
  const [dirtySignal, setDirtySignal] = useState(0);
  const activeTextEditingNodeIds = useRef(new Set<string>());
  const autosaveObservedDirtyVersion = useRef(0);
  const [textEditingSignal, setTextEditingSignal] = useState(0);
  const imeComposing = useRef(false);
  const serverRevision = useRef(0);
  const saveInFlight = useRef<Promise<void> | null>(null);
  const saveQueued = useRef<CanvasDocument | null>(null);
  const editorMounted = useRef(false);
  const runSubmissionInFlight = useRef(false);
  const libraryInsertInFlight = useRef(false);
  const libraryInsertCommand = useRef<Promise<void> | null>(null);
  const mediaOperationInFlight = useRef(false);
  const documentCommandInFlight = useRef(false);
  const uploadQueue = useRef<Promise<void> | null>(null);
  // 新建节点后把视口对到它们上面；实现在 runViewportCommand 定义之后挂到 ref 上。
  const focusNewNodesHandler = useRef<(nodes: readonly CanvasNode[]) => void>(() => undefined);
  const canvasUiPreferencesSaveInFlight = useRef(false);
  const toolNoticeTimer = useRef<number | null>(null);
  /** 每次渲染换成最新的处理函数；window 监听只挂一次。 */
  const teamAssetActionRef = useRef<(action: TeamAssetAction) => void>(() => undefined);
  const pendingTeamAssetAction = useRef<TeamAssetAction | null>(null);
  const latestDocument = useRef<CanvasDocument | null>(null);
  // 前端提交队列的纪元：「全部停止」、离开画布、卸载时加一，之前排进队列还没发出的计费提交一律作废。
  const submissionEpoch = useRef(0);
  const pendingTextVersions = useRef(new Map<string, string>());
  // Agent 经 MCP 改画布后的重载入口（#92）。用 ref 是因为保存失败分支（flushSave）声明在它之前，
  // 又不能把它塞进 flushSave 的依赖里让保存闭包每次重建。
  const reloadDocumentRef = useRef<() => Promise<void>>(async () => undefined);
  const {cards:sharedCards, refresh:refreshShares} = useSharedCanvases();
  const ownShares = sharedCards.filter(card=>card.is_self);
  const sharedOwner = ownShares.some(card=>card.project_id === projectId);
  const blockedHistory = useRef(new WeakSet<CanvasDocument>());
  const remoteDocumentChanged = useRef<(revision: number | null) => void>(() => undefined);
  const reversePromptConfigAttempts = useRef(new Set<string>());
  // 只有本会话提交过的反推 run 才会自动生成图片配置节点。原来的判据是「这个结果节点上还没挂配置」，
  // 于是删掉配置节点后刷新，甚至只是第一次打开一个有历史反推记录的项目，节点都会自己长回来。
  const reversePromptConfigEligibleRuns = useRef(new Set<string>());
  const ownerRoom = useCollabRoom(sharedOwner ? '/api/collab/shares/'+encodeURIComponent(projectId)+'/ws' : null,
    revision=>remoteDocumentChanged.current(revision));
  const {updatePresence:ownerPresence} = ownerRoom;
  useEffect(()=>{ if (sharedOwner) ownerPresence([...selectedNodeIds]); },[sharedOwner,ownerPresence,selectedNodeIds]);
  const history = useRef<{ past: CanvasDocument[]; future: CanvasDocument[] }>({ past: [], future: [] });
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  // D12：离开一个「新建项目」建出来、什么都没做的空项目时清掉它。
  useEffect(() => {
    const release = openCanvasEditor(projectId);
    return () => {
      release();
      // 资格由服务端核验（版本仍是 0、没改名、没改设置、没有内容 / 任务 / Agent 会话），这里只管触发。
      scheduleFreshCanvasProjectCleanup(projectId, discardEmptyCanvasProject);
    };
  }, [projectId]);
  // 本页最后一次确认过的服务端文档：外部改动到来时做三方合并的基准（首屏、保存成功、外部重载时更新）。
  const serverBaseDocument = useRef<CanvasDocument | null>(null);
  // 外部（Agent）改动的「这一轮」：按 Agent 运行区间划分（会话在跑期间的几次落盘是同一轮），
  // 每次落盘记一步 before → after，「撤销本轮」只反转这些步骤；撤销栈里同一轮也只占一步。
  const externalRound = useRef<ExternalRound | null>(null);
  const agentActiveRef = useRef(false);
  const undoExternalRoundRef = useRef<(round: ExternalRound) => void>(() => undefined);
  const undoToRef = useRef<(target?: CanvasDocument) => void>(() => undefined);
  const viewportSync = useRef<ViewportSyncToken | null>(null);
  const nodeClipboard = useRef<CanvasClipboardPayload | null>(null);
  const pasteSequence = useRef(0);
  const pendingViewportCommand = useRef<Promise<void> | null>(null);
  const viewportCommandEpoch = useRef(0);
  const cancelViewportCommand = useRef<(() => void) | null>(null);
  const projectNameEditorRef = useRef<EditableTextHandle>(null);
  const canvasMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const projectRenameInFlight = useRef(false);
  const {
    screenToFlowPosition,
    flowToScreenPosition,
    setViewport,
    fitView,
    fitBounds,
    getViewport,
    getZoom,
    setCenter,
    zoomIn,
    zoomOut,
    zoomTo,
  } = useReactFlow<FlowNode>();
  const flowStore = useStoreApi<FlowNode>();
  const [focusVariableNodeId, setFocusVariableNodeId] = useState<string | null>(null);
  const consumeVariableFocus = useCallback(() => setFocusVariableNodeId(null), []);
  useEffect(() => {
    const claim = (event: Event) => {
      const action = (event as CustomEvent<TeamAssetAction>).detail;
      if (!action) return;
      event.preventDefault();
      teamAssetActionRef.current(action);
    };
    window.addEventListener(TEAM_ASSET_ACTION_EVENT, claim);
    return () => window.removeEventListener(TEAM_ASSET_ACTION_EVENT, claim);
  }, []);

  const closeLibrary = useCallback(() => {
    const trigger = assetLibraryTriggerRef.current;
    setLibraryMode(null);
    requestAnimationFrame(() => trigger?.focus());
  }, []);

  const preserveImageEditResultHistory = useCallback((current: CanvasDocument, insertedIds: ReadonlySet<string>) => {
    if (!insertedIds.size) return;
    history.current.past = history.current.past.map(snapshot => retainNewImageEditResults(snapshot, current, insertedIds));
    history.current.future = history.current.future.map(snapshot => retainNewImageEditResults(snapshot, current, insertedIds));
  }, []);

  const mergeRunDocument = useCallback((
    remote: CanvasDocument,
    runIds: ReadonlySet<string>,
    resultNodeIds: ReadonlySet<string> = new Set(),
    groupResultIds?: ReadonlySet<string>,
  ) => {
    serverRevision.current = Math.max(serverRevision.current, remote.revision);
    setDocument(current => {
      if (!current || remote.revision < current.revision) return current;
      const remoteNodes = new Map(remote.nodes.map(node => [node.id, node]));
      const currentNodeIds = new Set(current.nodes.map(node => node.id));
      const serverAddedNodeIds = new Set<string>();
      for (const node of remote.nodes) {
        if (isContentNode(node) && (runIds.has(node.data.active_run_id ?? '') || resultNodeIds.has(node.id))
          && !currentNodeIds.has(node.id)) serverAddedNodeIds.add(node.id);
      }
      const serverAddedNodes = remote.nodes.filter(node => serverAddedNodeIds.has(node.id));
      const nodes = [...current.nodes.map(node => {
        const serverNode = remoteNodes.get(node.id);
        if (node.type === 'group' && serverNode?.type === 'group') {
          const additions = serverNode.data.member_node_ids.filter(id => serverAddedNodeIds.has(id));
          return additions.length ? { ...node, data: { ...node.data,
            member_node_ids: [...new Set([...node.data.member_node_ids, ...additions])],
          } } : node;
        }
        if (
          node.type === 'layer_stack'
          && serverNode?.type === 'layer_stack'
          && resultNodeIds.has(node.id)
        ) {
          return { ...node, data: serverNode.data };
        }
        if (node.type === 'image_edit' && serverNode?.type === 'image_edit') {
          return { ...node, data: { ...node.data, active_run_id: serverNode.data.active_run_id } };
        }
        if (!serverNode || !isContentNode(node) || !isContentNode(serverNode)) return node;
        // 本地仍挂着这批 run 的节点也要认领：逐张提交的多图，终态那一轮服务端已清掉封面的
        // active_run_id，新版本又不挂在封面上，只按服务端两样认领会把本地的旧 run 留下来。
        if (
          !resultNodeIds.has(node.id)
          && !runIds.has(serverNode.data.active_run_id ?? '')
          && !runIds.has(node.data.active_run_id ?? '')
        ) return node;
        // A same-revision Job response cannot replace text created locally while it was in flight.
        const localVersion = node.data.current_version_id;
        const hasUnsavedContent = activeTextEditingNodeIds.current.has(node.id)
          || (localVersion && (pendingTextVersions.current.get(node.id) === localVersion
            || !remote.content_versions[localVersion]));
        const frame = groupResultIds?.has(node.id) ? groupResultFrame(node, serverNode, current.content_versions) : {};
        return {
          ...node, ...(frame.size ? {size: frame.size} : {}),
          data: {
            ...node.data, ...(frame.display ? {display: frame.display} : {}),
            current_version_id: hasUnsavedContent ? localVersion : serverNode.data.current_version_id,
            active_run_id: serverNode.data.active_run_id,
          },
        } as CanvasContentNode;
      }), ...serverAddedNodes];
      const nodeIds = new Set(nodes.map(node => node.id));
      const connectionIds = new Set(current.connections.map(connection => connection.id));
      const serverRunConnections = remote.connections.filter(connection => (
        !connectionIds.has(connection.id)
        && nodeIds.has(connection.source_node_id)
        && nodeIds.has(connection.target_node_id)
        && serverAddedNodeIds.has(connection.target_node_id)
      ));
      const merged: CanvasDocument = normalizeCanvasGroups({
        ...current,
        revision: remote.revision,
        updated_at: remote.updated_at,
        nodes,
        connections: [...current.connections, ...serverRunConnections],
        content_versions: acceptServerContentVersions(
          current.content_versions,
          remote.content_versions,
        ),
      });
      preserveImageEditResultHistory(merged, serverAddedNodeIds);
      // 三方合并的基准跟着收下这批 run 涉及的节点：否则它们一直被当成「本页改过」，
      // Agent 之后再改同一个节点时，本地旧值会盖掉 Agent 的改动。
      const base = serverBaseDocument.current;
      if (base) {
        const runNodeIds = new Set(serverAddedNodeIds);
        for (const node of current.nodes) {
          const serverNode = remoteNodes.get(node.id);
          if (!serverNode) continue;
          if (resultNodeIds.has(node.id)
            || runIds.has(canvasNodeActiveRunId(node) ?? '')
            || runIds.has(canvasNodeActiveRunId(serverNode) ?? '')) runNodeIds.add(node.id);
        }
        // 用合并后本页手里的对象：它们的 run 字段已是服务端的值，其余字段与本地一致。
        const mergedNodes = new Map(merged.nodes.map(node => [node.id, node]));
        const baseIds = new Set(base.nodes.map(node => node.id));
        serverBaseDocument.current = {
          ...base,
          nodes: [
            ...base.nodes.map(node => (runNodeIds.has(node.id) ? mergedNodes.get(node.id) ?? node : node)),
            ...merged.nodes.filter(node => runNodeIds.has(node.id) && !baseIds.has(node.id)),
          ],
          connections: [...base.connections, ...serverRunConnections],
          content_versions: { ...base.content_versions, ...remote.content_versions },
        };
      }
      if (saveQueued.current) saveQueued.current = merged;
      return merged;
    });
  }, [preserveImageEditResultHistory]);

  // 出图记录的同步整体在 useCanvasJobSync 里：epoch 记账、兜底轮询、SSE 订阅都归它，
  // 这里只把「结果并回文档」这一半交出去。必须声明在下面那个切项目的 effect 之前——
  // 那个 effect 的依赖数组要引用 acceptJobs / resetJobSync。
  const { indicator: agentIndicator, onAgentEvent } = useCanvasAgentIndicator(projectId);
  agentActiveRef.current = agentIndicator !== 'idle';
  // Agent 停下：这一轮结束，之后的落盘算新的一轮。
  useEffect(() => {
    if (agentIndicator === 'idle' && externalRound.current) externalRound.current.open = false;
  }, [agentIndicator]);
  const { latest: groupRuns, steps: groupSteps, refresh: refreshGroupRuns } = useCanvasGroupRuns(
    projectId, !!document?.nodes.some(node => node.type === 'group'));
  const { jobs, acceptJobs, applyLocalJob, reset: resetJobSync } = useCanvasJobSync({
    projectId,
    mergeRunDocument,
    onError: setError,
    onDocumentChanged: revision => remoteDocumentChanged.current(revision),
    onCanvasAgent: onAgentEvent,
    refreshGroupRuns,
  });
  const jobsByRunId = useMemo(() => new Map(
    jobs.flatMap(job => job.canvas_run ? [[job.canvas_run.run_id, job] as const] : []),
  ), [jobs]);

  const setTextEditing = useCallback((nodeId: string, editing: boolean) => {
    const active = activeTextEditingNodeIds.current;
    const changed = editing ? !active.has(nodeId) : active.has(nodeId);
    if (!changed) return;
    if (editing) active.add(nodeId);
    else active.delete(nodeId);
    setTextEditingSignal(current => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDocument(null);
    setSelectedNodeIds(new Set());
    setSelectedConnectionIds(new Set());
    setHoveredNodeId(null);
    setConnectionInProgress(false);
    setMaterialPick(null);
    setSubmittingNodeIds(new Set());
    setAddOpen(false);
    setCreateMenu(null);
    setShortcutsOpen(false);
    setGenerationPreferencesOpen(false);
    setGenerationPreferencesSaving(false);
    setLibraryMode(null);
    setCreationAssetSaveRequest(null);
    setCanvasUiPreferences(DEFAULT_CANVAS_UI_PREFERENCES);
    setCanvasUiPreferencesError(null);
    setPreview(null);
    setLayerPreviewId(null);
    setMediaOperation(null);
    setMediaOperationBusy(false);
    setMediaOperationError(null);
    setMaskEdit(null);
    setMaskEditBusy(false);
    setMaskEditError(null);
    setAngleState(null);
    setAngleBusy(false);
    setAngleError(null);
    setMediaReplaceTarget(null);
    setMediaReplaceBusyNodeIds(new Set());
    setMediaReplaceError(null);
    setToolNotice(null);
    if (toolNoticeTimer.current !== null) window.clearTimeout(toolNoticeTimer.current);
    flowNodeCache.current.clear();
    revealedImageVersions.current.clear();
    flowEdgeCache.current.clear();
    flowEdgesRef.current = [];
    activeResizeNodeId.current = null;
    pendingLiveNodeLayout.current = null;
    if (resizePreviewFrame.current !== null) window.cancelAnimationFrame(resizePreviewFrame.current);
    resizePreviewFrame.current = null;
    setLiveNodeLayout(null);
    history.current = { past: [], future: [] };
    serverBaseDocument.current = null;
    if (externalRound.current) notify.dismiss(externalRound.current.toastId);
    externalRound.current = null;
    viewportSync.current = null;
    nodeClipboard.current = null;
    pasteSequence.current = 0;
    viewportCommandEpoch.current += 1;
    cancelViewportCommand.current?.();
    cancelViewportCommand.current = null;
    pendingViewportCommand.current = null;
    pendingTextVersions.current.clear();
    resetJobSync();
    reversePromptConfigAttempts.current.clear();
    reversePromptConfigEligibleRuns.current.clear();
    dirtyVersion.current = 0;
    setDirtySignal(0);
    activeTextEditingNodeIds.current.clear();
    autosaveObservedDirtyVersion.current = 0;
    setTextEditingSignal(0);
    serverRevision.current = 0;
    runSubmissionInFlight.current = false;
    documentCommandInFlight.current = false;
    uploadQueue.current = null;
    canvasUiPreferencesSaveInFlight.current = false;
    projectRenameInFlight.current = false;
    void getCanvasUiPreferences()
      .then(value => {
        if (!cancelled) setCanvasUiPreferences(value);
      })
      .catch(preferencesError => {
        if (!cancelled) setCanvasUiPreferencesError((preferencesError as Error).message);
      });
    // 局部修改 / 扩图面板的费用预估要用 TokenDance 价格快照；单独取，不阻塞画布加载。
    void loadTokenDancePrices();
    Promise.all([
      listCanvasProjects(true),
      localCanvasTransport.read(projectId),
      listKeys(),
      listCanvasJobs(projectId),
    ])
      .then(([projectRows, canvasDocument, keyRows, canvasJobs]) => {
        if (cancelled) return;
        const hydrated = materializeEmptyTextContent(canvasDocument);
        for (const [nodeId, versionId] of hydrated.versionIds) {
          pendingTextVersions.current.set(nodeId, versionId);
        }
        setProjects(projectRows);
        const loaded = normalizeCanvasGroups(hydrated.document);
        setDocument(loaded);
        serverBaseDocument.current = loaded;
        serverRevision.current = canvasDocument.revision;
        if (hydrated.versionIds.size) {
          dirtyVersion.current += 1;
          setDirtySignal(dirtyVersion.current);
        }
        setKeys(keyRows.keys.filter(key => key.enabled !== false).sort((left, right) => (
          Number(Boolean(right.is_default)) - Number(Boolean(left.is_default))
        )));
        acceptJobs(canvasJobs);
      })
      .catch(loadError => {
        if (!cancelled) setError((loadError as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (toolNoticeTimer.current !== null) window.clearTimeout(toolNoticeTimer.current);
      if (resizePreviewFrame.current !== null) window.cancelAnimationFrame(resizePreviewFrame.current);
    };
  }, [acceptJobs, projectId, resetJobSync]);

  const mergeSubmittedRunDocument = useCallback((
    remote: CanvasDocument,
    job: Job,
    dirtyAtSubmission: number,
  ) => {
    serverRevision.current = Math.max(serverRevision.current, remote.revision);
    const context = job.canvas_run;
    const latest = latestDocument.current;
    if (!latest || !context) {
      setDocument(remote);
      return;
    }
    const current = latest;
    const remoteNodes = new Map(remote.nodes.map(node => [node.id, node]));
    const remoteResult = remoteNodes.get(context.result_node_id);
    const hasResult = current.nodes.some(node => node.id === context.result_node_id);
    const resultReusesSurface = context.result_node_id === context.snapshot.surface_node_id;
    const nodes = current.nodes.map(node => {
      const remoteNode = remoteNodes.get(node.id);
      if (node.type === 'image_edit' && remoteNode?.type === 'image_edit'
        && node.id === context.snapshot.surface_node_id) {
        return { ...node, data: { ...node.data, active_run_id: remoteNode.data.active_run_id } };
      }
      if (node.id !== context.result_node_id || !remoteResult) return node;
      if (node.type === 'layer_stack' && remoteResult.type === 'layer_stack') {
        return { ...node, data: remoteResult.data };
      }
      if (!isContentNode(node) || !isContentNode(remoteResult)) return node;
      return {
        ...node,
        data: {
          ...node.data,
          active_run_id: remoteResult.data.active_run_id,
          current_version_id: remoteResult.data.current_version_id,
        },
      } as CanvasContentNode;
    });
    if (!hasResult && remoteResult && !resultReusesSurface) nodes.push(remoteResult);
    const mergedNodeIds = new Set(nodes.map(node => node.id));
    const connectionIds = new Set(current.connections.map(connection => connection.id));
    const runConnections = remote.connections.filter(connection => (
      !hasResult && connection.target_node_id === context.result_node_id
      && !connectionIds.has(connection.id)
      && mergedNodeIds.has(connection.source_node_id)
      && mergedNodeIds.has(connection.target_node_id)
    ));
    const merged: CanvasDocument = {
      ...current,
      revision: remote.revision,
      updated_at: remote.updated_at,
      nodes,
      connections: [...current.connections, ...runConnections],
      content_versions: acceptServerContentVersions(
        current.content_versions,
        remote.content_versions,
      ),
    };
    if (saveQueued.current || dirtyVersion.current > dirtyAtSubmission) {
      saveQueued.current = merged;
    }
    if (!hasResult && !resultReusesSurface) preserveImageEditResultHistory(merged, new Set([context.result_node_id]));
    setDocument(merged);
  }, [preserveImageEditResultHistory]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      if (materialPick) {
        event.preventDefault();
        setMaterialPick(null);
        return;
      }
      if (addOpen) {
        event.preventDefault();
        setAddOpen(false);
        requestAnimationFrame(() => addTriggerRef.current?.focus());
        return;
      }
      if (createMenu) {
        event.preventDefault();
        setCreateMenu(null);
        requestAnimationFrame(() => editorRegionRef.current?.focus());
        return;
      }
      if (libraryMode) {
        event.preventDefault();
        closeLibrary();
        return;
      }
      if (selectedNodeIds.size || selectedConnectionIds.size) {
        event.preventDefault();
        setSelectedNodeIds(new Set());
        setSelectedConnectionIds(new Set());
        requestAnimationFrame(() => editorRegionRef.current?.focus());
      }
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [addOpen, closeLibrary, createMenu, libraryMode, materialPick, selectedConnectionIds.size, selectedNodeIds.size]);

  useEffect(() => {
    if (!addOpen) return;
    requestAnimationFrame(() => addMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
  }, [addOpen]);

  useEffect(() => {
    if (!createMenu) return;
    requestAnimationFrame(() => createMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true }));
  }, [createMenu]);

  latestDocument.current = document;
  useEffect(() => {
    if (!document) return;
    const synced = syncLayerMaterials(syncDraftLayerStackSources(document));
    if (synced === document) return;
    // 上游图片换版后，尚未运行的拆分节点必须在同一次本地收敛中更新快照与比例。
    // 已运行 / 已完成节点由 helper 明确跳过，避免历史产物跟着上游变化。
    latestDocument.current = synced;
    saveQueued.current = synced;
    setDocument(synced);
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
  }, [document]);
  useEffect(() => {
    latestSelectedNodeIds.current = selectedNodeIds;
  }, [selectedNodeIds]);

  // 下面几张按节点索引的图都从 ref 读文档、用图签名做失效判据，而不是直接依赖 document：
  // 拖动每一帧、提示词每一次按键都会换掉 document 的引用，但只要「节点 id / 标题 / 当前版本 /
  // draft.mode + input 连线」这四样没变，这几张图就没有必要重算。它们都进了节点 context，
  // 重算一次就等于所有节点卡重渲染一次。exhaustive-deps 看不出这层关系，只会报「依赖里有没用到的
  // mentionGraphSignature」—— 那正是它存在的理由。
  // nodes / connections 两个数组的引用没变就不用重算：hover、选择、缩放、面板开合都会
  // 让组件重渲染，但它们碰不到文档。
  const mentionGraphSignature = useMemo(
    () => canvasMentionGraphSignature(document),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只看这两个数组的引用，不看整份 document
    [document?.nodes, document?.connections],
  );
  const mentionDocumentRef = useRef(document);
  mentionDocumentRef.current = document;

  /** 节点卡按 version_id 取内容，走这个常量引用的解析器，而不是把整张版本表塞进 context。
   *
   *  版本表每一次按键都会换引用（updateText 每次都重建 content_versions），而 context 变了就会
   *  绕过 memo 重渲染**所有**节点卡——缩放到能看见 200 个节点时每一帧都在做这件事。
   *  解析器读的是 latestDocument.current，它在同一次 render 的上面几行刚被赋成本次的 document，
   *  和直接读 props 是同一份数据。
   *
   *  代价是一条不变式：节点卡显示的内容变了，必须同时伴随「节点对象换引用」或「jobs 变化」，
   *  否则卡片不会重渲染。目前都满足——updateText 每次都重建被改的那个节点对象，服务端回填走
   *  current_version_id / jobs，候选版本随 job 完成进来。加新的内容写入路径时要守住这条。 */
  const resolveVersion = useCallback((versionId: string | null | undefined) => (
    versionId ? latestDocument.current?.content_versions[versionId] : undefined
  ), []);
  const findNode = useCallback((id: string) => latestDocument.current?.nodes.find(node => node.id === id), []);
  const listNodes = useCallback(() => latestDocument.current?.nodes ?? [], []);

  const selectedId = selectedNodeIds.size === 1
    ? selectedNodeIds.values().next().value ?? null
    : null;

  function clearSaveRetry() {
    saveFailure.current = null;
    if (saveRetryTimer.current !== null) window.clearTimeout(saveRetryTimer.current);
    if (saveRetryPhaseTimer.current !== null) window.clearTimeout(saveRetryPhaseTimer.current);
    saveRetryTimer.current = null;
    saveRetryPhaseTimer.current = null;
    setSaveRetryPhase('none');
  }

  function scheduleSaveRetry() {
    const failure = saveFailure.current ?? { since: Date.now(), attempts: 0 };
    failure.attempts += 1;
    saveFailure.current = failure;
    const elapsed = Date.now() - failure.since;
    const stuck = failure.attempts >= SAVE_RETRY_STUCK_ATTEMPTS || elapsed > SAVE_RETRY_STUCK_MS;
    setSaveRetryPhase(stuck ? 'stuck' : elapsed >= SAVE_RETRY_QUIET_MS ? 'retrying' : 'quiet');
    if (!stuck && elapsed < SAVE_RETRY_QUIET_MS && saveRetryPhaseTimer.current === null) {
      saveRetryPhaseTimer.current = window.setTimeout(() => {
        saveRetryPhaseTimer.current = null;
        if (saveFailure.current) setSaveRetryPhase(phase => phase === 'quiet' ? 'retrying' : phase);
      }, SAVE_RETRY_QUIET_MS - elapsed);
    }
    if (saveRetryTimer.current !== null) window.clearTimeout(saveRetryTimer.current);
    const delay = SAVE_RETRY_DELAYS_MS[failure.attempts - 1] ?? SAVE_RETRY_PROBE_MS;
    saveRetryTimer.current = window.setTimeout(() => {
      saveRetryTimer.current = null;
      void flushSaveRef.current().catch(() => undefined);
    }, delay);
  }

  const flushSave = useCallback(function drainSaveQueue(force = false): Promise<void> {
    if (runSubmissionInFlight.current || libraryInsertInFlight.current || documentCommandInFlight.current) return Promise.resolve();
    if (saveInFlight.current) {
      return saveInFlight.current.then(() => (
        saveQueued.current
        && (force || (
          !imeComposing.current
          && activeTextEditingNodeIds.current.size === 0
        ))
          ? drainSaveQueue(force)
          : undefined
      ));
    }
    const run = async () => {
      let failedSnapshot: CanvasDocument | null = null;
      try {
        while (
          saveQueued.current
          && (force || (
            !imeComposing.current
            && activeTextEditingNodeIds.current.size === 0
          ))
        ) {
          const snapshot = saveQueued.current;
          saveQueued.current = null;
          failedSnapshot = snapshot;
          setSaveState('saving');
          // 当前批次的文本版本 ID 从此冻结；保存途中继续输入必须创建下一版。
          pendingTextVersions.current.clear();
          const saved = await localCanvasTransport.save(projectId, {
            ...snapshot,
            revision: serverRevision.current,
          });
          failedSnapshot = null;
          const authoritativeRevision = Math.max(serverRevision.current, saved.revision);
          serverRevision.current = authoritativeRevision;
          const queued = saveQueued.current as CanvasDocument | null;
          if (queued) {
            // 排队中的快照是在服务端回写之前拍下的，同样带着占位 sha256。
            // 不把服务端真值合进来，下一次保存就会提交一份服务端已判非法的数据。
            saveQueued.current = {
              ...queued,
              revision: authoritativeRevision,
              content_versions: acceptServerContentVersions(
                queued.content_versions,
                saved.content_versions,
              ),
            };
          }
          const acceptSaved = (current: CanvasDocument | null) => {
            if (!current) return current;
            if (current === snapshot && saved.revision === authoritativeRevision) return saved;
            return {
              ...current,
              revision: Math.max(current.revision, authoritativeRevision),
              content_versions: acceptServerContentVersions(
                current.content_versions,
                saved.content_versions,
              ),
            };
          };
          // 排队的上传会在下一次 React render 前接着保存，必须先同步权威版本。
          latestDocument.current = acceptSaved(latestDocument.current);
          setDocument(acceptSaved);
          // 三方合并的基准 = 服务端已接受的内容，用本页手里的那份对象表示（同一份对象才比得出「没改过」）。
          serverBaseDocument.current = latestDocument.current === saved ? saved : snapshot;
        }
        setSaveState('saved');
        setSaveErrorDetail(null);
        clearSaveRetry();
      } catch (saveError) {
        // 卸载时仍冲刷最后一笔，但失败回调可能晚于清理，不能再启动旧画布的重试或冲突重载。
        if (!editorMounted.current) throw saveError;
        if (!saveQueued.current && failedSnapshot) saveQueued.current = failedSnapshot;
        setSaveState('error');
        // 自动保存的失败在这里是唯一能被观察到的地方：调用方基本都 .catch(() => undefined)，
        // 而状态药丸在窄屏被 max-w-24 truncate 掉。保存一失败，本地文档就和服务端分叉了，
        // 之后每一次编辑都不落盘，所以必须把服务端的 detail 原样送到报错条上。
        if (saveError instanceof ApiError && saveError.status === 409) {
          // 409 只有一种来源：别处（Agent 经 MCP、另一标签页）已经写过新版本。重载时按节点三方合并，
          // 本页没落盘的改动保留下来再存一次，不弹横幅。
          void reloadDocumentRef.current().catch(reloadError => setError(errorText(reloadError)));
          throw saveError;
        }
        // 不再弹报错条：按退避自动重试，状态只在顶栏胶囊里（规格 2.4）。原因放在胶囊的 Hint 里。
        setSaveErrorDetail(errorText(saveError));
        scheduleSaveRetry();
        throw saveError;
      }
    };
    const promise = run().finally(() => {
      if (saveInFlight.current === promise) saveInFlight.current = null;
    });
    saveInFlight.current = promise;
    return promise;
  }, [projectId]);
  const flushSaveRef = useRef(flushSave);
  flushSaveRef.current = flushSave;
  useEffect(() => {
    editorMounted.current = true;
    return () => {
      editorMounted.current = false;
      if (saveRetryTimer.current !== null) window.clearTimeout(saveRetryTimer.current);
      if (saveRetryPhaseTimer.current !== null) window.clearTimeout(saveRetryPhaseTimer.current);
    };
  }, [projectId]);

  // Agent 经 MCP 改画布（#92）：服务端 canvas.json 一落盘就广播 canvas-document-changed，
  // 本页按 revision 判断是不是别人的改动——自己的保存也会触发同一事件。
  /** 外部改动（Agent 一轮落盘）进撤销栈：一轮 = 一步，toast 只留一条并累计删除数（规格 2.1）。
   *  轮次按 Agent 会话的运行区间划分：会话在跑期间的连续落盘并成一轮，会话停下后的下一次落盘开新的一轮；
   *  没有本页 Agent 在跑时（外部 MCP、另一标签页）每次落盘各算一轮。不再按 8 秒窗口猜。 */
  const recordExternalRound = useCallback((before: CanvasDocument, after: CanvasDocument) => {
    const signature = (doc: CanvasDocument) => JSON.stringify([doc.nodes, doc.connections]);
    if (signature(before) === signature(after)) return;
    const afterIds = new Set(after.nodes.map(node => node.id));
    const deleted = before.nodes.filter(node => !afterIds.has(node.id)).length;
    const past = history.current.past;
    const round = externalRound.current;
    const continues = Boolean(round?.open && agentActiveRef.current);
    if (round) notify.dismiss(round.toastId);
    // 撤销栈：同一轮、期间用户没动过撤销栈时不另占一步。
    const stackUntouched = continues && round
      && past.length === round.pastLength
      && past[past.length - 1] === round.stackSnapshot;
    let stackSnapshot = round?.stackSnapshot ?? before;
    if (!stackUntouched) {
      stackSnapshot = before;
      past.push(before);
      history.current.past = past.slice(-50);
    }
    history.current.future = [];
    const steps = continues && round ? [...round.steps, { before, after }] : [{ before, after }];
    const total = deleted + (continues && round ? round.deleted : 0);
    const message = total
      ? `已应用本轮修改（含删除 ${total} 个节点）`
      : '已应用本轮修改';
    const next: ExternalRound = {
      steps,
      stackSnapshot,
      pastLength: history.current.past.length,
      deleted: total,
      toastId: '',
      open: continues || agentActiveRef.current,
    };
    next.toastId = notify.undo(message, () => undoExternalRoundRef.current(next), { actionLabel: '撤销本轮' });
    externalRound.current = next;
  }, []);

  const reloadDocumentFromServer = useCallback(async (fromNotification = false) => {
    const remote = await localCanvasTransport.read(projectId);
    // Read after the document: its Jobs have committed, even when document SSE arrives first.
    const groupJobs = !sharedOwner && remote.nodes.some(node => node.type === 'group')
      ? await listCanvasJobs(projectId) : [];
    const before = latestDocument.current;
    const base = serverBaseDocument.current;
    // SSE and the room socket can announce the same edit. A later GET can also finish first.
    if (!editorMounted.current || projectIdRef.current !== projectId || remote.revision < serverRevision.current
      || (fromNotification && base?.revision === remote.revision)) return;
    const hydrated = materializeEmptyTextContent(remote);
    const remoteDocument = normalizeCanvasGroups(hydrated.document);
    serverBaseDocument.current = remoteDocument;
    // 本页还有没落盘的编辑（正在编辑的文本、排队的保存）时按三方合并收下服务端文档：
    // 本页改过的节点保留本地值，其余用服务端的；合并结果再存一次。
    const sameProject = before?.project_id === remoteDocument.project_id;
    const pinned = new Set([...activeTextEditingNodeIds.current, ...pendingTextVersions.current.keys()]);
    const merge = sameProject && before && base
      ? mergeRemoteCanvasDocument(base, before, remoteDocument, pinned)
      : { document: remoteDocument, keptLocal: false };
    const reloaded = merge.document;
    const keptPending = new Map([...pendingTextVersions.current].filter(([nodeId, versionId]) => (
      reloaded.nodes.some(node => node.id === nodeId && isContentNode(node) && node.data.current_version_id === versionId)
    )));
    pendingTextVersions.current = new Map([...keptPending, ...hydrated.versionIds]);
    saveQueued.current = null;
    autosaveObservedDirtyVersion.current = 0;
    serverRevision.current = remote.revision;
    // 别处（多半是 Agent）改了画布：新放上来的节点淡入放大，被改动的节点闪一圈描边（Q15），看得出改了哪里。
    if (sameProject && before) {
      const historyBase = withGroupRunResults(before, reloaded, groupJobs);
      const { added, changed } = canvasRemoteNodeChanges(historyBase, reloaded);
      markCanvasNodesEntering(added, 0.96);
      flashCanvasNodes(changed);
      if (sharedOwner && base) {
        history.current = rebaseOwnerHistory(history.current,blockedHistory.current,before,base,remoteDocument);
      } else recordExternalRound(historyBase, reloaded);
    }
    latestDocument.current = reloaded;
    setDocument(reloaded);
    // 与首屏加载相同：补出来的空文本版本、合并留下的本地改动都还没落盘，要再保存一次。
    dirtyVersion.current = hydrated.versionIds.size || merge.keptLocal ? dirtyVersion.current + 1 : 0;
    setDirtySignal(dirtyVersion.current);
    setSaveState('saved');
    setSaveErrorDetail(null);
    setError(null);
    setErrorAction(null);
  }, [projectId, recordExternalRound, sharedOwner]);
  reloadDocumentRef.current = reloadDocumentFromServer;
  remoteDocumentChanged.current = (revision: number | null) => {
    if (revision === null || revision <= serverRevision.current) return;
    const inFlight = saveInFlight.current;
    if (inFlight) {
      // 自己的保存在途：等它落地把 serverRevision 推上去，再看这条事件是不是别人的。
      void inFlight.catch(() => undefined).then(() => remoteDocumentChanged.current(revision));
      return;
    }
    // 上传 / 媒体操作这类命令由服务端先写盘、本页拿到响应后再加节点。watcher 广播可能比
    // HTTP 响应先到（Windows 实测），此时 serverRevision 还没推上去，若当成别人的改动去重载，
    // 服务端文档（只有版本、没有节点）就会盖掉刚加的节点——表现为「提示已添加，画布上没有」。
    const command = uploadQueue.current;
    if (command) {
      void command.then(() => remoteDocumentChanged.current(revision));
      return;
    }
    if (documentCommandInFlight.current) {
      window.setTimeout(() => remoteDocumentChanged.current(revision), 200);
      return;
    }
    if (activeTextEditingNodeIds.current.size > 0) {
      // 正在编辑文本节点：重载会卸载 textarea、掐断输入法组合，等编辑结束再收服务端版本。
      window.setTimeout(() => remoteDocumentChanged.current(revision), 200);
      return;
    }
    // 其余情况收下服务端文档：本页没落盘的改动按节点三方合并保留，不弹横幅让人做选择。
    void reloadDocumentFromServer(true).catch(reloadError => setError(errorText(reloadError)));
  };

  // 中文 / 日文输入法在候选未确认前一直处于 composition 状态，而自动保存的去抖只有 350ms，
  // 很容易在「拼音打完、还没选字」这个空档里触发。组合期间落盘既会把半成品文本写进版本，
  // 也让整棵画布在组合中途重渲染。所以组合期间只排队不起定时器，compositionend 之后立刻补上。
  // 监听挂在 document 上：文本节点的 textarea、提示词输入框都在这一层之下，一处覆盖全部。
  const [compositionSignal, setCompositionSignal] = useState(0);
  useEffect(() => {
    const start = () => { imeComposing.current = true; };
    const end = () => {
      imeComposing.current = false;
      setCompositionSignal(current => current + 1);
    };
    // 走 window.document —— 这个组件里 `document` 是画布文档那个 state，把全局的遮住了。
    window.document.addEventListener('compositionstart', start);
    window.document.addEventListener('compositionend', end);
    return () => {
      window.document.removeEventListener('compositionstart', start);
      window.document.removeEventListener('compositionend', end);
    };
  }, []);

  useEffect(() => {
    const snapshot = latestDocument.current;
    if (!snapshot || dirtySignal === 0) {
      autosaveObservedDirtyVersion.current = 0;
      return;
    }
    if (dirtySignal > autosaveObservedDirtyVersion.current) {
      autosaveObservedDirtyVersion.current = dirtySignal;
      saveQueued.current = snapshot;
    }
    if (!saveQueued.current) return;
    // 创建手势会自动把光标交给提示词；先提交这一笔结构编辑，再进入延迟保存的输入会话。
    if (saveBeforePanelFocus.current) {
      saveBeforePanelFocus.current = false;
      void flushSave().catch(() => undefined);
      return;
    }
    // 队列已经排上了，卸载冲刷与 beforeunload 守卫照样看得到；输入法组合和文本编辑会话
    // 期间都只更新内存，不启动保存。退出文本编辑后 textEditingSignal 变化，再统一保存一次。
    if (imeComposing.current || activeTextEditingNodeIds.current.size > 0) return;
    const timer = window.setTimeout(() => void flushSave().catch(() => undefined), 350);
    return () => window.clearTimeout(timer);
  }, [compositionSignal, dirtySignal, flushSave, textEditingSignal]);

  // 上面那条 effect 每次 dirtySignal 变化都 clearTimeout，排队的快照没人接手。
  // 卸载（画布内返回、路由跳走、切项目）走的是 SPA 路径，fetch 不会被掐，所以这里补一次冲刷；
  // 清理函数用的是注册它那次 render 的闭包，切项目时冲的是旧 projectId，不会串项目。
  useEffect(() => () => {
    if (!saveQueued.current) return;
    void flushSave(true).catch(() => undefined);
  }, [flushSave]);

  // 关标签 / 刷新 / 硬跳转时 fetch 会被浏览器一起掐掉，冲不出去，只能拦一下让画师自己决定。
  useEffect(() => {
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      if (!saveQueued.current && !saveInFlight.current && !uploadQueue.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, []);

  /** 插件调服务端之前把页面上还没保存的编辑落盘：刚建的插件节点要先存到服务端，服务端才认它。 */
  const savePendingEdits = useCallback(async () => {
    if (latestDocument.current && dirtyVersion.current > 0) {
      saveQueued.current = latestDocument.current;
      await flushSave(true);
    } else if (saveInFlight.current) {
      await saveInFlight.current;
    }
  }, [flushSave]);

  const persistNow = useCallback(async (): Promise<boolean> => {
    if (projectRenameInFlight.current) {
      setError('项目名称正在保存，请稍后再离开。');
      return false;
    }
    if (runSubmissionInFlight.current || documentCommandInFlight.current) {
      setError('画布命令正在提交，请等待完成后再离开或执行其他操作。');
      return false;
    }
    if (libraryInsertCommand.current) await libraryInsertCommand.current;
    while (pendingViewportCommand.current) {
      const pending = pendingViewportCommand.current;
      try {
        await pending;
      } catch {
        setError('画布视口尚未保存，请稍后重试。');
        return false;
      }
      if (pendingViewportCommand.current === pending) pendingViewportCommand.current = null;
    }
    if (latestDocument.current && dirtyVersion.current > 0) {
      saveQueued.current = latestDocument.current;
      try {
        await flushSave(true);
      } catch {
        setError(CANVAS_SAVE_FAILED_LEAVE_MESSAGE);
        return false;
      }
    }
    return true;
  }, [flushSave]);

  /** 离开画布前先存；存不进去时报错条给「仍然离开」（明说会丢掉未保存的改动），不把人困在画布里。 */
  const leaveCanvas = useCallback((go: () => void) => {
    // 要离开了：队列里还没发出的计费提交不再发（等保存的这段时间里也不能轮到它们）。
    submissionEpoch.current += 1;
    void persistNow().then(saved => {
      if (saved) { go(); return; }
      setErrorAction({
        message: CANVAS_SAVE_FAILED_LEAVE_MESSAGE,
        label: '仍然离开',
        run: () => {
          saveQueued.current = null;
          clearSaveRetry();
          setError(null);
          go();
        },
      });
    });
  }, [persistNow]);

  const commit = useCallback((updater: (current: CanvasDocument) => CanvasDocument, record = false) => {
    // 新建的空项目一旦有了编辑就不再自动清理（D12）。
    settleFreshCanvasProject(projectIdRef.current);
    setDocument(current => {
      if (!current) return current;
      if (record) {
        history.current.past.push(current);
        history.current.past = history.current.past.slice(-50);
        history.current.future = [];
      } else if (history.current.future.length) {
        history.current.future = [];
      }
      return normalizeCommittedDocument(updater(current), current);
    });
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
  }, []);

  /** 「撤销本轮」：只反转这一轮 Agent 落盘的改动，从后往前逐步三方合并（基准 = 那一步之后，
   *  本页 = 现在，目标 = 那一步之前）。之后用户自己的编辑原样保留；这一轮改过、之后又被改过的节点 /
   *  连线保留现在的样子，并提示有几处没撤回。整次撤销本身进撤销栈，⌘Z 可以再撤回来。 */
  const undoExternalRound = useCallback((round: ExternalRound) => {
    if (externalRound.current === round) externalRound.current = null;
    const current = latestDocument.current;
    if (!current) return;
    const pinned = new Set([...activeTextEditingNodeIds.current, ...pendingTextVersions.current.keys()]);
    let reverted = current;
    for (const step of [...round.steps].reverse()) {
      reverted = mergeRemoteCanvasDocument(step.after, reverted, step.before, pinned).document;
    }
    const conflicts = canvasRoundUndoConflicts(round.steps, reverted);
    commit(() => ({ ...reverted, viewport: current.viewport }), true);
    if (conflicts > 0) notify.info(`有 ${conflicts} 处在本轮之后又改过，保留了现在的样子`);
  }, [commit]);
  undoExternalRoundRef.current = undoExternalRound;

  const previewNodeResize = useCallback((nodeId: string, layout: Omit<LiveNodeLayout, 'nodeId'>) => {
    activeResizeNodeId.current = nodeId;
    pendingLiveNodeLayout.current = { nodeId, ...layout };
    if (resizePreviewFrame.current !== null) return;
    resizePreviewFrame.current = window.requestAnimationFrame(() => {
      resizePreviewFrame.current = null;
      setLiveNodeLayout(pendingLiveNodeLayout.current);
    });
  }, []);

  const completeNodeResize = useCallback((nodeId: string, layout: Omit<LiveNodeLayout, 'nodeId'>) => {
    activeResizeNodeId.current = null;
    pendingLiveNodeLayout.current = null;
    if (resizePreviewFrame.current !== null) window.cancelAnimationFrame(resizePreviewFrame.current);
    resizePreviewFrame.current = null;
    setLiveNodeLayout(null);
    commit(current => ({
      ...current,
      nodes: current.nodes.map(node => node.id === nodeId ? {
        ...node,
        position: layout.position,
        // NodeResizer 已经在 maxWidth / maxHeight 上刹住了，这里再夹一次是因为落盘超界的代价
        // 不是这一次保存失败，而是之后所有编辑都不落盘：见 clampCanvasNodeSize。
        size: clampCanvasNodeSize(layout.size),
      } : node),
    }));
  }, [commit]);

  // 结果组：成员 → 封面。封面没展开、或正在重新生成时，成员收起不显示，连到成员的线画到封面上。
  // 按内容签名缓存：打字、拖动都会换 document.nodes，但结果组关系没变时要给出同一个对象，
  // 否则节点上下文和全部连线每次都跟着重算（见「引用变化打穿 memo」）。
  // 「重新生成中」按 job 状态判断：封面上残留的旧 active_run_id 不能让成员一直收起。
  const resultStackSignature = JSON.stringify([...resultStackOwners(document?.nodes ?? [])].map(([memberId, coverId]) => {
    const cover = document?.nodes.find(node => node.id === coverId);
    const runId = cover?.type === 'image' ? cover.data.active_run_id : null;
    const running = Boolean(runId) && jobs.some(job => (
      job.canvas_run?.run_id === runId && (job.status === 'pending' || job.status === 'pending_confirm')
    ));
    return [memberId, coverId, running];
  }));
  const resultStackEntries = useMemo(
    () => JSON.parse(resultStackSignature) as Array<[string, string, boolean]>,
    [resultStackSignature],
  );
  const resultStackOwnerById = useMemo<ReadonlyMap<string, string>>(
    () => new Map(resultStackEntries.map(([memberId, coverId]) => [memberId, coverId])),
    [resultStackEntries],
  );
  const collapsedStackMemberIds = useMemo<ReadonlySet<string>>(() => new Set(resultStackEntries.flatMap(
    ([memberId, coverId, running]) => (!expandedResultStackIds.has(coverId) || running ? [memberId] : []),
  )), [expandedResultStackIds, resultStackEntries]);
  const collapsedStackMemberIdsRef = useRef(collapsedStackMemberIds);
  collapsedStackMemberIdsRef.current = collapsedStackMemberIds;
  useEffect(() => {
    // 收起后成员不可见，不能还留在选中里（否则按删除键删掉的是看不见的节点）。
    setSelectedNodeIds(current => {
      if (![...current].some(id => collapsedStackMemberIds.has(id))) return current;
      return new Set([...current].filter(id => !collapsedStackMemberIds.has(id)));
    });
  }, [collapsedStackMemberIds]);

  const pendingHandleNode = createMenu?.compareSlot ? undefined : createMenu?.sourceId;
  const pendingHandleClass = createMenu?.sourceHandle === 'target' ? 'canvas-pending-left' : 'canvas-pending-right';
  const flowNodes = useMemo<FlowNode[]>(() => {
    // 节点卡上报新图已盖上来时重算：屏上版本记在 ref 里，这个计数把它变成依赖。
    void revealRevision;
    const activeIds = new Set<string>();
    const maximumPersistedZIndex = Math.max(0, ...(document?.nodes ?? []).map(node => node.z_index));
    const next = (document?.nodes ?? []).map(node => {
      activeIds.add(node.id);
      const selected = selectedNodeIds.has(node.id);
      const liveLayout = liveNodeLayout?.nodeId === node.id ? liveNodeLayout : undefined;
      const stackMember = resultStackOwnerById.has(node.id);
      const hidden = collapsedStackMemberIds.has(node.id);
      const currentImageVersionId = node.type === 'image' ? node.data.current_version_id : null;
      if (node.type === 'image' && !revealedImageVersions.current.has(node.id)) {
        revealedImageVersions.current.set(node.id, currentImageVersionId);
      }
      const shownVersionId = node.type === 'image' ? revealedImageVersions.current.get(node.id) ?? null : null;
      const className = node.id === pendingHandleNode ? pendingHandleClass : undefined;
      const cached = flowNodeCache.current.get(node.id);
      if (
        cached?.node === node
        && cached.flowNode.className === className
        && cached.selected === selected
        && cached.liveLayout === liveLayout
        && cached.hidden === hidden
        && cached.stackMember === stackMember
        && cached.shownVersionId === shownVersionId
      ) return cached.flowNode;
      const sizedNode = node.type === 'image' && shownVersionId !== currentImageVersionId
        ? { ...node, data: { ...node.data, current_version_id: shownVersionId } }
        : node;
      const renderedSize = liveLayout?.size
        ?? canvasNodeRenderedSize(sizedNode, document?.content_versions ?? {});
      const flowNode: FlowNode = {
        id: node.id,
        type: 'canvasNode',
        className,
        position: liveLayout?.position ?? node.position,
        style: {
          width: renderedSize.width,
          height: renderedSize.height,
          zIndex: node.type === 'group' ? 0 : canvasNodeRenderZIndex(node.z_index + 1, selected, maximumPersistedZIndex + 1),
          // React Flow 的外层仍会捕获点击；仅让分组内部穿透不足以露出连线。
          ...(node.type === 'group' ? { pointerEvents: 'none' as const } : {}),
        },
        selected,
        hidden,
        // 成员的位置由封面决定（拖封面整组移动），自己不能单独拖走。
        draggable: !stackMember,
        data: { domain: node },
      };
      flowNodeCache.current.set(node.id, { node, selected, liveLayout, hidden, stackMember, shownVersionId, flowNode });
      return flowNode;
    });
    for (const id of flowNodeCache.current.keys()) {
      if (!activeIds.has(id)) flowNodeCache.current.delete(id);
    }
    for (const id of revealedImageVersions.current.keys()) {
      if (!activeIds.has(id)) revealedImageVersions.current.delete(id);
    }
    for (const mediaPlaceholder of mediaPlaceholders) {
      next.push({
        id: mediaPlaceholder.id,
        type: 'canvasPlaceholder',
        position: mediaPlaceholder.position,
        style: {
          width: mediaPlaceholder.size.width,
          height: mediaPlaceholder.size.height,
          zIndex: maximumPersistedZIndex + 2,
        },
        width: mediaPlaceholder.size.width,
        height: mediaPlaceholder.size.height,
        handles: [{ type: 'target', position: Position.Left, x: 0, y: mediaPlaceholder.size.height / 2 }],
        data: { label: mediaPlaceholder.label, leaving: mediaPlaceholder.leaving, preview: mediaPlaceholder.preview },
        selectable: false,
        draggable: !mediaPlaceholder.preview && !mediaPlaceholder.leaving,
        connectable: false,
        deletable: false,
        focusable: false,
      });
    }
    return next;
  }, [pendingHandleNode, pendingHandleClass, collapsedStackMemberIds, document?.content_versions, document?.nodes, liveNodeLayout, mediaPlaceholders, resultStackOwnerById, revealRevision, selectedNodeIds]);

  const activeNodeId = hoveredNodeId ?? (
    selectedNodeIds.size === 1 ? selectedNodeIds.values().next().value ?? null : null
  );
  /** 连线对象和节点卡一样按引用做缓存。
   *
   *  xyflow 的 EdgeWrapper 是 `useStore(s => s.edgeLookup.get(id))`，默认 Object.is 比较：
   *  换一个新对象就重渲染这条连线。而这个 memo 的依赖里有 `document.nodes`（连线的无障碍
   *  名称要用节点标题）和 `activeNodeId`（hover），所以以前每打一个字、每挪一次鼠标，
   *  全部连线都会换成新对象重画一遍。
   *
   *  数组本身也复用：一条都没变时返回上一次那个数组，`setEdges` 连跑都不用跑。 */
  const layerConnectionSignature = JSON.stringify(canvasLayerMaterialConnections(document?.nodes ?? []));
  const layerConnections = useMemo<CanvasLayerMaterialConnection[]>(() => JSON.parse(layerConnectionSignature), [layerConnectionSignature]);
  const flowEdges = useMemo(() => {
    const titles = new Map((document?.nodes ?? []).map(node => [node.id, node.title]));
    const liveIds = new Set<string>();
    // 收起的结果组成员不显示：连到它的线画到封面上，只改显示，连线数据仍连在具体那张。
    const shown = (id: string) => (
      collapsedStackMemberIds.has(id) ? resultStackOwnerById.get(id) ?? id : id
    );
    const next = [...document?.connections ?? [], ...layerConnections].flatMap(connection => {
      const source = shown(connection.source_node_id);
      const target = shown(connection.target_node_id);
      // 组内两张之间的线收起后首尾落在同一个封面上，不画。
      if (source === target) return [];
      liveIds.add(connection.id);
      const active = activeNodeId === connection.source_node_id || activeNodeId === connection.target_node_id;
      const selected = selectedConnectionIds.has(connection.id);
      const sourceTitle = titles.get(connection.source_node_id) ?? connection.source_node_id;
      const targetTitle = titles.get(connection.target_node_id) ?? connection.target_node_id;
      const layerName = 'layerName' in connection && typeof connection.layerName === 'string' ? connection.layerName : null;
      const readOnly = layerName !== null;
      const cached = flowEdgeCache.current.get(connection.id);
      if (
        cached?.connection === connection
        && cached.active === active
        && cached.selected === selected
        && cached.sourceTitle === sourceTitle
        && cached.targetTitle === targetTitle
        && cached.source === source
        && cached.target === target
        && cached.flowEdge.deletable === !readOnly
      ) return [cached.flowEdge];
      const flowEdge: Edge = {
        id: connection.id,
        source,
        target,
        targetHandle: connection.role === 'input' && isCanvasCompareSlot(connection.slot) ? connection.slot : undefined,
        type: 'canvasConnection',
        data: { annotated: connection.role === 'input' && connection.annotated === true },
        className: cn(
          'canvas-input-edge',
          active && 'canvas-active-edge',
        ),
        ariaLabel: connection.role === 'material'
          ? `素材来源：${sourceTitle}${layerName ? ` · ${layerName}` : ''} → ${targetTitle}`
          : `输入连接：${sourceTitle} → ${targetTitle}`,
        interactionWidth: 16,
        selected,
        selectable: !readOnly,
        focusable: true,
        deletable: !readOnly,
      };
      flowEdgeCache.current.set(
        connection.id,
        { connection, active, selected, sourceTitle, targetTitle, source, target, flowEdge },
      );
      return [flowEdge];
    });
    for (const piece of mediaPlaceholders) {
      if (!piece.preview || piece.leaving) continue;
      next.push({ id: `edge-${piece.id}`, source: piece.sourceNodeId, target: piece.id, type: 'canvasConnection',
        className: 'canvas-input-edge', selectable: false, focusable: false, deletable: false });
    }
    for (const id of flowEdgeCache.current.keys()) {
      if (!liveIds.has(id)) flowEdgeCache.current.delete(id);
    }
    // 逐项按引用比，而不是「有没有走过 else 分支」：顺序变了也要当成变了。
    const previous = flowEdgesRef.current;
    if (next.length === previous.length && next.every((edge, index) => edge === previous[index])) {
      return previous;
    }
    flowEdgesRef.current = next;
    return next;
  }, [activeNodeId, collapsedStackMemberIds, document?.connections, document?.nodes, layerConnections, mediaPlaceholders, resultStackOwnerById, selectedConnectionIds]);

  const isValidConnection = useCallback<IsValidConnection>((connection) => (
    canCreateCanvasInputConnection(latestDocument.current, connection)
  ), []);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    // 框选期间的选中由 sweepSelection 接管，xyflow 发来的 select 一律忽略。
    const swept = selectionRectActive.current;
    const selectionChanges = changes.filter(change => (
      (change.type === 'select' && !swept) || change.type === 'remove'
    ));
    if (selectionChanges.length) {
      setSelectedNodeIds(current => {
        const next = new Set(current);
        for (const change of selectionChanges) {
          if (change.type === 'select') change.selected ? next.add(change.id) : next.delete(change.id);
          if (change.type === 'remove') next.delete(change.id);
        }
        if (next.size === current.size && [...next].every(id => current.has(id))) return current;
        return next;
      });
    }
    const placeholders = mediaPlaceholdersRef.current;
    const [placeholder] = placeholders;
    if (placeholder && !placeholder.preview && !placeholder.leaving) {
      const moved = changes.find(change => change.type === 'position' && change.id === placeholder.id && change.position);
      if (moved?.type === 'position' && moved.position) {
        updateMediaPlaceholders([{ ...placeholder, position: moved.position }]);
      }
    }
    const graphChanges = changes.filter(change => (
      (change.type === 'remove' && !placeholders.some(piece => piece.id === change.id))
      || (
        change.type === 'position'
        && !placeholders.some(piece => piece.id === change.id)
        && activeResizeNodeId.current !== change.id
      )
    ));
    if (!graphChanges.length) return;
    commit(current => {
      // 先把这一批 change 收成两张查找表，再对节点扫一遍。
      // 原来是每条 change 各做一次 nodes.map / nodes.filter：框选拖动时 change 数和节点数
      // 同阶，于是 O(n²)，而且拖动期间每一帧都要跑一次。
      const movedTo = new Map<string, XYPosition>();
      const removedNodeIds = new Set<string>();
      for (const change of graphChanges) {
        if (change.type === 'position' && change.position) movedTo.set(change.id, change.position);
        if (change.type === 'remove') removedNodeIds.add(change.id);
      }
      for (const group of current.nodes) {
        if (group.type !== 'group') continue;
        const destination = movedTo.get(group.id);
        if (!destination) continue;
        const dx = destination.x - group.position.x;
        const dy = destination.y - group.position.y;
        for (const id of group.data.member_node_ids) {
          const member = current.nodes.find(node => node.id === id);
          if (member && !movedTo.has(id)) movedTo.set(id, { x: member.position.x + dx, y: member.position.y + dy });
        }
      }
      const nodes: CanvasNode[] = [];
      for (const node of current.nodes) {
        if (removedNodeIds.has(node.id)) continue;
        const position = movedTo.get(node.id);
        nodes.push(position ? { ...node, position } : node);
      }
      return removeCanvasConnections(
        { ...current, nodes },
        edge => removedNodeIds.has(edge.source_node_id) || removedNodeIds.has(edge.target_node_id),
      );
    }, graphChanges.some(change => change.type === 'remove'));
    const removedIds = new Set(changes.flatMap(change => change.type === 'remove' ? [change.id] : []));
    if (activeResizeNodeId.current && removedIds.has(activeResizeNodeId.current)) {
      activeResizeNodeId.current = null;
      pendingLiveNodeLayout.current = null;
      if (resizePreviewFrame.current !== null) window.cancelAnimationFrame(resizePreviewFrame.current);
      resizePreviewFrame.current = null;
      setLiveNodeLayout(null);
    }
  }, [commit, updateMediaPlaceholders]);

  const onConnect = useCallback((connection: Connection) => {
    const document = latestDocument.current;
    if (!document || !canCreateCanvasInputConnection(document, connection)) {
      setError(canvasInputConnectionRejection(document, connection) ?? '这两个节点不能建立输入连接。');
      return;
    }
    const frameSlots = isCanvasCompareSlot(connection.targetHandle)
      ? { slots: [undefined] }
      : canvasFrameSlotsForNewInputs(document, connection.target!, [connection.source!], latestProviders.current);
    if (frameSlots.error) {
      setError(frameSlots.error);
      return;
    }
    const frameSlot = frameSlots.slots[0];
    setError(null);
    const connectionId = makeId('connection');
    flashCanvasEdges([connectionId]);
    commit(current => {
      const next: CanvasDocument = {
        ...current,
        connections: [...current.connections, {
          id: connectionId,
          role: 'input',
          source_node_id: connection.source!,
          target_node_id: connection.target!,
          // 拖到对比节点的 Before / After 接口上时，接口 id 就是槽位。
          ...(isCanvasCompareSlot(connection.targetHandle) ? { slot: connection.targetHandle } : {}),
          ...(frameSlot ? { slot: frameSlot } : {}),
        }],
      };
      return syncCanvasPromptReferences(next, new Set([connection.target!]));
    }, true);
  }, [commit]);

  /** 从输出侧拖出连线时，哪些节点算来源。
   *
   *  框选一组素材后从其中一个拖线，用户的意图是「把这一组都接进去」而不是只接手里那一个。
   *  起点不在选区里则维持单源：那是在拖一个未选中的节点，别把无关的选区一起带走。 */
  const connectionSourceIds = useCallback((fromNodeId: string): string[] => {
    const current = latestDocument.current;
    const selection = latestSelectedNodeIds.current;
    if (!current || selection.size < 2 || !selection.has(fromNodeId)) return [fromNodeId];
    const ids = current.nodes
      .filter(node => selection.has(node.id) && canvasNodeProvidesOutput(node))
      .map(node => node.id);
    return ids.includes(fromNodeId) ? ids : [fromNodeId, ...ids];
  }, []);

  const connectSources = useCallback((sourceIds: string[], targetNodeId: string) => {
    const accepted = sourceIds.filter(sourceId => canCreateCanvasInputConnection(
      latestDocument.current,
      { source: sourceId, target: targetNodeId },
    ));
    if (accepted.length === 0) {
      setError('选中的节点都不能连进这个节点。');
      return;
    }
    const frameSlots = canvasFrameSlotsForNewInputs(
      latestDocument.current!, targetNodeId, accepted, latestProviders.current,
    );
    if (frameSlots.error) {
      setError(frameSlots.error);
      return;
    }
    setError(null);
    commit(current => syncCanvasPromptReferences({
      ...current,
      connections: [...current.connections, ...accepted.map((sourceId, index) => ({
        id: makeId('connection'),
        role: 'input' as const,
        source_node_id: sourceId,
        target_node_id: targetNodeId,
        ...(frameSlots.slots[index] ? { slot: frameSlots.slots[index] } : {}),
      }))],
    }, new Set([targetNodeId])), true);
  }, [commit]);

  const reorderMaterialConnections = useCallback((targetNodeId: string, orderedSourceIds: readonly string[]) => {
    const current = latestDocument.current;
    if (!current || reorderCanvasInputConnections(current, targetNodeId, orderedSourceIds) === current) return;
    commit(document => reorderCanvasInputConnections(document, targetNodeId, orderedSourceIds), true);
  }, [commit]);

  const setMaterialConnected = useCallback((
    sourceNodeId: string,
    targetNodeId: string,
    connected: boolean,
  ) => {
    if (connected) {
      onConnect({
        source: sourceNodeId,
        target: targetNodeId,
        sourceHandle: null,
        targetHandle: null,
      });
      return;
    }
    const removedIds = new Set(
      latestDocument.current?.connections
        .filter(connection => (
          connection.role === 'input'
          && connection.source_node_id === sourceNodeId
          && connection.target_node_id === targetNodeId
        ))
        .map(connection => connection.id) ?? [],
    );
    if (removedIds.size === 0) return;
    setError(null);
    setSelectedConnectionIds(current => {
      const next = new Set(current);
      removedIds.forEach(id => next.delete(id));
      return next;
    });
    commit(current => removeCanvasConnections(
      current,
      connection => removedIds.has(connection.id),
    ), true);
  }, [commit, onConnect]);

  const setAnnotationDelivery = useCallback((
    sourceNodeId: string,
    targetNodeId: string,
    delivery: CanvasAnnotationDelivery,
  ) => {
    commit(current => ({
      ...current,
      connections: current.connections.map(connection => (
        connection.role === 'input' && connection.annotated
        && connection.source_node_id === sourceNodeId && connection.target_node_id === targetNodeId
          ? { ...connection, annotation_delivery: delivery }
          : connection
      )),
    }), true);
  }, [commit]);

  const setVideoFrameConnections = useCallback((
    targetNodeId: string,
    frames: Readonly<Record<CanvasVideoFrameSlot, string | null>>,
  ) => {
    const current = latestDocument.current;
    const target = current?.nodes.find(node => node.id === targetNodeId);
    // 判据必须和渲染控件的那一侧一致：面板按 draft.mode 决定要不要给首尾帧控件，这里以前按
    // node.type 收窄，把配置节点排除掉了——配置节点的 mode 是 video 但 type 是 config，于是
    // 控件显示、点了没反应。服务端的 _resolve_inputs 只看 surface.id 上的 slot 连线，本来就
    // 支持配置节点，所以对齐到 draft 这一侧。
    if (!current || !target || generationDraftForNode(target)?.mode !== 'video') {
      setError('只有视频生成节点可以设置首尾帧。');
      return;
    }
    const selectedSources = Object.entries(frames).filter(
      (entry): entry is [CanvasVideoFrameSlot, string] => Boolean(entry[1]),
    );
    const invalidSource = selectedSources.find(([, sourceNodeId]) => {
      const source = current.nodes.find(node => node.id === sourceNodeId);
      if (!source || source.type !== 'image' || !source.data.current_version_id) return true;
      return current.content_versions[source.data.current_version_id]?.kind !== 'image';
    });
    if (invalidSource) {
      setError('首尾帧只能选择画布上已有内容的图片节点。');
      return;
    }
    setError(null);
    const removedIds = new Set(current.connections
      .filter(connection => (
        connection.role === 'input'
        && connection.target_node_id === targetNodeId
        && Boolean(connection.slot)
      ))
      .map(connection => connection.id));
    setSelectedConnectionIds(selected => {
      if (![...removedIds].some(id => selected.has(id))) return selected;
      const next = new Set(selected);
      removedIds.forEach(id => next.delete(id));
      return next;
    });
    commit(document => ({
      ...document,
      connections: [
        ...document.connections.filter(connection => !(
          connection.role === 'input'
          && connection.target_node_id === targetNodeId
          && Boolean(connection.slot)
        )),
        ...selectedSources.map(([slot, sourceNodeId]) => ({
          id: makeId('connection'),
          role: 'input' as const,
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
          slot,
        })),
      ],
    }), true);
  }, [commit]);

  /** 切换视频生成方式时把已有连线搬过去，而不是删掉让人重连：切到全能参考，首尾帧连线变普通参考；
   *  切到首尾帧，普通的图片参考按顺序填进空着的首帧、尾帧槽位（多出来的留着，由面板提示）。 */
  const convertVideoFrameConnections = useCallback((targetNodeId: string, toFrameSlots: boolean, maxFrames: number) => {
    const current = latestDocument.current;
    if (!current) return;
    const kindOf = (nodeId: string) => {
      const node = current.nodes.find(item => item.id === nodeId);
      const versionId = node && isContentNode(node) ? node.data.current_version_id : null;
      return versionId ? current.content_versions[versionId]?.kind : undefined;
    };
    const incoming = current.connections.filter((connection): connection is CanvasInputConnection => (
      connection.role === 'input' && connection.target_node_id === targetNodeId
    ));
    // 值为 null 表示删掉（同一张图已经是普通参考，留一条就够）。
    const updates = new Map<string, CanvasInputConnection | null>();
    if (toFrameSlots) {
      const taken = new Set(incoming.map(connection => connection.slot).filter(Boolean));
      const free = (['first_frame', 'last_frame'] as const).slice(0, maxFrames).filter(slot => !taken.has(slot));
      for (const connection of incoming) {
        if (connection.slot || kindOf(connection.source_node_id) !== 'image') continue;
        const slot = free.shift();
        if (!slot) break;
        updates.set(connection.id, { ...connection, slot });
      }
    } else {
      const plainSources = new Set(incoming.filter(connection => !connection.slot).map(connection => connection.source_node_id));
      for (const connection of incoming) {
        if (!isCanvasVideoFrameSlot(connection.slot)) continue;
        const { slot: _slot, ...plain } = connection;
        updates.set(connection.id, plainSources.has(connection.source_node_id) ? null : plain);
        plainSources.add(connection.source_node_id);
      }
    }
    if (!updates.size) return;
    commit(document => syncCanvasPromptReferences({
      ...document,
      connections: document.connections.flatMap(connection => {
        if (!updates.has(connection.id)) return [connection];
        const next = updates.get(connection.id);
        return next ? [next] : [];
      }),
    }, new Set([targetNodeId])), true);
  }, [commit]);

  const beginMaterialPick = useCallback((request: MaterialPickState) => {
    if (request.selectableNodeIds.size === 0) return;
    setMaterialPick({
      ...request,
      selectableNodeIds: new Set(request.selectableNodeIds),
    });
    setAddOpen(false);
    setCreateMenu(null);
    setLibraryMode(null);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([request.targetNodeId]));
  }, []);

  const gestureStart = useRef<XYPosition | null>(null);
  const dragStarted = useRef(false);
  // xyflow starts immediately so a tap still gets onConnectEnd. Hand the visual
  // over only once the same screen-pixel threshold used by tap creation is crossed.
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!gestureStart.current || dragStarted.current ||
        isCanvasHandleTap(gestureStart.current, { x: event.clientX, y: event.clientY })) return;
      dragStarted.current = true;
      setConnectionInProgress(true);
    };
    window.addEventListener('pointermove', move, true);
    return () => window.removeEventListener('pointermove', move, true);
  }, []);
  const onConnectEnd = useCallback<OnConnectEnd>((event, state) => {
    setConnectionInProgress(false);
    const start = gestureStart.current;
    const dragged = dragStarted.current;
    dragStarted.current = false;
    gestureStart.current = null;
    if (state.isValid || !state.fromNode || event.type === 'touchcancel') return;
    let pointer = pointerPosition(event);
    if (!pointer) return;
    const tap = !dragged && start && isCanvasHandleTap(start, pointer);
    if (!tap && state.toHandle) return;
    const startedFromTarget = state.fromHandle?.type === 'target';
    const compareSlot = state.fromHandle?.id;
    const dropNodeId = tap ? null : state.toNode?.id ?? connectionDropNodeId(pointer, startedFromTarget ? 'right' : 'left');
    const sourceIds = startedFromTarget ? [state.fromNode.id] : connectionSourceIds(state.fromNode.id);
    if (dropNodeId) {
      if (sourceIds.length > 1) {
        connectSources(sourceIds, dropNodeId);
        return;
      }
      const connection: Connection = {
        source: startedFromTarget ? dropNodeId : state.fromNode.id,
        target: startedFromTarget ? state.fromNode.id : dropNodeId,
        sourceHandle: null,
        targetHandle: startedFromTarget ? compareSlot ?? null : null,
      };
      if (canCreateCanvasInputConnection(latestDocument.current, connection)) onConnect(connection);
      return;
    }
    const current = latestDocument.current;
    if (!current) return;
    if (startedFromTarget && !canvasUpstreamNodeTypesForTarget(current, state.fromNode.id).size) {
      setCreateMenu(null);
      const target = current.nodes.find(node => node.id === state.fromNode?.id);
      if (target?.type === 'plugin' && canvasNodeAcceptsInput(target)) notify.info('这个节点的输入已满。');
      return;
    }
    if (tap) {
      const node = current.nodes.find(item => item.id === state.fromNode?.id);
      if (!node) return;
      const size = canvasNodeRenderedSize(node, current.content_versions);
      pointer = flowToScreenPosition({
        x: node.position.x + (startedFromTarget ? -96 : size.width + 96),
        y: node.position.y + size.height * (compareSlot === 'before' ? 0.35 : compareSlot === 'after' ? 0.65 : 0.5),
      });
    }
    setAddOpen(false);
    setCreateMenu({
      screen: pointer,
      compareSlot: isCanvasCompareSlot(compareSlot) ? compareSlot : undefined,
      flow: screenToFlowPosition(pointer),
      sourceId: state.fromNode.id,
      sourceIds: startedFromTarget ? undefined : sourceIds,
      sourceHandle: state.fromHandle?.type ?? 'source',
      pointer,
    });
  }, [connectSources, connectionSourceIds, flowToScreenPosition, onConnect, screenToFlowPosition]);

  const sweepHits = useRef<ReadonlySet<string>>(new Set());

  const onSelectionStart = useCallback(() => {
    selectionRectActive.current = true;
    sweepHits.current = new Set();
    // xyflow 在这个回调返回后、React 重渲染之前就会按自己的规则算一次命中，并把 selected 直接
    // 写进内部节点对象（画面会闪一帧「全部选中」）。这里同步把内部节点置为不可选，堵住这一帧；
    // 框选途中节点因选中变化被 xyflow 按新的 flowNodes 重建时，内部节点会拿回可选，订阅 store 再压回去。
    const lockSelectable = (state: { nodeLookup?: ReadonlyMap<string, { selectable?: boolean }> }) => {
      for (const node of state.nodeLookup?.values() ?? []) if (node.selectable !== false) node.selectable = false;
    };
    lockSelectable(flowStore.getState());
    sweepUnsubscribe.current?.();
    sweepUnsubscribe.current = flowStore.subscribe(lockSelectable);
  }, [flowStore]);

  const onSelectionEnd = useCallback(() => {
    selectionRectActive.current = false;
    sweepUnsubscribe.current?.();
    sweepUnsubscribe.current = null;
    // 还原成 flowNodes 里给的值（缺省可选；占位节点本来就不可选）。
    for (const node of flowStore.getState().nodeLookup.values()) {
      const internal = node as { selectable?: boolean; internals?: { userNode?: { selectable?: boolean } } };
      internal.selectable = internal.internals?.userNode?.selectable;
    }
    // 选区框（nodesselection-rect）由 xyflow 按它自己的命中数决定显隐，而它这一路被我们
    // 关掉了，永远是空的。它在本回调之后同步把 nodesSelectionActive 写成 false，
    // 所以放到微任务里按我们的命中结果再写一次。
    const active = sweepHits.current.size > 0;
    queueMicrotask(() => flowStore.setState({ nodesSelectionActive: active }));
  }, [flowStore]);

  // 普通节点碰到框就选中；分组框要被完整包住才选中（同 tldraw 对 frame 的规则），
  // 否则在分组里随手一框，整个分组连同成员都被带上。
  useEffect(() => flowStore.subscribe((state, previous) => {
    const rect = state.userSelectionRect;
    if (!rect || rect === previous.userSelectionRect || !selectionRectActive.current) return;
    const current = latestDocument.current;
    if (!current) return;
    const [tx, ty, zoom] = state.transform;
    const left = (rect.x - tx) / zoom;
    const top = (rect.y - ty) / zoom;
    const right = left + rect.width / zoom;
    const bottom = top + rect.height / zoom;
    const hits = new Set<string>();
    for (const node of current.nodes) {
      if (collapsedStackMemberIdsRef.current.has(node.id)) continue;
      const size = canvasNodeRenderedSize(node, current.content_versions);
      const nodeRight = node.position.x + size.width;
      const nodeBottom = node.position.y + size.height;
      const hit = node.type === 'group'
        ? node.position.x >= left && node.position.y >= top && nodeRight <= right && nodeBottom <= bottom
        : node.position.x < right && nodeRight > left && node.position.y < bottom && nodeBottom > top;
      if (hit) hits.add(node.id);
    }
    sweepHits.current = hits;
    setSelectedNodeIds(selection => (
      selection.size === hits.size && [...hits].every(id => selection.has(id)) ? selection : hits
    ));
  }), [flowStore]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    // 框选态要在事件到达的当下判定：setState 的 updater 可能延后到框选结束之后才跑。
    const swept = selectionRectActive.current;
    const persistedIds = new Set(latestDocument.current?.connections.map(connection => connection.id));
    setSelectedConnectionIds(current => {
      const next = new Set(current);
      for (const change of changes) {
        if (!('id' in change) || !persistedIds.has(change.id)) continue;
        if (change.type === 'select') {
          if (change.selected && swept) continue;
          change.selected ? next.add(change.id) : next.delete(change.id);
        }
        if (change.type === 'remove') next.delete(change.id);
      }
      return next;
    });
    const removedIds = new Set(changes.flatMap(change => (
      change.type === 'remove' && persistedIds.has(change.id) ? [change.id] : []
    )));
    if (removedIds.size) {
      commit(current => removeCanvasConnections(
        current,
        edge => removedIds.has(edge.id),
      ), true);
    }
  }, [commit]);

  // 多选里能隐藏的节点：有内容的，或已经隐藏的（让它们能一起显示回来）。
  const hideableSelection = useMemo(() => (document?.nodes ?? []).filter(node => {
    if (!selectedNodeIds.has(node.id)) return false;
    if (node.hidden) return true;
    const versionId = canvasNodeProvidesContent(node) ? node.data.current_version_id : null;
    return canvasNodeHasHideableContent(node, versionId ? document?.content_versions[versionId] : undefined,
      node.type === 'compare' && document ? canvasCompareHasInput(document, node.id) : false);
  }), [document, selectedNodeIds]);
  const hideableSelectionAllHidden = hideableSelection.length > 0
    && hideableSelection.every(node => node.hidden);

  /** 节点右键菜单（U1 / P1）：作用于当前选择。 */
  function nodeContextMenuItems(): CanvasContextMenuItem[] {
    const current = latestDocument.current;
    const selected = current?.nodes.filter(node => selectedNodeIds.has(node.id)) ?? [];
    const single = selected.length === 1 ? selected[0] : null;
    const versionId = single && canvasNodeProvidesContent(single) ? single.data.current_version_id : null;
    const version = versionId ? current?.content_versions[versionId] : undefined;
    const items: CanvasContextMenuItem[] = [
      { key: 'duplicate', label: '创建副本', icon: <CopyIcon />, disabled: !selected.length, onSelect: () => {
        if (!current || !selected.length) return;
        const ids = new Set(selected.map(node => node.id));
        pasteCanvasNodes({
          schema_version: 1,
          source_project_id: projectId,
          nodes: selected.map(node => structuredClone(node)),
          connections: current.connections
            .filter(edge => ids.has(edge.source_node_id) && ids.has(edge.target_node_id))
            .map(edge => structuredClone(edge)),
        });
      } },
    ];
    if (hideableSelection.length) {
      items.push({
        key: 'hide',
        label: hideableSelectionAllHidden ? '显示内容' : '遮盖内容',
        icon: hideableSelectionAllHidden ? <ShowIcon /> : <HideIcon />,
        onSelect: toggleSelectionHidden,
      });
    }
    if (selected.length > 1) {
      items.push({ key: 'group', label: '分组', icon: <LayersIcon />, shortcut: `${CANVAS_MOD_KEY} G`, onSelect: () => groupSelectionRef.current() });
    }
    if (version && version.kind !== 'text') {
      items.push({ key: 'download', label: '下载', icon: <DownloadIcon />, href: canvasDownloadUrl(projectId, version.version_id) });
    }
    items.push('separator', {
      key: 'delete', label: '删除', icon: <DeleteIcon />, destructive: true,
      shortcut: CANVAS_DELETE_KEYS.includes('Backspace') ? '⌫' : 'Delete',
      onSelect: () => deleteCanvasItems(new Set(selected.map(node => node.id)), new Set()),
    });
    return items;
  }

  /** 画布空白处右键菜单：撤销 / 重做、粘贴、在指针处添加节点。 */
  function paneContextMenuItems(flow: XYPosition, screen: XYPosition): CanvasContextMenuItem[] {
    const menu: CreateMenuState = { screen, flow };
    const clipboard = nodeClipboard.current;
    return [
      { key: 'undo', label: '撤销', icon: <UndoIcon />, shortcut: CANVAS_UNDO_KEYS, disabled: !canUndo, onSelect: undo },
      { key: 'redo', label: '重做', icon: <RedoIcon />, shortcut: CANVAS_REDO_KEYS, disabled: !canRedo, onSelect: redo },
      ...(clipboard ? [{ key: 'paste', label: '粘贴', icon: <CopyIcon />, shortcut: `${CANVAS_MOD_KEY} V`,
        onSelect: () => pasteCanvasNodes(clipboard) }] : []),
      'separator',
      { key: 'text', label: '文本', icon: <TextIcon />, onSelect: () => addTextNode(menu) },
      { key: 'image', label: '图片', icon: <ImageFileIcon />, onSelect: () => addGenerationNode('image', menu) },
      { key: 'video', label: '视频', icon: <VideoFileIcon />, onSelect: () => addGenerationNode('video', menu) },
      { key: 'upload', label: '上传素材', icon: <UploadIcon />, onSelect: () => uploadRef.current?.click() },
    ];
  }

  const toggleSelectionHidden = useCallback(() => {
    const ids = new Set(hideableSelection.map(node => node.id));
    if (ids.size === 0) return;
    const hidden = !hideableSelectionAllHidden;
    commit(current => ({
      ...current,
      nodes: current.nodes.map(node => ids.has(node.id) && Boolean(node.hidden) !== hidden
        ? { ...node, hidden }
        : node),
    }), true);
  }, [commit, hideableSelection, hideableSelectionAllHidden]);

  // 「停止并删除」：先停掉正在生成的节点，等它们的任务结束后再删（见下方 effect）。
  const [deleteAfterStop, setDeleteAfterStop] = useState<ReadonlySet<string> | null>(null);
  const cancelRunRef = useRef<(runId: string) => Promise<void>>(async () => undefined);

  const deleteCanvasItems = useCallback((
    nodeIds: ReadonlySet<string>,
    connectionIds: ReadonlySet<string>,
  ) => {
    if (nodeIds.size === 0 && connectionIds.size === 0) return;
    const nodes = latestDocument.current?.nodes ?? [];
    const blocked = canvasDeletionBlockedMessage(nodes, nodeIds, jobsByRunId);
    if (blocked) {
      setError(blocked);
      setErrorAction({
        message: blocked,
        label: '停止并删除',
        run: () => {
          setError(null);
          setDeleteAfterStop(new Set(nodeIds));
          for (const node of nodes) {
            const runId = nodeIds.has(node.id) ? canvasNodeActiveRunId(node) : null;
            const job = runId ? jobsByRunId.get(runId) : undefined;
            if (runId && (job?.status === 'pending' || job?.status === 'pending_confirm')) {
              void cancelRunRef.current(runId);
            }
          }
        },
      });
      return;
    }
    // 删除后右上角给撤销（规格 2.1）：撤销回到删除前那一步。
    const announce = (snapshot: CanvasDocument | null) => {
      if (!snapshot) return;
      const message = nodeIds.size
        ? nodeIds.size === 1 ? '已删除节点' : `已删除 ${nodeIds.size} 个节点`
        : connectionIds.size === 1 ? '已删除连线' : `已删除 ${connectionIds.size} 条连线`;
      notify.undo(message, () => undoToRef.current(snapshot));
    };
    let snapshot: CanvasDocument | null = null;
    // 只删连线时先让线 150ms 淡出再删（Q15）；带节点的删除照旧立即生效。
    if (nodeIds.size === 0 && motionAvailable()) {
      const edgeIds = new Set(connectionIds);
      setSelectedConnectionIds(new Set());
      void Promise.all([...edgeIds].map(fadeOutCanvasEdge)).then(() => {
        commit(current => {
          snapshot = current;
          return removeCanvasConnections(current, edge => edgeIds.has(edge.id));
        }, true);
        window.requestAnimationFrame(() => announce(snapshot));
      });
      requestAnimationFrame(() => editorRegionRef.current?.focus());
      return;
    }
    commit(current => {
      snapshot = current;
      const next = removeCanvasConnections(current, edge => (
        connectionIds.has(edge.id)
        || nodeIds.has(edge.source_node_id)
        || nodeIds.has(edge.target_node_id)
      ));
      return { ...next, nodes: next.nodes.filter(node => !nodeIds.has(node.id)) };
    }, true);
    window.requestAnimationFrame(() => announce(snapshot));
    setSelectedNodeIds(new Set());
    setSelectedConnectionIds(new Set());
    requestAnimationFrame(() => editorRegionRef.current?.focus());
  }, [commit, jobsByRunId]);

  const deleteSelection = useCallback(() => {
    deleteCanvasItems(selectedNodeIds, selectedConnectionIds);
  }, [deleteCanvasItems, selectedConnectionIds, selectedNodeIds]);
  const deleteNodes = useCallback((nodeIds: ReadonlySet<string>) => {
    deleteCanvasItems(nodeIds, new Set());
  }, [deleteCanvasItems]);

  useEffect(() => {
    if (!deleteAfterStop) return;
    const nodes = latestDocument.current?.nodes ?? [];
    const remaining = new Set([...deleteAfterStop].filter(id => nodes.some(node => node.id === id)));
    if (!remaining.size) { setDeleteAfterStop(null); return; }
    if (canvasDeletionBlockedMessage(nodes, remaining, jobsByRunId)) return;
    setDeleteAfterStop(null);
    deleteCanvasItems(remaining, new Set());
  }, [deleteAfterStop, deleteCanvasItems, jobsByRunId]);

  useEffect(() => {
    function handleDelete(event: KeyboardEvent) {
      if (!CANVAS_DELETE_KEYS.includes(event.key)) return;
      // 事件 target 与当前焦点都要看：正在文本框里打字时，这个破坏性快捷键一律不生效。
      if (isCanvasShortcutBlockedTarget(event.target)) return;
      if (isCanvasShortcutBlockedTarget(window.document.activeElement)) return;
      if (selectedNodeIds.size === 0 && selectedConnectionIds.size === 0) return;
      event.preventDefault();
      deleteSelection();
    }
    window.addEventListener('keydown', handleDelete);
    return () => window.removeEventListener('keydown', handleDelete);
  }, [deleteSelection, selectedConnectionIds.size, selectedNodeIds.size]);

  const selectedNode = document?.nodes.find(node => node.id === selectedId) ?? null;
  const selectedIsUploadedImageMaterial = Boolean(
    selectedNode
    && document
    && isUploadedImageMaterialNode(
      selectedNode,
      'current_version_id' in selectedNode.data && selectedNode.data.current_version_id
        ? document.content_versions[selectedNode.data.current_version_id]
        : undefined,
    ),
  );
  const selectedDraft = useMemo(() => selectedNode && !selectedIsUploadedImageMaterial
    ? resolveCanvasGenerationDraft(selectedNode, providers, canvasUiPreferences.generation_defaults.text)
    : null, [selectedNode, selectedIsUploadedImageMaterial, providers, canvasUiPreferences.generation_defaults.text]);
  const generationPanelOpen = Boolean(
    selectedNode
    && selectedDraft
    && dismissedGenerationPanelNodeId !== selectedNode.id,
  );
  const projectName = projects.find(project => project.project_id === projectId)?.name ?? '画布项目';

  function beginProjectRename() {
    projectNameEditorRef.current?.edit();
  }
  // D12：刚新建的「未命名项目」进来就让顶栏项目名处于可编辑状态。
  const projectNameKnown = projects.some(project => project.project_id === projectId);
  useEffect(() => {
    if (loading || !projectNameKnown || !isFreshCanvasProject(projectId)) return;
    const frame = window.requestAnimationFrame(() => projectNameEditorRef.current?.edit());
    return () => window.cancelAnimationFrame(frame);
  }, [loading, projectId, projectNameKnown]);

  async function saveProjectName(name: string) {
    settleFreshCanvasProject(projectId);
    projectRenameInFlight.current = true;
    setError(null);
    try {
      const renamed = await renameCanvasProject(projectId, name);
      setProjects(current => current.map(project => (
        project.project_id === projectId ? { ...project, name: renamed.name } : project
      )));
      announceToolNotice(`已重命名为“${renamed.name}”`);
    } finally {
      projectRenameInFlight.current = false;
    }
  }

  function canvasPlacementBounds() {
    const surface = editorRegionRef.current?.getBoundingClientRect();
    const screenBounds = {
      left: (surface?.left ?? 0) + 24,
      right: (surface?.right ?? window.innerWidth) - 24,
      top: (surface?.top ?? 0) + 24,
      bottom: (surface?.bottom ?? window.innerHeight) - 24,
    };
    const topLeft = screenToFlowPosition({ x: screenBounds.left, y: screenBounds.top });
    const bottomRight = screenToFlowPosition({ x: screenBounds.right, y: screenBounds.bottom });
    return {
      screenBounds,
      flowBounds: {
        left: Math.min(topLeft.x, bottomRight.x),
        right: Math.max(topLeft.x, bottomRight.x),
        top: Math.min(topLeft.y, bottomRight.y),
        bottom: Math.max(topLeft.y, bottomRight.y),
      },
    };
  }

  function placeNewNode(preferred: CanvasPoint, size: CanvasSize) {
    const { flowBounds } = canvasPlacementBounds();
    return placeCanvasNodeWithoutOverlap(
      preferred,
      latestDocument.current?.nodes ?? [],
      size,
      flowBounds,
      node => canvasNodeRenderedSize(node, latestDocument.current?.content_versions ?? {}),
    );
  }

  function menuNodePosition(menu: CreateMenuState | null, size: CanvasSize, handleY = 0.5) {
    if (!menu) return defaultPosition(size);
    if (!menu.pointer || !latestDocument.current) return placeNewNode(menu.flow, size);
    return placeCanvasConnectedNode(menu.flow, size,
      menu.sourceHandle === 'target', latestDocument.current, handleY);
  }

  function defaultPosition(size: CanvasSize = CANVAS_DEFAULT_NODE_SIZE) {
    const { screenBounds } = canvasPlacementBounds();
    const center = screenToFlowPosition({
      x: (screenBounds.left + screenBounds.right) / 2,
      y: (screenBounds.top + screenBounds.bottom) / 2,
    });
    return placeNewNode(
      { x: center.x - size.width / 2, y: center.y - size.height / 2 },
      size,
    );
  }

  /** 工具条「保存」/「分享」共用：先落盘（服务端按画布文档核对节点与版本），再取当前版本。 */
  const persistedCurrentVersion = useCallback(async (node: CanvasContentNode) => {
    const versionId = node.data.current_version_id;
    if (!versionId) {
      setError('这个节点还没有可保存的内容。');
      return null;
    }
    if (!await persistNow()) return null;
    const version = latestDocument.current?.content_versions[versionId];
    if (!version) {
      setError('这个节点的内容版本已经不存在。');
      return null;
    }
    return version;
  }, [persistNow]);

  const saveNodeToLibrary = useCallback(async (node: CanvasContentNode) => {
    const version = await persistedCurrentVersion(node);
    if (!version) return;
    const save = canvasNodeSaveRequest({
      node,
      version,
      projectId,
      previewUrl: localCanvasTransport.mediaUrl(projectId, version.version_id),
      requestId: crypto.randomUUID(),
    });
    if (!save) {
      setError('音频不能存为创作资产。');
      return;
    }
    setLibraryMode(save.libraryMode);
    setCreationAssetSaveRequest(save.request);
  }, [persistedCurrentVersion, projectId]);

  const shareCanvasResult = useCallback(async (node: CanvasContentNode) => {
    const version = await persistedCurrentVersion(node);
    if (!version) return;
    const request = canvasNodeShareRequest({
      node,
      version,
      projectId,
      previewUrl: localCanvasTransport.mediaUrl(projectId, version.version_id),
      // ref 在下方定义，回调只在点击时读它，不进依赖。
      finalCategory: 'sha256' in version ? assetsByDigestRef.current.get(version.sha256)?.category : null,
    });
    if (!request) {
      setError('只有生成的图片或视频能分享。');
      return;
    }
    setShareRequest(request);
  }, [persistedCurrentVersion, projectId]);

  /** 服务端一次锁内往画布里加节点（插入资产 / 复刻）的共用合并：只收新节点、新版本、新连线，
   *  并发编辑保留，新节点按本地画布避让，整次插入是一步可撤销的历史。
   *  placement：'each' 逐个节点找空位；'group' 整组按包围盒平移（复刻的组内布局由服务端排好）。
   *  返回 true = 已合并；失败交给 onError（缺省报错条）。 */
  async function applyServerInsertion(
    request: (documentRevision: number) => Promise<CanvasDocument>,
    {
      placement = 'each',
      onError = insertError => setError((insertError as Error).message),
    }: {
      placement?: 'each' | 'group';
      onError?: (error: unknown) => void;
    } = {},
  ): Promise<boolean> {
    if (!await persistNow()) return false;
    const before = latestDocument.current;
    if (!before) return false;
    const dirtyAtInsertion = dirtyVersion.current;
    libraryInsertInFlight.current = true;
    let inserted = false;
    const command = (async () => {
      try {
        const remote = await request(serverRevision.current);
        const previousIds = new Set(before.nodes.map(node => node.id));
        const insertedNodes = remote.nodes.filter(node => !previousIds.has(node.id));
        const insertedVersions = Object.fromEntries(
          Object.entries(remote.content_versions).filter(([versionId]) => (
            !before.content_versions[versionId]
          )),
        );
        const concurrent = latestDocument.current ?? before;
        const concurrentIds = new Set(concurrent.nodes.map(node => node.id));
        const authoritativeRevision = Math.max(serverRevision.current, remote.revision);
        const mergedVersions = acceptServerContentVersions(
          concurrent.content_versions,
          insertedVersions,
        );
        const { flowBounds } = canvasPlacementBounds();
        const newNodes = insertedNodes.filter(inserted => !concurrentIds.has(inserted.id));
        const placedInsertedNodes: CanvasNode[] = placement === 'group'
          ? placeCanvasNodeGroupWithoutOverlap(newNodes, concurrent.nodes, mergedVersions, flowBounds)
          : [];
        if (placement === 'each') {
          for (const inserted of newNodes) {
            const placedPosition = placeCanvasNodeWithoutOverlap(
              inserted.position,
              [...concurrent.nodes, ...placedInsertedNodes],
              canvasNodeRenderedSize(inserted, mergedVersions),
              flowBounds,
              node => canvasNodeRenderedSize(node, mergedVersions),
            );
            placedInsertedNodes.push({ ...inserted, position: placedPosition });
          }
        }
        const remoteInsertedPositions = new Map(
          insertedNodes.map(node => [node.id, node.position] as const),
        );
        const insertedLayoutChanged = placedInsertedNodes.some(node => {
          const remotePosition = remoteInsertedPositions.get(node.id);
          return node.position.x !== remotePosition?.x || node.position.y !== remotePosition?.y;
        });
        const merged: CanvasDocument = {
          ...concurrent,
          revision: authoritativeRevision,
          updated_at: remote.updated_at,
          nodes: [
            ...concurrent.nodes,
            ...placedInsertedNodes,
          ],
          connections: [
            ...concurrent.connections,
            ...remote.connections.filter(connection => (
              !concurrent.connections.some(current => current.id === connection.id)
            )),
          ],
          content_versions: mergedVersions,
        };
        history.current.past.push(concurrent);
        history.current.past = history.current.past.slice(-50);
        history.current.future = [];
        serverRevision.current = authoritativeRevision;
        if (dirtyVersion.current > dirtyAtInsertion || insertedLayoutChanged) {
          saveQueued.current = merged;
          setSaveState('saving');
        } else {
          saveQueued.current = null;
          setSaveState('saved');
        }
        markCanvasNodesEntering(placedInsertedNodes.map(node => node.id));
        setDocument(merged);
        flowNodeCache.current.clear();
        setSelectedConnectionIds(new Set());
        setSelectedNodeIds(new Set());
        setFocusVariableNodeId(insertedNodes.find(node => node.type === 'text')?.id ?? null);
        inserted = true;
      } catch (insertError) {
        onError(insertError);
      } finally {
        libraryInsertInFlight.current = false;
        if (saveQueued.current) {
          try {
            await flushSave();
          } catch {
            setError('插入已完成，但并发编辑尚未保存。请检查服务后重试。');
          }
        }
      }
    })();
    libraryInsertCommand.current = command;
    try {
      await command;
    } finally {
      if (libraryInsertCommand.current === command) libraryInsertCommand.current = null;
    }
    return inserted;
  }

  function insertCreationAsset(
    assetId: string,
    variableValues: Record<string, string>,
    targetNodeId?: string,
    position?: CanvasPoint,
  ) {
    return applyServerInsertion(documentRevision => insertCreationAssetIntoCanvas({
      projectId,
      assetId,
      position: position ? placeNewNode(position, CANVAS_DEFAULT_NODE_SIZE) : defaultPosition(),
      documentRevision,
      variableValues,
      targetNodeId,
    }));
  }

  /** 画布复刻：模型按本机 key 匹配，匹配不到传 null（配置节点模型位留空，「先选模型」阻断生效）。 */
  async function reproduceGenerationAsset(asset: CreationAsset) {
    if (asset.content.kind !== 'generation') {
      setError('只有生成资产能复刻。');
      return;
    }
    const recipe = asset.content.snapshot;
    const match = resolveRecipeModel(recipe, keys);
    let warnings: string[] = [];
    const reproduced = await applyServerInsertion(async documentRevision => {
      const { warnings: responseWarnings, ...remote } = await localCanvasTransport.reproduce({
        projectId,
        assetId: asset.asset_id,
        position: defaultPosition(),
        alias: match?.alias ?? null,
        model: match?.model ?? null,
        documentRevision,
      });
      // warnings 是这次响应的附言，不属于文档：拆出来单独提示，合并只认节点 / 版本 / 连线。
      warnings = responseWarnings;
      return remote;
    }, { placement: 'group', onError: reproduceError => {
      if (
        reproduceError instanceof ApiError
        && reproduceError.status === 409
        && reproduceError.code === 'revision_conflict'
      ) {
        // 别处先改了画布：收服务端文档，再让画师点一次重试（位置与版本号都要按新文档重算）。
        void reloadDocumentFromServer()
          .then(() => {
            setError(REPRODUCE_CONFLICT_MESSAGE);
            setErrorAction({
              message: REPRODUCE_CONFLICT_MESSAGE,
              label: '重试',
              run: () => {
                setError(null);
                void reproduceGenerationAsset(asset);
              },
            });
          })
          .catch(reloadError => setError(errorText(reloadError)));
        return;
      }
      setError((reproduceError as Error).message);
    } });
    if (!reproduced) return;
    const notices = canvasReproduceNotices(recipe, match, warnings);
    if (notices.length) announceToolNotice(notices.join('\n'));
  }

  function openTeamPanel() {
    setAddOpen(false);
    setCreateMenu(null);
    setLibraryMode('team');
    setLibraryPanelKey(current => current + 1);
  }

  /** 推荐是附加信息：查不到或查询失败都不打断拖入，只在有命中时提示。 */
  async function suggestRelatedRecipes(sha256: string) {
    let related: Awaited<ReturnType<typeof listRelatedTeamAssets>>;
    try {
      related = await listRelatedTeamAssets(projectId, sha256);
    } catch {
      return;
    }
    if (!related.length) return;
    announceToolNotice(`有 ${related.length} 条相关配方`, { label: '看看', run: () => openTeamPanel() });
  }

  /** 分享提醒的「复刻」/「看看」：画布页认领后就地处理，不再导航去 Studio。 */
  async function handleTeamAssetAction(action: TeamAssetAction) {
    if (!document) {
      // 画布还在展开：先记下，文档到了再执行（复刻要按文档版本号写入）。
      pendingTeamAssetAction.current = action;
      return;
    }
    if (action.action === 'open') {
      openTeamPanel();
      return;
    }
    try {
      const result = await adoptTeamAsset(action.library_id, action.asset_id, projectId);
      if (result.asset.kind !== 'generation') {
        openTeamPanel();
        return;
      }
      await reproduceGenerationAsset(result.asset);
    } catch (adoptError) {
      setError(adoptError instanceof Error ? adoptError.message : String(adoptError));
    }
  }
  teamAssetActionRef.current = action => void handleTeamAssetAction(action);
  const documentLoaded = document !== null;
  useEffect(() => {
    const pending = pendingTeamAssetAction.current;
    if (!documentLoaded || !pending) return;
    pendingTeamAssetAction.current = null;
    teamAssetActionRef.current(pending);
  }, [documentLoaded]);

  function handleCanvasDrop(event: DragEvent) {
    // 团队库的拖放先落成本机创作资产，再走与「资产面板拖入」完全一样的插入路径。
    // 先看 types：文件拖放不带这个类型，没必要（也不保证能）读 dataTransfer。
    const teamAsset = Array.from(event.dataTransfer.types ?? []).includes(TEAM_ASSET_DRAG_TYPE)
      ? readTeamAssetDrag(event.dataTransfer)
      : null;
    if (teamAsset) {
      event.preventDefault();
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void (async () => {
        try {
          const result = await adoptTeamAsset(teamAsset.library_id, teamAsset.entry_id, projectId);
          const inserted = await insertCreationAsset(result.asset.asset_id, {}, undefined, flow);
          if (inserted && result.asset.kind === 'media' && result.asset.content.kind === 'media') {
            await suggestRelatedRecipes(result.asset.content.sha256);
          }
        } catch (adoptError) {
          setError(adoptError instanceof Error ? adoptError.message : String(adoptError));
        }
      })();
      return;
    }
    // 个人资产与参考库卡片拖入：落点与「使用」一致，在指针处插入这项资产。
    const creationAsset = Array.from(event.dataTransfer.types ?? []).includes(CREATION_ASSET_DRAG_TYPE)
      ? readCreationAssetDrag(event.dataTransfer)
      : null;
    if (creationAsset) {
      event.preventDefault();
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void insertCreationAsset(creationAsset.asset_id, {}, undefined, flow).catch(insertError => {
        setError(errorText(insertError));
      });
      return;
    }
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) {
      // 不 preventDefault 的话浏览器按默认行为打开这个文件，整个应用被顶掉，
      // 未保存的画布内容一起丢。快捷键面板本来就承诺「拖入图片 / 视频 / 音频 → 上传到画布」。
      event.preventDefault();
      const origin = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      handleUploads(files, { screen: { x: event.clientX, y: event.clientY }, flow: origin });
      return;
    }
  }

  function appendNode(
    node: CanvasNode,
    menu: CreateMenuState | null,
    baseDocument?: CanvasDocument,
    initialVersions: CanvasContentVersion[] = [],
    focus = true,
  ) {
    const apply = (current: CanvasDocument) => {
      const nodes = [...current.nodes, node];
      const connections = [...current.connections];
      const contentVersions = initialVersions.reduce<Record<string, CanvasContentVersion>>(
        (versions, version) => ({ ...versions, [version.version_id]: version }),
        current.content_versions,
      );
      if (menu?.sourceId) {
        const pairs = menu.sourceHandle === 'target'
          ? [{ sourceNodeId: node.id, targetNodeId: menu.sourceId }]
          : (menu.sourceIds ?? [menu.sourceId]).map(sourceNodeId => ({ sourceNodeId, targetNodeId: node.id }));
        for (const { sourceNodeId, targetNodeId } of pairs) {
          if (canCreateCanvasInputConnection({ ...current, nodes, content_versions: contentVersions }, {
            source: sourceNodeId,
            target: targetNodeId,
          })) {
            connections.push({
              id: makeId('connection'),
              role: 'input',
              source_node_id: sourceNodeId,
              target_node_id: targetNodeId,
              ...(menu.compareSlot ? { slot: menu.compareSlot } : {}),
            });
          }
        }
      }
      // 「创建并连接」顺带建的线亮一下（updater 可能延后到渲染时才跑，所以在这里点名）。
      flashCanvasEdges(connections.slice(current.connections.length).map(connection => connection.id));
      const next = { ...current, nodes, connections, content_versions: contentVersions };
      return menu?.sourceId
        ? syncCanvasPromptReferences(next, new Set([
          menu.sourceHandle === 'target' ? menu.sourceId : node.id,
        ]))
        : next;
    };
    if (baseDocument) {
      // 上传命令创建的 Content Version 已是服务端历史；撤销只移除随后添加的节点。
      history.current.past.push(baseDocument);
      history.current.past = history.current.past.slice(-50);
      history.current.future = [];
      const next = apply(baseDocument);
      latestDocument.current = next;
      setDocument(next);
      dirtyVersion.current += 1;
      setDirtySignal(dirtyVersion.current);
    } else {
      commit(apply, true);
    }
    const linked = Boolean(menu?.pointer && menu.sourceId);
    markCanvasNodesEntering([node.id], linked ? 0.92 : 0.98,
      linked ? (menu?.sourceHandle === 'target' ? 'right' : 'left') : 'center');
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set(linked ? [node.id] : []));
    setAddOpen(false);
    setCreateMenu(null);
    if (linked) {
      saveBeforePanelFocus.current = true;
      setDismissedGenerationPanelNodeId(null);
      requestAnimationFrame(() => {
        const pending = pendingViewportCommand.current;
        if (pending) void pending.then(() => revealConnectedNode(node));
        else revealConnectedNode(node);
      });
    } else if (focus) focusNewNodesHandler.current([node]);
  }

  function revealConnectedNode(node: CanvasNode) {
    const surface = editorRegionRef.current;
    if (!surface || !latestSelectedNodeIds.current.has(node.id)) return;
    const bounds = canvasChromeInsetBounds(surface);
    if (!bounds.width || !bounds.height) return;
    const size = canvasNodeRenderedSize(node, latestDocument.current?.content_versions ?? {});
    const topLeft = flowToScreenPosition(node.position);
    const zoom = getZoom();
    const width = size.width * zoom;
    const panel = surface.querySelector<HTMLElement>(`[data-canvas-node-panel-anchor="${CSS.escape(node.id)}"]`);
    // 面板横向独立夹紧；纵向在节点下方为面板留出空间。
    const left = topLeft.x, right = topLeft.x + width;
    const panelHeight = panel ? panel.offsetHeight + 16 : 0;
    const bottom = topLeft.y + size.height * zoom + panelHeight;
    const delta = (low: number, high: number, min: number, max: number) =>
      low < min ? min - low : Math.min(0, Math.max(min - low, max - high));
    const dx = delta(left, right, bounds.left + 16, bounds.right - 16);
    const dy = delta(topLeft.y, bottom, bounds.top + 16, bounds.bottom - 16);
    if (dx || dy) {
      const viewport = getViewport();
      void runViewportCommand(() => setViewport({ x: viewport.x + dx, y: viewport.y + dy, zoom },
        { duration: viewportMotionMs(MOTION_DURATION.base) }));
    }
  }

  function addTextNode(menu: CreateMenuState | null = createMenu) {
    addGenerationNode('text', menu);
  }

  function addCompareNode(menu: CreateMenuState | null = createMenu) {
    const size = { width: 320, height: 320 };
    appendNode({ id: makeId('compare'), type: 'compare', title: '对比',
      position: menuNodePosition(menu, size, 0.35),
      size, z_index: 0, data: {} }, menu);
  }

  function addPluginNode(plugin: PluginPackageLock, contribution: PluginNodeContribution) {
    const size = contribution.default_size;
    const shell: CanvasPluginNode = { id: makeId('plugin'), type: 'plugin', title: contribution.title,
      position: defaultPosition(size), size, z_index: 0,
      data: { plugin_id: plugin.id, node_type: contribution.type, plugin_version: plugin.version,
        package_digest: plugin.digest, data_schema_version: contribution.payload_schema_version,
        payload: {}, generation_draft: null } };
    if (plugin.runtime !== 'host') {
      appendNode(shell, null);
      return;
    }
    // 宿主插件（ADR-0039）的 payload 由插件代码填；插件启用时分块已在画布打开时加载。
    void loadHostPlugin(plugin.id).then(module => {
      const type = module?.nodeTypes[contribution.type];
      if (type) appendNode(type.create(shell), null);
    });
  }

  function groupSelection() {
    const current = latestDocument.current;
    if (!current) return;
    const members = current.nodes.filter(node => selectedNodeIds.has(node.id));
    const grouped = new Set(current.nodes.flatMap(node => node.type === 'group' ? node.data.member_node_ids : []));
    if (members.some(node => node.type === 'group' || grouped.has(node.id))) {
      setError('一个节点只能属于一个分组，请先解散原分组。'); return;
    }
    const left = Math.min(...members.map(node => node.position.x)) - 24;
    const top = Math.min(...members.map(node => node.position.y)) - 40;
    const right = Math.max(...members.map(node => node.position.x + canvasNodeRenderedSize(node, current.content_versions).width)) + 24;
    const bottom = Math.max(...members.map(node => node.position.y + canvasNodeRenderedSize(node, current.content_versions).height)) + 24;
    const id = makeId('group');
    commit(document => ({ ...document, nodes: [...document.nodes, { id, type: 'group', title: '分组',
      position: { x: left, y: top }, size: { width: right - left, height: bottom - top }, z_index: 0,
      data: {
        // 顺序按画布阅读顺序写死在数据里：它既是分组当素材包时的参考编号顺序，也是超上限时
        // 的截断依据。存成数据而不是两端各排一次，省掉一个必然漂移的判据。
        member_node_ids: canvasReadingOrder(members, current.content_versions).map(node => node.id),
      } }] }), true);
    setSelectedNodeIds(new Set([id]));
  }

  function addGenerationNode(
    kind: JobKind,
    menu: CreateMenuState | null = createMenu,
    audioFamily?: CanvasAudioFamily,
  ) {
    // 语音与音乐同为音频节点：各自从对应的偏好与模型族开始。
    const draft = createCanvasGenerationDraft(providers, kind, {
      inputPolicy: 'all_connected',
      preference: canvasUiPreferences.generation_defaults[audioFamily === 'music' ? 'music' : kind],
      audioFamily,
    });
    const nodeSize = kind === 'text' ? CANVAS_TEXT_NODE_DEFAULT_SIZE : CANVAS_DEFAULT_NODE_SIZE;
    const base = {
      id: makeId(kind),
      title: kind === 'audio'
        ? (audioFamily === 'music' ? '音乐' : '语音')
        : { text: '文本', image: '图片', video: '视频' }[kind],
      position: menuNodePosition(menu, nodeSize),
      z_index: 0,
    };
    const data = { current_version_id: null, generation_draft: draft, active_run_id: null };
    if (kind === 'text') {
      const versionId = makeId('version');
      const version: CanvasTextVersion = {
        version_id: versionId,
        kind: 'text',
        text: '',
        created_at: new Date().toISOString(),
        sha256: CANVAS_LOCAL_VERSION_SHA,
        origin: { kind: 'user_edit' },
      };
      pendingTextVersions.current.set(base.id, versionId);
      appendNode({
        ...base,
        type: 'text',
        data: { ...data, current_version_id: versionId, display: { scale: 'sm' } },
      }, menu, undefined, [version]);
    } else if (kind === 'audio') appendNode({ ...base, type: 'audio', data }, menu);
    else if (kind === 'image') appendNode({
      ...base,
      type: 'image',
      data: { ...data, display: { fit: 'contain', free_resize: false } },
    }, menu);
    else appendNode({
      ...base,
      type: 'video',
      data: { ...data, display: { fit: 'contain', free_resize: false } },
    }, menu);
  }

  async function uploadMaterial(file: File, menu: CreateMenuState | null, rowPosition?: CanvasPoint) {
    const uploaded = await uploadCanvasMedia(projectId, file, serverRevision.current);
    if (latestDocument.current?.project_id !== projectId) return null;
    serverRevision.current = Math.max(serverRevision.current, uploaded.document.revision);
    const version = uploaded.version;
    const concurrent = latestDocument.current ?? uploaded.document;
    const baseDocument: CanvasDocument = {
      ...concurrent,
      revision: serverRevision.current,
      updated_at: uploaded.document.updated_at,
      content_versions: acceptServerContentVersions(
        concurrent.content_versions,
        uploaded.document.content_versions,
      ),
    };
    const base = {
      id: makeId(version.kind),
      title: uploaded.filename,
      position: (() => {
        const size = version.kind === 'image' || version.kind === 'video'
          ? sizeLockedToCanvasVersion(null, version)
          : CANVAS_DEFAULT_NODE_SIZE;
        return rowPosition ?? (menu?.flow ? placeNewNode(menu.flow, size) : defaultPosition(size));
      })(),
      z_index: 0,
    };
    const node: CanvasContentNode = version.kind === 'audio'
      ? {
          ...base,
          type: 'audio',
          data: { current_version_id: version.version_id, generation_draft: null, active_run_id: null },
        }
      : version.kind === 'image'
        ? {
            ...base,
            type: 'image',
            data: { current_version_id: version.version_id, generation_draft: null, active_run_id: null, display: { fit: 'contain', free_resize: false } },
          }
        : {
            ...base,
            type: 'video',
            data: { current_version_id: version.version_id, generation_draft: null, active_run_id: null, display: { fit: 'contain', free_resize: false } },
          };
    // 多文件上传由 handleUploads 在全部落位后统一对一次视口。
    appendNode(node, menu, baseDocument, [], false);
    return node.id;
  }

  function handleUploads(allFiles: File[], menu: CreateMenuState | null = createMenu, emptyTarget?: MediaReplaceTarget, successNotice?: string, historyKinds?: ReadonlyMap<File, HistoryKind>) {
    if (!allFiles.length) return;
    // 一次拖进来一批：跳过明显不是图片 / 视频 / 音频的文件，其余照常导入，最后一条汇总（Q11）。
    // 浏览器给不出类型的（空 type）交给服务端判断。
    const files = allFiles.filter(file => historyKinds?.has(file) || !file.type || /^(image|video|audio)\//.test(file.type));
    const unsupported = allFiles.length - files.length;
    if (!files.length) {
      setError(unsupported === 1 ? '这个文件格式不支持，只能导入图片、视频或音频。' : `${unsupported} 个文件格式都不支持，只能导入图片、视频或音频。`);
      return;
    }
    // Each batch owns the document command window; later drops wait instead of racing revisions.
    const command = (uploadQueue.current ?? Promise.resolve()).then(async () => {
      if (latestDocument.current?.project_id !== projectId || !await persistNow()) return;
      if (documentCommandInFlight.current) {
        setError('请等待当前画布操作完成后再上传。');
        return;
      }
      documentCommandInFlight.current = true;
      setAddOpen(false);
      setCreateMenu(null);
      setError(null);
      if (emptyTarget) setMediaReplaceBusyNodeIds(current => new Set(current).add(emptyTarget.nodeId));
      const failures: string[] = [];
      const added: string[] = [];
      try {
        let rowX = menu?.flow.x ?? 0;
        for (const [index, file] of files.entries()) {
          if (latestDocument.current?.project_id !== projectId) return;
          try {
            if (index === 0 && emptyTarget) {
              const before = latestDocument.current;
              const target = before.nodes.find(node => node.id === emptyTarget.nodeId);
              // A chooser can stay open while the target changes; never overwrite newer content.
              if (!target || !isContentNode(target) || target.data.current_version_id) {
                throw new Error('原空节点已有内容或已删除，请重新选择上传位置。');
              }
              const dirtyAtCommand = dirtyVersion.current;
              const uploaded = await replaceCanvasNodeMedia(projectId, target.id, file, serverRevision.current);
              if (latestDocument.current?.project_id !== projectId) return;
              mergeMediaPointerCommand(uploaded.document, target.id, dirtyAtCommand, before);
              added.push(target.id);
            } else {
              const position = historyKinds && menu ? { ...menu, flow: { x: rowX, y: menu.flow.y } } : menu;
              let id: string | null;
              if (historyKinds?.get(file) === 'text') {
                const text = await file.text();
                if (latestDocument.current?.project_id !== projectId) return;
                const versionId = makeId('version');
                id = makeId('text');
                appendNode({ id, type: 'text', title: file.name, position: position?.flow ?? defaultPosition(CANVAS_TEXT_NODE_DEFAULT_SIZE),
                  z_index: 0, data: { current_version_id: versionId, generation_draft: null, active_run_id: null, display: { scale: 'sm' } } },
                  position, latestDocument.current, [{ version_id: versionId, kind: 'text', text,
                    created_at: new Date().toISOString(), sha256: CANVAS_LOCAL_VERSION_SHA, origin: { kind: 'user_edit' } }], false);
              } else id = await uploadMaterial(file, position, historyKinds ? position?.flow : undefined);
              if (id) {
                added.push(id);
                if (historyKinds) {
                  const current = latestDocument.current;
                  const node = current?.nodes.find(candidate => candidate.id === id);
                  if (node && current) rowX = node.position.x + canvasNodeRenderedSize(node, current.content_versions).width + 32;
                }
              }
            }
          } catch (error) {
            failures.push(`${shortFileName(file.name)}：${(error as Error).message}`);
          }
        }
      } finally {
        if (latestDocument.current?.project_id === projectId) {
          documentCommandInFlight.current = false;
          if (emptyTarget) setMediaReplaceTarget(null);
          if (emptyTarget) setMediaReplaceBusyNodeIds(current => {
            const next = new Set(current);
            next.delete(emptyTarget.nodeId);
            return next;
          });
          // Upload responses register versions, not the new nodes or concurrent local edits.
          saveQueued.current = latestDocument.current;
          try {
            await flushSave(true);
          } catch {
            failures.push('素材已上传，但画布尚未保存，请重试保存。');
          }
          if (latestDocument.current?.project_id === projectId) {
            setSelectedConnectionIds(new Set());
            setSelectedNodeIds(new Set(added));
            const addedIds = new Set(added);
            focusNewNodesHandler.current(latestDocument.current.nodes.filter(node => addedIds.has(node.id)));
            if (failures.length || unsupported) {
              const summary = [
                `已导入 ${added.length} 项`,
                unsupported ? `${unsupported} 项格式不支持` : null,
                failures.length ? `${failures.length} 项失败` : null,
              ].filter(Boolean).join('，');
              setError(failures.length ? `${summary}：${failures.slice(0, 2).join('；')}` : summary);
            } else announceToolNotice(successNotice ?? `已添加 ${added.length} 个素材`);
          }
        }
      }
    }).catch(error => {
      if (latestDocument.current?.project_id === projectId) setError((error as Error).message);
    });
    uploadQueue.current = command;
    void command.finally(() => {
      if (uploadQueue.current === command) uploadQueue.current = null;
    });
    return command;
  }

  function copySelectedNodes(event: ClipboardEvent) {
    if (isCanvasShortcutBlockedTarget(event.target) || !document || selectedNodeIds.size === 0) return;
    const nodes = document.nodes
      .filter(node => selectedNodeIds.has(node.id))
      .map(node => structuredClone(node));
    if (!nodes.length) return;
    const copiedIds = new Set(nodes.map(node => node.id));
    const payload: CanvasClipboardPayload = {
      schema_version: 1,
      source_project_id: projectId,
      nodes,
      connections: document.connections
        .filter(connection => (
          copiedIds.has(connection.source_node_id)
          && copiedIds.has(connection.target_node_id)
        ))
        .map(connection => structuredClone(connection)),
    };
    event.preventDefault();
    event.clipboardData?.setData(CANVAS_NODE_CLIPBOARD_TYPE, JSON.stringify(payload));
    nodeClipboard.current = payload;
    pasteSequence.current = 0;
    announceToolNotice(`已复制 ${nodes.length} 个节点`);
  }

  async function pasteCanvasNodesFromOtherProject(payload: CanvasClipboardPayload) {
    // 位置沿用源画布的相对布局，整组由 applyServerInsertion 按 group 放到不重叠的位置。
    const idMap = new Map(payload.nodes.map(node => [node.id, makeId(node.type)]));
    const topZ = Math.max(0, ...(document?.nodes.map(node => node.z_index) ?? []));
    const nodes = payload.nodes.map((source, index) => cloneCanvasNode(
      source, idMap, source.position, topZ + index + 1, false,
    ));
    const connections = payload.connections.flatMap(connection => {
      const sourceId = idMap.get(connection.source_node_id);
      const targetId = idMap.get(connection.target_node_id);
      const target = nodes.find(node => node.id === targetId);
      if (target?.type === 'image_edit' && sourceId !== target.data.source_node_id) return [];
      return sourceId && targetId
        ? [{ ...structuredClone(connection), id: makeId('connection'), source_node_id: sourceId, target_node_id: targetId }]
        : [];
    });
    const pasted = await applyServerInsertion(documentRevision => localCanvasTransport.paste({
      projectId,
      sourceProjectId: payload.source_project_id,
      nodes,
      connections,
      documentRevision,
    }), { placement: 'group' });
    if (pasted) announceToolNotice(`已从另一张画布粘贴 ${nodes.length} 个节点`);
  }

  function pasteCanvasNodes(payload: CanvasClipboardPayload) {
    if (!payload.nodes.length) return;
    pasteSequence.current += 1;
    const offset = 28 * pasteSequence.current;
    const idMap = new Map(payload.nodes.map(node => [node.id, makeId(node.type)]));
    const topZ = Math.max(0, ...(document?.nodes.map(node => node.z_index) ?? []));
    const versions = latestDocument.current?.content_versions ?? {};
    const left = Math.min(...payload.nodes.map(node => node.position.x));
    const top = Math.min(...payload.nodes.map(node => node.position.y));
    const right = Math.max(...payload.nodes.map(node => (
      node.position.x + canvasNodeRenderedSize(node, versions).width
    )));
    const bottom = Math.max(...payload.nodes.map(node => (
      node.position.y + canvasNodeRenderedSize(node, versions).height
    )));
    const groupPosition = placeNewNode(
      { x: left + offset, y: top + offset },
      { width: right - left, height: bottom - top },
    );
    const shift = { x: groupPosition.x - left, y: groupPosition.y - top };
    const nodes = payload.nodes.map((source, index) => cloneCanvasNode(
      source,
      idMap,
      { x: source.position.x + shift.x, y: source.position.y + shift.y },
      topZ + index + 1,
    ));
    const connections = payload.connections.flatMap(connection => {
      const sourceId = idMap.get(connection.source_node_id);
      const targetId = idMap.get(connection.target_node_id);
      const target = nodes.find(node => node.id === targetId);
      if (target?.type === 'image_edit' && sourceId !== target.data.source_node_id) return [];
      return sourceId && targetId
        ? [{ ...structuredClone(connection), id: makeId('connection'), source_node_id: sourceId, target_node_id: targetId }]
        : [];
    });
    for (const node of nodes) {
      if (node.type !== 'image_edit') continue;
      const sourceId = node.data.source_node_id;
      if (sourceId && !connections.some(edge => edge.source_node_id === sourceId && edge.target_node_id === node.id)) {
        connections.push({ id: makeId('connection'), source_node_id: sourceId, target_node_id: node.id, role: 'material' });
      }
    }
    commit(current => ({
      ...current,
      nodes: [...current.nodes, ...nodes],
      connections: [...current.connections, ...connections],
    }), true);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set());
    announceToolNotice(`已粘贴 ${nodes.length} 个节点`);
  }

  function pastePlainText(text: string) {
    if (!text.trim()) return;
    const nodeId = makeId('text');
    const versionId = makeId('version');
    const createdAt = new Date().toISOString();
    const version: CanvasTextVersion = {
      version_id: versionId,
      kind: 'text',
      text,
      created_at: createdAt,
      sha256: CANVAS_LOCAL_VERSION_SHA,
      origin: { kind: 'user_edit' },
    };
    const node: CanvasContentNode = {
      id: nodeId,
      type: 'text',
      title: '粘贴文本',
      position: defaultPosition(CANVAS_TEXT_NODE_DEFAULT_SIZE),
      z_index: 0,
      data: {
        current_version_id: versionId,
        generation_draft: null,
        active_run_id: null,
        display: { scale: 'sm' },
      },
    };
    pendingTextVersions.current.set(nodeId, versionId);
    commit(current => ({
      ...current,
      nodes: [...current.nodes, node],
      content_versions: { ...current.content_versions, [versionId]: version },
    }), true);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set());
    announceToolNotice('已从剪贴板创建文本节点');
  }

  useEffect(() => {
    function handleSelectAll(event: KeyboardEvent) {
      if ((!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== 'a') return;
      if (isCanvasShortcutBlockedTarget(event.target) || !document?.nodes.length) return;
      event.preventDefault();
      setSelectedConnectionIds(new Set());
      setSelectedNodeIds(new Set(document.nodes.map(node => node.id)));
      announceToolNotice(`已选择 ${document.nodes.length} 个节点`);
    }

    function handlePaste(event: ClipboardEvent) {
      if (isCanvasShortcutBlockedTarget(event.target)) return;
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const serialized = clipboard.getData(CANVAS_NODE_CLIPBOARD_TYPE);
      const internalPayload = nodeClipboard.current;
      // 同一标签页内复制过的用内存里的对象；别的画布（另一标签页 / 切换项目后）只剩系统剪贴板
      // 里的 JSON，解出来一样能用——媒体归属由服务端粘贴接口处理。
      const payload = internalPayload && serialized === JSON.stringify(internalPayload)
        ? internalPayload
        : parseCanvasClipboardPayload(serialized);
      if (payload) {
        event.preventDefault();
        if (payload.source?.kind === 'remote') {
          const { peerKey, projectId: sourceId } = payload.source;
          void applyServerInsertion(revision => copySharedNodes(peerKey, sourceId,
            payload.nodes.map(node => node.id), projectId, revision), { placement: 'group' });
        } else if (payload.source_project_id === projectId) pasteCanvasNodes(payload);
        else void pasteCanvasNodesFromOtherProject(payload);
        return;
      }
      const image = Array.from(clipboard.items)
        .find(item => item.kind === 'file' && item.type.startsWith('image/'))
        ?.getAsFile();
      if (image) {
        event.preventDefault();
        const flow = defaultPosition();
        handleUploads([image], { screen: { x: 0, y: 0 }, flow });
        return;
      }
      const text = clipboard.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      pastePlainText(text);
    }

    window.addEventListener('keydown', handleSelectAll);
    window.addEventListener('copy', copySelectedNodes);
    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('keydown', handleSelectAll);
      window.removeEventListener('copy', copySelectedNodes);
      window.removeEventListener('paste', handlePaste);
    };
  });

  const updateNode = useCallback((nodeId: string, updater: (node: CanvasNode) => CanvasNode) => {
    commit(current => {
      const next: CanvasDocument = {
        ...current,
        nodes: current.nodes.map(node => node.id === nodeId ? updater(node) : node),
      };
      return syncCanvasPromptReferences(next, canvasPromptSyncTargets(next, nodeId));
    });
  }, [commit]);

  const renameNode = useCallback((nodeId: string, title: string) => {
    commit(current => ({
      ...current,
      nodes: current.nodes.map(node => node.id === nodeId ? { ...node, title } : node),
    }), true);
  }, [commit]);

  const updateText = useCallback((nodeId: string, text: string) => {
    commit(current => {
      const node = current.nodes.find(candidate => candidate.id === nodeId);
      if (!node || node.type !== 'text') return current;
      let versionId = pendingTextVersions.current.get(nodeId);
      if (!versionId || !current.content_versions[versionId]) {
        versionId = makeId('version');
        pendingTextVersions.current.set(nodeId, versionId);
      }
      const existing = current.content_versions[versionId];
      const version: CanvasTextVersion = existing?.kind === 'text'
        ? { ...existing, text, sha256: CANVAS_LOCAL_VERSION_SHA }
        : {
            version_id: versionId,
            kind: 'text',
            text,
            created_at: new Date().toISOString(),
            sha256: CANVAS_LOCAL_VERSION_SHA,
            origin: { kind: 'user_edit' },
          };
      const next: CanvasDocument = {
        ...current,
        content_versions: { ...current.content_versions, [versionId]: version },
        nodes: current.nodes.map(candidate => candidate.id === nodeId && candidate.type === 'text'
          ? { ...candidate, data: { ...candidate.data, current_version_id: versionId } }
          : candidate),
      };
      return syncCanvasPromptReferences(next, canvasPromptSyncTargets(next, nodeId));
    });
  }, [commit]);

  const deleteNode = useCallback((nodeId: string) => {
    const blocked = canvasDeletionBlockedMessage(
      latestDocument.current?.nodes ?? [],
      new Set([nodeId]),
      jobsByRunId,
    );
    if (blocked) {
      setError(blocked);
      return;
    }
    commit(current => {
      const next = removeCanvasConnections(current, edge => (
        edge.source_node_id === nodeId || edge.target_node_id === nodeId
      ));
      return { ...next, nodes: next.nodes.filter(node => node.id !== nodeId) };
    }, true);
    setSelectedNodeIds(current => {
      if (!current.has(nodeId)) return current;
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
    requestAnimationFrame(() => editorRegionRef.current?.focus());
  }, [commit, jobsByRunId]);

  const reportError = useCallback((message: string) => setError(message), []);

  const annotationBridge = useMemo<AnnotationDocumentBridge>(() => ({
    projectId, current: () => latestDocument.current, revision: () => serverRevision.current,
    setRevision: revision => { serverRevision.current = revision; },
    apply: (next, record) => {
      flushSync(() => commit(() => next, record));
      latestDocument.current = next;
    },
    persist: persistNow,
    busy: () => documentCommandInFlight.current || runSubmissionInFlight.current,
    lock: locked => { documentCommandInFlight.current = locked; },
  }), [projectId, commit, persistNow]);
  // 出图成功后把这次的模型和参数（张数除外）写成生成偏好，下一个新建节点从这里开始。
  // 只是顺手记住，写不进去（偏好正在别处保存、版本冲突）就跳过，不打断出图。
  const latestCanvasUiPreferences = useRef(canvasUiPreferences);
  useEffect(() => { latestCanvasUiPreferences.current = canvasUiPreferences; }, [canvasUiPreferences]);
  const rememberGenerationDefault = useCallback((draft: CanvasGenerationDraft) => {
    const preferences = latestCanvasUiPreferences.current;
    const slot = canvasGenerationSlot(latestProviders.current, draft);
    const next = canvasGenerationDefaultFromDraft(draft, preferences.generation_defaults[slot], slot);
    if (!next || canvasUiPreferencesSaveInFlight.current) return;
    canvasUiPreferencesSaveInFlight.current = true;
    void saveCanvasUiPreferences(
      preferences.revision,
      preferences.image_toolbar,
      { ...preferences.generation_defaults, [slot]: next },
      preferences.upscale,
    )
      .then(saved => setCanvasUiPreferences(saved))
      // 版本冲突时重新读一次，下次出图就能接着记。
      .catch(() => getCanvasUiPreferences().then(setCanvasUiPreferences, () => undefined))
      .finally(() => { canvasUiPreferencesSaveInFlight.current = false; });
  }, []);

  /** 生成提交在前端排队（P1）：前一个提交落地后自动提交下一个，不再报「另一项生成正在提交」让人再点一次。
   *  排队中的节点按钮显示「排队中」。只串行「提交」这一步，提交之后的生成照常并行。
   *  排队项都是计费请求：「全部停止」、离开画布、卸载都把纪元加一，之前排进来的项轮到时一律不发；
   *  任务在真正调接口前还要再问一次 stillWanted（保存等待期间可能已经停止）。
   *  dedupeKey 相同的项在排队或提交中时不重复入队（同图同档的 AI高清连点）。 */
  const submissionChain = useRef<Promise<unknown>>(Promise.resolve());
  const pendingSubmissions = useRef(0);
  const pendingSubmissionKeys = useRef(new Set<string>());
  const [queuedNodeIds, setQueuedNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const queueSubmission = useCallback(<T,>(
    nodeId: string,
    task: (stillWanted: () => boolean) => Promise<T>,
    fallback: T,
    dedupeKey?: string,
  ): Promise<T> => {
    if (dedupeKey && pendingSubmissionKeys.current.has(dedupeKey)) return Promise.resolve(fallback);
    if (dedupeKey) pendingSubmissionKeys.current.add(dedupeKey);
    const epoch = submissionEpoch.current;
    const stillWanted = () => submissionEpoch.current === epoch
      && latestDocument.current?.project_id === projectIdRef.current;
    const mustWait = pendingSubmissions.current > 0 || runSubmissionInFlight.current;
    pendingSubmissions.current += 1;
    if (mustWait) setQueuedNodeIds(current => new Set(current).add(nodeId));
    const unqueue = () => setQueuedNodeIds(current => {
      if (!current.has(nodeId)) return current;
      const next = new Set(current);
      next.delete(nodeId);
      return next;
    });
    const run = submissionChain.current.catch(() => undefined).then(async () => {
      // 不走这条队列的提交（MJ 续查、媒体操作）还在途时也等它落地。
      while (runSubmissionInFlight.current && stillWanted()) {
        await new Promise(resolve => window.setTimeout(resolve, 100));
      }
      unqueue();
      if (!stillWanted()) return fallback;
      return task(stillWanted);
    }).finally(() => {
      pendingSubmissions.current -= 1;
      if (dedupeKey) pendingSubmissionKeys.current.delete(dedupeKey);
      unqueue();
    });
    submissionChain.current = run;
    return run;
  }, []);
  /** 撤销前端队列里还没发出的提交（已发出的由服务端 run 的停止处理）。 */
  const cancelQueuedSubmissions = useCallback(() => {
    submissionEpoch.current += 1;
    setQueuedNodeIds(current => (current.size ? new Set() : current));
  }, []);
  // 卸载（离开画布、切项目）后，旧闭包里排着的提交不能再发出去计费。
  useEffect(() => () => { submissionEpoch.current += 1; }, []);

  /** 返回这次提交的结果：submitted 已受理；not_sent / conflict 确定没有发出或被版本校验拒绝（可以再提交）；
   *  error 结果不明或被拒绝（不要自动再提交，可能已经在计费）。 */
  const submitRunNow = useCallback(async (nodeId: string, stillWanted: () => boolean): Promise<SubmitRunOutcome> => {
    if (runSubmissionInFlight.current) {
      setError('另一项生成正在提交，请稍后再试。');
      return { status: 'not_sent' };
    }
    setSubmittingNodeIds(current => new Set(current).add(nodeId));
    setError(null);
    try {
      if (!await persistNow()) return { status: 'not_sent' };
      await ensureAnnotatedInputs(annotationBridge, nodeId);
      const current = latestDocument.current;
      const node = current?.nodes.find(candidate => candidate.id === nodeId);
      const draft = node ? generationDraftForNode(node) : null;
      if (!current || !node || !draft) throw new Error('当前节点没有可提交的生成设置');
      // 音乐一次可出两首（服务端按模型上限校验）；语音的参数里没有 n，仍是一条。
      const requestedCount = draft.mode === 'text' || draft.mode === 'image'
        ? Math.max(1, Math.min(4, Number(draft.params.n ?? 1)))
        : draft.mode === 'audio'
          ? Math.max(1, Math.min(2, Number(draft.params.n ?? 1)))
          : 1;
      if (!stillWanted()) return { status: 'not_sent' };
      const dirtyAtSubmission = dirtyVersion.current;
      runSubmissionInFlight.current = true;
      const run = await submitCanvasRun(
        projectId,
        nodeId,
        serverRevision.current,
        requestedCount,
      );
      mergeSubmittedRunDocument(run.document, run.job, dirtyAtSubmission);
      applyLocalJob(run.job);
      rememberGenerationDefault(draft);
      const resultId = run.job.canvas_run?.result_node_id;
      if (resultId) setSelectedNodeIds(new Set([resultId]));
      return { status: 'submitted', resultNodeId: resultId };
    } catch (submitError) {
      setError((submitError as Error).message);
      return { status: submitError instanceof ApiError && submitError.status === 409 ? 'conflict' : 'error' };
    } finally {
      runSubmissionInFlight.current = false;
      if (saveQueued.current) void flushSave().catch(() => undefined);
      setSubmittingNodeIds(current => {
        const next = new Set(current);
        next.delete(nodeId);
        return next;
      });
    }
  }, [annotationBridge, 
    applyLocalJob,
    flushSave,
    mergeSubmittedRunDocument,
    persistNow,
    projectId,
    rememberGenerationDefault,
  ]);
  const submitRun = useCallback((nodeId: string): Promise<SubmitRunOutcome> => queueSubmission(nodeId, stillWanted => submitRunNow(nodeId, stillWanted), { status: 'not_sent' } as SubmitRunOutcome), [queueSubmission, submitRunNow]);

  const reversePromptNow = useCallback(async (node: CanvasContentNode, stillWanted: () => boolean) => {
    if (node.type !== 'image' || !node.data.current_version_id) {
      setError('请选择一个已有内容的图片节点再反推提示词。');
      return;
    }
    if (runSubmissionInFlight.current) {
      setError('另一项生成正在提交，请稍后再试。');
      return;
    }
    setSubmittingNodeIds(current => new Set(current).add(node.id));
    setError(null);
    try {
      if (!await persistNow() || !stillWanted()) return;
      const dirtyAtSubmission = dirtyVersion.current;
      runSubmissionInFlight.current = true;
      const run = await submitCanvasReversePrompt(
        projectId,
        node.id,
        serverRevision.current,
      );
      if (run.job.canvas_run) reversePromptConfigEligibleRuns.current.add(run.job.canvas_run.run_id);
      mergeSubmittedRunDocument(run.document, run.job, dirtyAtSubmission);
      applyLocalJob(run.job);
      const resultId = run.job.canvas_run?.result_node_id;
      if (resultId) setSelectedNodeIds(new Set([resultId]));
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      runSubmissionInFlight.current = false;
      if (saveQueued.current) void flushSave().catch(() => undefined);
      setSubmittingNodeIds(current => {
        const next = new Set(current);
        next.delete(node.id);
        return next;
      });
    }
  }, [
    applyLocalJob,
    flushSave,
    mergeSubmittedRunDocument,
    persistNow,
    projectId,
  ]);
  const reversePrompt = useCallback((node: CanvasContentNode): Promise<void> => queueSubmission(node.id, stillWanted => reversePromptNow(node, stillWanted), undefined), [queueSubmission, reversePromptNow]);

  const submitTextRevisionNow = useCallback(async (
    nodeId: string,
    request: CanvasTextRevisionInput,
    stillWanted: () => boolean,
  ) => {
    if (runSubmissionInFlight.current) {
      setError('另一项生成正在提交，请稍后再试。');
      return;
    }
    setSubmittingNodeIds(current => new Set(current).add(nodeId));
    setError(null);
    try {
      if (!await persistNow() || !stillWanted()) return;
      const node = latestDocument.current?.nodes.find(candidate => candidate.id === nodeId);
      const version = node?.type === 'text' && node.data.current_version_id
        ? latestDocument.current?.content_versions[node.data.current_version_id]
        : undefined;
      if (version?.kind !== 'text' || !version.text.trim()) {
        setError('请选择一个已有正文的文本节点再改写。');
        return;
      }
      const dirtyAtSubmission = dirtyVersion.current;
      runSubmissionInFlight.current = true;
      const run = await submitCanvasTextRevision(projectId, nodeId, serverRevision.current, {
        instruction: request.instruction,
        selection: request.selection ? codePointRange(version.text, request.selection) : null,
        alias: request.alias,
        model: request.model,
      });
      mergeSubmittedRunDocument(run.document, run.job, dirtyAtSubmission);
      applyLocalJob(run.job);
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      runSubmissionInFlight.current = false;
      if (saveQueued.current) void flushSave().catch(() => undefined);
      setSubmittingNodeIds(current => {
        const next = new Set(current);
        next.delete(nodeId);
        return next;
      });
    }
  }, [
    applyLocalJob,
    flushSave,
    mergeSubmittedRunDocument,
    persistNow,
    projectId,
  ]);
  const submitTextRevision = useCallback((nodeId: string, request: CanvasTextRevisionInput): Promise<void> => queueSubmission(nodeId, stillWanted => submitTextRevisionNow(nodeId, request, stillWanted), undefined), [queueSubmission, submitTextRevisionNow]);

  const createLayerDecomposition = useCallback((sourceNode: Extract<CanvasContentNode, { type: 'image' }>) => {
    const current = latestDocument.current;
    const source = current?.nodes.find(node => node.id === sourceNode.id);
    if (!current || source?.type !== 'image' || !source.data.current_version_id) {
      setError('请选择一个已有内容的图片节点再拆分图层。');
      return;
    }
    const sourceVersion = current.content_versions[source.data.current_version_id];
    if (sourceVersion?.kind !== 'image') {
      setError('图片节点当前没有可读取的项目内版本。');
      return;
    }
    const sourceSize = canvasNodeRenderedSize(source, current.content_versions);
    const choice = layerDecompositionModelChoices(keys)[0];
    const stack = newLayerStackNode(
      current,
      source,
      sourceVersion,
      { x: source.position.x + sourceSize.width + 72, y: source.position.y },
      { alias: choice?.key.alias ?? null, model: choice?.model.id ?? null, prompt: '', resolution: 'auto' },
    );
    setError(null);
    commit(document => withLayerStackFromSource(document, stack, source.id), true);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([stack.id]));
  }, [commit, keys]);

  const submitLayerDecompositionNow = useCallback(async (nodeId: string, stillWanted: () => boolean) => {
    const node = latestDocument.current?.nodes.find(candidate => candidate.id === nodeId);
    if (node?.type !== 'layer_stack' || node.data.base_version_id) {
      setError('这个拆分图层节点已不可提交。');
      return;
    }
    if (!node.data.alias || !node.data.model) {
      setError('请先选择图层拆分模型。');
      return;
    }
    if (runSubmissionInFlight.current) {
      setError('另一项生成正在提交，请稍后再试。');
      return;
    }
    setSubmittingNodeIds(current => new Set(current).add(nodeId));
    setError(null);
    try {
      if (!await persistNow() || !stillWanted()) return;
      const dirtyAtSubmission = dirtyVersion.current;
      runSubmissionInFlight.current = true;
      const run = await submitCanvasLayerDecomposition(
        projectId,
        nodeId,
        serverRevision.current,
        { alias: node.data.alias, model: node.data.model },
      );
      mergeSubmittedRunDocument(run.document, run.job, dirtyAtSubmission);
      applyLocalJob(run.job);
      const resultId = run.job.canvas_run?.result_node_id;
      if (resultId) setSelectedNodeIds(new Set([resultId]));
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      runSubmissionInFlight.current = false;
      if (saveQueued.current) void flushSave().catch(() => undefined);
      setSubmittingNodeIds(current => {
        const next = new Set(current);
        next.delete(nodeId);
        return next;
      });
    }
  }, [
    applyLocalJob,
    flushSave,
    mergeSubmittedRunDocument,
    persistNow,
    projectId,
  ]);
  const submitLayerDecomposition = useCallback((nodeId: string): Promise<void> => queueSubmission(nodeId, stillWanted => submitLayerDecompositionNow(nodeId, stillWanted), undefined), [queueSubmission, submitLayerDecompositionNow]);

  // 已完成的拆分节点不能再提交：改提示词重拆 = 从同一张来源图新建一个拆分节点放在下方并立即提交。
  const rerunLayerDecomposition = useCallback(async (
    stackId: string,
    settings: { alias: string; model: string; prompt: string; max_images?: number | null },
  ) => {
    const current = latestDocument.current;
    const previous = current?.nodes.find(node => node.id === stackId);
    if (!current || previous?.type !== 'layer_stack') return;
    const edge = current.connections.find(connection => (
      connection.role === 'input' && connection.target_node_id === stackId
    ));
    const source = current.nodes.find(node => node.id === edge?.source_node_id);
    const sourceVersion = source?.type === 'image' && source.data.current_version_id
      ? current.content_versions[source.data.current_version_id]
      : undefined;
    if (source?.type !== 'image' || sourceVersion?.kind !== 'image') {
      setError('拆分节点与来源图片的连接已断开。');
      return;
    }
    const previousSize = canvasNodeRenderedSize(previous, current.content_versions);
    const stack = newLayerStackNode(
      current,
      source,
      sourceVersion,
      { x: previous.position.x, y: previous.position.y + previousSize.height + 72 },
      { max_images: previous.data.max_images ?? null, ...settings, resolution: previous.data.resolution },
    );
    history.current.past.push(current);
    history.current.past = history.current.past.slice(-50);
    history.current.future = [];
    const next = normalizeCommittedDocument(withLayerStackFromSource(current, stack, source.id), current);
    latestDocument.current = next;
    setDocument(next);
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
    setError(null);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([stack.id]));
    await submitLayerDecomposition(stack.id);
  }, [submitLayerDecomposition]);

  const cancelRun = useCallback(async (runId: string) => {
    setError(null);
    try {
      const updated = await cancelCanvasRun(projectId, runId);
      applyLocalJob(updated);
    } catch (cancelError) {
      setError((cancelError as Error).message);
    }
  }, [applyLocalJob, projectId]);
  cancelRunRef.current = cancelRun;

  const resumeMjEdit = useCallback(async (runId: string) => {
    if (runSubmissionInFlight.current) return;
    let claimed = false;
    setError(null);
    try {
      if (!await persistNow()) return;
      if (runSubmissionInFlight.current || latestDocument.current?.project_id !== projectId) return;
      runSubmissionInFlight.current = true;
      claimed = true;
      const dirty = dirtyVersion.current;
      const result = await resumeCanvasMjEdit(projectId, runId, serverRevision.current);
      if (latestDocument.current?.project_id !== projectId) return;
      mergeSubmittedRunDocument(result.document, result.job, dirty);
      applyLocalJob(result.job);
    } catch (resumeError) {
      if (latestDocument.current?.project_id === projectId) setError((resumeError as Error).message);
    } finally {
      if (claimed) {
        runSubmissionInFlight.current = false;
        if (saveQueued.current) void flushSave().catch(() => undefined);
      }
    }
  }, [projectId, persistNow, mergeSubmittedRunDocument, applyLocalJob, flushSave]);

  const dismissCandidate = useCallback(async (runId: string, candidateId: string) => {
    setError(null);
    try {
      if (!await persistNow()) return;
      const result = await dismissCanvasCandidate(
        projectId,
        runId,
        candidateId,
        serverRevision.current,
      );
      if (latestDocument.current?.project_id !== projectId) return;
      applyLocalJob(result.job);
    } catch (dismissError) {
      if (latestDocument.current?.project_id !== projectId) return;
      setError((dismissError as Error).message);
    }
  }, [applyLocalJob, persistNow, projectId]);

  const recordHistorySnapshot = useCallback(() => {
    const snapshot = latestDocument.current;
    if (!snapshot || history.current.past.at(-1) === snapshot) return;
    history.current.past.push(snapshot);
    history.current.past = history.current.past.slice(-50);
    history.current.future = [];
  }, []);

  // 镜头不进撤销栈。以前这里每次平移 / 缩放都 push 一条历史，于是 Ctrl+Z 撤的是取景而不是编辑，
  // 平移次数够多时真正想撤的那次修改已经被 50 条上限挤出去了。视口仍然会落盘（它属于文档），
  // 只是不再是一个可撤销的动作。
  /** 显示类设置（画布背景、显示图片信息）和视口一样不进撤销栈：⌘Z 应该撤掉刚做的编辑，而不是先撤掉背景。 */
  const commitDisplaySetting = useCallback((settings: Partial<CanvasDocument['settings']>) => {
    const current = latestDocument.current;
    if (!current) return;
    // 改设置也是编辑过（D12）：不进撤销栈，但新建项目从此不再自动清理。
    settleFreshCanvasProject(projectIdRef.current);
    const next = { ...current, settings: { ...current.settings, ...settings }, updated_at: new Date().toISOString() };
    latestDocument.current = next;
    setDocument(next);
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
  }, []);

  const commitViewportDocument = useCallback((viewport: Viewport) => {
    const current = latestDocument.current;
    if (!current || current.project_id !== projectId || sameViewport(current.viewport, viewport)) return false;
    const next = { ...current, viewport, updated_at: new Date().toISOString() };
    latestDocument.current = next;
    setDocument(next);
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
    return true;
  }, [projectId]);

  const interruptViewportCommand = useCallback(() => {
    viewportCommandEpoch.current += 1;
    cancelViewportCommand.current?.();
    cancelViewportCommand.current = null;
    pendingViewportCommand.current = null;
  }, []);

  const runViewportCommand = useCallback((command: () => Promise<boolean>) => {
    const previous = pendingViewportCommand.current;
    const epoch = viewportCommandEpoch.current;
    const operation = (async () => {
      if (previous) await previous;
      if (viewportCommandEpoch.current !== epoch || latestDocument.current?.project_id !== projectId) return;
      let cancel!: () => void;
      let timeoutId: number | null = null;
      const cancelled = new Promise<'cancelled'>(resolve => {
        cancel = () => resolve('cancelled');
      });
      cancelViewportCommand.current = cancel;
      const result = await Promise.race([
        Promise.resolve().then(command).then(() => 'finished' as const),
        cancelled,
        new Promise<'timeout'>(resolve => {
          timeoutId = window.setTimeout(() => resolve('timeout'), 300);
        }),
      ]).catch(commandError => {
        setError((commandError as Error).message);
        return 'cancelled' as const;
      });
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (cancelViewportCommand.current === cancel) cancelViewportCommand.current = null;
      if (result === 'cancelled'
        || viewportCommandEpoch.current !== epoch
        || latestDocument.current?.project_id !== projectId) return;
      const viewport = getViewport();
      viewportSync.current = { projectId, viewport };
      if (!commitViewportDocument(viewport)) viewportSync.current = null;
    })();
    pendingViewportCommand.current = operation;
    const clearPending = () => {
      if (pendingViewportCommand.current === operation) pendingViewportCommand.current = null;
    };
    void operation.then(clearPending, clearPending);
    return operation;
  }, [commitViewportDocument, getViewport, projectId]);

  const disableMagnetism = connectionInProgress || !!createMenu || selectedNodeIds.size > 1;
  useLayoutEffect(() => {
    const region = editorRegionRef.current;
    if (!loading && documentLoaded && region && !disableMagnetism) return bindCanvasMagneticHandles(region, selectedId);
  }, [loading, documentLoaded, disableMagnetism, selectedId]);

  // 菜单、新节点和连线共享同一个画布点。边缘空间不够时只平移视口，始终保留松手的画布坐标。
  useLayoutEffect(() => {
    const menu = createMenuRef.current;
    if (!menu || !createMenu) return;
    const screen = createMenu.screen;
    const width = menu.offsetWidth, height = menu.offsetHeight;
    const left = screen.x - (createMenu.sourceHandle === 'target' ? width : 0);
    const top = screen.y - height / 2;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.translate = 'none';
    menu.style.visibility = 'visible';
    const [tx, ty, zoom] = flowStore.getState().transform;
    const unsubscribe = flowStore.subscribe((state, previous) => {
      if (state.transform === previous.transform) return;
      const [x, y, z] = state.transform;
      const dx = x - tx + createMenu.flow.x * (z - zoom);
      const dy = y - ty + createMenu.flow.y * (z - zoom);
      menu.style.translate = `${dx}px ${dy}px`;
    });
    const dx = Math.max(12 - left, Math.min(0, window.innerWidth - 12 - left - width));
    const dy = Math.max(12 - top, Math.min(0, window.innerHeight - 12 - top - height));
    if (dx || dy) void runViewportCommand(() => setViewport({ x: tx + dx, y: ty + dy, zoom },
      { duration: viewportMotionMs(MOTION_DURATION.fast) }));
    return unsubscribe;
  }, [createMenu, flowStore, runViewportCommand, setViewport]);


  const expandLayerStack = useCallback((nodeId: string) => {
    const current = latestDocument.current;
    if (!current) return;
    try {
      const expanded = expandCanvasLayerStack(current, nodeId, makeId);
      const replaced = new Set(expanded.nodes.map(node => node.id));
      if (expanded.nodes.length) commit(document => ({ ...document,
        nodes: [...document.nodes.filter(node => !replaced.has(node.id)).flatMap<CanvasNode>(node => {
          if (node.id === expanded.stack.id) return [expanded.stack];
          if (node.type !== 'group') return [node];
          const members = node.data.member_node_ids.filter(id => !replaced.has(id));
          return members.length || !node.data.member_node_ids.length
            ? [{ ...node, data: { ...node.data, member_node_ids: members } }] : [];
        }), ...expanded.nodes],
      }), true);
      setSelectedConnectionIds(new Set());
      setSelectedNodeIds(new Set([expanded.groupId]));
      setError(null);
      const group = [...expanded.nodes, ...current.nodes].find(node => node.id === expanded.groupId);
      if (group?.size) {
        const bounds = { ...group.position, ...group.size };
        void runViewportCommand(() => fitBounds(bounds, { duration: viewportMotionMs(MOTION_DURATION.fast), padding: 0.14 }));
      }
    } catch (error) {
      setError((error as Error).message);
    }
  }, [commit, fitBounds, runViewportCommand]);

  /** 撤销 / 重做之后点出变化在哪（Q7）：视口里的受影响节点闪一圈描边；一处都看不到时边缘给胶囊。 */
  const announceHistoryChange = useCallback((action: '撤销' | '重做', before: CanvasDocument, after: CanvasDocument) => {
    const bounds = editorRegionRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    const { x, y, zoom } = getViewport();
    const visible = { x: -x / zoom, y: -y / zoom, width: bounds.width / zoom, height: bounds.height / zoom };
    const affected = canvasHistoryAffectedNodes(before, after);
    flashCanvasNodes(affected.presentIds.filter(id => canvasRectsIntersect(affected.presentRects.get(id)!, visible)));
    if (historyHintTimer.current !== null) window.clearTimeout(historyHintTimer.current);
    const hint = canvasHistoryHint(action, affected.rects, visible);
    setHistoryHint(hint ? { ...hint, key: Date.now() } : null);
    historyHintTimer.current = hint ? window.setTimeout(() => {
      historyHintTimer.current = null;
      setHistoryHint(null);
    }, CANVAS_HISTORY_HINT_MS) : null;
  }, [getViewport]);
  useEffect(() => () => {
    if (historyHintTimer.current !== null) window.clearTimeout(historyHintTimer.current);
  }, []);

  /** 撤销到撤销栈里的某一步（不传 = 上一步）。Agent 一轮的「撤销本轮」传那一轮之前的快照：
   *  之后用户又做过的编辑一并退回，重做一次即可回到撤销前。 */
  const undoTo = useCallback((target?: CanvasDocument) => {
    const past = history.current.past;
    const index = target ? past.lastIndexOf(target) : past.length - 1;
    if (index < 0 || !document) return;
    const previous = past[index];
    if (blockedHistory.current.has(previous)) {
      history.current.past.splice(index,1); notify.info('该节点已被他人修改，无法撤回'); return;
    }
    if (document.nodes.some(node => node.type === 'image_edit' && node.data.active_run_id
      && !previous.nodes.some(item => item.id === node.id))) {
      setError('请先停止编辑节点的生成，再撤销创建。'); return;
    }
    history.current.past = past.slice(0, index);
    history.current.future.push(document);
    const restored = syncDraftLayerStackSources({
      ...restoreImageEditRunState(previous, document, jobsByRunId),
      revision: document.revision,
      updated_at: new Date().toISOString(),
      // 镜头既不进撤销栈也不被撤销还原：撤销时把用户当前的取景留住，不要把画布甩回快照拍下时
      // 的位置——那次跳动本身比看不见变化更让人失去方向。
      viewport: document.viewport,
      content_versions: restoreContentVersions(
        previous.content_versions,
        document.content_versions,
      ),
    });
    setDocument(restored);
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
    announceHistoryChange('撤销', document, restored);
  }, [announceHistoryChange, document, jobsByRunId]);
  undoToRef.current = undoTo;
  const undo = useCallback(() => undoTo(), [undoTo]);
  // 菜单里的撤销 / 重做按栈是否为空置灰；栈是 ref，跟着文档变化重算即可。
  const canUndo = Boolean(document) && history.current.past.length > 0;
  const canRedo = Boolean(document) && history.current.future.length > 0;

  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next || !document) return;
    if (blockedHistory.current.has(next)) {notify.info('该节点已被他人修改，无法重做');return;}
    history.current.past.push(document);
    const restored = syncDraftLayerStackSources({
      ...restoreImageEditRunState(next, document, jobsByRunId),
      revision: document.revision,
      updated_at: new Date().toISOString(),
      viewport: document.viewport,
      content_versions: restoreContentVersions(
        next.content_versions,
        document.content_versions,
      ),
    });
    setDocument(restored);
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
    announceHistoryChange('重做', document, restored);
  }, [announceHistoryChange, document, jobsByRunId]);

  const groupSelectionRef = useRef(groupSelection);
  groupSelectionRef.current = groupSelection;
  useEffect(() => {
    function handleGroupShortcut(event: KeyboardEvent) {
      if ((!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'g') return;
      if (isCanvasShortcutBlockedTarget(event.target)) return;
      // 不管选了几个都拦掉浏览器的「查找下一个」，画布里 ⌘G 只有打组一个含义。
      event.preventDefault();
      if (latestSelectedNodeIds.current.size < 2) return;
      // 快捷键没有点击来源：对应的「分组」按钮按一下给个回执（Q15），也确认没被输入法吞掉。
      flashShortcutButton(editorRegionRef.current?.querySelector('[data-canvas-shortcut="group"]'));
      groupSelectionRef.current();
    }
    window.addEventListener('keydown', handleGroupShortcut);
    return () => window.removeEventListener('keydown', handleGroupShortcut);
  }, []);

  useEffect(() => {
    function handleHistoryShortcut(event: KeyboardEvent) {
      if (!event.metaKey && !event.ctrlKey) return;
      const key = event.key.toLowerCase();
      const shouldUndo = key === 'z' && !event.shiftKey;
      const shouldRedo = key === 'y' || (key === 'z' && event.shiftKey);
      if (!shouldUndo && !shouldRedo) return;
      if (isCanvasShortcutBlockedTarget(event.target)) return;
      event.preventDefault();
      if (shouldRedo) redo();
      else undo();
    }
    window.addEventListener('keydown', handleHistoryShortcut);
    return () => window.removeEventListener('keydown', handleHistoryShortcut);
  }, [redo, undo]);

  const selectOnlyNode = useCallback((id: string) => {
    if (materialPick) {
      if (!materialPick.selectableNodeIds.has(id)) return;
      if (materialPick.slot) {
        const currentFrames = latestDocument.current?.connections.reduce<
          Record<CanvasVideoFrameSlot, string | null>
        >((frames, connection) => {
          if (
            connection.role === 'input'
            && connection.target_node_id === materialPick.targetNodeId
            && isCanvasVideoFrameSlot(connection.slot)
          ) frames[connection.slot] = connection.source_node_id;
          return frames;
        }, { first_frame: null, last_frame: null }) ?? {
          first_frame: null,
          last_frame: null,
        };
        setVideoFrameConnections(materialPick.targetNodeId, {
          ...currentFrames,
          [materialPick.slot]: id,
        });
      } else {
        setMaterialConnected(id, materialPick.targetNodeId, true);
      }
      setMaterialPick(null);
      return;
    }
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([id]));
    setDismissedGenerationPanelNodeId(current => generationPanelDismissalAfterNodeSelection(current, id));
  }, [materialPick, setMaterialConnected, setVideoFrameConnections]);

  const dismissGenerationPanel = useCallback((id: string) => {
    setDismissedGenerationPanelNodeId(id);
    restoreCanvasNodeFocus(id);
  }, []);

  const selectCandidate = useCallback((nodeId: string, versionId: string) => {
    recordHistorySnapshot();
    updateNode(nodeId, current => {
      if (!isContentNode(current)) return current;
      return {
        ...current,
        data: { ...current.data, current_version_id: versionId },
      } as CanvasContentNode;
    });
  }, [recordHistorySnapshot, updateNode]);

  const jobsByResultNodeId = useMemo(() => {
    const grouped = new Map<string, Job[]>();
    for (const job of jobs) {
      const resultNodeId = job.canvas_run?.result_node_id;
      if (!resultNodeId) continue;
      const runHistory = grouped.get(resultNodeId) ?? [];
      runHistory.push(job);
      grouped.set(resultNodeId, runHistory);
    }
    for (const runHistory of grouped.values()) {
      runHistory.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
    }
    return grouped;
  }, [jobs]);

  const jobsByResultNodeIdRef = useRef(jobsByResultNodeId);
  jobsByResultNodeIdRef.current = jobsByResultNodeId;
  const expandedResultStackIdsRef = useRef(expandedResultStackIds);
  expandedResultStackIdsRef.current = expandedResultStackIds;

  // 结果组展开 / 收起的成员动效。展开：记下这一批成员的起点，成员节点挂载时各取一次（平移回视口的
  // 重新挂载取不到，不播）。收起：先在成员内层外壳上播 150ms 收回，播完再把成员设成 hidden。
  const resultStackEntrances = useRef(new Map<string, CanvasStackMemberMotion>());
  const resultStackCollapses = useRef(new Map<string, { controls: AnimationPlaybackControls[]; shells: Element[] }>());
  /** 刚点了展开、等提交后登记入场的封面。 */
  const resultStackEntranceQueue = useRef(new Set<string>());
  const resultStackEntriesRef = useRef(resultStackEntries);
  resultStackEntriesRef.current = resultStackEntries;
  const consumeResultStackEntrance = useCallback((memberId: string) => {
    const entrance = resultStackEntrances.current.get(memberId) ?? null;
    resultStackEntrances.current.delete(memberId);
    return entrance;
  }, []);
  const resultStackMemberMotions = useCallback((coverId: string) => {
    const nodes = latestDocument.current?.nodes ?? [];
    const cover = nodes.find(node => node.id === coverId);
    if (!cover) return [];
    return resultStackEntriesRef.current
      .filter(([, owner]) => owner === coverId)
      .flatMap(([memberId]) => {
        const member = nodes.find(node => node.id === memberId);
        return member ? [member] : [];
      })
      .sort((a, b) => Math.hypot(a.position.x - cover.position.x, a.position.y - cover.position.y)
        - Math.hypot(b.position.x - cover.position.x, b.position.y - cover.position.y))
      .map((member, index) => ({ memberId: member.id, motion: canvasStackMemberMotion(cover.position, member.position, index) }));
  }, []);

  /** 展开 / 收起结果组。最近一次生成还没拆成节点时（旧数据、或生成结束时页面不在），展开时先拆。 */
  const toggleResultStack = useCallback((coverId: string) => {
    const cover = latestDocument.current?.nodes.find(node => node.id === coverId);
    if (!cover) return;
    // 收回途中又点了一次：停在当前位置，按展开处理（成员本来就还挂着）。
    const collapsing = resultStackCollapses.current.get(coverId);
    if (collapsing) {
      resultStackCollapses.current.delete(coverId);
      collapsing.controls.forEach(control => control.stop());
      clearStackMemberMotion(collapsing.shells);
      return;
    }
    const opening = !expandedResultStackIdsRef.current.has(coverId);
    const collapse = () => setExpandedResultStackIds(current => {
      const next = new Set(current);
      next.delete(coverId);
      return next;
    });
    if (opening) {
      const pending = pendingResultStack(cover, jobsByResultNodeIdRef.current.get(coverId));
      if (pending) commit(current => settleResultStack(current, coverId, pending, () => makeId('image')), true);
      // 现场拆出的成员要等新文档提交后才存在：入场起点在提交后的 layout effect 里按同一份文档算。
      resultStackEntranceQueue.current.add(coverId);
      setExpandedResultStackIds(current => new Set(current).add(coverId));
      return;
    }
    const members = resultStackMemberMotions(coverId).flatMap(({ memberId, motion }) => {
      const shell = editorRegionRef.current?.querySelector(`.react-flow__node[data-id="${CSS.escape(memberId)}"] .canvas-node-shell`);
      return shell ? [{ shell, motion }] : [];
    });
    const shells = members.map(member => member.shell);
    const controls = playStackMemberExit(shells, members.map(member => member.motion));
    if (!controls) {
      collapse();
      return;
    }
    resultStackCollapses.current.set(coverId, { controls, shells });
    void Promise.all(controls.map(control => control.finished)).then(() => {
      if (resultStackCollapses.current.get(coverId)?.controls !== controls) return;
      resultStackCollapses.current.delete(coverId);
      collapse();
      // 成员此时已卸载；万一还挂着（比如正在重新生成），别把透明态留在外壳上。
      window.requestAnimationFrame(() => clearStackMemberMotion(shells));
    });
  }, [commit, resultStackMemberMotions]);

  // 展开后的这次提交里登记成员入场：成员节点挂载（xyflow 在之后的 effect 里同步节点）时各取一次。
  useLayoutEffect(() => {
    const queue = resultStackEntranceQueue.current;
    if (!queue.size) return;
    for (const coverId of queue) {
      for (const { memberId, motion } of resultStackMemberMotions(coverId)) resultStackEntrances.current.set(memberId, motion);
    }
    queue.clear();
    // 没挂载上的成员（在视口外）不留着入场参数，免得之后平移过去才补播。
    window.setTimeout(() => resultStackEntrances.current.clear(), MOTION_DURATION.slow * 1000);
  }, [document, expandedResultStackIds, resultStackMemberMotions]);

  const setResultStackCover = useCallback((coverId: string, memberId: string) => {
    commit(current => swapResultStackCover(current, coverId, memberId), true);
    setSelectedNodeIds(new Set([coverId]));
  }, [commit]);

  // 生成在页面上结束时，把这一批的其余结果拆成结果组成员（替换上一批）。只认这次会话里
  // 亲眼看到从「生成中」变成结束的那次：打开画布时早已结束的旧数据留到点「展开」再拆。
  const runsSeenPending = useRef(new Set<string>());
  useEffect(() => {
    const current = latestDocument.current;
    if (!current) return;
    const settled: Array<{ coverId: string; pending: NonNullable<ReturnType<typeof pendingResultStack>> }> = [];
    for (const node of current.nodes) {
      const runHistory = jobsByResultNodeId.get(node.id);
      const latest = runHistory?.[runHistory.length - 1];
      const runId = latest?.canvas_run?.run_id;
      if (!latest || !runId) continue;
      if (latest.status === 'pending' || latest.status === 'pending_confirm') {
        runsSeenPending.current.add(runId);
        continue;
      }
      if (!runsSeenPending.current.has(runId)) continue;
      const pending = pendingResultStack(node, runHistory);
      const hasMembers = node.type === 'image' && Boolean(node.data.result_stack?.member_node_ids.length);
      if (pending && (pending.versionIds.length || hasMembers)) settled.push({ coverId: node.id, pending });
      runsSeenPending.current.delete(runId);
    }
    if (!settled.length) return;
    // 和服务端合并结果一样，不进撤销历史、也不清掉重做。
    setDocument(document => document ? normalizeCommittedDocument(settled.reduce(
      (next, { coverId, pending }) => settleResultStack(next, coverId, pending, () => makeId('image')),
      document,
    ), document) : document);
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
  }, [jobsByResultNodeId]);

  const reversePromptConfiguredNodeIds = useMemo(() => {
    const configured = new Set<string>();
    const document = mentionDocumentRef.current;
    if (!document) return configured;
    const configIds = new Set(
      document.nodes.filter(node => node.type === 'image').map(node => node.id),
    );
    for (const connection of document.connections) {
      if (
        connection.role === 'input'
        && connection.target_node_id === reversePromptConfigNodeId(connection.source_node_id)
        && configIds.has(connection.target_node_id)
      ) {
        configured.add(connection.source_node_id);
      }
    }
    return configured;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上方图签名说明
  }, [mentionGraphSignature]);
  const previewContent = useCallback((versionId: string, title: string, nodeId: string) => {
    const version = latestDocument.current?.content_versions[versionId];
    if (version) {
      const shell = editorRegionRef.current?.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
      setPreview({ nodeId, title, version, sourceRect: shell?.getBoundingClientRect() ?? null });
    }
  }, []);

  const previewLayerStack = useCallback((nodeId: string) => setLayerPreviewId(nodeId), []);

  /** 多条提示用换行分隔，逐行显示。 */
  const announceToolNotice = useCallback((message: string, action: CanvasNoticeAction | null = null) => {
    setToolNotice(message);
    setToolNoticeAction(action);
    if (toolNoticeTimer.current !== null) window.clearTimeout(toolNoticeTimer.current);
    toolNoticeTimer.current = window.setTimeout(() => {
      setToolNotice(null);
      setToolNoticeAction(null);
      toolNoticeTimer.current = null;
    }, action || message.includes('\n') ? TOOL_NOTICE_LONG_MS : TOOL_NOTICE_MS);
  }, []);

  const copyPrompt = useCallback(async (node: CanvasContentNode) => {
    const prompt = copyablePromptForNode(
      node,
      jobsByResultNodeId,
    );
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      announceToolNotice(`已复制“${node.title}”的生成提示词`);
    } catch {
      setError('无法写入剪贴板，请检查浏览器权限后重试。');
    }
  }, [announceToolNotice, jobsByResultNodeId]);

  const recoverReversePromptConfig = useCallback(async (job: Job) => {
    const context = job.canvas_run;
    if (!context || !isReversePromptJob(job)) return;
    if (documentCommandInFlight.current || runSubmissionInFlight.current) return;
    reversePromptConfigAttempts.current.add(context.run_id);
    setSubmittingNodeIds(current => new Set(current).add(context.result_node_id));
    setError(null);
    try {
      if (!await persistNow()) return;
      const before = latestDocument.current;
      if (!before) return;
      const dirtyAtCommand = dirtyVersion.current;
      documentCommandInFlight.current = true;
      const remote = await createCanvasReversePromptConfig(
        projectId,
        context.run_id,
        serverRevision.current,
      );
      const concurrent = latestDocument.current ?? remote;
      const configId = reversePromptConfigNodeId(context.result_node_id);
      const remoteConfig = remote.nodes.find(node => node.id === configId);
      if (!remoteConfig || remoteConfig.type !== 'image') {
        throw new Error('服务端没有返回反推后的图片节点。');
      }
      const hadConfig = concurrent.nodes.some(node => node.id === configId);
      const connectionIds = new Set(concurrent.connections.map(connection => connection.id));
      const createdConnections = remote.connections.filter(connection => (
        connection.role === 'input'
        && connection.source_node_id === context.result_node_id
        && connection.target_node_id === configId
        && !connectionIds.has(connection.id)
      ));
      const authoritativeRevision = Math.max(serverRevision.current, remote.revision);
      const merged: CanvasDocument = {
        ...concurrent,
        revision: authoritativeRevision,
        updated_at: remote.revision >= serverRevision.current ? remote.updated_at : concurrent.updated_at,
        nodes: hadConfig ? concurrent.nodes : [...concurrent.nodes, remoteConfig],
        connections: [...concurrent.connections, ...createdConnections],
        content_versions: acceptServerContentVersions(
          concurrent.content_versions,
          remote.content_versions,
        ),
      };
      if (!hadConfig) {
        history.current.past.push(concurrent);
        history.current.past = history.current.past.slice(-50);
        history.current.future = [];
      }
      serverRevision.current = authoritativeRevision;
      latestDocument.current = merged;
      if (dirtyVersion.current > dirtyAtCommand) {
        saveQueued.current = merged;
        setSaveState('saving');
      } else {
        saveQueued.current = null;
        setSaveState('saved');
      }
      flowNodeCache.current.clear();
      setDocument(merged);
      // 这是后台自动动作，不是用户点出来的：只有当选择还停在反推结果节点上（提交时留下的那个
      // 选中态）才把焦点挪到新图片节点。用户已经去点别的东西了就别抢。
      const selection = latestSelectedNodeIds.current;
      if (selection.size === 1 && selection.has(context.result_node_id)) {
        setSelectedConnectionIds(new Set());
        setSelectedNodeIds(new Set([configId]));
      }
      announceToolNotice('已用反推文本创建图片节点');
    } catch (configError) {
      setError((configError as Error).message);
    } finally {
      documentCommandInFlight.current = false;
      setSubmittingNodeIds(current => {
        const next = new Set(current);
        next.delete(context.result_node_id);
        return next;
      });
      if (saveQueued.current) void flushSave().catch(() => {
        setError('图片配置已创建，但并发编辑尚未保存。请检查服务后重试。');
      });
    }
  }, [announceToolNotice, flushSave, persistNow, projectId]);

  useEffect(() => {
    if (documentCommandInFlight.current || runSubmissionInFlight.current) return;
    const pending = jobs.find(job => {
      const context = job.canvas_run;
      return Boolean(
        context
        && isReversePromptJob(job)
        && (job.status === 'done' || job.status === 'partial')
        && context.candidates.some(candidate => candidate.status === 'succeeded')
        && reversePromptConfigEligibleRuns.current.has(context.run_id)
        && !reversePromptConfiguredNodeIds.has(context.result_node_id)
        && !reversePromptConfigAttempts.current.has(context.run_id),
      );
    });
    if (pending) void recoverReversePromptConfig(pending);
  }, [jobs, recoverReversePromptConfig, reversePromptConfiguredNodeIds]);

  const mergeMediaPointerCommand = useCallback((
    remote: CanvasDocument,
    nodeId: string,
    dirtyAtCommand: number,
    beforeCommand: CanvasDocument,
  ) => {
    const concurrent = latestDocument.current ?? remote;
    const remoteNode = remote.nodes.find(node => node.id === nodeId);
    const beforeNode = beforeCommand.nodes.find(node => node.id === nodeId);
    const concurrentNode = concurrent.nodes.find(node => node.id === nodeId);
    const beforePointer = beforeNode && isContentNode(beforeNode)
      ? beforeNode.data.current_version_id
      : null;
    const remotePointer = remoteNode && isContentNode(remoteNode)
      ? remoteNode.data.current_version_id
      : null;
    const concurrentPointer = concurrentNode && isContentNode(concurrentNode)
      ? concurrentNode.data.current_version_id
      : null;
    const pointerWasSuperseded = (
      !remotePointer
      || !concurrentNode
      || !isContentNode(concurrentNode)
      || (concurrentPointer !== beforePointer && concurrentPointer !== remotePointer)
    );
    const shouldApplyPointer = !pointerWasSuperseded && concurrentPointer !== remotePointer;
    const mergedNodes = concurrent.nodes.map(node => {
      if (!shouldApplyPointer || node.id !== nodeId || !isContentNode(node)) return node;
      return {
        ...node,
        data: {
          ...node.data,
          current_version_id: remotePointer,
        },
      } as CanvasContentNode;
    });
    const authoritativeRevision = Math.max(serverRevision.current, remote.revision);
    const merged: CanvasDocument = {
      ...concurrent,
      revision: authoritativeRevision,
      updated_at: remote.revision >= serverRevision.current ? remote.updated_at : concurrent.updated_at,
      nodes: mergedNodes,
      content_versions: acceptServerContentVersions(
        concurrent.content_versions,
        remote.content_versions,
      ),
    };
    if (!pointerWasSuperseded) {
      const historySnapshot: CanvasDocument = concurrentPointer === remotePointer
        ? {
            ...concurrent,
            nodes: concurrent.nodes.map(node => (
              node.id === nodeId && isContentNode(node)
                ? { ...node, data: { ...node.data, current_version_id: beforePointer } } as CanvasContentNode
                : node
            )),
          }
        : concurrent;
      history.current.past.push(historySnapshot);
      history.current.past = history.current.past.slice(-50);
      history.current.future = [];
    }
    serverRevision.current = authoritativeRevision;
    latestDocument.current = merged;
    if (dirtyVersion.current > dirtyAtCommand) {
      saveQueued.current = merged;
      setSaveState('saving');
    } else {
      saveQueued.current = null;
      setSaveState('saved');
    }
    flowNodeCache.current.clear();
    setDocument(merged);
    return pointerWasSuperseded ? 'superseded' as const : 'applied' as const;
  }, []);

  const beginMediaReplacement = useCallback((node: CanvasContentNode, returnNodeId?: string) => {
    const versionId = node.data.current_version_id;
    const version = versionId ? latestDocument.current?.content_versions[versionId] : null;
    if (node.type === 'text') {
      setMediaReplaceError({ nodeId: node.id, message: '文本节点不支持媒体上传。' });
      return;
    }
    if (version && (version.kind === 'text' || version.kind !== node.type)) {
      setMediaReplaceError({ nodeId: node.id, message: '这个节点引用了不匹配的媒体内容。' });
      return;
    }
    setMediaReplaceError(null);
    setMediaReplaceTarget({
      nodeId: node.id,
      title: node.title,
      kind: node.type,
      hadContent: Boolean(version),
      returnNodeId,
    });
    requestAnimationFrame(() => {
      if (!replaceMediaRef.current) return;
      replaceMediaRef.current.value = '';
      replaceMediaRef.current.click();
    });
  }, []);

  const replaceMedia = useCallback((node: CanvasContentNode) => {
    beginMediaReplacement(node);
  }, [beginMediaReplacement]);

  const replaceLayerStackSource = useCallback((nodeId: string) => {
    const current = latestDocument.current;
    if (!current) return;
    const stack = current?.nodes.find(node => node.id === nodeId);
    if (stack?.type !== 'layer_stack' || stack.data.base_version_id || stack.data.active_run_id) {
      setError('这个图层拆分节点的源图已经冻结。');
      return;
    }
    const input = current.connections.find(connection => (
      connection.role === 'input'
      && !connection.slot
      && connection.target_node_id === nodeId
    ));
    const source = current.nodes.find(node => node.id === input?.source_node_id);
    if (source?.type !== 'image') {
      setError('图层拆分节点没有可替换的上游图片。');
      return;
    }
    beginMediaReplacement(source, nodeId);
  }, [beginMediaReplacement]);

  const handleMediaReplace = useCallback(async (file: File, target: MediaReplaceTarget) => {
    if (documentCommandInFlight.current) {
      setMediaReplaceError({ nodeId: target.nodeId, message: '另一个媒体操作正在处理，请稍后重试。' });
      return;
    }
    setMediaReplaceBusyNodeIds(current => new Set(current).add(target.nodeId));
    setMediaReplaceError(null);
    try {
      if (!await persistNow()) {
        setMediaReplaceError({ nodeId: target.nodeId, message: '自动保存失败，媒体尚未替换。请检查服务后重试。' });
        return;
      }
      const before = latestDocument.current;
      if (!before) return;
      const dirtyAtCommand = dirtyVersion.current;
      documentCommandInFlight.current = true;
      const uploaded = await replaceCanvasNodeMedia(
        projectId,
        target.nodeId,
        file,
        serverRevision.current,
      );
      const mergeStatus = mergeMediaPointerCommand(
        uploaded.document,
        target.nodeId,
        dirtyAtCommand,
        before,
      );
      const returnNodeId = target.returnNodeId ?? target.nodeId;
      setSelectedConnectionIds(new Set());
      setSelectedNodeIds(new Set([returnNodeId]));
      announceToolNotice(mergeStatus === 'applied'
        ? target.hadContent
          ? `已替换“${target.title}”，旧版本仍可撤销恢复`
          : `已将文件上传到“${target.title}”`
        : `“${target.title}”已有更新内容；上传文件已保留为历史版本`);
      requestAnimationFrame(() => documentQueryNode(returnNodeId)?.focus());
    } catch (replaceError) {
      setMediaReplaceError({ nodeId: target.nodeId, message: (replaceError as Error).message });
    } finally {
      documentCommandInFlight.current = false;
      setMediaReplaceBusyNodeIds(current => {
        const next = new Set(current);
        next.delete(target.nodeId);
        return next;
      });
      setMediaReplaceTarget(null);
      if (saveQueued.current) void flushSave().catch(() => {
        setError('替换已完成，但并发编辑尚未保存。请检查服务后重试。');
      });
    }
  }, [announceToolNotice, flushSave, mergeMediaPointerCommand, persistNow, projectId]);

  const toggleFreeResize = useCallback((node: CanvasContentNode) => {
    if (node.type !== 'image') return;
    const versionId = node.data.current_version_id;
    const version = versionId ? latestDocument.current?.content_versions[versionId] : null;
    const locking = node.data.display.free_resize;
    commit(current => ({
      ...current,
      nodes: current.nodes.map(candidate => {
        if (candidate.id !== node.id || candidate.type !== 'image') return candidate;
        return {
          ...candidate,
          size: version?.kind === 'image'
            ? sizeLockedToCanvasVersion(candidate.size, version)
            : candidate.size,
          data: {
            ...candidate.data,
            display: { ...candidate.data.display, free_resize: !candidate.data.display.free_resize },
          },
        };
      }),
    }), true);
    flowNodeCache.current.delete(node.id);
    announceToolNotice(locking ? `已锁定“${node.title}”的图片比例` : `已开启“${node.title}”自由缩放`);
  }, [announceToolNotice, commit]);

  const openMediaOperation = useCallback((node: CanvasContentNode, tool: CanvasMediaTool) => {
    const versionId = node.data.current_version_id;
    const version = versionId ? latestDocument.current?.content_versions[versionId] : null;
    if (!version || version.kind !== 'image' || !version.width || !version.height) {
      setError('这个节点没有可处理的本地图片。');
      return;
    }
    setPreview(null);
    setMediaOperationError(null);
    setMediaOperation({ nodeId: node.id, title: node.title, tool, version });
  }, []);

  const persistImageEdit = useCallback(async (
    payload: Omit<CanvasImageEditSavePayload, 'expected_revision'>, mask: Blob | null,
  ) => {
    if (!await persistNow()) throw new Error('画布尚未保存，请重试。');
    const before = latestDocument.current;
    if (!before) throw new Error('画布尚未加载。');
    const dirtyAtSave = dirtyVersion.current;
    documentCommandInFlight.current = true;
    try {
      const result = await saveCanvasImageEdit(projectId, { ...payload, expected_revision: serverRevision.current }, mask);
      const current = latestDocument.current ?? before;
      const savedNode = result.document.nodes.find(node => node.id === result.node_id);
      if (savedNode?.type !== 'image_edit') throw new Error('编辑节点保存失败。');
      const exists = current.nodes.some(node => node.id === savedNode.id);
      const nodes = exists ? current.nodes.map(node => node.id === savedNode.id
        ? { ...node, data: savedNode.data } as CanvasNode : node) : [...current.nodes, savedNode];
      const nodeIds = new Set(nodes.map(node => node.id));
      const merged: CanvasDocument = detachMissingImageEditNodes({ ...current, revision: Math.max(serverRevision.current, result.document.revision),
        updated_at: result.document.updated_at, nodes,
        connections: [
          ...current.connections.filter(edge => !(edge.role === 'material' && edge.target_node_id === savedNode.id)),
          ...result.document.connections.filter(edge => edge.role === 'material' && edge.target_node_id === savedNode.id
            && nodeIds.has(edge.source_node_id)),
        ],
        content_versions: acceptServerContentVersions(current.content_versions, result.document.content_versions),
      });
      history.current.past.push(current);
      history.current.past = history.current.past.slice(-50);
      history.current.future = [];
      serverRevision.current = Math.max(serverRevision.current, result.document.revision);
      latestDocument.current = merged;
      setDocument(merged);
      saveQueued.current = dirtyVersion.current > dirtyAtSave ? merged : null;
      setSaveState(saveQueued.current ? 'saving' : 'saved');
      return savedNode;
    } finally {
      documentCommandInFlight.current = false;
      if (saveQueued.current) void flushSave().catch(() => undefined);
    }
  }, [flushSave, persistNow, projectId]);

  const openImageEdit = useCallback((nodeId: string) => {
    const node = latestDocument.current?.nodes.find(item => item.id === nodeId);
    if (node?.type !== 'image_edit') return;
    const version = latestDocument.current?.content_versions[node.data.source_version_id];
    if (!version || version.kind !== 'image') { setError('编辑源图片不存在。'); return; }
    setPreview(null); setMediaOperation(null); setMaskEditError(null);
    setMaskEdit({ nodeId, title: node.title, version,
      mode: node.data.options.mode === 'outpaint' ? 'outpaint' : 'inpaint', open: true });
  }, []);

  const openMaskEdit = useCallback((node: CanvasContentNode, mode: 'inpaint' | 'outpaint' = 'inpaint') => {
    const version = node.data.current_version_id ? latestDocument.current?.content_versions[node.data.current_version_id] : null;
    if (node.type !== 'image' || !version || version.kind !== 'image' || !version.width || !version.height) {
      setError('这个节点没有可局部编辑的图片版本。'); return;
    }
    const { width, height } = version;
    void persistImageEdit({ source_node_id: node.id, source_version_id: version.version_id,
      generation_draft: null, options: { mode }, reference_node_id: null, reference_version_id: null,
      editor_state: { strokes: [], frame_ratio: mode === 'outpaint' ? 'original' : '', frame: initialEditFrame(width, height, mode) },
    }, null).then(saved => { setSelectedNodeIds(new Set([saved.id])); openImageEdit(saved.id); })
      .catch(error => setError((error as Error).message));
  }, [openImageEdit, persistImageEdit]);

  const submitImageEdit = useCallback(async (nodeId: string): Promise<boolean> => {
    if (runSubmissionInFlight.current || !await persistNow()) return false;
    const node = latestDocument.current?.nodes.find(item => item.id === nodeId);
    if (node?.type !== 'image_edit' || node.data.active_run_id) return false;
    const validation = savedImageEditError(node, latestDocument.current?.content_versions[node.data.source_version_id], keys);
    if (validation) { setError(validation); setMaskEditError(validation); return false; }
    setSubmittingNodeIds(current => new Set(current).add(nodeId));
    runSubmissionInFlight.current = true;
    try {
      const dirtyAtSubmission = dirtyVersion.current;
      const run = await submitCanvasImageEdit(projectId, nodeId, serverRevision.current, node.data.generation_draft?.params.n ?? 1);
      mergeSubmittedRunDocument(run.document, run.job, dirtyAtSubmission);
      applyLocalJob(run.job);
      announceToolNotice(`已提交“${node.title}”的图片编辑`);
      return true;
    } catch (error) {
      setError((error as Error).message); setMaskEditError((error as Error).message);
      return false;
    } finally {
      runSubmissionInFlight.current = false;
      setSubmittingNodeIds(current => { const next = new Set(current); next.delete(nodeId); return next; });
      if (saveQueued.current) void flushSave().catch(() => undefined);
    }
  }, [announceToolNotice, applyLocalJob, flushSave, keys, mergeSubmittedRunDocument, persistNow, projectId]);

  const saveMaskEdit = useCallback(async (submission: CanvasMaskEditSubmission, generate = false): Promise<boolean> => {
    if (!maskEdit || maskEditBusy) return false;
    setMaskEditBusy(true); setMaskEditError(null);
    try {
      const saved = await persistImageEdit({ node_id: maskEdit.nodeId,
        generation_draft: submission.draft, options: submission.options, editor_state: submission.editorState,
        reference_node_id: submission.referenceNodeId, reference_version_id: submission.referenceVersionId,
      }, submission.mask);
      if (generate) {
        if (!await submitImageEdit(saved.id)) return true;
        setMaskEdit(null);
      }
      return true;
    } catch (error) {
      setMaskEditError((error as Error).message); return false;
    } finally { setMaskEditBusy(false); }
  }, [maskEdit, maskEditBusy, persistImageEdit, submitImageEdit]);

  const openAngle = useCallback((node: CanvasContentNode) => {
    const versionId = node.data.current_version_id;
    const version = versionId ? latestDocument.current?.content_versions[versionId] : null;
    if (node.type !== 'image' || !version || version.kind !== 'image') {
      setError('这个节点没有可生成新角度的图片版本。');
      return;
    }
    setPreview(null);
    setMediaOperation(null);
    setMaskEdit(null);
    setAngleError(null);
    setAngleState({ nodeId: node.id, title: node.title, version });
  }, []);

  const editVideo = useCallback((node: CanvasContentNode) => {
    const versionId = node.data.current_version_id;
    const version = versionId ? latestDocument.current?.content_versions[versionId] : null;
    if (node.type !== 'video' || !version || version.kind !== 'video') {
      setError('这个节点没有可编辑的视频版本。');
      return;
    }
    const existingDraft = node.data.generation_draft?.mode === 'video'
      ? node.data.generation_draft
      : null;
    const existingKey = existingDraft
      ? keys.find(key => key.alias === existingDraft.alias)
      : null;
    const existingModel = existingKey?.models.find(model => (
      model.id === existingDraft?.model
      && modelModality(model, existingKey) === 'video'
      && supportsCanvasVideoEdit(model.id, model.protocol)
    ));
    const fallback = firstVideoEditModel(keys);
    const key = existingModel && existingKey ? existingKey : fallback?.key;
    const model = existingModel ?? fallback?.model;
    if (!key || !model) {
      setError('未配置支持参考视频的生成模型。请先在设置中接入 Seedance 2.x 等兼容模型。');
      return;
    }
    const now = new Date().toISOString();
    const prompt = existingDraft?.prompt
      || copyablePromptForNode(node, jobsByResultNodeId)
      || '';
    const draft = {
      mode: 'video' as const,
      prompt,
      input_policy: existingDraft?.input_policy ?? 'all_connected' as const,
      model: model.id,
      alias: key.alias,
      params: normalizeCanvasVideoParams(
        model.id,
        model.protocol,
        existingDraft?.params ?? {},
        true,
      ),
      updated_at: now,
    };
    setPreview(null);
    setMediaOperation(null);
    setMaskEdit(null);
    setAngleState(null);
    setError(null);
    const newNodeId = makeId('video');
    const current = latestDocument.current;
    const next = current && createConnectedCanvasSurface(current, node.id, draft,
      { nodeId: newNodeId, connectionId: makeId('connection') }, 'video');
    if (!next) { setError('无法创建视频编辑节点。'); return; }
    commit(() => next, true);
    setDismissedGenerationPanelNodeId(null);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([newNodeId]));
    announceToolNotice(`已创建“${node.title}”的下游视频节点`);
  }, [announceToolNotice, commit, jobsByResultNodeId, keys]);

  const createImageFromSource = useCallback((nodeId: string) => {
    const current = latestDocument.current;
    if (!current) return;
    const newNodeId = makeId('image');
    const next = createConnectedCanvasSurface(current, nodeId,
      createCanvasGenerationDraft(providers, 'image', {
        preference: canvasUiPreferences.generation_defaults.image,
      }), { nodeId: newNodeId, connectionId: makeId('connection') }, 'image');
    if (!next) { setError('这个节点没有可用的内容。'); return; }
    setError(null);
    commit(() => next, true);
    setDismissedGenerationPanelNodeId(null);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([newNodeId]));
  }, [canvasUiPreferences.generation_defaults.image, commit, providers]);


  const submitAngle = useCallback(async (params: CanvasAngleParams) => {
    if (!angleState || runSubmissionInFlight.current) return;
    setAngleBusy(true);
    setAngleError(null);
    setSubmittingNodeIds(current => new Set(current).add(angleState.nodeId));
    try {
      if (!await persistNow()) {
        setAngleError('自动保存失败，多角度生成尚未提交。请检查服务后重试。');
        return;
      }
      const dirtyAtSubmission = dirtyVersion.current;
      runSubmissionInFlight.current = true;
      const run = await submitCanvasAngleRun(projectId, {
        surface_node_id: angleState.nodeId,
        expected_revision: serverRevision.current,
        requested_count: params.requestedCount,
        horizontal_angle: params.horizontalAngle,
        pitch_angle: params.pitchAngle,
        camera_distance: params.cameraDistance,
        wide_angle: params.wideAngle,
      });
      mergeSubmittedRunDocument(run.document, run.job, dirtyAtSubmission);
      applyLocalJob(run.job);
      const resultId = run.job.canvas_run?.result_node_id;
      if (resultId) setSelectedNodeIds(new Set([resultId]));
      setAngleState(null);
      announceToolNotice(`已提交“${angleState.title}”的多角度生成`);
    } catch (submitError) {
      setAngleError((submitError as Error).message);
    } finally {
      runSubmissionInFlight.current = false;
      setAngleBusy(false);
      setSubmittingNodeIds(current => {
        const next = new Set(current);
        next.delete(angleState.nodeId);
        return next;
      });
      if (saveQueued.current) void flushSave().catch(() => undefined);
    }
  }, [
    angleState,
    announceToolNotice,
    applyLocalJob,
    flushSave,
    mergeSubmittedRunDocument,
    persistNow,
    projectId,
  ]);

  const upscaleImageNow = useCallback(async (
    node: CanvasContentNode,
    target: CanvasUpscaleTarget,
    stillWanted: () => boolean,
  ) => {
    if (runSubmissionInFlight.current) return;
    setPreview(null);
    setSubmittingNodeIds(current => new Set(current).add(node.id));
    try {
      if (!await persistNow()) {
        setError('自动保存失败，AI高清尚未提交。请检查服务后重试。');
        return;
      }
      if (!stillWanted()) return;
      const dirtyAtSubmission = dirtyVersion.current;
      runSubmissionInFlight.current = true;
      const run = await submitCanvasUpscaleRun(projectId, {
        surface_node_id: node.id,
        expected_revision: serverRevision.current,
        target,
      });
      mergeSubmittedRunDocument(run.document, run.job, dirtyAtSubmission);
      applyLocalJob(run.job);
      const resultId = run.job.canvas_run?.result_node_id;
      if (resultId) setSelectedNodeIds(new Set([resultId]));
      announceToolNotice(`已提交“${node.title}”的 ${target} AI高清`);
    } catch (submitError) {
      const message = (submitError as Error).message;
      setError(message);
      const code = submitError instanceof ApiError ? submitError.code : null;
      setErrorAction(code === 'canvas_upscale_model_missing' || code === 'canvas_upscale_model_stale'
        ? { message, label: '前往配置', run: () => { setError(null); openGenerationPreferences('upscale'); } }
        : null);
    } finally {
      runSubmissionInFlight.current = false;
      setSubmittingNodeIds(current => {
        const next = new Set(current);
        next.delete(node.id);
        return next;
      });
      if (saveQueued.current) void flushSave().catch(() => undefined);
    }
  }, [
    announceToolNotice,
    applyLocalJob,
    flushSave,
    mergeSubmittedRunDocument,
    openGenerationPreferences,
    persistNow,
    projectId,
  ]);
  const upscaleImage = useCallback((node: CanvasContentNode, target: CanvasUpscaleTarget): Promise<void> => queueSubmission(
    node.id,
    stillWanted => upscaleImageNow(node, target, stillWanted),
    undefined,
    `upscale:${node.id}:${target}`,
  ), [queueSubmission, upscaleImageNow]);

  const executeMediaOperation = useCallback(async (
    target: { nodeId: string; versionId: string },
    operation: CanvasMediaOperation,
    reportError: (text: string) => void,
  ) => {
    if (mediaOperationInFlight.current) return;
    if (documentCommandInFlight.current) {
      reportError('另一个媒体操作正在处理，请稍后重试。');
      return;
    }
    mediaOperationInFlight.current = true;
    setMediaOperationBusy(true);
    setMediaOperationError(null);
    let placeholderHandedOver = false;
    let commandLocked = false;
    try {
      const initial = latestDocument.current;
      if (!initial) return;
      const source = initial.nodes.find(node => node.id === target.nodeId);
      const version = initial.content_versions[target.versionId];
      const editsLayer = operation.kind !== 'split' && layerMaterialNodeIds(initial).has(target.nodeId);
      const predict = (doc: CanvasDocument, node: CanvasNode) => {
        if (editsLayer || version?.kind !== 'image' || !version.width || !version.height) return [];
        const size = canvasNodeRenderedSize(node, doc.content_versions);
        if (operation.kind !== 'split') return [canvasMediaOperationPlaceholder(node, size, operation)];
        const url = canvasMediaUrlAtWidth(projectId, target.versionId, canvasThumbnailWidth(size.width * Math.max(flowStore.getState().transform[2], 1)));
        return predictSplitGridPlaceholders(node, size, { width: version.width, height: version.height }, operation, doc.nodes, url);
      };
      let pieces = source ? predict(initial, source) : [];
      updateMediaPlaceholders(pieces);
      if (!await persistNow()) {
        reportError('自动保存失败，图片处理尚未开始。请检查服务后重试。');
        return;
      }
      const before = latestDocument.current;
      if (!before || !editorMounted.current) return;
      if (before.nodes !== initial.nodes && operation.kind === 'split') {
        const latestSource = before.nodes.find(node => node.id === target.nodeId);
        if (!latestSource) return;
        pieces = predict(before, latestSource);
        updateMediaPlaceholders(pieces);
      }
      const [placeholder] = pieces;
      if (documentCommandInFlight.current || runSubmissionInFlight.current) {
        reportError('另一个画布操作正在提交，请稍后重试。');
        return;
      }
      const dirtyAtCommand = dirtyVersion.current;
      commandLocked = true;
      documentCommandInFlight.current = true;
      const result = await runCanvasMediaOperation(
        projectId,
        target.nodeId,
        target.versionId,
        serverRevision.current,
        operation,
      );
      if (!editorMounted.current) return;
      const concurrent = latestDocument.current ?? before;
      const knownNodeIds = new Set(concurrent.nodes.map(node => node.id));
      const knownConnectionIds = new Set(concurrent.connections.map(connection => connection.id));
      // 占位节点被拖走过，结果节点整体跟着搬同样的位移。
      const dragged = placeholder && !placeholder.preview && mediaPlaceholdersRef.current[0]?.id === placeholder.id
        ? mediaPlaceholdersRef.current[0].position
        : null;
      const shift = dragged && placeholder
        ? { x: dragged.x - placeholder.position.x, y: dragged.y - placeholder.position.y }
        : { x: 0, y: 0 };
      const createdNodes = result.document.nodes
        .filter(node => result.created_node_ids.includes(node.id) && !knownNodeIds.has(node.id))
        .map(node => (shift.x || shift.y
          ? { ...node, position: { x: node.position.x + shift.x, y: node.position.y + shift.y } }
          : node));
      const createdConnections = result.document.connections.filter(connection => (
        result.created_node_ids.includes(connection.target_node_id)
        && !knownConnectionIds.has(connection.id)
      ));
      const merged: CanvasDocument = {
        ...concurrent,
        revision: result.document.revision,
        updated_at: result.document.updated_at,
        nodes: [...concurrent.nodes.map(node => {
          const updated = result.document.nodes.find(item => item.id === node.id);
          return editsLayer && node.id === target.nodeId && node.type === 'image' && updated?.type === 'image'
            ? { ...node, data: { ...node.data, current_version_id: updated.data.current_version_id } } : node;
        }), ...createdNodes],
        connections: [...concurrent.connections, ...createdConnections],
        content_versions: acceptServerContentVersions(
          concurrent.content_versions,
          result.document.content_versions,
        ),
      };
      history.current.past.push(concurrent);
      history.current.past = history.current.past.slice(-50);
      history.current.future = [];
      serverRevision.current = result.document.revision;
      const synced = syncLayerMaterials(merged);
      latestDocument.current = synced;
      if (dirtyVersion.current > dirtyAtCommand) saveQueued.current = synced;
      flowNodeCache.current.clear();
      // 结果节点接替占位卡：结果淡入、占位卡留在原位淡出，两层交叉，不露画布。
      markCanvasNodesEntering(createdNodes.map(node => node.id), placeholder ? 1 : undefined);
      if (placeholder && motionAvailable()) {
        const leaving = mediaPlaceholdersRef.current.map(piece => ({ ...piece, leaving: true }));
        placeholderHandedOver = true;
        updateMediaPlaceholders(leaving);
        window.setTimeout(() => {
          if (mediaPlaceholdersRef.current === leaving) updateMediaPlaceholders([]);
        }, MOTION_DURATION.base * 1000);
      }
      setDocument(synced);
      setSelectedConnectionIds(new Set());
      setSelectedNodeIds(new Set(result.created_node_ids));
      setMediaOperation(null);
      announceToolNotice(
        editsLayer ? '已更新图层素材' : operation.kind === 'split'
          ? `已生成 ${result.created_node_ids.length} 个切图节点`
          : operation.kind === 'crop' ? '已生成裁剪节点' : '已生成抠图节点',
      );
      requestAnimationFrame(() => editorRegionRef.current?.focus());
    } catch (operationError) {
      reportError((operationError as Error).message);
    } finally {
      if (commandLocked) documentCommandInFlight.current = false;
      mediaOperationInFlight.current = false;
      if (!placeholderHandedOver) updateMediaPlaceholders([]);
      setMediaOperationBusy(false);
      if (saveQueued.current) void flushSave().catch(() => {
        setError('图片处理已完成，但并发编辑尚未保存。请检查服务后重试。');
      });
    }
  }, [announceToolNotice, flowStore, flushSave, persistNow, projectId, updateMediaPlaceholders]);

  const splitImage = useCallback((node: CanvasContentNode, operation: Extract<CanvasMediaOperation, { kind: 'split' }>) => {
    const versionId = node.data.current_version_id;
    if (versionId) void executeMediaOperation({ nodeId: node.id, versionId }, operation, notify.error);
  }, [executeMediaOperation]);

  const submitMediaOperation = useCallback((operation: CanvasMediaOperation) => {
    if (!mediaOperation) return Promise.resolve();
    return executeMediaOperation(
      { nodeId: mediaOperation.nodeId, versionId: mediaOperation.version.version_id },
      operation, setMediaOperationError,
    );
  }, [executeMediaOperation, mediaOperation]);

  const removeBackground = useCallback((node: CanvasContentNode) => {
    const versionId = node.data.current_version_id;
    const version = versionId ? latestDocument.current?.content_versions[versionId] : null;
    if (!version || version.kind !== 'image' || !version.width || !version.height) {
      setError('这个节点没有可处理的本地图片。');
      return;
    }
    setPreview(null);
    const target = { nodeId: node.id, versionId: version.version_id };
    void (async () => {
      let status: CanvasMattingModelStatus;
      try {
        status = await getCanvasMattingModel();
      } catch (statusError) {
        setError((statusError as Error).message);
        return;
      }
      if (!status.available) {
        setError(status.message ?? '当前平台不支持本机抠图。');
        return;
      }
      if (!status.ready) {
        setMattingPrompt({ ...target, title: node.title, bytes: status.bytes });
        return;
      }
      announceToolNotice(`${node.title} 抠图中…`);
      await executeMediaOperation(target, { kind: 'remove_background' }, setError);
    })();
  }, [announceToolNotice, executeMediaOperation]);

  const confirmMattingDownload = useCallback(async () => {
    if (!mattingPrompt || mattingDownloading) return;
    setMattingDownloading(true);
    try {
      await downloadCanvasMattingModel();
      setMattingPrompt(null);
      announceToolNotice(`模型已就绪，${mattingPrompt.title} 抠图中…`);
      await executeMediaOperation(
        { nodeId: mattingPrompt.nodeId, versionId: mattingPrompt.versionId },
        { kind: 'remove_background' }, setError,
      );
    } catch (downloadError) {
      setError((downloadError as Error).message);
    } finally {
      setMattingDownloading(false);
    }
  }, [announceToolNotice, executeMediaOperation, mattingDownloading, mattingPrompt]);

  const persistCanvasUiPreferences = useCallback(async (
    imageToolbar: CanvasImageToolbarPreferences,
    generationDefaults: CanvasGenerationDefaults,
    upscale: CanvasUpscalePreferences,
    successNotice: string,
  ) => {
    if (canvasUiPreferencesSaveInFlight.current) {
      throw new Error('另一项画布界面设置正在保存，请稍后重试。');
    }
    canvasUiPreferencesSaveInFlight.current = true;
    try {
      const saved = await saveCanvasUiPreferences(
        canvasUiPreferences.revision,
        imageToolbar,
        generationDefaults,
        upscale,
      );
      setCanvasUiPreferences(saved);
      setCanvasUiPreferencesError(null);
      announceToolNotice(successNotice);
    } catch (saveError) {
      let message = (saveError as Error).message;
      try {
        const latest = await getCanvasUiPreferences();
        setCanvasUiPreferences(latest);
        message = `${message} 已重新载入当前设置，请确认后再保存。`;
      } catch {
        // 保留浏览器中最后一次成功读取的偏好，避免网络错误伪装成保存成功。
      }
      setCanvasUiPreferencesError(message);
      throw new Error(message);
    } finally {
      canvasUiPreferencesSaveInFlight.current = false;
    }
  }, [announceToolNotice, canvasUiPreferences.revision]);

  const persistImageToolbarPreferences = useCallback(async (
    value: CanvasImageToolbarPreferences,
  ) => persistCanvasUiPreferences(
    value,
    canvasUiPreferences.generation_defaults,
    canvasUiPreferences.upscale,
    '图片快捷工具已更新',
  ), [canvasUiPreferences.generation_defaults, canvasUiPreferences.upscale, persistCanvasUiPreferences]);

  const persistGenerationPreferences = useCallback(async (
    value: CanvasGenerationDefaults,
    upscale: CanvasUpscalePreferences,
  ) => {
    setGenerationPreferencesSaving(true);
    setCanvasUiPreferencesError(null);
    try {
      await persistCanvasUiPreferences(
        canvasUiPreferences.image_toolbar,
        value,
        upscale,
        '生成偏好已更新',
      );
      setGenerationPreferencesOpen(false);
      requestAnimationFrame(() => canvasMenuTriggerRef.current?.focus());
    } catch {
      // 保存函数已重新读取冲突版本并写入明确错误；保留弹窗让用户核对。
    } finally {
      setGenerationPreferencesSaving(false);
    }
  }, [canvasUiPreferences.image_toolbar, persistCanvasUiPreferences]);

  const mentionReferencesByNodeId = useMemo(() => {
    const current = mentionDocumentRef.current;
    if (!current) return new Map();
    return new Map(current.nodes.map(node => [
      node.id,
      buildCanvasMentionReferences(
        projectId,
        node,
        current.nodes,
        current.connections,
        current.content_versions,
      ),
    ]));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上方图签名说明
  }, [mentionGraphSignature, projectId]);
  const materialReferences = useMemo(() => {
    const current = mentionDocumentRef.current;
    return current
      ? buildCanvasMaterialReferences(projectId, current.nodes, current.content_versions)
      : [];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上方图签名说明
  }, [mentionGraphSignature, projectId]);
  const connectedMaterialNodeIdsByNodeId = useMemo(() => {
    const current = mentionDocumentRef.current;
    const result = new Map<string, Set<string>>();
    for (const connection of current?.connections ?? []) {
      if (connection.role !== 'input' || connection.slot) continue;
      const sources = result.get(connection.target_node_id) ?? new Set<string>();
      // 连的是分组时，界面上的参考位要显示包里的成员——和真正发出去的那批素材保持一致。
      for (const sourceId of current ? expandCanvasInputSource(current, connection.source_node_id, connection.target_node_id) : []) {
        sources.add(sourceId);
      }
      result.set(connection.target_node_id, sources);
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上方图签名说明
  }, [mentionGraphSignature]);
  const pendingInputNodesByNodeId = useMemo(
    () => canvasPendingInputNodes(mentionDocumentRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上方图签名说明
    [mentionGraphSignature],
  );
  const videoFrameNodeIdsByNodeId = useMemo(() => {
    const current = mentionDocumentRef.current;
    const result = new Map<string, Partial<Record<CanvasVideoFrameSlot, string>>>();
    for (const connection of current?.connections ?? []) {
      if (connection.role !== 'input' || !isCanvasVideoFrameSlot(connection.slot)) continue;
      const frames = result.get(connection.target_node_id) ?? {};
      frames[connection.slot] = connection.source_node_id;
      result.set(connection.target_node_id, frames);
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上方图签名说明
  }, [mentionGraphSignature]);
  const compareInputsByNodeId = useMemo(() => {
    const current = mentionDocumentRef.current;
    const nodes = new Map((current?.nodes ?? []).map(node => [node.id, node]));
    const result = new Map<string, CanvasCompareInputs>();
    for (const connection of current?.connections ?? []) {
      if (connection.role !== 'input' || !isCanvasCompareSlot(connection.slot)) continue;
      const source = nodes.get(connection.source_node_id);
      const sides = result.get(connection.target_node_id) ?? {};
      sides[connection.slot] = {
        nodeId: connection.source_node_id,
        title: source?.title ?? '',
        versionId: source?.type === 'image' ? source.data.current_version_id : null,
      };
      result.set(connection.target_node_id, sides);
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上方图签名说明
  }, [mentionGraphSignature]);

  const pluginInputsByNodeId = useMemo(() => pluginInputsFromDocument(mentionDocumentRef.current),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上方图签名说明（结果组成员表在签名里）
    [mentionGraphSignature]);

  const layerParentSignature = JSON.stringify((document?.nodes ?? []).flatMap(node => {
    if (node.type !== 'layer_stack') return [];
    return [node.data.base_material_node_id, ...node.data.layers.map(layer => layer.material_node_id)]
      .filter((id): id is string => Boolean(id))
      .map(id => [id, { nodeId: node.id, title: node.title }] as const);
  }));
  const layerParentByNodeId = useMemo(() => new Map<string, { nodeId: string; title: string }>(
    JSON.parse(layerParentSignature),
  ), [layerParentSignature]);
  // 结果节点 → 编辑节点：编辑节点到结果是 material 连线。签名带上编辑节点本身，
  // 提示词 / 画框改了面板跟着变，其余编辑不换 Map 引用。
  const editSourceSignature = JSON.stringify((() => {
    const editNodes = new Map((document?.nodes ?? []).flatMap(node => node.type === 'image_edit' ? [[node.id, node] as const] : []));
    return (document?.connections ?? []).flatMap(connection => {
      const edit = connection.role === 'material' ? editNodes.get(connection.source_node_id) : undefined;
      return edit ? [[connection.target_node_id, edit] as const] : [];
    });
  })());
  const editSourceByResultNodeId = useMemo(() => new Map<string, CanvasImageEditNode>(
    JSON.parse(editSourceSignature),
  ), [editSourceSignature]);
  const locateNodeHandler = useRef<(id: string) => void>(() => undefined);
  locateNodeHandler.current = (nodeId: string) => {
    const current = latestDocument.current;
    const node = current?.nodes.find(item => item.id === nodeId);
    if (!current || !node) return;
    selectOnlyNode(nodeId);
    const size = canvasNodeRenderedSize(node, current.content_versions);
    void runViewportCommand(() => setCenter(node.position.x + size.width / 2,
      node.position.y + size.height / 2, { zoom: getZoom(), duration: 0 }));
  };
  const locateNode = useCallback((nodeId: string) => locateNodeHandler.current(nodeId), []);
  // 首页「打开所在位置」带 `?node=`：文档载入后定位一次，再把参数从地址栏去掉。
  useEffect(() => {
    if (!documentLoaded) return;
    const params = new URLSearchParams(window.location.search);
    const nodeId = params.get('node');
    if (!nodeId) return;
    params.delete('node');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    requestAnimationFrame(() => locateNode(nodeId));
  }, [documentLoaded, locateNode]);
  const [projectAssets, setProjectAssets] = useState<CreationAsset[]>([]);
  const [assetsRevision, setAssetsRevision] = useState(0);
  const refreshProjectAssets = useCallback(async () => {
    const response = await listCreationAssets({ projectId, scope: 'project' });
    setProjectAssets(current => JSON.stringify(current) === JSON.stringify(response.assets) ? current : response.assets);
  }, [projectId]);
  useEffect(() => {
    let active = true;
    setProjectAssets([]);
    const refresh = () => { void listCreationAssets({ projectId, scope: 'project' }).then(response => {
      if (active) setProjectAssets(current => JSON.stringify(current) === JSON.stringify(response.assets) ? current : response.assets);
    }).catch(error => { if (active) setError((error as Error).message); }); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); };
  }, [projectId, assetsRevision]);
  const assetsByDigest = useMemo(() => {
    const result = new Map<string, CreationAsset>();
    for (const asset of projectAssets) {
      const media = assetMediaContent(asset);
      if (media && (!result.has(media.sha256) || asset.category)) result.set(media.sha256, asset);
    }
    return result;
  }, [projectAssets]);
  const assetsByDigestRef = useRef(assetsByDigest);
  assetsByDigestRef.current = assetsByDigest;
  const resolveFinalCategory = useCallback((sha256: string) => assetsByDigestRef.current.get(sha256)?.category ?? null, []);
  const finalizationRevision = useMemo(() => JSON.stringify([...assetsByDigest].map(([digest, asset]) => [digest, asset.category])), [assetsByDigest]);
  const projectCategories = projects.find(project => project.project_id === projectId)?.categories ?? DEFAULT_CANVAS_CATEGORIES;
  const finalizeHandler = useRef<(node: CanvasContentNode, category: string | null) => Promise<void>>(async () => undefined);
  finalizeHandler.current = async (node, category) => {
    const version = await persistedCurrentVersion(node);
    if (version?.kind !== 'image') return;
    // 先刷新再按本项目摘要匹配，避免资产面板刚编辑后用旧缓存覆盖。
    const response = await listCreationAssets({ projectId, scope: 'project' });
    const matches = response.assets.filter(asset => assetMediaContent(asset)?.sha256 === version.sha256);
    const existing = matches.find(asset => asset.category) ?? matches[0];
    if (existing) {
      // 同一图片可能同时保存过媒体与生成资产；取消定稿须清空所有命中的条目。
      for (const asset of matches.filter(asset => asset.category !== category)) {
        await updateCreationAssetCategory(asset.asset_id, category);
      }
    } else if (category) {
      await saveMediaCreationAssetFromPath({
        sourcePath: `canvases/${projectId}/${version.path}`, title: node.title,
        tags: [], projectId, category, allowExisting: true,
      });
    }
    await refreshProjectAssets();
    setAssetsRevision(value => value + 1);
  };
  const finalizeNode = useCallback((node: CanvasContentNode, category: string | null) => finalizeHandler.current(node, category), []);
  const saveCategories = useCallback(async (categories: string[]) => {
    const updated = await updateCanvasCategories(projectId, categories);
    setProjects(current => current.map(project => project.project_id === projectId ? updated : project));
  }, [projectId]);
  const createCompareNodeHandler = useRef<(node: CanvasContentNode, source: CanvasCompareSource) => void>(() => undefined);
  // 结果图上的「对比」：建对比节点，原图连 Before、结果连 After。原图优先用快照里登记的那个节点；
  // 它被删了或已换成别的图，就在旁边补一张固定原图版本的图片节点，保证对比的是生成时真正用的原图。
  createCompareNodeHandler.current = (node, source) => {
    const current = latestDocument.current;
    if (!current || !node.data.current_version_id) return;
    const holdsOriginal = (candidate: CanvasNode | undefined) => candidate?.type === 'image'
      && candidate.data.current_version_id === source.beforeVersionId;
    const listed = current.nodes.find(candidate => candidate.id === source.beforeNodeId);
    const existing = holdsOriginal(listed) ? listed : current.nodes.find(holdsOriginal);
    const size = canvasNodeRenderedSize(node, current.content_versions);
    const compareId = makeId('compare');
    const compare: CanvasNode = { id: compareId, type: 'compare', title: `${node.title} 对比`,
      position: placeNewNode({ x: node.position.x + size.width + 96, y: node.position.y }, size),
      size, z_index: 0, data: {} };
    const original: CanvasNode | null = existing ? null : {
      id: makeId('image'), type: 'image', title: `${node.title} 原图`,
      position: placeNewNode({ x: node.position.x, y: node.position.y + size.height + 96 }, size),
      size, z_index: 0,
      data: { current_version_id: source.beforeVersionId, generation_draft: null, active_run_id: null,
        display: { fit: 'contain', free_resize: false } },
    };
    const beforeNodeId = existing?.id ?? original!.id;
    commit(document => ({
      ...document,
      nodes: [...document.nodes, ...(original ? [original] : []), compare],
      connections: [...document.connections,
        { id: makeId('connection'), role: 'input', source_node_id: beforeNodeId, target_node_id: compareId, slot: 'before' },
        { id: makeId('connection'), role: 'input', source_node_id: node.id, target_node_id: compareId, slot: 'after' },
      ],
    }), true);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([compareId]));
    focusNewNodesHandler.current([compare]);
  };
  const createPluginNodeFromMediaHandler = useRef<(node: CanvasContentNode, plugin: PluginPackageLock, action: PluginMediaAction) => void>(() => undefined);
  createPluginNodeFromMediaHandler.current = (node, plugin, action) => {
    const current = latestDocument.current;
    const target = action.action;
    if (target.kind === 'host_call') {
      // 调用型动作（ADR-0041）：不建节点，把来源节点交给宿主插件分块里同 id 的处理函数。
      if (plugin.runtime !== 'host' || !isHostPluginId(plugin.id)) return;
      void loadHostPlugin(plugin.id).then(module => module?.imageActions?.[action.id]?.(node, hostPluginApi));
      return;
    }
    const contribution = target.kind === 'create_node'
      ? plugin.contributes.nodes.find(item => item.type === target.node_type) : undefined;
    if (!current || !contribution || target.kind !== 'create_node') return;
    const size = contribution.default_size;
    const sourceSize = canvasNodeRenderedSize(node, current.content_versions);
    const id = makeId('plugin');
    const created: CanvasPluginNode = { id, type: 'plugin', title: contribution.title,
      position: placeNewNode({ x: node.position.x + sourceSize.width + 96, y: node.position.y }, size),
      size, z_index: 0,
      data: { plugin_id: plugin.id, node_type: contribution.type, plugin_version: plugin.version,
        package_digest: plugin.digest, data_schema_version: contribution.payload_schema_version,
        payload: {}, generation_draft: null } };
    if (plugin.runtime === 'host') {
      // 宿主插件不连线：来源节点交给插件代码处理（分镜把它记成剧本来源）。
      void loadHostPlugin(plugin.id).then(module => {
        const type = module?.nodeTypes[contribution.type];
        if (!type) return;
        const filled = type.create(created, node.id);
        commit(document => ({ ...document, nodes: [...document.nodes, filled] }), true);
        setSelectedConnectionIds(new Set());
        setSelectedNodeIds(new Set([id]));
        focusNewNodesHandler.current([filled]);
        if (target.open_panel) type.openPanel?.(id);
      });
      return;
    }
    commit(document => ({
      ...document,
      nodes: [...document.nodes, created],
      connections: [...document.connections,
        { id: makeId('connection'), role: 'input', source_node_id: node.id, target_node_id: id }],
    }), true);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([id]));
    focusNewNodesHandler.current([created]);
    if (target.open_panel) requestPluginPanel(id);
  };
  const createPluginNodeFromMedia = useCallback(
    (node: CanvasContentNode, plugin: PluginPackageLock, action: PluginMediaAction) => (
      createPluginNodeFromMediaHandler.current(node, plugin, action)), []);
  const createCompareNode = useCallback(
    (node: CanvasContentNode, source: CanvasCompareSource) => createCompareNodeHandler.current(node, source), []);
  const swapCompareInputs = useCallback((nodeId: string) => {
    commit(current => ({
      ...current,
      connections: current.connections.map(connection => (
        connection.role === 'input' && connection.target_node_id === nodeId && isCanvasCompareSlot(connection.slot)
          ? { ...connection, slot: connection.slot === 'before' ? 'after' as const : 'before' as const }
          : connection
      )),
    }), true);
  }, [commit]);
  const openCompare = useCallback((nodeId: string) => setCompareViewId(nodeId), []);
  // 新建节点：只平移到新节点（多个时取包围盒）的中心，保持当前缩放（飙哥 2026-10-09，
  // 取代 09-14 的「放大到占视口大部分」）。一批新节点只算一次、只动一次视口。
  focusNewNodesHandler.current = (nodes: readonly CanvasNode[]) => {
    if (!nodes.length) return;
    markCanvasNodesEntering(nodes.map(node => node.id));
    const versions = latestDocument.current?.content_versions ?? {};
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const node of nodes) {
      const size = canvasNodeRenderedSize(node, versions);
      left = Math.min(left, node.position.x);
      top = Math.min(top, node.position.y);
      right = Math.max(right, node.position.x + size.width);
      bottom = Math.max(bottom, node.position.y + size.height);
    }
    void runViewportCommand(() => setCenter((left + right) / 2, (top + bottom) / 2,
      { zoom: getZoom(), duration: viewportMotionMs(MOTION_DURATION.slow) }));
  };

  // 框选时选中数每帧在变；context 只关心「是否多选」，依赖写成 size 会让所有节点跟着每帧重渲染。
  const multiSelectionActive = selectedNodeIds.size > 1;
  const annotationController = useCanvasAnnotation(document, selectedNodeIds, commit, undo, redo, history.current.past.length > 0, history.current.future.length > 0);
  const editWithAnnotation = useCallback(async (nodeId: string) => {
    setError(null);
    setSubmittingNodeIds(current => new Set(current).add(nodeId));
    try {
      const draft = createCanvasGenerationDraft(providers, 'image', { preference: canvasUiPreferences.generation_defaults.image });
      const id = await createAnnotatedGeneration(annotationBridge, nodeId, draft);
      annotationController.exit();
      setDismissedGenerationPanelNodeId(null);
      setSelectedConnectionIds(new Set());
      setSelectedNodeIds(new Set([id]));
      locateNode(id);
    } catch (error) { setError((error as Error).message); }
    finally { setSubmittingNodeIds(current => { const next = new Set(current); next.delete(nodeId); return next; }); }
  }, [annotationBridge, annotationController, providers, canvasUiPreferences.generation_defaults.image, locateNode]);
  // 宿主插件（ADR-0039）：已启用的在画布打开时加载；交给它们的能力对象保持常量引用。
  const hostPlugins = useHostPlugins();
  const hostPluginLatest = useRef({ submitRun, commit, providers, savePendingEdits, jobsByResultNodeId,
    defaults: canvasUiPreferences.generation_defaults });
  hostPluginLatest.current = { submitRun, commit, providers, savePendingEdits, jobsByResultNodeId,
    defaults: canvasUiPreferences.generation_defaults };
  const hostPluginApi = useMemo<HostPluginApi>(() => ({
    projectId, findNode, listNodes, resolveVersion, updateNode, reportError,
    recordHistory: recordHistorySnapshot, selectNode: selectOnlyNode,
    clearError: () => setError(null),
    announce: message => announceToolNotice(message),
    savePendingEdits: () => hostPluginLatest.current.savePendingEdits(),
    lastRunFailed: nodeId => hostPluginLatest.current.jobsByResultNodeId.get(nodeId)?.some(job => job.status === 'failed') ?? false,
    currentDocument: () => latestDocument.current,
    commitDocument: (updater, record) => hostPluginLatest.current.commit(updater, record),
    submitRun: nodeId => hostPluginLatest.current.submitRun(nodeId),
    // 画布状态经 React 更新后才进 latestDocument：插件的下一步要等它落定。
    waitForDocument: async ready => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (latestDocument.current && ready(latestDocument.current)) return true;
        await new Promise(resolve => window.setTimeout(resolve, 25));
      }
      return false;
    },
    providers: () => hostPluginLatest.current.providers,
    generationDefault: slot => hostPluginLatest.current.defaults[slot],
    newId: makeId,
  }), [projectId, findNode, listNodes, resolveVersion, updateNode, reportError, recordHistorySnapshot, selectOnlyNode, announceToolNotice]);
  const runPluginCanvasAction = (plugin: PluginPackageLock, action: PluginCanvasAction) => {
    setAddOpen(false);
    if (plugin.runtime !== 'host' || !isHostPluginId(plugin.id)) return;
    const position = defaultPosition();
    void loadHostPlugin(plugin.id).then(module => module?.canvasActions?.[action.id]?.(hostPluginApi, position));
  };

  /** 节点失败态上的修复动作（规格 2.3，与创作台同一张表）：密钥 / 余额 / 地址去供应商设置（有充值地址的直接外链），
   *  服务无响应重新加载；重试只对普通生成直接再提交一次，反推、AI高清等预设任务与换模型、改提示词一样
   *  定位并选中发起生成的那个节点，交给用户在面板里改了再点生成。 */
  const runFailureAction = useCallback((job: Job, action: JobErrorAction) => {
    if (action.kind === 'topup' || action.kind === 'open_provider' || action.kind === 'edit_endpoint') {
      const href = presentJobError(job, keys.find(key => key.alias === job.alias)).action?.href;
      if (href) {
        window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      leaveCanvas(() => setLocation('/settings/providers'));
      return;
    }
    if (action.kind === 'reconnect') {
      window.location.reload();
      return;
    }
    const surfaceId = job.canvas_run?.snapshot.surface_node_id;
    const surface = surfaceId ? latestDocument.current?.nodes.find(node => node.id === surfaceId) : undefined;
    if (!surface) return;
    const presetTask = Boolean(job.canvas_run?.snapshot.normalized_params.preset_id);
    if (action.kind === 'retry' && !presetTask && generationDraftForNode(surface)) {
      void submitRun(surface.id);
      return;
    }
    selectOnlyNode(surface.id);
    locateNode(surface.id);
  }, [keys, leaveCanvas, locateNode, selectOnlyNode, setLocation, submitRun]);

  const contextValue = useMemo<CanvasNodeContextValue>(() => ({
    groupRuns, groupSteps, refreshGroupRuns,
    projectCategories, resolveFinalCategory, finalizationRevision, finalizeNode, saveCategories,
    editWithAnnotation,
    annotationController,
    layerParentByNodeId,
    editSourceByResultNodeId,
    locateNode,
    focusVariableNodeId,
    consumeVariableFocus,
    projectId,
    materialReferences,
    connectedMaterialNodeIdsByNodeId,
    videoFrameNodeIdsByNodeId,
    pendingInputNodesByNodeId,
    mentionReferencesByNodeId,
    resolveVersion,
    findNode,
    listNodes,
    hostPlugins,
    hostPluginApi,
    keys,
    generationProviders: providers,
    jobsByRunId,
    jobsByResultNodeId,
    submittingNodeIds,
    mediaReplaceBusyNodeIds,
    mediaReplaceError,
    canvasUiPreferences,
    canvasUiPreferencesError,
    showImageInfo: document?.settings?.show_image_info ?? true,
    libraryBusy: false,
    multiSelectionActive,
    generationPanel: {
      dismissedNodeId: dismissedGenerationPanelNodeId,
      narrowViewport,
      dismiss: dismissGenerationPanel,
      surfaceRef: editorRegionRef,
    },
    materialPick,
    beginMaterialPick,
    setMaterialConnected,
    setAnnotationDelivery,
    reorderMaterialConnections,
    setVideoFrameConnections,
    convertVideoFrameConnections,
    mattingAvailable,
    deleteNodes,
    queuedNodeIds,
    selectNode: selectOnlyNode,
    previewContent,
    previewLayerStack,
    selectCandidate,
    resultStackOwnerById,
    expandedResultStackIds,
    toggleResultStack,
    consumeResultStackEntrance,
    reportMediaRevealed,
    setResultStackCover,
    reportError,
    submitRun,
    cancelRun,
    resumeMjEdit,
    dismissCandidate,
    updateNode,
    previewNodeResize,
    completeNodeResize,
    renameNode,
    updateText,
    setTextEditing,
    createImageFromSource,
    recordHistory: recordHistorySnapshot,
    saveAsset: saveNodeToLibrary,
    shareResult: shareCanvasResult,
    copyPrompt,
    reversePrompt,
    submitTextRevision,
    createLayerDecomposition,
    submitLayerDecomposition,
    rerunLayerDecomposition,
    recoverReversePromptConfig,
    reversePromptConfiguredNodeIds,
    replaceMedia,
    replaceLayerStackSource,
    expandLayerStack,
    toggleFreeResize,
    openMediaOperation,
    splitImage,
    removeBackground,
    openMaskEdit,
    openImageEdit,
    submitImageEdit,
    openAngle,
    upscaleImage,
    createCompareNode,
    compareInputsByNodeId,
    pluginInputsByNodeId,
    savePendingEdits,
    createPluginNodeFromMedia,
    swapCompareInputs,
    openCompare,
    editVideo,
    saveImageToolbarPreferences: persistImageToolbarPreferences,
    deleteNode,
    runFailureAction,
  }), [
    groupRuns, groupSteps, refreshGroupRuns,
    runFailureAction,
    projectCategories, resolveFinalCategory, finalizationRevision, finalizeNode, saveCategories,
    editWithAnnotation,
    annotationController,
    beginMaterialPick,
    cancelRun,
    resumeMjEdit,
    canvasUiPreferences,
    canvasUiPreferencesError,
    connectedMaterialNodeIdsByNodeId,
    completeNodeResize,
    copyPrompt,
    createImageFromSource,
    layerParentByNodeId,
    editSourceByResultNodeId,
    locateNode,
    createLayerDecomposition,
    deleteNode,
    dismissedGenerationPanelNodeId,
    dismissGenerationPanel,
    dismissCandidate,
    // 版本表不进依赖：它每一次按键都换引用，而 context 变了就会绕过 memo 重渲染所有节点卡。
    // 节点卡改走 resolveVersion（常量引用），失效由节点对象自身的引用变化承担。
    document?.settings?.show_image_info,
    editVideo,
    jobsByResultNodeId,
    jobsByRunId,
    keys,
    providers,
    mediaReplaceBusyNodeIds,
    mediaReplaceError,
    materialReferences,
    materialPick,
    focusVariableNodeId,
    consumeVariableFocus,
    mentionReferencesByNodeId,
    narrowViewport,
    openAngle,
    upscaleImage,
    createCompareNode,
    compareInputsByNodeId,
    pluginInputsByNodeId,
    savePendingEdits,
    createPluginNodeFromMedia,
    swapCompareInputs,
    openCompare,
    openMaskEdit,
    openImageEdit,
    submitImageEdit,
    openMediaOperation,
    splitImage,
    removeBackground,
    previewContent,
    previewLayerStack,
    persistImageToolbarPreferences,
    projectId,
    reportError,
    recordHistorySnapshot,
    recoverReversePromptConfig,
    replaceMedia,
    replaceLayerStackSource,
    expandLayerStack,
    reversePrompt,
    reversePromptConfiguredNodeIds,
    renameNode,
    submitTextRevision,
    saveNodeToLibrary,
    shareCanvasResult,
    multiSelectionActive,
    selectCandidate,
    resultStackOwnerById,
    expandedResultStackIds,
    toggleResultStack,
    consumeResultStackEntrance,
    reportMediaRevealed,
    setResultStackCover,
    selectOnlyNode,
    setMaterialConnected,
    setAnnotationDelivery,
    reorderMaterialConnections,
    setTextEditing,
    setVideoFrameConnections,
    convertVideoFrameConnections,
    mattingAvailable,
    deleteNodes,
    queuedNodeIds,
    submitLayerDecomposition,
    rerunLayerDecomposition,
    submitRun,
    submittingNodeIds,
    toggleFreeResize,
    updateNode,
    updateText,
    previewNodeResize,
    resolveVersion,
    findNode,
    listNodes,
    hostPlugins,
    hostPluginApi,
    videoFrameNodeIdsByNodeId,
    pendingInputNodesByNodeId,
  ]);

  useEffect(() => {
    const region = editorRegionRef.current;
    if (!region) return;
    const preventBrowserHistoryNavigation = (event: WheelEvent) => {
      if (event.cancelable && shouldPreventCanvasHistoryNavigation(event)) {
        event.preventDefault();
      }
    };
    region.addEventListener('wheel', preventBrowserHistoryNavigation, {
      capture: true,
      passive: false,
    });
    return () => region.removeEventListener('wheel', preventBrowserHistoryNavigation, {
      capture: true,
    });
  }, [document?.project_id]);

  // 上面的拦截只在滚轮落进编辑区时生效。弹窗类组件（Radix 模态菜单）会给 body 加
  // pointer-events: none，滚轮直接落到根节点，Mac 双指横滑就成了浏览器后退。
  // 画布页在根节点上关掉横向回弹，后退手势无论落在哪都触发不了。
  useEffect(() => {
    const root = window.document.documentElement;
    const previous = root.style.overscrollBehaviorX;
    root.style.overscrollBehaviorX = 'none';
    return () => { root.style.overscrollBehaviorX = previous; };
  }, []);

  // 生成中的节点：拖动时 document.nodes 每帧都换，但决定「是否在生成」的只有节点 id / 类型 / active_run_id
  // 与任务表。按这几样做 key，拖动期间不再每帧对所有节点跑一遍 canvasNodeRunState（含历史任务排序）。
  const runNodesRef = useRef<readonly CanvasNode[]>([]);
  runNodesRef.current = document?.nodes ?? [];
  const runKey = (document?.nodes ?? []).map(node => (
    `${node.id}:${node.type}:${'active_run_id' in node.data ? node.data.active_run_id ?? '' : ''}`
  )).join('|');
  const runningNodeIds = useMemo(() => (runKey ? runNodesRef.current : [])
    .filter(node => canvasNodeRunState(node, jobsByRunId, jobsByResultNodeId).status === 'loading')
    .map(node => node.id), [jobsByResultNodeId, jobsByRunId, runKey]);

  // 进入画布：读得快就不闪转圈（超过 300ms 才出），读完画布整体 200ms 淡入。
  const wasLoading = useRef(loading);
  useLayoutEffect(() => {
    if (loading) { wasLoading.current = true; return; }
    if (!wasLoading.current) return;
    wasLoading.current = false;
    const region = editorRegionRef.current;
    if (!region || !motionAvailable()) return;
    clearOnFinish(animate(region, { opacity: [0, 1] }, { duration: MOTION_DURATION.base, ease: MOTION_EASE.out }), region, ['opacity']);
  }, [loading]);

  if (loading) return <DelayedCanvasLoading />;
  if (!document) return <EditorMessage text={error || '画布读取失败'} action={<Button onClick={onBack}>返回项目列表</Button>} />;

  const background = backgroundVariant(document.settings.background);
  const layerPreviewNode = document.nodes.find(node => node.id === layerPreviewId);
  const previewNode = preview
    ? document.nodes.find(node => node.id === preview.nodeId) ?? null
    : null;
  const previewPrompt = previewNode
    ? copyablePromptForNode(previewNode, jobsByResultNodeId)
    : null;
  const previewImages = preview?.version.kind === 'image' ? document.nodes.filter(node =>
    node.type === 'image' && !node.hidden && node.data.current_version_id && document.content_versions[node.data.current_version_id]?.kind === 'image') : [];
  const previewIndex = previewImages.findIndex(node => node.id === preview?.nodeId);
  const stepPreview = (delta: number) => {
    const next = previewIndex >= 0 ? previewImages[previewIndex + delta] : null;
    if (next?.type !== 'image') return;
    const versionId = next.data.current_version_id;
    if (versionId) return () => previewContent(versionId, next.title, next.id);
  };
  const editablePreview = previewNode?.type === 'image' && previewNode.data.current_version_id === preview?.version.version_id
    ? previewNode : null;
  // 从图片的输出端拖出来的新建菜单才给「对比」：新节点会把这张图接到 Before。
  const createMenuFromImage = Boolean(createMenu?.sourceId && createMenu.sourceHandle !== 'target'
    && (createMenu.sourceIds ?? [createMenu.sourceId]).every(id => document?.nodes.find(node => node.id === id)?.type === 'image'));
  const compareViewNode = compareViewId ? document?.nodes.find(node => node.id === compareViewId) : undefined;
  const compareViewInputs = compareViewNode ? compareInputsByNodeId.get(compareViewNode.id) : undefined;
  const compareViewAfter = compareViewInputs?.after?.versionId ? resolveVersion(compareViewInputs.after.versionId) : undefined;
  const compareViewAfterSize = compareViewAfter?.kind === 'image' && compareViewAfter.width && compareViewAfter.height
    ? { width: compareViewAfter.width, height: compareViewAfter.height } : null;
  const compareViewFrame = compareViewInputs?.after?.versionId
    ? canvasCompareFrame(compareViewInputs.before?.versionId, resolveVersion(compareViewInputs.after.versionId),
      jobsByResultNodeId.get(compareViewInputs.after.nodeId), versionId => resolveVersion(versionId))
    : null;
  const previewJobId = preview && (
    preview.version.origin.kind === 'job_output'
    || preview.version.origin.kind === 'layer_decomposition'
  )
    ? preview.version.origin.job_id
    : null;
  const previewJob = previewJobId
    ? jobs.find(job => job.job_id === previewJobId)
    : undefined;
  const maskEditNode = maskEdit
    ? document.nodes.find(node => node.id === maskEdit.nodeId) ?? null
    : null;
  const maskEditData = maskEditNode?.type === 'image_edit' ? maskEditNode.data : undefined;
  const MaskEditor = maskEdit?.mode === 'outpaint' ? CanvasOutpaintEditor : CanvasInpaintEditor;
  const maskEditSourceTitle = document.nodes.find(node => node.id === maskEditData?.source_node_id)?.title;

  const minimapToggle = (
    <Hint label={document.settings.show_minimap ? '关闭小地图' : '打开小地图'}><Toggle
      aria-label={document.settings.show_minimap ? '关闭小地图' : '打开小地图'}
      pressed={document.settings.show_minimap}
      className={CANVAS_CHROME_BUTTON_CLASS}
      onPressedChange={show_minimap => commit(current => ({
        ...current,
        settings: { ...current.settings, show_minimap },
      }), true)}
    ><MinimapIcon /></Toggle></Hint>
  );
  const toggleAssetLibrary = () => {
    setAddOpen(false);
    setAgentOpen(false);
    setCreateMenu(null);
    if (libraryMode) closeLibrary();
    else setLibraryMode('prompts');
  };
  const fitAllNodes = () => {
    void runViewportCommand(() => fitView({ duration: viewportMotionMs(MOTION_DURATION.fast), padding: 0.12 }));
  };

  const canvasFeedbackVisible = !activePreview && !layerPreviewNode && !mediaOperation && !maskEdit && !angleState
    && !shortcutsOpen && !generationPreferencesOpen;

  return (
    <CanvasNodeContext.Provider value={contextValue}>
      <section
        ref={editorRegionRef}
        tabIndex={-1}
        className="canvas-editor-region relative h-full min-h-0 overflow-hidden bg-background outline-none"
        aria-label={`画布编辑器 ${projectName}`}
        onMouseDown={event => {
          // Windows 的 Chrome / Edge 在中键按下时启动浏览器自动滚动（十字光标 + 跟着鼠标滚
          // 最近的可滚动祖先），会和中键平移抢同一串事件。xyflow 的 d3-zoom 监听器直接挂在
          // pane 上、比这个 React 冒泡处理器先跑，所以在这里 preventDefault 只掐掉浏览器的
          // 默认动作，平移不受影响。只拦中键，左右键照旧。
          if (event.button === 1) event.preventDefault();
        }}
      >
        <ReactFlow<FlowNode>
          proOptions={CANVAS_PRO_OPTIONS}
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={canvasNodeTypes}
          edgeTypes={canvasEdgeTypes}
          connectionLineComponent={CanvasConnectionLine}
          attributionPosition="bottom-center"
          onSelectionStart={onSelectionStart}
          onSelectionEnd={onSelectionEnd}
          onConnect={onConnect}
          connectOnClick={false}
          connectionDragThreshold={0}
          onConnectStart={event => {
            gestureStart.current = pointerPosition(event);
            dragStarted.current = false;
          }}
          onConnectEnd={onConnectEnd}
          isValidConnection={isValidConnection}
          onEdgesChange={onEdgesChange}
          onNodesChange={onNodesChange}
          multiSelectionKeyCode={CANVAS_MULTI_SELECT_KEYS}
          // Shift 必须从 selectionKeyCode 上摘掉，否则 Pane 的 onPointerDownCapture 会在按住 Shift 时
          // 把落在节点上的 pointerdown 也吞掉去起框选（stopPropagation + preventDefault），
          // 节点根本收不到这次点击，松手时零面积框选还会把整个选择清空。
          // 框选本来就由 selectionOnDrag 接管（空白处直接拖），Shift 这一路是多余的。
          selectionKeyCode={null}
          selectNodesOnDrag={false}
          onNodeClick={(event, node) => {
            // xyflow 在 onNodeClick 之前已经按 multiSelectionKeyCode 把这次点击并进（或移出）选择集，
            // 这里再无条件调 selectOnlyNode 会立刻打平成单选——快捷键面板承诺的「Shift / ⌘ 点击追加
            // 选择」一直因此失效。取材模式不参与：那时点击的语义是「挑这一个」。
            if (!materialPick && (event.shiftKey || event.metaKey || event.ctrlKey)) return;
            selectOnlyNode(node.id);
          }}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            if (materialPick) return;
            setCreateMenu(null);
            setAddOpen(false);
            if (!latestSelectedNodeIds.current.has(node.id)) selectOnlyNode(node.id);
            setContextMenu({ x: event.clientX, y: event.clientY, flow: screenToFlowPosition({ x: event.clientX, y: event.clientY }), nodeId: node.id });
          }}
          onPaneContextMenu={event => {
            event.preventDefault();
            if (materialPick) return;
            setCreateMenu(null);
            setAddOpen(false);
            setContextMenu({ x: event.clientX, y: event.clientY, flow: screenToFlowPosition({ x: event.clientX, y: event.clientY }), nodeId: null });
          }}
          onNodeMouseEnter={(_, node) => setHoveredNodeId(node.id)}
          onNodeMouseLeave={(_, node) => setHoveredNodeId(current => current === node.id ? null : current)}
          onNodeDragStart={recordHistorySnapshot}
          onNodeDrag={(_,node,moved)=>{if (ownerRoom.connected) {
            const positions = Object.fromEntries((moved.length ? moved : [node]).map(item=>[item.id,item.position]));
            ownerPresence(Object.keys(positions),positions);
          }}}
          onNodeDragStop={()=>{if (ownerRoom.connected) ownerPresence([...selectedNodeIds]);}}
          onMoveStart={event => {
            if (!event) return;
            interruptViewportCommand();
            viewportSync.current = null;
          }}
          onPaneClick={event => {
            annotationController.exit();
            setCreateMenu(null);
            if (materialPick) {
              requestAnimationFrame(() => editorRegionRef.current?.focus());
              return;
            }
            setSelectedConnectionIds(new Set());
            setSelectedNodeIds(new Set());
            // 分组框不接指针（好让框里的连线和框选照常工作），点在框内空白或边线上的
            // 点击会落到这里：按位置找到分组并选中它。xyflow 在本回调之后还会同步清一次
            // 它自己的选择，所以放到微任务里再写。
            const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
            // 边线只有 1px，往外放 6 屏幕像素才点得中。
            const slack = 6 / getZoom();
            const group = (latestDocument.current?.nodes ?? [])
              .filter(node => node.type === 'group' && node.size
                && point.x >= node.position.x - slack && point.x <= node.position.x + node.size.width + slack
                && point.y >= node.position.y - slack && point.y <= node.position.y + node.size.height + slack)
              .sort((a, b) => a.size!.width * a.size!.height - b.size!.width * b.size!.height)[0];
            if (group) queueMicrotask(() => setSelectedNodeIds(new Set([group.id])));
            requestAnimationFrame(() => editorRegionRef.current?.focus());
          }}
          onDragOver={event => {
            const types = event.dataTransfer.types;
            // 'Files' 也要接：dragover 不 preventDefault 时 drop 事件根本不会派发，
            // 浏览器直接导航到被拖进来的文件。
            if (!types.includes('Files') && !types.includes(TEAM_ASSET_DRAG_TYPE) && !types.includes(CREATION_ASSET_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={handleCanvasDrop}
          onMoveEnd={(_, viewport: Viewport) => {
            if (latestDocument.current?.project_id !== projectId) return;
            if (pendingViewportCommand.current) return;
            const sync = viewportSync.current;
            if (sync?.projectId === projectId && sameViewport(sync.viewport, viewport)) {
              viewportSync.current = null;
              return;
            }
            viewportSync.current = null;
            commitViewportDocument(viewport);
          }}
          defaultViewport={document.viewport}
          minZoom={CANVAS_MIN_ZOOM}
          maxZoom={CANVAS_MAX_ZOOM}
          zoomOnScroll={CANVAS_WHEEL_ZOOMS}
          zoomOnPinch
          panOnScroll={!CANVAS_WHEEL_ZOOMS}
          panOnDrag={CANVAS_MOUSE_PAN_BUTTONS}
          panActivationKeyCode={['Space', 'Control']}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          deleteKeyCode={null}
          nodesDraggable
          nodesConnectable
          onlyRenderVisibleElements
          className={cn('canvas-flow canvas-flow-local', multiSelectionActive && 'canvas-flow-multiselect', connectionInProgress && 'canvas-flow-connecting')}
        >
          <CanvasZoomCssVars />
          {ownerRoom.connected && document && <RoomSelectionOverlay members={ownerRoom.members.filter(member=>member.client_id !== ownerRoom.clientId)} document={document}/>}
          {background && <Background variant={background} gap={22} size={1} />}
          <AnimatePresence initial={false}>
          {document.settings.show_minimap && !materialPick && (
            <CanvasChromeFade key="minimap">
            <MiniMap
              position="bottom-left"
              className="canvas-minimap hidden sm:block"
              pannable
              zoomable
              ariaLabel="画布小地图"
              nodeColor="var(--primary)"
              maskColor="var(--scrim)"
              onClick={(event, position) => {
                event.stopPropagation();
                void runViewportCommand(() => setCenter(position.x, position.y, { zoom: getZoom(), duration: viewportMotionMs(MOTION_DURATION.fast) }));
              }}
            />
            </CanvasChromeFade>
          )}
          </AnimatePresence>
          {createMenu?.sourceId && (
            <CanvasPendingConnection
              slot={createMenu.compareSlot}
              sourceIds={createMenu.sourceIds ?? [createMenu.sourceId]}
              handle={createMenu.sourceHandle ?? 'source'}
              to={createMenu.flow}
            />
          )}
        </ReactFlow>

        {document.nodes.length === 0 && !materialPick && (
          // 新建的画布原来是一整块空背景：没有任何东西说这里能放什么、从哪儿开始。
          // 壳不吃事件，画布照样能拖能缩放。
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-6">
            <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-xl border border-border bg-glass p-6 text-center backdrop-blur-glass shell-glow">
              <p className="text-sm font-medium text-foreground">画布还是空的</p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button size="sm" variant="outline" onClick={() => addTextNode(null)}>
                  <TextIcon aria-hidden="true" />文本节点
                </Button>
                <Button size="sm" variant="outline" onClick={() => addGenerationNode('image', null)}>
                  <ImageFileIcon aria-hidden="true" />图片节点
                </Button>
                <Button size="sm" variant="outline" onClick={() => uploadRef.current?.click()}>
                  <UploadIcon aria-hidden="true" />上传素材
                </Button>
              </div>
            </div>
          </div>
        )}

        <AnimatePresence>
        {selectedNodeIds.size > 1 && (
          <CanvasChromeFade key="multi-select" offset={-4} className="pointer-events-auto absolute left-1/2 top-20 z-30 -translate-x-1/2">
          <div
            role="toolbar"
            aria-label={`已选择 ${selectedNodeIds.size} 个节点`}
            className="flex items-center gap-1 rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow"
          >
            <span className="px-2 text-xs font-medium tabular-nums text-foreground">
              已选 {selectedNodeIds.size} 个节点
            </span>
            <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
            <Button type="button" variant="ghost" size="sm" data-canvas-shortcut="group" onClick={groupSelection}>
              <LayersIcon aria-hidden="true" />分组
            </Button>
            {hideableSelection.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={toggleSelectionHidden}>
                {hideableSelectionAllHidden
                  ? <><ShowIcon aria-hidden="true" />显示内容</>
                  : <><HideIcon aria-hidden="true" />遮盖内容</>}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={deleteSelection}
            >
              <DeleteIcon aria-hidden="true" />
              删除
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="取消多选"
              onClick={() => {
                setSelectedNodeIds(new Set());
                setSelectedConnectionIds(new Set());
                requestAnimationFrame(() => editorRegionRef.current?.focus());
              }}
            >
              <CloseIcon aria-hidden="true" />
            </Button>
          </div>
          </CanvasChromeFade>
        )}
        </AnimatePresence>

        {!materialPick && (
          <CanvasZoomDock
            assetControl={narrowViewport ? null : (
              <Button variant="bare"
                ref={assetLibraryTriggerRef}
                type="button"
                aria-pressed={Boolean(libraryMode)}
                aria-expanded={Boolean(libraryMode)}
                aria-controls="canvas-library-panel"
                className={cn(
                  'flex h-10 items-center gap-2 rounded-full pl-3 pr-4 text-sm text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&_svg]:size-4 [&_svg]:text-muted-foreground',
                  libraryMode && 'bg-secondary',
                )}
                onClick={toggleAssetLibrary}
              ><LibraryIcon aria-hidden="true" />资产</Button>
            )}
            minimapToggle={minimapToggle}
            onZoomOut={() => {
              if (getZoom() <= CANVAS_MIN_ZOOM + 0.0005) return;
              void runViewportCommand(() => zoomOut({ duration: viewportMotionMs(MOTION_DURATION.fast) }));
            }}
            onZoomIn={() => {
              if (getZoom() >= CANVAS_MAX_ZOOM - 0.0005) return;
              void runViewportCommand(() => zoomIn({ duration: viewportMotionMs(MOTION_DURATION.fast) }));
            }}
            onResetZoom={() => {
              if (Math.abs(getZoom() - 1) < 0.001) return;
              void runViewportCommand(() => zoomTo(1, { duration: viewportMotionMs(MOTION_DURATION.fast) }));
            }}
            onFitView={fitAllNodes}
          />
        )}

        {materialPick && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-primary py-1 pl-4 pr-1 text-xs font-medium text-primary-foreground shell-glow sm:top-4"
          >
            <span>从画布选择参考</span>
            <Button variant="bare"
              type="button"
              aria-label="退出画布参考选择"
              className="rounded-full bg-background/20 px-2.5 py-1 text-primary-foreground transition-colors hover:bg-background/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground"
              onClick={() => {
                setMaterialPick(null);
                requestAnimationFrame(() => editorRegionRef.current?.focus());
              }}
            >
              退出
            </Button>
          </div>
        )}

        <div className="canvas-editor-top pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-start gap-2 p-2 sm:gap-3 sm:p-3 md:p-4">
          <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
            <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="返回画布项目列表" onClick={() => leaveCanvas(onBack)}><BackIcon /></Button>
            <div className="h-6 w-px bg-border" />
            <SharedStatusButton shares={ownShares} refresh={refreshShares} />
            <RoomPresence members={ownerRoom.members}/>
            <div className="flex min-w-0 items-center">
                <EditableText
                  ref={projectNameEditorRef}
                  value={projectName}
                  triggerLabel={`重命名画布项目 ${projectName}`}
                  inputLabel="画布项目名称"
                  className="max-w-28 font-medium text-foreground sm:max-w-52"
                  onSave={saveProjectName}
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground data-[state=open]:bg-secondary" aria-label="切换画布项目">
                      <ChevronDownIcon aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="bottom" align="start" className="min-w-44 rounded-xl">
                    <DropdownMenuLabel>切换项目</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={projectId}
                      onValueChange={value => {
                        if (value === projectId) return;
                        leaveCanvas(() => onSwitchProject(value));
                      }}
                    >
                      {projects.map(project => (
                        <DropdownMenuRadioItem key={project.project_id} value={project.project_id}>
                          <span className="max-w-52 truncate">{project.name}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button ref={canvasMenuTriggerRef} variant="ghost" size="icon" className="size-8 shrink-0 data-[state=open]:bg-secondary" aria-label="画布菜单">
                      <MoreIcon aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="bottom" align="start" className="w-48 rounded-xl">
                    {/* U1：不放常驻撤销按钮，撤销 / 重做在画布菜单与右键菜单里，带快捷键提示。 */}
                    <DropdownMenuItem className="gap-2" disabled={!canUndo} onSelect={undo}>
                      <UndoIcon aria-hidden="true" />撤销<MenuShortcut keys={CANVAS_UNDO_KEYS} />
                    </DropdownMenuItem>
                    <DropdownMenuItem className="gap-2" disabled={!canRedo} onSelect={redo}>
                      <RedoIcon aria-hidden="true" />重做<MenuShortcut keys={CANVAS_REDO_KEYS} />
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="gap-2" onSelect={beginProjectRename}>
                      <EditIcon aria-hidden="true" />重命名
                    </DropdownMenuItem>
                    <DropdownMenuItem className="gap-2" onSelect={() => setReferencesOpen(true)}><LibraryIcon />项目参考库</DropdownMenuItem>
                    <DropdownMenuItem className="gap-2" onSelect={() => setSpecsOpen(true)}>
                      <TextFileIcon aria-hidden="true" />规范
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="gap-2"
                      onSelect={() => {
                        setAddOpen(false);
                        setCreateMenu(null);
                        openGenerationPreferences('image');
                      }}
                    >
                      <ParamsIcon aria-hidden="true" />生成偏好
                    </DropdownMenuItem>
                    <DropdownMenuItem className="gap-2" onSelect={() => setShortcutsOpen(true)}>
                      <HelpIcon aria-hidden="true" />快捷键
                    </DropdownMenuItem>
                    <CanvasCopyForAgentItem name={projectName} projectId={projectId} />
                    {/* 沉浸式画布把整条顶栏（含设置入口）藏了：没有密钥的新用户在画布里点不动「生成」，
                        也没有任何地方能去配置。这一项是画布内唯一的全局设置出口。 */}
                    <DropdownMenuItem asChild className="gap-2">
                      <Link href="/settings/providers"><SettingsIcon aria-hidden="true" />设置</Link>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>主题</DropdownMenuLabel>
                    <CanvasThemeSelector />
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>画布背景</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={document.settings.background}
                      onValueChange={value => {
                        if (value !== 'none' && value !== 'dots' && value !== 'lines') return;
                        if (value === document.settings.background) return;
                        commitDisplaySetting({ background: value });
                      }}
                    >
                      {([
                        ['none', '空白', BlankIcon],
                        ['dots', '点阵', DotGridIcon],
                        ['lines', '线框', GridIcon],
                      ] as const).map(([value, label, Icon]) => (
                        <DropdownMenuRadioItem key={value} value={value} className="gap-2">
                          <Icon aria-hidden="true" />{label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem
                      checked={document.settings.show_image_info}
                      className="gap-2"
                      onCheckedChange={checked => commitDisplaySetting({ show_image_info: checked })}
                    >
                      <InfoIcon aria-hidden="true" />显示图片信息
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
          </div>
          {/* 正常保存不打扰（飙哥 2026-09-30 去掉「已保存 · vN」）。失败后先静默退避重试，1.5s 后才露出
              中性胶囊；15s 或连续 4 次仍不成转警示色并给「立即重试」（规格 2.4）。原因在 Hint 里。 */}
          {saveState === 'error' && (saveRetryPhase === 'retrying' || saveRetryPhase === 'stuck') && (
            <div
              aria-live="polite"
              className={cn(
                'pointer-events-auto flex max-w-40 items-center gap-2 truncate rounded-full border bg-glass py-1 pl-3 pr-1 text-xs backdrop-blur-glass shell-glow sm:max-w-none',
                saveRetryPhase === 'stuck' ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground',
              )}
            >
              <Hint label={saveErrorDetail ?? undefined}><span>{saveRetryPhase === 'stuck' ? '保存失败' : '保存重试中…'}</span></Hint>
              {saveRetryPhase === 'stuck' && (
                <Button variant="ghost" size="sm" className="h-7 rounded-full px-2.5 text-xs"
                  onClick={() => void flushSave().catch(() => undefined)}>立即重试</Button>
              )}
            </div>
          )}
          <AnimatePresence initial={false}>
          {runningNodeIds.length > 0 && (
            <CanvasChromeFade key="running" className="pointer-events-auto ml-auto shrink-0 rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
              {/* 「生成中 N」展开进行中的清单：逐项定位 / 停止，另有「全部停止」止损（批量提交后发现提示词写错）。 */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" className="h-9 gap-2 px-3 font-normal" aria-label={`生成中 ${runningNodeIds.length} 项`}>
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                    生成中
                    <span className="text-xs tabular-nums text-muted-foreground">{runningNodeIds.length}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-1">
                  <div role="list" aria-label="生成中的节点" className="max-h-72 overflow-y-auto">
                    {runningNodeIds.map(nodeId => {
                      const node = document.nodes.find(item => item.id === nodeId);
                      const job = node ? canvasNodeRunState(node, jobsByRunId, jobsByResultNodeId).job : undefined;
                      const runId = job?.canvas_run?.run_id;
                      return (
                        <div key={nodeId} role="listitem" className="flex items-center gap-1 rounded-md pl-2 hover:bg-secondary/60">
                          <Button variant="ghost" size="sm" className="h-8 min-w-0 flex-1 justify-start px-0 font-normal"
                            onClick={() => void runViewportCommand(() => fitView({
                              nodes: [{ id: nodeId }],
                              duration: viewportMotionMs(MOTION_DURATION.fast),
                              padding: 0.4,
                              maxZoom: 1,
                            }))}>
                            <span className="truncate">{node?.title ?? nodeId}</span>
                          </Button>
                          {runId && (
                            <Hint label={job?.cancel_requested_at ? '停止中…' : '停止'}><Button variant="ghost" size="icon" className="size-8 shrink-0"
                              aria-label={`停止 ${node?.title ?? ''} 的生成`} disabled={Boolean(job?.cancel_requested_at)}
                              onClick={() => void cancelRun(runId)}>
                              <StopIcon size="sm" aria-hidden="true" />
                            </Button></Hint>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-1 border-t border-border pt-1">
                    <Button variant="ghost" size="sm" className="h-8 w-full justify-center text-destructive hover:text-destructive"
                      onClick={() => {
                        cancelQueuedSubmissions();
                        for (const nodeId of runningNodeIds) {
                          const node = document.nodes.find(item => item.id === nodeId);
                          const job = node ? canvasNodeRunState(node, jobsByRunId, jobsByResultNodeId).job : undefined;
                          const runId = job?.canvas_run?.run_id;
                          if (runId && !job?.cancel_requested_at) void cancelRun(runId);
                        }
                      }}>全部停止</Button>
                  </div>
                </PopoverContent>
              </Popover>
            </CanvasChromeFade>
          )}
          </AnimatePresence>
          <div className={cn('pointer-events-auto shrink-0 rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow', runningNodeIds.length === 0 && 'ml-auto')}>
            {/* 状态点从会话列表读，面板关着也看得见：运行中只点不配字，待确认用强调色加「待确认」。 */}
            <Hint label={agentIndicator === 'running' ? '运行中…' : agentIndicator === 'awaiting' ? '有待确认的操作' : undefined}>
              <Button
                variant="ghost"
                aria-label={agentIndicator === 'awaiting' ? 'Agent（待确认）' : agentIndicator === 'running' ? 'Agent（运行中）' : 'Agent'}
                aria-expanded={agentOpen && !agentHidden}
                aria-controls="canvas-agent-panel"
                onClick={toggleAgent}
                className={cn('h-9 gap-1.5 px-3', agentOpen && !agentHidden && 'bg-secondary text-primary hover:text-primary')}
              >
                <AiIcon />Agent
                {agentIndicator === 'running' && (
                  <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
                )}
                {agentIndicator === 'awaiting' && (
                  <span className="flex items-center gap-1 text-xs text-primary">
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />待确认
                  </span>
                )}
              </Button>
            </Hint>
          </div>
        </div>

        {!materialPick && (
          <div className="canvas-mobile-rail absolute left-3 top-1/2 z-20 flex max-h-[calc(100dvh-8rem)] -translate-y-1/2 flex-col items-center gap-1 overflow-y-auto rounded-full border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow md:contents md:max-h-none md:overflow-visible">
          <div className="canvas-tool-dock contents md:absolute md:z-20 md:flex md:max-h-[calc(100dvh-17rem)] md:flex-col md:items-center md:gap-0 md:overflow-y-auto md:rounded-full md:border md:border-border md:bg-glass md:p-1.5 md:backdrop-blur-glass md:shell-glow">
            <span className="xl:hidden">
              <ToolButton buttonRef={addTriggerRef} label={addOpen ? '关闭添加菜单' : '添加节点'} active={addOpen} expanded={addOpen} controlsId="canvas-add-menu" onClick={() => { setCreateMenu(null); setAddOpen(value => !value); }}><SwapIcon swapKey={addOpen}>{addOpen ? <CloseIcon /> : <AddIcon />}</SwapIcon></ToolButton>
            </span>
            <ToolButton label="选择工具" active={!addOpen && !createMenu} onClick={() => { setAddOpen(false); setCreateMenu(null); }}><SelectIcon /></ToolButton>
            <div className="my-1 h-px w-7 bg-border" />
            <div className="hidden xl:contents">
              {/* 按使用频率排：文本、图片、视频、上传，再是语音、音乐，低频的对比放最后。 */}
              <ToolButton label="添加文本节点" onClick={() => addTextNode(null)}><TextIcon /></ToolButton>
              <ToolButton label="添加图片节点" onClick={() => addGenerationNode('image', null)}><ImageFileIcon /></ToolButton>
              <ToolButton label="添加视频节点" onClick={() => addGenerationNode('video', null)}><VideoFileIcon /></ToolButton>
              <ToolButton label="上传素材" onClick={() => uploadRef.current?.click()}><UploadIcon /></ToolButton>
              <ToolButton label="添加语音节点" onClick={() => addGenerationNode('audio', null, 'speech')}><AudioFileIcon /></ToolButton>
              <ToolButton label="添加音乐节点" onClick={() => addGenerationNode('audio', null, 'music')}><MusicFileIcon /></ToolButton>
              <ToolButton label="添加对比节点" onClick={() => addCompareNode(null)}><CompareIcon /></ToolButton>
              <PluginCanvasActionItems hostPlugins={hostPlugins} onRun={runPluginCanvasAction} layout="toolbar" />
            </div>
          </div>
          {/* 窄屏没有底部两组浮条，视图与资产入口并进这条工具栏。 */}
          {narrowViewport && (
            <div className="contents">
              <ToolButton label="适应全部节点" onClick={fitAllNodes}><ExpandIcon /></ToolButton>
              {minimapToggle}
              <ToolButton buttonRef={assetLibraryTriggerRef} label="资产" active={Boolean(libraryMode)} expanded={Boolean(libraryMode)} controlsId="canvas-library-panel" popup={false} onClick={toggleAssetLibrary}><LibraryIcon /></ToolButton>
            </div>
          )}
          <AnimatePresence>
          {addOpen && (
            <motion.div
              key="add-menu"
              ref={addMenuRef} id="canvas-add-menu" role="menu" aria-label="添加节点" onKeyDown={handleMenuNavigation}
              // 进场沿用 popover-in；退场 150ms 淡出（.canvas-add-menu 在宽屏自带 translateY 定位，只动透明度）。
              exit={motionAvailable() ? { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } } : undefined}
              className="canvas-add-menu popover-in absolute left-14 top-0 w-56 rounded-xl border border-border bg-popover p-2 shell-glow"
            >
              <p className="px-2 pb-2 pt-1 text-xs text-muted-foreground">添加节点</p>
              <CanvasCreateMenuItems allowEmptyNodes allowUpload onAddCompare={() => addCompareNode(null)} onAddText={() => addTextNode(null)} onAddImage={() => addGenerationNode('image', null)} onAddVideo={() => addGenerationNode('video', null)} onAddAudio={() => addGenerationNode('audio', null, 'speech')} onAddMusic={() => addGenerationNode('audio', null, 'music')} onUpload={() => uploadRef.current?.click()} />
              <PluginCreateMenuItems onAdd={addPluginNode} />
              <PluginCanvasActionItems hostPlugins={hostPlugins} onRun={runPluginCanvasAction} />
            </motion.div>
          )}
          </AnimatePresence>
          </div>
        )}

        <FileInput ref={uploadRef} multiple aria-label="选择上传素材" className="sr-only" accept="image/*,video/*,audio/*" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; handleUploads(files); }} />
        <FileInput
          ref={replaceMediaRef}
          className="sr-only"
          multiple={Boolean(mediaReplaceTarget && !mediaReplaceTarget.hadContent)}
          aria-label={mediaReplaceTarget
            ? mediaReplaceTarget.hadContent ? '选择替换媒体' : '选择上传媒体'
            : '选择节点媒体文件'}
          accept={mediaReplaceTarget ? replacementAccept(mediaReplaceTarget.kind) : undefined}
          onChange={event => {
            const files = Array.from(event.target.files ?? []);
            const target = mediaReplaceTarget;
            if (files.length && target && !target.hadContent) {
              const node = latestDocument.current?.nodes.find(node => node.id === target.nodeId);
              const flow = node ? { x: node.position.x + (node.size?.width ?? CANVAS_DEFAULT_NODE_SIZE.width) + 32, y: node.position.y } : defaultPosition();
              handleUploads(files, { screen: { x: 0, y: 0 }, flow }, target);
            } else if (files[0] && target) void handleMediaReplace(files[0], target);
            else setMediaReplaceTarget(null);
            event.target.value = '';
          }}
        />

        {contextMenu && (
          <CanvasContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            label={contextMenu.nodeId ? '节点菜单' : '画布菜单'}
            onClose={closeContextMenu}
            items={contextMenu.nodeId ? nodeContextMenuItems() : paneContextMenuItems(contextMenu.flow, contextMenu)}
          />
        )}

        {/* 「创建并连接」：在松手处 150ms 淡入放大，关掉 150ms 淡出。left / top 管位置（平移时直接改写），动画只动透明度与缩放。 */}
        <AnimatePresence>
        {createMenu && (
          <motion.div
            key="create-menu"
            ref={createMenuRef} role="menu" aria-label="连接创建节点" onKeyDown={handleMenuNavigation}
            initial={motionAvailable() ? { opacity: 0, scale: prefersReducedMotion() ? 1 : 0.96 } : false}
            animate={{ opacity: 1, scale: 1, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.out } }}
            exit={motionAvailable() ? { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } } : undefined}
            className={cn('fixed z-20 max-h-[calc(100dvh-1.5rem)] w-56 overflow-y-auto rounded-xl border border-border bg-popover p-2 shell-glow', createMenu.sourceHandle === 'target' ? 'origin-right' : 'origin-left')}
            style={{ visibility: 'hidden' }}
          >
            <div className="flex items-center justify-between px-2 pb-2 pt-1"><p className="text-xs text-muted-foreground">{createMenu.sourceHandle === 'target' ? '添加上游节点' : '添加下游节点'}</p><Button variant="bare" type="button" aria-label="关闭连接创建菜单" onClick={() => { setCreateMenu(null); requestAnimationFrame(() => editorRegionRef.current?.focus()); }} className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><CloseIcon /></Button></div>
            <CanvasCreateMenuItems allowedTypes={createMenu.sourceHandle === 'target' && createMenu.sourceId
              ? canvasUpstreamNodeTypesForTarget(document, createMenu.sourceId) : undefined} {...canvasConnectionCreationCapabilities(createMenu.sourceHandle ?? 'source')} onAddCompare={createMenuFromImage ? () => addCompareNode(createMenu) : undefined} rejectedModes={createMenu.sourceHandle === 'target' || !createMenu.sourceId ? undefined : canvasModesRejectingSources(document, createMenu.sourceIds ?? [createMenu.sourceId])} onAddText={() => addTextNode(createMenu)} onAddImage={() => addGenerationNode('image', createMenu)} onAddVideo={() => addGenerationNode('video', createMenu)} onAddAudio={() => addGenerationNode('audio', createMenu, 'speech')} onAddMusic={() => addGenerationNode('audio', createMenu, 'music')} onUpload={() => uploadRef.current?.click()} />
          </motion.div>
        )}
        </AnimatePresence>

        {/* 资产库与 Agent 面板：窄屏共用右侧一个位置（互切时交叉淡化）；宽屏并列，资产库挪到左侧。 */}
        <AnimatePresence initial={false}>
        {libraryMode && (
          <CanvasSidePanelMotion key="library">
          <AssetPanel
            key={libraryPanelKey}
            className={cn('canvas-library-panel', wideViewport && agentOpen && 'left-20! right-auto!')}
            projectId={projectId}
            openLibrary={libraryMode === 'team'}
            saveRequest={creationAssetSaveRequest}
            onSaveRequestHandled={requestId => {
              setCreationAssetSaveRequest(current => current?.requestId === requestId ? null : current);
            }}
            onClose={closeLibrary}
            onSubject={selectedNode && selectedDraft ? token => {
              commit(current => ({ ...current, nodes: current.nodes.map(node => node.id === selectedNode.id
                ? withGenerationDraftForNode(node, { ...selectedDraft, prompt: [selectedDraft.prompt, token].filter(Boolean).join(' '),
                  updated_at: new Date().toISOString() }) : node) }), true);
            } : undefined}
            onHistoryReference={async (items, placeOnCanvas) => {
              const kinds = new Map<File, HistoryKind>();
              for (const item of items) kinds.set(await item.read(), item.kind);
              const files = Array.from(kinds.keys());
              if (latestDocument.current?.project_id !== projectId) return;
              const size = { ...CANVAS_DEFAULT_NODE_SIZE, width: files.length * CANVAS_DEFAULT_NODE_SIZE.width + (files.length - 1) * 32 };
              const menu: CreateMenuState = { screen: { x: 0, y: 0 }, flow: defaultPosition(size),
                ...(!placeOnCanvas && selectedNode && selectedDraft ? { sourceId: selectedNode.id, sourceHandle: 'target' as const } : {}) };
              await handleUploads(files, menu, undefined, '已放到画布', kinds);
            }}
          />
          </CanvasSidePanelMotion>
        )}

        {agentOpen && (
          <CanvasSidePanelMotion key="agent">
          <CanvasAgentPanel
            key={projectId}
            className={cn('canvas-library-panel', agentHidden && 'hidden')}
            projectId={projectId}
            selectedNodes={document.nodes
              .filter(node => selectedNodeIds.has(node.id))
              .map(node => ({
                id: node.id, title: node.title, type: node.type,
                versionId: node.type === 'image' ? node.data.current_version_id : null,
              }))}
            onClose={() => setAgentOpen(false)}
            onUpload={() => uploadRef.current?.click()}
            onOpenKeySettings={() => leaveCanvas(() => setLocation('/settings/providers'))}
            onLocateNode={locateNode}
          />
          </CanvasSidePanelMotion>
        )}
        </AnimatePresence>

        <Dialog open={referencesOpen} onOpenChange={setReferencesOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogTitle>项目参考库</DialogTitle>
          {referencesOpen && <ProjectReferenceLibrary visible projectId={projectId} refreshKey={assetsRevision} onAssetsChanged={refreshProjectAssets}
            onOpen={setReferencePreview} onUse={asset => { void insertCreationAsset(asset.asset_id, {}, selectedNode && selectedDraft ? selectedNode.id : undefined); }} />}
        </DialogContent></Dialog>
        <Dialog open={!!referencePreview} onOpenChange={open => { if (!open) setReferencePreview(null); }}><DialogContent>
          <DialogTitle>{referencePreview?.title}</DialogTitle>
          {referencePreview && assetMediaContent(referencePreview) && <MediaPreview assetId={referencePreview.asset_id}
            content={assetMediaContent(referencePreview)!} alt={referencePreview.title} className="max-h-[75vh] w-full object-contain" />}
        </DialogContent></Dialog>
        {specsOpen && <ProjectSpecsDrawer key={projectId} projectId={projectId} onClose={() => setSpecsOpen(false)} />}

        <TeamShareDialog
          request={shareRequest}
          projectId={projectId}
          onClose={() => setShareRequest(null)}
          onShared={(_entry, libraryName) => announceToolNotice(`已分享到 ${libraryName}`)}
        />

        {narrowViewport && generationPanelOpen && selectedNode && selectedDraft && (
          <CanvasMobileGenerationPanel
            node={selectedNode}
            draft={selectedDraft}
            context={contextValue}
          />
        )}

        {/* 报错条与操作提示：出现 150ms 淡入下移 4px，消失 150ms 淡出（退场期间保留最后一份内容）。 */}
        <AnimatePresence>
          {canvasFeedbackVisible && error && (
            <CanvasChromeFade key="error" offset={-4} className="absolute left-1/2 top-20 z-30 w-full max-w-lg -translate-x-1/2 px-3">
              <CanvasActionFeedback
                error={error}
                notice={null}
                action={errorAction && errorAction.message === error ? errorAction : null} onDismissError={() => setError(null)}
                className="items-center"
              />
            </CanvasChromeFade>
          )}
          {canvasFeedbackVisible && toolNotice && (
            <CanvasChromeFade key="notice" offset={-4} className="absolute right-3 top-20 z-30 max-w-sm md:right-4">
              <CanvasActionFeedback
                error={null}
                notice={toolNotice}
                noticeAction={toolNoticeAction}
                action={errorAction && errorAction.message === error ? errorAction : null} onDismissError={() => setError(null)}
                className="items-end"
              />
            </CanvasChromeFade>
          )}
          {canvasFeedbackVisible && historyHint && (
            <CanvasChromeFade key={`history:${historyHint.key}`} className={cn('pointer-events-none absolute z-30', CANVAS_HISTORY_HINT_POSITION[historyHint.direction])}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="pointer-events-auto rounded-full font-normal tabular-nums"
                onClick={() => {
                  const { bounds } = historyHint;
                  setHistoryHint(null);
                  void runViewportCommand(() => setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
                    zoom: getZoom(),
                    duration: viewportMotionMs(MOTION_DURATION.slow),
                    ease: CANVAS_VIEWPORT_EASE_IN_OUT,
                    // 只平移：默认的 smooth 插值远距离时会先拉远再推近。
                    interpolate: 'linear',
                  }));
                }}
              >{historyHint.label}</Button>
            </CanvasChromeFade>
          )}
        </AnimatePresence>

        {maskEdit && (
          <MaskEditor
            key={`${projectId}:${maskEdit.nodeId}:${maskEdit.version.version_id}`}
            open={maskEdit.open}
            title={maskEditSourceTitle ?? maskEdit.title}
            version={maskEdit.version}
            mediaUrl={localCanvasTransport.mediaUrl(projectId, maskEdit.version.version_id)}
            keys={keys}
            initialData={maskEditData}
            busy={maskEditBusy}
            error={maskEditError}
            onOpenChange={open => {
              if (!open && !maskEditBusy) {
                setMaskEdit(null);
                setMaskEditError(null);
              }
            }}
            onSave={submission => saveMaskEdit(submission)}
            onSubmit={submission => saveMaskEdit(submission, true)}
          />
        )}

        {angleState && (
          <CanvasAngleDialog
            open
            title={angleState.title}
            mediaUrl={localCanvasTransport.mediaUrl(projectId, angleState.version.version_id)}
            busy={angleBusy}
            error={angleError}
            onOpenChange={open => {
              if (!open && !angleBusy) {
                setAngleState(null);
                setAngleError(null);
              }
            }}
            onSubmit={params => void submitAngle(params)}
          />
        )}

        <Dialog open={shortcutsOpen} onOpenChange={open => {
          setShortcutsOpen(open);
          if (!open) requestAnimationFrame(() => canvasMenuTriggerRef.current?.focus());
        }}>
          <DialogContent id="canvas-shortcuts-dialog" className="max-h-[88dvh] max-w-xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>画布快捷键</DialogTitle>
              <DialogDescription>节点编辑、视口导航与剪贴板操作</DialogDescription>
            </DialogHeader>
            <CanvasShortcutList />
          </DialogContent>
        </Dialog>

        <CanvasGenerationPreferencesDialog
          open={generationPreferencesOpen}
          value={canvasUiPreferences.generation_defaults}
          upscale={canvasUiPreferences.upscale}
          initialTab={generationPreferencesTab}
          keys={keys}
          generationProviders={providers}
          saving={generationPreferencesSaving}
          error={canvasUiPreferencesError}
          onOpenChange={open => {
            setGenerationPreferencesOpen(open);
            if (!open) requestAnimationFrame(() => canvasMenuTriggerRef.current?.focus());
          }}
          onSave={(value, upscale) => void persistGenerationPreferences(value, upscale)}
        />

        {mediaOperation && (
          <CanvasMediaOperationDialog
            open
            tool={mediaOperation.tool}
            title={mediaOperation.title}
            version={mediaOperation.version}
            mediaUrl={localCanvasTransport.mediaUrl(projectId, mediaOperation.version.version_id)}
            busy={mediaOperationBusy}
            error={mediaOperationError}
            updatesMaterial={layerMaterialNodeIds(document).has(mediaOperation.nodeId)}
            onOpenChange={open => {
              if (!open) {
                setMediaOperation(null);
                setMediaOperationError(null);
              }
            }}
            onSubmit={operation => void submitMediaOperation(operation)}
          />
        )}

        {mattingPrompt && (
          <CanvasMattingModelDialog
            open
            bytes={mattingPrompt.bytes}
            downloading={mattingDownloading}
            onCancel={() => {
              if (!mattingDownloading) setMattingPrompt(null);
            }}
            onConfirm={() => void confirmMattingDownload()}
          />
        )}

        <Dialog open={layerPreviewNode?.type === 'layer_stack'} onOpenChange={open => { if (!open) setLayerPreviewId(null); }}>
          {layerPreviewNode?.type === 'layer_stack' && <CanvasLayerStackPreview key={layerPreviewNode.id}
            node={layerPreviewNode} projectId={projectId} resolveVersion={resolveVersion}
            onCloseAutoFocus={event => { event.preventDefault(); restoreCanvasNodeFocus(layerPreviewNode.id); }} />}
        </Dialog>
        <Dialog open={compareViewNode?.type === 'compare'} onOpenChange={open => { if (!open) setCompareViewId(null); }}>
          {compareViewNode?.type === 'compare' && (
            <DialogContent className="max-w-[min(92vw,96rem)] gap-3 p-3"
              onCloseAutoFocus={event => { event.preventDefault(); restoreCanvasNodeFocus(compareViewNode.id); }}>
              <DialogHeader className="px-1">
                <DialogTitle>{compareViewNode.title}</DialogTitle>
                <DialogDescription className="sr-only">拖动分界对照原图与结果</DialogDescription>
              </DialogHeader>
              <div className="h-[80dvh] overflow-hidden rounded-md">
                <CanvasCompareSurface projectId={projectId} title={compareViewNode.title}
                  beforeVersionId={compareViewInputs?.before?.versionId ?? null}
                  afterVersionId={compareViewInputs?.after?.versionId ?? null}
                  afterSize={compareViewAfterSize} frame={compareViewFrame} bitmapWidth={null} />
              </div>
            </DialogContent>
          )}
        </Dialog>
        {preview && <CanvasPreview
          projectId={projectId}
          preview={preview}
          dialogOpen={Boolean(dialogPreview)}
          onClose={() => setPreview(null)}
          onPrevious={stepPreview(-1)} onNext={stepPreview(1)}
          onEdit={editablePreview ? () => { setPreview(null); openMaskEdit(editablePreview); } : undefined}
          onReference={editablePreview ? () => { setPreview(null); createImageFromSource(editablePreview.id); } : undefined}
          feedback={<CanvasActionFeedback error={error} notice={toolNotice} action={errorAction && errorAction.message === error ? errorAction : null} onDismissError={() => setError(null)} />}
          onReproduce={preview.version.frozen_generation ? () => {
            const snapshot = preview.version.frozen_generation!;
            const candidates = keys.filter(key => key.models.some(item => item.id === snapshot.model_id));
            const key = candidates.find(item => item.provider === snapshot.provider) ?? candidates[0];
            void applyServerInsertion(revision => reproduceFrozen(projectId, preview.version.version_id,
              revision, defaultPosition(), key?.alias ?? null, key ? snapshot.model_id : null),
            { placement: 'group' }).then(inserted => {
              if (!inserted) return;
              setPreview(null);
              if (!key) announceToolNotice(`原模型为 ${snapshot.model_name || snapshot.model_id}（${snapshot.provider_label || snapshot.provider}），请选择本机可用模型`);
            });
          } : undefined}
          job={previewJob}
          nodes={document.nodes}
          onCopyPrompt={previewNode && previewPrompt && isContentNode(previewNode)
            ? () => void copyPrompt(previewNode)
            : undefined}
        />}
      </section>
    </CanvasNodeContext.Provider>
  );
}

/** 已启用插件贡献的节点类型，排在内置项之后；副标题用插件清单的一句话说明。没有启用的插件时什么都不渲染。 */
function PluginCreateMenuItems({ onAdd }: { onAdd: (plugin: PluginPackageLock, node: PluginNodeContribution) => void }) {
  const plugins = usePlugins();
  return <>
    {enabledPlugins(plugins).flatMap(plugin => plugin.contributes.nodes.map(node => {
      const Icon = pluginIcon(node.icon);
      return <AddMenuButton key={`${plugin.id}:${node.type}`} icon={<Icon />} title={node.title}
        description={plugin.description} onClick={() => onAdd(plugin, node)} />;
    }))}
  </>;
}

function CanvasCreateMenuItems({ allowedTypes, allowEmptyNodes, allowUpload, rejectedModes, onAddText, onAddImage, onAddVideo, onAddAudio, onAddMusic, onUpload, onAddCompare }: {
  allowedTypes?: ReadonlySet<string>;
  onAddCompare?: () => void;
  /** 连出来的素材里有这些模式收不下的类型：对应选项置灰。 */
  rejectedModes?: ReadonlySet<string>;
  allowEmptyNodes: boolean;
  allowUpload: boolean;
  onAddText: () => void;
  onAddImage: () => void;
  onAddVideo: () => void;
  onAddAudio: () => void;
  onAddMusic: () => void;
  onUpload: () => void;
}) {
  return <>
    {allowEmptyNodes && (!allowedTypes || allowedTypes.has('text')) && <AddMenuButton icon={<TextIcon />} title="文本" description="脚本、提示词与备注" onClick={onAddText} />}
    {allowEmptyNodes && (!allowedTypes || allowedTypes.has('image')) && <AddMenuButton icon={<ImageFileIcon />} title="图片" description="空节点可填写生成设置" onClick={onAddImage} disabledReason={rejectedModes?.has('image') ? '图片生成只能参考文本和图片' : undefined} />}
    {allowEmptyNodes && (!allowedTypes || allowedTypes.has('video')) && <AddMenuButton icon={<VideoFileIcon />} title="视频" description="空节点可填写生成设置" onClick={onAddVideo} />}
    {allowEmptyNodes && (!allowedTypes || allowedTypes.has('audio')) && <AddMenuButton icon={<AudioFileIcon />} title="语音" description="旁白与配音" onClick={onAddAudio} disabledReason={rejectedModes?.has('audio') ? '音频生成只能参考文本' : undefined} />}
    {allowEmptyNodes && (!allowedTypes || allowedTypes.has('audio')) && <AddMenuButton icon={<MusicFileIcon />} title="音乐" description="配乐与歌曲" onClick={onAddMusic} disabledReason={rejectedModes?.has('audio') ? '音频生成只能参考文本' : undefined} />}
    {onAddCompare && <AddMenuButton icon={<CompareIcon />} title="对比" description="左右拖动对照两张图" onClick={onAddCompare} />}
    {allowUpload && <AddMenuButton icon={<UploadIcon />} title="上传素材" description="图片、视频或音频" onClick={onUpload} />}
  </>;
}

const CANVAS_MOD_KEY = /Mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl';
const CANVAS_UNDO_KEYS = `${CANVAS_MOD_KEY} Z`;
const CANVAS_REDO_KEYS = `${CANVAS_MOD_KEY} ⇧ Z`;

/** 菜单项右侧的快捷键提示。 */
function MenuShortcut({ keys }: { keys: string }) {
  return <span aria-hidden="true" className="ml-auto pl-4 font-mono text-xs text-muted-foreground">{keys}</span>;
}

const CANVAS_SHORTCUTS = [
  { keys: ['鼠标中键', '拖动'], label: '平移画布' },
  { keys: ['Space / Ctrl', '拖动'], label: '临时平移画布' },
  { keys: ['鼠标滚轮'], label: '缩放画布' },
  { keys: ['触控板双指'], label: '滑动平移 / 捏合缩放' },
  { keys: ['空白拖动'], label: '框选多个节点' },
  { keys: ['Shift / ⌘', '点击'], label: '追加选择节点' },
  { keys: ['⌘ / Ctrl', 'A'], label: '全选节点' },
  { keys: ['⌘ / Ctrl', 'G'], label: '选中节点打组' },
  { keys: ['⌘ / Ctrl', 'C / V'], label: '复制 / 粘贴节点' },
  { keys: ['⌘ / Ctrl', 'Z'], label: '撤销' },
  { keys: ['⌘ / Ctrl', 'Shift', 'Z'], label: '重做' },
  { keys: ['⌘ / Ctrl', 'Y'], label: '重做' },
  { keys: ['⌘ / Ctrl', '↵'], label: '生成（在提示词框里）' },
  { keys: [CANVAS_DELETE_KEYS.join(' / ')], label: '删除选中节点或连接' },
  { keys: ['Esc'], label: '关闭浮层或清空选择' },
  { keys: ['粘贴文本 / 图片'], label: '从系统剪贴板创建节点' },
  { keys: ['拖入图片 / 视频 / 音频'], label: '上传到画布' },
] as const;

function CanvasShortcutList() {
  return (
    <div role="list" aria-label="画布快捷键列表" className="divide-y divide-border rounded-lg border border-border bg-background px-3">
      {CANVAS_SHORTCUTS.map(item => (
        <div key={`${item.keys.join('-')}-${item.label}`} role="listitem" className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(9rem,0.7fr)] sm:items-center">
          <div className="flex flex-wrap items-center gap-1.5">
            {item.keys.map((key, index) => (
              <span key={`${key}-${index}`} className="contents">
                {index > 0 && <span aria-hidden="true" className="text-xs text-muted-foreground">+</span>}
                <kbd className="rounded-md border border-border bg-secondary px-2 py-1 font-mono text-xs text-foreground">{key}</kbd>
              </span>
            ))}
          </div>
          <p className="text-sm text-muted-foreground sm:text-right">{item.label}</p>
        </div>
      ))}
    </div>
  );
}

function CanvasPreview({
  dialogOpen, onClose, onPrevious, onNext, onEdit, onReference, feedback, onReproduce,
  projectId,
  preview,
  job,
  nodes,
  onCopyPrompt,
}: {
  projectId: string;
  preview: PreviewState;
  dialogOpen: boolean;
  feedback: ReactNode;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onEdit?: () => void;
  onReference?: () => void;
  onReproduce?: () => void;
  job?: Job;
  nodes: CanvasNode[];
  onCopyPrompt?: () => void;
}) {
  const { version } = preview;
  const [showSource, setShowSource] = useState(false);
  const [showMask, setShowMask] = useState(false);
  useEffect(() => { setShowMask(false); setShowSource(false); }, [version.version_id]);
  const maskId = job?.canvas_run?.snapshot.mask_version_id;
  const edit = job?.canvas_run?.snapshot.normalized_params.image_edit as {
    source_version_id?: string; mode?: string; width?: number; height?: number; x?: number; y?: number;
    source_width?: number; source_height?: number;
  } | undefined;
  const src = version.kind === 'text' ? null : localCanvasTransport.mediaUrl(projectId, version.version_id);
  const metadata = <>
    <dl className="grid gap-2 rounded-lg border border-border bg-background p-4 text-sm sm:grid-cols-2">
      <MetadataItem label="类型" value={contentKindLabel(version.kind)} />
      <MetadataItem label="来源" value={contentOriginLabel(version, job)} />
      {version.kind !== 'text' && version.width && version.height && (
        <MetadataItem label="尺寸" value={`${version.width} × ${version.height}`} numeric />
      )}
      {version.kind !== 'text' && <MetadataItem label="文件体积" value={formatCanvasBytes(version.bytes)} numeric />}
      {version.kind !== 'text' && <MetadataItem label="格式" value={version.mime_type} />}
      <MetadataItem label="创建时间" value={formatCanvasTimestamp(version.created_at)} numeric />
      <MetadataItem label="版本" value={version.version_id} technical />
    </dl>
    {version.frozen_generation && <FrozenGenerationDetails generation={version.frozen_generation}
      mediaUrl={id => localCanvasTransport.mediaUrl(projectId, id)} />}
    {onReproduce && <Button size="sm" variant="outline" onClick={onReproduce}>复刻生成</Button>}
    {!version.frozen_generation && job?.canvas_run && (
      <CanvasGenerationMetadata snapshot={job.canvas_run.snapshot} job={job} nodes={nodes} />
    )}
  </>;
  if (version.kind === 'image' && src) {
    const actions = [
      { label: '局部修改', Icon: BrushIcon, run: onEdit },
      { label: '设为参考', Icon: AddImageIcon, run: onReference },
      { label: '复制提示词', Icon: CopyIcon, run: onCopyPrompt },
    ];
    return <Lightbox src={src} sourceRect={preview.sourceRect} meta={{ title: preview.title }}
      onClose={onClose} onPrevious={onPrevious} onNext={onNext}
      imageOverlay={<>
        {showSource && <span className="pointer-events-none absolute inset-0 bg-background" />}
        {showMask && maskId && <div aria-label="可编辑区域" className="pointer-events-none absolute inset-0 bg-primary/50" style={{ maskImage: `linear-gradient(white, white), url("${localCanvasTransport.mediaUrl(projectId, maskId)}")`, maskMode: 'luminance', maskComposite: 'subtract', maskSize: '100% 100%' }} />}
        {showSource && edit?.source_version_id && <img src={localCanvasTransport.mediaUrl(projectId, edit.source_version_id)} alt="编辑原图" className="absolute object-contain" style={edit.mode === 'outpaint' && edit.width && edit.height ? {
          left: `${(edit.x || 0) / edit.width * 100}%`, top: `${(edit.y || 0) / edit.height * 100}%`,
          width: `${(edit.source_width || edit.width) / edit.width * 100}%`, height: `${(edit.source_height || edit.height) / edit.height * 100}%`,
        } : { inset: 0, width: '100%', height: '100%' }} />}
      </>}
      details={<>{feedback}
        {edit?.source_version_id && <Button size="sm" variant="ghost" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setShowSource(true); }} onPointerUp={() => setShowSource(false)} onPointerCancel={() => setShowSource(false)} onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); setShowSource(true); } }} onKeyUp={() => setShowSource(false)} onBlur={() => setShowSource(false)}>按住查看原图</Button>}
        {edit && maskId && (edit.mode === 'inpaint' || edit.mode === 'outpaint') && <Toggle size="sm" pressed={showMask} onPressedChange={setShowMask}>查看选区</Toggle>}
        {metadata}</>}
      bottomActions={<>
        {actions.map(({ label, Icon, run }) => run && <Hint key={label} label={label}>
          <Button size="icon" variant="ghost" aria-label={label} className="size-8 rounded-full" onClick={run}><Icon size="sm" /></Button>
        </Hint>)}
        <Hint label="下载"><Button size="icon" variant="ghost" asChild className="size-8 rounded-full">
          <a href={canvasDownloadUrl(projectId, version.version_id)} aria-label="下载原文件"><DownloadIcon size="sm" /></a>
        </Button></Hint>
      </>} />;
  }
  return <Dialog open={dialogOpen} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto">
      <DialogHeader><DialogTitle>{preview.title}</DialogTitle><DialogDescription>原始内容、来源与生成信息</DialogDescription></DialogHeader>
      {feedback}
      {version.kind === 'text' && (
        <p className="max-h-[58dvh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-4 text-sm leading-relaxed text-foreground">
          {readablePromptVariables(version.text) || '暂无文本内容'}
        </p>
      )}
      {version.kind === 'video' && src && (
        <video src={src} controls playsInline preload="metadata" className="max-h-[58dvh] w-full rounded-lg object-contain" />
      )}
      {version.kind === 'audio' && src && (
        <audio src={src} controls preload="metadata" className="w-full" />
      )}
      {metadata}
      <DialogFooter>
        {onCopyPrompt && (
          <Button variant="outline" onClick={onCopyPrompt}>
            <CopyIcon aria-hidden="true" />复制生成提示词
          </Button>
        )}
        {version.kind !== 'text' && (
          <Button asChild>
            <a href={canvasDownloadUrl(projectId, version.version_id)}>
              <DownloadIcon aria-hidden="true" />下载原文件
            </a>
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function CanvasActionFeedback({ error, notice, action = null, noticeAction = null, onDismissError, className }: {
  error: string | null;
  notice: string | null;
  action?: CanvasNoticeAction | null;
  noticeAction?: CanvasNoticeAction | null;
  onDismissError: () => void;
  className?: string;
}) {
  if (!error && !notice) return null;
  const displayError = canvasNodeRunDisplayError(error, '操作失败，请稍后重试');
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {error && (
        <div role="alert" className="flex min-w-0 items-start gap-2 overflow-hidden rounded-lg border border-destructive/30 bg-popover px-3 py-2 text-sm text-destructive shell-glow">
          <span className="line-clamp-3 min-w-0 flex-1 break-words leading-relaxed">{displayError}</span>
          {action && (
            <Button variant="bare"
              type="button"
              className="shrink-0 rounded-md border border-destructive/40 px-2 py-0.5 text-xs text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onClick={action.run}
            >{action.label}</Button>
          )}
          <Button variant="bare" type="button" aria-label="关闭错误提示" onClick={onDismissError}><CloseIcon /></Button>
        </div>
      )}
      {notice && (
        <div role="status" className="flex min-w-0 items-start gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-sm text-foreground shell-glow">
          <div className="min-w-0 flex-1">
            {notice.split('\n').map((line, index) => <p key={index}>{line}</p>)}
          </div>
          {noticeAction && (
            <Button variant="outline" size="sm"
              type="button"
              className="h-6 shrink-0 px-2"
              onClick={noticeAction.run}
            >{noticeAction.label}</Button>
          )}
        </div>
      )}
    </div>
  );
}

function MetadataItem({ label, value, numeric = false, technical = false }: {
  label: string;
  value: string;
  numeric?: boolean;
  technical?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <Hint label={value}><dd className={cn('mt-0.5 truncate text-foreground', numeric && 'tabular-nums', technical && 'font-mono text-xs')}>{value}</dd></Hint>
    </div>
  );
}

function contentKindLabel(kind: CanvasContentVersion['kind']) {
  return { text: '文本', image: '图片', video: '视频', audio: '音频' }[kind];
}

function contentOriginLabel(version: CanvasContentVersion, job?: Job) {
  if (version.frozen_generation) return `AI 生成 · ${version.frozen_generation.model_name || version.frozen_generation.model_id}`;
  const { origin } = version;
  if (origin.kind === 'user_edit') return '人工编辑';
  if (origin.kind === 'upload') return '上传素材';
  if (origin.kind === 'user_mask') return '局部编辑蒙版';
  if (origin.kind === 'job_output') return job?.model ? `AI 生成 · ${job.model}` : 'AI 生成';
  if (origin.kind === 'layer_decomposition') {
    return job?.model ? `图层拆分 · ${job.model}` : '图层拆分';
  }
  if (origin.kind === 'import') return '项目包导入';
  if (origin.kind === 'creation_asset_snapshot') return `创作资产 · ${origin.title}`;
  if (origin.operation.kind === 'crop') return '本地裁剪';
  if (origin.operation.kind === 'split') return '本地切图';
  return '本地放大';
}

// 微信等来源的文件名能有上百字符，报错里只留头尾，原因才看得见。
function shortFileName(name: string, limit = 32) {
  if (name.length <= limit) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  return `${name.slice(0, limit - ext.length - 1)}…${ext}`;
}

function formatCanvasTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

function firstVideoEditModel(keys: KeyView[]) {
  for (const key of keys) {
    const model = key.models.find(candidate => (
      modelModality(candidate, key) === 'video'
      && supportsCanvasVideoEdit(candidate.id, candidate.protocol)
    ));
    if (model) return { key, model };
  }
  return null;
}

function pointerPosition(event: MouseEvent | TouchEvent): XYPosition | null {
  if ('clientX' in event) return { x: event.clientX, y: event.clientY };
  const touch = event.changedTouches[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
}

/** 画布级快捷键的焦点守卫：任何文本输入（input / textarea / 可编辑内容）、弹窗与菜单里一律不触发。 */
function isCanvasShortcutBlockedTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"]'));
}

function handleMenuNavigation(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(window.document.activeElement as HTMLButtonElement);
  if (event.key === 'Home') items[0]?.focus();
  else if (event.key === 'End') items.at(-1)?.focus();
  else if (event.key === 'ArrowDown') items[(current + 1 + items.length) % items.length]?.focus();
  else items[(current - 1 + items.length) % items.length]?.focus();
}

function documentQueryNode(nodeId: string) {
  return window.document.querySelector<HTMLElement>(`[data-canvas-node-id="${CSS.escape(nodeId)}"]`);
}

function isContentNode(node: CanvasNode): node is CanvasContentNode {
  return node.type === 'text' || node.type === 'image' || node.type === 'video' || node.type === 'audio';
}

function generationDraftForNode(node: CanvasNode) {
  if (node.type === 'image_edit') return null;
  if ('generation_draft' in node.data) return node.data.generation_draft;
  return null;
}

/** 连到首尾帧模式的视频生成配置上的图片按顺序填进空着的首帧、尾帧槽位（P0：不再让人先删线再去槽位里重选）。
 *  返回每个来源对应的槽位（不是首尾帧模式时都是 undefined）；槽位不够时给出原因。 */
function canvasFrameSlotsForNewInputs(
  document: CanvasDocument,
  targetNodeId: string,
  sourceIds: readonly string[],
  providers: readonly KeyView[],
): { slots: (CanvasVideoFrameSlot | undefined)[]; error?: string } {
  const none = { slots: sourceIds.map(() => undefined) };
  const target = document.nodes.find(node => node.id === targetNodeId);
  const draft = target ? generationDraftForNode(target) : null;
  if (!draft || draft.mode !== 'video') return none;
  const mediaKind = (nodeId: string) => {
    const node = document.nodes.find(item => item.id === nodeId);
    const versionId = node && isContentNode(node) ? node.data.current_version_id : null;
    return versionId ? document.content_versions[versionId]?.kind : undefined;
  };
  const editingExistingVideo = document.connections.some(connection => (
    connection.role === 'input' && connection.target_node_id === targetNodeId
    && !connection.slot && mediaKind(connection.source_node_id) === 'video'
  ));
  const { usesFrameSlots, maxFrames } = canvasVideoFrameSlotMode(draft, providers, editingExistingVideo);
  if (!usesFrameSlots || maxFrames === 0) return none;
  const taken = new Set(document.connections.flatMap(connection => (
    connection.role === 'input' && connection.target_node_id === targetNodeId ? [connection.slot] : []
  )));
  const free = (['first_frame', 'last_frame'] as const).slice(0, maxFrames).filter(slot => !taken.has(slot));
  const slots: (CanvasVideoFrameSlot | undefined)[] = [];
  for (const sourceId of sourceIds) {
    if (mediaKind(sourceId) !== 'image') return none;
    const slot = free.shift();
    if (!slot) {
      return { ...none, error: maxFrames === 1 ? '首帧已占用，先移除再连接。' : '首帧和尾帧都已占用，先移除一个再连接。' };
    }
    slots.push(slot);
  }
  return { slots };
}

function withGenerationDraftForNode(
  node: CanvasNode,
  draft: CanvasGenerationDraft,
): CanvasNode {
  if ('generation_draft' in node.data) {
    return { ...node, data: { ...node.data, generation_draft: draft } } as CanvasNode;
  }
  return node;
}

function removeCanvasConnections(
  document: CanvasDocument,
  shouldRemove: (connection: CanvasConnection) => boolean,
): CanvasDocument {
  const removed = document.connections.filter(shouldRemove);
  if (removed.length === 0) return document;
  const connections = document.connections.filter(connection => !shouldRemove(connection));
  const remainingPairs = new Set(connections.flatMap(connection => (
    connection.role === 'input' && !connection.slot
      ? [`${connection.source_node_id}\u0000${connection.target_node_id}`]
      : []
  )));
  const disconnectedByTarget = new Map<string, Set<string>>();
  for (const connection of removed) {
    if (connection.role !== 'input' || connection.slot) continue;
    const pair = `${connection.source_node_id}\u0000${connection.target_node_id}`;
    if (remainingPairs.has(pair)) continue;
    const nodeIds = disconnectedByTarget.get(connection.target_node_id) ?? new Set<string>();
    nodeIds.add(connection.source_node_id);
    disconnectedByTarget.set(connection.target_node_id, nodeIds);
  }
  const next = { ...document, connections };
  if (disconnectedByTarget.size === 0) return next;
  return syncCanvasPromptReferences(next, new Set(disconnectedByTarget.keys()), disconnectedByTarget);
}

/** 让连接图和提示词引用在同一次文档事务里收敛。
 *
 * 全能参考视频会自动把已连接、已有内容的文本节点写成 @ token；断开最后一条同源连接时，
 * 同一函数负责移除 token。不能放在生成面板 effect 里，否则未选中的目标节点不会挂载面板，
 * 会长期保存成「连接已存在、提示词没有引用」的中间态。 */
function syncCanvasPromptReferences(
  document: CanvasDocument,
  targetNodeIds: ReadonlySet<string>,
  disconnectedByTarget: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): CanvasDocument {
  if (targetNodeIds.size === 0) return document;
  const nodesById = new Map(document.nodes.map(node => [node.id, node]));
  const connectedByTarget = new Map<string, Set<string>>();
  for (const connection of document.connections) {
    if (
      connection.role !== 'input'
      || connection.slot
      || !targetNodeIds.has(connection.target_node_id)
    ) continue;
    const sources = connectedByTarget.get(connection.target_node_id) ?? new Set<string>();
    sources.add(connection.source_node_id);
    connectedByTarget.set(connection.target_node_id, sources);
  }
  const updatedAt = new Date().toISOString();
  let changed = false;
  const nodes = document.nodes.map(node => {
    if (!targetNodeIds.has(node.id)) return node;
    const draft = generationDraftForNode(node);
    if (!draft) return node;
    const disconnectedNodeIds = disconnectedByTarget.get(node.id) ?? new Set<string>();
    let prompt = removeCanvasMentionTokens(draft.prompt, disconnectedNodeIds);
    if (draft.mode === 'video' && draft.params.frame_mode === 'auto') {
      for (const sourceNodeId of connectedByTarget.get(node.id) ?? []) {
        const source = nodesById.get(sourceNodeId);
        if (source?.type === 'text' && source.data.current_version_id) {
          prompt = appendCanvasMentionToken(prompt, sourceNodeId);
        }
      }
    }
    const normalizedPrompt = prompt.trim() ? prompt : '';
    if (normalizedPrompt === draft.prompt) return node;
    changed = true;
    return withGenerationDraftForNode(node, { ...draft, prompt: normalizedPrompt, updated_at: updatedAt });
  });
  return changed ? { ...document, nodes } : document;
}

function canvasPromptSyncTargets(document: CanvasDocument, changedNodeId: string): Set<string> {
  const targets = new Set([changedNodeId]);
  for (const connection of document.connections) {
    if (
      connection.role === 'input'
      && !connection.slot
      && connection.source_node_id === changedNodeId
    ) targets.add(connection.target_node_id);
  }
  return targets;
}

/** ≥1280px：资产库与 Agent 面板并列。 */
function useWideCanvasViewport() {
  const query = '(min-width: 80rem)';
  const [wide, setWide] = useState(() => (
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return wide;
}

function useNarrowCanvasViewport() {
  const query = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => (
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

function connectionDropNodeId(pointer: XYPosition, side: 'left' | 'right') {
  const direct = window.document
    .elementFromPoint(pointer.x, pointer.y)
    ?.closest<HTMLElement>('.react-flow__node')
    ?.dataset.id;
  if (direct) return direct;
  const nodes = [...window.document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')]
    .flatMap((element) => {
      const id = element.dataset.id;
      if (!id) return [];
      const rect = element.getBoundingClientRect();
      return [{ id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }];
    });
  return closestCanvasConnectionEndpoint(pointer, nodes, side);
}

function backgroundVariant(background: CanvasDocument['settings']['background']) {
  if (background === 'dots') return BackgroundVariant.Dots;
  if (background === 'lines') return BackgroundVariant.Lines;
  return null;
}

function sameViewport(left: Viewport, right: Viewport) {
  return Math.abs(left.x - right.x) < 0.001
    && Math.abs(left.y - right.y) < 0.001
    && Math.abs(left.zoom - right.zoom) < 0.001;
}

function replacementAccept(kind: MediaReplaceTarget['kind']) {
  if (kind === 'image') return '.png,.jpg,.jpeg,.webp';
  if (kind === 'video') return '.mp4,.webm,.mov';
  return '.mp3,.wav,.m4a,.aac';
}

function reversePromptConfigNodeId(resultNodeId: string) {
  return `image-reverse-${resultNodeId}`;
}

function cloneCanvasNode(
  source: CanvasNode,
  idMap: ReadonlyMap<string, string>,
  position: XYPosition,
  zIndex: number,
  preserveExternalReferences = true,
): CanvasNode {
  const clone = structuredClone(source);
  if (isContentNode(clone)) {
    return {
      ...clone,
      id: idMap.get(source.id)!,
      position,
      z_index: zIndex,
      data: {
        ...clone.data,
        generation_draft: cloneCanvasDraft(clone.data.generation_draft, idMap),
        active_run_id: null,
        // 结果组只保留一起复制过来的成员；一个都没跟过来就不再是结果组。
        ...(clone.type === 'image' && clone.data.result_stack ? (() => {
          const members = clone.data.result_stack.member_node_ids.flatMap(id => idMap.get(id) ?? []);
          return { result_stack: members.length ? { ...clone.data.result_stack, member_node_ids: members } : null };
        })() : {}),
      },
    } as CanvasNode;
  }
  if (clone.type === 'group') {
    return {
      ...clone,
      id: idMap.get(source.id)!,
      position,
      z_index: zIndex,
      data: {
        ...clone.data,
        member_node_ids: clone.data.member_node_ids.flatMap(memberId => {
          const clonedId = idMap.get(memberId);
          return clonedId ? [clonedId] : [];
        }),
      },
    };
  }
  if (clone.type === 'compare') return { ...clone, id: idMap.get(source.id)!, position, z_index: zIndex };
  if (clone.type === 'image_edit') return { ...clone, id: idMap.get(source.id)!, position, z_index: zIndex,
    data: { ...clone.data, active_run_id: null,
      source_node_id: idMap.get(clone.data.source_node_id ?? '') ?? (preserveExternalReferences ? clone.data.source_node_id : null),
      reference_node_id: idMap.get(clone.data.reference_node_id ?? '') ?? (preserveExternalReferences ? clone.data.reference_node_id : null),
      generation_draft: cloneCanvasDraft(clone.data.generation_draft, idMap),
    } };
  if (clone.type === 'layer_stack') return { ...clone, id: idMap.get(source.id)!, position, z_index: zIndex,
    data: { ...clone.data, base_material_node_id: idMap.get(clone.data.base_material_node_id ?? '') ?? null,
      layers: clone.data.layers.map(layer => ({ ...layer, material_node_id: idMap.get(layer.material_node_id ?? '') ?? null })) } };
  return {
    ...clone,
    id: idMap.get(source.id)!,
    position,
    z_index: zIndex,
    data: {
      ...clone.data,
      // 宿主插件节点（如分镜）payload 里的节点绑定：一同复制的改指新节点，其余清空。插件关闭时原样复制。
      ...((remap => remap ? { payload: remap(clone.data.payload, idMap) } : {})(currentHostNodeType(clone)?.remapPayload)),
      generation_draft: cloneCanvasDraft(clone.data.generation_draft, idMap),
    },
  };
}

function cloneCanvasDraft(
  draft: CanvasGenerationDraft | null,
  idMap: ReadonlyMap<string, string>,
): CanvasGenerationDraft | null {
  if (!draft) return null;
  return {
    ...draft,
    prompt: draft.prompt.replace(/@\[node:([^\]]+)\]/g, (_marker, nodeId: string) => {
      const clonedId = idMap.get(nodeId);
      return clonedId ? `@[node:${clonedId}]` : '';
    }),
    updated_at: new Date().toISOString(),
  };
}

/** 所有本地编辑的统一收尾：传 previous 进去当「谁动过」的判据，只有自己刚动过的节点会被分组吞进去。 */
function normalizeCommittedDocument(next: CanvasDocument, previous: CanvasDocument): CanvasDocument {
  return {
    ...normalizeCanvasGroups(normalizeCanvasCompareConnections(detachMissingImageEditNodes(syncDraftLayerStackSources(
      normalizeResultStacks(next, previous),
    ))), previous),
    updated_at: new Date().toISOString(),
  };
}

function newLayerStackNode(
  document: CanvasDocument,
  source: Extract<CanvasContentNode, { type: 'image' }>,
  sourceVersion: CanvasMediaVersion,
  preferred: XYPosition,
  settings: Pick<CanvasLayerStackNode['data'], 'alias' | 'model' | 'prompt' | 'resolution' | 'max_images'>,
): CanvasLayerStackNode {
  const size = layerStackSizeForCanvasVersion(sourceVersion);
  return {
    id: makeId('layer-stack'),
    title: '拆分图层',
    type: 'layer_stack',
    position: placeCanvasNodeWithoutOverlap(
      preferred,
      document.nodes,
      size,
      undefined,
      node => canvasNodeRenderedSize(node, document.content_versions),
    ),
    size,
    z_index: source.z_index,
    data: {
      ...settings,
      source_version_id: sourceVersion.version_id,
      base_version_id: null,
      base_visible: true,
      layers: [],
      active_run_id: null,
      error: null,
    },
  };
}

function withLayerStackFromSource(
  document: CanvasDocument,
  stack: CanvasLayerStackNode,
  sourceNodeId: string,
): CanvasDocument {
  return {
    ...document,
    nodes: [...document.nodes, stack],
    connections: [...document.connections, {
      id: makeId('connection'),
      role: 'input',
      source_node_id: sourceNodeId,
      target_node_id: stack.id,
    }],
  };
}

type SubmitRunOutcome =
  | { status: 'submitted'; resultNodeId?: string }
  | { status: 'not_sent' | 'conflict' | 'error' };

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function parseCanvasClipboardPayload(serialized: string): CanvasClipboardPayload | null {
  if (!serialized) return null;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      typeof parsed !== 'object' || parsed === null
      || (parsed as CanvasClipboardPayload).schema_version !== 1
      || typeof (parsed as CanvasClipboardPayload).source_project_id !== 'string'
      || !Array.isArray((parsed as CanvasClipboardPayload).nodes)
      || !Array.isArray((parsed as CanvasClipboardPayload).connections)
    ) return null;
    return parsed as CanvasClipboardPayload;
  } catch {
    return null;
  }
}

const canvasFlowZoom = (state: ReactFlowState) => state.transform[2];

/** 连接把手随缩放反比放大，靠 CSS 变量。原来是把 zoom 存成 CanvasEditor 的 state、每帧平移 / 缩放都让
 *  5000 行的主树整棵重渲染；后来改成订阅 zoom 的空组件，但仍要每帧走一次 React 渲染 + 绘制之后的 useEffect，
 *  变量也写在整个编辑器外壳上（顶栏、面板、浮条都跟着重算样式）。
 *  现在直接订阅 store：只在 zoom 变了（平移不算）时同步写，写在只含节点的 .react-flow__nodes 上，
 *  不经过 React，也赶在这一帧绘制之前。 */
function CanvasZoomCssVars() {
  const store = useStoreApi<FlowNode>();
  useLayoutEffect(() => {
    let lastZoom = Number.NaN;
    let target: HTMLElement | null = null;
    const write = (state: { transform?: [number, number, number]; domNode?: HTMLDivElement | null }) => {
      const zoom = state.transform?.[2];
      if (zoom === undefined) return;
      if (!target?.isConnected) {
        target = state.domNode?.querySelector<HTMLElement>('.react-flow__nodes') ?? null;
        lastZoom = Number.NaN;
      }
      if (!target || zoom === lastZoom) return;
      lastZoom = zoom;
      target.style.setProperty('--canvas-zoom', String(zoom));
      target.style.setProperty('--canvas-handle-size', `${48 / zoom}px`);
      target.style.setProperty('--canvas-handle-dot-size', `${12 / zoom}px`);
      target.style.setProperty('--canvas-handle-border-size', `${2 / zoom}px`);
    };
    write(store.getState());
    return store.subscribe(write);
  }, [store]);
  return null;
}

const zoomDockButtonClass = 'grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40';

function CanvasZoomDock({
  assetControl,
  minimapToggle,
  onZoomOut,
  onZoomIn,
  onResetZoom,
  onFitView,
}: {
  assetControl: ReactNode;
  minimapToggle: ReactNode;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetZoom: () => void;
  onFitView: () => void;
}) {
  const zoom = useStore(canvasFlowZoom);
  const percent = Math.round(zoom * 100);
  return (
    <>
    {assetControl && (
      <div className="canvas-config-dock absolute bottom-3 left-3 z-20 hidden items-center rounded-full border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow md:flex">
        {assetControl}
      </div>
    )}
    <div className="canvas-zoom-dock absolute bottom-3 right-3 z-20 hidden items-center gap-1 rounded-full border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow md:flex">
      {minimapToggle}
      <div className="mx-1 h-5 w-px bg-border" />
      <Button variant="bare"
        type="button"
        aria-label="缩小画布"
        disabled={zoom <= CANVAS_MIN_ZOOM + 0.0005}
        className={zoomDockButtonClass}
        onClick={onZoomOut}
      ><MinusIcon aria-hidden="true" /></Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="bare"
            type="button"
            aria-label={`画布缩放 ${percent}%`}
            className="h-8 w-14 rounded-md text-xs tabular-nums text-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary data-[state=open]:bg-secondary"
          >{percent}%</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center" className="min-w-36 rounded-xl">
          <DropdownMenuItem onSelect={onFitView}>适应全部</DropdownMenuItem>
          <DropdownMenuItem onSelect={onResetZoom}>100%</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="bare"
        type="button"
        aria-label="放大画布"
        disabled={zoom >= CANVAS_MAX_ZOOM - 0.0005}
        className={zoomDockButtonClass}
        onClick={onZoomIn}
      ><AddIcon aria-hidden="true" /></Button>
      <div className="mx-1 h-5 w-px bg-border" />
      <Hint label="适应全部节点"><Button variant="bare"
        type="button"
        aria-label="适应全部节点"
        className={zoomDockButtonClass}
        onClick={onFitView}
      ><ExpandIcon aria-hidden="true" /></Button></Hint>
    </div>
    </>
  );
}

/** 右侧面板（资产库、画布 Agent）的进出场：从右侧 16px 滑入并淡入 200ms，收起 150ms 淡出。
 *  面板本身是 fixed 定位，外层铺满视口：带 transform 的祖先会成为 fixed 的定位参照，铺满才不改面板位置。
 *  外层不接事件，只有面板本身接。减弱动态效果时只淡变。 */
function CanvasSidePanelMotion({ children }: { children: ReactNode }) {
  const animated = motionAvailable();
  const reduced = prefersReducedMotion();
  return (
    <motion.div
      className="pointer-events-none fixed inset-0 z-40 [&>*]:pointer-events-auto"
      initial={animated ? { opacity: 0, x: reduced ? 0 : 16 } : false}
      animate={{ opacity: 1, x: 0, transition: { duration: MOTION_DURATION.base, ease: MOTION_EASE.out } }}
      exit={animated ? { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } } : undefined}
    >
      {children}
    </motion.div>
  );
}

/** 画布上的浮条（报错条、提示、多选工具条、生成中胶囊、小地图）：150ms 淡入（offset 给出 4px 的来向），退场 150ms 淡出。
 *  只动透明度与 y：定位用的 -translate-x-1/2 是 translate 属性，不与这里的 transform 打架。减弱动态效果只淡变。 */
function CanvasChromeFade({ children, className, offset = 0 }: { children: ReactNode; className?: string; offset?: number }) {
  const animated = motionAvailable();
  const y = prefersReducedMotion() ? 0 : offset;
  return (
    <motion.div
      className={className}
      initial={animated ? { opacity: 0, y } : false}
      animate={{ opacity: 1, y: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } }}
      exit={animated ? { opacity: 0, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } } : undefined}
    >
      {children}
    </motion.div>
  );
}

const CANVAS_HISTORY_HINT_POSITION: Record<CanvasHistoryHint['direction'], string> = {
  left: 'left-20 top-1/2 -translate-y-1/2',
  right: 'right-4 top-1/2 -translate-y-1/2',
  up: 'left-1/2 top-20 -translate-x-1/2',
  down: 'bottom-20 left-1/2 -translate-x-1/2',
};

/** 读画布超过 300ms 才显示转圈，之前留空；转圈出现时 150ms 淡入。jsdom 里直接显示，测试照旧能找到文案。 */
function DelayedCanvasLoading() {
  const [visible, setVisible] = useState(() => !motionAvailable());
  useEffect(() => {
    if (visible) return;
    const timer = window.setTimeout(() => setVisible(true), CANVAS_LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);
  if (!visible) return <div className="h-full" aria-busy="true" />;
  return (
    <motion.div className="h-full" initial={motionAvailable() ? { opacity: 0 } : false} animate={{ opacity: 1, transition: { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle } }}>
      <EditorMessage icon={<LoadingIcon size="lg" className="animate-spin" />} text="展开画布中…" />
    </motion.div>
  );
}

/** 快捷键触发时，对应按钮做一次 150ms 的按下回弹；减弱动态效果时不缩放，交给操作结果本身。 */
function flashShortcutButton(button: Element | null | undefined) {
  if (!button || !motionAvailable() || prefersReducedMotion()) return;
  clearOnFinish(animate(button, { scale: [1, 0.94, 1] }, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }), button, ['transform']);
}

/** 视口平移 / 缩放的时长（xyflow 收毫秒）。减弱动态效果时直接跳到位。 */
function viewportMotionMs(seconds: number) {
  return prefersReducedMotion() ? 0 : seconds * 1000;
}
