import { BrushIcon, DragHandleIcon, ImageIcon, MoreIcon } from '@/components/ui/icons';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';

import {
  CANVAS_IMAGE_TOOLS,
  IMAGE_TOOLBAR_INLINE_LIMIT,
  orderedCanvasImageTools,
  type CanvasImageToolDefinition,
} from '@/components/canvas/canvasImageToolbar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  CanvasImageQuickToolId,
  CanvasImageToolbarPreferences,
} from '@/schema/canvas';
import { SwapLabel } from '@/components/ui/swap-label';
import { Checkbox } from '@/components/ui/checkbox';
import { Hint } from '@/components/ui/tooltip';

export function CanvasImageToolbarPreferencesDialog({
  open,
  value,
  saving,
  error,
  onOpenChange,
  onSave,
  excludedToolIds,
}: {
  open: boolean;
  value: CanvasImageToolbarPreferences;
  /** 本机用不了的工具（如不支持本机抠图）：不在候选里出现，已存的配置原样保留。 */
  excludedToolIds?: ReadonlySet<CanvasImageQuickToolId>;
  saving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (value: CanvasImageToolbarPreferences) => void;
}) {
  const [draft, setDraft] = useState(value);
  const availableTools = useMemo(
    () => CANVAS_IMAGE_TOOLS.filter(tool => !excludedToolIds?.has(tool.id)),
    [excludedToolIds],
  );
  const visibleTools = useMemo(
    () => orderedCanvasImageTools(draft.tool_ids).filter(tool => !excludedToolIds?.has(tool.id)),
    [draft.tool_ids, excludedToolIds],
  );
  const hiddenTools = useMemo(() => {
    const selected = new Set(draft.tool_ids);
    return availableTools.filter(tool => !selected.has(tool.id));
  }, [availableTools, draft.tool_ids]);

  useEffect(() => {
    if (open) setDraft({ ...value, tool_ids: orderedCanvasImageTools(value.tool_ids).map(tool => tool.id) });
  }, [open, value]);

  function setVisible(id: CanvasImageQuickToolId, visible: boolean) {
    setDraft(current => ({
      ...current,
      tool_ids: visible
        ? [...current.tool_ids, id]
        : current.tool_ids.filter(candidate => candidate !== id),
    }));
  }

  function move(id: CanvasImageQuickToolId, delta: -1 | 1) {
    setDraft(current => {
      const index = current.tool_ids.indexOf(id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= current.tool_ids.length) return current;
      const toolIds = [...current.tool_ids];
      [toolIds[index], toolIds[target]] = [toolIds[target], toolIds[index]];
      return { ...current, tool_ids: toolIds };
    });
  }

  const preview = visibleTools.slice(0, IMAGE_TOOLBAR_INLINE_LIMIT);

  return (
    <Dialog open={open} onOpenChange={next => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="max-h-[92dvh] min-w-0 max-w-3xl grid-cols-1 overflow-x-hidden overflow-y-auto">
        <DialogHeader>
          <DialogTitle>自定义图片快捷工具</DialogTitle>
          <DialogDescription className="sr-only">图片节点工具条的快捷工具与顺序</DialogDescription>
        </DialogHeader>

        <section aria-label="工具栏预览" className="rounded-lg border border-border bg-card p-4">
          <p className="mb-3 text-xs text-muted-foreground">节点预览</p>
          {/* 与真实工具条同构：纯图标，固定的「局部修改」在最前（置灰表示不可调），分隔线后「更多」。 */}
          <div className="mx-auto w-fit max-w-full overflow-x-auto rounded-xl border border-border bg-glass p-1 backdrop-blur-glass shell-glow">
            <div className="flex min-w-max items-center gap-1">
              <span role="img" aria-label="局部修改（固定）" className="grid size-7 place-items-center rounded-full text-muted-foreground opacity-50">
                <BrushIcon aria-hidden="true" />
              </span>
              {preview.map(tool => {
                const Icon = tool.icon;
                return (
                  <span key={tool.id} role="img" aria-label={tool.label} className="grid size-7 place-items-center rounded-full text-muted-foreground">
                    <Icon aria-hidden="true" />
                  </span>
                );
              })}
              <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
              <span role="img" aria-label="更多" className="grid size-7 place-items-center rounded-full text-muted-foreground">
                <MoreIcon aria-hidden="true" />
              </span>
            </div>
          </div>
          <div className="mt-3 grid min-h-28 place-items-center rounded-lg border border-border bg-secondary/20 text-muted-foreground">
            <span className="flex items-center gap-2 text-sm"><ImageIcon size="lg" aria-hidden="true" />图片节点</span>
          </div>
        </section>

        <section aria-label="快捷工具顺序" className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">快捷工具</p>
            <p className="text-xs tabular-nums text-muted-foreground">已显示 {visibleTools.length}/{availableTools.length}</p>
          </div>
          <Reorder.Group
            as="div"
            axis="y"
            values={draft.tool_ids}
            onReorder={toolIds => setDraft(current => ({ ...current, tool_ids: toolIds }))}
            className="space-y-2"
          >
            {visibleTools.map((tool, index) => (
              <VisibleToolRow
                key={tool.id}
                tool={tool}
                inMore={index >= IMAGE_TOOLBAR_INLINE_LIMIT}
                onHide={() => setVisible(tool.id, false)}
                onMove={delta => move(tool.id, delta)}
              />
            ))}
          </Reorder.Group>
          {hiddenTools.map(tool => {
            const Icon = tool.icon;
            return (
              <div key={tool.id} className={TOOL_ROW_CLASS}>
                <Checkbox
                  aria-label={`显示${tool.label}`}
                  checked={false}
                  onCheckedChange={() => setVisible(tool.id, true)}
                />
                <Icon className="shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-sm text-muted-foreground">{tool.label}</span>
              </div>
            );
          })}
        </section>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={saving} onClick={() => onSave(draft)}><SwapLabel active={Boolean(saving)} on="保存中…" off="保存设置" /></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TOOL_ROW_CLASS = 'flex h-12 items-center gap-3 rounded-lg border border-border bg-card px-3';

function VisibleToolRow({ tool, inMore, onHide, onMove }: {
  tool: CanvasImageToolDefinition;
  inMore: boolean;
  onHide: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const dragControls = useDragControls();
  const Icon = tool.icon;
  return (
    <Reorder.Item
      as="div"
      value={tool.id}
      dragListener={false}
      dragControls={dragControls}
      whileDrag={{ zIndex: 20 }}
      className={TOOL_ROW_CLASS}
    >
      <Checkbox
        aria-label={`显示${tool.label}`}
        checked
        onCheckedChange={onHide}
      />
      <Icon className="shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-sm">{tool.label}</span>
      {inMore && <span className="text-xs text-muted-foreground">在「更多」里</span>}
      <Hint label="拖动排序，或按上下方向键"><Button variant="bare"
        type="button"
        aria-label={`拖动调整${tool.label}的顺序`}
        className="grid size-8 cursor-grab touch-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:cursor-grabbing"
        onPointerDown={event => dragControls.start(event)}
        onKeyDown={event => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          onMove(event.key === 'ArrowUp' ? -1 : 1);
        }}
      >
        <DragHandleIcon aria-hidden="true" />
      </Button></Hint>
    </Reorder.Item>
  );
}
