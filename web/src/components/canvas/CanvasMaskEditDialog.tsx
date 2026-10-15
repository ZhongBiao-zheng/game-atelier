import { Eraser, Hand, LoaderCircle, Paintbrush, Redo2, RotateCcw, Scan, Sparkles, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { getCanvasImageEditSource, type CanvasImageEditOptions, type CanvasImageEditSource } from '@/api/canvas';
import type { KeyView } from '@/api/keys';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { imageControlCaps } from '@/lib/imageControlCaps';
import { estimateGenerationCostForSubmission } from '@/lib/generationCost';
import type { CanvasGenerationDraft, CanvasMediaVersion } from '@/schema/canvas';
import { drawEditStrokes, editSize, isEditModel, type EditFrame, type EditPoint, type EditStroke, type EditTool } from './imageEditGeometry';
import { useRegionalEditPlan } from './useRegionalEditPlan';
import { RegionalEditControls } from './RegionalEditControls';

export interface CanvasMaskEditSubmission {
  mask: Blob;
  draft: CanvasGenerationDraft;
  requestedCount: number;
  options: CanvasImageEditOptions;
}

type Props = {
  open: boolean; title: string; version: CanvasMediaVersion; mediaUrl: string; keys: KeyView[];
  projectId?: string; nodeId?: string; initialMode?: 'inpaint' | 'outpaint';
  references?: Array<{ id: string; title: string }>;
  initialDraft: CanvasGenerationDraft | null; busy: boolean; error: string | null;
  onOpenChange: (open: boolean) => void; onSubmit: (submission: CanvasMaskEditSubmission) => void;
};

export function CanvasMaskEditDialog({ open, title, version, mediaUrl, keys, projectId, nodeId,
  initialMode = 'inpaint', references = [], initialDraft, busy, error, onOpenChange, onSubmit }: Props) {
  const [mode, setMode] = useState(initialMode);
  const [native, setNative] = useState(false);
  const [source, setSource] = useState<CanvasImageEditSource | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [dimensions, setDimensions] = useState({ width: version.width || 1, height: version.height || 1 });
  const [frame, setFrame] = useState<EditFrame>({ width: Math.round((version.width || 1) * 1.5), height: Math.round((version.height || 1) * 1.5), x: Math.round((version.width || 1) / 4), y: Math.round((version.height || 1) / 4) });
  const [tool, setTool] = useState<EditTool>('brush');
  const [brushSize, setBrushSize] = useState(40);
  const [strokes, setStrokes] = useState<EditStroke[]>([]);
  const [redoStrokes, setRedoStrokes] = useState<EditStroke[][]>([]);
  const undoStates = useRef<EditStroke[][]>([]);
  const activeStroke = useRef<EditStroke | null>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const stageObserver = useRef<ResizeObserver | null>(null);
  const [stageSize, setStageSize] = useState({ width: 640, height: 400 });
  const measureStage = useCallback((element: HTMLDivElement | null) => {
    stageObserver.current?.disconnect();
    if (!element) return;
    stageObserver.current = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect?.width && rect.height) setStageSize({ width: rect.width, height: rect.height });
    });
    stageObserver.current.observe(element);
  }, []);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ point: EditPoint; frame: EditFrame; pan: EditPoint; kind: string; scale: number } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [reference, setReference] = useState('');
  const [quality, setQuality] = useState('auto');
  const [count, setCount] = useState(1);
  const [actionId, setActionId] = useState('');
  const [nativeZoom, setNativeZoom] = useState(1.5);
  const [frameRatio, setFrameRatio] = useState('');
  const [context, setContext] = useState(.25);
  const [feather, setFeather] = useState<number | null>(null);
  const [groups, setGroups] = useState<number[][] | null>(null);
  const [regionPrompts, setRegionPrompts] = useState<Record<string, string>>({});
  const [activeRegion, setActiveRegion] = useState('');
  const availableKeys = useMemo(() => keys.filter(key => key.models.some(model => isEditModel(model, key))), [keys]);
  const firstKey = availableKeys.find(key => key.alias === initialDraft?.alias) ?? availableKeys[0];
  const [alias, setAlias] = useState(firstKey?.alias ?? '');
  const [model, setModel] = useState(firstKey?.models.find(model => model.id === initialDraft?.model && isEditModel(model, firstKey))?.id ?? firstKey?.models.find(model => isEditModel(model, firstKey))?.id ?? '');
  const selectedKey = availableKeys.find(key => key.alias === alias);
  const caps = imageControlCaps(model, selectedKey?.provider, selectedKey?.base_url);
  const expanded = mode === 'outpaint' && !native;
  const regional = mode === 'inpaint' && !native;
  const planned = useRegionalEditPlan({ enabled: open && ready && regional, projectId, nodeId,
    versionId: version.version_id, alias, model, ...dimensions, strokes, context, feather, groups });
  const regions = planned.plan?.regions ?? [];
  const active = regions.find(region => region.id === activeRegion) ?? regions[0];
  const target = expanded ? frame : dimensions;
  const scale = Math.min((stageSize.width - 48) / Math.max(1, target.width), (stageSize.height - 48) / Math.max(1, target.height)) * zoom;
  const size = editSize(selectedKey, model, target.width, target.height);
  const invalidFrame = expanded && (frame.width < dimensions.width || frame.height < dimensions.height || frame.x < 0 || frame.y < 0 || frame.x + dimensions.width > frame.width || frame.y + dimensions.height > frame.height || (frame.width === dimensions.width && frame.height === dimensions.height));
  const actions = source?.mj?.actions.filter(action => action.kind === mode || action.kind === 'prepare') ?? [];
  const action = actions.find(action => action.custom_id === actionId) ?? actions[0];
  const preparing = native && action?.kind === 'prepare';
  const needsMask = mode === 'inpaint' && !preparing;
  const validation = native ? (!action ? '这个原任务没有可用动作' : null) : regional ? planned.error ?? (!selectedKey || !model ? '请选择编辑模型' : null) : invalidFrame ? '画框必须向外扩展并完整包含原图' : size.error;
  const effectiveQuality = caps.qualities?.includes(quality as never) ? quality : caps.qualities?.[0];
  const costs = (regional ? regions.map(region => region.params) : [size.params]).map(params =>
    estimateGenerationCostForSubmission(selectedKey, model, 'image', { ...params, n: count, quality: effectiveQuality }));
  const estimatedCost = native || !costs.length || costs.some(cost => cost == null) ? null : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);

  useEffect(() => { if (open) setMode(initialMode); }, [open, initialMode]);
  useEffect(() => {
    if (!projectId || !nodeId || !open) return;
    let current = true;
    getCanvasImageEditSource(projectId, nodeId).then(value => {
      if (current && value.source_version_id === version.version_id) { setSource(value); setSourceError(value.reason); }
    }).catch(() => { if (current) setSourceError('暂时无法读取 MJ 动作，可继续使用通用模型'); });
    return () => { current = false; };
  }, [projectId, nodeId, version.version_id, open]);
  useEffect(() => { if (overlay.current && ready) drawEditStrokes(overlay.current, strokes); }, [strokes, ready, open]);

  function initialize(image: HTMLImageElement) {
    if (!image.naturalWidth || !image.naturalHeight) return;
    setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
    if (overlay.current) { overlay.current.width = image.naturalWidth; overlay.current.height = image.naturalHeight; drawEditStrokes(overlay.current, strokes); }
    setReady(true);
  }
  function point(event: ReactPointerEvent) {
    const rect = overlay.current!.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / (rect.width || 1) * dimensions.width, y: (event.clientY - rect.top) / (rect.height || 1) * dimensions.height };
  }
  function startDrag(event: ReactPointerEvent, kind: string) {
    if (busy) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { point: { x: event.clientX, y: event.clientY }, frame, pan, kind, scale };
  }
  function moveDrag(event: ReactPointerEvent) {
    const current = drag.current;
    if (!current) return;
    const dx = (event.clientX - current.point.x) / current.scale;
    const dy = (event.clientY - current.point.y) / current.scale;
    if (current.kind === 'pan') { setPan({ x: current.pan.x + dx * current.scale, y: current.pan.y + dy * current.scale }); return; }
    const next = { ...current.frame };
    if (current.kind === 'image') {
      next.x = Math.round(Math.max(0, Math.min(next.width - dimensions.width, next.x + dx)));
      next.y = Math.round(Math.max(0, Math.min(next.height - dimensions.height, next.y + dy)));
    } else {
      if (current.kind.includes('e')) next.width = Math.round(Math.max(next.x + dimensions.width, next.width + dx));
      if (current.kind.includes('s')) next.height = Math.round(Math.max(next.y + dimensions.height, next.height + dy));
      if (current.kind.includes('w')) { const delta = Math.round(Math.max(-next.x, -dx)); next.width += delta; next.x += delta; }
      if (current.kind.includes('n')) { const delta = Math.round(Math.max(-next.y, -dy)); next.height += delta; next.y += delta; }
    }
    setFrame(next);
    if (current.kind !== 'image') setFrameRatio('');
  }
  function endDrag() { drag.current = null; }
  function startStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (tool === 'hand' || event.button === 1) { startDrag(event, 'pan'); return; }
    if (busy || !ready || !needsMask) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = point(event);
    activeStroke.current = { tool, size: brushSize / scale, points: [p, { x: p.x + .01, y: p.y + .01 }] };
    drawEditStrokes(event.currentTarget, [...strokes, activeStroke.current]);
  }
  function moveStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (drag.current) { moveDrag(event); return; }
    const stroke = activeStroke.current;
    if (!stroke) return;
    const p = point(event);
    if (stroke.tool === 'rectangle') stroke.points[1] = p; else stroke.points.push(p);
    drawEditStrokes(event.currentTarget, [...strokes, stroke]);
  }
  function changeStrokes(next: EditStroke[]) {
    undoStates.current.push(strokes); setRedoStrokes([]); setStrokes(next); setLocalError(null);
    resetRegions();
  }
  function resetRegions() {
    setGroups(null); setRegionPrompts({}); setActiveRegion('');
  }
  function changeGroups(next: number[][] | null) {
    // Preserve explicit instructions through manual merge/split rather than silently discarding them.
    const prompts: Record<string, string> = {};
    for (const ids of next ?? []) {
      const texts = regions.filter(region => region.components.some(id => ids.includes(id)))
        .map(region => regionPrompts[region.id]?.trim()).filter(Boolean);
      if (texts.length) prompts[[...ids].sort((a, b) => a - b).join('-')] = [...new Set(texts)].join('\n');
    }
    setRegionPrompts(prompts); setGroups(next); setActiveRegion('');
  }
  function endStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (activeStroke.current) { changeStrokes([...strokes, activeStroke.current]); activeStroke.current = null; }
    endDrag();
  }
  function resize(width: number, height: number) {
    setFrameRatio('');
    setFrame({ width, height, x: Math.max(0, Math.round((width - dimensions.width) / 2)), y: Math.max(0, Math.round((height - dimensions.height) / 2)) });
  }
  async function submit() {
    if (!ready || busy || validation || (needsMask && !strokes.length) || (regional && !planned.plan)) return;
    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width; canvas.height = dimensions.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (needsMask && overlay.current) {
      const pixels = overlay.current.getContext('2d')?.getImageData(0, 0, dimensions.width, dimensions.height).data;
      if (!pixels?.some((v, i) => i % 4 === 3 && v > 0)) { setLocalError('请先选择需要修改的区域'); return; }
    }
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (needsMask && overlay.current) { ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(overlay.current, 0, 0); }
    const mask = regional ? planned.mask : await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!mask) { setLocalError('无法读取选区，请重新打开编辑器'); return; }
    const requestedCount = native ? preparing ? 1 : 4 : count;
    const options: CanvasImageEditOptions = { mode: preparing ? 'prepare' : mode, source_version_id: version.version_id, ...(expanded ? frame : {}), ...(reference && !native && !expanded ? { reference_node_id: reference } : {}), ...(native && action ? { custom_id: action.custom_id, zoom: nativeZoom } : {}), ...(regional ? { context, feather, groups, region_prompts: regionPrompts, plan_id: planned.plan!.plan_id } : {}) };
    onSubmit({ mask, requestedCount, options, draft: {
      mode: 'image', prompt: prompt.trim(), input_policy: 'all_connected',
      alias: native ? source!.mj!.alias : alias, model: native ? source!.mj!.model : model,
      params: native ? { n: requestedCount } : { ...(regional ? regions[0].params : size.params), n: count, ...(caps.qualities ? { quality: caps.qualities.includes(quality as never) ? quality : caps.qualities[0] } : {}) },
      updated_at: new Date().toISOString(),
    } });
  }

  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
    <DialogContent className="flex max-h-[94dvh] max-w-6xl flex-col overflow-y-auto">
      <DialogHeader><DialogTitle>编辑图片 · {title}</DialogTitle><DialogDescription className="sr-only">选择区域或扩大画框，生成新的图片节点。</DialogDescription></DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" aria-pressed={mode === 'inpaint'} variant={mode === 'inpaint' ? 'secondary' : 'ghost'} onClick={() => setMode('inpaint')}>局部修改</Button>
        <Button size="sm" aria-pressed={mode === 'outpaint'} variant={mode === 'outpaint' ? 'secondary' : 'ghost'} onClick={() => setMode('outpaint')}>扩图</Button>
        {source?.mj && <select aria-label="编辑方式" className="canvas-input ml-auto w-auto" value={native ? 'mj' : 'common'} onChange={event => { setNative(event.target.value === 'mj'); setActionId(''); }}><option value="common">通用模型</option><option value="mj">MJ 原生</option></select>}
      </div>
      <div className="grid shrink-0 gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0 space-y-3">
          <div ref={measureStage} className="relative h-[48dvh] min-h-64 touch-none overflow-hidden rounded-lg border border-border bg-background"
            onPointerDown={event => { if (tool === 'hand' || event.target === event.currentTarget) startDrag(event, 'pan'); }} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
            <div className="absolute border border-primary" style={{ width: target.width * scale, height: target.height * scale, left: (stageSize.width - target.width * scale) / 2 + pan.x, top: (stageSize.height - target.height * scale) / 2 + pan.y }}>
              {expanded && [
                [0, 0, frame.width, frame.y],
                [0, frame.y + dimensions.height, frame.width, frame.height - frame.y - dimensions.height],
                [0, frame.y, frame.x, dimensions.height],
                [frame.x + dimensions.width, frame.y, frame.width - frame.x - dimensions.width, dimensions.height],
              ].map(([x, y, width, height], index) => <div key={index} className="pointer-events-none absolute bg-primary/15" style={{ left: x * scale, top: y * scale, width: Math.max(0, width) * scale, height: Math.max(0, height) * scale }} />)}
              <div className={`absolute ${expanded ? 'outline outline-1 outline-border' : 'overflow-hidden'}`} style={{ width: dimensions.width * scale, height: dimensions.height * scale, left: expanded ? frame.x * scale : 0, top: expanded ? frame.y * scale : 0 }}>
                <img src={mediaUrl} alt={title} draggable={false} className={`block size-full select-none ${expanded ? 'cursor-move' : ''}`} onLoad={event => initialize(event.currentTarget)} onError={() => { setReady(false); setLocalError('源图片加载失败'); }} onPointerDown={event => { if (expanded) startDrag(event, 'image'); }} />
                {regional && regions.map(region => <img key={region.id} src={region.preview} alt="" aria-hidden draggable={false}
                  className="pointer-events-none absolute" style={{ left: region.crop[0] * scale, top: region.crop[1] * scale, width: region.crop[2] * scale, height: region.crop[3] * scale }} />)}
                {regional && active && <div aria-label="上下文裁片" className="pointer-events-none absolute border border-primary"
                  style={{ left: active.crop[0] * scale, top: active.crop[1] * scale, width: active.crop[2] * scale, height: active.crop[3] * scale }} />}
                <canvas ref={overlay} width={dimensions.width} height={dimensions.height} aria-label="蒙版绘制区域" className={`absolute inset-0 size-full touch-none opacity-60 ${needsMask ? 'cursor-crosshair' : 'pointer-events-none invisible'}`} onPointerDown={startStroke} onPointerMove={moveStroke} onPointerUp={endStroke} onPointerCancel={endStroke} />
                {regional && regions.map((region, index) => <button key={region.id} type="button" aria-label={`查看区域 ${index + 1}`} aria-pressed={active?.id === region.id}
                  className="absolute size-6 rounded-full border border-border bg-card text-xs focus-visible:ring-1 focus-visible:ring-ring"
                  style={{ left: Math.max(0, Math.min(dimensions.width * scale - 24, region.bounds[0] * scale)), top: Math.max(0, region.bounds[1] * scale - 24) }}
                  onPointerDown={event => event.stopPropagation()} onClick={() => setActiveRegion(region.id)}>{index + 1}</button>)}
              </div>
              {expanded && ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(direction => <button key={direction} type="button" aria-label={`扩展画框 ${direction}`} className="absolute size-3 border border-primary bg-background" style={{ left: direction.includes('w') ? 0 : direction.includes('e') ? '100%' : '50%', top: direction.includes('n') ? 0 : direction.includes('s') ? '100%' : '50%', transform: 'translate(-50%, -50%)', cursor: `${direction}-resize` }} onPointerDown={event => startDrag(event, direction)} onKeyDown={event => {
                if (event.key === 'ArrowRight') resize(frame.width + 16, frame.height);
                if (event.key === 'ArrowDown') resize(frame.width, frame.height + 16);
              }} />)}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {needsMask && <>
              {([{ id: 'brush', title: '涂抹', icon: Paintbrush }, { id: 'eraser', title: '擦除', icon: Eraser }, { id: 'rectangle', title: '矩形', icon: Scan }] as const).map(item => <Button key={item.id} size="sm" variant={tool === item.id ? 'secondary' : 'ghost'} onClick={() => setTool(item.id)}><item.icon />{item.title}</Button>)}
              <input aria-label="笔刷大小" className="w-20 accent-primary" type="range" min={4} max={180} value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} />
              <Button size="icon" variant="ghost" aria-label="撤销选区" disabled={!undoStates.current.length} onClick={() => { const last = undoStates.current.pop(); if (last) { setRedoStrokes([...redoStrokes, strokes]); setStrokes(last); resetRegions(); } }}><Undo2 /></Button>
              <Button size="icon" variant="ghost" aria-label="重做选区" disabled={!redoStrokes.length} onClick={() => { const last = redoStrokes.at(-1); if (last) { undoStates.current.push(strokes); setStrokes(last); setRedoStrokes(redoStrokes.slice(0, -1)); resetRegions(); } }}><Redo2 /></Button>
              <Button size="sm" variant="ghost" onClick={() => changeStrokes([])}>清空</Button>
            </>}
            <Button size="icon" variant={tool === 'hand' ? 'secondary' : 'ghost'} aria-label="平移" onClick={() => setTool('hand')}><Hand /></Button>
            <input aria-label="编辑视图缩放" className="ml-auto w-24 accent-primary" type="range" min={.5} max={4} step={.1} value={zoom} onChange={event => setZoom(Number(event.target.value))} />
            <Button size="icon" variant="ghost" aria-label="适应窗口" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><RotateCcw /></Button>
          </div>
        </div>
        <div className="space-y-3">
          {expanded && <>
            <select aria-label="扩图比例" className="canvas-input" value={frameRatio} onChange={event => {
              if (!event.target.value) return;
              const [a, b] = event.target.value.split(':').map(Number);
              const width = Math.max(dimensions.width, dimensions.height * a / b);
              resize(Math.ceil(width), Math.ceil(width * b / a));
              setFrameRatio(event.target.value);
            }}><option value="">自定义画框</option>{['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9'].map(r => <option key={r}>{r}</option>)}</select>
            <div className="grid grid-cols-2 gap-2"><label className="text-xs text-muted-foreground">宽<input aria-label="目标宽度" type="number" className="canvas-input" value={frame.width} onChange={event => resize(Number(event.target.value), frame.height)} /></label><label className="text-xs text-muted-foreground">高<input aria-label="目标高度" type="number" className="canvas-input" value={frame.height} onChange={event => resize(frame.width, Number(event.target.value))} /></label></div>
          </>}
          {native ? <>
            <select aria-label="MJ 动作" className="canvas-input" value={action?.custom_id ?? ''} onChange={event => setActionId(event.target.value)}>{actions.map(item => <option key={item.custom_id} value={item.custom_id}>{item.label}</option>)}</select>
            {action?.custom_id.toLowerCase().includes('custom_zoom') && <label className="text-xs">拉远倍数<input aria-label="MJ 拉远倍数" className="canvas-input" type="number" min={1} max={2} step={.1} value={nativeZoom} onChange={event => setNativeZoom(Number(event.target.value))} /></label>}
            <p className="text-xs text-muted-foreground">{preparing ? '先生成单图，再打开编辑。此操作可能单独计费。' : 'MJ 决定最终尺寸，不保证原图像素不变。'}</p>
          </> : <>
            <select aria-label="编辑密钥" className="canvas-input" value={alias} onChange={event => { const key = availableKeys.find(k => k.alias === event.target.value); setAlias(event.target.value); setModel(key?.models.find(m => isEditModel(m, key))?.id ?? ''); }}><option value="">选择密钥</option>{availableKeys.map(key => <option key={key.alias}>{key.alias}</option>)}</select>
            <select aria-label="编辑模型" className="canvas-input" value={model} onChange={event => setModel(event.target.value)}><option value="">选择模型</option>{selectedKey?.models.filter(m => isEditModel(m, selectedKey)).map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}</select>
            <div className="flex gap-2">{caps.qualities && <select aria-label="编辑质量" className="canvas-input" value={caps.qualities.includes(quality as never) ? quality : caps.qualities[0]} onChange={event => setQuality(event.target.value)}>{caps.qualities.map(q => <option key={q} value={q}>{({ auto: '自动', low: '低', medium: '中', high: '高' })[q]}</option>)}</select>}<select aria-label="候选数" className="canvas-input" value={count} onChange={event => setCount(Number(event.target.value))}>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} 张</option>)}</select></div>
            {!expanded && references.length > 0 && <select aria-label="替换参考素材" className="canvas-input" value={reference} onChange={event => setReference(event.target.value)}><option value="">替换参考素材（可选）</option>{references.map(ref => <option key={ref.id} value={ref.id}>{ref.title}</option>)}</select>}
            <p className="text-xs text-muted-foreground" aria-label="编辑输出尺寸">{target.width} × {target.height} · {expanded ? '保护原图' : '融合范围外不变'}</p>
          </>}
          <textarea aria-label="编辑提示词" className="canvas-input min-h-28 resize-y" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={mode === 'outpaint' ? '留空自然延展；或描述新增画面' : '留空自然修复；或描述修改内容'} />
          {regional && regions.length > 0 && <RegionalEditControls regions={regions} activeId={active?.id ?? ''} onActive={setActiveRegion}
            context={context} feather={feather} onContext={setContext} onFeather={setFeather}
            prompts={regionPrompts} defaultPrompt={prompt} onPrompt={(id, text) => setRegionPrompts({ ...regionPrompts, [id]: text })} onGroups={changeGroups} />}
          {(error || localError || validation) && <p role="alert" className="text-xs text-destructive">{error || localError || validation}</p>}
          {sourceError && <p className="text-xs text-muted-foreground">{sourceError}</p>}
        </div>
      </div>
      <DialogFooter><span role="status" className="mr-auto self-center text-xs text-muted-foreground">{regional && (planned.planning ? '规划中…' : regions.length ? `${regions.reduce((sum, r) => sum + r.components.length, 0)} 个选区 · ${regions.length} 区 · ${regions.length * count} 次生成 · ` : '涂抹需要修改的位置 · ')}{!planned.planning && (estimatedCost == null ? '费用以供应商结算为准' : `预计 ¥${Number(estimatedCost.toFixed(4))}`)}</span><Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>关闭</Button><Button disabled={busy || !ready || !!validation || (needsMask && !strokes.length) || (regional && !planned.plan)} onClick={() => void submit()}>{busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}{busy ? '提交中…' : preparing ? '准备单图' : '生成'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
