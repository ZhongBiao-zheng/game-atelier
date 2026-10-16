import { ChevronDown, Eraser, Paintbrush, Redo2, Sparkles, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { estimateGenerationCostForSubmission } from '@/lib/generationCost';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { imageControlCaps, MJ_IMAGES_PER_TASK } from '@/lib/imageControlCaps';
import { drawEditStrokes, editMaskBlob, editModelChoices, editSize, type EditPoint, type EditStroke } from './imageEditGeometry';
import { EditorComposer, ImageEditorShell, editorChip, editorIconButton, isTypingTarget, useEditorViewport,
  type CanvasMaskEditSubmission, type ImageEditorProps } from './ImageEditorShell';

type BrushTool = 'brush' | 'eraser';
const BRUSH_MIN = 8;
const BRUSH_MAX = 200;
const choiceId = (alias: string, model: string) => `${alias}\u0000${model}`;

/** 同一选区编辑器，按模型分流常规蒙版编辑与 MJ 原生重绘。 */
export function CanvasInpaintEditor({ open, title, version, mediaUrl, keys, initialData, busy: parentBusy, error,
  onOpenChange, onSave, onSubmit }: ImageEditorProps) {
  const initialDraft = initialData?.generation_draft ?? null;
  const [serializing, setSerializing] = useState(false);
  const busy = parentBusy || serializing;
  const [ready, setReady] = useState(false);
  const [dimensions, setDimensions] = useState({ width: version.width || 1, height: version.height || 1 });
  const [tool, setTool] = useState<BrushTool>('brush');
  const [spacePan, setSpacePan] = useState(false);
  const [brushSize, setBrushSize] = useState(64);
  const [strokes, setStrokes] = useState<EditStroke[]>(initialData?.editor_state.strokes ?? []);
  const undoStack = useRef<EditStroke[][]>([]);
  const [redoStack, setRedoStack] = useState<EditStroke[][]>([]);
  const activeStroke = useRef<EditStroke | null>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [cursor, setCursor] = useState<EditPoint | null>(null);
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? '');
  const [localError, setLocalError] = useState<string | null>(null);
  const choices = useMemo(() => editModelChoices(keys), [keys]);
  const [selected, setSelected] = useState(() => {
    const saved = choices.find(item => item.key.alias === initialDraft?.alias && item.model === initialDraft?.model);
    // A missing saved model requires an explicit choice, never a silent channel switch.
    return saved ? choiceId(saved.key.alias, saved.model) : initialDraft?.model ? ''
      : choices[0] ? choiceId(choices[0].key.alias, choices[0].model) : '';
  });
  const choice = choices.find(item => choiceId(item.key.alias, item.model) === selected);
  const mj = Boolean(choice?.mj);
  const [count, setCount] = useState(() => initialDraft?.model === 'mj-v8.2' ? 1
    : Math.min(4, Math.max(1, initialDraft?.params.n ?? 1)));
  const candidates = mj ? MJ_IMAGES_PER_TASK : count;
  const caps = imageControlCaps(choice?.model ?? '', choice?.key.provider, choice?.key.base_url);
  const savedQuality = choice?.key.alias === initialDraft?.alias && choice?.model === initialDraft?.model
    ? initialDraft?.params.quality : undefined;
  const quality = caps.qualities?.includes(savedQuality as never) ? savedQuality
    : caps.qualities?.includes('low' as never) ? 'low' : caps.qualities?.[0];
  const size = editSize(choice?.key, choice?.model ?? '', dimensions.width, dimensions.height);
  const params = mj ? { n: MJ_IMAGES_PER_TASK }
    : { ...size.params, n: count, ...(quality ? { quality } : {}) };
  const viewport = useEditorViewport(dimensions);
  const { scale, origin } = viewport;
  const fingerprint = JSON.stringify({ strokes, prompt, selected, count });
  const savedFingerprint = useRef(fingerprint);
  const cost = estimateGenerationCostForSubmission(choice?.key, choice?.model ?? '', 'image',
    { ...params, ...(mj ? { image_edit: { mode: 'inpaint' } } : {}) });
  const blocker = !choice ? '请选择可用的编辑模型' : !ready ? '图片加载中' : initialData?.active_run_id ? '正在生成'
    : size.error ? size.error : !strokes.length ? '先涂抹要修改的区域' : mj && !prompt.trim() ? '写下要改成什么' : null;

  useEffect(() => { if (overlay.current && ready) drawEditStrokes(overlay.current, strokes); }, [strokes, ready]);

  function initialize(image: HTMLImageElement) {
    if (!image.naturalWidth || !image.naturalHeight) return;
    setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
    if (overlay.current) {
      overlay.current.width = image.naturalWidth; overlay.current.height = image.naturalHeight;
      drawEditStrokes(overlay.current, strokes);
    }
    setReady(true);
  }
  function imagePoint(event: ReactPointerEvent<HTMLCanvasElement>): EditPoint {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / (rect.width || 1) * dimensions.width,
      y: (event.clientY - rect.top) / (rect.height || 1) * dimensions.height };
  }
  function commit(next: EditStroke[]) {
    undoStack.current.push(strokes); setRedoStack([]); setStrokes(next); setLocalError(null);
  }
  function undo() {
    const last = undoStack.current.pop();
    if (last) { setRedoStack([...redoStack, strokes]); setStrokes(last); }
  }
  function redo() {
    const last = redoStack.at(-1);
    if (last) { undoStack.current.push(strokes); setStrokes(last); setRedoStack(redoStack.slice(0, -1)); }
  }
  function startStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (spacePan || event.button === 1) { viewport.startPan(event); return; }
    if (busy || !ready || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = imagePoint(event);
    activeStroke.current = { tool, size: brushSize / scale, points: [point, { x: point.x + .01, y: point.y + .01 }] };
    drawEditStrokes(event.currentTarget, [...strokes, activeStroke.current]);
  }
  function moveStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (viewport.movePan(event)) return;
    const point = imagePoint(event);
    setCursor({ x: point.x * scale, y: point.y * scale });
    const stroke = activeStroke.current;
    if (!stroke) return;
    stroke.points.push(point);
    drawEditStrokes(event.currentTarget, [...strokes, stroke]);
  }
  function endStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (activeStroke.current) { commit([...strokes, activeStroke.current]); activeStroke.current = null; }
    viewport.endPan();
  }
  function handleKey(event: KeyboardEvent) {
    if (isTypingTarget(event.target)) return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === ' ') { event.preventDefault(); setSpacePan(true); }
    else if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (mod) return;
    else if (event.key === 'b' || event.key === 'B') setTool('brush');
    else if (event.key === 'e' || event.key === 'E') setTool('eraser');
    else if (event.key === '[') setBrushSize(size => Math.max(BRUSH_MIN, size - 8));
    else if (event.key === ']') setBrushSize(size => Math.min(BRUSH_MAX, size + 8));
  }

  async function submit(generate: boolean) {
    if (busy || (generate && blocker)) return;
    setSerializing(true); setLocalError(null);
    try {
      let mask: Blob | null = null;
      if (strokes.length) {
        try { mask = await editMaskBlob(dimensions.width, dimensions.height, strokes); }
        catch (error) { if (generate) throw error; }
      }
      const submission: CanvasMaskEditSubmission = {
        mask, requestedCount: candidates, options: { mode: 'inpaint' },
        editorState: { strokes, frame: { ...dimensions, x: 0, y: 0 }, frame_ratio: '' },
        referenceNodeId: mj ? null : initialData?.reference_node_id ?? null,
        referenceVersionId: mj ? null : initialData?.reference_version_id ?? null,
        draft: { mode: 'image', prompt: prompt.trim(), input_policy: 'all_connected', alias: choice?.key.alias ?? '',
          model: choice?.model ?? '', params, updated_at: new Date().toISOString() },
      };
      if (await (generate ? onSubmit(submission) : onSave(submission))) savedFingerprint.current = fingerprint;
    } catch (error) {
      setLocalError((error as Error).message);
    } finally { setSerializing(false); }
  }

  const toolButton = (id: BrushTool, label: string, key: string, Icon: typeof Paintbrush) => (
    <button type="button" aria-pressed={tool === id} onClick={() => setTool(id)}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${tool === id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
      <Icon className="size-4" aria-hidden />{label}<span className="hidden font-mono text-xs text-muted-foreground/80 lg:inline" aria-hidden>{key}</span>
    </button>
  );

  return <ImageEditorShell open={open} heading="局部修改" icon={Paintbrush} subtitle={`${title} · ${dimensions.width} × ${dimensions.height}`}
    viewport={viewport} busy={busy} dirty={fingerprint !== savedFingerprint.current} onClose={() => onOpenChange(false)}
    onKeyDown={handleKey} onKeyUp={event => { if (event.key === ' ') setSpacePan(false); }}
    toolbar={<>
      {toolButton('brush', '涂抹', 'B', Paintbrush)}
      {toolButton('eraser', '擦除', 'E', Eraser)}
      <span className="mx-1.5 h-5 w-px bg-border" aria-hidden />
      <label className="flex items-center gap-2.5 px-2">
        <span className="sr-only">笔刷大小</span>
        <span className="size-1.5 rounded-full bg-muted-foreground" aria-hidden />
        <input type="range" min={BRUSH_MIN} max={BRUSH_MAX} value={brushSize} className="w-28 accent-primary"
          onChange={event => setBrushSize(Number(event.target.value))} />
        <span className="size-3.5 rounded-full bg-muted-foreground" aria-hidden />
        <span className="w-7 font-mono text-xs">{brushSize}</span>
      </label>
      <span className="mx-1.5 h-5 w-px bg-border" aria-hidden />
      <button type="button" aria-label="撤销选区" className={editorIconButton} disabled={!undoStack.current.length} onClick={undo}><Undo2 /></button>
      <button type="button" aria-label="重做选区" className={editorIconButton} disabled={!redoStack.length} onClick={redo}><Redo2 /></button>
      <button type="button" disabled={!strokes.length} onClick={() => commit([])}
        className="h-9 shrink-0 whitespace-nowrap rounded-lg px-3 text-sm text-muted-foreground hover:text-foreground disabled:opacity-40">清空</button>
    </>}
    stage={<div className={`relative size-full ${spacePan ? 'cursor-grab' : ''}`}
      onPointerDown={event => { if (event.target === event.currentTarget) viewport.startPan(event); }}
      onPointerMove={viewport.movePan} onPointerUp={viewport.endPan} onPointerCancel={viewport.endPan}>
      <div className="absolute rounded-sm outline outline-1 outline-border"
        style={{ left: origin.x, top: origin.y, width: dimensions.width * scale, height: dimensions.height * scale }}>
        <img src={mediaUrl} alt={title} draggable={false} className="block size-full select-none"
          onLoad={event => initialize(event.currentTarget)} onError={() => { setReady(false); setLocalError('源图片加载失败'); }} />
        <canvas ref={overlay} width={dimensions.width} height={dimensions.height} aria-label="蒙版绘制区域"
          className={`absolute inset-0 size-full touch-none opacity-60 ${spacePan ? 'cursor-grab' : 'cursor-none'}`}
          onPointerDown={startStroke} onPointerMove={moveStroke} onPointerUp={endStroke} onPointerCancel={endStroke}
          onPointerLeave={() => setCursor(null)} />
        {cursor && !spacePan && <span aria-hidden className="pointer-events-none absolute rounded-full border-[1.5px] border-foreground outline outline-1 outline-background/60"
          style={{ left: cursor.x - brushSize / 2, top: cursor.y - brushSize / 2, width: brushSize, height: brushSize }} />}
      </div>
    </div>}
    composer={<EditorComposer prompt={prompt} onPrompt={setPrompt} placeholder={mj ? '描述选区要改成什么（必填）' : '描述选区要改成什么；留空自然修复'}
      blocker={blocker} error={error || localError} cost={cost} busy={busy} canSave={!busy && (ready || !strokes.length)}
      generateLabel={`生成 ${candidates} 张`} onSave={() => void submit(false)} onGenerate={() => void submit(true)}
      chips={<>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="编辑模型" title={choice?.key.alias}
              className={`${editorChip} max-w-64 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}>
              <Sparkles className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{choice ? (mj ? 'Midjourney 局部重绘' : choice.name) : '选择模型'}</span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="z-50 max-h-80 max-w-[calc(100vw-2rem)] overflow-y-auto">
            <DropdownMenuRadioGroup value={selected} onValueChange={setSelected}>
              {choices.map(item => <DropdownMenuRadioItem key={choiceId(item.key.alias, item.model)} value={choiceId(item.key.alias, item.model)}>
                <span className="flex-1">{item.mj ? 'Midjourney 局部重绘' : item.name}</span>
                <span className="ml-3 text-xs text-muted-foreground">{item.key.alias}</span>
              </DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {mj ? <span className={`${editorChip} font-mono`}>{MJ_IMAGES_PER_TASK} 张 · Fast</span>
          : <select aria-label="候选数" value={count} onChange={event => setCount(Number(event.target.value))}
            className={`${editorChip} bg-transparent font-mono`}>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} 张</option>)}</select>}
      </>} />} />;
}
