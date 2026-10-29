import { Ellipsis, GripVertical, Image as ImageIcon } from 'lucide-react';
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

export function CanvasImageToolbarPreferencesDialog({
  open,
  value,
  saving,
  error,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  value: CanvasImageToolbarPreferences;
  saving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (value: CanvasImageToolbarPreferences) => void;
}) {
  const [draft, setDraft] = useState(value);
  const visibleTools = useMemo(() => orderedCanvasImageTools(draft.tool_ids), [draft.tool_ids]);
  const hiddenTools = useMemo(() => {
    const selected = new Set(draft.tool_ids);
    return CANVAS_IMAGE_TOOLS.filter(tool => !selected.has(tool.id));
  }, [draft.tool_ids]);

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
          <DialogDescription>勾选要用的工具，拖动调整顺序。前 4 个直接显示在节点上方，其余在「更多」里。设置会应用到所有画布项目。</DialogDescription>
        </DialogHeader>

        <section aria-label="工具栏预览" className="rounded-lg border border-border bg-card p-4">
          <p className="mb-3 text-xs text-muted-foreground">节点预览</p>
          <div className="overflow-x-auto rounded-xl border border-border bg-glass p-1 backdrop-blur-glass shell-glow">
            <div className="flex min-w-max items-center">
              {preview.map(tool => {
                const Icon = tool.icon;
                return (
                  <span key={tool.id} className="flex h-9 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground">
                    <Icon className="size-4" aria-hidden="true" />
                    <span>{tool.label}</span>
                  </span>
                );
              })}
              <span className="grid size-9 place-items-center rounded-md text-muted-foreground" aria-label="更多与配置">
                <Ellipsis className="size-4" aria-hidden="true" />
              </span>
            </div>
          </div>
          <div className="mt-3 grid min-h-28 place-items-center rounded-lg border border-border bg-secondary/20 text-muted-foreground">
            <span className="flex items-center gap-2 text-sm"><ImageIcon className="size-5" aria-hidden="true" />图片节点</span>
          </div>
        </section>

        <section aria-label="快捷工具顺序" className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">快捷工具</p>
            <p className="text-xs tabular-nums text-muted-foreground">已显示 {draft.tool_ids.length}/{CANVAS_IMAGE_TOOLS.length}</p>
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
                  onChange={() => setVisible(tool.id, true)}
                  className="size-4 accent-primary"
                />
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
        onChange={onHide}
        className="size-4 accent-primary"
      />
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-sm">{tool.label}</span>
      {inMore && <span className="text-xs text-muted-foreground">在「更多」里</span>}
      <button
        type="button"
        aria-label={`拖动调整${tool.label}的顺序`}
        title="拖动排序，或按上下方向键"
        className="grid size-8 cursor-grab touch-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:cursor-grabbing"
        onPointerDown={event => dragControls.start(event)}
        onKeyDown={event => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          onMove(event.key === 'ArrowUp' ? -1 : 1);
        }}
      >
        <GripVertical className="size-4" aria-hidden="true" />
      </button>
    </Reorder.Item>
  );
}
