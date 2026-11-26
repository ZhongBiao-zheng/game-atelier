import { useEffect, useState } from 'react';
import { readCollabStatus, updateCollabShare } from '@/api/collab';
import { fetchProfile, saveProfile } from '@/api/teamLibraries';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { Segmented, SegmentedItem } from '@/components/ui/segmented';
import { errorText } from '@/lib/errorText';
import type { CollabCard, CollabMode } from '@/schema/collab';

export function SharedCanvasSettingsDialog({ projectId, name, share, onClose, onSaved }: {
  projectId: string; name: string; share?: CollabCard; onClose: () => void; onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [needsName, setNeedsName] = useState<boolean | null>(null);
  const [mode, setMode] = useState<CollabMode>(share?.mode ?? 'edit');
  const [borrow, setBorrow] = useState(share?.allow_borrow_provider ?? false);
  const [changePasscode, setChangePasscode] = useState(!share?.requires_passcode);
  const [passcode, setPasscode] = useState('');
  const [addresses, setAddresses] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void fetchProfile().then(profile => {
      if (active) setNeedsName(!profile.display_name?.trim());
    }).catch(reason => { if (active) setError(errorText(reason)); });
    if (share) void readCollabStatus().then(status => {
      if (active && status.port) setAddresses(status.addresses.map(address =>
        address.includes(':') ? address : `${address}:${status.port}`));
    }).catch(() => {});
    return () => { active = false; };
  }, [projectId, share?.project_id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || needsName === null || (needsName && !displayName.trim())) return;
    setBusy(true);
    setError('');
    try {
      if (needsName) await saveProfile(displayName.trim());
      await updateCollabShare(projectId, {
        mode, allow_borrow_provider: borrow,
        ...(changePasscode ? { passcode } : {}),
      });
      onSaved();
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent aria-describedby={undefined}>
      <DialogHeader><DialogTitle>{share ? '共享设置' : '共享画布'} · {name}</DialogTitle></DialogHeader>
      <form autoComplete="off" onSubmit={submit} className="grid gap-4">
        {needsName && <div className="grid gap-2">
          <Label htmlFor="collab-owner-name">你的团队显示名</Label>
          <Input id="collab-owner-name" value={displayName} maxLength={80} required onChange={e => setDisplayName(e.target.value)} />
        </div>}
        <div className="grid gap-2"><span className="text-sm font-medium">访客权限</span>
          <Segmented aria-label="访客权限" className="grid-cols-2">
            <SegmentedItem value="edit" selected={mode === 'edit'} onSelect={() => setMode('edit')}>可协作</SegmentedItem>
            <SegmentedItem value="view" selected={mode === 'view'} onSelect={() => setMode('view')}>仅查看</SegmentedItem>
          </Segmented>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="collab-access-code">访问口令</Label>
          {changePasscode
            ? <SecretInput id="collab-access-code" value={passcode} placeholder={share?.requires_passcode ? '留空并保存可清除原口令' : '选填'} maxLength={128} onChange={e => setPasscode(e.target.value)} />
            : <Button variant="outline" type="button" onClick={() => setChangePasscode(true)}>修改或清除口令</Button>}
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="collab-borrow" checked={borrow} disabled={mode === 'view'} onCheckedChange={value => setBorrow(value === true)} />
          <Label htmlFor="collab-borrow">允许访客借用我的供应商</Label>
        </div>
        {addresses.length > 0 && <p className="select-text text-xs text-muted-foreground">连接地址　{addresses.join('、')}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="submit" disabled={busy || needsName === null || (needsName && !displayName.trim())}>
          {busy ? '保存中…' : share ? '保存设置' : '开始共享'}
        </Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
