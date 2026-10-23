import { Bold, Circle, Download, Eraser, Highlighter, Italic, LoaderCircle, Maximize, Pencil, Redo2, Scan, Shapes, Spline, Square, Type, Undo2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { canvasMediaUrl } from '@/api/canvas';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { CanvasImageAnnotation, CanvasMediaVersion } from '@/schema/canvas';
import { ANNOTATION_COLOR, ANNOTATION_FONTS, clamp, exportAnnotation, loadAnnotationSource, restoreAnnotation, serializeAnnotation, type AnnotationElement, type AnnotationTool } from './imageAnnotation';
import { AnnotationColorPicker } from './AnnotationColorPicker';
import { AnnotationSurface, applySettings, type AnnotationSettings, type AnnotationSurfaceHandle } from './AnnotationSurface';
import './annotationEditor.css';

export interface AnnotationSubmission { image: Blob; elements: CanvasImageAnnotation['elements']; prompt: string }
const TOOLS = [
  ['shape', '矩形/椭圆', Shapes], ['line', '折线', Spline], ['pen', '画笔', Pencil], ['marker', '记号笔', Highlighter],
  ['mosaic', '马赛克/模糊', Scan], ['text', '文本', Type], ['eraser', '橡皮擦', Eraser],
] as const;
const DEFAULTS: AnnotationSettings = { strokeWidth: 3, color: ANNOTATION_COLOR, fill: false, shape: 'rectangle', lineStyle: 'arrow', curved: false, region: false, effect: 'pixelate', blockSize: 16, fontFamily: 'sans-serif', fontSize: 28, bold: false, italic: false, outline: false };
function elementTool(e: AnnotationElement): AnnotationTool {
  return e.type === 'freedraw' ? 'pen' : ['rectangle', 'ellipse', 'diamond'].includes(e.type) ? 'shape' : e.type === 'arrow' ? 'line' : e.type === 'erase' ? 'eraser' : e.type as AnnotationTool;
}

export default function CanvasAnnotationEditor({ projectId, title, source, initial, onClose, onSave }: {
  projectId: string; title: string; source: CanvasMediaVersion; initial?: CanvasImageAnnotation | null;
  onClose: () => void; onSave: (submission: AnnotationSubmission, edit: boolean) => Promise<boolean>;
}) {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadAnnotationSource>> | null>(null);
  const [elements, setElements] = useState(() => restoreAnnotation(initial)), scene = useRef(elements);
  const savedScene = useRef(JSON.stringify(elements)), past = useRef<AnnotationElement[][]>([]), future = useRef<AnnotationElement[][]>([]);
  const lastGroup = useRef({ key: '', at: 0 });
  const [tool, setTool] = useState<AnnotationTool>('pen'), [selected, setSelected] = useState<string | null>(null);
  const [options, setOptions] = useState<Record<AnnotationTool, AnnotationSettings>>(() => Object.fromEntries(TOOLS.map(([id]) => [id, { ...DEFAULTS, strokeWidth: id === 'marker' ? 24 : id === 'eraser' || id === 'mosaic' ? 40 : 3 }])) as Record<AnnotationTool, AnnotationSettings>);
  const settings = options[tool], selectedRef = useRef(selected); selectedRef.current = selected;
  const [prompt, setPrompt] = useState(initial?.prompt ?? ''), savedPrompt = useRef(prompt);
  const [busy, setBusy] = useState(false), saving = useRef(false);
  const [error, setError] = useState<string | null>(null), [closeChoice, setCloseChoice] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const surface = useRef<AnnotationSurfaceHandle>(null);
  const [controls, setControls] = useState<HTMLDivElement | null>(null);
  const sizeCallback = useRef<(delta: number) => void>(() => {});

  useEffect(() => {
    const controller = new AbortController();
    void loadAnnotationSource(canvasMediaUrl(projectId, source.version_id), controller.signal)
      .then(result => { if (!controller.signal.aborted) setLoaded(result); })
      .catch(error => { if (!controller.signal.aborted) setError((error as Error).message); });
    return () => controller.abort();
  }, [projectId, source.version_id]);
  useEffect(() => {
    const host = controls;
    if (!host) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.target as HTMLElement).closest('[data-brush-size]')) return;
      event.preventDefault(); sizeCallback.current(event.deltaY < 0 ? 1 : -1);
    };
    host.addEventListener('wheel', wheel, { passive: false }); return () => host.removeEventListener('wheel', wheel);
  }, [controls]);

  function commit(next: AnnotationElement[], group = '') {
    if (JSON.stringify(next) === JSON.stringify(scene.current)) return;
    const now = Date.now();
    if (!group || lastGroup.current.key !== group || now - lastGroup.current.at > 600) past.current = [...past.current.slice(-49), scene.current];
    lastGroup.current = { key: group, at: now }; future.current = []; scene.current = next; setElements(next);
  }
  function select(id: string | null) {
    setSelected(id); selectedRef.current = id;
    const e = scene.current.find(e => e.id === id); if (!e) return;
    const nextTool = elementTool(e); setTool(nextTool);
    setOptions(previous => ({ ...previous, [nextTool]: { ...previous[nextTool], strokeWidth: e.strokeWidth, color: e.strokeColor, fill: e.backgroundColor !== 'transparent',
      ...(e.type === 'rectangle' || e.type === 'ellipse' ? { shape: e.type } : {}),
      ...(e.type === 'line' || e.type === 'arrow' ? { lineStyle: e.lineStyle ?? 'arrow', curved: !!e.controls?.length } : {}),
      ...(e.type === 'text' ? { fontFamily: typeof e.fontFamily === 'string' ? e.fontFamily : 'sans-serif', fontSize: e.fontSize ?? 28, bold: !!e.bold, italic: !!e.italic, outline: !!e.outline } : {}),
    } }));
  }
  function update(patch: Partial<AnnotationSettings>, group = 'settings') {
    const next = { ...settings, ...patch }; setOptions(previous => ({ ...previous, [tool]: next }));
    if (selectedRef.current) commit(scene.current.map(e => e.id === selectedRef.current ? applySettings(e, next) : e), group);
  }
  sizeCallback.current = delta => {
    if (busy) return;
    if (tool === 'text') update({ fontSize: clamp(settings.fontSize + delta, 8, 300) }, 'size');
    else update({ strokeWidth: clamp(settings.strokeWidth + delta * (settings.strokeWidth >= 20 ? 2 : 1), 1, 200) }, 'size');
  };
  function switchTool(next: AnnotationTool) { surface.current?.finish(); select(null); setTool(next); }
  function history(redo: boolean) {
    surface.current?.finish();
    const from = redo ? future : past, to = redo ? past : future;
    const next = from.current.at(-1); if (!next) return;
    from.current = from.current.slice(0, -1); to.current = [...to.current, scene.current]; lastGroup.current = { key: '', at: 0 };
    scene.current = next; setElements(next); select(null);
  }
  function requestClose() {
    if (saving.current) return;
    surface.current?.finish();
    if (JSON.stringify(scene.current) !== savedScene.current || prompt !== savedPrompt.current) setCloseChoice(true); else onClose();
  }
  async function save(edit: boolean, download = false) {
    if (!loaded || saving.current) return;
    surface.current?.finish(); saving.current = true; setBusy(true); setError(null);
    try {
      const elements = serializeAnnotation(scene.current), image = await exportAnnotation(loaded.image, scene.current);
      if (download) {
        const url = URL.createObjectURL(image), anchor = document.createElement('a'); anchor.href = url; anchor.download = `${title}-标注.png`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (await onSave({ image, elements, prompt: prompt.trim() }, edit)) onClose();
    } catch (error) { setError((error as Error).message); }
    finally { saving.current = false; setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) requestClose(); }}>
    <DialogContent hideClose className="annotation-dialog left-0 top-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0"
      onEscapeKeyDown={event => event.preventDefault()}
      onKeyDownCapture={event => { if (busy) { event.preventDefault(); event.stopPropagation(); } }}
      onKeyDown={event => {
        event.stopPropagation();
        if ((event.target as HTMLElement).closest('input,textarea,select') || colorOpen) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); history(event.shiftKey); }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); history(true); }
      }}>
      <DialogDescription className="sr-only">选择工具，在图片上标注。滚轮调整画笔大小，按住空格拖动画布。保存后可继续编辑或去改图。</DialogDescription>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5">
        <Button variant="ghost" size="icon" aria-label="关闭标注" disabled={busy} onClick={requestClose}><X /></Button>
        <DialogTitle className="text-sm font-medium">标注</DialogTitle>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{title}</span>
        <Button variant="ghost" size="icon" aria-label="适应图片" title="适应图片" disabled={!loaded || busy} onClick={() => surface.current?.fit()}><Maximize /></Button>
        <Button variant="ghost" size="icon" aria-label="下载标注图" title="下载标注图" disabled={!loaded || busy} onClick={() => void save(false, true)}><Download /></Button>
      </header>
      <div className="shrink-0 border-b border-border bg-card">
        <div role="toolbar" aria-label="标注工具" className="flex items-center justify-center gap-1 overflow-x-auto px-2 py-2 sm:gap-2">
          {TOOLS.map(([id, name, Icon]) => <Button key={id} variant="ghost" aria-label={name} aria-pressed={tool === id} title={name} disabled={busy} onClick={() => switchTool(id)} className={`h-9 shrink-0 gap-2 px-2 sm:px-3 ${tool === id ? 'bg-secondary text-foreground' : 'text-muted-foreground'}`}><Icon className="size-4" /><span className="hidden text-xs md:inline">{name}</span></Button>)}
          <span className="mx-1 h-5 w-px shrink-0 bg-border" />
          <Button variant="ghost" size="icon" aria-label="撤回" title="撤回（⌘/Ctrl Z）" disabled={busy || !past.current.length} onClick={() => history(false)}><Undo2 /></Button>
          <Button variant="ghost" size="icon" aria-label="重做" title="重做（⌘/Ctrl Shift Z）" disabled={busy || !future.current.length} onClick={() => history(true)}><Redo2 /></Button>
        </div>
        <div ref={setControls} aria-label="工具参数" className={`flex min-h-12 flex-wrap items-center justify-center gap-3 border-t border-border px-3 py-2 text-xs ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          {tool !== 'text' && <label data-brush-size className="flex items-center gap-2" title="滚轮调整画笔大小"><span className="annotation-size-preview grid size-6 place-items-center overflow-hidden"><i className="block rounded-full bg-foreground" style={{ width: Math.min(20, settings.strokeWidth), height: Math.min(20, settings.strokeWidth) }} /></span><input type="range" aria-label="画笔大小" min={1} max={200} value={settings.strokeWidth} className="w-20 accent-primary" onChange={event => update({ strokeWidth: Number(event.target.value) }, 'size')} /><input type="number" aria-label="画笔大小数值" min={1} max={200} value={settings.strokeWidth} className="annotation-number w-14" onChange={event => update({ strokeWidth: clamp(Number(event.target.value), 1, 200) }, 'size')} /></label>}
          {tool === 'shape' && <div className="flex gap-1"><Button variant="ghost" size="icon" aria-label="矩形" title="矩形" aria-pressed={settings.shape === 'rectangle'} className={settings.shape === 'rectangle' ? 'bg-secondary' : ''} onClick={() => update({ shape: 'rectangle' })}><Square /></Button><Button variant="ghost" size="icon" aria-label="椭圆" title="椭圆" aria-pressed={settings.shape === 'ellipse'} className={settings.shape === 'ellipse' ? 'bg-secondary' : ''} onClick={() => update({ shape: 'ellipse' })}><Circle /></Button></div>}
          {(tool === 'shape' || tool === 'marker') && <label className="flex items-center gap-2"><input type="checkbox" className="accent-primary" checked={settings.fill} onChange={event => update({ fill: event.target.checked })} />填充</label>}
          {tool === 'line' && <><select aria-label="线段类型" className="annotation-select" value={settings.lineStyle} onChange={event => update({ lineStyle: event.target.value as AnnotationSettings['lineStyle'] })}><option value="line">直线</option><option value="arrow">普通箭头</option><option value="wide">宽箭头</option><option value="hollow">空心箭头</option></select><label className="flex items-center gap-2"><input type="checkbox" className="accent-primary" checked={settings.curved} onChange={event => update({ curved: event.target.checked })} />控制点</label></>}
          {(tool === 'mosaic' || tool === 'eraser') && <label className="flex items-center gap-2"><input type="checkbox" className="accent-primary" checked={settings.region} onChange={event => update({ region: event.target.checked })} />{tool === 'mosaic' ? '框选填充' : '框选模式'}</label>}
          {tool === 'mosaic' && <><select aria-label="马赛克方式" className="annotation-select" value={settings.effect} onChange={event => update({ effect: event.target.value as 'pixelate' | 'blur' })}><option value="pixelate">马赛克</option><option value="blur">模糊</option></select><label className="flex items-center gap-2">{settings.effect === 'blur' ? '模糊强度' : '马赛克大小'}<input type="number" aria-label={settings.effect === 'blur' ? '模糊强度' : '马赛克大小'} min={2} max={100} value={settings.blockSize} className="annotation-number w-14" onChange={event => update({ blockSize: clamp(Number(event.target.value), 2, 100) })} /></label></>}
          {tool === 'text' && <><Button variant="ghost" size="icon" aria-label="粗体" title="粗体" aria-pressed={settings.bold} className={settings.bold ? 'bg-secondary' : ''} onClick={() => update({ bold: !settings.bold })}><Bold /></Button><Button variant="ghost" size="icon" aria-label="斜体" title="斜体" aria-pressed={settings.italic} className={settings.italic ? 'bg-secondary' : ''} onClick={() => update({ italic: !settings.italic })}><Italic /></Button><label className="flex items-center gap-2"><input type="checkbox" className="accent-primary" checked={settings.outline} onChange={event => update({ outline: event.target.checked })} />描边</label><select aria-label="字体" className="annotation-select" value={settings.fontFamily} onChange={event => update({ fontFamily: event.target.value })}>{ANNOTATION_FONTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><label data-brush-size className="flex items-center gap-2">字号<input type="number" aria-label="字号" min={8} max={300} value={settings.fontSize} className="annotation-number w-14" onChange={event => update({ fontSize: clamp(Number(event.target.value), 8, 300) }, 'size')} /></label></>}
          {!['mosaic', 'eraser'].includes(tool) && <button className="flex h-8 items-center gap-2 rounded-md border border-input px-2 focus-visible:ring-2 focus-visible:ring-ring" aria-label="颜色选择" title="颜色选择" onClick={() => { surface.current?.finish(); setColorOpen(true); }}><span className="annotation-swatch size-5 rounded-sm border border-border" style={{ backgroundColor: settings.color }} /><span>颜色</span></button>}
        </div>
      </div>
      {loaded ? <AnnotationSurface ref={surface} image={loaded.image} elements={elements} tool={tool} settings={settings} selected={selected} onSelect={select} onCommit={commit} onSize={delta => sizeCallback.current(delta)} disabled={busy || colorOpen} /> : <div role="status" className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">{error ? '图片未能加载' : '正在加载图片…'}</div>}
      <footer className="shrink-0 border-t border-border bg-card p-3 sm:px-5">
        {error && <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>}
        {closeChoice ? <div className="flex flex-wrap items-center justify-end gap-2"><span className="mr-auto text-sm">保留这次标注？</span><Button variant="ghost" disabled={busy} onClick={() => setCloseChoice(false)}>继续编辑</Button><Button variant="outline" disabled={busy} onClick={onClose}>放弃修改</Button><Button disabled={busy || !loaded} onClick={() => void save(false)}>保存标注</Button></div> : <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <textarea aria-label="标注改图要求" value={prompt} maxLength={20000} rows={2} disabled={busy} onChange={event => setPrompt(event.target.value)} placeholder="补充改图要求（可选）" className="min-w-0 basis-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring sm:flex-1 sm:basis-auto" />
          <Button variant="outline" disabled={busy || !loaded} onClick={() => void save(false)}>保存标注</Button><Button disabled={busy || !loaded} onClick={() => void save(true)}>{busy && <LoaderCircle className="animate-spin" />}去改图</Button>
        </div>}
      </footer>
      {colorOpen && <AnnotationColorPicker value={settings.color} onChange={color => update({ color }, 'color')} onClose={() => setColorOpen(false)} />}
    </DialogContent>
  </Dialog>;
}
