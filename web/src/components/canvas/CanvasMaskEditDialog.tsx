import { Eraser, LoaderCircle, Paintbrush, Redo2, RotateCcw, Sparkles, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { modelModality, type KeyView } from '@/api/keys';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { imageControlCaps } from '@/lib/imageControlCaps';
import { normalizeCanvasImageParams } from '@/pages/canvasEditorModel';
import type { CanvasGenerationDraft, CanvasMediaVersion } from '@/schema/canvas';


type MaskTool = 'brush' | 'eraser';
type MaskStroke = { kind: 'stroke'; tool: MaskTool; size: number; points: Array<{ x: number; y: number }> };
type MaskCommand = MaskStroke | { kind: 'clear' };

export interface CanvasMaskEditSubmission {
  mask: Blob;
  draft: CanvasGenerationDraft;
  requestedCount: number;
}

export function CanvasMaskEditDialog({
  open,
  title,
  version,
  mediaUrl,
  keys,
  initialDraft,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  title: string;
  version: CanvasMediaVersion;
  mediaUrl: string;
  keys: KeyView[];
  initialDraft: CanvasGenerationDraft | null;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (submission: CanvasMaskEditSubmission) => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const activeStroke = useRef<MaskStroke | null>(null);
  const past = useRef<MaskCommand[]>([]);
  const future = useRef<MaskCommand[]>([]);
  const [tool, setTool] = useState<MaskTool>('brush');
  const [brushSize, setBrushSize] = useState(72);
  const [ready, setReady] = useState(false);
  const [historySignal, setHistorySignal] = useState(0);
  const availableKeys = useMemo(() => keys.filter(key => (
    (key.provider === 'openai' || key.provider === 'custom')
    && key.models.some(model => isMaskModel(model, key))
  )), [keys]);
  const fallbackKey = availableKeys[0];
  const initialKey = availableKeys.find(key => key.alias === initialDraft?.alias) ?? fallbackKey;
  const fallbackModel = initialKey?.models.find(model => isMaskModel(model, initialKey));
  const initialModel = initialKey?.models.find(model => model.id === initialDraft?.model) ?? fallbackModel;
  const [alias, setAlias] = useState(initialKey?.alias ?? '');
  const [model, setModel] = useState(initialModel?.id ?? '');
  const [prompt, setPrompt] = useState(initialDraft?.prompt ?? '');
  const [quality, setQuality] = useState(String(initialDraft?.params.quality ?? 'auto'));
  const [requestedCount, setRequestedCount] = useState(Number(initialDraft?.params.n ?? 1));
  const selectedKey = availableKeys.find(key => key.alias === alias);
  const models = (selectedKey?.models ?? []).filter(candidate => isMaskModel(candidate, selectedKey));

  useEffect(() => {
    if (!open) return;
    const nextKey = availableKeys.find(key => key.alias === initialDraft?.alias) ?? availableKeys[0];
    const nextModel = nextKey?.models.find(candidate => candidate.id === initialDraft?.model)
      ?? nextKey?.models.find(candidate => isMaskModel(candidate, nextKey));
    setAlias(nextKey?.alias ?? '');
    setModel(nextModel?.id ?? '');
    setPrompt(initialDraft?.prompt ?? '');
    setQuality(String(initialDraft?.params.quality ?? 'auto'));
    setRequestedCount(Math.max(1, Math.min(4, Number(initialDraft?.params.n ?? 1))));
    setTool('brush');
    setReady(false);
    past.current = [];
    future.current = [];
    setHistorySignal(value => value + 1);
  }, [availableKeys, initialDraft, open, version.version_id]);

  function initializeCanvas() {
    const image = imageRef.current;
    const overlay = overlayRef.current;
    if (!image || !overlay || !image.naturalWidth || !image.naturalHeight) return;
    overlay.width = image.naturalWidth;
    overlay.height = image.naturalHeight;
    const overlayContext = overlay.getContext('2d');
    if (!overlayContext) return;
    overlayContext.clearRect(0, 0, overlay.width, overlay.height);
    past.current = [];
    future.current = [];
    setHistorySignal(value => value + 1);
    setReady(true);
  }

  function point(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = overlayRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * canvas.width / bounds.width,
      y: (event.clientY - bounds.top) * canvas.height / bounds.height,
    };
  }

  function draw(
    from: { x: number; y: number },
    to: { x: number; y: number },
    strokeTool: MaskTool,
    strokeSize: number,
  ) {
    const overlay = overlayRef.current;
    const overlayContext = overlay?.getContext('2d');
    if (!overlay || !overlayContext) return;
    const displayWidth = overlay.getBoundingClientRect().width || overlay.width;
    const width = strokeSize * overlay.width / displayWidth;
    overlayContext.lineCap = 'round';
    overlayContext.lineJoin = 'round';
    overlayContext.lineWidth = width;
    overlayContext.beginPath();
    overlayContext.moveTo(from.x, from.y);
    overlayContext.lineTo(to.x, to.y);
    if (strokeTool === 'brush') {
      overlayContext.globalCompositeOperation = 'source-over';
      overlayContext.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim();
    } else {
      overlayContext.globalCompositeOperation = 'destination-out';
      overlayContext.strokeStyle = 'black';
    }
    overlayContext.stroke();
  }

  function redraw() {
    const overlay = overlayRef.current;
    const context = overlay?.getContext('2d');
    if (!overlay || !context) return;
    context.clearRect(0, 0, overlay.width, overlay.height);
    for (const command of past.current) {
      if (command.kind === 'clear') {
        context.clearRect(0, 0, overlay.width, overlay.height);
        continue;
      }
      for (let index = 1; index < command.points.length; index += 1) {
        draw(command.points[index - 1], command.points[index], command.tool, command.size);
      }
    }
  }

  function beginStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    const current = point(event);
    if (!current || busy) return;
    future.current = [];
    event.currentTarget.setPointerCapture(event.pointerId);
    activeStroke.current = {
      kind: 'stroke',
      tool,
      size: brushSize,
      points: [current, { x: current.x + 0.01, y: current.y + 0.01 }],
    };
    draw(current, activeStroke.current.points[1], tool, brushSize);
  }

  function moveStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    const current = point(event);
    const currentStroke = activeStroke.current;
    if (!currentStroke || !current) return;
    const previous = currentStroke.points.at(-1)!;
    currentStroke.points.push(current);
    draw(previous, current, currentStroke.tool, currentStroke.size);
  }

  function endStroke(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (activeStroke.current) {
      past.current.push(activeStroke.current);
      activeStroke.current = null;
      setHistorySignal(signal => signal + 1);
    }
  }

  function undo() {
    const previous = past.current.pop();
    if (!previous) return;
    future.current.push(previous);
    redraw();
    setHistorySignal(signal => signal + 1);
  }

  function redo() {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(next);
    redraw();
    setHistorySignal(signal => signal + 1);
  }

  function clear() {
    if (!ready) return;
    const overlay = overlayRef.current;
    const overlayContext = overlay?.getContext('2d');
    if (!overlay || !overlayContext) return;
    past.current.push({ kind: 'clear' });
    future.current = [];
    overlayContext.clearRect(0, 0, overlay.width, overlay.height);
    setHistorySignal(signal => signal + 1);
  }

  async function submit() {
    const overlay = overlayRef.current;
    if (!overlay || !prompt.trim() || !alias || !model) return;
    const canvas = document.createElement('canvas');
    canvas.width = overlay.width;
    canvas.height = overlay.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = 'destination-out';
    context.drawImage(overlay, 0, 0);
    const mask = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!mask) return;
    const baseParams = initialDraft?.params ?? {};
    const selectedModel = selectedKey?.models.find(item => item.id === model);
    const params = normalizeCanvasImageParams(
      model,
      selectedKey?.provider,
      baseParams,
      selectedModel?.protocol,
    );
    params.n = requestedCount;
    params.quality = quality;
    params.size = 'auto';
    onSubmit({
      mask,
      requestedCount,
      draft: {
        mode: 'image',
        prompt: prompt.trim(),
        input_policy: 'mentions_only',
        alias,
        model,
        params,
        updated_at: new Date().toISOString(),
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[94dvh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Paintbrush aria-hidden="true" />局部编辑“{title}”</DialogTitle>
          <DialogDescription>涂抹需要改变的区域；原图和蒙版会冻结进本次生成记录，便于事后溯源。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-3">
            <div className="grid max-h-[58dvh] min-h-64 place-items-center overflow-hidden rounded-lg border border-border bg-background/70">
              <div className="relative max-h-[58dvh] max-w-full">
                <img ref={imageRef} src={mediaUrl} alt={title} className="block max-h-[58dvh] max-w-full select-none" onLoad={initializeCanvas} draggable={false} />
                <canvas
                  ref={overlayRef}
                  aria-label="蒙版绘制区域"
                  className="absolute inset-0 size-full touch-none opacity-60"
                  onPointerDown={beginStroke}
                  onPointerMove={moveStroke}
                  onPointerUp={endStroke}
                  onPointerCancel={endStroke}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant={tool === 'brush' ? 'secondary' : 'ghost'} onClick={() => setTool('brush')}><Paintbrush />涂抹</Button>
              <Button type="button" size="sm" variant={tool === 'eraser' ? 'secondary' : 'ghost'} onClick={() => setTool('eraser')}><Eraser />擦除</Button>
              <label className="flex min-w-40 flex-1 items-center gap-2 text-xs text-muted-foreground">
                笔刷
                <input aria-label="笔刷大小" type="range" min="12" max="180" value={brushSize} onChange={event => setBrushSize(Number(event.target.value))} className="min-w-24 flex-1 accent-primary" />
                <span className="w-8 text-right">{brushSize}</span>
              </label>
              <Button type="button" size="icon" variant="ghost" aria-label="撤销蒙版" disabled={!past.current.length} onClick={undo}><Undo2 /></Button>
              <Button type="button" size="icon" variant="ghost" aria-label="重做蒙版" disabled={!future.current.length} onClick={redo}><Redo2 /></Button>
              <Button type="button" size="sm" variant="ghost" onClick={clear}><RotateCcw />清空</Button>
              <span className="sr-only" aria-live="polite">蒙版历史 {historySignal}</span>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-3">
            <label className="block text-xs text-muted-foreground">编辑提示词
              <textarea aria-label="局部编辑提示词" rows={7} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述涂抹区域需要变成什么" className="canvas-input mt-1 resize-none" />
            </label>
            <label className="block text-xs text-muted-foreground">密钥
              <select aria-label="局部编辑密钥" value={alias} onChange={event => {
                const nextKey = availableKeys.find(key => key.alias === event.target.value);
                setAlias(event.target.value);
                setModel(nextKey?.models.find(candidate => isMaskModel(candidate, nextKey))?.id ?? '');
              }} className="canvas-input mt-1">
                <option value="">选择密钥</option>
                {availableKeys.map(key => <option key={key.alias} value={key.alias}>{key.alias}</option>)}
              </select>
            </label>
            <label className="block text-xs text-muted-foreground">模型
              <select aria-label="局部编辑模型" value={model} onChange={event => setModel(event.target.value)} className="canvas-input mt-1">
                <option value="">选择模型</option>
                {models.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name || candidate.id}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs text-muted-foreground">质量
                <select aria-label="局部编辑质量" value={quality} onChange={event => setQuality(event.target.value)} className="canvas-input mt-1">
                  {['auto', 'low', 'medium', 'high'].map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="block text-xs text-muted-foreground">候选数
                <select aria-label="局部编辑候选数" value={requestedCount} onChange={event => setRequestedCount(Number(event.target.value))} className="canvas-input mt-1">
                  {[1, 2, 3, 4].map(value => <option key={value} value={value}>{value} 张</option>)}
                </select>
              </label>
            </div>
            {!availableKeys.length && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">没有可用的 GPT Image 蒙版模型。请先在设置中配置 OpenAI 或兼容 `/images/edits` 的模型。</p>}
            {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">{error}</p>}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" disabled={busy || !ready || !prompt.trim() || !alias || !model || !availableKeys.length} onClick={() => void submit()}>
            {busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
            {busy ? '提交中…' : '生成局部编辑'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isMaskModel(model: KeyView['models'][number], key: KeyView | undefined) {
  return Boolean(
    key
    && modelModality(model, key) === 'image'
    && imageControlCaps(model.id, key.provider, model.protocol).family === 'gpt-image'
    && (model.protocol == null || model.protocol === 'openai'),
  );
}
