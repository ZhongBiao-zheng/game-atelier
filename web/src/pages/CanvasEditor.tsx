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
  FileAudio,
  FileImage,
  FileVideo,
  Grid2X2,
  LoaderCircle,
  Maximize2,
  MousePointer2,
  Plus,
  Redo2,
  Type,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getCanvasDocument,
  listCanvasJobs,
  listCanvasProjects,
  saveCanvasDocument,
  submitCanvasRun,
  uploadCanvasMedia,
} from '@/api/canvas';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import {
  AddMenuButton,
  CanvasInspector,
  CanvasNodeContext,
  EditorMessage,
  ToolButton,
  canvasNodeTypes,
  type CanvasNodeContextValue,
  type FlowNode,
} from '@/components/canvas/CanvasEditorViews';
import { Button } from '@/components/ui/button';
import type {
  CanvasContentNode,
  CanvasDocument,
  CanvasNode,
  CanvasTextVersion,
} from '@/schema/canvas';
import type { Job, JobKind } from '@/schema/jobs';
import { normalizeCanvasImageParams } from './canvasEditorModel';

interface CreateMenuState {
  screen: XYPosition;
  flow: XYPosition;
  sourceId?: string;
  sourceHandle?: 'source' | 'target';
}

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
  const [submittingNodeIds, setSubmittingNodeIds] = useState<Set<string>>(() => new Set());
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set());
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<Set<string>>(() => new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [createMenu, setCreateMenu] = useState<CreateMenuState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const uploadRef = useRef<HTMLInputElement>(null);
  const dirtyVersion = useRef(0);
  const [dirtySignal, setDirtySignal] = useState(0);
  const serverRevision = useRef(0);
  const saveInFlight = useRef<Promise<void> | null>(null);
  const saveQueued = useRef<CanvasDocument | null>(null);
  const runSubmissionInFlight = useRef(false);
  const latestDocument = useRef<CanvasDocument | null>(null);
  const pendingTextVersions = useRef(new Map<string, string>());
  const syncedTerminalRuns = useRef(new Set<string>());
  const history = useRef<{ past: CanvasDocument[]; future: CanvasDocument[] }>({ past: [], future: [] });
  const { screenToFlowPosition, fitView } = useReactFlow<FlowNode>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDocument(null);
    setSelectedNodeIds(new Set());
    setSelectedConnectionIds(new Set());
    setSubmittingNodeIds(new Set());
    setCreateMenu(null);
    history.current = { past: [], future: [] };
    pendingTextVersions.current.clear();
    syncedTerminalRuns.current.clear();
    dirtyVersion.current = 0;
    setDirtySignal(0);
    serverRevision.current = 0;
    runSubmissionInFlight.current = false;
    Promise.all([listCanvasProjects(), getCanvasDocument(projectId), listKeys(), listCanvasJobs(projectId)])
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
    return () => { cancelled = true; };
  }, [projectId]);

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
      setAddOpen(false);
      setCreateMenu(null);
      setSelectedNodeIds(new Set());
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  latestDocument.current = document;
  const selectedId = selectedNodeIds.size === 1
    ? selectedNodeIds.values().next().value ?? null
    : null;

  const flushSave = useCallback(function drainSaveQueue(): Promise<void> {
    if (runSubmissionInFlight.current) return Promise.resolve();
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

  const flowNodes = useMemo<FlowNode[]>(() => (document?.nodes ?? []).map(node => ({
    id: node.id,
    type: 'canvasNode',
    position: node.position,
    style: {
      width: node.size?.width ?? (node.type === 'text' ? 256 : 320),
      height: node.size?.height ?? (node.type === 'text' ? 144 : 176),
      zIndex: node.z_index,
    },
    selected: selectedNodeIds.has(node.id),
    data: { domain: node },
  })), [document?.nodes, selectedNodeIds]);

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
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
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
    }
    window.addEventListener('keydown', handleDelete);
    return () => window.removeEventListener('keydown', handleDelete);
  }, [commit, selectedConnectionIds, selectedNodeIds]);

  const selectedNode = document?.nodes.find(node => node.id === selectedId) ?? null;
  const selectedContentNode = selectedNode && isContentNode(selectedNode) ? selectedNode : null;
  const projectName = projects.find(project => project.project_id === projectId)?.name ?? '画布项目';

  function defaultPosition() {
    return screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
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
  }

  function addTextNode(menu: CreateMenuState | null = createMenu) {
    const nodeId = makeId('text');
    const versionId = makeId('version');
    const version: CanvasTextVersion = {
      version_id: versionId,
      kind: 'text',
      text: '',
      created_at: new Date().toISOString(),
      sha256: '0'.repeat(64),
      origin: { kind: 'user_edit' },
    };
    pendingTextVersions.current.set(nodeId, versionId);
    commit(current => ({ ...current, content_versions: { ...current.content_versions, [versionId]: version } }));
    appendNode({
      id: nodeId,
      type: 'text',
      title: '文本',
      position: menu?.flow ?? defaultPosition(),
      z_index: 0,
      data: { current_version_id: versionId, generation_draft: null, active_run_id: null },
    }, menu);
  }

  function addGenerationNode(kind: JobKind, menu: CreateMenuState | null = createMenu) {
    const key = firstKeyForKind(keys, kind);
    const model = key?.models.find(item => modelModality(item, key) === kind)?.id ?? '';
    const now = new Date().toISOString();
    const draft = {
      mode: kind,
      prompt: '',
      input_policy: 'all_connected' as const,
      model,
      alias: key?.alias ?? null,
      params: kind === 'image'
        ? normalizeCanvasImageParams(model, key?.provider, { n: 1, ratio: '1:1' })
        : { duration: 5, ratio: '16:9', resolution: '720p', generate_audio: true },
      updated_at: now,
    };
    appendNode({
      id: makeId(kind),
      type: kind,
      title: kind === 'image' ? '图片' : '视频',
      position: menu?.flow ?? defaultPosition(),
      z_index: 0,
      data: {
        current_version_id: null,
        generation_draft: draft,
        active_run_id: null,
        display: { fit: 'contain', free_resize: false },
      },
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

  function updateNode(nodeId: string, updater: (node: CanvasNode) => CanvasNode) {
    commit(current => ({ ...current, nodes: current.nodes.map(node => node.id === nodeId ? updater(node) : node) }));
  }

  function updateText(nodeId: string, text: string) {
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
  }

  function deleteNode(nodeId: string) {
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
  }

  async function submitRun(nodeId: string) {
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
      const requestedCount = draft.mode === 'image'
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
  }

  function recordHistorySnapshot() {
    const snapshot = latestDocument.current;
    if (!snapshot || history.current.past.at(-1) === snapshot) return;
    history.current.past.push(snapshot);
    history.current.past = history.current.past.slice(-50);
    history.current.future = [];
  }

  function undo() {
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
  }

  function redo() {
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
  }

  const selectOnlyNode = useCallback((id: string) => {
    setSelectedConnectionIds(new Set());
    setSelectedNodeIds(new Set([id]));
  }, []);

  const contextValue: CanvasNodeContextValue = {
    projectId,
    contentVersions: document?.content_versions ?? {},
    keys,
    jobsByRunId: new Map(
      jobs.flatMap(job => job.canvas_run ? [[job.canvas_run.run_id, job] as const] : []),
    ),
    submittingNodeIds,
    selectNode: selectOnlyNode,
    submitRun,
    updateNode,
    updateText,
    recordHistory: recordHistorySnapshot,
    deleteNode,
  };

  if (loading) return <EditorMessage icon={<LoaderCircle className="size-5 animate-spin" />} text="正在展开画布…" />;
  if (!document) return <EditorMessage text={error || '画布读取失败'} action={<Button onClick={onBack}>返回项目列表</Button>} />;

  const background = backgroundVariant(document.settings.background);

  return (
    <CanvasNodeContext.Provider value={contextValue}>
      <section className="relative h-full min-h-0 overflow-hidden bg-background" aria-label={`画布编辑器 ${projectName}`}>
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
          onMoveEnd={(_, viewport: Viewport) => commit(current => ({ ...current, viewport }))}
          defaultViewport={document.viewport}
          minZoom={0.08}
          maxZoom={2.5}
          zoomOnScroll={false}
          zoomOnPinch
          panOnScroll
          panOnDrag={false}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          deleteKeyCode={null}
          onlyRenderVisibleElements
          className="canvas-flow"
        >
          {background && <Background variant={background} gap={22} size={1} />}
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap position="bottom-left" className="canvas-minimap hidden sm:block" pannable zoomable nodeColor="var(--primary)" maskColor="var(--scrim)" />
        </ReactFlow>

        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 md:p-4">
          <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
            <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="返回画布项目列表" onClick={() => void persistNow().then(saved => { if (saved) onBack(); })}><ArrowLeft /></Button>
            <div className="h-6 w-px bg-border" />
            <label className="relative min-w-0">
              <span className="sr-only">切换画布项目</span>
              <select value={projectId} onChange={event => void persistNow().then(saved => { if (saved) onSwitchProject(event.target.value); })} className="h-9 max-w-52 appearance-none truncate rounded-md bg-transparent pl-2 pr-8 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {projects.map(project => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-2.5 size-4 text-muted-foreground" />
            </label>
          </div>
          <div className="pointer-events-auto rounded-full border border-border bg-glass px-3 py-2 text-xs text-muted-foreground backdrop-blur-glass shell-glow">
            {saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存冲突，内容已保留' : `已保存 · v${document.revision}`}
          </div>
        </div>

        <div className="absolute left-3 top-1/2 z-20 -translate-y-1/2 md:left-4">
          <div className="relative flex flex-col items-center gap-1 rounded-full border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
            <ToolButton label={addOpen ? '关闭添加菜单' : '添加节点'} active={addOpen} onClick={() => { setCreateMenu(null); setAddOpen(value => !value); }}>{addOpen ? <X /> : <Plus />}</ToolButton>
            <ToolButton label="选择工具" active={!addOpen && !createMenu} onClick={() => { setAddOpen(false); setCreateMenu(null); }}><MousePointer2 /></ToolButton>
            <div className="my-1 h-px w-7 bg-border" />
            <ToolButton label="撤销" disabled={history.current.past.length === 0} onClick={undo}><Undo2 /></ToolButton>
            <ToolButton label="重做" disabled={history.current.future.length === 0} onClick={redo}><Redo2 /></ToolButton>
            <div className="my-1 h-px w-7 bg-border" />
            <ToolButton label="切换画布背景" active={document.settings.background !== 'none'} onClick={() => commit(current => ({ ...current, settings: { ...current.settings, background: nextBackground(current.settings.background) } }), true)}><Grid2X2 /></ToolButton>
            <ToolButton label="适应全部节点" onClick={() => void fitView({ duration: 250, padding: 0.12 })}><Maximize2 /></ToolButton>
          </div>
          {addOpen && (
            <div className="popover-in absolute left-14 top-0 w-56 rounded-xl border border-border bg-popover p-2 shell-glow">
              <p className="px-2 pb-2 pt-1 text-xs uppercase tracking-label text-muted-foreground">添加节点</p>
              <CanvasCreateMenuItems allowResources showAudioShortcut onAddText={() => addTextNode(null)} onAddImage={() => addGenerationNode('image', null)} onAddVideo={() => addGenerationNode('video', null)} onUpload={() => uploadRef.current?.click()} />
            </div>
          )}
          <input ref={uploadRef} type="file" className="sr-only" accept="image/*,video/*,audio/*" onChange={event => { const file = event.target.files?.[0]; if (file) void handleUpload(file); event.target.value = ''; }} />
        </div>

        {createMenu && (
          <div aria-label="连接创建节点" className="fixed z-20 w-56 rounded-xl border border-border bg-popover p-2 shell-glow" style={{ left: createMenu.screen.x, top: createMenu.screen.y }}>
            <div className="flex items-center justify-between px-2 pb-2 pt-1"><p className="text-xs uppercase tracking-label text-muted-foreground">创建并连接</p><button type="button" aria-label="关闭连接创建菜单" onClick={() => setCreateMenu(null)} className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="size-4" /></button></div>
            <CanvasCreateMenuItems allowResources={createMenu.sourceHandle === 'target'} onAddText={() => addTextNode(createMenu)} onAddImage={() => addGenerationNode('image', createMenu)} onAddVideo={() => addGenerationNode('video', createMenu)} onUpload={() => uploadRef.current?.click()} />
          </div>
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
          />
        )}

        {error && <div role="alert" className="absolute right-3 top-20 z-30 flex max-w-sm items-start gap-2 rounded-lg border border-destructive/30 bg-popover px-3 py-2 text-sm text-destructive shell-glow md:right-4"><span className="flex-1">{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}><X className="size-4" /></button></div>}
      </section>
    </CanvasNodeContext.Provider>
  );
}

function CanvasCreateMenuItems({ allowResources, showAudioShortcut = false, onAddText, onAddImage, onAddVideo, onUpload }: {
  allowResources: boolean;
  showAudioShortcut?: boolean;
  onAddText: () => void;
  onAddImage: () => void;
  onAddVideo: () => void;
  onUpload: () => void;
}) {
  return <>
    {allowResources && <AddMenuButton icon={<Type />} title="文本" description="脚本、提示词与备注" onClick={onAddText} />}
    <AddMenuButton icon={<FileImage />} title="图片" description="空节点可填写生成设置" onClick={onAddImage} />
    <AddMenuButton icon={<FileVideo />} title="视频" description="空节点可填写生成设置" onClick={onAddVideo} />
    {allowResources && showAudioShortcut && <AddMenuButton icon={<FileAudio />} title="音频素材" description="上传一段声音或音乐" onClick={onUpload} />}
    {allowResources && <AddMenuButton icon={<Upload />} title="上传素材" description="图片、视频或音频" onClick={onUpload} />}
  </>;
}

function firstKeyForKind(keys: KeyView[], kind: JobKind) {
  return keys.find(key => key.models.some(model => modelModality(model, key) === kind));
}

function pointerPosition(event: MouseEvent | TouchEvent): XYPosition | null {
  if ('clientX' in event) return { x: event.clientX, y: event.clientY };
  const touch = event.changedTouches[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
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
  if (background === 'lines' || background === 'grid') return BackgroundVariant.Lines;
  return null;
}

function nextBackground(background: CanvasDocument['settings']['background']): CanvasDocument['settings']['background'] {
  if (background === 'none') return 'dots';
  if (background === 'dots') return 'lines';
  return 'none';
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}
