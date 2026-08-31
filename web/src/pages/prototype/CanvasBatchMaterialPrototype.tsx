import '@xyflow/react/dist/style.css';
import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Handle, Position, ReactFlow, useNodesState, type Node as ReactFlowNode, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { ArrowDown, ArrowLeft, ArrowUp, ImagePlus, Images, Layers, Play, Plus, Scan, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { CanvasNodeCard, CanvasNodeContext, type CanvasNodeContextValue, type FlowNode } from '@/components/canvas/CanvasEditorViews';
import { DEFAULT_CANVAS_UI_PREFERENCES } from '@/components/canvas/canvasImageToolbar';
import type { CanvasMaterialReference, CanvasMentionReference } from '@/lib/canvasMentions';
import type { CanvasGenerationDraft } from '@/schema/canvas';
import { createPrototypeCanvas, pipelineSteps, PROTOTYPE_KEYS, STEP_LABELS, type PrototypePipeline } from './batchCanvasFixtures';

// Throwaway, in-memory interaction prototype. Never import runtime generation APIs here.
type Material = { id: string; name: string; url?: string; sample?: number };
type Item = { id: string; images: Material[] };
type Run = {
  items: Item[];
  rounds: number;
  steps: string[];
  drafts: Record<string, CanvasGenerationDraft>;
  sharedTexts: string[];
  completedSteps: number;
  status: 'running' | 'stopped' | 'done';
};
type BatchFlowNode = ReactFlowNode<Record<string, never>, 'batchPrototype'>;
type PrototypeNode = FlowNode | BatchFlowNode;
const batchNode: BatchFlowNode = { id: 'batch', type: 'batchPrototype', position: { x: 25, y: 40 }, data: {} };
const number = (n: number) => String(n).padStart(2, '0');
const sampleMaterial = (n: number): Material => ({ id: crypto.randomUUID(), name: `素材 ${number(n + 1)}`, sample: n });
const sampleItems = (count: number): Item[] => Array.from({ length: count }, (_, i) => ({ id: crypto.randomUUID(), images: [sampleMaterial(i)] }));

function usePrototypeState() {
  const [items, setItems] = useState<Item[]>(() => sampleItems(3));
  const [pipeline, setPipeline] = useState<PrototypePipeline>('video');
  const [initial] = useState(() => createPrototypeCanvas('video'));
  const [nodes, setNodes, onNodesChange] = useNodesState<PrototypeNode>([batchNode, ...initial.nodes]);
  const [versions, setVersions] = useState(initial.versions);
  const [edges, setEdges] = useState(initial.edges);
  const [dismissedNodeId, setDismissedNodeId] = useState<string | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [rounds, setRounds] = useState(1);
  const [run, setRun] = useState<Run | null>(null);
  const [notice, setNotice] = useState('');
  const flow = useRef<ReactFlowInstance<PrototypeNode> | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);
  const urls = useRef(new Set<string>());
  const locked = run?.status === 'running';

  useEffect(() => {
    const owned = urls.current;
    return () => owned.forEach(url => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => { setRun(null); }, [items, rounds, pipeline]);

  useEffect(() => {
    const retained = new Set([...items, ...(run?.items ?? [])].flatMap(item => item.images.map(image => image.url)));
    for (const url of urls.current) {
      if (!retained.has(url)) {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }
    }
  }, [items, run]);

  useEffect(() => {
    if (!locked) return;
    const timer = window.setInterval(() => setRun(previous => {
      if (!previous || previous.status !== 'running') return previous;
      const completedSteps = previous.completedSteps + 1;
      return { ...previous, completedSteps, status: completedSteps >= previous.items.length * previous.rounds * previous.steps.length ? 'done' : 'running' };
    }), 650);
    return () => window.clearInterval(timer);
  }, [locked]);

  const addMaterials = (materials: Material[], itemId: string | null) => {
    if (locked || !materials.length) return;
    if (itemId) {
      setItems(current => current.map(item => item.id === itemId ? { ...item, images: [...item.images, ...materials] } : item));
      setNotice(`已追加 ${materials.length} 张参考图，任务项数不变。`);
    } else {
      setItems(current => [...current, ...materials.map(material => ({ id: crypto.randomUUID(), images: [material] }))]);
      setNotice(`已新增 ${materials.length} 项，每项 1 张图。`);
    }
  };
  const receiveFiles = (files: File[], itemId: string | null) => {
    if (locked) return;
    const images = files.filter(file => file.type.startsWith('image/'));
    addMaterials(images.map(file => {
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      return { id: crypto.randomUUID(), name: file.name, url };
    }), itemId);
    if (images.length !== files.length) setNotice('这里只接收图片，其他文件已跳过。');
  };
  const requestFiles = (itemId: string | null) => {
    uploadTarget.current = itemId;
    fileInput.current?.click();
  };
  const removeMaterial = (itemId: string, materialId: string) => {
    if (locked) return;
    setItems(current => current.map(item => item.id === itemId ? { ...item, images: item.images.filter(image => image.id !== materialId) } : item).filter(item => item.images.length));
  };
  const moveItem = (index: number, delta: number) => {
    if (locked) return;
    setItems(current => {
      const copy = [...current];
      [copy[index], copy[index + delta]] = [copy[index + delta], copy[index]];
      return copy;
    });
  };
  const start = (onlyNode?: string) => {
    if (locked || !items.length) return;
    const steps = onlyNode ? [onlyNode] : pipelineSteps(pipeline);
    const drafts: Record<string, CanvasGenerationDraft> = {};
    for (const id of steps) {
      const node = nodes.find(candidate => candidate.id === id);
      const domain = node?.type === 'canvasNode' ? node.data.domain : undefined;
      const draft = domain && 'generation_draft' in domain.data ? domain.data.generation_draft : null;
      if (!draft) return;
      if ((draft.params.n ?? 1) !== 1) {
        setNotice('本原型先验证每项一个产物，请把生成张数设为 1。');
        return;
      }
      drafts[id] = structuredClone(draft);
    }
    setRun({ items: items.map(item => ({ ...item, images: [...item.images] })), rounds, steps, drafts, sharedTexts: Object.values(versions).flatMap(version => version.kind === 'text' ? [version.text] : []), completedSteps: 0, status: 'running' });
    setNodes(current => current.map(node => ({ ...node, selected: false })));
    setNotice('');
  };

  const selectNode = (id: string) => {
    setNodes(current => current.map(node => ({ ...node, selected: node.id === id })));
    setDismissedNodeId(null);
    setResultsOpen(false);
    const node = nodes.find(candidate => candidate.id === id);
    if (node?.type === 'canvasNode' && 'generation_draft' in node.data.domain.data && node.data.domain.data.generation_draft) {
      void flow.current?.setViewport({ x: (surfaceRef.current?.clientWidth ?? 1280) / 2 - (node.position.x + 150) * .9, y: 55 - node.position.y * .9, zoom: .9 }, { duration: 200 });
    }
  };
  const changePipeline = (next: PrototypePipeline) => {
    if (locked) return;
    const nextCanvas = createPrototypeCanvas(next);
    setPipeline(next);
    setNodes([batchNode, ...nextCanvas.nodes]);
    setVersions(nextCanvas.versions);
    setEdges(nextCanvas.edges);
    setRun(null);
    setResultsOpen(false);
    setNotice('已切换示例链路，生成参数恢复为演示默认值；素材保留。');
    window.requestAnimationFrame(() => void flow.current?.fitView({ padding: .15, maxZoom: 1, duration: 200 }));
  };

  const materials: CanvasMaterialReference[] = [
    { nodeId: 'batch', versionId: 'prototype-batch', kind: 'image', title: `批量素材 · ${items.length} 项`, previewUrl: items[0]?.images[0]?.url },
    ...nodes.flatMap(node => {
      if (node.type !== 'canvasNode') return [];
      const domain = node.data.domain;
      if (domain.type !== 'text' && domain.type !== 'image' && domain.type !== 'video' && domain.type !== 'audio') return [];
      const version = versions[domain.data.current_version_id ?? ''];
      return [{ nodeId: node.id, versionId: domain.data.current_version_id ?? `prototype-${node.id}`, kind: domain.type, title: domain.title, text: version?.kind === 'text' ? version.text : undefined }];
    }),
  ];
  const connected = new Map(nodes.map(node => [node.id, new Set(edges.filter(edge => edge.target === node.id).map(edge => edge.source))]));
  const mentions = new Map<string, CanvasMentionReference[]>(nodes.map(node => {
    const counts = { image: 0, text: 0, video: 0, audio: 0 };
    const labels = { image: '图片', text: '文本', video: '视频', audio: '音频' };
    return [node.id, materials.filter(material => connected.get(node.id)?.has(material.nodeId)).map(material => ({
      ...material, label: `${labels[material.kind]}${++counts[material.kind]}`,
    }))];
  }));
  const unavailable = () => setNotice('本原型固定示例链路，只演示批量素材和生成设置；其他操作未接入，不会写入真实项目。');
  const context: CanvasNodeContextValue = {
    projectId: 'prototype-batch', keys: PROTOTYPE_KEYS, materialReferences: materials,
    connectedMaterialNodeIdsByNodeId: connected, mentionReferencesByNodeId: mentions,
    resolveVersion: id => id ? versions[id] : undefined,
    jobsByRunId: new Map(), jobsByResultNodeId: new Map(), submittingNodeIds: new Set(),
    mediaReplaceBusyNodeIds: new Set(), mediaReplaceError: null,
    canvasUiPreferences: DEFAULT_CANVAS_UI_PREFERENCES, canvasUiPreferencesError: null,
    showImageInfo: false, libraryBusy: false,
    generationPanel: { dismissedNodeId, narrowViewport: locked, dismiss: setDismissedNodeId, surfaceRef },
    selectNode, recordHistory: () => {}, reportError: setNotice,
    updateNode: (id, updater) => {
      if (locked) return;
      setNodes(current => current.map(node => node.id === id && node.type === 'canvasNode' ? { ...node, data: { domain: updater(node.data.domain) } } : node));
      setRun(null);
    },
    renameNode: (id, title) => setNodes(current => current.map(node => node.id === id && node.type === 'canvasNode' ? { ...node, data: { domain: { ...node.data.domain, title } } } : node)),
    updateText: (id, text) => {
      if (locked) return;
      setVersions(current => ({ ...current, [`prototype-${id}`]: { ...current[`prototype-${id}`], kind: 'text', text } }));
      setRun(null);
    },
    submitRun: async id => start(id), retryRun: async id => start(id),
    cancelRun: async () => setRun(current => current ? { ...current, status: 'stopped' } : current),
    setMaterialConnected: unavailable, beginMaterialPick: unavailable, setVideoFrameConnections: unavailable,
    previewContent: unavailable, selectCandidate: unavailable, dismissCandidate: async () => unavailable(),
    createImageConfigFromText: unavailable, saveAsset: async () => unavailable(), copyPrompt: async () => unavailable(),
    reversePrompt: async () => unavailable(), recoverReversePromptConfig: async () => unavailable(), reversePromptConfiguredNodeIds: new Set(),
    replaceMedia: unavailable, toggleFreeResize: unavailable, openMediaOperation: unavailable, openMaskEdit: unavailable,
    openAngle: unavailable, editVideo: unavailable, saveImageToolbarPreferences: async () => unavailable(), deleteNode: unavailable,
  };
  return { items, setItems, pipeline, changePipeline, rounds, setRounds, run, setRun, locked, notice, fileInput, uploadTarget, receiveFiles, requestFiles, removeMaterial, moveItem, start, nodes, onNodesChange, edges, context, surfaceRef, flow, resultsOpen, setResultsOpen };
}

type PrototypeState = ReturnType<typeof usePrototypeState>;
const PrototypeContext = createContext<PrototypeState | null>(null);
function usePrototype() {
  const state = useContext(PrototypeContext);
  if (!state) throw new Error('Prototype context is missing');
  return state;
}

function Thumbnail({ material, className }: { material: Material; className?: string }) {
  if (material.url) return <img src={material.url} alt={material.name} title={material.name} draggable={false} loading="lazy" className={cn('size-14 shrink-0 rounded-md border border-border object-cover', className)} />;
  const n = material.sample ?? 0;
  return (
    <div role="img" aria-label={material.name} title={`${material.name} · 示例占位图`} className={cn('relative grid size-14 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-secondary', n % 2 ? 'text-primary' : 'text-muted-foreground', className)}>
      <svg viewBox="0 0 64 64" className="size-full" aria-hidden>
        <circle cx="32" cy="32" r="24" fill="currentColor" opacity=".12" />
        {n % 3 === 0 ? <path d="M18 43V27L22 15L31 23L42 15L47 29V43Q32 54 18 43Z" fill="currentColor" opacity=".7" /> : n % 3 === 1 ? <><ellipse cx="33" cy="39" rx="19" ry="15" fill="currentColor" opacity=".7" /><ellipse cx="26" cy="21" rx="5" ry="12" fill="currentColor" opacity=".7" /><ellipse cx="41" cy="21" rx="5" ry="12" fill="currentColor" opacity=".7" /></> : <><path d="M13 40L27 19L50 40L45 50H18Z" fill="currentColor" opacity=".7" /><circle cx="46" cy="18" r="5" fill="currentColor" opacity=".45" /></>}
      </svg>
      <span className="absolute bottom-0 right-1 text-xs text-foreground">{number(n + 1)}</span>
    </div>
  );
}

function FileDrop({ itemId, children, className }: { itemId: string | null; children: ReactNode; className?: string }) {
  const { receiveFiles, locked, items } = usePrototype();
  const [hover, setHover] = useState(false);
  const over = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = locked ? 'none' : 'copy';
    if (!locked) setHover(true);
  };
  return <div className={cn('relative rounded-lg transition-colors', hover && 'bg-primary/10 ring-1 ring-primary', className)} onDragOver={over} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHover(false); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); setHover(false); receiveFiles(Array.from(event.dataTransfer.files), itemId); }}>{children}{hover && <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-card/90 px-3 text-center text-sm text-primary">{itemId ? `加入第 ${number(items.findIndex(item => item.id === itemId) + 1)} 项，不增加项数` : '松开后，一张图新增一项'}</div>}</div>;
}

