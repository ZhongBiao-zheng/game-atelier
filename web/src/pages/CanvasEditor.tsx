import '@xyflow/react/dist/style.css';

import {
  Background,
  BackgroundVariant,
  MiniMap,
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
  type XYPosition,
  useReactFlow,
} from '@xyflow/react';
import {
  ArrowLeft,
  ChevronDown,
  CircleHelp,
  CircleDot,
  ClipboardCopy,
  Download,
  FileAudio,
  FileImage,
  FileVideo,
  Grid2X2,
  Info,
  Library,
  LoaderCircle,
  MapPinned,
  Maximize2,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Redo2,
  Scan,
  Settings,
  Settings2,
  Square,
  Trash2,
  Type,
  Undo2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Link } from 'wouter';

import {
  cancelCanvasRun,
  canvasDownloadUrl,
  canvasMediaUrl,
  createCanvasReversePromptConfig,
  createCanvasPrompt,
  dismissCanvasCandidate,
  deleteCanvasAsset,
  deleteCanvasPrompt,
  getCanvasDocument,
  getCanvasAssets,
  getCanvasPrompts,
  insertCanvasAsset,
  insertCanvasPrompt,
  listCanvasJobs,
  listCanvasProjects,
  renameCanvasProject,
  replaceCanvasNodeMedia,
  retryCanvasRun,
  runCanvasMediaOperation,
  saveCanvasAsset,
  saveCanvasDocument,
  submitCanvasAngleRun,
  submitCanvasRun,
  submitCanvasMaskEdit,
  submitCanvasReversePrompt,
  updateCanvasAsset,
  updateCanvasPrompt,
  uploadCanvasMedia,
} from '@/api/canvas';
import { getCanvasUiPreferences, saveCanvasUiPreferences } from '@/api/canvasUi';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import { useCanvasJobSync } from '@/hooks/useCanvasJobSync';
import {
  AddMenuButton,
  CanvasMobileGenerationPanel,
  CanvasNodeContext,
  EditorMessage,
  ToolButton,
  canvasNodeTypes,
  copyablePromptForNode,
  type CanvasNodeContextValue,
  type FlowNode,
} from '@/components/canvas/CanvasEditorViews';
import { canvasNodeRunDisplayError, isReversePromptJob } from '@/components/canvas/CanvasNodeRunStatus';
import { CanvasThemeSelector } from '@/components/canvas/CanvasThemeSelector';
import {
  CanvasGenerationMetadata,
  canvasRetryErrorMessage,
} from '@/components/canvas/CanvasGenerationMetadata';
import { CanvasGenerationPreferencesDialog } from '@/components/canvas/CanvasGenerationPreferencesDialog';
import {
  CanvasMaskEditDialog,
  type CanvasMaskEditSubmission,
} from '@/components/canvas/CanvasMaskEditDialog';
import {
  CanvasAngleDialog,
  type CanvasAngleParams,
} from '@/components/canvas/CanvasAngleDialog';
import {
  CanvasMediaOperationDialog,
  type CanvasMediaTool,
} from '@/components/canvas/CanvasMediaOperationDialog';
import { DEFAULT_CANVAS_UI_PREFERENCES } from '@/components/canvas/canvasImageToolbar';
import { formatCanvasBytes } from '@/components/canvas/canvasMediaFormatting';
import {
  generationPanelDismissalAfterNodeSelection,
  isUploadedImageMaterialNode,
  restoreCanvasNodeFocus,
} from '@/components/canvas/canvasNodePanelInteraction';
import {
  CANVAS_LIBRARY_DRAG_TYPE,
  CanvasLibraryPanel,
  type CanvasLibraryMode,
} from '@/components/canvas/CanvasLibraryPanel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  CanvasContentVersion,
  CanvasConnection,
  CanvasContentNode,
  CanvasDocument,
  CanvasGenerationDefaults,
  CanvasGenerationDraft,
  CanvasImageToolbarPreferences,
  CanvasLibraryAsset,
  CanvasMediaOperation,
  CanvasMediaVersion,
  CanvasNode,
  CanvasPoint,
  CanvasPrompt,
  CanvasSize,
  CanvasTextVersion,
  CanvasUiPreferences,
  CanvasVideoFrameSlot,
  RevisionedSidecar,
} from '@/schema/canvas';
import type { Job, JobKind } from '@/schema/jobs';
import { cn } from '@/lib/utils';
import {
  buildCanvasMaterialReferences,
  buildCanvasMentionReferences,
  removeCanvasMentionTokens,
} from '@/lib/canvasMentions';
import { shouldPreventCanvasHistoryNavigation } from '@/lib/canvasTrackpad';
import {
  CANVAS_LOCAL_VERSION_SHA,
  acceptServerContentVersions,
  canvasConnectionCreationCapabilities,
  canvasDeletionBlockedMessage,
  canvasNodeRenderZIndex,
  canCreateCanvasInputConnection,
  clampCanvasNodeSize,
  canvasPendingInputNodes,
  closestCanvasConnectionEndpoint,
  createCanvasGenerationDraft,
  createConnectedCanvasConfig,
  normalizeCanvasVideoParams,
  restoreContentVersions,
  supportsCanvasVideoEdit,
} from './canvasEditorModel';

interface CreateMenuState {
  screen: XYPosition;
  flow: XYPosition;
  sourceId?: string;
  sourceHandle?: 'source' | 'target';
}

interface MaterialPickState {
  targetNodeId: string;
  slot?: CanvasVideoFrameSlot;
  selectableNodeIds: ReadonlySet<string>;
}

interface PreviewState {
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

interface MaskEditState {
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
    node.type === 'config'
      ? [node.id, node.title, node.type, null, node.data.draft.mode]
      : node.type === 'text' || node.type === 'image' || node.type === 'video' || node.type === 'audio'
        ? [
          node.id,
          node.title,
          node.type,
          node.data.current_version_id,
          node.data.generation_draft?.mode ?? null,
        ]
        : [node.id, node.title, node.type],
  );
  mentionNodeFragments.set(node, fragment);
  return fragment;
}

function mentionConnectionFragment(connection: CanvasConnection): string {
  const cached = mentionConnectionFragments.get(connection);
  if (cached !== undefined) return cached;
  const fragment = JSON.stringify([
    connection.id, connection.source_node_id, connection.target_node_id,
  ]);
  mentionConnectionFragments.set(connection, fragment);
  return fragment;
}

function canvasMentionGraphSignature(document: CanvasDocument | null): string {
  if (!document) return '';
  const nodes = document.nodes.map(mentionNodeFragment).join(',');
  const connections = document.connections
    .filter(connection => connection.role === 'input')
    .map(mentionConnectionFragment)
    .join(',');
  return `${nodes}|${connections}`;
}

