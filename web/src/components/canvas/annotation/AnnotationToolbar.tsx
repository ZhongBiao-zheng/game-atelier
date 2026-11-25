import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { AiIcon, ArrowToolIcon, DeleteIcon, ExpandIcon, LoadingIcon, PenIcon, RectangleIcon, RedoIcon, SelectIcon, TextIcon, UndoIcon } from '@/components/ui/icons';
import { SwapIcon } from '@/components/ui/swap-icon';
import { SwapLabel } from '@/components/ui/swap-label';
import { shakeOnError } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Toggle } from '@/components/ui/toggle';
import { ANNOTATION_COLORS, ANNOTATION_COLOR_NAMES, type AnnotationTool } from './annotationModel';
import { useAnnotationView, type AnnotationEditor } from './useAnnotationEditor';
import { AnnotationSizePopover } from './AnnotationSizePopover';
import { Hint } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
const TOOLS = [ ['select', '选择 V', SelectIcon], ['rect', '框选 R', RectangleIcon], ['arrow', '箭头 A', ArrowToolIcon], ['freedraw', '画笔 P', PenIcon], ['text', '文字 T', TextIcon] ] as const;
const button = 'grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40';
const separator = <span className="mx-1 h-5 w-px shrink-0 bg-border" />;
/** 标注工具选中态是反色块，与工具栏其余按钮的浅底区分。 */
const ON_INVERT = 'data-[state=on]:bg-foreground data-[state=on]:text-background';
export interface AnnotationToolbarProps {
  editor: AnnotationEditor; undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean;
  onExpand?: () => void; onEdit?: () => void; busy?: boolean;
}
export function AnnotationToolbar({ editor, undo, redo, canUndo, canRedo, onExpand, onEdit, busy }: AnnotationToolbarProps) {
  const view = useAnnotationView(editor);
  const target = editor.text ?? view.selected;
  const editButton = useRef<HTMLButtonElement>(null);
  // 去改图失败时还停在标注里（成功会退出标注、工具条随之收起）：只抖这个按钮，错误文案交给画布报错条。
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && editor.enabled) shakeOnError(editButton.current);
    wasBusy.current = busy;
  }, [busy, editor.enabled]);
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
        <Icon size="lg" /></ToggleGroupItem></Hint>)}
    </ToggleGroup>
    {separator}
    <ToggleGroup type="single" aria-label="颜色" className="gap-0" value={activeColor} onValueChange={value => { const color = ANNOTATION_COLORS.find(item => item === value); if (color) editor.changeStyle({ color }); }}>
      {ANNOTATION_COLORS.map((color, i) => <Hint key={color} label={ANNOTATION_COLOR_NAMES[i]}><ToggleGroupItem value={color} aria-label={ANNOTATION_COLOR_NAMES[i]}
        className="size-7 min-w-7 rounded-full px-0 hover:bg-transparent data-[state=on]:border-foreground data-[state=on]:bg-transparent">
        <span className="size-5 rounded-full" style={{ backgroundColor: color }} /></ToggleGroupItem></Hint>)}
    </ToggleGroup>
    <AnnotationSizePopover text={text} value={value} onChange={(n, preview) => editor.changeStyle(text ? { font_size: n } : { stroke_width: n }, preview)} />
    {/* 只对文字有意义，但常驻占位：切工具、选中不同标注时工具条宽度不变，后面的按钮不左右跳。 */}
    <Hint label="文字底色"><Toggle aria-label="文字底色" pressed={Boolean(background)} disabled={!text} tabIndex={text ? undefined : -1}
      aria-hidden={text ? undefined : true} className={cn(ON_INVERT, !text && 'invisible')}
      onPressedChange={on => editor.changeStyle({ background: on })}>
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><rect x={2} y={3} width={20} height={18} rx={3} /><path d="M7 8h10M12 8v9" /></svg>
    </Toggle></Hint>
    {separator}
    <Hint label="撤回 ⌘Z / Ctrl+Z"><Button variant="bare" type="button" aria-label="撤回" className={button} disabled={!canUndo} onClick={undo}><UndoIcon size="lg" /></Button></Hint>
    <Hint label="重做 ⇧⌘Z / Ctrl+Shift+Z"><Button variant="bare" type="button" aria-label="重做" className={button} disabled={!canRedo} onClick={redo}><RedoIcon size="lg" /></Button></Hint>
    <Hint label="删除所选 Delete"><Button variant="bare" type="button" aria-label="删除所选" className={button} disabled={!view.selected} onClick={editor.removeSelected}><DeleteIcon size="lg" /></Button></Hint>
    {onExpand && <Hint label="展开"><Button variant="bare" type="button" aria-label="展开" className={button} onClick={onExpand}><ExpandIcon size="lg" /></Button></Hint>}
    {separator}
    <Button ref={editButton} variant="default" type="button" aria-busy={busy || undefined}
      disabled={(!view.elements.length && !editor.text?.text.trim()) || !onEdit || busy} className="shrink-0"
      onClick={() => { flushSync(() => editor.finishText()); onEdit?.(); }}>
      <SwapIcon swapKey={Boolean(busy)}>{busy ? <LoadingIcon className="animate-spin" /> : <AiIcon />}</SwapIcon>
      <SwapLabel active={Boolean(busy)} on="提交中…" off="去改图" />
    </Button>
  </div>;
}