function MaterialList() {
  const state = usePrototype();
  return (
    <div className="nodrag nowheel nopan space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">每行是一项。行内的图一起参考，行与行独立执行。</p>
      <div className="max-h-72 space-y-2 overflow-y-auto no-scrollbar p-1" aria-label="素材项列表">
        {state.items.map((item, index) => (
          <FileDrop key={item.id} itemId={item.id} className="border border-border bg-background/40 p-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">第 {number(index + 1)} 项 · {item.images.length} 张参考</span>
              <div className="flex items-center gap-1">
                <button className="prototype-icon size-6" disabled={state.locked || index === 0} aria-label={`上移第 ${number(index + 1)} 项`} onClick={() => state.moveItem(index, -1)}><ArrowUp size={12} /></button>
                <button className="prototype-icon size-6" disabled={state.locked || index === state.items.length - 1} aria-label={`下移第 ${number(index + 1)} 项`} onClick={() => state.moveItem(index, 1)}><ArrowDown size={12} /></button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {item.images.map(material => <div key={material.id} className="group relative">
                <Thumbnail material={material} />
                <button className="prototype-icon absolute -right-1 -top-1 size-5 rounded-full border border-border bg-card opacity-0 group-hover:opacity-100 focus:opacity-100" disabled={state.locked} aria-label={`移除第 ${number(index + 1)} 项的${material.name}`} onClick={() => state.removeMaterial(item.id, material.id)}><X size={12} /></button>
              </div>)}
              <button className="prototype-icon size-14 flex-col gap-1 rounded-md border border-dashed border-border hover:border-primary" disabled={state.locked} aria-label={`给第 ${number(index + 1)} 项添加参考图`} title={`加入第 ${number(index + 1)} 项，不增加项数`} onClick={() => state.requestFiles(item.id)}><Plus size={18} /><span className="text-xs">参考</span></button>
            </div>
          </FileDrop>
        ))}
        {!state.items.length && <p className="py-6 text-center text-sm text-muted-foreground">还没有素材，拖入图片开始。</p>}
      </div>
      <FileDrop itemId={null}>
        <button className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary" disabled={state.locked} onClick={() => state.requestFiles(null)}><ImagePlus size={16} />拖入一批图片，或点击添加</button>
      </FileDrop>
      <p className="text-xs text-muted-foreground">拖到空白添加区 → 新项；拖到某一行 → 该项参考图。</p>
    </div>
  );
}

