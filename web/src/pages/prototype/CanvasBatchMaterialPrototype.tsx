import '@xyflow/react/dist/style.css';
import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Handle, Position, ReactFlow, useNodesState, type Edge, type Node as FlowNode, type NodeProps } from '@xyflow/react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronLeft, ChevronRight, Expand, Film, ImagePlus, Images, Layers, Play, Plus, Square, Type, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// Throwaway, in-memory interaction prototype. Never import runtime generation APIs here.
type Material = { id: string; name: string; url?: string; sample?: number };
type Item = { id: string; images: Material[] };
type Target = 'video' | 'text';
type Run = {
  items: Item[];
  rounds: number;
  target: Target;
  prompts: [string, string];
  shared: boolean;
  completedSteps: number;
  status: 'running' | 'stopped' | 'done';
};
type PrototypeNode = FlowNode<{ kind: 'materials' | 'promptA' | 'promptB' | 'image' | 'output' }, 'prototype'>;
const number = (n: number) => String(n).padStart(2, '0');
const sampleMaterial = (n: number): Material => ({ id: crypto.randomUUID(), name: `素材 ${number(n + 1)}`, sample: n });
const sampleItems = (count: number): Item[] => Array.from({ length: count }, (_, i) => ({ id: crypto.randomUUID(), images: [sampleMaterial(i)] }));

function usePrototypeState() {
  const [items, setItems] = useState<Item[]>(() => sampleItems(3));
  const [variant, setVariant] = useState<'A' | 'B'>(() => new URLSearchParams(location.search).get('variant') === 'B' ? 'B' : 'A');
  const [editorOpen, setEditorOpen] = useState(false);
  const [rounds, setRounds] = useState(1);
  const [target, setTarget] = useState<Target>('video');
  const [prompts, setPrompts] = useState<[string, string]>(['保留主体和构图，转换为毛绒玩偶风格，柔和棚拍光。', '让画面中的角色轻轻转头，镜头缓慢推进，保持角色一致。']);
  const [shared, setShared] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);
  const urls = useRef(new Set<string>());
  const locked = run?.status === 'running';

  useEffect(() => {
    const owned = urls.current;
    return () => owned.forEach(url => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => { setRun(null); }, [items, rounds, target, prompts, shared]);

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
      return { ...previous, completedSteps, status: completedSteps >= previous.items.length * previous.rounds * 2 ? 'done' : 'running' };
    }), 650);
    return () => window.clearInterval(timer);
  }, [locked]);

  const changeVariant = (next: 'A' | 'B') => {
    setVariant(next);
    setEditorOpen(false);
    const url = new URL(location.href);
    url.searchParams.set('variant', next);
    history.replaceState(null, '', url);
  };

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (editorOpen || element.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], .react-flow__node')) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        changeVariant(variant === 'A' ? 'B' : 'A');
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [variant, editorOpen]);

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
  const start = () => {
    if (locked || !items.length) return;
    setRun({ items: items.map(item => ({ ...item, images: [...item.images] })), rounds, target, prompts: [...prompts], shared, completedSteps: 0, status: 'running' });
  };
  return { items, setItems, variant, changeVariant, editorOpen, setEditorOpen, rounds, setRounds, target, setTarget, prompts, setPrompts, shared, setShared, run, setRun, locked, notice, fileInput, uploadTarget, receiveFiles, requestFiles, addMaterials, removeMaterial, moveItem, start };
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

function MaterialsNode() {
  const state = usePrototype();
  const total = state.items.reduce((sum, item) => sum + item.images.length, 0);
  return <>
    <div className="mb-3 flex items-center justify-between gap-2"><span className="flex items-center gap-2 font-medium"><Layers size={16} />批量素材</span><span className="text-xs text-primary">{state.items.length} 项 · {total} 张图</span></div>
    {state.variant === 'A' ? <MaterialList /> : <div className="nodrag nowheel nopan space-y-4">
      <div className="flex gap-2 overflow-hidden">{state.items.slice(0, 4).map(item => <Thumbnail key={item.id} material={item.images[0]} />)}{!state.items.length && <p className="text-sm text-muted-foreground">还没有素材</p>}</div>
      <p className="text-xs text-muted-foreground">默认一图一项，需要时单独加参考。</p>
      <Button variant="outline" className="w-full" onClick={() => state.setEditorOpen(true)}><Expand />展开 {state.items.length} 项</Button>
      <FileDrop itemId={null}><Button variant="ghost" className="w-full" disabled={state.locked} onClick={() => state.requestFiles(null)}><Plus />拖入或添加一批图片</Button></FileDrop>
    </div>}
    <Handle type="source" position={Position.Right} id="items" />
  </>;
}

