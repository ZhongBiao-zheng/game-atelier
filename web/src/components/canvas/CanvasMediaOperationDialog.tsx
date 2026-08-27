import { Crop, Grid2X2, Redo2, Undo2, ZoomIn } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { clamp, cn } from '@/lib/utils';
import type { CanvasMediaOperation, CanvasMediaVersion } from '@/schema/canvas';

export type CanvasMediaTool = 'crop' | 'split' | 'upscale';

interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type CropHandle = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
type CropRatio = 'free' | 'original' | '1:1' | '4:3' | '16:9' | '9:16';
type SplitLines = { horizontal: number[]; vertical: number[] };

const CROP_RATIOS: Array<{ value: CropRatio; label: string }> = [
  { value: 'free', label: '自由' },
  { value: 'original', label: '原图' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
];
const UPSCALE_TARGETS = [1024, 2048, 3072, 4096] as const;
const UPSCALE_ALGORITHMS = [
  { value: 'nearest', label: '像素', description: '保留硬边，适合像素画' },
  { value: 'bilinear', label: '平滑', description: '速度快，边缘更柔和' },
  { value: 'lanczos', label: '高质量', description: '细节过渡最好，处理稍慢' },
] as const;

export function CanvasMediaOperationDialog({
  open,
  tool,
  title,
  version,
  mediaUrl,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  tool: CanvasMediaTool;
  title: string;
  version: CanvasMediaVersion;
  mediaUrl: string;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (operation: CanvasMediaOperation) => void;
}) {
  const registeredWidth = version.width ?? 1;
  const registeredHeight = version.height ?? 1;
  const [sourceDimensions, setSourceDimensions] = useState({
    width: registeredWidth,
    height: registeredHeight,
  });
  const { width, height } = sourceDimensions;
  const [cropRatio, setCropRatio] = useState<CropRatio>('free');
  const [cropRect, setCropRect] = useState<NormalizedRect>(() => centeredCrop(width, height, 'free'));
  const [splitLines, setSplitLines] = useState<SplitLines>(() => evenSplit(2, 2));
  const splitPast = useRef<SplitLines[]>([]);
  const splitFuture = useRef<SplitLines[]>([]);
  const availableTarget = UPSCALE_TARGETS.find(target => target > Math.max(width, height)) ?? null;
  const [upscaleTarget, setUpscaleTarget] = useState<(typeof UPSCALE_TARGETS)[number] | null>(availableTarget);
  const [upscaleAlgorithm, setUpscaleAlgorithm] = useState<'nearest' | 'bilinear' | 'lanczos'>('lanczos');

  useEffect(() => {
    if (!open) return;
    setSourceDimensions({ width: registeredWidth, height: registeredHeight });
    const probe = new window.Image();
    probe.onload = () => {
      if (probe.naturalWidth > 0 && probe.naturalHeight > 0) {
        setSourceDimensions({ width: probe.naturalWidth, height: probe.naturalHeight });
      }
    };
    probe.src = mediaUrl;
    return () => {
      probe.onload = null;
      probe.src = '';
    };
  }, [mediaUrl, open, registeredHeight, registeredWidth, version.version_id]);

  useEffect(() => {
    if (!open) return;
    setCropRatio('free');
    setCropRect(centeredCrop(width, height, 'free'));
    setSplitLines(evenSplit(2, 2));
    splitPast.current = [];
    splitFuture.current = [];
    setUpscaleTarget(UPSCALE_TARGETS.find(target => target > Math.max(width, height)) ?? null);
    setUpscaleAlgorithm('lanczos');
  }, [height, open, version.version_id, width]);

  const dialogCopy = {
    crop: { icon: <Crop aria-hidden="true" />, heading: `裁剪“${title}”`, description: '调整选区后生成一个新的图片节点，原图保持不变。' },
    split: { icon: <Grid2X2 aria-hidden="true" />, heading: `切分“${title}”`, description: '按切线一次生成整组图片节点，整批可以一次撤销。' },
    upscale: { icon: <ZoomIn aria-hidden="true" />, heading: `本地放大“${title}”`, description: '使用确定性重采样放大像素尺寸，不会恢复原图中不存在的新细节。' },
  }[tool];

  function commitSplit(next: SplitLines) {
    splitPast.current.push(cloneLines(splitLines));
    splitPast.current = splitPast.current.slice(-30);
    splitFuture.current = [];
    setSplitLines(next);
  }

  function undoSplit() {
    const previous = splitPast.current.pop();
    if (!previous) return;
    splitFuture.current.push(cloneLines(splitLines));
    setSplitLines(previous);
  }

  function redoSplit() {
    const next = splitFuture.current.pop();
    if (!next) return;
    splitPast.current.push(cloneLines(splitLines));
    setSplitLines(next);
  }

  function submit() {
    if (tool === 'crop') onSubmit({ kind: 'crop', rect: cropRect });
    if (tool === 'split') onSubmit({
      kind: 'split',
      horizontal_lines: splitLines.horizontal,
      vertical_lines: splitLines.vertical,
    });
    if (tool === 'upscale' && upscaleTarget) onSubmit({
      kind: 'upscale',
      target_long_edge: upscaleTarget,
      algorithm: upscaleAlgorithm,
    });
  }

  const output = tool === 'crop'
    ? cropPixelSize(cropRect, width, height)
    : tool === 'split'
      ? { width: splitLines.vertical.length + 1, height: splitLines.horizontal.length + 1 }
      : upscaleTarget ? scaledSize(width, height, upscaleTarget) : null;
  const confirmDisabled = busy || (tool === 'upscale' && upscaleTarget === null);

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-h-[92dvh] max-w-4xl overflow-y-auto" aria-busy={busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-balance">{dialogCopy.icon}{dialogCopy.heading}</DialogTitle>
          <DialogDescription className="text-pretty">{dialogCopy.description}</DialogDescription>
        </DialogHeader>

        {tool === 'crop' && (
          <CropEditor
            mediaUrl={mediaUrl}
            sourceWidth={width}
            sourceHeight={height}
            rect={cropRect}
            ratio={cropRatio}
            onRectChange={setCropRect}
            onRatioChange={next => {
              setCropRatio(next);
              setCropRect(centeredCrop(width, height, next));
            }}
          />
        )}
        {tool === 'split' && (
          <SplitEditor
            mediaUrl={mediaUrl}
            sourceWidth={width}
            sourceHeight={height}
            lines={splitLines}
            canUndo={splitPast.current.length > 0}
            canRedo={splitFuture.current.length > 0}
            onCommit={commitSplit}
            onChange={setSplitLines}
            onUndo={undoSplit}
            onRedo={redoSplit}
          />
        )}
        {tool === 'upscale' && (
          <UpscaleEditor
            width={width}
            height={height}
            target={upscaleTarget}
            algorithm={upscaleAlgorithm}
            onTargetChange={setUpscaleTarget}
            onAlgorithmChange={setUpscaleAlgorithm}
          />
        )}

        {error && <p id="canvas-media-operation-error" role="alert" className="text-sm text-destructive">{error}</p>}
        {busy && <p role="status" className="text-sm text-muted-foreground">正在处理图片并提交画布，请稍候…</p>}

        <DialogFooter className="items-center sm:justify-between">
          <p className="text-xs tabular-nums text-muted-foreground">
            {tool === 'split' && output ? `${output.height} 行 × ${output.width} 列 · ${output.height * output.width} 个结果` : null}
            {tool !== 'split' && output ? `输出 ${output.width} × ${output.height} px` : null}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
            <Button
              disabled={confirmDisabled}
              aria-describedby={error ? 'canvas-media-operation-error' : undefined}
              onClick={submit}
            >
              {busy ? '处理中…' : { crop: '生成裁剪节点', split: '生成切图节点', upscale: '生成放大节点' }[tool]}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CropEditor({
  mediaUrl,
  sourceWidth,
  sourceHeight,
  rect,
  ratio,
  onRectChange,
  onRatioChange,
}: {
  mediaUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  rect: NormalizedRect;
  ratio: CropRatio;
  onRectChange: (rect: NormalizedRect) => void;
  onRatioChange: (ratio: CropRatio) => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ handle: CropHandle; x: number; y: number; rect: NormalizedRect } | null>(null);
  const lockedRatio = ratioValue(ratio, sourceWidth / sourceHeight);
  const normalizedRatio = lockedRatio ? lockedRatio / (sourceWidth / sourceHeight) : null;

  function begin(handle: CropHandle, event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { handle, x: event.clientX, y: event.clientY, rect };
  }

  function move(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = pointer.current;
    const bounds = previewRef.current?.getBoundingClientRect();
    if (!active || !bounds) return;
    const dx = (event.clientX - active.x) / bounds.width;
    const dy = (event.clientY - active.y) / bounds.height;
    onRectChange(resizeCrop(
      active.rect,
      active.handle,
      dx,
      dy,
      normalizedRatio,
      2 / sourceWidth,
      2 / sourceHeight,
    ));
  }

  function nudge(handle: CropHandle, key: string) {
    const stepX = 1 / sourceWidth;
    const stepY = 1 / sourceHeight;
    const dx = key === 'ArrowLeft' ? -stepX : key === 'ArrowRight' ? stepX : 0;
    const dy = key === 'ArrowUp' ? -stepY : key === 'ArrowDown' ? stepY : 0;
    if (!dx && !dy) return;
    onRectChange(resizeCrop(rect, handle, dx, dy, normalizedRatio, 2 / sourceWidth, 2 / sourceHeight));
  }

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-xs text-muted-foreground">裁剪比例</legend>
        <div className="flex flex-wrap gap-2">
          {CROP_RATIOS.map(item => (
            <Button
              key={item.value}
              type="button"
              variant={ratio === item.value ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={ratio === item.value}
              onClick={() => onRatioChange(item.value)}
            >{item.label}</Button>
          ))}
        </div>
      </fieldset>
      <div
        ref={previewRef}
        className="relative mx-auto w-full overflow-hidden rounded-lg border border-border bg-background"
        style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}`, maxWidth: `calc(48dvh * ${sourceWidth / sourceHeight})` }}
      >
        <img src={mediaUrl} alt="裁剪预览" className="absolute inset-0 size-full object-contain" draggable={false} />
        <button
          type="button"
          aria-label="移动裁剪框"
          className="absolute z-20 cursor-move border-2 border-primary bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={rectStyle(rect)}
          onPointerDown={event => begin('move', event)}
          onPointerMove={move}
          onPointerUp={() => { pointer.current = null; }}
          onKeyDown={event => {
            if (!event.key.startsWith('Arrow')) return;
            event.preventDefault();
            nudge('move', event.key);
          }}
        >
          {(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const).map(handle => (
            <span
              key={handle}
              aria-hidden="true"
              className={cn('pointer-events-none absolute size-3 rounded-full border border-primary-foreground bg-primary', cropHandlePosition(handle))}
            />
          ))}
        </button>
        {(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const).map(handle => (
          <button
            key={handle}
            type="button"
            aria-label={`调整裁剪框${cropHandleLabel(handle)}`}
            className={cn('absolute z-20 size-6 -translate-x-1/2 -translate-y-1/2 opacity-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary', cropHandleCursor(handle))}
            style={cropHandleButtonStyle(handle, rect)}
            onPointerDown={event => begin(handle, event)}
            onPointerMove={move}
            onPointerUp={() => { pointer.current = null; }}
            onKeyDown={event => {
              if (!event.key.startsWith('Arrow')) return;
              event.preventDefault();
              nudge(handle, event.key);
            }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(['x', 'y', 'width', 'height'] as const).map(key => (
          <label key={key} className="space-y-1 text-xs text-muted-foreground">
            <span>{{ x: '左边', y: '上边', width: '宽度', height: '高度' }[key]}（%）</span>
            <input
              type="number"
              min={key === 'width' ? 200 / sourceWidth : key === 'height' ? 200 / sourceHeight : 0}
              max={(key === 'x' ? 1 - rect.width : key === 'y' ? 1 - rect.height : 1) * 100}
              step={0.1}
              value={(rect[key] * 100).toFixed(1)}
              onChange={event => {
                const next = updateCropField(
                  rect,
                  key,
                  Number(event.target.value) / 100,
                  2 / sourceWidth,
                  2 / sourceHeight,
                );
                onRatioChange('free');
                onRectChange(next);
              }}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function SplitEditor({
  mediaUrl,
  sourceWidth,
  sourceHeight,
  lines,
  canUndo,
  canRedo,
  onCommit,
  onChange,
  onUndo,
  onRedo,
}: {
  mediaUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  lines: SplitLines;
  canUndo: boolean;
  canRedo: boolean;
  onCommit: (lines: SplitLines) => void;
  onChange: (lines: SplitLines) => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ axis: 'horizontal' | 'vertical'; index: number } | null>(null);

  function begin(axis: 'horizontal' | 'vertical', index: number, event: ReactPointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { axis, index };
    onCommit(cloneLines(lines));
  }

  function move(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = pointer.current;
    const bounds = previewRef.current?.getBoundingClientRect();
    if (!active || !bounds) return;
    const value = active.axis === 'vertical'
      ? (event.clientX - bounds.left) / bounds.width
      : (event.clientY - bounds.top) / bounds.height;
    onChange(moveSplitLine(lines, active.axis, active.index, value, sourceWidth, sourceHeight));
  }

  function keyMove(axis: 'horizontal' | 'vertical', index: number, key: string) {
    const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : key === 'ArrowRight' || key === 'ArrowDown' ? 1 : 0;
    if (!direction) return;
    const dimension = axis === 'vertical' ? sourceWidth : sourceHeight;
    const current = lines[axis][index];
    onCommit(moveSplitLine(lines, axis, index, current + direction * 4 / dimension, sourceWidth, sourceHeight));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <LabeledCount label="行数" value={lines.horizontal.length + 1} onChange={rows => onCommit(evenSplit(rows, lines.vertical.length + 1))} />
        <LabeledCount label="列数" value={lines.vertical.length + 1} onChange={columns => onCommit(evenSplit(lines.horizontal.length + 1, columns))} />
        <div className="ml-auto flex gap-1">
          <Button type="button" variant="ghost" size="icon" aria-label="撤销切线调整" disabled={!canUndo} onClick={onUndo}><Undo2 aria-hidden="true" /></Button>
          <Button type="button" variant="ghost" size="icon" aria-label="重做切线调整" disabled={!canRedo} onClick={onRedo}><Redo2 aria-hidden="true" /></Button>
        </div>
      </div>
      <div
        ref={previewRef}
        className="relative mx-auto w-full overflow-hidden rounded-lg border border-border bg-background"
        style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}`, maxWidth: `calc(48dvh * ${sourceWidth / sourceHeight})` }}
      >
        <img src={mediaUrl} alt="切图预览" className="absolute inset-0 size-full object-contain" draggable={false} />
        {lines.vertical.map((value, index) => (
          <button
            key={`vertical-${index}`}
            type="button"
            aria-label={`调整第 ${index + 1} 条竖向切线`}
            className="absolute top-0 z-20 flex h-full w-3 -translate-x-1/2 cursor-col-resize justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            style={{ left: `${value * 100}%` }}
            onPointerDown={event => begin('vertical', index, event)}
            onPointerMove={move}
            onPointerUp={() => { pointer.current = null; }}
            onKeyDown={event => {
              if (!event.key.startsWith('Arrow')) return;
              event.preventDefault();
              keyMove('vertical', index, event.key);
            }}
          ><span className="block h-full w-px bg-primary" /></button>
        ))}
        {lines.horizontal.map((value, index) => (
          <button
            key={`horizontal-${index}`}
            type="button"
            aria-label={`调整第 ${index + 1} 条横向切线`}
            className="absolute left-0 z-20 flex h-3 w-full -translate-y-1/2 cursor-row-resize items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            style={{ top: `${value * 100}%` }}
            onPointerDown={event => begin('horizontal', index, event)}
            onPointerMove={move}
            onPointerUp={() => { pointer.current = null; }}
            onKeyDown={event => {
              if (!event.key.startsWith('Arrow')) return;
              event.preventDefault();
              keyMove('horizontal', index, event.key);
            }}
          ><span className="block h-px w-full bg-primary" /></button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">拖动切线可以创建非均匀切块；每块最短边至少 16 像素。</p>
    </div>
  );
}

function UpscaleEditor({
  width,
  height,
  target,
  algorithm,
  onTargetChange,
  onAlgorithmChange,
}: {
  width: number;
  height: number;
  target: (typeof UPSCALE_TARGETS)[number] | null;
  algorithm: 'nearest' | 'bilinear' | 'lanczos';
  onTargetChange: (target: (typeof UPSCALE_TARGETS)[number]) => void;
  onAlgorithmChange: (algorithm: 'nearest' | 'bilinear' | 'lanczos') => void;
}) {
  const longEdge = Math.max(width, height);
  return (
    <div className="space-y-6">
      <fieldset>
        <legend className="mb-2 text-xs text-muted-foreground">目标长边</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {UPSCALE_TARGETS.map(item => (
            <Button
              key={item}
              type="button"
              variant={target === item ? 'secondary' : 'outline'}
              disabled={item <= longEdge}
              aria-pressed={target === item}
              onClick={() => onTargetChange(item)}
              className="tabular-nums"
            >{item}px</Button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-xs text-muted-foreground">重采样算法</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {UPSCALE_ALGORITHMS.map(item => (
            <label key={item.value} className={cn('cursor-pointer rounded-lg border p-4', algorithm === item.value ? 'border-primary bg-secondary' : 'border-border bg-card')}>
              <span className="flex items-center gap-2 text-sm font-medium">
                <input type="radio" name="upscale-algorithm" checked={algorithm === item.value} onChange={() => onAlgorithmChange(item.value)} />
                {item.label}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">{item.description}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
        <p className="text-pretty">本地放大只改变像素尺寸，不是 AI 超分，也不会补回原图中不存在的纹理或细节。</p>
        {target === null && <p className="mt-2 text-destructive">原图长边已经达到 4096px，不能继续本地放大。</p>}
      </div>
    </div>
  );
}

function LabeledCount({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="space-y-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <select value={value} onChange={event => onChange(Number(event.target.value))} className="h-9 rounded-md border border-input bg-transparent px-3 text-sm tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {Array.from({ length: 11 }, (_, index) => index + 2).map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>
  );
}

function ratioValue(ratio: CropRatio, original: number): number | null {
  if (ratio === 'free') return null;
  if (ratio === 'original') return original;
  const [width, height] = ratio.split(':').map(Number);
  return width / height;
}

function centeredCrop(width: number, height: number, ratio: CropRatio): NormalizedRect {
  const target = ratioValue(ratio, width / height);
  if (!target) return { x: 0.12, y: 0.12, width: 0.76, height: 0.76 };
  const normalizedRatio = target / (width / height);
  let cropWidth = 0.76;
  let cropHeight = cropWidth / normalizedRatio;
  if (cropHeight > 0.76) {
    cropHeight = 0.76;
    cropWidth = cropHeight * normalizedRatio;
  }
  return { x: (1 - cropWidth) / 2, y: (1 - cropHeight) / 2, width: cropWidth, height: cropHeight };
}

function resizeCrop(
  rect: NormalizedRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  ratio: number | null,
  minWidth: number,
  minHeight: number,
): NormalizedRect {
  if (handle === 'move') {
    return { ...rect, x: clamp(rect.x + dx, 0, 1 - rect.width), y: clamp(rect.y + dy, 0, 1 - rect.height) };
  }
  let left = rect.x;
  let right = rect.x + rect.width;
  let top = rect.y;
  let bottom = rect.y + rect.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - minWidth);
  if (handle.includes('e')) right = clamp(right + dx, left + minWidth, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - minHeight);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + minHeight, 1);
  if (!ratio) return { x: left, y: top, width: right - left, height: bottom - top };

  let width = right - left;
  let height = bottom - top;
  if (handle === 'n' || handle === 's') width = height * ratio;
  else height = width / ratio;
  const anchorX = handle.includes('w') ? right : handle.includes('e') ? left : (left + right) / 2;
  const anchorY = handle.includes('n') ? bottom : handle.includes('s') ? top : (top + bottom) / 2;
  if (handle.includes('w')) left = anchorX - width;
  else if (handle.includes('e')) right = anchorX + width;
  else { left = anchorX - width / 2; right = anchorX + width / 2; }
  if (handle.includes('n')) top = anchorY - height;
  else if (handle.includes('s')) bottom = anchorY + height;
  else { top = anchorY - height / 2; bottom = anchorY + height / 2; }
  const fit = Math.min(1, 1 / (right - left), 1 / (bottom - top));
  width = (right - left) * fit;
  height = (bottom - top) * fit;
  left = clamp(handle.includes('w') ? right - width : handle.includes('e') ? left : anchorX - width / 2, 0, 1 - width);
  top = clamp(handle.includes('n') ? bottom - height : handle.includes('s') ? top : anchorY - height / 2, 0, 1 - height);
  return { x: left, y: top, width, height };
}

function updateCropField(
  rect: NormalizedRect,
  key: keyof NormalizedRect,
  value: number,
  minWidth: number,
  minHeight: number,
): NormalizedRect {
  const next = { ...rect, [key]: Number.isFinite(value) ? value : rect[key] };
  next.width = clamp(next.width, minWidth, 1);
  next.height = clamp(next.height, minHeight, 1);
  next.x = clamp(next.x, 0, 1 - next.width);
  next.y = clamp(next.y, 0, 1 - next.height);
  return next;
}

function cropPixelSize(rect: NormalizedRect, width: number, height: number) {
  return {
    width: Math.ceil((rect.x + rect.width) * width) - Math.floor(rect.x * width),
    height: Math.ceil((rect.y + rect.height) * height) - Math.floor(rect.y * height),
  };
}

function rectStyle(rect: NormalizedRect) {
  return { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` };
}

function cropHandlePosition(handle: Exclude<CropHandle, 'move'>) {
  return {
    n: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2',
    ne: 'right-0 top-0 translate-x-1/2 -translate-y-1/2',
    e: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2',
    se: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2',
    s: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2',
    sw: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2',
    w: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2',
    nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2',
  }[handle];
}

function cropHandleButtonStyle(handle: Exclude<CropHandle, 'move'>, rect: NormalizedRect) {
  const x = handle.includes('w') ? rect.x : handle.includes('e') ? rect.x + rect.width : rect.x + rect.width / 2;
  const y = handle.includes('n') ? rect.y : handle.includes('s') ? rect.y + rect.height : rect.y + rect.height / 2;
  return { left: `${x * 100}%`, top: `${y * 100}%` };
}

function cropHandleCursor(handle: Exclude<CropHandle, 'move'>) {
  if (handle === 'n' || handle === 's') return 'cursor-row-resize';
  if (handle === 'e' || handle === 'w') return 'cursor-col-resize';
  return handle === 'ne' || handle === 'sw' ? 'cursor-nesw-resize' : 'cursor-nwse-resize';
}

function cropHandleLabel(handle: Exclude<CropHandle, 'move'>) {
  return { n: '上边', ne: '右上角', e: '右边', se: '右下角', s: '下边', sw: '左下角', w: '左边', nw: '左上角' }[handle];
}

function evenSplit(rows: number, columns: number): SplitLines {
  return {
    horizontal: Array.from({ length: rows - 1 }, (_, index) => (index + 1) / rows),
    vertical: Array.from({ length: columns - 1 }, (_, index) => (index + 1) / columns),
  };
}

function cloneLines(lines: SplitLines): SplitLines {
  return { horizontal: [...lines.horizontal], vertical: [...lines.vertical] };
}

function moveSplitLine(
  lines: SplitLines,
  axis: 'horizontal' | 'vertical',
  index: number,
  value: number,
  width: number,
  height: number,
): SplitLines {
  const next = cloneLines(lines);
  const dimension = axis === 'vertical' ? width : height;
  const minimum = 16 / dimension;
  const values = next[axis];
  values[index] = clamp(value, (values[index - 1] ?? 0) + minimum, (values[index + 1] ?? 1) - minimum);
  return next;
}

function scaledSize(width: number, height: number, longEdge: number) {
  const scale = longEdge / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

