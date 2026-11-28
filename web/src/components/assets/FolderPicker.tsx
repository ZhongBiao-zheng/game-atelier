import { useEffect, useState } from 'react';
import { listLibrary, libraryWrite, type LibraryFolder } from '@/api/library';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { AddIcon, FolderIcon } from '@/components/ui/icons';
import { errorText } from '@/lib/errorText';
import { notify } from '@/lib/notify';

export function FolderPicker({ open, onClose, onChoose, allowed, root = false }: {
  open: boolean; onClose: () => void; onChoose: (folder: LibraryFolder) => Promise<void>;
  allowed?: (folder: LibraryFolder) => boolean; root?: boolean;
}) {
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setCreating(false); setName('');
    listLibrary().then(c => { if (active) setFolders(c.folders); }).catch(e => notify.error(errorText(e)));
    return () => { active = false; };
  }, [open]);
  async function select(folder?: LibraryFolder) {
    if (busy) return;
    setBusy(true);
    try {
      const chosen = folder ?? await libraryWrite<LibraryFolder>('folders', { name });
      if (!folder) {
        setFolders(current => [...current, chosen]);
        setCreating(false);
        setName('');
      }
      await onChoose(chosen);
      onClose();
    } catch (e) { notify.error(errorText(e)); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={v => { if (!v && !busy) onClose(); }}><DialogContent>
    <DialogTitle>选择文件夹</DialogTitle>
    <div className="max-h-[55vh] overflow-y-auto">
      {root && <Button variant="ghost" className="w-full justify-start" onClick={() => void select({ id: '', name: '我的文件夹', item_ids: [], parent_id: null })}>我的文件夹</Button>}
      {folders.filter(f => !f.system && (!allowed || allowed(f))).map(f => <Button key={f.id} variant="ghost" disabled={busy}
        className="w-full justify-start" onClick={() => void select(f)}><FolderIcon />{f.parent_id ? folders.find(p => p.id === f.parent_id)?.name + ' / ' : ''}{f.name}</Button>)}
      {creating ? <form autoComplete="off" className="flex gap-2" onSubmit={event => { event.preventDefault(); void select(); }}>
        <Input autoFocus aria-label="文件夹名称" value={name} onChange={e => setName(e.target.value)} maxLength={160}/>
        <Button disabled={busy || !name.trim()}>创建</Button>
      </form> : <Button variant="ghost" className="w-full justify-start" onClick={() => setCreating(true)}><AddIcon />新建文件夹</Button>}
    </div></DialogContent></Dialog>;
}
