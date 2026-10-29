import { Minus, Plus, Redo2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { clamp, cn } from '@/lib/utils';
import type { CanvasMediaOperation, CanvasMediaVersion } from '@/schema/canvas';
import { Input } from '@/components/ui/input';

export type CanvasMediaTool = 'crop' | 'split';

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

/** 行 × 列。 */
const SPLIT_PRESETS: Array<{ rows: number; columns: number }> = [
  { rows: 2, columns: 2 },
  { rows: 3, columns: 3 },
  { rows: 1, columns: 4 },
  { rows: 4, columns: 1 },
];
const SPLIT_MAX_COUNT = 12;
const CROP_MIN_PIXELS = 2;

const OPTION_TILE_CLASS = 'flex h-14 flex-col items-center justify-center gap-1.5 rounded-lg border text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';
const OPTION_TILE_ON_CLASS = 'border-primary bg-primary/10 text-foreground';
const OPTION_TILE_OFF_CLASS = 'border-border text-muted-foreground hover:text-foreground';
const PANEL_LABEL_CLASS = 'mb-2 text-xs text-muted-foreground';
const STAGE_BADGE_CLASS = 'pointer-events-none whitespace-nowrap rounded-sm bg-background/70 px-1.5 py-0.5 text-xs tabular-nums text-foreground';

export function CanvasMediaOperationDialog({
  open,
  tool,
  title,
  version,
  mediaUrl,
  busy,
  error,
  updatesMaterial,
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
  updatesMaterial: boolean;
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
  }, [height, open, version.version_id, width]);

  const description = tool === 'split'
    ? `按切线把“${title}”一次生成整组图片节点，整批可以一次撤销。`
    : updatesMaterial ? `裁剪“${title}”后同步更新原图层，可撤销。` : `调整选区后由“${title}”生成一个新的图片节点，原图保持不变。`;

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
  }

  const splitCount = (splitLines.horizontal.length + 1) * (splitLines.vertical.length + 1);
  const submitLabel = busy ? '处理中…'
    : tool === 'split' ? `生成 ${splitCount} 个节点`
      : updatesMaterial ? '更新图层素材' : '生成裁剪节点';

  return (
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
      {/* 左图右栏：图片占满左侧且不滚动，控件与按钮都在右栏；窄屏上下堆叠。 */}
      <DialogContent
        className="flex h-[min(42rem,92dvh)] max-w-5xl gap-0 overflow-hidden p-0 max-md:h-auto max-md:max-h-[92dvh] max-md:flex-col max-md:overflow-y-auto"
        aria-busy={busy}
      >
        <div className="flex min-h-0 min-w-0 flex-1 bg-background p-6 max-md:h-72 max-md:flex-none">
          <div className="flex size-full items-center justify-center" style={{ containerType: 'size' }}>
            {tool === 'crop' && (
              <CropStage
                mediaUrl={mediaUrl}
                sourceWidth={width}
                sourceHeight={height}
                rect={cropRect}
                ratio={cropRatio}
                onRectChange={setCropRect}
              />
            )}
            {tool === 'split' && (
              <SplitStage
                mediaUrl={mediaUrl}
                sourceWidth={width}
                sourceHeight={height}
                lines={splitLines}
                onCommit={commitSplit}
                onChange={setSplitLines}
              />
            )}
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-5 border-border p-5 md:w-72 md:overflow-y-auto md:border-l max-md:border-t">
          <DialogHeader>
            <DialogTitle>{tool === 'crop' ? '裁剪' : '切分'}</DialogTitle>
            <DialogDescription className="sr-only">{description}</DialogDescription>
          </DialogHeader>

          {tool === 'crop' && (
            <CropControls
              sourceWidth={width}
              sourceHeight={height}
              rect={cropRect}
              ratio={cropRatio}
              onRatioChange={next => {
                setCropRatio(next);
                setCropRect(centeredCrop(width, height, next));
              }}
              onSizeChange={next => {
                setCropRatio('free');
                setCropRect(next);
              }}
              onReset={() => {
                setCropRatio('free');
                setCropRect({ x: 0, y: 0, width: 1, height: 1 });
              }}
            />
          )}
          {tool === 'split' && (
            <SplitControls
              sourceWidth={width}
              sourceHeight={height}
              lines={splitLines}
              canUndo={splitPast.current.length > 0}
              canRedo={splitFuture.current.length > 0}
              onCommit={commitSplit}
              onUndo={undoSplit}
              onRedo={redoSplit}
            />
          )}

          <div className="mt-auto space-y-3">
            <p className="text-xs tabular-nums text-muted-foreground">
              原图 {width} × {height}{tool === 'split' && ` · ${splitCount} 个结果`}
            </p>
            {error && <p id="canvas-media-operation-error" role="alert" className="text-sm text-destructive">{error}</p>}
            {busy && <p role="status" className="text-xs text-muted-foreground">正在处理图片并提交画布…</p>}
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
              <Button
                className="flex-1"
                disabled={busy || (tool === 'split' && splitCount < 2)}
                aria-describedby={error ? 'canvas-media-operation-error' : undefined}
                onClick={submit}
              >
                {submitLabel}
              </Button>
            </div>
          </div>
        </aside>
      </DialogContent>
    </Dialog>
  );
}

