import '@xyflow/react/dist/style.css';

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnectEnd,
  type Viewport,
  type XYPosition,
  useReactFlow,
} from '@xyflow/react';
import {
  ArrowLeft,
  ChevronDown,
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
  MousePointer2,
  Plus,
  Redo2,
  Square,
  Type,
  Undo2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import {
  cancelCanvasRun,
  canvasDownloadUrl,
  canvasMediaUrl,
  createCanvasReversePromptConfig,
  createCanvasPrompt,
  deleteCanvasAsset,
  deleteCanvasPrompt,
  getCanvasDocument,
  getCanvasAssets,
  getCanvasPrompts,
  insertCanvasAsset,
  insertCanvasPrompt,
  listCanvasJobs,
  listCanvasProjects,
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
import {
  AddMenuButton,
  CanvasGenerationComposer,
  CanvasInspector,
  CanvasNodeContext,
  EditorMessage,
  ToolButton,
  canvasNodeTypes,
  copyablePromptForNode,
  isReversePromptJob,
  type CanvasNodeContextValue,
  type FlowNode,
} from '@/components/canvas/CanvasEditorViews';
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
  CANVAS_LIBRARY_DRAG_TYPE,
  CanvasLibraryPanel,
  type CanvasLibraryMode,
} from '@/components/canvas/CanvasLibraryPanel';
import { Button } from '@/components/ui/button';
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
  CanvasContentNode,
  CanvasDocument,
  CanvasImageToolbarPreferences,
  CanvasLibraryAsset,
  CanvasMediaOperation,
  CanvasMediaVersion,
  CanvasNode,
  CanvasPrompt,
  CanvasTextVersion,
  CanvasUiPreferences,
  RevisionedSidecar,
} from '@/schema/canvas';
import type { Job, JobKind } from '@/schema/jobs';
import { cn } from '@/lib/utils';
import {
  normalizeCanvasImageParams,
  normalizeCanvasVideoParams,
  supportsCanvasVideoEdit,
} from './canvasEditorModel';

interface CreateMenuState {
  screen: XYPosition;
  flow: XYPosition;
  sourceId?: string;
  sourceHandle?: 'source' | 'target';
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
}