function PromptNode({ index }: { index: 0 | 1 }) {
  const state = usePrototype();
  return <>
    <div className="mb-3 flex items-center gap-2 font-medium"><Type size={16} />共用文本 {index === 0 ? 'A' : 'B'}<span className="ml-auto text-xs font-normal text-muted-foreground">全部项</span></div>
    <textarea aria-label={`共用文本 ${index === 0 ? 'A' : 'B'}`} value={state.prompts[index]} disabled={state.locked} onChange={event => state.setPrompts(current => index === 0 ? [event.target.value, current[1]] : [current[0], event.target.value])} className="nodrag nowheel nopan h-20 w-full resize-none rounded-md bg-background/40 p-2 text-sm leading-relaxed no-scrollbar focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50" />
    <Handle type="source" position={Position.Bottom} />
  </>;
}

function GenerationNode({ output }: { output: boolean }) {
  const state = usePrototype();
  const { run } = state;
  const target = run?.target ?? state.target;
  const completed = run ? Math.min(run.items.length * run.rounds, output ? Math.floor(run.completedSteps / 2) : Math.ceil(run.completedSteps / 2)) : 0;
  const planned = run ? run.items.length * run.rounds : state.items.length * state.rounds;
  return <>
    <Handle type="target" position={Position.Left} id="media" />
    <Handle type="target" position={Position.Top} id="prompt" />
    {!output && <Handle type="source" position={Position.Right} />}
    <div className="mb-3 flex items-center gap-2 font-medium">{output ? target === 'video' ? <Film size={16} /> : <Type size={16} /> : <Images size={16} />}{output ? '后续生成' : '图片生成'}<span className="ml-auto text-xs font-normal text-muted-foreground">{output ? '步骤 02' : '步骤 01'}</span></div>
    <div className="nodrag nowheel nopan space-y-3">
      {output ? <label className="flex items-center justify-between text-sm text-muted-foreground">产物类型<select aria-label="后续产物类型" value={state.target} disabled={state.locked} onChange={event => state.setTarget(event.target.value as Target)} className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"><option value="video">视频</option><option value="text">文本</option></select></label> : <>
        <p className="text-sm text-muted-foreground">每项参考图 + 共用文本 A</p>
        <button disabled={state.locked} onClick={() => state.setShared(!state.shared)} className={cn('flex w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50', state.shared && 'border-primary/50 text-primary')} aria-pressed={state.shared}>{state.shared ? <Check size={14} /> : <Plus size={14} />}{state.shared ? '已加共用参考（示例），每项都使用' : '给所有项加同一张参考（示例）'}</button>
      </>}
      <div className="rounded-md bg-background/50 p-3">
        <p className="text-sm">{output ? '收到每项的图，再自动接着跑' : '每项输出 1 张图'}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{output ? '沿用项号；不会引用其他项的结果。' : '本原型先验证一对一链路，不自动扩散多候选图。'}</p>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{run ? run.status === 'running' ? '模拟进度' : '模拟完成' : '预计产物'}</span><span className={run ? 'text-primary' : ''}>{run ? `${completed} / ${planned}` : planned} {output && target === 'video' ? '段' : output ? '份' : '张'}</span></div>
      <div className="h-1 overflow-hidden rounded-full bg-secondary"><div className="h-full bg-primary transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${planned ? completed / planned * 100 : 0}%` }} /></div>
    </div>
  </>;
}

function PrototypeFlowNode({ data }: NodeProps<PrototypeNode>) {
  return <section className="rounded-lg border border-border bg-card p-4 text-sm text-foreground" style={{ width: data.kind === 'materials' ? 356 : 286 }}>
    {data.kind === 'materials' ? <MaterialsNode /> : data.kind === 'promptA' ? <PromptNode index={0} /> : data.kind === 'promptB' ? <PromptNode index={1} /> : <GenerationNode output={data.kind === 'output'} />}
  </section>;
}

