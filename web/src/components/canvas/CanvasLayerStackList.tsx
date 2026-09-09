import { useState, type DragEvent } from 'react';
import { Download, Ellipsis, Eye, EyeOff, GripVertical } from 'lucide-react';
import { canvasDownloadUrl, canvasMediaUrl } from '@/api/canvas';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { CanvasLayerStackNode } from '@/schema/canvas';
import { cn } from '@/lib/utils';
import { moveLayerStackPart, orderedLayerStackParts } from './canvasLayerOrder';
import type { CanvasNodeContextValue } from './CanvasEditorViews';

export function CanvasLayerStackList({ node, context, disabled, onVisibility, onHover }: {
  node: CanvasLayerStackNode;
  context: CanvasNodeContextValue;
  disabled: boolean;
  onVisibility: (layerId: string | null, visible: boolean) => void;
  onHover: (layerId: string | null) => void;
}) {
  const [dragged, setDragged] = useState<string | null>(null);
  const [target, setTarget] = useState<{ key: string; after: boolean } | null>(null);
  const parts = orderedLayerStackParts(node).reverse();
  function resetDrag() { setDragged(null); setTarget(null); }
  function move(sourceKey: string, targetKey: string, after: boolean) {
    if (disabled || moveLayerStackPart(node, sourceKey, targetKey, after) === node) return;
    context.recordHistory();
    context.updateNode(node.id, current => current.type === 'layer_stack'
      ? moveLayerStackPart(current, sourceKey, targetKey, after) : current);
  }
  function hit(event: DragEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY >= rect.top + rect.height / 2;
  }
  return <div role="list" aria-label="图层列表" className="nodrag nopan h-full overflow-y-auto p-2"
    onPointerDown={event => event.stopPropagation()}
    onDragOver={event => {
      event.preventDefault(); event.stopPropagation();
      if (!dragged || disabled) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const edge = Math.min(32, rect.height / 4);
      if (event.clientY < rect.top + edge) event.currentTarget.scrollTop -= 16;
      else if (event.clientY > rect.bottom - edge) event.currentTarget.scrollTop += 16;
    }}
    onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null);
    }}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); resetDrag(); }}>
    {parts.map((part, index) => <div key={part.key} role="listitem" data-layer-row={part.key}
      aria-label={part.name} draggable={!disabled}
      title={part.layer?.description || part.name}
      className={cn('relative flex items-center gap-1 rounded-md p-2 hover:bg-secondary/60 focus-within:bg-secondary/60',
        !disabled && 'cursor-grab', dragged === part.key && 'opacity-50')}
      onMouseEnter={() => onHover(part.layer?.id ?? null)} onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(part.layer?.id ?? null)} onBlur={() => onHover(null)}
      onDragStart={event => {
        event.stopPropagation();
        if (disabled || (event.target as HTMLElement).closest('button,a')) { event.preventDefault(); return; }
        event.dataTransfer.setData('application/x-atelier-layer', part.key);
        event.dataTransfer.effectAllowed = 'move';
        setDragged(part.key);
      }}
      onDragEnd={resetDrag}
      onDragOver={event => {
        if (!dragged || disabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setTarget({ key: part.key, after: hit(event) });
      }}
      onDrop={event => {
        event.preventDefault(); event.stopPropagation();
        if (dragged) move(dragged, part.key, hit(event));
        resetDrag();
      }}>
      {target?.key === part.key && dragged !== part.key && <span aria-hidden="true"
        className={cn('pointer-events-none absolute inset-x-2 border-t-2 border-primary', target.after ? 'bottom-0' : 'top-0')} />}
      <GripVertical aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      <img src={canvasMediaUrl(context.projectId, part.versionId, 128)} alt="" draggable={false}
        className="size-12 shrink-0 rounded-md bg-secondary/40 object-contain" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{part.name}</span>
      <a href={canvasDownloadUrl(context.projectId, part.versionId)} download draggable={false}
        aria-label={`下载${part.name}`} onClick={event => event.stopPropagation()}
        className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Download className="size-4" />
      </a>
      <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground"
        aria-label={`${part.visible ? '隐藏' : '显示'}${part.name}`} aria-pressed={part.visible}
        onClick={event => { event.stopPropagation(); onVisibility(part.layer?.id ?? null, !part.visible); }}>
        {part.visible ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
      </Button>
      <DropdownMenu><DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-6 shrink-0 text-muted-foreground"
          disabled={disabled} aria-label={`${part.name}图层排序`} onClick={event => event.stopPropagation()}>
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger><DropdownMenuContent onPointerDown={event => event.stopPropagation()}>
        <DropdownMenuItem disabled={disabled || index === 0}
          onSelect={() => move(part.key, parts[index - 1].key, false)}>上移一层</DropdownMenuItem>
        <DropdownMenuItem disabled={disabled || index === parts.length - 1}
          onSelect={() => move(part.key, parts[index + 1].key, true)}>下移一层</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
    </div>)}
  </div>;
}
