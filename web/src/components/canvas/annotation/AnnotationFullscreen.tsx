import { useCallback, useEffect, useRef, useState } from 'react';
import { Minimize2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useEditorViewport } from '../ImageEditorShell';
import { AnnotationEditingLayer } from './AnnotationEditingLayer';
import { AnnotationToolbar, type AnnotationToolbarProps } from './AnnotationToolbar';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
export function AnnotationFullscreen({ title, src, width, height, onCollapse, ...toolbar }: AnnotationToolbarProps & {
  title: string; src: string; width: number; height: number; onCollapse: () => void;
}) {
  const viewport = useEditorViewport({ width, height });
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const measure = viewport.measure;
  const measureStage = useCallback((element: HTMLDivElement | null) => { setStage(element); measure(element); }, [measure]);
  const viewportRef = useRef(viewport); viewportRef.current = viewport;
  useEffect(() => {
    const element = stage; if (!element) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); viewportRef.current.zoomBy(Math.exp(-event.deltaY * .002)); };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [stage]);
  return <Dialog open onOpenChange={open => { if (!open) onCollapse(); }}>
    <DialogContent hideClose className="fixed inset-0 z-50 block h-dvh w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 bg-background p-0"
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
      <DialogDescription className="sr-only">全屏标注</DialogDescription>
      <header className="absolute inset-x-4 top-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Hint label="收起 Esc"><Button variant="bare" type="button" aria-label="收起" className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={onCollapse}><Minimize2 size={18} /></Button></Hint>
          <DialogTitle className="text-sm font-medium">{title}</DialogTitle>
          <span className="text-xs tabular-nums text-muted-foreground">{width} × {height}</span>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground" aria-label="标注缩放">{Math.round(viewport.scale * 100)}%</span>
      </header>
      <div ref={measureStage} className="absolute inset-x-0 bottom-24 top-16 overflow-hidden touch-none"
        style={{ cursor: toolbar.editor.panning ? 'grab' : undefined }}
        onPointerDown={event => { if (toolbar.editor.panning || event.button === 1) viewport.startPan(event); }}
        onPointerMove={viewport.movePan} onPointerUp={viewport.endPan} onPointerCancel={viewport.endPan}>
        <div className="absolute overflow-hidden rounded-sm" style={{ left: viewport.origin.x, top: viewport.origin.y, width: width * viewport.scale, height: height * viewport.scale }}>
          <img src={src} alt={title} draggable={false} className="block size-full select-none" />
          <AnnotationEditingLayer editor={toolbar.editor} width={width} height={height} fit="contain" />
        </div>
      </div>
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2"><AnnotationToolbar {...toolbar} /></div>
    </DialogContent>
  </Dialog>;
}