const nodeTypes = { prototype: PrototypeFlowNode };
const initialNodes: PrototypeNode[] = [
  { id: 'materials', type: 'prototype', position: { x: 40, y: 70 }, data: { kind: 'materials' } },
  { id: 'promptA', type: 'prototype', position: { x: 486, y: 35 }, data: { kind: 'promptA' } },
  { id: 'image', type: 'prototype', position: { x: 486, y: 256 }, data: { kind: 'image' } },
  { id: 'promptB', type: 'prototype', position: { x: 872, y: 35 }, data: { kind: 'promptB' } },
  { id: 'output', type: 'prototype', position: { x: 872, y: 256 }, data: { kind: 'output' } },
];
const edges: Edge[] = [
  { id: 'materials-image', source: 'materials', sourceHandle: 'items', target: 'image', targetHandle: 'media' },
  { id: 'text-image', source: 'promptA', target: 'image', targetHandle: 'prompt' },
  { id: 'image-output', source: 'image', target: 'output', targetHandle: 'media' },
  { id: 'text-output', source: 'promptB', target: 'output', targetHandle: 'prompt' },
].map(edge => ({ ...edge, style: { stroke: 'var(--primary)', strokeWidth: 1.5 } }));

function Results() {
  const { run } = usePrototype();
  if (!run) return <div className="px-5 py-5 text-sm text-muted-foreground">点击「模拟执行分组」，在这里查看素材 → 图片 → 视频 / 文本的逐项对应关系。</div>;
  const entries = Array.from({ length: run.rounds }, (_, round) => run.items.map((item, index) => ({ item, round, index }))).flat();
  return <div className="max-h-40 overflow-auto no-scrollbar" aria-label="模拟结果列表">
    <table className="w-full min-w-[650px] text-left text-xs">
      <thead className="sticky top-0 bg-card text-muted-foreground"><tr><th className="px-5 py-2 font-normal">轮 / 项</th><th className="px-3 py-2 font-normal">本次输入</th><th className="px-3 py-2 font-normal">步骤 01 · 图片</th><th className="px-5 py-2 font-normal">步骤 02 · {run.target === 'video' ? '视频' : '文本'}</th></tr></thead>
      <tbody>{entries.map(({ item, round, index }, order) => {
        const imageDone = run.completedSteps > order * 2;
        const outputDone = run.completedSteps > order * 2 + 1;
        const status = (done: boolean, active: boolean) => done ? '模拟完成' : active && run.status === 'running' ? '模拟中…' : run.status === 'stopped' ? '已停止' : '等待';
        return <tr key={`${round}-${item.id}`} className="border-t border-border/60"><td className="whitespace-nowrap px-5 py-3 text-muted-foreground">{number(round + 1)} / {number(index + 1)}</td><td className="px-3 py-3"><div className="flex items-center gap-2"><Thumbnail material={item.images[0]} className="size-8" /><span>{item.images.length} 张{run.shared ? ' + 共用参考' : ''}</span></div></td><td className="px-3 py-3"><span className={imageDone ? 'text-primary' : 'text-muted-foreground'}>{status(imageDone, run.completedSteps === order * 2)}</span></td><td className="px-5 py-3"><div className="flex items-center gap-2"><ArrowRight size={12} className="text-muted-foreground" /><span className={outputDone ? 'text-primary' : 'text-muted-foreground'}>{status(outputDone, run.completedSteps === order * 2 + 1)}</span>{imageDone && <span className="text-muted-foreground">· 使用本项图片</span>}</div></td></tr>;
      })}</tbody>
    </table>
  </div>;
}

