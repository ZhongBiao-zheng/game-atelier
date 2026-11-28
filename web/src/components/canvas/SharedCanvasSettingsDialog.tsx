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
import { CheckIcon, CopyIcon } from '@/components/ui/icons';
import { SwapIcon } from '@/components/ui/swap-icon';
import { SwapLabel } from '@/components/ui/swap-label';
import { Collapse } from '@/components/ui/collapse';
import { useRetained } from '@/components/ui/retained';
import { errorText } from '@/lib/errorText';
import { useCopyFeedback } from '@/lib/useCopyFeedback';
import type { CollabCard, CollabMode } from '@/schema/collab';

function CopyAddress({ address }: { address: string }) {
  const [state, copy] = useCopyFeedback();
  return <span className="flex items-center gap-1">
    <span className="select-text truncate font-mono text-xs text-muted-foreground">{address}</span>
    <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={state === 'copied' ? '已复制' : '复制 ' + address}
      onClick={() => copy(address)}>
      <SwapIcon swapKey={state === 'copied'} variant="pop">{state === 'copied' ? <CheckIcon /> : <CopyIcon />}</SwapIcon>
    </Button>
  </span>;
}

export function SharedCanvasSettingsDialog({ open = true, projectId, name, share, onClose, onSaved }: {
  /** 不传时一直打开（调用方条件挂载）；受控时关闭能播退场。 */
  open?: boolean; projectId: string; name: string; share?: CollabCard; onClose: () => void; onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [needsName, setNeedsName] = useState<boolean | null>(null);
  const [mode, setMode] = useState<CollabMode>(share?.mode ?? 'edit');
  const [borrow, setBorrow] = useState(share?.allow_borrow_provider ?? false);
  const [changePasscode, setChangePasscode] = useState(!share?.requires_passcode);
  const [passcode, setPasscode] = useState('');
  const [addresses, setAddresses] = useState<string[]>([]);
  const [error, setError] = useState('');
  const shownError = useRetained(error || null);
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

  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
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
        {addresses.length > 0 && <div className="grid gap-1"><span className="text-xs text-muted-foreground">连接地址</span>
          {addresses.map(address => <CopyAddress key={address} address={address} />)}</div>}
        <Collapse open={Boolean(error)}><p role="alert" className="text-sm text-destructive">{shownError}</p></Collapse>
        <DialogFooter><Button type="submit" disabled={busy || needsName === null || (needsName && !displayName.trim())}>
          <SwapLabel active={busy} on="保存中…" off={share ? '保存设置' : '开始共享'} />
        </Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
