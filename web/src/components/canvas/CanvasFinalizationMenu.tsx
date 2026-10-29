import { Check, CircleHelp, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { CanvasContentNode, CanvasContentVersion } from '@/schema/canvas';
import type { CanvasNodeContextValue } from './CanvasEditorViews';

export function CanvasFinalizationMenu({ node, content, context, disabled, onOverlayOpenChange }: {
  node: CanvasContentNode;
  content: CanvasContentVersion | undefined;
  context: CanvasNodeContextValue;
  disabled: boolean;
  onOverlayOpenChange: (open: boolean) => void;
}) {
  // add = 新增类别并直接定稿当前图片后关掉；manage = 管理（删除 / 新增）类别。
  const [editing, setEditing] = useState<'add' | 'manage' | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categories = context.projectCategories ?? [];
  const category = content ? context.resolveFinalCategory?.(content.sha256) : null;

  async function finalize(value: string | null) {
    setBusy(true);
    try { await context.finalizeNode?.(node, value); }
    catch (error) { context.reportError?.((error as Error).message); }
    finally { setBusy(false); }
  }

  function edit(mode: 'add' | 'manage' | null) {
    setEditing(mode);
    setError(null);
    setName('');
    onOverlayOpenChange(mode !== null);
  }

  async function save(next: string[]) {
    setBusy(true);
    setError(null);
    try {
      await context.saveCategories?.(next);
      setName('');
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }

  async function addAndFinalize(value: string) {
    setBusy(true);
    setError(null);
    try {
      if (!categories.includes(value)) await context.saveCategories?.([...categories, value]);
      await context.finalizeNode?.(node, value);
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
      return;
    }
    setBusy(false);
    edit(null);
  }

  return <>
    <DropdownMenu onOpenChange={open => onOverlayOpenChange(open || editing !== null)}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`定稿 ${node.title}`} disabled={disabled || busy}
          className="flex h-9 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50">
          <Check className="size-4" />定稿
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="nodrag max-h-80 min-w-36 overflow-y-auto" onPointerDown={event => event.stopPropagation()}>
        {categories.map(value => <DropdownMenuItem key={value} disabled={busy} onSelect={() => void finalize(value)} className="justify-between gap-4">
          {value}{value === category && <Check className="size-4" />}
        </DropdownMenuItem>)}
        {category && <DropdownMenuItem disabled={busy} onSelect={() => void finalize(null)}>取消定稿</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => edit('add')}>新增类别…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => edit('manage')}>管理类别…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={editing === 'add'} onOpenChange={open => { if (!busy && !open) edit(null); }}>
      <DialogContent aria-describedby={undefined} className="nodrag max-w-sm" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <DialogHeader><DialogTitle>新增类别</DialogTitle></DialogHeader>
        <form autoComplete="off" className="flex gap-2" onSubmit={event => {
          event.preventDefault();
          if (name.trim() && !busy) void addAndFinalize(name.trim());
        }}>
          <Input autoFocus aria-label="类别名称" placeholder="类别名称" maxLength={24} value={name} disabled={busy} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing && event.key === 'Enter') event.preventDefault(); }} />
          <Button type="submit" disabled={busy || !name.trim() || (!categories.includes(name.trim()) && categories.length >= 40)}>定稿</Button>
        </form>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
    <Dialog open={editing === 'manage'} onOpenChange={open => { if (!busy && !open) edit(null); }}>
      <DialogContent aria-describedby={undefined} className="nodrag max-w-sm" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <DialogHeader><DialogTitle>项目类别</DialogTitle></DialogHeader>
        <span title="同一资产的类别和取消定稿对所有关联项目生效。使用已定稿资产后会自动进入本项目参考库。" tabIndex={0} aria-label="定稿规则" className="absolute right-14 top-5 text-muted-foreground"><CircleHelp className="size-4" /></span>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {categories.map(value => <div key={value} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{value}</span>
            <Button variant="ghost" size="icon" aria-label={`删除类别 ${value}`} disabled={busy} onClick={() => void save(categories.filter(item => item !== value))}><Trash2 className="size-4" /></Button>
          </div>)}
        </div>
        <form autoComplete="off" className="flex gap-2" onSubmit={event => {
          event.preventDefault();
          if (name.trim() && !busy) void save([...categories, name.trim()]);
        }}>
          <Input aria-label="类别名称" placeholder="类别名称" maxLength={24} value={name} disabled={busy} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing && event.key === 'Enter') event.preventDefault(); }} />
          <Button type="submit" disabled={busy || !name.trim() || categories.length >= 40}>新增</Button>
        </form>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  </>;
}