function MaterialsNode({ selected }: NodeProps<BatchFlowNode>) {
  const state = usePrototype();
  const total = state.items.reduce((sum, item) => sum + item.images.length, 0);
  return <section className={cn('w-[356px] rounded-lg border bg-card p-4 text-sm text-foreground shell-glow', selected ? 'border-primary' : 'border-border')}>
    <div className="mb-3 flex items-center justify-between gap-2"><span className="flex items-center gap-2 font-medium"><Layers size={16} />批量素材</span><span className="text-xs text-primary">{state.items.length} 项 · {total} 张图</span></div>
    <MaterialList />
    <Handle type="source" position={Position.Right} className="canvas-node-handle" aria-label="批量素材输出"><span className="canvas-node-handle-dot" aria-hidden /></Handle>
  </section>;
}

function ReusedCanvasNode(props: NodeProps<FlowNode>) {
  const { run } = usePrototype();
  const step = run?.steps.indexOf(props.id) ?? -1;
  const completed = run && step >= 0 ? Math.max(0, Math.min(run.items.length * run.rounds, Math.floor((run.completedSteps + run.steps.length - 1 - step) / run.steps.length))) : 0;
  return <div className="relative h-full w-full">
    <CanvasNodeCard {...props} />
    {run && step >= 0 && <div className="pointer-events-none absolute bottom-3 left-3 right-3 rounded-md border border-primary/30 bg-card/95 px-3 py-2 text-xs text-primary">
      模拟{run.status === 'running' ? '中' : run.status === 'stopped' ? '已停止' : '完成'} · {completed} / {run.items.length * run.rounds} 项
    </div>}
  </div>;
}

