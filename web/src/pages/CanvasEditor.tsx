import '@xyflow/react/dist/style.css';

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  createCanvasJob,
  getCanvasDocument,
  listCanvasJobs,
  listCanvasProjects,
  saveCanvasDocument,
  uploadCanvasMedia,
} from '@/api/canvas';
import { listKeys, modelModality, type KeyView } from '@/api/keys';
import { Button } from '@/components/ui/button';
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
import { useSSE } from '@/hooks/useSSE';
import type { CanvasDocument, CanvasGenerationNode, CanvasNode } from '@/schema/canvas';
import type { Job, JobKind } from '@/schema/jobs';
import {
  buildCanvasGenerationRequest,
  normalizeCanvasImageParams,
} from './canvasEditorModel';

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
  return (
    <ReactFlowProvider>
      <CanvasEditorInner {...props} />
    </ReactFlowProvider>
  );
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
  const [jobs, setJobs] = useState<Map<string, Job>>(new Map());
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConnectionIds, setSelectedConnectionIds] = useState<Set<string>>(() => new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [createMenu, setCreateMenu] = useState<CreateMenuState | null>(null);
  const [background, setBackground] = useState<BackgroundVariant | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dirtyVersion = useRef(0);
  const [dirtySignal, setDirtySignal] = useState(0);
  const saveInFlight = useRef<Promise<void> | null>(null);
  const saveQueued = useRef<CanvasDocument | null>(null);
  const latestDocument = useRef<CanvasDocument | null>(null);
  const history = useRef<{ past: CanvasDocument[]; future: CanvasDocument[] }>({ past: [], future: [] });
  const { screenToFlowPosition, fitView } = useReactFlow<FlowNode>();

  const refreshJobs = useCallback(async () => {
    try {
      const rows = await listCanvasJobs(projectId);
      setJobs(new Map(rows.map(job => [job.job_id, job])));
    } catch {
      // 初始加载负责展示错误；SSE 兜底刷新失败时保留已有任务状态。
    }
  }, [projectId]);

  useSSE({
    onJobChanged: payload => {
      if (!payload.job_id || jobs.has(payload.job_id)) void refreshJobs();
    },
    onConnect: refreshJobs,
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDocument(null);
    setSelectedId(null);
    setSelectedConnectionIds(new Set());
    setCreateMenu(null);
    history.current = { past: [], future: [] };
    Promise.all([
      listCanvasProjects(),
      getCanvasDocument(projectId),
      listCanvasJobs(projectId),
      listKeys(),
    ]).then(([projectRows, canvasDocument, jobRows, keyRows]) => {
      if (cancelled) return;
      setProjects(projectRows);
      setDocument(canvasDocument);
      setJobs(new Map(jobRows.map(job => [job.job_id, job])));
      setKeys(keyRows.keys);
    }).catch(loadError => {
      if (!cancelled) setError((loadError as Error).message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setAddOpen(false);
      setCreateMenu(null);
      setSelectedId(null);
    }
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  latestDocument.current = document;

  const flushSave = useCallback(function drainSaveQueue(): Promise<void> {
    if (saveInFlight.current) {
      return saveInFlight.current.then(() => (
        saveQueued.current ? drainSaveQueue() : undefined
      ));
    }
    const run = async () => {
      let failedSnapshot: CanvasDocument | null = null;
      try {
        while (saveQueued.current) {
          const snapshot = saveQueued.current;
          saveQueued.current = null;
          failedSnapshot = snapshot;
          setSaveState('saving');
          await saveCanvasDocument(projectId, snapshot);
          failedSnapshot = null;
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
    if (!document || dirtySignal === 0) return;
    saveQueued.current = document;
    const timer = window.setTimeout(() => void flushSave().catch(() => undefined), 350);
    return () => window.clearTimeout(timer);
  }, [dirtySignal, document, flushSave]);

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

  useEffect(() => () => {
    if (latestDocument.current && dirtyVersion.current > 0) {
      saveQueued.current = latestDocument.current;
      void flushSave().catch(() => undefined);
    }
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
      const next = { ...updater(current), updated_at: new Date().toISOString() };
      return next;
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
    },
    selected: node.id === selectedId,
    data: { domain: node },
  })), [document?.nodes, selectedId]);

  const flowEdges = useMemo(() => (document?.connections ?? []).map(connection => ({
    id: connection.id,
    source: connection.source_node_id,
    target: connection.target_node_id,
    type: 'smoothstep',
    className: 'canvas-provenance-edge',
    selected: selectedConnectionIds.has(connection.id),
    selectable: true,
    deletable: true,
  })), [document?.connections, selectedConnectionIds]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    let nextSelected = selectedId;
    for (const change of changes) {
      if (change.type !== 'select') continue;
      if (change.selected) nextSelected = change.id;
      else if (nextSelected === change.id) nextSelected = null;
    }
    setSelectedId(nextSelected);
    const graphChanges = changes.filter(change => (
      change.type === 'position' || change.type === 'dimensions' || change.type === 'remove'
    ));
    if (!graphChanges.length) return;
    commit(current => {
      let nodes = [...current.nodes];
      let connections = current.connections;
      for (const change of graphChanges) {
        if (change.type === 'position' && change.position) {
          nodes = nodes.map(node => node.id === change.id ? { ...node, position: change.position! } : node);
        }
        if (change.type === 'dimensions' && change.dimensions) {
          nodes = nodes.map(node => node.id === change.id
            ? { ...node, size: { width: change.dimensions!.width, height: change.dimensions!.height } }
            : node);
        }
        if (change.type === 'remove') {
          nodes = nodes.filter(node => node.id !== change.id);
          connections = connections.filter(edge => edge.source_node_id !== change.id && edge.target_node_id !== change.id);
          if (nextSelected === change.id) nextSelected = null;
        }
      }
      return { ...current, nodes, connections };
    }, graphChanges.some(change => change.type === 'remove'));
    setSelectedId(nextSelected);
  }, [commit, selectedId]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const targetNode = latestDocument.current?.nodes.find(node => node.id === connection.target);
    if (targetNode?.type !== 'generation') {
      setError('当前画布仅支持把连接接入生成节点。');
      return;
    }
    commit(current => {
      const exists = current.connections.some(edge => (
        edge.source_node_id === connection.source && edge.target_node_id === connection.target
      ));
      if (exists) return current;
      return {
        ...current,
        connections: [...current.connections, {
          id: makeId('connection'),
          kind: 'provenance',
          source_node_id: connection.source!,
          target_node_id: connection.target!,
        }],
      };
    }, true);
  }, [commit]);

  const onConnectEnd = useCallback<OnConnectEnd>((event, state) => {
    if (state.isValid || !state.fromNode) return;
    const fromDomainNode = latestDocument.current?.nodes.find(node => node.id === state.fromNode?.id);
    if (state.fromHandle?.type === 'target' && fromDomainNode?.type !== 'generation') return;
    const pointer = pointerPosition(event);
    if (!pointer) return;
    const menuWidth = 240;
    const menuHeight = 344;
    setAddOpen(false);
    setCreateMenu({
      screen: {
        x: Math.max(12, Math.min(pointer.x, window.innerWidth - menuWidth - 12)),
        y: Math.max(12, Math.min(pointer.y, window.innerHeight - menuHeight - 12)),
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
        if (change.type === 'select') {
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
        }
        if (change.type === 'remove') next.delete(change.id);
      }
      return next;
    });
    const removedIds = new Set(changes.filter(change => change.type === 'remove').map(change => change.id));
    if (!removedIds.size) return;
    commit(current => ({
      ...current,
      connections: current.connections.filter(edge => !removedIds.has(edge.id)),
    }), true);
  }, [commit]);

  useEffect(() => {
    function handleDelete(event: KeyboardEvent) {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)
      ) return;
      if (!selectedId && selectedConnectionIds.size === 0) return;
      event.preventDefault();
      const deletingNodeIds = selectedId ? new Set([selectedId]) : new Set<string>();
      commit(current => ({
        ...current,
        nodes: current.nodes.filter(node => !deletingNodeIds.has(node.id)),
        connections: current.connections.filter(edge => (
          !selectedConnectionIds.has(edge.id)
          && !deletingNodeIds.has(edge.source_node_id)
          && !deletingNodeIds.has(edge.target_node_id)
        )),
      }), true);
      setSelectedId(null);
      setSelectedConnectionIds(new Set());
    }
    window.addEventListener('keydown', handleDelete);
    return () => window.removeEventListener('keydown', handleDelete);
  }, [commit, selectedConnectionIds, selectedId]);

  const selectedNode = document?.nodes.find(node => node.id === selectedId) ?? null;
  const projectName = projects.find(project => project.project_id === projectId)?.name ?? '画布项目';

  function defaultPosition() {
    return screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  }

  function appendNode(node: CanvasNode, menu: CreateMenuState | null) {
    commit(current => {
      const connections = [...current.connections];
      if (menu?.sourceId) {
        const sourceNodeId = menu.sourceHandle === 'target' ? node.id : menu.sourceId;
        const targetNodeId = menu.sourceHandle === 'target' ? menu.sourceId : node.id;
        connections.push({
          id: makeId('connection'),
          kind: 'provenance',
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
        });
      }
      return { ...current, nodes: [...current.nodes, node], connections };
    }, true);
    setSelectedConnectionIds(new Set());
    setSelectedId(node.id);
    setAddOpen(false);
    setCreateMenu(null);
  }

  function addTextNode(menu: CreateMenuState | null = createMenu) {
    const id = makeId('text');
    const node: CanvasNode = {
      id,
      type: 'text',
      position: menu?.flow ?? defaultPosition(),
      data: { title: '文本', text: '' },
    };
    appendNode(node, menu);
  }

  function addGenerationNode(kind: JobKind, menu: CreateMenuState | null = createMenu) {
    const key = firstKeyForKind(keys, kind);
    const model = key?.models.find(item => modelModality(item, key) === kind)?.id ?? '';
    const id = makeId(kind);
    const node: CanvasGenerationNode = {
      id,
      type: 'generation',
      position: menu?.flow ?? defaultPosition(),
      data: {
        media_kind: kind,
        draft: {
          prompt: '',
          model,
          alias: key?.alias,
          params: kind === 'image'
            ? normalizeCanvasImageParams(model, key?.provider, { n: 1, ratio: '1:1' })
            : { duration: 5, ratio: '16:9', resolution: '720p', generate_audio: true },
        },
        job_ids: [],
      },
    };
    appendNode(node, menu);
  }

  async function handleUpload(file: File) {
    const menu = createMenu;
    setAddOpen(false);
    setError(null);
    try {
      const uploaded = await uploadCanvasMedia(projectId, file);
      const id = makeId('resource');
      const node: CanvasNode = {
        id,
        type: 'resource',
        position: menu?.flow ?? defaultPosition(),
        data: uploaded,
      };
      appendNode(node, menu);
    } catch (uploadError) {
      setError((uploadError as Error).message);
    }
  }

  function updateNode(nodeId: string, updater: (node: CanvasNode) => CanvasNode) {
    commit(current => ({
      ...current,
      nodes: current.nodes.map(node => node.id === nodeId ? updater(node) : node),
    }));
  }

  function updateSelected(updater: (node: CanvasNode) => CanvasNode) {
    if (selectedId) updateNode(selectedId, updater);
  }

  function deleteNode(deletingId: string) {
    commit(current => ({
      ...current,
      nodes: current.nodes.filter(node => node.id !== deletingId),
      connections: current.connections.filter(edge => edge.source_node_id !== deletingId && edge.target_node_id !== deletingId),
    }), true);
    setSelectedId(current => current === deletingId ? null : current);
    setSelectedConnectionIds(current => {
      if (!document) return current;
      const attachedIds = new Set(document.connections
        .filter(edge => edge.source_node_id === deletingId || edge.target_node_id === deletingId)
        .map(edge => edge.id));
      return new Set([...current].filter(id => !attachedIds.has(id)));
    });
  }

  function deleteSelected() {
    if (selectedId) deleteNode(selectedId);
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
    setDocument({ ...previous, updated_at: new Date().toISOString() });
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
  }

  function redo() {
    const next = history.current.future.pop();
    if (!next || !document) return;
    history.current.past.push(document);
    setDocument({ ...next, updated_at: new Date().toISOString() });
    dirtyVersion.current += 1;
    setDirtySignal(dirtyVersion.current);
  }

  async function generate(node: CanvasGenerationNode) {
    const provider = keys.find(key => key.alias === node.data.draft.alias)?.provider;
    const request = buildCanvasGenerationRequest(node, provider);
    if (!request.prompt) {
      setError('请先填写生成提示词。');
      return;
    }
    if (!request.model) {
      setError('当前没有可用模型，请先到设置中配置密钥和模型。');
      return;
    }
    setGeneratingId(node.id);
    setError(null);
    try {
      const job = await createCanvasJob(projectId, request);
      setJobs(current => new Map(current).set(job.job_id, job));
      commit(current => {
        return {
          ...current,
          nodes: current.nodes.map(candidate => candidate.id === node.id && candidate.type === 'generation'
            ? {
              ...candidate,
              data: {
                ...candidate.data,
                job_ids: [...candidate.data.job_ids, job.job_id],
                active_job_id: job.job_id,
                selected_output_index: 0,
              },
            }
            : candidate),
        };
      }, true);
    } catch (generationError) {
      setError((generationError as Error).message);
    } finally {
      setGeneratingId(null);
    }
  }

  const contextValue: CanvasNodeContextValue = {
    projectId,
    jobs,
    keys,
    generatingId,
    selectNode: id => {
      setSelectedConnectionIds(new Set());
      setSelectedId(id);
    },
    updateNode,
    recordHistory: recordHistorySnapshot,
    deleteNode,
    generate: node => void generate(node),
  };

  if (loading) return <EditorMessage icon={<LoaderCircle className="size-5 animate-spin" />} text="正在展开画布…" />;
  if (!document) return <EditorMessage text={error || '画布读取失败'} action={<Button onClick={onBack}>返回项目列表</Button>} />;

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
          onNodeClick={(_, node) => {
            setSelectedConnectionIds(new Set());
            setSelectedId(node.id);
          }}
          onNodeDragStart={recordHistorySnapshot}
          onPaneClick={() => {
            setCreateMenu(null);
            setSelectedConnectionIds(new Set());
            setSelectedId(null);
          }}
          onMoveEnd={(_, viewport: Viewport) => commit(current => ({ ...current, viewport }))}
          defaultViewport={document.viewport}
          minZoom={0.08}
          maxZoom={2.5}
          deleteKeyCode={null}
          onlyRenderVisibleElements
          className="canvas-flow"
        >
          {background && <Background variant={background} gap={22} size={1} />}
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            position="bottom-left"
            className="canvas-minimap hidden sm:block"
            pannable
            zoomable
            nodeColor="var(--primary)"
            maskColor="var(--scrim)"
          />
        </ReactFlow>

        <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-3 md:p-4">
          <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
            <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label="返回画布项目列表" onClick={() => void persistNow().then(saved => { if (saved) onBack(); })}>
              <ArrowLeft aria-hidden="true" />
            </Button>
            <div className="h-6 w-px bg-border" aria-hidden="true" />
            <label className="relative min-w-0">
              <span className="sr-only">切换画布项目</span>
              <select
                value={projectId}
                onChange={event => {
                  const nextProjectId = event.target.value;
                  void persistNow().then(saved => { if (saved) onSwitchProject(nextProjectId); });
                }}
                className="h-9 max-w-52 appearance-none truncate rounded-md bg-transparent pl-2 pr-8 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {projects.map(project => <option key={project.project_id} value={project.project_id}>{project.name}</option>)}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
            </label>
          </div>
          <div className="pointer-events-auto rounded-full border border-border bg-glass px-3 py-2 text-xs text-muted-foreground backdrop-blur-glass shell-glow">
            {saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已自动保存'}
          </div>
        </div>

        <div className="absolute left-3 top-1/2 z-20 -translate-y-1/2 md:left-4">
          <div className="relative flex flex-col items-center gap-1 rounded-full border border-border bg-glass p-1.5 backdrop-blur-glass shell-glow">
            <ToolButton label={addOpen ? '关闭添加菜单' : '添加节点'} active={addOpen} onClick={() => {
              setCreateMenu(null);
              setAddOpen(value => !value);
            }}>
              {addOpen ? <X /> : <Plus />}
            </ToolButton>
            <ToolButton label="选择工具" active={!addOpen && !createMenu} onClick={() => {
              setAddOpen(false);
              setCreateMenu(null);
            }}><MousePointer2 /></ToolButton>
            <div className="my-1 h-px w-7 bg-border" />
            <ToolButton label="撤销" disabled={history.current.past.length === 0} onClick={undo}><Undo2 /></ToolButton>
            <ToolButton label="重做" disabled={history.current.future.length === 0} onClick={redo}><Redo2 /></ToolButton>
            <div className="my-1 h-px w-7 bg-border" />
            <ToolButton
              label="切换画布背景"
              active={background !== null}
              onClick={() => setBackground(current => (
                current === null
                  ? BackgroundVariant.Dots
                  : current === BackgroundVariant.Dots
                    ? BackgroundVariant.Lines
                    : null
              ))}
            >
              <Grid2X2 />
            </ToolButton>
            <ToolButton label="适应全部节点" onClick={() => void fitView({ duration: 250, padding: 0.12 })}><Maximize2 /></ToolButton>
          </div>
          {addOpen && (
            <div className="popover-in absolute left-14 top-0 w-56 rounded-xl border border-border bg-popover p-2 shell-glow">
              <p className="px-2 pb-2 pt-1 text-xs uppercase tracking-label text-muted-foreground">添加节点</p>
              <CanvasCreateMenuItems
                allowResources
                showAudioShortcut
                onAddText={() => addTextNode(null)}
                onAddImage={() => addGenerationNode('image', null)}
                onAddVideo={() => addGenerationNode('video', null)}
                onUpload={() => uploadRef.current?.click()}
              />
            </div>
          )}
          <input
            ref={uploadRef}
            type="file"
            className="sr-only"
            accept="image/*,video/*,audio/*"
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) void handleUpload(file);
              event.target.value = '';
            }}
          />
        </div>

        {createMenu && (
          <div
            aria-label="连接创建节点"
            className="fixed z-20 w-56 rounded-xl border border-border bg-popover p-2 shell-glow"
            style={{ left: createMenu.screen.x, top: createMenu.screen.y }}
          >
            <div className="flex items-center justify-between px-2 pb-2 pt-1">
              <p className="text-xs uppercase tracking-label text-muted-foreground">创建并连接</p>
              <button
                type="button"
                aria-label="关闭连接创建菜单"
                onClick={() => setCreateMenu(null)}
                className="grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <CanvasCreateMenuItems
              allowResources={createMenu.sourceHandle === 'target'}
              onAddText={() => addTextNode(createMenu)}
              onAddImage={() => addGenerationNode('image', createMenu)}
              onAddVideo={() => addGenerationNode('video', createMenu)}
              onUpload={() => uploadRef.current?.click()}
            />
          </div>
        )}

        {selectedNode && selectedNode.type !== 'generation' && (
          <CanvasInspector
            node={selectedNode}
            updateNode={updateSelected}
            recordHistory={recordHistorySnapshot}
            deleteNode={deleteSelected}
            projectId={projectId}
          />
        )}

        {error && (
          <div role="alert" className="absolute right-3 top-20 z-30 flex max-w-sm items-start gap-2 rounded-lg border border-destructive/30 bg-popover px-3 py-2 text-sm text-destructive shell-glow md:right-4">
            <span className="flex-1">{error}</span>
            <button type="button" aria-label="关闭错误提示" onClick={() => setError(null)}><X className="size-4" /></button>
          </div>
        )}
      </section>
    </CanvasNodeContext.Provider>
  );
}

