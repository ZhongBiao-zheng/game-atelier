import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CollapseIcon } from '@/components/ui/icons';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { motionAvailable, prefersReducedMotion } from '@/lib/motion';
import { useEditorViewport } from '../ImageEditorShell';
import { AnnotationEditingLayer } from './AnnotationEditingLayer';
import { AnnotationToolbar, type AnnotationToolbarProps } from './AnnotationToolbar';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

type FullscreenProps = AnnotationToolbarProps & {
  title: string; src: string; width: number; height: number; onCollapse: () => void;
  /** 顶栏右侧缩放比例前的额外操作（共享画布的手动保存）。 */
  actions?: ReactNode;
};

/** 鼠标滚轮一格（deltaY≈100）约合 22% 的缩放；一次跳到位显得生硬，分几帧走完（约 180ms），每帧取剩余的 35%。
 *  触控板的连续小增量本来就跟手，直接应用。 */
const WHEEL_ZOOM_PER_PIXEL = .002;
const SMOOTH_ZOOM_THRESHOLD = .05;
const SMOOTH_ZOOM_FRACTION = .35;

/** 全屏标注。open 受控、由节点常驻挂载：收起时 Radix 等退场动画播完才卸载内容，不再一关就没。
 *  整层铺满视口，只做淡入淡出，不缩放（缩放会连标题与工具条一起放大缩小）。 */
export function AnnotationFullscreen({ open, ...props }: FullscreenProps & { open: boolean }) {
  return <Dialog open={open} onOpenChange={next => { if (!next) props.onCollapse(); }}>
    <DialogContent hideClose
      className="fixed inset-0 z-50 block h-dvh w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 bg-background p-0 [--dialog-scale-in:1] [--dialog-scale-out:1]"
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <AnnotationFullscreenBody {...props} />
    </DialogContent>
  </Dialog>;
}

function AnnotationFullscreenBody({ title, src, width, height, onCollapse, actions, ...toolbar }: FullscreenProps) {
  const viewport = useEditorViewport({ width, height });
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const measure = viewport.measure;
  const measureStage = useCallback((element: HTMLDivElement | null) => { setStage(element); measure(element); }, [measure]);
  const viewportRef = useRef(viewport); viewportRef.current = viewport;
  useEffect(() => {
    const element = stage; if (!element) return;
    const pending = { log: 0, frame: 0 };
    const step = () => {
      const remaining = pending.log;
      const part = Math.abs(remaining) < .002 ? remaining : remaining * SMOOTH_ZOOM_FRACTION;
      pending.log = remaining - part;
      viewportRef.current.zoomBy(Math.exp(part));
      pending.frame = pending.log ? requestAnimationFrame(step) : 0;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
      const log = -delta * WHEEL_ZOOM_PER_PIXEL;
      if (!motionAvailable() || prefersReducedMotion() || Math.abs(log) < SMOOTH_ZOOM_THRESHOLD) {
        viewportRef.current.zoomBy(Math.exp(log));
        return;
      }
      pending.log += log;
      if (!pending.frame) pending.frame = requestAnimationFrame(step);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', wheel);
      if (pending.frame) cancelAnimationFrame(pending.frame);
    };
  }, [stage]);
  const endPan = () => { viewport.endPan(); setDragging(false); };
  return <>
    <DialogDescription className="sr-only">全屏标注</DialogDescription>
    <header className="desktop-clear-top absolute inset-x-4 top-4 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <Hint label="收起 Esc"><Button variant="bare" type="button" aria-label="收起" className="grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground" onClick={onCollapse}><CollapseIcon size="lg" /></Button></Hint>
        <DialogTitle className="text-sm font-medium">{title}</DialogTitle>
        <span className="text-xs tabular-nums text-muted-foreground">{width} × {height}</span>
      </div>
      <div className="flex items-center gap-3">
        {actions}
        <span className="text-xs tabular-nums text-muted-foreground" aria-label="标注缩放">{Math.round(viewport.scale * 100)}%</span>
      </div>
    </header>
    <div ref={measureStage} className="desktop-clear-top absolute inset-x-0 bottom-24 top-16 overflow-hidden touch-none"
      style={{ cursor: dragging ? 'grabbing' : toolbar.editor.panning ? 'grab' : undefined }}
      onPointerDown={event => { if (toolbar.editor.panning || event.button === 1) { viewport.startPan(event); setDragging(true); } }}
      onPointerMove={viewport.movePan} onPointerUp={endPan} onPointerCancel={endPan}>
      <div className="absolute overflow-hidden rounded-sm" style={{ left: viewport.origin.x, top: viewport.origin.y, width: width * viewport.scale, height: height * viewport.scale }}>
        <img src={src} alt={title} draggable={false} className="block size-full select-none" />
        <AnnotationEditingLayer editor={toolbar.editor} width={width} height={height} fit="contain" />
      </div>
    </div>
    <div className="absolute bottom-5 left-1/2 -translate-x-1/2"><AnnotationToolbar {...toolbar} /></div>
  </>;
}
