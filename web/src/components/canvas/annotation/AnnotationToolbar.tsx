import { flushSync } from 'react-dom';
import { MousePointer2, Square, MoveUpRight, PenLine, Type, Undo2, Redo2, Trash2, Maximize2 } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Toggle } from '@/components/ui/toggle';
import { ANNOTATION_COLORS, ANNOTATION_COLOR_NAMES, type AnnotationTool } from './annotationModel';
import type { AnnotationEditor } from './useAnnotationEditor';
import { AnnotationSizePopover } from './AnnotationSizePopover';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
const TOOLS = [ ['select', '选择 V', MousePointer2], ['rect', '框选 R', Square], ['arrow', '箭头 A', MoveUpRight], ['freedraw', '画笔 P', PenLine], ['text', '文字 T', Type] ] as const;
const button = 'grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40';
const separator = <span className="mx-1 h-5 w-px shrink-0 bg-border" />;
/** 标注工具选中态是反色块，与工具栏其余按钮的浅底区分。 */
const ON_INVERT = 'data-[state=on]:bg-foreground data-[state=on]:text-background';
export interface AnnotationToolbarProps {
  editor: AnnotationEditor; undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean;
  onExpand?: () => void; onEdit?: () => void; busy?: boolean;
}
export function AnnotationToolbar({ editor, undo, redo, canUndo, canRedo, onExpand, onEdit, busy }: AnnotationToolbarProps) {
  const target = editor.text ?? editor.selected;
  const text = target ? target.type === 'text' : editor.prefs.tool === 'text';
  const value = target ? (target.type === 'text' ? target.font_size : target.stroke_width)
    : text ? editor.prefs.font_size : editor.prefs.stroke_width;
  const activeColor = target?.color ?? editor.prefs.color;
  const background = target?.type === 'text' ? target.background : editor.prefs.background;
  return <div role="toolbar" aria-label="标注工具" data-annotation-controls
    className="nodrag nopan flex items-center gap-1 whitespace-nowrap rounded-xl border border-border bg-glass p-1.5 backdrop-blur-glass"
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <ToggleGroup type="single" aria-label="标注类型" value={editor.prefs.tool} onValueChange={value => { if (value) editor.chooseTool(value as AnnotationTool); }}>
      {TOOLS.map(([tool, label, Icon]) => <Hint key={tool} label={label}><ToggleGroupItem value={tool} aria-label={label} className={ON_INVERT}>
        <Icon size={18} strokeWidth={1.8} /></ToggleGroupItem></Hint>)}
    </ToggleGroup>
    {separator}
    <ToggleGroup type="single" aria-label="颜色" className="gap-0" value={activeColor} onValueChange={value => { const color = ANNOTATION_COLORS.find(item => item === value); if (color) editor.changeStyle({ color }); }}>
      {ANNOTATION_COLORS.map((color, i) => <Hint key={color} label={ANNOTATION_COLOR_NAMES[i]}><ToggleGroupItem value={color} aria-label={ANNOTATION_COLOR_NAMES[i]}
        className="size-7 min-w-7 rounded-full px-0 hover:bg-transparent data-[state=on]:border-foreground data-[state=on]:bg-transparent">
        <span className="size-5 rounded-full" style={{ backgroundColor: color }} /></ToggleGroupItem></Hint>)}
    </ToggleGroup>
    <AnnotationSizePopover text={text} value={value} onChange={(n, preview) => editor.changeStyle(text ? { font_size: n } : { stroke_width: n }, preview)} />
    {text && <Hint label="文字底色"><Toggle aria-label="文字底色" pressed={Boolean(background)} className={ON_INVERT}
      onPressedChange={on => editor.changeStyle({ background: on })}>
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><rect x={2} y={3} width={20} height={18} rx={3} /><path d="M7 8h10M12 8v9" /></svg>
    </Toggle></Hint>}
    {separator}
    <Hint label="撤回 ⌘Z / Ctrl+Z"><Button variant="bare" type="button" aria-label="撤回" className={button} disabled={!canUndo} onClick={undo}><Undo2 size={18} strokeWidth={1.8} /></Button></Hint>
    <Hint label="重做 ⇧⌘Z / Ctrl+Shift+Z"><Button variant="bare" type="button" aria-label="重做" className={button} disabled={!canRedo} onClick={redo}><Redo2 size={18} strokeWidth={1.8} /></Button></Hint>
    <Hint label="删除所选 Delete"><Button variant="bare" type="button" aria-label="删除所选" className={button} disabled={!editor.selected} onClick={editor.removeSelected}><Trash2 size={18} strokeWidth={1.8} /></Button></Hint>
    {onExpand && <Hint label="展开"><Button variant="bare" type="button" aria-label="展开" className={button} onClick={onExpand}><Maximize2 size={18} strokeWidth={1.8} /></Button></Hint>}
    {separator}
    <Button variant="default" type="button" disabled={(!editor.elements.length && !editor.text?.text.trim()) || !onEdit || busy} className="shrink-0" onClick={() => { flushSync(() => editor.finishText()); onEdit?.(); }}>去改图</Button>
  </div>;
}