/** 图片在舞台里等比铺到最大：宽、高谁先碰到舞台边就以谁为准。舞台外壳声明了 container-type: size。 */
function stageFrameStyle(sourceWidth: number, sourceHeight: number) {
  const aspect = sourceWidth / sourceHeight;
  return { aspectRatio: `${sourceWidth} / ${sourceHeight}`, width: `min(100cqw, calc(100cqh * ${aspect}))` };
}

function CropStage({
  mediaUrl,
  sourceWidth,
  sourceHeight,
  rect,
  ratio,
  onRectChange,
}: {
  mediaUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  rect: NormalizedRect;
  ratio: CropRatio;
  onRectChange: (rect: NormalizedRect) => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ handle: CropHandle; x: number; y: number; rect: NormalizedRect } | null>(null);
  const lockedRatio = ratioValue(ratio, sourceWidth / sourceHeight);
  const normalizedRatio = lockedRatio ? lockedRatio / (sourceWidth / sourceHeight) : null;
  const minWidth = CROP_MIN_PIXELS / sourceWidth;
  const minHeight = CROP_MIN_PIXELS / sourceHeight;
  const output = cropPixelSize(rect, sourceWidth, sourceHeight);
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

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
    onRectChange(resizeCrop(active.rect, active.handle, dx, dy, normalizedRatio, minWidth, minHeight));
  }

  function nudge(handle: CropHandle, key: string) {
    const stepX = 1 / sourceWidth;
    const stepY = 1 / sourceHeight;
    const dx = key === 'ArrowLeft' ? -stepX : key === 'ArrowRight' ? stepX : 0;
    const dy = key === 'ArrowUp' ? -stepY : key === 'ArrowDown' ? stepY : 0;
    if (!dx && !dy) return;
    onRectChange(resizeCrop(rect, handle, dx, dy, normalizedRatio, minWidth, minHeight));
  }

  return (
    <div ref={previewRef} className="relative overflow-hidden" style={stageFrameStyle(sourceWidth, sourceHeight)}>
      <img src={mediaUrl} alt="裁剪预览" className="absolute inset-0 size-full object-contain" draggable={false} />
      {/* 裁剪框外压暗：四块遮罩围住选区。 */}
      <span aria-hidden="true" className="absolute inset-x-0 top-0 bg-background/60" style={{ height: `${rect.y * 100}%` }} />
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 bg-background/60" style={{ height: `${(1 - bottom) * 100}%` }} />
      <span aria-hidden="true" className="absolute left-0 bg-background/60" style={{ top: `${rect.y * 100}%`, height: `${rect.height * 100}%`, width: `${rect.x * 100}%` }} />
      <span aria-hidden="true" className="absolute right-0 bg-background/60" style={{ top: `${rect.y * 100}%`, height: `${rect.height * 100}%`, width: `${(1 - right) * 100}%` }} />
      <button
        type="button"
        aria-label="移动裁剪框"
        className="absolute z-20 cursor-move border border-foreground bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-foreground/30" />
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-foreground/30" />
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-foreground/30" />
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-foreground/30" />
        {(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const).map(handle => (
          <span
            key={handle}
            aria-hidden="true"
            className={cn('pointer-events-none absolute', cropHandleMark(handle))}
          />
        ))}
        <span className={cn(STAGE_BADGE_CLASS, 'absolute bottom-2 left-1/2 -translate-x-1/2')}>
          {output.width} × {output.height}
        </span>
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
  );
}

