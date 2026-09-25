import { ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { CreationAsset } from '@/schema/creationAssets';

export function PanelTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={cn('flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary [&_svg]:size-4', active && 'bg-secondary text-foreground')}>{children}</button>;
}

export function ScopeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={cn('rounded-full border border-transparent px-3 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary', active && 'border-border bg-secondary text-foreground')}>{children}</button>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block space-y-1.5"><span className="flex items-center justify-between text-xs text-muted-foreground"><span>{label}</span>{hint && <span className="max-w-48 truncate">{hint}</span>}</span>{children}</label>;
}

export function CanvasPicker({ asset, targets, linkedCanvas, busy, onConnect }: {
  asset: CreationAsset;
  targets: { projectId: string; name: string }[];
  linkedCanvas: { projectId: string; name: string } | null;
  busy: boolean;
  onConnect: (target: { projectId: string; name: string }) => void;
}) {
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
      <div className="rounded-lg border border-border bg-card p-3"><p className="text-sm font-medium">{asset.title}</p><p className="mt-1 text-xs text-muted-foreground">选择一个画布，资产会出现在该画布的“本项目”范围中。</p></div>
      {!linkedCanvas && targets.map(target => <button key={target.projectId} type="button" disabled={busy} className="flex w-full items-center justify-between rounded-lg border border-border bg-card px-3 py-3 text-left text-sm hover:bg-secondary disabled:opacity-50" onClick={() => onConnect(target)}><span className="truncate">{target.name}</span><span className="text-xs text-muted-foreground">加入</span></button>)}
      {linkedCanvas && <div role="status" className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-xs">已加入“{linkedCanvas.name}”。<a className="ml-1 inline-flex items-center gap-1 text-primary hover:underline" href={`/canvas/${encodeURIComponent(linkedCanvas.projectId)}`}>打开画布<ExternalLink className="size-3" /></a></div>}
    </div>
  );
}

export function DiscardChangesDialog({ open, onOpenChange, onKeepEditing, onDiscard }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose>
        <DialogHeader><DialogTitle>放弃未保存的修改？</DialogTitle><DialogDescription>当前编辑内容还没有保存。</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" onClick={onKeepEditing}>继续编辑</Button><Button onClick={onDiscard}>放弃修改</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteAssetDialog({ target, busy, onCancel, onConfirm }: {
  target: CreationAsset | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={Boolean(target)} onOpenChange={open => { if (!open) onCancel(); }}>
      <DialogContent hideClose>
        <DialogHeader><DialogTitle>删除“{target?.title}”？</DialogTitle><DialogDescription>删除后不可恢复。已经使用过的提示词、媒体和来源名称快照不会受影响。</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={onCancel}>取消</Button><Button variant="destructive" disabled={busy} onClick={onConfirm}>{busy ? '删除中…' : '确认删除'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