export default function CanvasBatchMaterialPrototype() {
  const state = usePrototypeState();
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [resultsOpen, setResultsOpen] = useState(false);
  const totalTasks = state.items.length * state.rounds;
  return <PrototypeContext.Provider value={state}>
    <style>{`.prototype-icon { display:flex; align-items:center; justify-content:center; cursor:pointer; color:var(--muted-foreground); transition:color .15s,background-color .15s; } .prototype-icon:hover { color:var(--foreground); background:var(--secondary); } .prototype-icon:focus-visible { outline:2px solid var(--primary); outline-offset:2px; } .prototype-icon:disabled { opacity:.3; pointer-events:none; } .batch-prototype .react-flow__handle { width:8px; height:8px; background:var(--primary); border:2px solid var(--card); } .batch-prototype .react-flow__attribution { background:var(--card); color:var(--muted-foreground); }`}</style>
    <div className="batch-prototype flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-3"><a href="/canvas" className="prototype-icon size-9 rounded-full border border-border" aria-label="返回正式画布"><ArrowLeft size={16} /></a><div><h1 className="text-base font-medium">批量素材 · 画布原型</h1><p className="mt-1 text-xs text-muted-foreground">仅内存演示，不上传、不保存、不调用模型。</p></div></div>
        <div className="flex items-center gap-2"><Button variant="ghost" size="sm" disabled={state.locked} onClick={() => state.setItems(current => [...current, ...sampleItems(20)])}>追加 20 项示例</Button><Button variant="outline" size="sm" disabled={state.locked} onClick={() => { state.setItems(sampleItems(3)); state.setRun(null); }}>重置示例</Button></div>
      </header>
      <div className="mx-4 mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-glass px-4 py-3 backdrop-blur-glass">
        <div><div className="flex items-center gap-2 text-sm font-medium"><Layers size={16} />示例分组<span className="font-normal text-muted-foreground">素材 → 图片 → {state.target === 'video' ? '视频' : '文本'}</span></div><p className="mt-1 text-xs text-muted-foreground">{state.items.length} 项 × {state.rounds} 轮 = {totalTasks} 条链路 · 共 {totalTasks * 2} 次模拟生成</p></div>
        <div className="flex items-center gap-3"><label className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">重复<Input aria-label="重复轮数" type="number" min={1} max={20} step={1} value={state.rounds} disabled={state.locked} onChange={event => state.setRounds(Math.max(1, Math.min(20, Math.trunc(Number(event.target.value) || 1))))} className="w-14 text-center text-foreground" />轮</label>{state.locked ? <Button variant="outline" onClick={() => state.setRun(current => current ? { ...current, status: 'stopped' } : current)}><Square />停止模拟</Button> : <Button disabled={!state.items.length} onClick={state.start}><Play />模拟执行分组</Button>}</div>
      </div>
      <div className="relative min-h-64 flex-1">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} nodesConnectable={false} edgesFocusable={false} deleteKeyCode={null} fitView fitViewOptions={{ padding: .1, maxZoom: 1 }} minZoom={.3} maxZoom={1.5} colorMode="dark" aria-label="批量素材工作流原型" />
        <div className="pointer-events-none absolute bottom-2 left-5 right-5 flex justify-between gap-4 text-xs text-muted-foreground"><span>拖动标题移动节点 · 滚轮缩放</span><span className="max-w-[55%] text-right" role="status">{state.locked ? '正在模拟；素材和参数已锁定。' : state.run?.status === 'done' ? '模拟已完成，没有产生真实图像或费用。' : state.run?.status === 'stopped' ? '已停止，保留已完成的模拟结果。' : state.notice}</span></div>
      </div>
      <section className="mx-4 mb-16 shrink-0 overflow-hidden rounded-xl border border-border bg-card">
        <button className="flex w-full items-center justify-between gap-2 px-5 py-3 text-sm transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary" aria-expanded={resultsOpen} onClick={() => setResultsOpen(!resultsOpen)}><span className="flex items-center gap-2"><Images size={16} />模拟结果<span className="text-xs text-muted-foreground">{state.run ? `${Math.floor(state.run.completedSteps / 2)} / ${state.run.items.length * state.run.rounds} 项完成${state.run.status === 'stopped' ? ' · 已停止' : ''}` : '尚未执行'}</span></span>{resultsOpen ? <ArrowDown size={14} /> : <ArrowUp size={14} />}</button>
        {resultsOpen && <Results />}
      </section>
      <div className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 whitespace-nowrap rounded-full border border-border bg-glass px-2 py-1.5 text-xs backdrop-blur-glass" aria-label="原型方案切换"><button className="prototype-icon size-8 rounded-full" aria-label="上一个原型方案" onClick={() => state.changeVariant(state.variant === 'A' ? 'B' : 'A')}><ChevronLeft size={16} /></button><span>{state.variant} / 2 · {state.variant === 'A' ? '节点内直接编辑' : '紧凑节点，展开编辑'}</span><button className="prototype-icon size-8 rounded-full" aria-label="下一个原型方案" onClick={() => state.changeVariant(state.variant === 'A' ? 'B' : 'A')}><ChevronRight size={16} /></button></div>
      <Dialog open={state.editorOpen} onOpenChange={state.setEditorOpen}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>批量素材 · {state.items.length} 项</DialogTitle><DialogDescription>调整只影响这份演示，不会改动资产库。</DialogDescription></DialogHeader><MaterialList /><Button variant="outline" onClick={() => state.setEditorOpen(false)}>完成</Button></DialogContent></Dialog>
      <input ref={state.fileInput} type="file" accept="image/*" multiple className="hidden" aria-label="选择本地素材图片" onChange={event => { state.receiveFiles(Array.from(event.target.files ?? []), state.uploadTarget.current); event.target.value = ''; }} />
    </div>
  </PrototypeContext.Provider>;
}
