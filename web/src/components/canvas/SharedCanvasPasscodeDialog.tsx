import { useState } from 'react';
import { authenticateCollab } from '@/api/collab';
import { saveProfile } from '@/api/teamLibraries';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { errorText } from '@/lib/errorText';

export function SharedCanvasPasscodeDialog({peerKey, projectId, name, needsName, needsCode, onClose, onEntered}: {
  peerKey: string; projectId: string; name: string; needsName: boolean; needsCode: boolean;
  onClose: () => void; onEntered: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (needsName) await saveProfile(displayName.trim());
      await authenticateCollab(peerKey, projectId, passcode);
      onEntered();
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>进入共享画布 · {name}</DialogTitle></DialogHeader>
      <form autoComplete="off" onSubmit={submit} className="grid gap-4">
        {needsName && <div className="grid gap-2">
          <Label htmlFor="collab-guest-name">你的团队显示名</Label>
          <Input id="collab-guest-name" required value={displayName} maxLength={80} onChange={e => setDisplayName(e.target.value)} />
        </div>}
        {needsCode && <div className="grid gap-2">
          <Label htmlFor="collab-passcode">访问口令</Label>
          <SecretInput id="collab-passcode" required value={passcode} maxLength={128} onChange={e => setPasscode(e.target.value)} />
        </div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="submit" disabled={busy || (needsName && !displayName.trim()) || (needsCode && !passcode)}>{busy ? '进入中…' : '进入画布'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
