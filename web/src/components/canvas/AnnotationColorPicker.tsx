import { useRef, useState } from 'react';
import { Pipette, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ANNOTATION_COLOR, ANNOTATION_PRESETS, clamp } from './imageAnnotation';
import { COLOR_PRESETS_KEY, colorHex, fromHsv, parseColor, toHsv, type Rgba } from './annotationColor';

type ScreenEyeDropper = { new(): { open(): Promise<{ sRGBHex: string }> } };

export function AnnotationColorPicker({ value, onChange, onClose }: { value: string; onChange: (value: string) => void; onClose: () => void }) {
  const initial = parseColor(value) ?? parseColor(ANNOTATION_COLOR)!;
  const [rgba, setRgba] = useState<Rgba>(initial);
  const [hsv, setHsv] = useState(() => toHsv(initial));
  const [hex, setHex] = useState(colorHex(initial));
  const [error, setError] = useState('');
  const [custom, setCustom] = useState<string[]>(() => {
    try { const saved: unknown = JSON.parse(localStorage.getItem(COLOR_PRESETS_KEY) ?? '[]'); return Array.isArray(saved) ? saved.filter((c): c is string => typeof c === 'string' && !!parseColor(c)).slice(0, 32) : []; }
    catch { return []; }
  });
  const colorBefore = useRef(value);
  const EyeDropper = (window as Window & { EyeDropper?: ScreenEyeDropper }).EyeDropper;
  function change(next: Rgba, nextHsv = toHsv(next)) {
    setRgba(next); setHsv(nextHsv); setHex(colorHex(next)); setError(''); onChange(colorHex(next));
  }
  function changeHsv(index: number, value: number) {
    const next: [number, number, number] = [...hsv]; next[index] = value;
    change(fromHsv(...next, rgba[3]), next);
  }
  function savePresets(next: string[]) {
    try { localStorage.setItem(COLOR_PRESETS_KEY, JSON.stringify(next)); setCustom(next); }
    catch { setError('无法保存预设，请检查浏览器存储空间。'); }
  }
  async function sample() {
    if (!EyeDropper) return;
    try { const result = await new EyeDropper().open(); const next = parseColor(result.sRGBHex); if (next) change([next[0], next[1], next[2], rgba[3]]); }
    catch (error) { if ((error as Error).name !== 'AbortError') setError('屏幕取色失败，请重试。'); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="annotation-color-dialog max-w-sm gap-4" onKeyDown={event => event.stopPropagation()}>
      <DialogTitle>颜色</DialogTitle><DialogDescription className="sr-only">色调、饱和度、亮度、RGBA、HTML 和保存的颜色预设。</DialogDescription>
      <div className="annotation-sv relative h-40 touch-none overflow-hidden rounded-md" style={{ backgroundColor: `hsl(${hsv[0]} 100% 50%)` }}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); const rect = event.currentTarget.getBoundingClientRect(); const next: [number, number, number] = [hsv[0], clamp((event.clientX - rect.left) / rect.width * 100, 0, 100), clamp(100 - (event.clientY - rect.top) / rect.height * 100, 0, 100)]; change(fromHsv(...next, rgba[3]), next); }}
        onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const rect = event.currentTarget.getBoundingClientRect(); const next: [number, number, number] = [hsv[0], clamp((event.clientX - rect.left) / rect.width * 100, 0, 100), clamp(100 - (event.clientY - rect.top) / rect.height * 100, 0, 100)]; change(fromHsv(...next, rgba[3]), next); }}>
        <span className="annotation-color-dot" style={{ left: `${hsv[1]}%`, top: `${100 - hsv[2]}%` }} />
      </div>
      <div className="space-y-2">
        {(['色调', '饱和度', '亮度'] as const).map((name, i) => <label key={name} className="flex items-center gap-3 text-xs">
          <span className="w-10">{name}</span><input aria-label={name} className={`min-w-0 flex-1 accent-primary ${i === 0 ? 'annotation-hue' : ''}`} type="range" min={0} max={i === 0 ? 360 : 100} value={hsv[i]} onChange={event => changeHsv(i, Number(event.target.value))} />
          <input aria-label={`${name}数值`} className="annotation-number w-14" type="number" min={0} max={i === 0 ? 360 : 100} value={Math.round(hsv[i])} onChange={event => changeHsv(i, clamp(Number(event.target.value), 0, i === 0 ? 360 : 100))} />
        </label>)}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {(['R', 'G', 'B', 'A'] as const).map((name, i) => <label key={name} className="space-y-1 text-xs text-muted-foreground">{name}
          <input aria-label={name} className="annotation-number w-full text-foreground" type="number" min={0} max={i === 3 ? 1 : 255} step={i === 3 ? 0.01 : 1} value={i === 3 ? Math.round(rgba[i] * 100) / 100 : Math.round(rgba[i])}
            onChange={event => { const next: Rgba = [...rgba]; next[i] = clamp(Number(event.target.value), 0, i === 3 ? 1 : 255); change(next); }} />
        </label>)}
      </div>
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs">HTML<input aria-label="HTML" value={hex} className="annotation-number min-w-0 flex-1 font-mono" maxLength={9}
          onChange={event => { setHex(event.target.value); const next = parseColor(event.target.value); if (next && [7, 9].includes(event.target.value.length)) { setRgba(next); setHsv(toHsv(next)); onChange(colorHex(next)); setError(''); } }}
          onBlur={() => { const next = parseColor(hex); if (next) change(next); else { setError('请输入有效的 HTML 色值。'); setHex(colorHex(rgba)); } }} /></label>
        <Button variant="outline" size="icon" aria-label="屏幕取色" title={EyeDropper ? '屏幕取色' : '当前浏览器不支持屏幕取色，请使用 Chrome 或 Edge'} disabled={!EyeDropper} onClick={() => void sample()}><Pipette /></Button>
      </div>
      <div className="flex gap-2"><span className="annotation-swatch h-8 flex-1 rounded-md" style={{ backgroundColor: colorBefore.current }} /><span className="annotation-swatch h-8 flex-1 rounded-md" style={{ backgroundColor: colorHex(rgba) }} /></div>
      <div className="flex flex-wrap gap-2" aria-label="颜色预设">
        {ANNOTATION_PRESETS.map(color => <button key={color} aria-label={`颜色 ${color}`} className="annotation-swatch size-7 rounded-sm border border-input focus-visible:ring-2 focus-visible:ring-ring" style={{ backgroundColor: color }} onClick={() => change(parseColor(color)!)} />)}
        {custom.map(color => <div key={color} className="group relative"><button aria-label={`自定义颜色 ${color}`} className="annotation-swatch size-7 rounded-sm border border-input focus-visible:ring-2 focus-visible:ring-ring" style={{ backgroundColor: color }} onClick={() => change(parseColor(color)!)} /><button className="absolute -right-1 -top-1 rounded-full border border-border bg-card p-0.5 opacity-0 focus:opacity-100 group-hover:opacity-100" aria-label={`删除预设 ${color}`} onClick={() => savePresets(custom.filter(c => c !== color))}><X className="size-3" /></button></div>)}
        <Button variant="outline" size="icon" className="size-7" aria-label="添加到颜色预设" title="添加到颜色预设" disabled={custom.length >= 32 || custom.includes(colorHex(rgba))} onClick={() => savePresets([...custom, colorHex(rgba)])}><Plus /></Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <Button className="ml-auto" onClick={onClose}>完成</Button>
    </DialogContent>
  </Dialog>;
}
