import '@xyflow/react/dist/style.css';

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type NodeChange,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  FileAudio,
  FileImage,
  FileVideo,
  LoaderCircle,
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
import { buildCanvasGenerationRequest } from './canvasEditorModel';

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
  const [referenceIds, setReferenceIds] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<FlowNode> | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dirtyVersion = useRef(0);
  const [dirtySignal, setDirtySignal] = useState(0);
  const saveInFlight = useRef<Promise<void> | null>(null);
  const saveQueued = useRef<CanvasDocument | null>(null);
  const latestDocument = useRef<CanvasDocument | null>(null);
  const history = useRef<{ past: CanvasDocument[]; future: CanvasDocument[] }>({ past: [], future: [] });

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
    setReferenceIds(new Set());
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
    width: node.size?.width,
    height: node.size?.height,
    selected: node.id === selectedId,
    data: { domain: node },
  })), [document?.nodes, selectedId]);

  const flowEdges = useMemo(() => (document?.connections ?? []).map(connection => ({
    id: connection.id,
    source: connection.source_node_id,
    target: connection.target_node_id,
    type: 'smoothstep',
    className: 'canvas-provenance-edge',
  })), [document?.connections]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    let nextSelected = selectedId;
    for (const change of changes) {
      if (change.type === 'select' && change.selected) nextSelected = change.id;
    }
    setSelectedId(nextSelected);
    const graphChanges = changes.filter(change => change.type === 'position' || change.type === 'remove');
    if (!graphChanges.length) return;
    commit(current => {
      let nodes = [...current.nodes];
      let connections = current.connections;
      for (const change of graphChanges) {
        if (change.type === 'position' && change.position) {
          nodes = nodes.map(node => node.id === change.id ? { ...node, position: change.position! } : node);
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

  const selectedNode = document?.nodes.find(node => node.id === selectedId) ?? null;
  const projectName = projects.find(project => project.project_id === projectId)?.name ?? '画布项目';

  function defaultPosition() {
    if (!flow) return { x: 260 + (document?.nodes.length ?? 0) * 24, y: 180 };
    return flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  }

  function addTextNode() {
    const id = makeId('text');
    const node: CanvasNode = {
      id,
      type: 'text',
      position: defaultPosition(),
      data: { title: '文本', text: '' },
    };
    commit(current => ({ ...current, nodes: [...current.nodes, node] }), true);
    setSelectedId(id);
    setAddOpen(false);
  }

  function addGenerationNode(kind: JobKind) {
    const key = firstKeyForKind(keys, kind);
    const model = key?.models.find(item => modelModality(item, key) === kind)?.id ?? '';
    const id = makeId(kind);
    const node: CanvasGenerationNode = {
      id,
      type: 'generation',
      position: defaultPosition(),
      data: {
        media_kind: kind,
        draft: {
          prompt: '',
          model,
          alias: key?.alias,
          params: kind === 'image'
            ? { n: 1, ratio: '1:1', quality: 'auto' }
            : { duration: 5, ratio: '16:9', resolution: '720p', generate_audio: true },
        },
        job_ids: [],
      },
    };
    commit(current => ({ ...current, nodes: [...current.nodes, node] }), true);
    setSelectedId(id);
    setAddOpen(false);
  }

  async function handleUpload(file: File) {
    setAddOpen(false);
    setError(null);
    try {
      const uploaded = await uploadCanvasMedia(projectId, file);
      const id = makeId('resource');
      const node: CanvasNode = {
        id,
        type: 'resource',
        position: defaultPosition(),
        data: uploaded,
      };
      commit(current => ({ ...current, nodes: [...current.nodes, node] }), true);
      setSelectedId(id);
    } catch (uploadError) {
      setError((uploadError as Error).message);
    }
  }

  function updateSelected(updater: (node: CanvasNode) => CanvasNode) {
    if (!selectedId) return;
    commit(current => ({
      ...current,
      nodes: current.nodes.map(node => node.id === selectedId ? updater(node) : node),
    }));
  }

  function deleteSelected() {
    if (!selectedId) return;
    const deletingId = selectedId;
    commit(current => ({
      ...current,
      nodes: current.nodes.filter(node => node.id !== deletingId),
      connections: current.connections.filter(edge => edge.source_node_id !== deletingId && edge.target_node_id !== deletingId),
    }), true);
    setSelectedId(null);
    setReferenceIds(ids => { const next = new Set(ids); next.delete(deletingId); return next; });
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
    const connectedIds = document?.connections
      .filter(edge => edge.target_node_id === node.id)
      .map(edge => edge.source_node_id) ?? [];
    const requestedIds = referenceIds.size ? [...referenceIds] : connectedIds;
    const sources = (document?.nodes ?? []).filter(candidate => requestedIds.includes(candidate.id) && candidate.id !== node.id);
    const request = buildCanvasGenerationRequest(node, sources, jobs);
    if (!request.body.prompt) {
      setError('请先填写生成提示词，或连接一个有内容的文本节点。');
      return;
    }
    if (!request.body.model) {
      setError('当前没有可用模型，请先到设置中配置密钥和模型。');
      return;
    }
    setGeneratingId(node.id);
    setError(null);
    try {
      const job = await createCanvasJob(projectId, request.body);
      setJobs(current => new Map(current).set(job.job_id, job));
      commit(current => {
        const retained = current.connections.filter(edge => edge.target_node_id !== node.id);
        const provenance = request.sourceNodeIds.map(sourceId => ({
          id: makeId('edge'),
          kind: 'provenance' as const,
          source_node_id: sourceId,
          target_node_id: node.id,
        }));
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
          connections: [...retained, ...provenance],
        };
      }, true);
      setReferenceIds(new Set());
    } catch (generationError) {
      setError((generationError as Error).message);
    } finally {
      setGeneratingId(null);
    }
  }

  const contextValue = useMemo<CanvasNodeContextValue>(() => ({
    projectId,
    jobs,
    referenceIds,
    selectedId,
    selectNode: setSelectedId,
    toggleReference: id => setReferenceIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    }),
  }), [jobs, projectId, referenceIds, selectedId]);

  if (loading) return <EditorMessage icon={<LoaderCircle className="size-5 animate-spin" />} text="正在展开画布…" />;
  if (!document) return <EditorMessage text={error || '画布读取失败'} action={<Button onClick={onBack}>返回项目列表</Button>} />;

  return (
    <CanvasNodeContext.Provider value={contextValue}>
      <section className="relative h-full min-h-0 overflow-hidden bg-background" aria-label={`画布编辑器 ${projectName}`}>
        <ReactFlow<FlowNode>
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={canvasNodeTypes}
          onInit={setFlow}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onNodeDragStart={recordHistorySnapshot}
          onPaneClick={() => setSelectedId(null)}
          onMoveEnd={(_, viewport: Viewport) => commit(current => ({ ...current, viewport }))}
          defaultViewport={document.viewport}
          minZoom={0.08}
          maxZoom={2.5}
          deleteKeyCode={['Backspace', 'Delete']}
          onlyRenderVisibleElements
          className="canvas-flow"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
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
            <ToolButton label={addOpen ? '关闭添加菜单' : '添加节点'} active={addOpen} onClick={() => setAddOpen(value => !value)}>
              {addOpen ? <X /> : <Plus />}
            </ToolButton>
            <ToolButton label="选择工具" active={!addOpen} onClick={() => setAddOpen(false)}><MousePointer2 /></ToolButton>
            <div className="my-1 h-px w-7 bg-border" />
            <ToolButton label="撤销" disabled={history.current.past.length === 0} onClick={undo}><Undo2 /></ToolButton>
            <ToolButton label="重做" disabled={history.current.future.length === 0} onClick={redo}><Redo2 /></ToolButton>
          </div>
          {addOpen && (
            <div className="popover-in absolute left-14 top-0 w-56 rounded-xl border border-border bg-popover p-2 shell-glow">
              <p className="px-2 pb-2 pt-1 text-xs uppercase tracking-label text-muted-foreground">添加节点</p>
              <AddMenuButton icon={<Type />} title="文本" description="脚本、提示词与备注" onClick={addTextNode} />
              <AddMenuButton icon={<FileImage />} title="图片生成" onClick={() => addGenerationNode('image')} />
              <AddMenuButton icon={<FileVideo />} title="视频生成" onClick={() => addGenerationNode('video')} />
              <AddMenuButton icon={<FileAudio />} title="音频素材" description="上传一段声音或音乐" onClick={() => uploadRef.current?.click()} />
              <AddMenuButton icon={<Upload />} title="上传素材" description="图片、视频或音频" onClick={() => uploadRef.current?.click()} />
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

        {referenceIds.size > 0 && (
          <div className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-primary/30 bg-glass px-4 py-2 text-xs text-foreground backdrop-blur-glass shell-glow">
            <Check className="size-4 text-primary" aria-hidden="true" />
            已选择 {referenceIds.size} 个参考节点；选择生成节点后点击生成
            <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setReferenceIds(new Set())}>清空</button>
          </div>
        )}

        {selectedNode && (
          <CanvasInspector
            node={selectedNode}
            jobs={jobs}
            keys={keys}
            generating={generatingId === selectedNode.id}
            referenced={referenceIds.has(selectedNode.id)}
            updateNode={updateSelected}
            recordHistory={recordHistorySnapshot}
            toggleReference={() => contextValue.toggleReference(selectedNode.id)}
            deleteNode={deleteSelected}
            generate={generate}
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


function firstKeyForKind(keys: KeyView[], kind: JobKind) {
  return keys.find(key => key.models.some(model => modelModality(model, key) === kind));
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}
