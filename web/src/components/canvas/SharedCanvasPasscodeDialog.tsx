import { useRef, useState } from 'react';
import { authenticateCollab } from '@/api/collab';
import { saveProfile } from '@/api/teamLibraries';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useRetained } from '@/components/ui/retained';
import { SecretInput } from '@/components/ui/secret-input';
import { SwapLabel } from '@/components/ui/swap-label';
import { errorText } from '@/lib/errorText';
import { shakeOnError } from '@/lib/motion';

export function SharedCanvasPasscodeDialog({open = true, peerKey, projectId, name, needsName, needsCode, onClose, onEntered}: {
  /** 不传时一直打开（调用方条件挂载）；受控时关闭能播退场。 */
  open?: boolean; peerKey: string; projectId: string; name: string; needsName: boolean; needsCode: boolean;
  onClose: () => void; onEntered: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const shownError = useRetained(error || null);
  const [busy, setBusy] = useState(false);
  const passcodeInput = useRef<HTMLInputElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (needsName) await saveProfile(displayName.trim());
      await authenticateCollab(peerKey, projectId, passcode);
      onEntered();
    } catch (reason) {
      setError(errorText(reason));
      shakeOnError(needsCode ? passcodeInput.current : submitButton.current);
    }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>进入共享画布 · {name}</DialogTitle></DialogHeader>
      <form autoComplete="off" onSubmit={submit} className="grid gap-4">
        {needsName && <div className="grid gap-2">
          <Label htmlFor="collab-guest-name">你的团队显示名</Label>
          <Input id="collab-guest-name" required value={displayName} maxLength={80} onChange={e => setDisplayName(e.target.value)} />
        </div>}
        {needsCode && <div className="grid gap-2">
          <Label htmlFor="collab-passcode">访问口令</Label>
          <SecretInput ref={passcodeInput} id="collab-passcode" required value={passcode} maxLength={128} onChange={e => setPasscode(e.target.value)} />
        </div>}
        <Collapse open={Boolean(error)}><p role="alert" className="text-sm text-destructive">{shownError}</p></Collapse>
        <DialogFooter><Button ref={submitButton} type="submit" disabled={busy || (needsName && !displayName.trim()) || (needsCode && !passcode)}>
          <SwapLabel active={busy} on="进入中…" off="进入画布" />
        </Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
