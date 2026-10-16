import { LoaderCircle, Maximize, Minus, Plus, X, type LucideIcon } from 'lucide-react';
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { KeyView } from '@/api/keys';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { CanvasGenerationDraft, CanvasImageEditEditorState, CanvasImageEditNode, CanvasImageEditSettings, CanvasMediaVersion } from '@/schema/canvas';

export interface CanvasMaskEditSubmission {
  mask: Blob | null;
  draft: CanvasGenerationDraft;
  requestedCount: number;
  options: CanvasImageEditSettings;
  editorState: CanvasImageEditEditorState;
  referenceNodeId: string | null;
  referenceVersionId: string | null;
}

export interface ImageEditorProps {
  open: boolean; title: string; version: CanvasMediaVersion; mediaUrl: string; keys: KeyView[];
  initialData?: CanvasImageEditNode['data'];
  busy: boolean; error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (submission: CanvasMaskEditSubmission) => Promise<boolean>;
  onSubmit: (submission: CanvasMaskEditSubmission) => Promise<boolean>;
}

const STAGE_PADDING = 48;

/** 舞台尺寸、缩放与平移；scale 是「屏幕像素 / 图片像素」。 */
export function useEditorViewport(target: { width: number; height: number }) {
  const observer = useRef<ResizeObserver | null>(null);
  const [stage, setStage] = useState({ width: 960, height: 600 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null);
  const measure = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!element) return;
    observer.current = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (rect?.width && rect.height) setStage({ width: rect.width, height: rect.height });
    });
    observer.current.observe(element);
  }, []);
  const fit = Math.min((stage.width - STAGE_PADDING * 2) / Math.max(1, target.width),
    (stage.height - STAGE_PADDING) / Math.max(1, target.height));
  const scale = Math.max(.01, fit * zoom);
  return {
    measure, stage, scale, pan,
    origin: { x: (stage.width - target.width * scale) / 2 + pan.x, y: (stage.height - target.height * scale) / 2 + pan.y },
    zoomBy: (factor: number) => setZoom(value => Math.min(8, Math.max(.25, value * factor))),
    reset: () => { setZoom(1); setPan({ x: 0, y: 0 }); },
    startPan(event: ReactPointerEvent) {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, pan };
    },
    movePan(event: ReactPointerEvent) {
      const current = drag.current;
      if (!current) return false;
      setPan({ x: current.pan.x + event.clientX - current.x, y: current.pan.y + event.clientY - current.y });
      return true;
    },
    endPan() { drag.current = null; },
  };
}

export type EditorViewport = ReturnType<typeof useEditorViewport>;

const glass = 'border border-border bg-glass backdrop-blur-glass';
export const editorIconButton = 'inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4';
export const editorChip = 'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-3 text-xs text-foreground';

export function ImageEditorShell({ open, heading, icon: Icon, viewport, busy, dirty, onClose, onAutoSave, onKeyDown, onKeyUp,
  toolbar, stage, composer, stageBottom = 'bottom-44' }: {
  open: boolean; heading: string; icon: LucideIcon; viewport: EditorViewport;
  busy: boolean; dirty: boolean; onClose: () => void;
  /** 关闭前自动保存未保存的修改；失败时留在编辑器里显示错误。 */
  onAutoSave: () => Promise<boolean>;
  onKeyDown?: (event: KeyboardEvent) => void; onKeyUp?: (event: KeyboardEvent) => void;
  toolbar?: ReactNode; stage: ReactNode; composer: ReactNode;
  /** 舞台底边，需要让出底部输入栏的高度。 */
  stageBottom?: string;
}) {
  async function requestClose() {
    if (busy) return;
    if (dirty && !await onAutoSave()) return;
    onClose();
  }
  return <>
    <Dialog open={open} onOpenChange={next => { if (!next) void requestClose(); }}>
      <DialogContent hideClose onKeyDown={onKeyDown} onKeyUp={onKeyUp}
        className="edit-dot-grid left-0 top-0 block h-dvh w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 bg-background p-0">
        <DialogDescription className="sr-only">{heading}：编辑完成后生成新的图片节点。</DialogDescription>
        <div ref={viewport.measure} className={`absolute inset-x-0 top-20 touch-none ${stageBottom}`}>{stage}</div>
        <div className={`absolute left-4 top-4 flex h-11 items-center gap-1.5 rounded-full pl-1 pr-4 ${glass}`}>
          <button type="button" aria-label="关闭编辑器" className={editorIconButton} disabled={busy} onClick={() => void requestClose()}><X /></button>
          <Icon className="size-4 text-primary" aria-hidden />
          <DialogTitle className="text-sm font-medium">{heading}</DialogTitle>
        </div>
        {toolbar && <div role="toolbar" aria-label={`${heading}工具`}
          className={`absolute left-1/2 top-4 flex h-11 -translate-x-1/2 items-center gap-0.5 whitespace-nowrap rounded-xl px-1 ${glass}`}>{toolbar}</div>}
        <div className={`absolute right-4 top-4 flex h-11 items-center gap-0.5 rounded-full px-1.5 ${glass}`}>
          <button type="button" aria-label="缩小" className={editorIconButton} onClick={() => viewport.zoomBy(1 / 1.25)}><Minus /></button>
          <span aria-label="编辑视图缩放" className="w-12 text-center font-mono text-xs">{Math.round(viewport.scale * 100)}%</span>
          <button type="button" aria-label="放大" className={editorIconButton} onClick={() => viewport.zoomBy(1.25)}><Plus /></button>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <button type="button" aria-label="适应窗口" className={editorIconButton} onClick={viewport.reset}><Maximize /></button>
        </div>
        <section aria-label={`${heading}设置与生成`}
          className={`absolute bottom-4 left-1/2 flex w-[min(760px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-3 rounded-2xl p-3.5 ${glass}`}>
          {composer}
        </section>
      </DialogContent>
    </Dialog>
  </>;
}

/** 提示词 + 操作行；blocker 非空时生成置灰，并在按钮左侧写出缺什么。 */
export function EditorComposer({ prompt, onPrompt, placeholder, chips, blocker, error, cost, busy, generateLabel,
  onGenerate, children }: {
  prompt: string; onPrompt: (value: string) => void; placeholder: string; chips: ReactNode;
  blocker: string | null; error: string | null; cost: number | null; busy: boolean; generateLabel: string;
  onGenerate: () => void; children?: ReactNode;
}) {
  return <fieldset disabled={busy} className="contents">
    {children}
    <textarea aria-label="编辑提示词" rows={2} value={prompt} placeholder={placeholder}
      className="block w-full resize-none border-0 bg-transparent px-1 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
      onChange={event => onPrompt(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!blocker) onGenerate(); } }} />
    {error && <p role="alert" className="px-1 text-xs text-destructive">{error}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {chips}
      <span role="status" className="ml-auto text-xs text-muted-foreground">{blocker ?? (cost == null ? '费用以供应商结算为准' : `预计 ¥${Number(cost.toFixed(4))}`)}</span>
      <button type="button" disabled={Boolean(blocker)} onClick={onGenerate}
        className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
        {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}{busy ? '提交中…' : generateLabel}
        {!busy && <span className="font-mono text-xs opacity-65" aria-hidden>⌘↵</span>}
      </button>
    </div>
  </fieldset>;
}

export function isTypingTarget(target: EventTarget) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}