interface CanvasClipboardPayload {
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
const CANVAS_NODE_CLIPBOARD_TYPE = 'application/x-game-atelier-canvas-nodes';
const CANVAS_MIN_ZOOM = 0.08;
const CANVAS_MAX_ZOOM = 2.5;
// xyflow 默认只认 Meta/Control，Shift 归 selectionKeyCode（框选）。框选已经由 selectionOnDrag
// 接管，所以把 Shift 也并进多选键、并把 selectionKeyCode 置空，和快捷键面板写的「Shift / ⌘ 点击」对齐。
const CANVAS_MULTI_SELECT_KEYS = ['Shift', 'Meta', 'Control'];

const CANVAS_CHROME_BUTTON_CLASS = 'grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

export function CanvasEditor(props: {
  projectId: string;
  onBack: () => void;
  onSwitchProject: (projectId: string) => void;
}) {
  return <ReactFlowProvider><CanvasEditorInner {...props} /></ReactFlowProvider>;
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
  const [document, setDocument] = useState<CanvasDocument | null>(null);
  const [projects, setProjects] = useState<Array<{ project_id: string; name: string }>>([]);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [assets, setAssets] = useState<RevisionedSidecar<CanvasLibraryAsset> | null>(null);
  const [prompts, setPrompts] = useState<RevisionedSidecar<CanvasPrompt> | null>(null);
  const [canvasUiPreferences, setCanvasUiPreferences] = useState<CanvasUiPreferences>(DEFAULT_CANVAS_UI_PREFERENCES);
  const [canvasUiPreferencesError, setCanvasUiPreferencesError] = useState<string | null>(null);
  const [libraryMode, setLibraryMode] = useState<CanvasLibraryMode | null>(null);
  const [libraryFocusAssetId, setLibraryFocusAssetId] = useState<string | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
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
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [generationPreferencesOpen, setGenerationPreferencesOpen] = useState(false);
  const [generationPreferencesSaving, setGenerationPreferencesSaving] = useState(false);
  const [viewportZoom, setViewportZoom] = useState(1);
  const [projectRenameDraft, setProjectRenameDraft] = useState<string | null>(null);
  const [projectRenameBusy, setProjectRenameBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [saveErrorDetail, setSaveErrorDetail] = useState<string | null>(null);
  const [historyDepth, setHistoryDepth] = useState({ past: 0, future: 0 });
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [mediaOperation, setMediaOperation] = useState<MediaOperationState | null>(null);
  const [mediaOperationBusy, setMediaOperationBusy] = useState(false);
  const [mediaOperationError, setMediaOperationError] = useState<string | null>(null);
  const [maskEdit, setMaskEdit] = useState<MaskEditState | null>(null);
  const [maskEditBusy, setMaskEditBusy] = useState(false);
  const [maskEditError, setMaskEditError] = useState<string | null>(null);
  const [angleState, setAngleState] = useState<AngleState | null>(null);
  const [angleBusy, setAngleBusy] = useState(false);
  const [angleError, setAngleError] = useState<string | null>(null);
  const [mediaReplaceTarget, setMediaReplaceTarget] = useState<MediaReplaceTarget | null>(null);
  const [mediaReplaceBusyNodeIds, setMediaReplaceBusyNodeIds] = useState<Set<string>>(() => new Set());
  const [mediaReplaceError, setMediaReplaceError] = useState<{ nodeId: string; message: string } | null>(null);
  const [toolNotice, setToolNotice] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceMediaRef = useRef<HTMLInputElement>(null);
  const editorRegionRef = useRef<HTMLElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const assetLibraryTriggerRef = useRef<HTMLButtonElement>(null);
  const promptLibraryTriggerRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const shortcutsTriggerRef = useRef<HTMLButtonElement>(null);
  const generationPreferencesTriggerRef = useRef<HTMLButtonElement>(null);
  const flowNodeCache = useRef(new Map<string, {
    node: CanvasNode;
    selected: boolean;
    liveLayout: LiveNodeLayout | undefined;
    flowNode: FlowNode;
  }>());
  const flowEdgeCache = useRef(new Map<string, {
    connection: CanvasConnection;
    active: boolean;
    selected: boolean;
    sourceTitle: string;
    targetTitle: string;
    flowEdge: Edge;
  }>());
  const flowEdgesRef = useRef<Edge[]>([]);
  const [liveNodeLayout, setLiveNodeLayout] = useState<LiveNodeLayout | null>(null);
  const pendingLiveNodeLayout = useRef<LiveNodeLayout | null>(null);
  const activeResizeNodeId = useRef<string | null>(null);
  const resizePreviewFrame = useRef<number | null>(null);
  const dirtyVersion = useRef(0);
  const [dirtySignal, setDirtySignal] = useState(0);
  const serverRevision = useRef(0);
  const saveInFlight = useRef<Promise<void> | null>(null);
  const saveQueued = useRef<CanvasDocument | null>(null);
  const runSubmissionInFlight = useRef(false);
  const libraryMutationInFlight = useRef(false);
  const libraryInsertInFlight = useRef(false);
  const libraryInsertCommand = useRef<Promise<void> | null>(null);
  const mediaOperationInFlight = useRef(false);
  const documentCommandInFlight = useRef(false);
  const canvasUiPreferencesSaveInFlight = useRef(false);
  const toolNoticeTimer = useRef<number | null>(null);
  const latestDocument = useRef<CanvasDocument | null>(null);
  const pendingTextVersions = useRef(new Map<string, string>());
  const reversePromptConfigAttempts = useRef(new Set<string>());
  // 只有本会话提交过的反推 run 才会自动生成图片配置节点。原来的判据是「这个结果节点上还没挂配置」，
  // 于是删掉配置节点后刷新，甚至只是第一次打开一个有历史反推记录的项目，节点都会自己长回来。
  const reversePromptConfigEligibleRuns = useRef(new Set<string>());
  const history = useRef<{ past: CanvasDocument[]; future: CanvasDocument[] }>({ past: [], future: [] });
  const viewportSync = useRef<ViewportSyncToken | null>(null);
  const nodeClipboard = useRef<CanvasClipboardPayload | null>(null);
  const pasteSequence = useRef(0);
  const zoomSliderActive = useRef(false);
  const zoomSliderCommitTimer = useRef<number | null>(null);
  const zoomSliderMove = useRef<Promise<boolean> | null>(null);
  const pendingViewportCommand = useRef<Promise<void> | null>(null);
  const viewportCommandEpoch = useRef(0);
  const cancelViewportCommand = useRef<(() => void) | null>(null);
  const finishZoomSliderRef = useRef<() => void>(() => undefined);
  const projectRenameInputRef = useRef<HTMLInputElement>(null);
  const projectRenameTriggerRef = useRef<HTMLButtonElement>(null);
  const projectRenameInFlight = useRef(false);
  const cancelProjectRename = useRef(false);
  const {
    screenToFlowPosition,
    fitView,
    getViewport,
    getZoom,
    setCenter,
    setViewport,
    zoomIn,
    zoomOut,
    zoomTo,
  } = useReactFlow<FlowNode>();
  const closeLibrary = useCallback(() => {
    const trigger = libraryMode === 'prompts'
      ? promptLibraryTriggerRef.current
      : assetLibraryTriggerRef.current;
    setLibraryMode(null);
    requestAnimationFrame(() => trigger?.focus());
  }, [libraryMode]);

  const acceptAssets = useCallback((value: RevisionedSidecar<CanvasLibraryAsset>) => {
    setAssets(current => !current || value.revision >= current.revision ? value : current);
  }, []);
  const acceptPrompts = useCallback((value: RevisionedSidecar<CanvasPrompt>) => {
    setPrompts(current => !current || value.revision >= current.revision ? value : current);
  }, []);

  const mergeRunDocument = useCallback((
    remote: CanvasDocument,
    runIds: ReadonlySet<string>,
  ) => {
    serverRevision.current = Math.max(serverRevision.current, remote.revision);
    setDocument(current => {
      if (!current || remote.revision <= current.revision) return current;
      const remoteNodes = new Map(remote.nodes.map(node => [node.id, node]));
      const currentNodeIds = new Set(current.nodes.map(node => node.id));
      const serverAddedNodeIds = new Set(remote.connections.flatMap(connection => (
        connection.role === 'derivation'
        && connection.origin.kind === 'generation_run'
        && runIds.has(connection.origin.run_id)
        && !currentNodeIds.has(connection.target_node_id)
          ? [connection.target_node_id]
          : []
      )));
      const serverAddedNodes = remote.nodes.filter(node => serverAddedNodeIds.has(node.id));
      const nodes = [...current.nodes.map(node => {
        const serverNode = remoteNodes.get(node.id);
        if (!serverNode || !isContentNode(node) || !isContentNode(serverNode)) return node;
        if (!node.data.active_run_id || node.data.active_run_id !== serverNode.data.active_run_id) return node;
        return {
          ...node,
          data: {
            ...node.data,
            current_version_id: serverNode.data.current_version_id,
          },
        } as CanvasContentNode;
      }), ...serverAddedNodes];
      const nodeIds = new Set(nodes.map(node => node.id));
      const connectionIds = new Set(current.connections.map(connection => connection.id));
      const serverRunConnections = remote.connections.filter(connection => (
        !connectionIds.has(connection.id)
        && nodeIds.has(connection.source_node_id)
        && nodeIds.has(connection.target_node_id)
        && (
          (
            connection.role === 'derivation'
            && connection.origin.kind === 'generation_run'
            && runIds.has(connection.origin.run_id)
          )
          || serverAddedNodeIds.has(connection.target_node_id)
        )
      ));
      const merged: CanvasDocument = {
        ...current,
        revision: remote.revision,
        updated_at: remote.updated_at,
        nodes,
        connections: [...current.connections, ...serverRunConnections],
        content_versions: acceptServerContentVersions(
          current.content_versions,
          remote.content_versions,
        ),
      };
      if (saveQueued.current) saveQueued.current = merged;
      return merged;
    });
  }, []);

  // 出图记录的同步整体在 useCanvasJobSync 里：epoch 记账、兜底轮询、SSE 订阅都归它，
  // 这里只把「结果并回文档」这一半交出去。必须声明在下面那个切项目的 effect 之前——
  // 那个 effect 的依赖数组要引用 acceptJobs / resetJobSync。
  const { jobs, acceptJobs, applyLocalJob, reset: resetJobSync } = useCanvasJobSync({
    projectId,
    mergeRunDocument,
    onError: setError,
  });

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
    setViewportZoom(1);
    setProjectRenameDraft(null);
    setProjectRenameBusy(false);
    setLibraryMode(null);
    setLibraryFocusAssetId(null);
    setLibraryError(null);
    setAssets(null);
    setPrompts(null);
    setCanvasUiPreferences(DEFAULT_CANVAS_UI_PREFERENCES);
    setCanvasUiPreferencesError(null);
    setPreview(null);
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
    flowEdgeCache.current.clear();
    flowEdgesRef.current = [];
    activeResizeNodeId.current = null;
    pendingLiveNodeLayout.current = null;
    if (resizePreviewFrame.current !== null) window.cancelAnimationFrame(resizePreviewFrame.current);
    resizePreviewFrame.current = null;
    setLiveNodeLayout(null);
    history.current = { past: [], future: [] };
    viewportSync.current = null;
    nodeClipboard.current = null;
    pasteSequence.current = 0;
    zoomSliderActive.current = false;
    if (zoomSliderCommitTimer.current !== null) window.clearTimeout(zoomSliderCommitTimer.current);
    zoomSliderCommitTimer.current = null;
    zoomSliderMove.current = null;
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
    serverRevision.current = 0;
    runSubmissionInFlight.current = false;
    documentCommandInFlight.current = false;
    canvasUiPreferencesSaveInFlight.current = false;
    projectRenameInFlight.current = false;
    cancelProjectRename.current = false;
    void getCanvasUiPreferences()
      .then(value => {
        if (!cancelled) setCanvasUiPreferences(value);
      })
      .catch(preferencesError => {
        if (!cancelled) setCanvasUiPreferencesError((preferencesError as Error).message);
      });
    Promise.all([
      listCanvasProjects(true),
      getCanvasDocument(projectId),
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
        setDocument(hydrated.document);
        setViewportZoom(canvasDocument.viewport.zoom);
        serverRevision.current = canvasDocument.revision;
        if (hydrated.versionIds.size) {
          dirtyVersion.current += 1;
          setDirtySignal(dirtyVersion.current);
        }
        setKeys([...keyRows.keys].sort((left, right) => (
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
      if (zoomSliderCommitTimer.current !== null) window.clearTimeout(zoomSliderCommitTimer.current);
      if (resizePreviewFrame.current !== null) window.cancelAnimationFrame(resizePreviewFrame.current);
    };
  }, [acceptJobs, projectId, resetJobSync]);

  useEffect(() => {
    if (!libraryMode) return;
    let cancelled = false;
    const load = libraryMode === 'assets'
      ? assets ? null : getCanvasAssets(projectId).then(value => { if (!cancelled) acceptAssets(value); })
      : prompts ? null : getCanvasPrompts(projectId).then(value => { if (!cancelled) acceptPrompts(value); });
    if (!load) return;
    setLibraryLoading(true);
    setLibraryError(null);
    void load.catch(loadError => {
      if (!cancelled) setLibraryError((loadError as Error).message);
    }).finally(() => {
      if (!cancelled) setLibraryLoading(false);
    });
    return () => {
      cancelled = true;
      setLibraryLoading(false);
    };
  }, [acceptAssets, acceptPrompts, assets, libraryMode, projectId, prompts]);


  const mergeSubmittedRunDocument = useCallback((
    remote: CanvasDocument,
    job: Job,
    dirtyAtSubmission: number,
  ) => {
    serverRevision.current = Math.max(serverRevision.current, remote.revision);
    const context = job.canvas_run;
    const current = latestDocument.current;
    if (!current || !context) {
      setDocument(remote);
      return;
    }
    const remoteNodes = new Map(remote.nodes.map(node => [node.id, node]));
    const remoteResult = remoteNodes.get(context.result_node_id);
    const hasResult = current.nodes.some(node => node.id === context.result_node_id);
    const resultReusesSurface = context.result_node_id === context.snapshot.surface_node_id;
    const nodes = current.nodes.map(node => {
      if (node.id !== context.result_node_id || !isContentNode(node)) return node;
      if (!remoteResult || !isContentNode(remoteResult)) return node;
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
      connection.role === 'derivation'
      && connection.origin.kind === 'generation_run'
      && connection.origin.run_id === context.run_id
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
    setDocument(merged);
  }, []);

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
    requestAnimationFrame(() => createMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
  }, [createMenu]);

  latestDocument.current = document;
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

  const selectedId = selectedNodeIds.size === 1
    ? selectedNodeIds.values().next().value ?? null
    : null;

  const flushSave = useCallback(function drainSaveQueue(): Promise<void> {
    if (runSubmissionInFlight.current || libraryInsertInFlight.current || documentCommandInFlight.current) return Promise.resolve();
    if (saveInFlight.current) {
      return saveInFlight.current.then(() => saveQueued.current ? drainSaveQueue() : undefined);
    }
    const run = async () => {
      let failedSnapshot: CanvasDocument | null = null;
      try {
        while (saveQueued.current) {
          const snapshot = saveQueued.current;
          saveQueued.current = null;
          failedSnapshot = snapshot;
          setSaveState('saving');
          // 当前批次的文本版本 ID 从此冻结；保存途中继续输入必须创建下一版。
          pendingTextVersions.current.clear();
          const saved = await saveCanvasDocument(projectId, {
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
          setDocument(current => {
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
          });
        }
        setSaveState('saved');
        setSaveErrorDetail(null);
      } catch (saveError) {
        if (!saveQueued.current && failedSnapshot) saveQueued.current = failedSnapshot;
        setSaveState('error');
        // 自动保存的失败在这里是唯一能被观察到的地方：调用方基本都 .catch(() => undefined)，
        // 而状态药丸在窄屏被 max-w-24 truncate 掉。保存一失败，本地文档就和服务端分叉了，
        // 之后每一次编辑都不落盘，所以必须把服务端的 detail 原样送到报错条上。
        const detail = (saveError as Error).message;
        setSaveErrorDetail(detail);
        setError(detail);
        throw saveError;
      }
    };
    const promise = run().finally(() => {
      if (saveInFlight.current === promise) saveInFlight.current = null;
    });
    saveInFlight.current = promise;
    return promise;
  }, [projectId]);

  useEffect(() => {
    const snapshot = latestDocument.current;
    if (!snapshot || dirtySignal === 0) return;
    saveQueued.current = snapshot;
    const timer = window.setTimeout(() => void flushSave().catch(() => undefined), 350);
    return () => window.clearTimeout(timer);
  }, [dirtySignal, flushSave]);

  // 撤销栈是个 ref（快照数组要在同一次事件里被连续读写，做不成 state），但撤销 / 重做按钮的禁用态
  // 得跟着它变。所以这条 effect 故意不写依赖数组：历史在 9 处被就地修改，每一处都伴随一次
  // setDocument，也就是每一次修改后都会跑到这里。两次长度读取 + 相等就 bail，代价是常数级。
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 规则担心的更新链由上面的相等 bail 掐断
  useEffect(() => {
    setHistoryDepth(current => {
      const past = history.current.past.length;
      const future = history.current.future.length;
      return current.past === past && current.future === future ? current : { past, future };
    });
  });

  // 上面那条 effect 每次 dirtySignal 变化都 clearTimeout，排队的快照没人接手。
  // 卸载（画布内返回、路由跳走、切项目）走的是 SPA 路径，fetch 不会被掐，所以这里补一次冲刷；
  // 清理函数用的是注册它那次 render 的闭包，切项目时冲的是旧 projectId，不会串项目。
  useEffect(() => () => {
    if (!saveQueued.current) return;
    void flushSave().catch(() => undefined);
  }, [flushSave]);

  // 关标签 / 刷新 / 硬跳转时 fetch 会被浏览器一起掐掉，冲不出去，只能拦一下让画师自己决定。
  useEffect(() => {
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      if (!saveQueued.current && !saveInFlight.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, []);

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
    if (zoomSliderActive.current) finishZoomSliderRef.current();
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
        await flushSave();
      } catch {
        setError('自动保存失败，已留在当前画布。请检查服务后重试。');
        return false;
      }
    }
    return true;
  }, [flushSave]);

  const commit = useCallback((updater: (current: CanvasDocument) => CanvasDocument, record = false) => {
    setDocument(current => {
      if (!current) return current;
      if (record) {
        history.current.past.push(current);
        history.current.past = history.current.past.slice(-50);
        history.current.future = [];
      } else if (history.current.future.length) {
        history.current.future = [];
      }
      return { ...updater(current), updated_at: new Date().toISOString() };
    });
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
  }, []);

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

  const flowNodes = useMemo<FlowNode[]>(() => {
    const activeIds = new Set<string>();
    const maximumPersistedZIndex = Math.max(0, ...(document?.nodes ?? []).map(node => node.z_index));
    const next = (document?.nodes ?? []).map(node => {
      activeIds.add(node.id);
      const selected = selectedNodeIds.has(node.id);
      const liveLayout = liveNodeLayout?.nodeId === node.id ? liveNodeLayout : undefined;
      const cached = flowNodeCache.current.get(node.id);
      if (
        cached?.node === node
        && cached.selected === selected
        && cached.liveLayout === liveLayout
      ) return cached.flowNode;
      const renderedSize = liveLayout?.size
        ?? canvasNodeRenderedSize(node, document?.content_versions ?? {});
      const flowNode: FlowNode = {
        id: node.id,
        type: 'canvasNode',
        position: liveLayout?.position ?? node.position,
        style: {
          width: renderedSize.width,
          height: renderedSize.height,
          zIndex: canvasNodeRenderZIndex(node.z_index, selected, maximumPersistedZIndex),
        },
        selected,
        data: { domain: node },
      };
      flowNodeCache.current.set(node.id, { node, selected, liveLayout, flowNode });
      return flowNode;
    });
    for (const id of flowNodeCache.current.keys()) {
      if (!activeIds.has(id)) flowNodeCache.current.delete(id);
    }
    return next;
  }, [document?.content_versions, document?.nodes, liveNodeLayout, selectedNodeIds]);

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
  const flowEdges = useMemo(() => {
    const titles = new Map((document?.nodes ?? []).map(node => [node.id, node.title]));
    const liveIds = new Set<string>();
    const next = (document?.connections ?? []).map(connection => {
      liveIds.add(connection.id);
      const active = activeNodeId === connection.source_node_id || activeNodeId === connection.target_node_id;
      const selected = selectedConnectionIds.has(connection.id);
      const sourceTitle = titles.get(connection.source_node_id) ?? connection.source_node_id;
      const targetTitle = titles.get(connection.target_node_id) ?? connection.target_node_id;
      const cached = flowEdgeCache.current.get(connection.id);
      if (
        cached?.connection === connection
        && cached.active === active
        && cached.selected === selected
        && cached.sourceTitle === sourceTitle
        && cached.targetTitle === targetTitle
      ) return cached.flowEdge;
      const flowEdge: Edge = {
        id: connection.id,
        source: connection.source_node_id,
        target: connection.target_node_id,
        // xyflow v12 没有 'bezier' 这个内置类型，写它会 fallback 到 default 并每次刷警告。
        type: 'default',
        className: cn(
          connection.role === 'derivation' ? 'canvas-provenance-edge' : 'canvas-input-edge',
          active && 'canvas-active-edge',
        ),
        ariaLabel: `${connection.role === 'derivation' ? '派生' : '输入'}连接：${sourceTitle} → ${targetTitle}`,
        interactionWidth: 16,
        selected,
        selectable: true,
        focusable: true,
        deletable: true,
      };
      flowEdgeCache.current.set(
        connection.id,
        { connection, active, selected, sourceTitle, targetTitle, flowEdge },
      );
      return flowEdge;
    });
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
  }, [activeNodeId, document?.connections, document?.nodes, selectedConnectionIds]);

  const isValidConnection = useCallback<IsValidConnection>((connection) => (
    canCreateCanvasInputConnection(latestDocument.current, connection)
  ), []);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const selectionChanges = changes.filter(change => change.type === 'select' || change.type === 'remove');
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
    const graphChanges = changes.filter(change => (
      change.type === 'remove'
      || (
        change.type === 'position'
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
  }, [commit]);

  const onConnect = useCallback((connection: Connection) => {
    if (!canCreateCanvasInputConnection(latestDocument.current, connection)) {
      setError('这两个节点不能建立输入连接。');
      return;
    }
    setError(null);
    commit(current => {
      return {
        ...current,
        connections: [...current.connections, {
          id: makeId('connection'),
          role: 'input',
          source_node_id: connection.source!,
          target_node_id: connection.target!,
        }],
      };
    }, true);
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

  const onConnectEnd = useCallback<OnConnectEnd>((event, state) => {
    setConnectionInProgress(false);
    if (state.isValid || !state.fromNode) return;
    if (state.toHandle) return;
    const pointer = pointerPosition(event);
    const startedFromTarget = state.fromHandle?.type === 'target';
    const dropNodeId = state.toNode?.id ?? (
      pointer ? connectionDropNodeId(pointer, startedFromTarget ? 'right' : 'left') : null
    );
    if (dropNodeId) {
      const connection: Connection = {
        source: startedFromTarget ? dropNodeId : state.fromNode.id,
        target: startedFromTarget ? state.fromNode.id : dropNodeId,
        sourceHandle: null,
        targetHandle: null,
      };
      if (canCreateCanvasInputConnection(latestDocument.current, connection)) onConnect(connection);
      return;
    }
    if (!pointer) return;
    setAddOpen(false);
    setCreateMenu({
      screen: {
        x: Math.max(12, Math.min(pointer.x, window.innerWidth - 252)),
        y: Math.max(12, Math.min(pointer.y, window.innerHeight - 356)),
      },
      flow: screenToFlowPosition(pointer),
      sourceId: state.fromNode.id,
      sourceHandle: state.fromHandle?.type ?? 'source',
    });
  }, [onConnect, screenToFlowPosition]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setSelectedConnectionIds(current => {
      const next = new Set(current);
      for (const change of changes) {
        if (change.type === 'select') change.selected ? next.add(change.id) : next.delete(change.id);
        if (change.type === 'remove') next.delete(change.id);
      }
      return next;
    });
    const removedIds = new Set(changes.filter(change => change.type === 'remove').map(change => change.id));
    if (removedIds.size) {
      commit(current => removeCanvasConnections(
        current,
        edge => removedIds.has(edge.id),
      ), true);
    }
  }, [commit]);

  const deleteSelection = useCallback(() => {
    if (selectedNodeIds.size === 0 && selectedConnectionIds.size === 0) return;
    const nodeIds = selectedNodeIds;
    const blocked = canvasDeletionBlockedMessage(latestDocument.current?.nodes ?? [], nodeIds);
    if (blocked) {
      setError(blocked);
      return;
    }
    commit(current => {
      const next = removeCanvasConnections(current, edge => (
        selectedConnectionIds.has(edge.id)
        || nodeIds.has(edge.source_node_id)
        || nodeIds.has(edge.target_node_id)
      ));
      return { ...next, nodes: next.nodes.filter(node => !nodeIds.has(node.id)) };
    }, true);
    setSelectedNodeIds(new Set());
    setSelectedConnectionIds(new Set());
    requestAnimationFrame(() => editorRegionRef.current?.focus());
  }, [commit, selectedConnectionIds, selectedNodeIds]);

  useEffect(() => {
    function handleDelete(event: KeyboardEvent) {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (isCanvasShortcutBlockedTarget(event.target)) return;
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
  const selectedDraft = selectedNode && !selectedIsUploadedImageMaterial
    && !(selectedNode.type === 'config' && selectedNode.data.draft.mode === 'text')
    ? generationDraftForNode(selectedNode)
    : null;
  const generationPanelOpen = Boolean(
    selectedNode
    && selectedDraft
    && dismissedGenerationPanelNodeId !== selectedNode.id,
  );
  const projectName = projects.find(project => project.project_id === projectId)?.name ?? '画布项目';

  function beginProjectRename() {
    cancelProjectRename.current = false;
    setProjectRenameDraft(projectName);
    requestAnimationFrame(() => projectRenameInputRef.current?.select());
  }

  async function commitProjectRename(restoreFocus: boolean) {
    if (projectRenameDraft === null || projectRenameInFlight.current || cancelProjectRename.current) return;
    const name = projectRenameDraft.trim();
    if (!name) {
      setError('请输入画布项目名称');
      requestAnimationFrame(() => projectRenameInputRef.current?.focus());
      return;
    }
    if (name === projectName) {
      setProjectRenameDraft(null);
      if (restoreFocus) requestAnimationFrame(() => projectRenameTriggerRef.current?.focus());
      return;
    }
    projectRenameInFlight.current = true;
    setProjectRenameBusy(true);
    setError(null);
    try {
      const renamed = await renameCanvasProject(projectId, name);
      setProjects(current => current.map(project => (
        project.project_id === projectId ? { ...project, name: renamed.name } : project
      )));
      setProjectRenameDraft(null);
      announceToolNotice(`已重命名为“${renamed.name}”`);
      if (restoreFocus) requestAnimationFrame(() => projectRenameTriggerRef.current?.focus());
    } catch (renameError) {
      setError((renameError as Error).message);
      requestAnimationFrame(() => projectRenameInputRef.current?.focus());
    } finally {
      projectRenameInFlight.current = false;
      setProjectRenameBusy(false);
    }
  }

  function defaultPosition() {
    return screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  }

  const mutateLibrary = useCallback(async (action: () => Promise<void>) => {
    if (libraryMutationInFlight.current) {
      const concurrentError = new Error('另一项创作库操作正在处理，请稍后再试。');
      setLibraryError(concurrentError.message);
      throw concurrentError;
    }
    libraryMutationInFlight.current = true;
    setLibraryBusy(true);
    setLibraryError(null);
    try {
      await action();
    } catch (mutationError) {
      setLibraryError((mutationError as Error).message);
      throw mutationError;
    } finally {
      libraryMutationInFlight.current = false;
      setLibraryBusy(false);
    }
  }, []);

  const saveNodeToLibrary = useCallback(async (node: CanvasContentNode) => {
    const versionId = node.data.current_version_id;
    if (!versionId) {
      setError('这个节点还没有可保存的内容。');
      return;
    }
    if (!await persistNow()) return;
    setLibraryMode('assets');
    try {
      await mutateLibrary(async () => {
        const currentAssets = assets ?? await getCanvasAssets(projectId);
        const updated = await saveCanvasAsset(
          projectId,
          versionId,
          node.title,
          [],
          currentAssets.revision,
        );
        acceptAssets(updated);
        setLibraryFocusAssetId(
          updated.items.find(item => item.version_id === versionId)?.asset_id ?? null,
        );
      });
    } catch {
      // 错误已显示在创作库面板。
    }
  }, [acceptAssets, assets, mutateLibrary, persistNow, projectId]);

  async function insertLibraryItem(
    kind: 'asset' | 'prompt',
    id: string,
    position = defaultPosition(),
  ) {
    if (!await persistNow()) return;
    const before = latestDocument.current;
    if (!before) return;
    const dirtyAtInsertion = dirtyVersion.current;
    libraryInsertInFlight.current = true;
    const command = (async () => {
      try {
        await mutateLibrary(async () => {
        const remote = kind === 'asset'
          ? await insertCanvasAsset(projectId, id, position, serverRevision.current)
          : await insertCanvasPrompt(projectId, id, position, serverRevision.current);
        const previousIds = new Set(before.nodes.map(node => node.id));
        const insertedNodes = remote.nodes.filter(node => !previousIds.has(node.id));
        const inserted = insertedNodes[0];
        const insertedVersions = Object.fromEntries(
          Object.entries(remote.content_versions).filter(([versionId]) => (
            !before.content_versions[versionId]
          )),
        );
        const concurrent = latestDocument.current ?? before;
        const concurrentIds = new Set(concurrent.nodes.map(node => node.id));
        const authoritativeRevision = Math.max(serverRevision.current, remote.revision);
        const merged: CanvasDocument = {
          ...concurrent,
          revision: authoritativeRevision,
          updated_at: remote.updated_at,
          nodes: [
            ...concurrent.nodes,
            ...insertedNodes.filter(node => !concurrentIds.has(node.id)),
          ],
          content_versions: acceptServerContentVersions(
            concurrent.content_versions,
            insertedVersions,
          ),
        };
        history.current.past.push(concurrent);
        history.current.past = history.current.past.slice(-50);
        history.current.future = [];
        serverRevision.current = authoritativeRevision;
        if (dirtyVersion.current > dirtyAtInsertion) {
          saveQueued.current = merged;
          setSaveState('saving');
        } else {
          saveQueued.current = null;
          setSaveState('saved');
        }
        setDocument(merged);
        flowNodeCache.current.clear();
        setSelectedConnectionIds(new Set());
        setSelectedNodeIds(inserted ? new Set([inserted.id]) : new Set());
        requestAnimationFrame(() => {
          if (inserted) documentQueryNode(inserted.id)?.focus();
        });
        });
      } catch {
        // 错误已显示在创作库面板。
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
  }

  function handleCanvasDrop(event: DragEvent) {
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length) {
      // 不 preventDefault 的话浏览器按默认行为打开这个文件，整个应用被顶掉，
      // 未保存的画布内容一起丢。快捷键面板本来就承诺「拖入图片 / 视频 / 音频 → 上传到画布」。
      event.preventDefault();
      const origin = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void (async () => {
        for (const [index, file] of files.entries()) {
          await handleUpload(file, {
            screen: { x: event.clientX, y: event.clientY },
            flow: { x: origin.x + index * 32, y: origin.y + index * 32 },
          });
        }
      })();
      return;
    }
    const raw = event.dataTransfer.getData(CANVAS_LIBRARY_DRAG_TYPE);
    if (!raw) return;
    event.preventDefault();
    try {
      const item = JSON.parse(raw) as { kind?: string; id?: string };
      if ((item.kind !== 'asset' && item.kind !== 'prompt') || !item.id) return;
      void insertLibraryItem(
        item.kind,
        item.id,
        screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    } catch {
      setLibraryError('无法识别拖入的创作库内容。');
    }
  }

  function appendNode(
    node: CanvasNode,
    menu: CreateMenuState | null,
    baseDocument?: CanvasDocument,
    initialVersions: CanvasContentVersion[] = [],
  ) {
    const apply = (current: CanvasDocument) => {
      const nodes = [...current.nodes, node];
      const connections = [...current.connections];
      const contentVersions = initialVersions.reduce<Record<string, CanvasContentVersion>>(
        (versions, version) => ({ ...versions, [version.version_id]: version }),
        current.content_versions,
      );
      if (menu?.sourceId) {
        const sourceNodeId = menu.sourceHandle === 'target' ? node.id : menu.sourceId;
        const targetNodeId = menu.sourceHandle === 'target' ? menu.sourceId : node.id;
        if (canCreateCanvasInputConnection({ ...current, nodes, content_versions: contentVersions }, {
          source: sourceNodeId,
          target: targetNodeId,
        })) {
          connections.push({
            id: makeId('connection'),
            role: 'input',
            source_node_id: sourceNodeId,
            target_node_id: targetNodeId,
          });
        }
      }
      return { ...current, nodes, connections, content_versions: contentVersions };
    };
    if (baseDocument) {
      // 上传命令创建的 Content Version 已是服务端历史；撤销只移除随后添加的节点。
      history.current.past.push(baseDocument);
      history.current.past = history.current.past.slice(-50);
      history.current.future = [];
      const next = apply(baseDocument);
      setDocument(next);
      dirtyVersion.current += 1;
      setDirtySignal(dirtyVersion.current);
    } else {
      commit(apply, true);
    }
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([node.id]));
    setAddOpen(false);
    setCreateMenu(null);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      documentQueryNode(node.id)?.focus();
    }));
  }

  function addTextNode(menu: CreateMenuState | null = createMenu) {
    addGenerationNode('text', menu);
  }

  function addGenerationNode(kind: JobKind, menu: CreateMenuState | null = createMenu) {
    const draft = createCanvasGenerationDraft(keys, kind, {
      inputPolicy: 'all_connected',
      preference: canvasUiPreferences.generation_defaults[kind],
    });
    const base = {
      id: makeId(kind),
      title: { text: '文本', image: '图片', video: '视频', audio: '音频' }[kind],
      position: menu?.flow ?? defaultPosition(),
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

  function addConfigNode(menu: CreateMenuState | null = createMenu) {
    const draft = createCanvasGenerationDraft(keys, 'image', {
      preference: canvasUiPreferences.generation_defaults.image,
      prompt: menu?.sourceId && menu.sourceHandle !== 'target'
        ? `@[node:${menu.sourceId}]`
        : '',
    });
    appendNode({
      id: makeId('config'),
      title: '生成配置',
      type: 'config',
      position: menu?.flow ?? defaultPosition(),
      z_index: 0,
      data: { draft },
    }, menu);
  }

  async function handleUpload(file: File, menuOverride: CreateMenuState | null = createMenu) {
    const menu = menuOverride;
    if (!await persistNow()) return;
    const current = latestDocument.current;
    if (!current) return;
    setAddOpen(false);
    setError(null);
    try {
      const uploaded = await uploadCanvasMedia(projectId, file, serverRevision.current);
      serverRevision.current = uploaded.document.revision;
      const version = uploaded.version;
      const concurrent = latestDocument.current ?? uploaded.document;
      const baseDocument: CanvasDocument = {
        ...concurrent,
        revision: uploaded.document.revision,
        updated_at: uploaded.document.updated_at,
        content_versions: acceptServerContentVersions(
          concurrent.content_versions,
          uploaded.document.content_versions,
        ),
      };
      const base = {
        id: makeId(version.kind),
        title: uploaded.filename,
        position: menu?.flow ?? defaultPosition(),
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
      appendNode(node, menu, baseDocument);
    } catch (uploadError) {
      setError((uploadError as Error).message);
    }
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
          connection.role === 'input'
          && copiedIds.has(connection.source_node_id)
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

  function pasteCanvasNodes(payload: CanvasClipboardPayload) {
    if (payload.source_project_id !== projectId) {
      announceToolNotice('节点剪贴板只在当前画布项目内可用');
      return;
    }
    if (!payload.nodes.length) return;
    pasteSequence.current += 1;
    const offset = 28 * pasteSequence.current;
    const idMap = new Map(payload.nodes.map(node => [node.id, makeId(node.type)]));
    const topZ = Math.max(0, ...(document?.nodes.map(node => node.z_index) ?? []));
    const nodes = payload.nodes.map((source, index) => cloneCanvasNode(
      source,
      idMap,
      { x: source.position.x + offset, y: source.position.y + offset },
      topZ + index + 1,
    ));
    const connections = payload.connections.flatMap(connection => {
      const sourceId = idMap.get(connection.source_node_id);
      const targetId = idMap.get(connection.target_node_id);
      return sourceId && targetId
        ? [{ ...structuredClone(connection), id: makeId('connection'), source_node_id: sourceId, target_node_id: targetId }]
        : [];
    });
    commit(current => ({
      ...current,
      nodes: [...current.nodes, ...nodes],
      connections: [...current.connections, ...connections],
    }), true);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set(nodes.map(node => node.id)));
    requestAnimationFrame(() => documentQueryNode(nodes[0].id)?.focus());
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
      position: defaultPosition(),
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
    setSelectedNodeIds(new Set([nodeId]));
    requestAnimationFrame(() => documentQueryNode(nodeId)?.focus());
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
      const payload = internalPayload && serialized === JSON.stringify(internalPayload)
        ? internalPayload
        : null;
      if (payload) {
        event.preventDefault();
        pasteCanvasNodes(payload);
        return;
      }
      const image = Array.from(clipboard.items)
        .find(item => item.kind === 'file' && item.type.startsWith('image/'))
        ?.getAsFile();
      if (image) {
        event.preventDefault();
        const flow = defaultPosition();
        void handleUpload(image, { screen: { x: 0, y: 0 }, flow });
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
    commit(current => ({ ...current, nodes: current.nodes.map(node => node.id === nodeId ? updater(node) : node) }));
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
      return {
        ...current,
        content_versions: { ...current.content_versions, [versionId]: version },
        nodes: current.nodes.map(candidate => candidate.id === nodeId && candidate.type === 'text'
          ? { ...candidate, data: { ...candidate.data, current_version_id: versionId } }
          : candidate),
      };
    });
  }, [commit]);

  const deleteNode = useCallback((nodeId: string) => {
    const blocked = canvasDeletionBlockedMessage(
      latestDocument.current?.nodes ?? [],
      new Set([nodeId]),
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
  }, [commit]);

  const submitRun = useCallback(async (nodeId: string) => {
    if (runSubmissionInFlight.current) {
      setError('另一项生成正在提交，请稍后再试。');
      return;
    }
    setSubmittingNodeIds(current => new Set(current).add(nodeId));
    setError(null);
    try {
      if (!await persistNow()) return;
      const current = latestDocument.current;
      const node = current?.nodes.find(candidate => candidate.id === nodeId);
      const draft = node ? generationDraftForNode(node) : null;
      if (!current || !node || !draft) throw new Error('当前节点没有可提交的生成设置');
      const requestedCount = draft.mode === 'text' || draft.mode === 'image'
        ? Math.max(1, Math.min(4, Number(draft.params.n ?? 1)))
        : 1;
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

  const reversePrompt = useCallback(async (node: CanvasContentNode) => {
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
      if (!await persistNow()) return;
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

  const retryRun = useCallback(async (nodeId: string, runId: string) => {
    if (runSubmissionInFlight.current) {
      setError('另一项生成正在提交，请稍后再试。');
      return;
    }
    setSubmittingNodeIds(current => new Set(current).add(nodeId));
    setError(null);
    try {
      if (!await persistNow()) return;
      const dirtyAtSubmission = dirtyVersion.current;
      runSubmissionInFlight.current = true;
      const run = await retryCanvasRun(projectId, runId, serverRevision.current);
      if (run.job.canvas_run && isReversePromptJob(run.job)) {
        reversePromptConfigEligibleRuns.current.add(run.job.canvas_run.run_id);
      }
      mergeSubmittedRunDocument(run.document, run.job, dirtyAtSubmission);
      applyLocalJob(run.job);
      const resultId = run.job.canvas_run?.result_node_id;
      if (resultId) setSelectedNodeIds(new Set([resultId]));
    } catch (retryError) {
      setError(canvasRetryErrorMessage(retryError));
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

  const cancelRun = useCallback(async (runId: string) => {
    setError(null);
    try {
      const updated = await cancelCanvasRun(projectId, runId);
      applyLocalJob(updated);
    } catch (cancelError) {
      setError((cancelError as Error).message);
    }
  }, [applyLocalJob, projectId]);

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
    if (zoomSliderCommitTimer.current !== null) window.clearTimeout(zoomSliderCommitTimer.current);
    zoomSliderCommitTimer.current = null;
    zoomSliderActive.current = false;
    zoomSliderMove.current = null;
  }, []);

  const beginZoomSlider = useCallback(() => {
    interruptViewportCommand();
    if (zoomSliderCommitTimer.current !== null) window.clearTimeout(zoomSliderCommitTimer.current);
    zoomSliderCommitTimer.current = null;
    zoomSliderActive.current = true;
    const viewport = getViewport();
    zoomSliderMove.current = setViewport(viewport).then(() => true, () => true);
  }, [getViewport, interruptViewportCommand, setViewport]);

  const commitZoomSliderViewport = useCallback(() => {
    if (latestDocument.current?.project_id !== projectId) return;
    const viewport = getViewport();
    viewportSync.current = { projectId, viewport };
    if (!commitViewportDocument(viewport)) viewportSync.current = null;
  }, [commitViewportDocument, getViewport, projectId]);

  const finishZoomSlider = useCallback(() => {
    if (!zoomSliderActive.current) return;
    if (zoomSliderCommitTimer.current !== null) window.clearTimeout(zoomSliderCommitTimer.current);
    zoomSliderCommitTimer.current = null;
    const finalize = () => {
      if (!zoomSliderActive.current) return;
      zoomSliderActive.current = false;
      commitZoomSliderViewport();
    };
    const move = zoomSliderMove.current;
    let timeoutId: number | null = null;
    const moveSettled = move
      ? Promise.race([
          move.then(() => undefined, () => undefined),
          new Promise<void>(resolve => {
            timeoutId = window.setTimeout(resolve, 250);
          }),
        ])
      : Promise.resolve();
    const pending = moveSettled.then(finalize).finally(() => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    });
    pendingViewportCommand.current = pending;
    const clearPending = () => {
      if (pendingViewportCommand.current === pending) pendingViewportCommand.current = null;
    };
    void pending.then(clearPending, clearPending);
  }, [commitZoomSliderViewport]);
  finishZoomSliderRef.current = finishZoomSlider;

  const scheduleZoomSliderCommit = useCallback(() => {
    if (zoomSliderCommitTimer.current !== null) window.clearTimeout(zoomSliderCommitTimer.current);
    zoomSliderCommitTimer.current = window.setTimeout(() => {
      zoomSliderCommitTimer.current = null;
      finishZoomSlider();
    }, 120);
  }, [finishZoomSlider]);

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

  const undo = useCallback(() => {
    const previous = history.current.past.pop();
    if (!previous || !document) return;
    history.current.future.push(document);
    const restored = {
      ...previous,
      revision: document.revision,
      updated_at: new Date().toISOString(),
      // 镜头既不进撤销栈也不被撤销还原：撤销时把用户当前的取景留住，不要把画布甩回快照拍下时
      // 的位置——那次跳动本身比看不见变化更让人失去方向。
      viewport: document.viewport,
      content_versions: restoreContentVersions(
        previous.content_versions,
        document.content_versions,
      ),
    };
    setDocument(restored);
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
  }, [document]);

  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next || !document) return;
    history.current.past.push(document);
    const restored = {
      ...next,
      revision: document.revision,
      updated_at: new Date().toISOString(),
      viewport: document.viewport,
      content_versions: restoreContentVersions(
        next.content_versions,
        document.content_versions,
      ),
    };
    setDocument(restored);
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
  }, [document]);

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
            && connection.slot
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

  const jobsByRunId = useMemo(() => new Map(
    jobs.flatMap(job => job.canvas_run ? [[job.canvas_run.run_id, job] as const] : []),
  ), [jobs]);
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
  const reversePromptConfiguredNodeIds = useMemo(() => {
    const configured = new Set<string>();
    const document = mentionDocumentRef.current;
    if (!document) return configured;
    const configIds = new Set(
      document.nodes.filter(node => node.type === 'config').map(node => node.id),
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
    if (version) setPreview({ nodeId, title, version });
  }, []);

  const announceToolNotice = useCallback((message: string) => {
    setToolNotice(message);
    if (toolNoticeTimer.current !== null) window.clearTimeout(toolNoticeTimer.current);
    toolNoticeTimer.current = window.setTimeout(() => {
      setToolNotice(null);
      toolNoticeTimer.current = null;
    }, 1800);
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
      if (!remoteConfig || remoteConfig.type !== 'config') {
        throw new Error('服务端没有返回反推图片配置节点。');
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
      // 选中态）才把焦点挪到新配置节点。用户已经去点别的东西了就别抢。
      const selection = latestSelectedNodeIds.current;
      if (selection.size === 1 && selection.has(context.result_node_id)) {
        setSelectedConnectionIds(new Set());
        setSelectedNodeIds(new Set([configId]));
      }
      announceToolNotice('已从反推文本创建图片生成配置');
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

  const replaceMedia = useCallback((node: CanvasContentNode) => {
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
    });
    requestAnimationFrame(() => {
      if (!replaceMediaRef.current) return;
      replaceMediaRef.current.value = '';
      replaceMediaRef.current.click();
    });
  }, []);

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
      setSelectedConnectionIds(new Set());
      setSelectedNodeIds(new Set([target.nodeId]));
      announceToolNotice(mergeStatus === 'applied'
        ? target.hadContent
          ? `已替换“${target.title}”，旧版本仍可撤销恢复`
          : `已将文件上传到“${target.title}”`
        : `“${target.title}”已有更新内容；上传文件已保留为历史版本`);
      requestAnimationFrame(() => documentQueryNode(target.nodeId)?.focus());
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
            ? sizeLockedToVersion(candidate.size, version)
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

  const openMaskEdit = useCallback((node: CanvasContentNode) => {
    const versionId = node.data.current_version_id;
    const version = versionId ? latestDocument.current?.content_versions[versionId] : null;
    if (node.type !== 'image' || !version || version.kind !== 'image' || !version.width || !version.height) {
      setError('这个节点没有可局部编辑的图片版本。');
      return;
    }
    setPreview(null);
    setMediaOperation(null);
    setMaskEditError(null);
    setMaskEdit({ nodeId: node.id, title: node.title, version });
  }, []);

  const submitMaskEdit = useCallback(async (submission: CanvasMaskEditSubmission) => {
    if (!maskEdit || runSubmissionInFlight.current) return;
    setMaskEditBusy(true);
    setMaskEditError(null);
    setSubmittingNodeIds(current => new Set(current).add(maskEdit.nodeId));
    try {
      if (documentCommandInFlight.current) {
        setMaskEditError('另一个媒体操作正在处理，请稍后重试。');
        return;
      }
      const before = latestDocument.current;
      if (!before) return;
      const sourceNode = before.nodes.find(node => node.id === maskEdit.nodeId);
      if (!sourceNode || sourceNode.type !== 'image') {
        setMaskEditError('源图片节点已经不存在。');
        return;
      }
      history.current.past.push(before);
      history.current.past = history.current.past.slice(-50);
      history.current.future = [];
      const withDraft: CanvasDocument = {
        ...before,
        updated_at: new Date().toISOString(),
        nodes: before.nodes.map(node => node.id === maskEdit.nodeId && node.type === 'image'
          ? { ...node, data: { ...node.data, generation_draft: submission.draft } }
          : node),
      };
      latestDocument.current = withDraft;
      setDocument(withDraft);
      dirtyVersion.current += 1;
      setDirtySignal(dirtyVersion.current);
      saveQueued.current = withDraft;
      try {
        await flushSave();
      } catch {
        setMaskEditError('自动保存失败，局部编辑尚未提交。请检查服务后重试。');
        return;
      }
      const dirtyAtSubmission = dirtyVersion.current;
      runSubmissionInFlight.current = true;
      const run = await submitCanvasMaskEdit(
        projectId,
        maskEdit.nodeId,
        serverRevision.current,
        submission.requestedCount,
        submission.mask,
      );
      mergeSubmittedRunDocument(run.document, run.job, dirtyAtSubmission);
      applyLocalJob(run.job);
      const resultId = run.job.canvas_run?.result_node_id;
      if (resultId) setSelectedNodeIds(new Set([resultId]));
      setMaskEdit(null);
      announceToolNotice(`已提交“${maskEdit.title}”的局部编辑`);
    } catch (submitError) {
      setMaskEditError((submitError as Error).message);
    } finally {
      runSubmissionInFlight.current = false;
      setMaskEditBusy(false);
      setSubmittingNodeIds(current => {
        const next = new Set(current);
        next.delete(maskEdit.nodeId);
        return next;
      });
      if (saveQueued.current) void flushSave().catch(() => undefined);
    }
  }, [
    announceToolNotice,
    applyLocalJob,
    flushSave,
    maskEdit,
    mergeSubmittedRunDocument,
    projectId,
  ]);

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
    commit(current => ({
      ...current,
      nodes: current.nodes.map(candidate => candidate.id === node.id && candidate.type === 'video'
        ? { ...candidate, data: { ...candidate.data, generation_draft: draft } }
        : candidate),
    }), true);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([node.id]));
    announceToolNotice(`已打开“${node.title}”的视频编辑设置`);
  }, [announceToolNotice, commit, jobsByResultNodeId, keys]);

  const createImageConfigFromText = useCallback((nodeId: string) => {
    const current = latestDocument.current;
    const source = current?.nodes.find(node => node.id === nodeId);
    const version = source && source.type === 'text' && source.data.current_version_id
      ? current?.content_versions[source.data.current_version_id]
      : null;
    if (!current || !source || source.type !== 'text' || version?.kind !== 'text') {
      setError('这个文本节点暂时无法创建图片生成配置。');
      return;
    }
    const configId = makeId('config');
    const next = createConnectedCanvasConfig(
      current,
      nodeId,
      createCanvasGenerationDraft(keys, 'image', {
        preference: canvasUiPreferences.generation_defaults.image,
      }),
      { nodeId: configId, connectionId: makeId('connection') },
    );
    if (!next) {
      setError('无法从这个文本节点创建图片生成配置。');
      return;
    }
    setError(null);
    commit(() => next, true);
    setDismissedGenerationPanelNodeId(null);
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([configId]));
    setAddOpen(false);
    setCreateMenu(null);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      documentQueryNode(configId)?.focus();
    }));
  }, [canvasUiPreferences.generation_defaults.image, commit, keys]);

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

  const submitMediaOperation = useCallback(async (operation: CanvasMediaOperation) => {
    if (!mediaOperation || mediaOperationInFlight.current) return;
    if (documentCommandInFlight.current) {
      setMediaOperationError('另一个媒体操作正在处理，请稍后重试。');
      return;
    }
    mediaOperationInFlight.current = true;
    setMediaOperationBusy(true);
    setMediaOperationError(null);
    try {
      if (!await persistNow()) {
        setMediaOperationError('自动保存失败，图片处理尚未开始。请检查服务后重试。');
        return;
      }
      const before = latestDocument.current;
      if (!before) return;
      const dirtyAtCommand = dirtyVersion.current;
      documentCommandInFlight.current = true;
      const result = await runCanvasMediaOperation(
        projectId,
        mediaOperation.nodeId,
        mediaOperation.version.version_id,
        serverRevision.current,
        operation,
      );
      const concurrent = latestDocument.current ?? before;
      const knownNodeIds = new Set(concurrent.nodes.map(node => node.id));
      const knownConnectionIds = new Set(concurrent.connections.map(connection => connection.id));
      const createdNodes = result.document.nodes.filter(node => (
        result.created_node_ids.includes(node.id) && !knownNodeIds.has(node.id)
      ));
      const createdConnections = result.document.connections.filter(connection => (
        connection.role === 'derivation'
        && result.created_node_ids.includes(connection.target_node_id)
        && !knownConnectionIds.has(connection.id)
      ));
      const merged: CanvasDocument = {
        ...concurrent,
        revision: result.document.revision,
        updated_at: result.document.updated_at,
        nodes: [...concurrent.nodes, ...createdNodes],
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
      latestDocument.current = merged;
      if (dirtyVersion.current > dirtyAtCommand) saveQueued.current = merged;
      flowNodeCache.current.clear();
      setDocument(merged);
      setSelectedConnectionIds(new Set());
      setSelectedNodeIds(new Set(result.created_node_ids));
      setMediaOperation(null);
      announceToolNotice(
        operation.kind === 'split'
          ? `已生成 ${result.created_node_ids.length} 个切图节点`
          : operation.kind === 'crop' ? '已生成裁剪节点' : '已生成本地放大节点',
      );
      requestAnimationFrame(() => editorRegionRef.current?.focus());
    } catch (operationError) {
      setMediaOperationError((operationError as Error).message);
    } finally {
      documentCommandInFlight.current = false;
      mediaOperationInFlight.current = false;
      setMediaOperationBusy(false);
      if (saveQueued.current) void flushSave().catch(() => {
        setError('图片处理已完成，但并发编辑尚未保存。请检查服务后重试。');
      });
    }
  }, [announceToolNotice, flushSave, mediaOperation, persistNow, projectId]);

  const persistCanvasUiPreferences = useCallback(async (
    imageToolbar: CanvasImageToolbarPreferences,
    generationDefaults: CanvasGenerationDefaults,
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
    '图片快捷工具已更新',
  ), [canvasUiPreferences.generation_defaults, persistCanvasUiPreferences]);

  const persistGenerationPreferences = useCallback(async (
    value: CanvasGenerationDefaults,
  ) => {
    setGenerationPreferencesSaving(true);
    setCanvasUiPreferencesError(null);
    try {
      await persistCanvasUiPreferences(
        canvasUiPreferences.image_toolbar,
        value,
        '生成偏好已更新',
      );
      setGenerationPreferencesOpen(false);
      requestAnimationFrame(() => generationPreferencesTriggerRef.current?.focus());
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
      sources.add(connection.source_node_id);
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
      if (connection.role !== 'input' || !connection.slot) continue;
      const frames = result.get(connection.target_node_id) ?? {};
      frames[connection.slot] = connection.source_node_id;
      result.set(connection.target_node_id, frames);
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 见上方图签名说明
  }, [mentionGraphSignature]);

  const contextValue = useMemo<CanvasNodeContextValue>(() => ({
    projectId,
    materialReferences,
    connectedMaterialNodeIdsByNodeId,
    videoFrameNodeIdsByNodeId,
    pendingInputNodesByNodeId,
    mentionReferencesByNodeId,
    resolveVersion,
    keys,
    jobsByRunId,
    jobsByResultNodeId,
    submittingNodeIds,
    mediaReplaceBusyNodeIds,
    mediaReplaceError,
    canvasUiPreferences,
    canvasUiPreferencesError,
    showImageInfo: document?.settings?.show_image_info ?? true,
    libraryBusy,
    multiSelectionActive: selectedNodeIds.size > 1,
    generationPanel: {
      dismissedNodeId: dismissedGenerationPanelNodeId,
      narrowViewport,
      dismiss: dismissGenerationPanel,
      surfaceRef: editorRegionRef,
    },
    materialPick,
    beginMaterialPick,
    setMaterialConnected,
    setVideoFrameConnections,
    selectNode: selectOnlyNode,
    previewContent,
    selectCandidate,
    submitRun,
    retryRun,
    cancelRun,
    dismissCandidate,
    updateNode,
    previewNodeResize,
    completeNodeResize,
    renameNode,
    updateText,
    createImageConfigFromText,
    recordHistory: recordHistorySnapshot,
    saveAsset: saveNodeToLibrary,
    copyPrompt,
    reversePrompt,
    recoverReversePromptConfig,
    reversePromptConfiguredNodeIds,
    replaceMedia,
    toggleFreeResize,
    openMediaOperation,
    openMaskEdit,
    openAngle,
    editVideo,
    saveImageToolbarPreferences: persistImageToolbarPreferences,
    deleteNode,
  }), [
    // assets 的失效经由 saveNodeToLibrary 传导（它依赖 assets），不再单列 assets?.revision。
    beginMaterialPick,
    cancelRun,
    canvasUiPreferences,
    canvasUiPreferencesError,
    connectedMaterialNodeIdsByNodeId,
    completeNodeResize,
    copyPrompt,
    createImageConfigFromText,
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
    libraryBusy,
    mediaReplaceBusyNodeIds,
    mediaReplaceError,
    materialReferences,
    materialPick,
    mentionReferencesByNodeId,
    narrowViewport,
    openAngle,
    openMaskEdit,
    openMediaOperation,
    previewContent,
    persistImageToolbarPreferences,
    projectId,
    recordHistorySnapshot,
    recoverReversePromptConfig,
    replaceMedia,
    reversePrompt,
    reversePromptConfiguredNodeIds,
    retryRun,
    renameNode,
    saveNodeToLibrary,
    selectedNodeIds.size,
    selectCandidate,
    selectOnlyNode,
    setMaterialConnected,
    setVideoFrameConnections,
    submitRun,
    submittingNodeIds,
    toggleFreeResize,
    updateNode,
    updateText,
    previewNodeResize,
    resolveVersion,
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

  if (loading) return <EditorMessage icon={<LoaderCircle className="size-5 animate-spin" />} text="正在展开画布…" />;
  if (!document) return <EditorMessage text={error || '画布读取失败'} action={<Button onClick={onBack}>返回项目列表</Button>} />;

  const background = backgroundVariant(document.settings.background);
  const previewNode = preview
    ? document.nodes.find(node => node.id === preview.nodeId) ?? null
    : null;
  const previewPrompt = previewNode
    ? copyablePromptForNode(previewNode, jobsByResultNodeId)
    : null;
  const previewJobId = preview && preview.version.origin.kind === 'job_output'
    ? preview.version.origin.job_id
    : null;
  const previewJob = previewJobId
    ? jobs.find(job => job.job_id === previewJobId)
    : undefined;
  const maskEditNode = maskEdit
    ? document.nodes.find(node => node.id === maskEdit.nodeId) ?? null
    : null;
  const maskEditDraft = maskEditNode ? generationDraftForNode(maskEditNode) : null;

  const renderCanvasConfigControls = (placement: 'mobile' | 'desktop') => (
    <>
      <button
        type="button"
        title={document.settings.show_minimap ? '关闭小地图' : '打开小地图'}
        aria-label={document.settings.show_minimap ? '关闭小地图' : '打开小地图'}
        aria-pressed={document.settings.show_minimap}
        className={cn(
          CANVAS_CHROME_BUTTON_CLASS,
          document.settings.show_minimap && 'bg-secondary text-foreground',
        )}
        onClick={() => commit(current => ({
          ...current,
          settings: { ...current.settings, show_minimap: !current.settings.show_minimap },
        }), true)}
      ><MapPinned /></button>
      <ToolButton buttonRef={assetLibraryTriggerRef} label="项目资产库" active={libraryMode === 'assets'} expanded={libraryMode === 'assets'} controlsId="canvas-library-panel" popup={false} onClick={() => { setAddOpen(false); setCreateMenu(null); setLibraryMode(current => current === 'assets' ? null : 'assets'); }}><Library /></ToolButton>
      <ToolButton buttonRef={promptLibraryTriggerRef} label="项目提示词库" active={libraryMode === 'prompts'} expanded={libraryMode === 'prompts'} controlsId="canvas-library-panel" popup={false} onClick={() => { setAddOpen(false); setCreateMenu(null); setLibraryMode(current => current === 'prompts' ? null : 'prompts'); }}><WandSparkles /></ToolButton>
      <ToolButton
        buttonRef={generationPreferencesTriggerRef}
        label="生成偏好"
        active={generationPreferencesOpen}
        expanded={generationPreferencesOpen}
        controlsId="canvas-generation-preferences-dialog"
        popup="dialog"
        onClick={() => {
          setAddOpen(false);
          setCreateMenu(null);
          setGenerationPreferencesOpen(true);
        }}
      ><Settings2 /></ToolButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="画布外观"
            aria-label="画布外观"
            className={cn(CANVAS_CHROME_BUTTON_CLASS, 'data-[state=open]:bg-primary data-[state=open]:text-primary-foreground')}
          >
            <Grid2X2 aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side={placement === 'mobile' ? 'right' : 'top'} align="start" className="w-48 rounded-xl">
          <DropdownMenuLabel>主题</DropdownMenuLabel>
          <CanvasThemeSelector />
          <DropdownMenuSeparator />
          <DropdownMenuLabel>画布背景</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={document.settings.background}
            onValueChange={value => {
              if (value !== 'none' && value !== 'dots' && value !== 'lines') return;
              if (value === document.settings.background) return;
              commit(current => ({
                ...current,
                settings: { ...current.settings, background: value },
              }), true);
            }}
          >
            {([
              ['none', '空白', Square],
              ['dots', '点阵', CircleDot],
              ['lines', '线框', Grid2X2],
            ] as const).map(([value, label, Icon]) => (
              <DropdownMenuRadioItem key={value} value={value} className="gap-2">
                <Icon className="size-4" aria-hidden="true" />{label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={document.settings.show_image_info}
            className="gap-2"
            onCheckedChange={checked => commit(current => ({
              ...current,
              settings: { ...current.settings, show_image_info: checked },
            }), true)}
          >
            <Info className="size-4" aria-hidden="true" />显示图片信息
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* 沉浸式画布把整条顶栏（含设置入口）藏了：没有密钥的新用户在画布里点不动「生成」，
          也没有任何地方能去配置。这颗按钮是画布内唯一的全局设置出口。 */}
      <Link
        href="/settings"
        title="设置"
        aria-label="设置"
        className={CANVAS_CHROME_BUTTON_CLASS}
      ><Settings aria-hidden="true" /></Link>
      <ToolButton
        buttonRef={shortcutsTriggerRef}
        label="快捷键"
        expanded={shortcutsOpen}
        controlsId="canvas-shortcuts-dialog"
        popup="dialog"
        onClick={() => setShortcutsOpen(true)}
      ><CircleHelp /></ToolButton>
    </>
  );

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
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={canvasNodeTypes}
          onConnect={onConnect}
          onConnectStart={() => setConnectionInProgress(true)}
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
          onNodeClick={(event, node) => {
            // xyflow 在 onNodeClick 之前已经按 multiSelectionKeyCode 把这次点击并进（或移出）选择集，
            // 这里再无条件调 selectOnlyNode 会立刻打平成单选——快捷键面板承诺的「Shift / ⌘ 点击追加
            // 选择」一直因此失效。取材模式不参与：那时点击的语义是「挑这一个」。
            if (!materialPick && (event.shiftKey || event.metaKey || event.ctrlKey)) return;
            selectOnlyNode(node.id);
          }}
          onNodeMouseEnter={(_, node) => setHoveredNodeId(node.id)}
          onNodeMouseLeave={(_, node) => setHoveredNodeId(current => current === node.id ? null : current)}
          onNodeDragStart={recordHistorySnapshot}
          onMoveStart={event => {
            if (!event) return;
            interruptViewportCommand();
            viewportSync.current = null;
          }}
          onMove={(_, viewport: Viewport) => setViewportZoom(viewport.zoom)}
          onPaneClick={() => {
            setCreateMenu(null);
            if (materialPick) {
              requestAnimationFrame(() => editorRegionRef.current?.focus());
              return;
            }
            setSelectedConnectionIds(new Set());
            setSelectedNodeIds(new Set());
            requestAnimationFrame(() => editorRegionRef.current?.focus());
          }}
          onDragOver={event => {
            const types = event.dataTransfer.types;
            // 'Files' 也要接：dragover 不 preventDefault 时 drop 事件根本不会派发，
            // 浏览器直接导航到被拖进来的文件。
            if (!types.includes(CANVAS_LIBRARY_DRAG_TYPE) && !types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={handleCanvasDrop}
          onMoveEnd={(_, viewport: Viewport) => {
            if (latestDocument.current?.project_id !== projectId) return;
            if (zoomSliderActive.current || pendingViewportCommand.current) return;
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
          onlyRenderVisibleElements
          className={cn('canvas-flow', connectionInProgress && 'canvas-flow-connecting')}
          style={{
            '--canvas-handle-size': `${48 / viewportZoom}px`,
            '--canvas-handle-dot-size': `${12 / viewportZoom}px`,
            '--canvas-handle-border-size': `${2 / viewportZoom}px`,
          } as CSSProperties}
        >
          {background && <Background variant={background} gap={22} size={1} />}
          {document.settings.show_minimap && !materialPick && (
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
                void runViewportCommand(() => setCenter(position.x, position.y, { zoom: getZoom(), duration: 150 }));
              }}
            />
          )}
        </ReactFlow>

        {document.nodes.length === 0 && !materialPick && (
          // 新建的画布原来是一整块空背景：没有任何东西说这里能放什么、从哪儿开始。
          // 壳不吃事件，画布照样能拖能缩放。
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-6">
            <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-xl border border-border bg-glass p-6 text-center backdrop-blur-glass shell-glow">
              <p className="text-sm font-medium text-foreground">画布还是空的</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                从一个节点开始：文本节点写提示词，空的图片 / 视频节点填生成设置，
                或者把本地素材直接拖进画布。节点之间连线，输出就会成为下一步的输入。
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button size="sm" variant="outline" onClick={() => addTextNode(null)}>
                  <Type aria-hidden="true" />文本节点
                </Button>
                <Button size="sm" variant="outline" onClick={() => addGenerationNode('image', null)}>
                  <FileImage aria-hidden="true" />图片节点
                </Button>
                <Button size="sm" variant="outline" onClick={() => uploadRef.current?.click()}>
                  <Upload aria-hidden="true" />上传素材
                </Button>
              </div>
            </div>
          </div>
        )}

        {selectedNodeIds.size > 1 && (
          <div
            role="toolbar"
            aria-label={`已选择 ${selectedNodeIds.size} 个节点`}
            className="pointer-events-auto absolute left-1/2 top-20 z-30 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow"
          >
            <span className="px-2 text-xs font-medium text-foreground">
              已选 {selectedNodeIds.size} 个节点
            </span>
            <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={deleteSelection}
            >
              <Trash2 aria-hidden="true" />
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
              <X aria-hidden="true" />
            </Button>
          </div>
        )}

        {!materialPick && (
          <div className="canvas-zoom-dock absolute bottom-3 left-3 z-20 hidden items-center gap-1 rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow md:flex">
          {!narrowViewport && renderCanvasConfigControls('desktop')}
          <span className="mx-1 h-7 w-px bg-border" aria-hidden="true" />
          <button
            type="button"
            aria-label="缩小画布"
            disabled={viewportZoom <= CANVAS_MIN_ZOOM + 0.0005}
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              if (getZoom() <= CANVAS_MIN_ZOOM + 0.0005) return;
              void runViewportCommand(() => zoomOut({ duration: 150 }));
            }}
          ><Minus className="size-4" aria-hidden="true" /></button>
          <input
            type="range"
            min="8"
            max="250"
            step="1"
            value={Math.round(viewportZoom * 100)}
            aria-label="画布缩放百分比"
            aria-valuetext={`${Math.round(viewportZoom * 100)}%`}
            className="h-1 w-24 cursor-pointer accent-primary sm:w-32"
            onPointerDown={beginZoomSlider}
            onPointerUp={finishZoomSlider}
            onPointerCancel={finishZoomSlider}
            onKeyDown={event => {
              if (isRangeAdjustmentKey(event.key)) beginZoomSlider();
            }}
            onKeyUp={event => {
              if (isRangeAdjustmentKey(event.key)) finishZoomSlider();
            }}
            onBlur={finishZoomSlider}
            onChange={event => {
              const shouldScheduleCommit = !zoomSliderActive.current
                || zoomSliderCommitTimer.current !== null;
              if (!zoomSliderActive.current) beginZoomSlider();
              const zoom = Number(event.target.value) / 100;
              setViewportZoom(zoom);
              const previousMove = zoomSliderMove.current;
              zoomSliderMove.current = previousMove
                ? previousMove.then(() => zoomTo(zoom), () => zoomTo(zoom))
                : zoomTo(zoom);
              if (shouldScheduleCommit) scheduleZoomSliderCommit();
            }}
          />
          <span aria-live="polite" className="w-11 text-right text-xs tabular-nums text-muted-foreground">{Math.round(viewportZoom * 100)}%</span>
          <button
            type="button"
            aria-label="放大画布"
            disabled={viewportZoom >= CANVAS_MAX_ZOOM - 0.0005}
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              if (getZoom() >= CANVAS_MAX_ZOOM - 0.0005) return;
              void runViewportCommand(() => zoomIn({ duration: 150 }));
            }}
          ><Plus className="size-4" aria-hidden="true" /></button>
          <button
            type="button"
            aria-label="复位画布缩放到 100%"
            className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onClick={() => {
              if (Math.abs(getZoom() - 1) < 0.001) return;
              void runViewportCommand(() => zoomTo(1, { duration: 150 }));
            }}
          ><Scan className="size-4" aria-hidden="true" /></button>
          </div>
        )}

        {materialPick && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-auto absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-primary py-1 pl-4 pr-1 text-xs font-medium text-primary-foreground shell-glow sm:top-4"
          >
            <span>从画布选择参考</span>
            <button
              type="button"
              aria-label="退出画布参考选择"
              className="rounded-full bg-background/20 px-2.5 py-1 text-primary-foreground transition-colors hover:bg-background/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground"
              onClick={() => {
                setMaterialPick(null);
                requestAnimationFrame(() => editorRegionRef.current?.focus());
              }}
            >
              退出
            </button>
          </div>
        )}

        <div className="canvas-editor-top pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-start gap-2 p-2 sm:gap-3 sm:p-3 md:p-4">
          <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
            <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="返回画布项目列表" onClick={() => void persistNow().then(saved => { if (saved) onBack(); })}><ArrowLeft /></Button>
            <div className="h-6 w-px bg-border" />
            {projectRenameDraft === null ? (
              <div className="flex min-w-0 items-center">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      title="切换画布项目"
                      className="flex h-9 min-w-0 max-w-28 items-center gap-1 rounded-md px-2 text-sm font-medium text-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary data-[state=open]:bg-secondary sm:max-w-52"
                    >
                      <span className="truncate">{projectName}</span>
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="bottom" align="start" className="min-w-44 rounded-xl">
                    <DropdownMenuLabel>切换项目</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={projectId}
                      onValueChange={value => {
                        if (value === projectId) return;
                        void persistNow().then(saved => { if (saved) onSwitchProject(value); });
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
                <Button ref={projectRenameTriggerRef} variant="ghost" size="icon" className="size-8 shrink-0" aria-label={`重命名画布项目 ${projectName}`} onClick={beginProjectRename}>
                  <Pencil className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <Input
                ref={projectRenameInputRef}
                value={projectRenameDraft}
                disabled={projectRenameBusy}
                aria-label="画布项目名称"
                className="h-9 w-32 sm:w-52"
                onChange={event => setProjectRenameDraft(event.target.value)}
                onBlur={() => void commitProjectRename(false)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    void commitProjectRename(true);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelProjectRename.current = true;
                    setProjectRenameDraft(null);
                    requestAnimationFrame(() => projectRenameTriggerRef.current?.focus());
                  }
                }}
              />
            )}
          </div>
          <div
            aria-live="polite"
            className={cn(
              'pointer-events-auto max-w-24 truncate rounded-full border bg-glass px-3 py-2 text-xs backdrop-blur-glass shell-glow sm:max-w-none',
              saveState === 'error'
                ? 'border-destructive/40 text-destructive'
                : 'border-border text-muted-foreground',
            )}
          >
            {saveState === 'saving' ? '保存中…' : saveState === 'error' ? (
              // 原文案是「保存冲突，内容已保留」。它把所有失败都说成冲突，还向用户保证内容没事——
              // 实际是本地已经和服务端分叉，之后的编辑都不落盘。这里只说失败，并给出重试入口。
              <button
                type="button"
                title={saveErrorDetail ?? undefined}
                className="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:underline"
                onClick={() => void flushSave().catch(() => undefined)}
              >
                保存失败 · 重试
              </button>
            ) : `已保存 · v${document.revision}`}
          </div>
        </div>

        {!materialPick && (
          <div className="canvas-mobile-rail absolute left-3 top-1/2 z-20 flex max-h-[calc(100dvh-8rem)] -translate-y-1/2 flex-col items-center gap-1 overflow-y-auto rounded-full border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow md:contents md:max-h-none md:overflow-visible">
          <div className="canvas-tool-dock contents md:absolute md:z-20 md:flex md:max-h-[calc(100dvh-17rem)] md:flex-col md:items-center md:gap-0 md:overflow-y-auto md:rounded-full md:border md:border-border md:bg-glass md:p-1.5 md:backdrop-blur-glass md:shell-glow">
            <span className="xl:hidden">
              <ToolButton buttonRef={addTriggerRef} label={addOpen ? '关闭添加菜单' : '添加节点'} active={addOpen} expanded={addOpen} controlsId="canvas-add-menu" onClick={() => { setCreateMenu(null); setAddOpen(value => !value); }}>{addOpen ? <X /> : <Plus />}</ToolButton>
            </span>
            <ToolButton label="选择工具" active={!addOpen && !createMenu} onClick={() => { setAddOpen(false); setCreateMenu(null); }}><MousePointer2 /></ToolButton>
            <div className="my-1 h-px w-7 bg-border" />
            <ToolButton label="撤销" disabled={historyDepth.past === 0} onClick={undo}><Undo2 /></ToolButton>
            <ToolButton label="重做" disabled={historyDepth.future === 0} onClick={redo}><Redo2 /></ToolButton>
            <div className="my-1 h-px w-7 bg-border" />
            <div className="hidden xl:contents">
              <ToolButton label="添加文本节点" onClick={() => addTextNode(null)}><Type /></ToolButton>
              <ToolButton label="添加图片节点" onClick={() => addGenerationNode('image', null)}><FileImage /></ToolButton>
              <ToolButton label="添加视频节点" onClick={() => addGenerationNode('video', null)}><FileVideo /></ToolButton>
              <ToolButton label="添加音频节点" onClick={() => addGenerationNode('audio', null)}><FileAudio /></ToolButton>
              <ToolButton label="添加生成配置节点" onClick={() => addConfigNode(null)}><WandSparkles /></ToolButton>
              <ToolButton label="上传素材" onClick={() => uploadRef.current?.click()}><Upload /></ToolButton>
              <div className="my-1 h-px w-7 bg-border" />
            </div>
            <ToolButton label="适应全部节点" onClick={() => {
              void runViewportCommand(() => fitView({ duration: 150, padding: 0.12 }));
            }}><Maximize2 /></ToolButton>
          </div>
          {narrowViewport && <div className="contents">{renderCanvasConfigControls('mobile')}</div>}
          {addOpen && (
            <div ref={addMenuRef} id="canvas-add-menu" role="menu" aria-label="添加节点" onKeyDown={handleMenuNavigation} className="canvas-add-menu popover-in absolute left-14 top-0 w-56 rounded-xl border border-border bg-popover p-2 shell-glow">
              <p className="px-2 pb-2 pt-1 text-xs uppercase tracking-label text-muted-foreground">添加节点</p>
              <CanvasCreateMenuItems allowEmptyNodes allowUpload allowConfig onAddText={() => addTextNode(null)} onAddImage={() => addGenerationNode('image', null)} onAddVideo={() => addGenerationNode('video', null)} onAddAudio={() => addGenerationNode('audio', null)} onAddConfig={() => addConfigNode(null)} onUpload={() => uploadRef.current?.click()} />
            </div>
          )}
          </div>
        )}

        <input ref={uploadRef} type="file" className="sr-only" accept="image/*,video/*,audio/*" onChange={event => { const file = event.target.files?.[0]; if (file) void handleUpload(file); event.target.value = ''; }} />
        <input
          ref={replaceMediaRef}
          type="file"
          className="sr-only"
          aria-label={mediaReplaceTarget
            ? mediaReplaceTarget.hadContent ? '选择替换媒体' : '选择上传媒体'
            : '选择节点媒体文件'}
          accept={mediaReplaceTarget ? replacementAccept(mediaReplaceTarget.kind) : undefined}
          onChange={event => {
            const file = event.target.files?.[0];
            const target = mediaReplaceTarget;
            if (file && target) void handleMediaReplace(file, target);
            else setMediaReplaceTarget(null);
            event.target.value = '';
          }}
        />

        {createMenu && (
          <div ref={createMenuRef} role="menu" aria-label="连接创建节点" onKeyDown={handleMenuNavigation} className="fixed z-20 w-56 rounded-xl border border-border bg-popover p-2 shell-glow" style={{ left: createMenu.screen.x, top: createMenu.screen.y }}>
            <div className="flex items-center justify-between px-2 pb-2 pt-1"><p className="text-xs uppercase tracking-label text-muted-foreground">创建并连接</p><button type="button" aria-label="关闭连接创建菜单" onClick={() => { setCreateMenu(null); requestAnimationFrame(() => editorRegionRef.current?.focus()); }} className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X className="size-4" /></button></div>
            <CanvasCreateMenuItems {...canvasConnectionCreationCapabilities(createMenu.sourceHandle ?? 'source')} onAddText={() => addTextNode(createMenu)} onAddImage={() => addGenerationNode('image', createMenu)} onAddVideo={() => addGenerationNode('video', createMenu)} onAddAudio={() => addGenerationNode('audio', createMenu)} onAddConfig={() => addConfigNode(createMenu)} onUpload={() => uploadRef.current?.click()} />
          </div>
        )}

        {libraryMode && (
          <CanvasLibraryPanel
            mode={libraryMode}
            projectId={projectId}
            assets={assets}
            prompts={prompts}
            contentVersions={document.content_versions}
            focusAssetId={libraryFocusAssetId}
            busy={libraryBusy || libraryLoading}
            error={libraryError}
            onModeChange={setLibraryMode}
            onClose={closeLibrary}
            onInsertAsset={assetId => void insertLibraryItem('asset', assetId)}
            onInsertPrompt={promptId => void insertLibraryItem('prompt', promptId)}
            onUpdateAsset={(assetId, input) => mutateLibrary(async () => {
              if (!assets) return;
              acceptAssets(await updateCanvasAsset(projectId, assetId, input, assets.revision));
            })}
            onDeleteAsset={assetId => mutateLibrary(async () => {
              if (!assets) return;
              acceptAssets(await deleteCanvasAsset(projectId, assetId, assets.revision));
            })}
            onCreatePrompt={input => mutateLibrary(async () => {
              if (!prompts) return;
              acceptPrompts(await createCanvasPrompt(projectId, input, prompts.revision));
            })}
            onUpdatePrompt={(promptId, input) => mutateLibrary(async () => {
              if (!prompts) return;
              acceptPrompts(await updateCanvasPrompt(projectId, promptId, input, prompts.revision));
            })}
            onDeletePrompt={promptId => mutateLibrary(async () => {
              if (!prompts) return;
              acceptPrompts(await deleteCanvasPrompt(projectId, promptId, prompts.revision));
            })}
          />
        )}

        {narrowViewport && generationPanelOpen && selectedNode && selectedDraft && (
          <CanvasMobileGenerationPanel
            node={selectedNode}
            draft={selectedDraft}
            context={contextValue}
          />
        )}

        {!preview && !mediaOperation && !maskEdit && !angleState && selectedNodeIds.size <= 1 && (
          <CanvasActionFeedback
            error={error}
            notice={toolNotice}
            onDismissError={() => setError(null)}
            className="absolute right-3 top-20 z-30 max-w-sm items-end md:right-4"
          />
        )}

        {maskEdit && (
          <CanvasMaskEditDialog
            open
            title={maskEdit.title}
            version={maskEdit.version}
            mediaUrl={canvasMediaUrl(projectId, maskEdit.version.version_id)}
            keys={keys}
            initialDraft={maskEditDraft}
            busy={maskEditBusy}
            error={maskEditError}
            onOpenChange={open => {
              if (!open && !maskEditBusy) {
                setMaskEdit(null);
                setMaskEditError(null);
              }
            }}
            onSubmit={submission => void submitMaskEdit(submission)}
          />
        )}

        {angleState && (
          <CanvasAngleDialog
            open
            title={angleState.title}
            mediaUrl={canvasMediaUrl(projectId, angleState.version.version_id)}
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
          if (!open) requestAnimationFrame(() => shortcutsTriggerRef.current?.focus());
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
          keys={keys}
          saving={generationPreferencesSaving}
          error={canvasUiPreferencesError}
          onOpenChange={open => {
            setGenerationPreferencesOpen(open);
            if (!open) requestAnimationFrame(() => generationPreferencesTriggerRef.current?.focus());
          }}
          onSave={value => void persistGenerationPreferences(value)}
        />

        {mediaOperation && (
          <CanvasMediaOperationDialog
            open
            tool={mediaOperation.tool}
            title={mediaOperation.title}
            version={mediaOperation.version}
            mediaUrl={canvasMediaUrl(projectId, mediaOperation.version.version_id)}
            busy={mediaOperationBusy}
            error={mediaOperationError}
            onOpenChange={open => {
              if (!open) {
                setMediaOperation(null);
                setMediaOperationError(null);
              }
            }}
            onSubmit={operation => void submitMediaOperation(operation)}
          />
        )}

        <Dialog open={Boolean(preview)} onOpenChange={open => { if (!open) setPreview(null); }}>
          {preview && (
            <DialogContent className="max-h-[90dvh] max-w-4xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{preview.title}</DialogTitle>
                <DialogDescription>原始内容、来源与生成信息</DialogDescription>
              </DialogHeader>
              <CanvasActionFeedback error={error} notice={toolNotice} onDismissError={() => setError(null)} />
              <CanvasPreview
                projectId={projectId}
                preview={preview}
                job={previewJob}
                nodes={document.nodes}
                onCopyPrompt={previewNode && previewPrompt && isContentNode(previewNode)
                  ? () => void copyPrompt(previewNode)
                  : undefined}
              />
            </DialogContent>
          )}
        </Dialog>
      </section>
    </CanvasNodeContext.Provider>
  );
}

function CanvasCreateMenuItems({ allowEmptyNodes, allowUpload, allowConfig, onAddText, onAddImage, onAddVideo, onAddAudio, onAddConfig, onUpload }: {
  allowEmptyNodes: boolean;
  allowUpload: boolean;
  allowConfig: boolean;
  onAddText: () => void;
  onAddImage: () => void;
  onAddVideo: () => void;
  onAddAudio: () => void;
  onAddConfig: () => void;
  onUpload: () => void;
}) {
  return <>
    {allowEmptyNodes && <AddMenuButton icon={<Type />} title="文本" description="脚本、提示词与备注" onClick={onAddText} />}
    {allowEmptyNodes && <AddMenuButton icon={<FileImage />} title="图片" description="空节点可填写生成设置" onClick={onAddImage} />}
    {allowEmptyNodes && <AddMenuButton icon={<FileVideo />} title="视频" description="空节点可填写生成设置" onClick={onAddVideo} />}
    {allowEmptyNodes && <AddMenuButton icon={<FileAudio />} title="音频" description="旁白、对白与语音" onClick={onAddAudio} />}
    {allowConfig && <AddMenuButton icon={<WandSparkles />} title="生成配置" description="连接内容并选择生成类型" onClick={onAddConfig} />}
    {allowUpload && <AddMenuButton icon={<Upload />} title="上传素材" description="图片、视频或音频" onClick={onUpload} />}
  </>;
}

const CANVAS_SHORTCUTS = [
  { keys: ['鼠标中键', '拖动'], label: '平移画布' },
  { keys: ['Space / Ctrl', '拖动'], label: '临时平移画布' },
  { keys: ['鼠标滚轮'], label: '缩放画布' },
  { keys: ['触控板双指'], label: '滑动平移 / 捏合缩放' },
  { keys: ['空白拖动'], label: '框选多个节点' },
  { keys: ['Shift / ⌘', '点击'], label: '追加选择节点' },
  { keys: ['⌘ / Ctrl', 'A'], label: '全选节点' },
  { keys: ['⌘ / Ctrl', 'C / V'], label: '复制 / 粘贴节点' },
  { keys: ['⌘ / Ctrl', 'Z'], label: '撤销' },
  { keys: ['⌘ / Ctrl', 'Shift', 'Z'], label: '重做' },
  { keys: ['⌘ / Ctrl', 'Y'], label: '重做' },
  { keys: ['Delete / Backspace'], label: '删除选中节点或连接' },
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
  projectId,
  preview,
  job,
  nodes,
  onCopyPrompt,
}: {
  projectId: string;
  preview: PreviewState;
  job?: Job;
  nodes: CanvasNode[];
  onCopyPrompt?: () => void;
}) {
  const { version } = preview;
  const src = version.kind === 'text' ? null : canvasMediaUrl(projectId, version.version_id);
  return (
    <div className="space-y-4">
      {version.kind === 'text' && (
        <p className="max-h-[58dvh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-4 text-sm leading-relaxed text-foreground">
          {version.text || '暂无文本内容'}
        </p>
      )}
      {version.kind === 'image' && src && (
        <img src={src} alt={preview.title} decoding="async" className="max-h-[58dvh] w-full rounded-lg object-contain" />
      )}
      {version.kind === 'video' && src && (
        <video src={src} controls playsInline preload="metadata" className="max-h-[58dvh] w-full rounded-lg object-contain" />
      )}
      {version.kind === 'audio' && src && (
        <audio src={src} controls preload="metadata" className="w-full" />
      )}
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
      {job?.canvas_run && (
        <CanvasGenerationMetadata snapshot={job.canvas_run.snapshot} job={job} nodes={nodes} />
      )}
      <DialogFooter>
        {onCopyPrompt && (
          <Button variant="outline" onClick={onCopyPrompt}>
            <ClipboardCopy aria-hidden="true" />复制生成提示词
          </Button>
        )}
        {version.kind !== 'text' && (
          <Button asChild>
            <a href={canvasDownloadUrl(projectId, version.version_id)}>
              <Download aria-hidden="true" />下载原文件
            </a>
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

function CanvasActionFeedback({ error, notice, onDismissError, className }: {
  error: string | null;
  notice: string | null;
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
          <button type="button" aria-label="关闭错误提示" onClick={onDismissError}><X className="size-4" /></button>
        </div>
      )}
      {notice && <div role="status" className="rounded-lg border border-border bg-popover px-3 py-2 text-sm text-foreground shell-glow">{notice}</div>}
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
      <dd className={cn('mt-0.5 truncate text-foreground', numeric && 'tabular-nums', technical && 'font-mono text-xs')} title={value}>{value}</dd>
    </div>
  );
}

function contentKindLabel(kind: CanvasContentVersion['kind']) {
  return { text: '文本', image: '图片', video: '视频', audio: '音频' }[kind];
}

function contentOriginLabel(version: CanvasContentVersion, job?: Job) {
  const { origin } = version;
  if (origin.kind === 'user_edit') return '人工编辑';
  if (origin.kind === 'upload') return '上传素材';
  if (origin.kind === 'user_mask') return '局部编辑蒙版';
  if (origin.kind === 'job_output') return job?.model ? `AI 生成 · ${job.model}` : 'AI 生成';
  if (origin.kind === 'import') return '项目包导入';
  if (origin.operation.kind === 'crop') return '本地裁剪';
  if (origin.operation.kind === 'split') return '本地切图';
  return '本地放大';
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

function isCanvasShortcutBlockedTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]'));
}

function isRangeAdjustmentKey(key: string) {
  return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key);
}

function handleMenuNavigation(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
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
  if (node.type === 'config') return node.data.draft;
  if ('generation_draft' in node.data) return node.data.generation_draft;
  return null;
}

function withGenerationDraftForNode(
  node: CanvasNode,
  draft: CanvasGenerationDraft,
): CanvasNode {
  if (node.type === 'config') return { ...node, data: { draft } };
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
  if (disconnectedByTarget.size === 0) return { ...document, connections };
  const updatedAt = new Date().toISOString();
  const nodes = document.nodes.map(node => {
    const disconnectedNodeIds = disconnectedByTarget.get(node.id);
    const draft = generationDraftForNode(node);
    if (!disconnectedNodeIds || !draft) return node;
    const prompt = removeCanvasMentionTokens(draft.prompt, disconnectedNodeIds);
    if (prompt === draft.prompt) return node;
    return withGenerationDraftForNode(node, { ...draft, prompt, updated_at: updatedAt });
  });
  return { ...document, nodes, connections };
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
  return `config-reverse-${resultNodeId}`;
}

function canvasNodeRenderedSize(
  node: CanvasNode,
  versions: Readonly<Record<string, CanvasContentVersion>>,
) {
  if (node.type === 'text') return node.size ?? { width: 256, height: 144 };
  if (node.type !== 'image' || node.data.display.free_resize || !node.data.current_version_id) {
    return node.size ?? { width: 320, height: 176 };
  }
  const version = versions[node.data.current_version_id];
  return version?.kind === 'image'
    ? sizeLockedToVersion(node.size, version)
    : node.size ?? { width: 320, height: 176 };
}

function sizeLockedToVersion(
  current: CanvasNode['size'],
  version: CanvasMediaVersion,
) {
  if (!version.width || !version.height) return current ?? { width: 320, height: 176 };
  const ratio = version.width / version.height;
  let width = Math.min(4000, Math.max(240, current?.width ?? 320));
  let height = width / ratio;
  if (height < 150) {
    height = 150;
    width = height * ratio;
  }
  if (height > 4000) {
    height = 4000;
    width = height * ratio;
  }
  if (width > 4000) {
    width = 4000;
    height = width / ratio;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function cloneCanvasNode(
  source: CanvasNode,
  idMap: ReadonlyMap<string, string>,
  position: XYPosition,
  zIndex: number,
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
      },
    } as CanvasNode;
  }
  if (clone.type === 'config') {
    return {
      ...clone,
      id: idMap.get(source.id)!,
      position,
      z_index: zIndex,
      data: { draft: cloneCanvasDraft(clone.data.draft, idMap)! },
    };
  }
  if (clone.type === 'group') {
    return {
      ...clone,
      id: idMap.get(source.id)!,
      position,
      z_index: zIndex,
      data: {
        member_node_ids: clone.data.member_node_ids.flatMap(memberId => {
          const clonedId = idMap.get(memberId);
          return clonedId ? [clonedId] : [];
        }),
      },
    };
  }
  return {
    ...clone,
    id: idMap.get(source.id)!,
    position,
    z_index: zIndex,
    data: {
      ...clone.data,
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

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}
