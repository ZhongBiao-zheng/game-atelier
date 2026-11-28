import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { errorText } from '@/lib/errorText';

export function TemplateNameDialog({ title, initialName, onClose, onSave }: {
  title: string; initialName: string; onClose: () => void; onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true);
    try { await onSave(name.trim()); onClose(); }
    catch (cause) { setError(errorText(cause)); setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-w-sm" aria-describedby={undefined} dirty={name !== initialName}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      <form autoComplete="off" className="grid gap-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <Input aria-label="模板名称" autoFocus maxLength={120} value={name} disabled={busy}
          onFocus={event => event.target.select()} onChange={event => setName(event.target.value)} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button disabled={busy || !name.trim()} type="submit">保存</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