function CropControls({
  sourceWidth,
  sourceHeight,
  rect,
  ratio,
  onRatioChange,
  onSizeChange,
  onReset,
}: {
  sourceWidth: number;
  sourceHeight: number;
  rect: NormalizedRect;
  ratio: CropRatio;
  onRatioChange: (ratio: CropRatio) => void;
  onSizeChange: (rect: NormalizedRect) => void;
  onReset: () => void;
}) {
  const output = cropPixelSize(rect, sourceWidth, sourceHeight);
  const isFullImage = rect.x === 0 && rect.y === 0 && rect.width === 1 && rect.height === 1;

  return (
    <>
      <fieldset>
        <legend className={PANEL_LABEL_CLASS}>比例</legend>
        <div className="grid grid-cols-3 gap-1.5">
          {CROP_RATIOS.map(item => (
            <button
              key={item.value}
              type="button"
              aria-pressed={ratio === item.value}
              className={cn(OPTION_TILE_CLASS, ratio === item.value ? OPTION_TILE_ON_CLASS : OPTION_TILE_OFF_CLASS)}
              onClick={() => onRatioChange(item.value)}
            >
              <span
                aria-hidden="true"
                className={cn('rounded-sm border border-current', item.value === 'free' && 'border-dashed')}
                style={ratioGlyphSize(item.value, sourceWidth / sourceHeight)}
              />
              {item.label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className={PANEL_LABEL_CLASS}>尺寸（像素）</legend>
        <div className="grid grid-cols-2 gap-2">
          <PixelField
            label="宽"
            value={output.width}
            max={sourceWidth}
            onCommit={pixels => onSizeChange(cropWithPixelSize(rect, 'width', pixels, sourceWidth))}
          />
          <PixelField
            label="高"
            value={output.height}
            max={sourceHeight}
            onCommit={pixels => onSizeChange(cropWithPixelSize(rect, 'height', pixels, sourceHeight))}
          />
        </div>
      </fieldset>
      <button
        type="button"
        disabled={isFullImage}
        className="self-start text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:underline disabled:pointer-events-none disabled:opacity-40"
        onClick={onReset}
      >
        重置为整张图
      </button>
    </>
  );
}

/** 输入时先留在本地草稿，失焦或回车才提交——逐字提交会在打第一位数字时就被钳到下限。 */
function PixelField({ label, value, max, onCommit }: {
  label: string;
  value: number;
  max: number;
  onCommit: (pixels: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    if (draft === null) return;
    const parsed = Math.round(Number(draft));
    setDraft(null);
    if (!Number.isFinite(parsed) || draft.trim() === '') return;
    const pixels = clamp(parsed, CROP_MIN_PIXELS, max);
    if (pixels !== value) onCommit(pixels);
  }

  return (
    <label className="flex h-9 items-center gap-2 rounded-md border border-input px-2.5 text-xs text-muted-foreground focus-within:ring-2 focus-within:ring-primary">
      <span>{label}</span>
      <Input variant="bare"
        type="text"
        inputMode="numeric"
        aria-label={`裁剪${label}度（像素）`}
        value={draft ?? String(value)}
        onChange={event => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          commit();
        }}
        className="w-full min-w-0 bg-transparent text-right text-sm tabular-nums text-foreground outline-none"
      />
    </label>
  );
}

function SplitStage({
  mediaUrl,
  sourceWidth,
  sourceHeight,
  lines,
  onCommit,
  onChange,
}: {
  mediaUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  lines: SplitLines;
  onCommit: (lines: SplitLines) => void;
  onChange: (lines: SplitLines) => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ axis: SplitAxis; index: number } | null>(null);
  // 正在拖动或聚焦的切线：只有它显示离边缘的像素距离。手柄在切线的下端 / 右端，避开每块左上角的编号。
  const [activeLine, setActiveLine] = useState<{ axis: SplitAxis; index: number } | null>(null);
  const tiles = splitTiles(lines, sourceWidth, sourceHeight);

  function begin(axis: SplitAxis, index: number, event: ReactPointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointer.current = { axis, index };
    setActiveLine({ axis, index });
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

  function end() {
    pointer.current = null;
    setActiveLine(null);
  }

  function keyMove(axis: SplitAxis, index: number, key: string) {
    const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : key === 'ArrowRight' || key === 'ArrowDown' ? 1 : 0;
    if (!direction) return;
    const dimension = axis === 'vertical' ? sourceWidth : sourceHeight;
    const current = lines[axis][index];
    onCommit(moveSplitLine(lines, axis, index, current + direction * 4 / dimension, sourceWidth, sourceHeight));
  }

  function isActive(axis: SplitAxis, index: number) {
    return activeLine?.axis === axis && activeLine.index === index;
  }

  return (
    <div ref={previewRef} className="relative overflow-hidden" style={stageFrameStyle(sourceWidth, sourceHeight)}>
      <img src={mediaUrl} alt="切图预览" className="absolute inset-0 size-full object-contain" draggable={false} />
      {tiles.map(tile => (
        <span
          key={tile.number}
          aria-hidden="true"
          className={cn(STAGE_BADGE_CLASS, 'absolute m-2')}
          style={{ left: `${tile.left * 100}%`, top: `${tile.top * 100}%` }}
        >{tile.number}</span>
      ))}
      {lines.vertical.map((value, index) => (
        <button
          key={`vertical-${index}`}
          type="button"
          aria-label={`调整第 ${index + 1} 条竖向切线`}
          className="group absolute top-0 z-20 flex h-full w-4 -translate-x-1/2 cursor-col-resize justify-center focus-visible:outline-none"
          style={{ left: `${value * 100}%` }}
          onPointerDown={event => begin('vertical', index, event)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onFocus={() => setActiveLine({ axis: 'vertical', index })}
          onBlur={() => { if (!pointer.current) setActiveLine(null); }}
          onKeyDown={event => {
            if (!event.key.startsWith('Arrow')) return;
            event.preventDefault();
            keyMove('vertical', index, event.key);
          }}
        >
          <span className="block h-full w-0.5 bg-primary" />
          <span aria-hidden="true" className="absolute bottom-1 size-4 rounded-full border-2 border-background bg-primary group-focus-visible:ring-2 group-focus-visible:ring-primary" />
          {isActive('vertical', index) && (
            <span className={cn(STAGE_BADGE_CLASS, 'absolute bottom-7 bg-primary text-primary-foreground')}>{Math.round(value * sourceWidth)} px</span>
          )}
        </button>
      ))}
      {lines.horizontal.map((value, index) => (
        <button
          key={`horizontal-${index}`}
          type="button"
          aria-label={`调整第 ${index + 1} 条横向切线`}
          className="group absolute left-0 z-20 flex h-4 w-full -translate-y-1/2 cursor-row-resize items-center focus-visible:outline-none"
          style={{ top: `${value * 100}%` }}
          onPointerDown={event => begin('horizontal', index, event)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onFocus={() => setActiveLine({ axis: 'horizontal', index })}
          onBlur={() => { if (!pointer.current) setActiveLine(null); }}
          onKeyDown={event => {
            if (!event.key.startsWith('Arrow')) return;
            event.preventDefault();
            keyMove('horizontal', index, event.key);
          }}
        >
          <span className="block h-0.5 w-full bg-primary" />
          <span aria-hidden="true" className="absolute right-1 size-4 rounded-full border-2 border-background bg-primary group-focus-visible:ring-2 group-focus-visible:ring-primary" />
          {isActive('horizontal', index) && (
            <span className={cn(STAGE_BADGE_CLASS, 'absolute right-7 bg-primary text-primary-foreground')}>{Math.round(value * sourceHeight)} px</span>
          )}
        </button>
      ))}
    </div>
  );
}

function SplitControls({
  sourceWidth,
  sourceHeight,
  lines,
  canUndo,
  canRedo,
  onCommit,
  onUndo,
  onRedo,
}: {
  sourceWidth: number;
  sourceHeight: number;
  lines: SplitLines;
  canUndo: boolean;
  canRedo: boolean;
  onCommit: (lines: SplitLines) => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const rows = lines.horizontal.length + 1;
  const columns = lines.vertical.length + 1;
  const tiles = splitTiles(lines, sourceWidth, sourceHeight);
  const even = sameLines(lines, evenSplit(rows, columns));

  return (
    <>
      <fieldset>
        <legend className={PANEL_LABEL_CLASS}>常用</legend>
        <div className="grid grid-cols-4 gap-1.5">
          {SPLIT_PRESETS.map(preset => {
            const selected = preset.rows === rows && preset.columns === columns;
            return (
              <button
                key={`${preset.rows}x${preset.columns}`}
                type="button"
                aria-label={`${preset.rows} 行 ${preset.columns} 列`}
                aria-pressed={selected}
                className={cn(OPTION_TILE_CLASS, selected ? OPTION_TILE_ON_CLASS : OPTION_TILE_OFF_CLASS)}
                onClick={() => onCommit(evenSplit(preset.rows, preset.columns))}
              >
                <span
                  aria-hidden="true"
                  className="grid h-4 w-5 gap-0.5"
                  style={{ gridTemplateColumns: `repeat(${preset.columns}, minmax(0, 1fr))` }}
                >
                  {Array.from({ length: preset.rows * preset.columns }, (_, index) => (
                    <span key={index} className="rounded-sm bg-current opacity-60" />
                  ))}
                </span>
                {preset.rows}×{preset.columns}
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-2">
        <CountStepper label="行" value={rows} onChange={next => onCommit(evenSplit(next, columns))} />
        <CountStepper label="列" value={columns} onChange={next => onCommit(evenSplit(rows, next))} />
      </div>
      <div className="flex items-center">
        <button
          type="button"
          disabled={even}
          className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:underline disabled:pointer-events-none disabled:opacity-40"
          onClick={() => onCommit(evenSplit(rows, columns))}
        >
          恢复均分
        </button>
        <span className="ml-auto flex gap-1">
          <StepButton label="撤销切线调整" disabled={!canUndo} onClick={onUndo}><Undo2 aria-hidden="true" /></StepButton>
          <StepButton label="重做切线调整" disabled={!canRedo} onClick={onRedo}><Redo2 aria-hidden="true" /></StepButton>
        </span>
      </div>
      <div className="min-h-0">
        <p className={PANEL_LABEL_CLASS}>结果</p>
        <ul className="grid max-h-40 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 overflow-y-auto text-xs tabular-nums">
          {tiles.map(tile => (
            <li key={tile.number} className="contents">
              <span className="min-w-5 rounded-sm bg-secondary px-1.5 py-0.5 text-center text-muted-foreground">{tile.number}</span>
              <span>{tile.width} × {tile.height}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function CountStepper({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <div>
      <p className={PANEL_LABEL_CLASS}>{label}</p>
      <div className="flex h-9 items-center justify-between rounded-md border border-input px-1">
        <StepButton label={`减少${label}数`} disabled={value <= 1} onClick={() => onChange(value - 1)}><Minus aria-hidden="true" /></StepButton>
        <span aria-live="polite" className="text-sm tabular-nums">{value}</span>
        <StepButton label={`增加${label}数`} disabled={value >= SPLIT_MAX_COUNT} onClick={() => onChange(value + 1)}><Plus aria-hidden="true" /></StepButton>
      </div>
    </div>
  );
}

function StepButton({ label, disabled, onClick, children }: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

type SplitAxis = 'horizontal' | 'vertical';

/** 比例按钮上的形状示意：在 24×20 的格子里按比例画一个框。 */
function ratioGlyphSize(ratio: CropRatio, original: number) {
  const aspect = ratio === 'free' ? 1.25 : ratioValue(ratio, original) ?? 1;
  const width = Math.min(24, 20 * aspect);
  return { width, height: width / aspect };
}

/** 把某一边改成指定像素数，另一边与位置不动；起点对齐到整像素，保证换算回来正好是这个数。 */
function cropWithPixelSize(
  rect: NormalizedRect,
  key: 'width' | 'height',
  pixels: number,
  dimension: number,
): NormalizedRect {
  const originKey = key === 'width' ? 'x' : 'y';
  const start = Math.min(Math.round(rect[originKey] * dimension), dimension - pixels);
  return { ...rect, [originKey]: (start + 0.25) / dimension, [key]: (pixels - 0.5) / dimension };
}

function splitTiles(lines: SplitLines, width: number, height: number) {
  const xs = [0, ...lines.vertical, 1];
  const ys = [0, ...lines.horizontal, 1];
  const tiles: Array<{ number: number; left: number; top: number; width: number; height: number }> = [];
  for (let row = 0; row < ys.length - 1; row += 1) {
    for (let column = 0; column < xs.length - 1; column += 1) {
      tiles.push({
        number: tiles.length + 1,
        left: xs[column],
        top: ys[row],
        width: Math.round(xs[column + 1] * width) - Math.round(xs[column] * width),
        height: Math.round(ys[row + 1] * height) - Math.round(ys[row] * height),
      });
    }
  }
  return tiles;
}

function sameLines(a: SplitLines, b: SplitLines) {
  const close = (left: number[], right: number[]) => left.length === right.length
    && left.every((value, index) => Math.abs(value - right[index]) < 1e-6);
  return close(a.horizontal, b.horizontal) && close(a.vertical, b.vertical);
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

function cropPixelSize(rect: NormalizedRect, width: number, height: number) {
  return {
    width: Math.ceil((rect.x + rect.width) * width) - Math.floor(rect.x * width),
    height: Math.ceil((rect.y + rect.height) * height) - Math.floor(rect.y * height),
  };
}

function rectStyle(rect: NormalizedRect) {
  return { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` };
}

/** 四角 L 形、四边短条。 */
function cropHandleMark(handle: Exclude<CropHandle, 'move'>) {
  return {
    n: 'left-1/2 top-0 h-0.5 w-6 -translate-x-1/2 -translate-y-1/2 bg-foreground',
    s: 'bottom-0 left-1/2 h-0.5 w-6 -translate-x-1/2 translate-y-1/2 bg-foreground',
    e: 'right-0 top-1/2 h-6 w-0.5 -translate-y-1/2 translate-x-1/2 bg-foreground',
    w: 'left-0 top-1/2 h-6 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-foreground',
    nw: '-left-0.5 -top-0.5 size-3.5 border-l-2 border-t-2 border-foreground',
    ne: '-right-0.5 -top-0.5 size-3.5 border-r-2 border-t-2 border-foreground',
    sw: '-bottom-0.5 -left-0.5 size-3.5 border-b-2 border-l-2 border-foreground',
    se: '-bottom-0.5 -right-0.5 size-3.5 border-b-2 border-r-2 border-foreground',
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
  axis: SplitAxis,
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