const nodeTypes = { batchPrototype: MaterialsNode, canvasNode: ReusedCanvasNode };

function Results() {
  const { run } = usePrototype();
  if (!run) return <div className="px-5 py-5 text-sm text-muted-foreground">点击「模拟执行分组」，查看每项的链路结果。节点内的生成按钮只模拟当前节点。</div>;
  const entries = Array.from({ length: run.rounds }, (_, round) => run.items.map((item, index) => ({ item, round, index }))).flat();
  return <div className="max-h-40 overflow-auto no-scrollbar" aria-label="模拟结果列表">
    <table className="w-full min-w-[650px] text-left text-xs">
      <thead className="sticky top-0 bg-card text-muted-foreground"><tr><th className="px-5 py-2 font-normal">轮 / 项</th><th className="px-3 py-2 font-normal">本次输入</th>{run.steps.map(id => <th key={id} className="px-3 py-2 font-normal">{STEP_LABELS[id]}</th>)}</tr></thead>
      <tbody>{entries.map(({ item, round, index }, order) => <tr key={`${round}-${item.id}`} className="border-t border-border/60">
        <td className="whitespace-nowrap px-5 py-3 text-muted-foreground">{number(round + 1)} / {number(index + 1)}</td>
        <td className="px-3 py-3"><div className="flex items-center gap-2"><Thumbnail material={item.images[0]} className="size-8" /><span>{item.images.length} 张参考</span></div></td>
        {run.steps.map((id, step) => {
          const offset = order * run.steps.length + step;
          const done = run.completedSteps > offset;
          return <td key={id} className={cn('px-3 py-3', done ? 'text-primary' : 'text-muted-foreground')}>
            {done ? '模拟完成' : run.status === 'stopped' ? '已停止' : run.completedSteps === offset ? '模拟中…' : '等待'}
            {done && step > 0 && <span className="ml-2 text-muted-foreground">· 本项{STEP_LABELS[run.steps[step - 1]]}</span>}
          </td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}

export default function CanvasBatchMaterialPrototype() {
  const state = usePrototypeState();
  const totalTasks = state.items.length * state.rounds;
  const completed = state.run ? Math.floor(state.run.completedSteps / state.run.steps.length) : 0;
  return <PrototypeContext.Provider value={state}>
    <CanvasNodeContext.Provider value={state.context}>
      <style>{`.prototype-icon { display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--muted-foreground); transition:color .15s,background-color .15s; } .prototype-icon:hover { color:var(--foreground); background:var(--secondary); } .prototype-icon:focus-visible { outline:2px solid var(--primary); outline-offset:2px; } .prototype-icon:disabled { opacity:.3; pointer-events:none; } .batch-prototype .react-flow__attribution { background:var(--card); color:var(--muted-foreground); }`}</style>
      <div className="batch-prototype flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-center gap-3"><a href="/canvas" className="prototype-icon size-9 rounded-full border border-border" aria-label="返回正式画布"><ArrowLeft size={16} /></a><div><h1 className="text-base font-medium">批量素材 · 复用现有节点</h1><p className="mt-1 text-xs text-muted-foreground">只新增批量素材。其余节点和设置面板直接使用正式组件。</p></div></div>
          <div className="flex items-center gap-2"><Button variant="ghost" size="sm" disabled={state.locked} onClick={() => state.setItems(current => [...current, ...sampleItems(20)])}>追加 20 项示例</Button><Button variant="outline" size="sm" disabled={state.locked} onClick={() => { state.setItems(sampleItems(3)); state.setRun(null); }}>重置素材</Button></div>
        </header>
        <div className="mx-4 mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-glass px-4 py-3 backdrop-blur-glass">
          <div><label className="flex items-center gap-2 text-sm font-medium"><Layers size={16} />示例分组<select aria-label="示例链路" value={state.pipeline} disabled={state.locked} onChange={event => state.changePipeline(event.target.value as PrototypePipeline)} className="rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"><option value="video">图片 → 视频</option><option value="audio">图片 → 文案 → 配音</option></select></label><p className="mt-1 text-xs text-muted-foreground">{state.items.length} 项 × {state.rounds} 轮 = {totalTasks} 条链路 · 每项一份产物</p></div>
          <div className="flex items-center gap-3"><label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">重复<Input aria-label="重复轮数" type="number" min={1} max={20} step={1} value={state.rounds} disabled={state.locked} onChange={event => state.setRounds(Math.max(1, Math.min(20, Math.trunc(Number(event.target.value) || 1))))} className="w-14 text-center text-foreground" />轮</label>{state.locked ? <Button variant="outline" onClick={() => state.setRun(current => current ? { ...current, status: 'stopped' } : current)}><Square />停止模拟</Button> : <Button disabled={!state.items.length} onClick={() => state.start()}><Play />模拟执行分组</Button>}</div>
        </div>
        <div ref={state.surfaceRef} className="relative min-h-64 flex-1">
          <ReactFlow<PrototypeNode> nodes={state.nodes} edges={state.edges} nodeTypes={nodeTypes} onNodesChange={state.onNodesChange} onInit={instance => { state.flow.current = instance; }} onNodeClick={(_, node) => state.context.selectNode(node.id)} nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null} fitView fitViewOptions={{ padding: .15, maxZoom: 1 }} minZoom={.3} maxZoom={1.5} colorMode="dark" aria-label="批量素材工作流原型" />
          <div className="absolute bottom-3 left-4 z-20"><Button variant="outline" size="sm" onClick={() => { state.context.generationPanel.dismiss(state.nodes.find(node => node.selected)?.id ?? ''); void state.flow.current?.fitView({ padding: .15, maxZoom: 1, duration: 200 }); }}><Scan />查看全图</Button></div>
        </div>
        <div role="status" className="shrink-0 px-5 py-2 text-xs text-muted-foreground">{state.locked ? '正在模拟，参数已冻结。不上传、不保存、不调用模型。' : state.run?.status === 'done' ? '模拟完成，没有产生真实媒体或费用。' : state.run?.status === 'stopped' ? '模拟已停止，保留已完成结果。' : state.notice || '点选生成节点打开原来的设置；双击文本节点编辑。仅内存演示，不上传、不保存、不调用模型。'}</div>
        <section className="mx-4 mb-4 shrink-0 overflow-hidden rounded-xl border border-border bg-card">
          <button className="flex w-full items-center justify-between gap-2 px-5 py-3 text-sm transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary" aria-expanded={state.resultsOpen} onClick={() => state.setResultsOpen(!state.resultsOpen)}><span className="flex items-center gap-2"><Images size={16} />模拟结果<span className="text-xs text-muted-foreground">{state.run ? `${completed} / ${state.run.items.length * state.run.rounds} 项完成${state.run.status === 'stopped' ? ' · 已停止' : ''}` : '尚未执行'}</span></span>{state.resultsOpen ? <ArrowDown size={14} /> : <ArrowUp size={14} />}</button>
          {state.resultsOpen && <Results />}
        </section>
        <input ref={state.fileInput} type="file" accept="image/*" multiple className="hidden" aria-label="选择本地素材图片" onChange={event => { state.receiveFiles(Array.from(event.target.files ?? []), state.uploadTarget.current); event.target.value = ''; }} />
      </div>
    </CanvasNodeContext.Provider>
  </PrototypeContext.Provider>;
}