function CanvasCreateMenuItems({
  allowResources,
  showAudioShortcut = false,
  onAddText,
  onAddImage,
  onAddVideo,
  onUpload,
}: {
  allowResources: boolean;
  showAudioShortcut?: boolean;
  onAddText: () => void;
  onAddImage: () => void;
  onAddVideo: () => void;
  onUpload: () => void;
}) {
  return (
    <>
      {allowResources && <AddMenuButton icon={<Type />} title="文本" description="脚本、提示词与备注" onClick={onAddText} />}
      <AddMenuButton icon={<FileImage />} title="图片生成" onClick={onAddImage} />
      <AddMenuButton icon={<FileVideo />} title="视频生成" onClick={onAddVideo} />
      {allowResources && showAudioShortcut && (
        <AddMenuButton icon={<FileAudio />} title="音频素材" description="上传一段声音或音乐" onClick={onUpload} />
      )}
      {allowResources && <AddMenuButton icon={<Upload />} title="上传素材" description="图片、视频或音频" onClick={onUpload} />}
    </>
  );
}


function firstKeyForKind(keys: KeyView[], kind: JobKind) {
  return keys.find(key => key.models.some(model => modelModality(model, key) === kind));
}

function pointerPosition(event: MouseEvent | TouchEvent): XYPosition | null {
  if ('clientX' in event) return { x: event.clientX, y: event.clientY };
  const touch = event.changedTouches[0];
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}
