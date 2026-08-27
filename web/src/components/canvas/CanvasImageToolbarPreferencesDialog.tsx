import { ChevronDown, ChevronUp, Ellipsis, Image as ImageIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  CANVAS_IMAGE_TOOLS,
  orderedCanvasImageTools,
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
  const selected = useMemo(() => new Set(draft.tool_ids), [draft.tool_ids]);
  const rows = useMemo(() => {
    const visible = orderedCanvasImageTools(draft.tool_ids);
    return [...visible, ...CANVAS_IMAGE_TOOLS.filter(tool => !selected.has(tool.id))];
  }, [draft.tool_ids, selected]);

  useEffect(() => {
    if (open) setDraft(value);
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

  const preview = orderedCanvasImageTools(draft.tool_ids);

  return (
    <Dialog open={open} onOpenChange={next => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="max-h-[92dvh] min-w-0 max-w-3xl grid-cols-1 overflow-x-hidden overflow-y-auto">
        <DialogHeader>
          <DialogTitle>自定义图片快捷工具</DialogTitle>
          <DialogDescription>选择节点上方显示的工具并调整顺序。设置会应用到所有画布项目。</DialogDescription>
        </DialogHeader>

        <section aria-label="工具栏预览" className="rounded-lg border border-border bg-card p-4">
          <p className="mb-3 text-xs uppercase tracking-label text-muted-foreground/70">节点预览</p>
          <div className="overflow-x-auto rounded-xl border border-border bg-glass p-1 backdrop-blur-glass shell-glow">
            <div className="flex min-w-max items-center">
              {preview.map(tool => {
                const Icon = tool.icon;
                return (
                  <span key={tool.id} className="flex h-9 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground">
                    <Icon className="size-4" aria-hidden="true" />
                    {draft.show_labels && <span>{tool.label}</span>}
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

        <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 text-sm">
          <span>
            <span className="block font-medium">显示按钮文字</span>
            <span className="block text-xs text-muted-foreground">关闭时仍保留悬停提示和无障碍名称。</span>
          </span>
          <input
            type="checkbox"
            checked={draft.show_labels}
            onChange={event => setDraft(current => ({ ...current, show_labels: event.target.checked }))}
            className="size-4 accent-primary"
          />
        </label>

        <section aria-label="快捷工具顺序" className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">快捷工具</p>
            <p className="text-xs tabular-nums text-muted-foreground">已显示 {draft.tool_ids.length}/{CANVAS_IMAGE_TOOLS.length}</p>
          </div>
          {rows.map(tool => {
            const Icon = tool.icon;
            const index = draft.tool_ids.indexOf(tool.id);
            const visible = index >= 0;
            return (
              <div key={tool.id} className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={`显示${tool.label}`}
                  checked={visible}
                  onChange={event => setVisible(tool.id, event.target.checked)}
                  className="size-4 accent-primary"
                />
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-sm">{tool.label}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`上移${tool.label}`}
                  disabled={!visible || index === 0}
                  onClick={() => move(tool.id, -1)}
                >
                  <ChevronUp aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`下移${tool.label}`}
                  disabled={!visible || index === draft.tool_ids.length - 1}
                  onClick={() => move(tool.id, 1)}
                >
                  <ChevronDown aria-hidden="true" />
                </Button>
              </div>
            );
          })}
        </section>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={saving} onClick={() => onSave(draft)}>{saving ? '保存中…' : '保存设置'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
