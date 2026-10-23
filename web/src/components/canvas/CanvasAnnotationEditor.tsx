import { CaptureUpdateAction, Excalidraw, MainMenu } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { Download, LoaderCircle, Maximize, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { canvasMediaUrl } from '@/api/canvas';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useTheme } from '@/lib/theme';
import type { CanvasImageAnnotation, CanvasMediaVersion } from '@/schema/canvas';
import { ANNOTATION_COLOR, annotationElements, exportAnnotation, loadAnnotationSource, restoreAnnotation, serializeAnnotation } from './imageAnnotation';
import '@excalidraw/excalidraw/index.css';
import './annotationEditor.css';

(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';

export interface AnnotationSubmission {
  image: Blob;
  elements: CanvasImageAnnotation['elements'];
  prompt: string;
}

export default function CanvasAnnotationEditor({ projectId, title, source, initial, onClose, onSave }: {
  projectId: string; title: string; source: CanvasMediaVersion; initial?: CanvasImageAnnotation | null;
  onClose: () => void;
  onSave: (submission: AnnotationSubmission, edit: boolean) => Promise<boolean>;
}) {
  const theme = useTheme();
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadAnnotationSource>> | null>(null);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const initialElements = useRef(restoreAnnotation(initial));
  const savedScene = useRef(JSON.stringify(initialElements.current));
  const savedPrompt = useRef(prompt);
  const saving = useRef(false);
  const [closeChoice, setCloseChoice] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadAnnotationSource(canvasMediaUrl(projectId, source.version_id), controller.signal)
      .then(result => { if (!controller.signal.aborted) setLoaded(result); })
      .catch(error => { if (!controller.signal.aborted) setError((error as Error).message); });
    return () => controller.abort();
  }, [projectId, source.version_id]);

  useEffect(() => {
    if (!api || !loaded) return;
    const frame = requestAnimationFrame(() => api.scrollToContent(loaded.source, { fitToContent: true, maxZoom: 1, animate: false }));
    return () => cancelAnimationFrame(frame);
  }, [api, loaded]);

  function requestClose() {
    if (saving.current) return;
    if (dirty || prompt !== savedPrompt.current) setCloseChoice(true);
    else onClose();
  }

  async function save(edit: boolean, download = false) {
    if (!api || !loaded || saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try {
      const elements = serializeAnnotation(api.getSceneElements());
      const image = await exportAnnotation(loaded.source, api.getSceneElements(), loaded.files);
      if (download) {
        const url = URL.createObjectURL(image);
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${title}-标注.png`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (await onSave({ image, elements, prompt: prompt.trim() }, edit)) onClose();
    } catch (error) { setError((error as Error).message); }
    finally { saving.current = false; setBusy(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open) requestClose(); }}>
    <DialogContent hideClose className="annotation-dialog left-0 top-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0"
      onEscapeKeyDown={event => { event.preventDefault(); }}
      onKeyDownCapture={event => { if (busy) { event.preventDefault(); event.stopPropagation(); } }}
      onKeyDown={event => { event.stopPropagation(); }}>
      <DialogDescription className="sr-only">在图片上手绘、添加图形、箭头和文字，保存后可继续编辑或用于改图。</DialogDescription>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5">
        <Button variant="ghost" size="icon" aria-label="关闭标注" disabled={busy} onClick={requestClose}><X /></Button>
        <Pencil className="size-4 text-primary" aria-hidden />
        <DialogTitle className="text-sm font-medium">标注</DialogTitle>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{title}</span>
        <Button variant="ghost" size="icon" aria-label="适应图片" disabled={!api || busy} onClick={() => loaded && api?.scrollToContent(loaded.source, { fitToContent: true, maxZoom: 1 })}><Maximize /></Button>
        <Button variant="ghost" size="icon" aria-label="下载标注图" disabled={!api || busy} onClick={() => void save(false, true)}><Download /></Button>
      </header>
      <div className={`annotation-stage relative min-h-0 flex-1 ${busy ? 'pointer-events-none' : ''}`} onContextMenu={event => event.preventDefault()}>
        {loaded ? <Excalidraw excalidrawAPI={setApi} langCode="zh-CN" theme={theme} autoFocus handleKeyboardGlobally={false}
          initialData={{ elements: [loaded.source, ...initialElements.current], files: loaded.files,
            appState: { viewBackgroundColor: 'transparent', currentItemStrokeColor: ANNOTATION_COLOR, currentItemStrokeWidth: 2,
              currentItemRoughness: 0, currentItemFontFamily: 2, activeTool: { type: 'freedraw', customType: null, locked: false, lastActiveTool: null }, } }}
          UIOptions={{ tools: { image: false }, canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, toggleTheme: false, saveAsImage: false } }}
          validateEmbeddable={false} onLinkOpen={(_, event) => event.preventDefault()}
          onPaste={data => !data.files?.length && !data.elements?.some(element => !['freedraw', 'rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text'].includes(element.type))}
          onChange={(elements, state) => {
            if (state.openSidebar) api?.updateScene({ appState: { openSidebar: null }, captureUpdate: CaptureUpdateAction.NEVER });
            const original = elements.find(element => element.id === loaded.source.id);
            const invalid = elements.some(element => element.id !== loaded.source.id && !element.isDeleted && !['freedraw', 'rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text'].includes(element.type));
            if (!original || original.isDeleted || !original.locked || original.x !== 0 || original.y !== 0 || original.width !== loaded.width || original.height !== loaded.height || original.angle !== 0 || invalid || elements[0]?.id !== loaded.source.id) {
              api?.updateScene({ elements: [loaded.source, ...annotationElements(elements)], captureUpdate: CaptureUpdateAction.NEVER });
            }
            setDirty(JSON.stringify(annotationElements(elements)) !== savedScene.current);
          }}>
          <MainMenu><MainMenu.DefaultItems.Help /></MainMenu>
        </Excalidraw> : <div role="status" className="grid h-full place-items-center text-sm text-muted-foreground">{error ? '图片未能加载' : '正在加载标注工具…'}</div>}
      </div>
      <footer className="shrink-0 border-t border-border bg-card p-3 sm:px-5">
        {error && <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>}
        {closeChoice ? <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-sm">保留这次标注？</span>
          <Button variant="ghost" disabled={busy} onClick={() => setCloseChoice(false)}>继续编辑</Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>放弃修改</Button>
          <Button disabled={busy || !api} onClick={() => void save(false)}>保存标注</Button>
        </div> : <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <textarea aria-label="标注改图要求" value={prompt} maxLength={20000} rows={2} disabled={busy}
            onChange={event => setPrompt(event.target.value)} placeholder="补充改图要求（可选）"
            className="min-w-0 basis-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring sm:flex-1 sm:basis-auto" />
          <Button variant="outline" disabled={busy || !api} onClick={() => void save(false)}>保存标注</Button>
          <Button disabled={busy || !api} onClick={() => void save(true)}>{busy && <LoaderCircle className="animate-spin" />}去改图</Button>
        </div>}
      </footer>
    </DialogContent>
  </Dialog>;
}
