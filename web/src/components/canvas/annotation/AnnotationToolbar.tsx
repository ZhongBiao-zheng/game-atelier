import { flushSync } from 'react-dom';
import { MousePointer2, Square, MoveUpRight, PenLine, Type, Undo2, Redo2, Trash2, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ANNOTATION_COLORS, ANNOTATION_COLOR_NAMES, type AnnotationTool } from './annotationModel';
import type { AnnotationEditor } from './useAnnotationEditor';
import { AnnotationSizePopover } from './AnnotationSizePopover';
const TOOLS = [ ['select', '选择 V', MousePointer2], ['rect', '框选 R', Square], ['arrow', '箭头 A', MoveUpRight], ['freedraw', '画笔 P', PenLine], ['text', '文字 T', Type] ] as const;
const button = 'grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40';
const separator = <span className="mx-1 h-5 w-px shrink-0 bg-border" />;
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
    {TOOLS.map(([tool, label, Icon]) => <button key={tool} type="button" title={label} aria-label={label} aria-pressed={editor.prefs.tool === tool}
      className={cn(button, editor.prefs.tool === tool && 'bg-foreground text-background hover:bg-foreground hover:text-background')}
      onClick={() => editor.chooseTool(tool as AnnotationTool)}><Icon size={18} strokeWidth={1.8} /></button>)}
    {separator}
    {ANNOTATION_COLORS.map((color, i) => <button key={color} type="button" title={ANNOTATION_COLOR_NAMES[i]} aria-label={ANNOTATION_COLOR_NAMES[i]}
      aria-pressed={activeColor === color} className={cn('grid size-7 shrink-0 place-items-center rounded-full border border-transparent', activeColor === color && 'border-foreground')}
      onClick={() => editor.changeStyle({ color })}><span className="size-5 rounded-full" style={{ backgroundColor: color }} /></button>)}
    <AnnotationSizePopover text={text} value={value} onChange={(n, preview) => editor.changeStyle(text ? { font_size: n } : { stroke_width: n }, preview)} />
    {text && <button type="button" title="文字底色" aria-label="文字底色" aria-pressed={background}
      className={cn(button, background && 'bg-foreground text-background')}
      onClick={() => editor.changeStyle({ background: !background })}>
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><rect x={2} y={3} width={20} height={18} rx={3} /><path d="M7 8h10M12 8v9" /></svg>
    </button>}
    {separator}
    <button type="button" title="撤回 ⌘Z / Ctrl+Z" aria-label="撤回" className={button} disabled={!canUndo} onClick={undo}><Undo2 size={18} strokeWidth={1.8} /></button>
    <button type="button" title="重做 ⇧⌘Z / Ctrl+Shift+Z" aria-label="重做" className={button} disabled={!canRedo} onClick={redo}><Redo2 size={18} strokeWidth={1.8} /></button>
    <button type="button" title="删除所选 Delete" aria-label="删除所选" className={button} disabled={!editor.selected} onClick={editor.removeSelected}><Trash2 size={18} strokeWidth={1.8} /></button>
    {onExpand && <button type="button" title="展开" aria-label="展开" className={button} onClick={onExpand}><Maximize2 size={18} strokeWidth={1.8} /></button>}
    {separator}
    <button type="button" disabled={(!editor.elements.length && !editor.text?.text.trim()) || !onEdit || busy} className="h-9 shrink-0 rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground disabled:opacity-40" onClick={() => { flushSync(() => editor.finishText()); onEdit?.(); }}>去改图</button>
  </div>;
}