const CANVAS_MOUSE_PAN_BUTTONS: number[] = [];

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
  const [document, setDocument] = useState<CanvasDocument | null>(null);
  const [projects, setProjects] = useState<Array<{ project_id: string; name: string }>>([]);
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
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
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<Set<string>>(() => new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [createMenu, setCreateMenu] = useState<CreateMenuState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
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
  const flowNodeCache = useRef(new Map<string, { node: CanvasNode; selected: boolean; flowNode: FlowNode }>());
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
  const syncedTerminalRuns = useRef(new Set<string>());
  const reversePromptConfigAttempts = useRef(new Set<string>());
  const history = useRef<{ past: CanvasDocument[]; future: CanvasDocument[] }>({ past: [], future: [] });
  const { screenToFlowPosition, fitView, getZoom, setCenter } = useReactFlow<FlowNode>();
  const acceptAssets = useCallback((value: RevisionedSidecar<CanvasLibraryAsset>) => {
    setAssets(current => !current || value.revision >= current.revision ? value : current);
  }, []);
  const acceptPrompts = useCallback((value: RevisionedSidecar<CanvasPrompt>) => {
    setPrompts(current => !current || value.revision >= current.revision ? value : current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDocument(null);
    setSelectedNodeIds(new Set());
    setSelectedConnectionIds(new Set());
    setSubmittingNodeIds(new Set());
    setAddOpen(false);
    setCreateMenu(null);
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
    history.current = { past: [], future: [] };
    pendingTextVersions.current.clear();
    syncedTerminalRuns.current.clear();
    reversePromptConfigAttempts.current.clear();
    dirtyVersion.current = 0;
    setDirtySignal(0);
    serverRevision.current = 0;
    runSubmissionInFlight.current = false;
    documentCommandInFlight.current = false;
    canvasUiPreferencesSaveInFlight.current = false;
    void getCanvasUiPreferences()
      .then(value => {
        if (!cancelled) setCanvasUiPreferences(value);
      })
      .catch(preferencesError => {
        if (!cancelled) setCanvasUiPreferencesError((preferencesError as Error).message);
      });
    Promise.all([
      listCanvasProjects(),
      getCanvasDocument(projectId),
      listKeys(),
      listCanvasJobs(projectId),
    ])
      .then(([projectRows, canvasDocument, keyRows, canvasJobs]) => {
        if (cancelled) return;
        setProjects(projectRows);
        setDocument(canvasDocument);
        serverRevision.current = canvasDocument.revision;
        setKeys(keyRows.keys);
        setJobs(canvasJobs);
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
    };
  }, [projectId]);

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

  const mergeRunDocument = useCallback((remote: CanvasDocument) => {
    serverRevision.current = Math.max(serverRevision.current, remote.revision);
    setDocument(current => {
      if (!current || remote.revision <= current.revision) return current;
      const remoteNodes = new Map(remote.nodes.map(node => [node.id, node]));
      const nodeIds = new Set(current.nodes.map(node => node.id));
      const nodes = current.nodes.map(node => {
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
      });
      const connectionIds = new Set(current.connections.map(connection => connection.id));
      const serverDerivations = remote.connections.filter(connection => (
        connection.role === 'derivation'
        && !connectionIds.has(connection.id)
        && nodeIds.has(connection.source_node_id)
        && nodeIds.has(connection.target_node_id)
      ));
      const merged: CanvasDocument = {
        ...current,
        revision: remote.revision,
        updated_at: remote.updated_at,
        nodes,
        connections: [...current.connections, ...serverDerivations],
        content_versions: { ...remote.content_versions, ...current.content_versions },
      };
      if (saveQueued.current) saveQueued.current = merged;
      return merged;
    });
  }, []);

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
      content_versions: { ...remote.content_versions, ...current.content_versions },
    };
    if (saveQueued.current || dirtyVersion.current > dirtyAtSubmission) {
      saveQueued.current = merged;
    }
    setDocument(merged);
  }, []);

  const hasRunningJobs = jobs.some(job => (
    job.namespace === 'canvas'
    && (job.status === 'pending' || job.status === 'pending_confirm')
  ));

  useEffect(() => {
    if (!hasRunningJobs) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const canvasJobs = await listCanvasJobs(projectId);
        if (cancelled) return;
        const completedRuns = canvasJobs.filter(job => (
          job.canvas_run
          && job.status !== 'pending'
          && job.status !== 'pending_confirm'
          && !syncedTerminalRuns.current.has(job.canvas_run.run_id)
        ));
        if (completedRuns.length) {
          const remote = await getCanvasDocument(projectId);
          if (cancelled) return;
          mergeRunDocument(remote);
          for (const job of completedRuns) syncedTerminalRuns.current.add(job.canvas_run!.run_id);
        }
        setJobs(canvasJobs);
      } catch (pollError) {
        if (!cancelled) setError((pollError as Error).message);
      }
    };
    const timer = window.setInterval(() => void poll(), 1200);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hasRunningJobs, mergeRunDocument, projectId]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
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
  }, [addOpen, createMenu, libraryMode, selectedConnectionIds.size, selectedNodeIds.size]);

  useEffect(() => {
    if (!addOpen) return;
    requestAnimationFrame(() => addMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
  }, [addOpen]);

  useEffect(() => {
    if (!createMenu) return;
    requestAnimationFrame(() => createMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
  }, [createMenu]);

  latestDocument.current = document;
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
            saveQueued.current = { ...queued, revision: authoritativeRevision };
          }
          setDocument(current => {
            if (!current) return current;
            if (current === snapshot && saved.revision === authoritativeRevision) return saved;
            return {
              ...current,
              revision: Math.max(current.revision, authoritativeRevision),
              content_versions: { ...saved.content_versions, ...current.content_versions },
            };
          });
        }
        setSaveState('saved');
      } catch (saveError) {
        if (!saveQueued.current && failedSnapshot) saveQueued.current = failedSnapshot;
        setSaveState('error');
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

  const persistNow = useCallback(async (): Promise<boolean> => {
    if (runSubmissionInFlight.current || documentCommandInFlight.current) {
      setError('画布命令正在提交，请等待完成后再离开或执行其他操作。');
      return false;
    }
    if (libraryInsertCommand.current) await libraryInsertCommand.current;
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

  const flowNodes = useMemo<FlowNode[]>(() => {
    const activeIds = new Set<string>();
    const next = (document?.nodes ?? []).map(node => {
      activeIds.add(node.id);
      const selected = selectedNodeIds.has(node.id);
      const cached = flowNodeCache.current.get(node.id);
      if (cached?.node === node && cached.selected === selected) return cached.flowNode;
      const renderedSize = canvasNodeRenderedSize(node, document?.content_versions ?? {});
      const flowNode: FlowNode = {
        id: node.id,
        type: 'canvasNode',
        position: node.position,
        style: {
          width: renderedSize.width,
          height: renderedSize.height,
          zIndex: node.z_index,
        },
        selected,
        data: { domain: node },
      };
      flowNodeCache.current.set(node.id, { node, selected, flowNode });
      return flowNode;
    });
    for (const id of flowNodeCache.current.keys()) {
      if (!activeIds.has(id)) flowNodeCache.current.delete(id);
    }
    return next;
  }, [document?.content_versions, document?.nodes, selectedNodeIds]);

  const flowEdges = useMemo(() => (document?.connections ?? []).map(connection => ({
    id: connection.id,
    source: connection.source_node_id,
    target: connection.target_node_id,
    type: 'smoothstep',
    className: connection.role === 'derivation' ? 'canvas-provenance-edge' : 'canvas-input-edge',
    selected: selectedConnectionIds.has(connection.id),
    selectable: true,
    deletable: true,
  })), [document?.connections, selectedConnectionIds]);

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
    const graphChanges = changes.filter(change => change.type === 'position' || change.type === 'remove');
    if (!graphChanges.length) return;
    commit(current => {
      let nodes = [...current.nodes];
      let connections = current.connections;
      for (const change of graphChanges) {
        if (change.type === 'position' && change.position) nodes = nodes.map(node => node.id === change.id ? { ...node, position: change.position! } : node);
        if (change.type === 'remove') {
          nodes = nodes.filter(node => node.id !== change.id);
          connections = connections.filter(edge => edge.source_node_id !== change.id && edge.target_node_id !== change.id);
        }
      }
      return { ...current, nodes, connections };
    }, graphChanges.some(change => change.type === 'remove'));
  }, [commit]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const source = latestDocument.current?.nodes.find(node => node.id === connection.source);
    const target = latestDocument.current?.nodes.find(node => node.id === connection.target);
    if (!source || !target || !providesContent(source) || target.type === 'group' || target.type === 'plugin') {
      setError('这两个节点不能建立输入连接。');
      return;
    }
    commit(current => {
      if (current.connections.some(edge => edge.role === 'input' && edge.source_node_id === connection.source && edge.target_node_id === connection.target)) return current;
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

  const onConnectEnd = useCallback<OnConnectEnd>((event, state) => {
    if (state.isValid || !state.fromNode) return;
    const pointer = pointerPosition(event);
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
  }, [screenToFlowPosition]);

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
    if (removedIds.size) commit(current => ({ ...current, connections: current.connections.filter(edge => !removedIds.has(edge.id)) }), true);
  }, [commit]);

  useEffect(() => {
    function handleDelete(event: KeyboardEvent) {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (isInteractiveTarget(event.target)) return;
      if (selectedNodeIds.size === 0 && selectedConnectionIds.size === 0) return;
      event.preventDefault();
      const nodeIds = selectedNodeIds;
      commit(current => ({
        ...current,
        nodes: current.nodes.filter(node => !nodeIds.has(node.id)),
        connections: current.connections.filter(edge => !selectedConnectionIds.has(edge.id) && !nodeIds.has(edge.source_node_id) && !nodeIds.has(edge.target_node_id)),
      }), true);
      setSelectedNodeIds(new Set());
      setSelectedConnectionIds(new Set());
      requestAnimationFrame(() => editorRegionRef.current?.focus());
    }
    window.addEventListener('keydown', handleDelete);
    return () => window.removeEventListener('keydown', handleDelete);
  }, [commit, selectedConnectionIds, selectedNodeIds]);

  const selectedNode = document?.nodes.find(node => node.id === selectedId) ?? null;
  const selectedContentNode = selectedNode && isContentNode(selectedNode) ? selectedNode : null;
  const selectedDraft = selectedNode ? generationDraftForNode(selectedNode) : null;
  const projectName = projects.find(project => project.project_id === projectId)?.name ?? '画布项目';

  function defaultPosition() {
    return screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  }

  function closeLibrary() {
    const trigger = libraryMode === 'prompts'
      ? promptLibraryTriggerRef.current
      : assetLibraryTriggerRef.current;
    setLibraryMode(null);
    requestAnimationFrame(() => trigger?.focus());
  }

  async function mutateLibrary(action: () => Promise<void>) {
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
  }

  async function saveNodeToLibrary(node: CanvasContentNode) {
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
  }

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
          content_versions: {
            ...insertedVersions,
            ...concurrent.content_versions,
          },
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

  function handleLibraryDrop(event: DragEvent) {
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

  function appendNode(node: CanvasNode, menu: CreateMenuState | null, baseDocument?: CanvasDocument) {
    const apply = (current: CanvasDocument) => {
      const connections = [...current.connections];
      if (menu?.sourceId) {
        const sourceNodeId = menu.sourceHandle === 'target' ? node.id : menu.sourceId;
        const targetNodeId = menu.sourceHandle === 'target' ? menu.sourceId : node.id;
        connections.push({ id: makeId('connection'), role: 'input', source_node_id: sourceNodeId, target_node_id: targetNodeId });
      }
      return { ...current, nodes: [...current.nodes, node], connections };
    };
    if (baseDocument) {
      // 上传命令创建的 Content Version 已是服务端历史；撤销只移除随后添加的节点。
      history.current.past.push(baseDocument);
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
    const key = firstKeyForKind(keys, kind);
    const selectedModel = key?.models.find(item => modelModality(item, key) === kind);
    const model = selectedModel?.id ?? '';
    const now = new Date().toISOString();
    const draft = {
      mode: kind,
      prompt: '',
      input_policy: 'all_connected' as const,
      model,
      alias: key?.alias ?? null,
      params: kind === 'image'
        ? normalizeCanvasImageParams(model, key?.provider, { n: 1, ratio: '1:1' })
        : kind === 'video'
          ? normalizeCanvasVideoParams(
              model,
              selectedModel?.protocol,
              { duration: 5, ratio: '16:9', resolution: '720p', generate_audio: true },
            )
          : kind === 'audio'
            ? { voice: 'alloy', response_format: 'mp3', speed: 1 }
            : { n: 1 },
      updated_at: now,
    };
    const base = {
      id: makeId(kind),
      title: { text: '文本', image: '图片', video: '视频', audio: '音频' }[kind],
      position: menu?.flow ?? defaultPosition(),
      z_index: 0,
    };
    const data = { current_version_id: null, generation_draft: draft, active_run_id: null };
    if (kind === 'text') appendNode({ ...base, type: 'text', data }, menu);
    else if (kind === 'audio') appendNode({ ...base, type: 'audio', data }, menu);
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

  async function handleUpload(file: File) {
    const menu = createMenu;
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
        content_versions: {
          ...uploaded.document.content_versions,
          ...concurrent.content_versions,
        },
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

  const updateNode = useCallback((nodeId: string, updater: (node: CanvasNode) => CanvasNode) => {
    commit(current => ({ ...current, nodes: current.nodes.map(node => node.id === nodeId ? updater(node) : node) }));
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
        ? { ...existing, text, sha256: '0'.repeat(64) }
        : {
            version_id: versionId,
            kind: 'text',
            text,
            created_at: new Date().toISOString(),
            sha256: '0'.repeat(64),
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
    commit(current => ({
      ...current,
      nodes: current.nodes.filter(node => node.id !== nodeId),
      connections: current.connections.filter(edge => edge.source_node_id !== nodeId && edge.target_node_id !== nodeId),
    }), true);
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
      setJobs(currentJobs => [
        ...currentJobs.filter(job => job.job_id !== run.job.job_id),
        run.job,
      ]);
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
  }, [flushSave, mergeSubmittedRunDocument, persistNow, projectId]);

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
      mergeSubmittedRunDocument(run.document, run.job, dirtyAtSubmission);
      setJobs(currentJobs => [
        ...currentJobs.filter(job => job.job_id !== run.job.job_id),
        run.job,
      ]);
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
  }, [flushSave, mergeSubmittedRunDocument, persistNow, projectId]);

  const retryRun = useCallback(async (
    nodeId: string,
    runId: string,
    mode: 'original' | 'current',
    candidateId?: string,
  ) => {
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
      const run = await retryCanvasRun(
        projectId,
        runId,
        mode,
        serverRevision.current,
        candidateId,
      );
      mergeSubmittedRunDocument(run.document, run.job, dirtyAtSubmission);
      setJobs(currentJobs => [
        ...currentJobs.filter(job => job.job_id !== run.job.job_id),
        run.job,
      ]);
      const resultId = run.job.canvas_run?.result_node_id;
      if (resultId) setSelectedNodeIds(new Set([resultId]));
    } catch (retryError) {
      setError((retryError as Error).message);
    } finally {
      runSubmissionInFlight.current = false;
      if (saveQueued.current) void flushSave().catch(() => undefined);
      setSubmittingNodeIds(current => {
        const next = new Set(current);
        next.delete(nodeId);
        return next;
      });
    }
  }, [flushSave, mergeSubmittedRunDocument, persistNow, projectId]);

  const cancelRun = useCallback(async (runId: string) => {
    setError(null);
    try {
      const updated = await cancelCanvasRun(projectId, runId);
      setJobs(currentJobs => [
        ...currentJobs.filter(job => job.job_id !== updated.job_id),
        updated,
      ]);
    } catch (cancelError) {
      setError((cancelError as Error).message);
    }
  }, [projectId]);

  const recordHistorySnapshot = useCallback(() => {
    const snapshot = latestDocument.current;
    if (!snapshot || history.current.past.at(-1) === snapshot) return;
    history.current.past.push(snapshot);
    history.current.past = history.current.past.slice(-50);
    history.current.future = [];
  }, []);

  const undo = useCallback(() => {
    const previous = history.current.past.pop();
    if (!previous || !document) return;
    history.current.future.push(document);
    setDocument({
      ...previous,
      revision: document.revision,
      updated_at: new Date().toISOString(),
      content_versions: { ...previous.content_versions, ...document.content_versions },
    });
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
  }, [document]);

  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next || !document) return;
    history.current.past.push(document);
    setDocument({
      ...next,
      revision: document.revision,
      updated_at: new Date().toISOString(),
      content_versions: { ...next.content_versions, ...document.content_versions },
    });
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
  }, [document]);

  useEffect(() => {
    function handleHistoryShortcut(event: KeyboardEvent) {
      if ((!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
    window.addEventListener('keydown', handleHistoryShortcut);
    return () => window.removeEventListener('keydown', handleHistoryShortcut);
  }, [redo, undo]);

  const selectOnlyNode = useCallback((id: string) => {
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([id]));
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
  }, [document]);
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
        content_versions: { ...remote.content_versions, ...concurrent.content_versions },
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
      setSelectedConnectionIds(new Set());
      setSelectedNodeIds(new Set([configId]));
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
      content_versions: { ...remote.content_versions, ...concurrent.content_versions },
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
    if (!version || version.kind === 'text' || version.kind !== node.type) {
      setMediaReplaceError({ nodeId: node.id, message: '这个节点还没有可替换的媒体内容。' });
      return;
    }
    setMediaReplaceError(null);
    setMediaReplaceTarget({ nodeId: node.id, title: node.title, kind: version.kind });
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
        ? `已替换“${target.title}”，旧版本仍可撤销恢复`
        : `“${target.title}”已有更新内容；替换文件已保留为历史版本`);
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
      setJobs(currentJobs => [
        ...currentJobs.filter(job => job.job_id !== run.job.job_id),
        run.job,
      ]);
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
  }, [announceToolNotice, flushSave, maskEdit, mergeSubmittedRunDocument, projectId]);

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
      setJobs(currentJobs => [
        ...currentJobs.filter(job => job.job_id !== run.job.job_id),
        run.job,
      ]);
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
  }, [angleState, announceToolNotice, flushSave, mergeSubmittedRunDocument, persistNow, projectId]);

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
        content_versions: { ...result.document.content_versions, ...concurrent.content_versions },
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

  const persistImageToolbarPreferences = useCallback(async (
    value: CanvasImageToolbarPreferences,
  ) => {
    if (canvasUiPreferencesSaveInFlight.current) {
      throw new Error('另一项画布界面设置正在保存，请稍后重试。');
    }
    canvasUiPreferencesSaveInFlight.current = true;
    try {
      const saved = await saveCanvasUiPreferences(canvasUiPreferences.revision, value);
      setCanvasUiPreferences(saved);
      setCanvasUiPreferencesError(null);
      announceToolNotice('图片快捷工具已更新');
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

  const contextValue = useMemo<CanvasNodeContextValue>(() => ({
    projectId,
    contentVersions: document?.content_versions ?? {},
    keys,
    jobsByRunId,
    jobsByResultNodeId,
    submittingNodeIds,
    mediaReplaceBusyNodeIds,
    mediaReplaceError,
    canvasUiPreferences,
    canvasUiPreferencesError,
    showImageInfo: document?.settings.show_image_info ?? true,
    libraryBusy,
    selectNode: selectOnlyNode,
    previewContent,
    selectCandidate,
    submitRun,
    retryRun,
    cancelRun,
    updateNode,
    updateText,
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
    assets?.revision,
    cancelRun,
    canvasUiPreferences,
    canvasUiPreferencesError,
    copyPrompt,
    deleteNode,
    document?.content_versions,
    document?.settings.show_image_info,
    editVideo,
    jobsByResultNodeId,
    jobsByRunId,
    keys,
    libraryBusy,
    mediaReplaceBusyNodeIds,
    mediaReplaceError,
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
    selectCandidate,
    selectOnlyNode,
    submitRun,
    submittingNodeIds,
    toggleFreeResize,
    updateNode,
    updateText,
  ]);

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

  return (
    <CanvasNodeContext.Provider value={contextValue}>
      <section ref={editorRegionRef} tabIndex={-1} className="relative h-full min-h-0 overflow-hidden bg-background outline-none" aria-label={`画布编辑器 ${projectName}`}>
        <ReactFlow<FlowNode>
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={canvasNodeTypes}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onEdgesChange={onEdgesChange}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => selectOnlyNode(node.id)}
          onNodeDragStart={recordHistorySnapshot}
          onPaneClick={() => {
            setCreateMenu(null);
            setSelectedConnectionIds(new Set());
            setSelectedNodeIds(new Set());
          }}
          onDragOver={event => {
            if (!event.dataTransfer.types.includes(CANVAS_LIBRARY_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={handleLibraryDrop}
          onMoveEnd={(_, viewport: Viewport) => commit(current => ({ ...current, viewport }))}
          defaultViewport={document.viewport}
          minZoom={0.08}
          maxZoom={2.5}
          zoomOnScroll={false}
          zoomOnPinch
          panOnScroll
          panOnDrag={CANVAS_MOUSE_PAN_BUTTONS}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          deleteKeyCode={null}
          onlyRenderVisibleElements
          className="canvas-flow"
        >
          {background && <Background variant={background} gap={22} size={1} />}
          <Controls position="bottom-left" showInteractive={false} className="canvas-controls hidden sm:flex" />
          {document.settings.show_minimap && (
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
                void setCenter(position.x, position.y, { zoom: getZoom(), duration: 150 });
              }}
            />
          )}
        </ReactFlow>

        <div className="canvas-editor-top pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-2 p-2 sm:gap-3 sm:p-3 md:p-4">
          <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
            <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="返回画布项目列表" onClick={() => void persistNow().then(saved => { if (saved) onBack(); })}><ArrowLeft /></Button>
            <div className="h-6 w-px bg-border" />
            <label className="relative min-w-0">
              <span className="sr-only">切换画布项目</span>
              <select value={projectId} onChange={event => void persistNow().then(saved => { if (saved) onSwitchProject(event.target.value); })} className="h-9 max-w-28 appearance-none truncate rounded-md bg-transparent pl-2 pr-8 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary sm:max-w-52">
                {projects.map(project => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-2.5 size-4 text-muted-foreground" />
            </label>
          </div>
          <div aria-live="polite" className="pointer-events-auto max-w-24 truncate rounded-full border border-border bg-glass px-3 py-2 text-xs text-muted-foreground backdrop-blur-glass shell-glow sm:max-w-none">
            {saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存冲突，内容已保留' : `已保存 · v${document.revision}`}
          </div>
        </div>

        <div className="canvas-tool-rail absolute left-3 top-1/2 z-20 -translate-y-1/2 md:left-4">
          <div className="relative flex flex-col items-center gap-1 rounded-full border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
            <ToolButton buttonRef={addTriggerRef} label={addOpen ? '关闭添加菜单' : '添加节点'} active={addOpen} expanded={addOpen} controlsId="canvas-add-menu" onClick={() => { setCreateMenu(null); setAddOpen(value => !value); }}>{addOpen ? <X /> : <Plus />}</ToolButton>
            <ToolButton label="选择工具" active={!addOpen && !createMenu} onClick={() => { setAddOpen(false); setCreateMenu(null); }}><MousePointer2 /></ToolButton>
            <div className="my-1 h-px w-7 bg-border" />
            <ToolButton buttonRef={assetLibraryTriggerRef} label="项目资产库" active={libraryMode === 'assets'} expanded={libraryMode === 'assets'} controlsId="canvas-library-panel" popup={false} onClick={() => { setAddOpen(false); setCreateMenu(null); setLibraryMode(current => current === 'assets' ? null : 'assets'); }}><Library /></ToolButton>
            <ToolButton buttonRef={promptLibraryTriggerRef} label="项目提示词库" active={libraryMode === 'prompts'} expanded={libraryMode === 'prompts'} controlsId="canvas-library-panel" popup={false} onClick={() => { setAddOpen(false); setCreateMenu(null); setLibraryMode(current => current === 'prompts' ? null : 'prompts'); }}><WandSparkles /></ToolButton>
            <div className="my-1 h-px w-7 bg-border" />
            <ToolButton label="撤销" disabled={history.current.past.length === 0} onClick={undo}><Undo2 /></ToolButton>
            <ToolButton label="重做" disabled={history.current.future.length === 0} onClick={redo}><Redo2 /></ToolButton>
            <div className="my-1 h-px w-7 bg-border" />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  title="画布外观"
                  aria-label="画布外观"
                  className="grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary data-[state=open]:bg-primary data-[state=open]:text-primary-foreground"
                >
                  <Grid2X2 aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="w-48 rounded-xl">
                <DropdownMenuLabel>画布背景</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={document.settings.background}
                  onValueChange={value => {
                    if (value !== 'none' && value !== 'dots' && value !== 'lines') return;
                    if (value === document.settings.background) return;
                    commit(current => ({
                      ...current,
                      settings: {
                        ...current.settings,
                        background: value,
                      },
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
                <DropdownMenuCheckboxItem
                  checked={document.settings.show_minimap}
                  className="gap-2"
                  onCheckedChange={checked => commit(current => ({
                    ...current,
                    settings: { ...current.settings, show_minimap: checked },
                  }), true)}
                >
                  <MapPinned className="size-4" aria-hidden="true" />显示小地图
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <ToolButton label="适应全部节点" onClick={() => void fitView({ duration: 150, padding: 0.12 })}><Maximize2 /></ToolButton>
          </div>
          {addOpen && (
            <div ref={addMenuRef} id="canvas-add-menu" role="menu" aria-label="添加节点" onKeyDown={handleMenuNavigation} className="popover-in absolute left-14 top-0 w-56 rounded-xl border border-border bg-popover p-2 shell-glow">
              <p className="px-2 pb-2 pt-1 text-xs uppercase tracking-label text-muted-foreground">添加节点</p>
              <CanvasCreateMenuItems allowResources onAddText={() => addTextNode(null)} onAddImage={() => addGenerationNode('image', null)} onAddVideo={() => addGenerationNode('video', null)} onAddAudio={() => addGenerationNode('audio', null)} onUpload={() => uploadRef.current?.click()} />
            </div>
          )}
          <input ref={uploadRef} type="file" className="sr-only" accept="image/*,video/*,audio/*" onChange={event => { const file = event.target.files?.[0]; if (file) void handleUpload(file); event.target.value = ''; }} />
          <input
            ref={replaceMediaRef}
            type="file"
            className="sr-only"
            aria-label="选择替换媒体"
            accept={mediaReplaceTarget ? replacementAccept(mediaReplaceTarget.kind) : undefined}
            onChange={event => {
              const file = event.target.files?.[0];
              const target = mediaReplaceTarget;
              if (file && target) void handleMediaReplace(file, target);
              else setMediaReplaceTarget(null);
              event.target.value = '';
            }}
          />
        </div>

        {createMenu && (
          <div ref={createMenuRef} role="menu" aria-label="连接创建节点" onKeyDown={handleMenuNavigation} className="fixed z-20 w-56 rounded-xl border border-border bg-popover p-2 shell-glow" style={{ left: createMenu.screen.x, top: createMenu.screen.y }}>
            <div className="flex items-center justify-between px-2 pb-2 pt-1"><p className="text-xs uppercase tracking-label text-muted-foreground">创建并连接</p><button type="button" aria-label="关闭连接创建菜单" onClick={() => { setCreateMenu(null); requestAnimationFrame(() => editorRegionRef.current?.focus()); }} className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X className="size-4" /></button></div>
            <CanvasCreateMenuItems allowResources={createMenu.sourceHandle === 'target'} onAddText={() => addTextNode(createMenu)} onAddImage={() => addGenerationNode('image', createMenu)} onAddVideo={() => addGenerationNode('video', createMenu)} onAddAudio={() => addGenerationNode('audio', createMenu)} onUpload={() => uploadRef.current?.click()} />
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

        {selectedContentNode && (
          <CanvasInspector
            node={selectedContentNode}
            updateNode={updater => updateNode(selectedContentNode.id, updater)}
            updateText={text => updateText(selectedContentNode.id, text)}
            recordHistory={recordHistorySnapshot}
            deleteNode={() => deleteNode(selectedContentNode.id)}
            projectId={projectId}
            contentVersions={document.content_versions}
            onPreview={selectedContentNode.data.current_version_id
              ? () => previewContent(selectedContentNode.data.current_version_id!, selectedContentNode.title, selectedContentNode.id)
              : undefined}
            downloadHref={selectedContentNode.data.current_version_id
              && document.content_versions[selectedContentNode.data.current_version_id]?.kind !== 'text'
              ? canvasDownloadUrl(projectId, selectedContentNode.data.current_version_id)
              : undefined}
            onCopyPrompt={copyablePromptForNode(selectedContentNode, jobsByResultNodeId)
              ? () => void copyPrompt(selectedContentNode)
              : undefined}
            onReversePrompt={selectedContentNode.type === 'image'
              && selectedContentNode.data.current_version_id
              ? () => void reversePrompt(selectedContentNode)
              : undefined}
            reversePromptBusy={submittingNodeIds.has(selectedContentNode.id)}
            onReplaceMedia={selectedContentNode.data.current_version_id
              ? () => replaceMedia(selectedContentNode)
              : undefined}
            onToggleFreeResize={selectedContentNode.type === 'image'
              && selectedContentNode.data.current_version_id
              ? () => toggleFreeResize(selectedContentNode)
              : undefined}
            onMaskEdit={selectedContentNode.type === 'image'
              && selectedContentNode.data.current_version_id
              ? () => openMaskEdit(selectedContentNode)
              : undefined}
            onAngle={selectedContentNode.type === 'image'
              && selectedContentNode.data.current_version_id
              ? () => openAngle(selectedContentNode)
              : undefined}
            onEditVideo={selectedContentNode.type === 'video'
              && selectedContentNode.data.current_version_id
              ? () => editVideo(selectedContentNode)
              : undefined}
            replaceMediaBusy={mediaReplaceBusyNodeIds.has(selectedContentNode.id)}
            onCrop={() => openMediaOperation(selectedContentNode, 'crop')}
            onSplit={() => openMediaOperation(selectedContentNode, 'split')}
            onUpscale={() => openMediaOperation(selectedContentNode, 'upscale')}
            onSaveAsset={selectedContentNode.data.current_version_id
              ? () => void saveNodeToLibrary(selectedContentNode)
              : undefined}
            saveAssetBusy={libraryBusy}
            mobileGeneration={selectedDraft ? (
              <CanvasGenerationComposer
                embedded
                node={selectedContentNode}
                draft={selectedDraft}
                context={contextValue}
              />
            ) : null}
          />
        )}

        {!preview && !mediaOperation && !maskEdit && !angleState && <CanvasActionFeedback error={error} notice={toolNotice} onDismissError={() => setError(null)} className="absolute right-3 top-20 z-30 max-w-sm items-end md:right-4" />}

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

function CanvasCreateMenuItems({ allowResources, onAddText, onAddImage, onAddVideo, onAddAudio, onUpload }: {
  allowResources: boolean;
  onAddText: () => void;
  onAddImage: () => void;
  onAddVideo: () => void;
  onAddAudio: () => void;
  onUpload: () => void;
}) {
  return <>
    {allowResources && <AddMenuButton icon={<Type />} title="文本" description="脚本、提示词与备注" onClick={onAddText} />}
    <AddMenuButton icon={<FileImage />} title="图片" description="空节点可填写生成设置" onClick={onAddImage} />
    <AddMenuButton icon={<FileVideo />} title="视频" description="空节点可填写生成设置" onClick={onAddVideo} />
    <AddMenuButton icon={<FileAudio />} title="音频" description="旁白、对白与语音" onClick={onAddAudio} />
    {allowResources && <AddMenuButton icon={<Upload />} title="上传素材" description="图片、视频或音频" onClick={onUpload} />}
  </>;
}

function CanvasPreview({
  projectId,
  preview,
  job,
  onCopyPrompt,
}: {
  projectId: string;
  preview: PreviewState;
  job?: Job;
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
        {job?.canvas_run && <MetadataItem label="模型" value={job.canvas_run.snapshot.model} />}
        <MetadataItem label="创建时间" value={formatCanvasTimestamp(version.created_at)} numeric />
        <MetadataItem label="版本" value={version.version_id} technical />
      </dl>
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
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-popover px-3 py-2 text-sm text-destructive shell-glow">
          <span className="flex-1">{error}</span>
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

function firstKeyForKind(keys: KeyView[], kind: JobKind) {
  return keys.find(key => key.models.some(model => modelModality(model, key) === kind));
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

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="dialog"]'));
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

function providesContent(node: CanvasNode) {
  return isContentNode(node);
}

function backgroundVariant(background: CanvasDocument['settings']['background']) {
  if (background === 'dots') return BackgroundVariant.Dots;
  if (background === 'lines') return BackgroundVariant.Lines;
  return null;
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

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}
