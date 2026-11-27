import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { PopoverContent } from '@/components/ui/popover';
import { canvasSplitAxis, equalSplitLines } from '@/pages/canvasEditorModel';
import type { CanvasMediaOperation } from '@/schema/canvas';

const GRID = 6;
const PRESETS = [[2, 2], [3, 3], [4, 3]] as const;

export function CanvasSplitGridPopover({ width, height, onSubmit, onCustom, onReturnFocus }: {
  width: number;
  height: number;
  onSubmit: (operation: Extract<CanvasMediaOperation, { kind: 'split' }>) => void;
  onCustom: () => void;
  onReturnFocus: () => void;
}) {
  const matrix = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(true);
  const label = useRef<HTMLParagraphElement>(null);
  const current = useRef({ cols: 0, rows: 0 });
  const cells = Array.from({ length: GRID * GRID }, (_, i) => ({ cols: i % GRID + 1, rows: Math.floor(i / GRID) + 1 }));
  function message(cols: number, rows: number) {
    if (cols * rows === 1) return '请选择至少 2 格';
    for (const [length, parts] of [[width, cols], [height, rows]]) {
      const cuts = canvasSplitAxis(equalSplitLines(parts), length);
      if (cuts.some((cut, i) => i > 0 && cut - cuts[i - 1] < 16)) return '每格至少需要 16 × 16 像素';
    }
    return '';
  }
  function highlight(cols: number, rows: number) {
    if (!matrix.current || !label.current) return;
    if (cols === current.current.cols && rows === current.current.rows) return;
    current.current = { cols, rows };
    const warning = message(cols, rows);
    label.current.textContent = [`${cols} × ${rows}`, warning].filter(Boolean).join(' · ');
    label.current.classList.toggle('text-destructive', Boolean(warning && cols * rows > 1));
    Array.from(matrix.current.children).forEach((cell, i) => {
      cell.setAttribute('data-active', String(i % GRID < cols && Math.floor(i / GRID) < rows));
      (cell as HTMLElement).tabIndex = i === (rows - 1) * GRID + cols - 1 ? 0 : -1;
    });
  }
  function submit(cols: number, rows: number) {
    highlight(cols, rows);
    if (message(cols, rows)) return;
    returnFocus.current = false;
    onSubmit({ kind: 'split', horizontal_lines: equalSplitLines(rows), vertical_lines: equalSplitLines(cols) });
  }
  return <PopoverContent side="top" align="center" sideOffset={8} aria-label="网格切分"
    className="nodrag w-56 rounded-xl border border-border bg-card p-3 shell-glow"
    onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => event.stopPropagation()}
    onEscapeKeyDown={event => event.stopPropagation()}
    onInteractOutside={() => { returnFocus.current = false; }}
    onOpenAutoFocus={event => {
      event.preventDefault();
      returnFocus.current = true;
      current.current = { cols: 0, rows: 0 };
      (matrix.current?.firstElementChild as HTMLElement | null)?.focus();
    }}
    onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current) onReturnFocus(); }}>
    <div className="mb-2 flex gap-1">
      {PRESETS.map(([cols, rows]) => <Button key={cols} variant="secondary" size="sm" className="flex-1 tabular-nums"
        aria-disabled={Boolean(message(cols, rows))} onPointerEnter={() => highlight(cols, rows)}
        onFocus={() => highlight(cols, rows)} onClick={() => submit(cols, rows)}>{cols}×{rows}</Button>)}
    </div>
    <div ref={matrix} role="group" aria-label="选择列数和行数" className="grid grid-cols-6 gap-1"
      onKeyDown={event => {
        const { cols, rows } = current.current;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          submit(cols, rows);
          return;
        }
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        const x = Math.max(1, Math.min(GRID, cols + delta[0]));
        const y = Math.max(1, Math.min(GRID, rows + delta[1]));
        (matrix.current?.children[(y - 1) * GRID + x - 1] as HTMLElement)?.focus();
        highlight(x, y);
      }}>
      {cells.map(({ cols, rows }, i) => <Button key={i} variant="solid" size="icon" tabIndex={i === 0 ? 0 : -1}
        className="size-6 rounded-sm border border-border bg-popover p-0 hover:bg-popover focus-visible:ring-1 data-[active=true]:border-primary data-[active=true]:bg-primary/20 data-[active=true]:hover:bg-primary/20"
        aria-label={`${cols} 列 ${rows} 行`} aria-disabled={Boolean(message(cols, rows))}
        onPointerEnter={() => highlight(cols, rows)} onFocus={() => highlight(cols, rows)}
        onClick={() => submit(cols, rows)} />)}
    </div>
    <p ref={label} aria-live="polite" className="my-2 text-xs tabular-nums text-muted-foreground">1 × 1 · 请选择至少 2 格</p>
    <div className="border-t border-border pt-1"><Button variant="ghost" size="sm" onClick={() => { returnFocus.current = false; onCustom(); }}>自定义切线…</Button></div>
  </PopoverContent>;
}
