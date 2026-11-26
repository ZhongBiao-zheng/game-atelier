import { useCallback, useEffect, useRef, useState } from 'react';
import { connectCollabPeer, listCollabPeers, remoteProjectPath, stopCollabShare } from '@/api/collab';
import { canvasMediaUrl } from '@/api/canvas';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LockIcon, ShareIcon } from '@/components/ui/icons';
import { RevealImage } from '@/components/ui/reveal-image';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorText } from '@/lib/errorText';
import { COLLAB_PROTOCOL_VERSION, type CollabCard } from '@/schema/collab';
import { SharedCanvasSettingsDialog } from './SharedCanvasSettingsDialog';

export function useSharedCanvases() {
  const [cards, setCards] = useState<CollabCard[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const call = ++generation.current;
    try {
      const peers = await listCollabPeers();
      if (call !== generation.current) return;
      setCards([...peers].sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
      setError('');
    } catch (reason) { if (call === generation.current) setError(errorText(reason)); }
    finally { if (call === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const cancelPending = () => { ++generation.current; };
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    return () => { cancelPending(); window.clearInterval(timer); };
  }, [refresh]);
  return {cards, error, loading, refresh};
}

export function SharedStatusButton({shares, refresh}: {shares: CollabCard[]; refresh: () => void}) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<CollabCard | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function stop() {
    setBusy(true);
    try { await stopCollabShare(); refresh(); setOpen(false); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  return <>
    {shares.length > 0 && <Button variant="outline" size="sm" className="rounded-full" onClick={() => { setError(''); setOpen(true); }}>
      <ShareIcon />共享中（{shares.length}）
    </Button>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>我共享的画布</DialogTitle></DialogHeader>
        <div className="grid max-h-80 gap-1 overflow-y-auto">{shares.map(card =>
          <Button key={card.project_id} variant="ghost" className="justify-between" onClick={() => { setOpen(false); setConfig(card); }}>
            <span className="truncate">{card.name}</span><span className="text-xs text-muted-foreground">共享设置</span>
          </Button>)}</div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => void stop()}>全部停止共享</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {config && <SharedCanvasSettingsDialog projectId={config.project_id} name={config.name} share={config}
      onClose={() => setConfig(null)} onSaved={() => { setConfig(null); refresh(); }} />}
  </>;
}

export function EditorSharedStatus() {
  const {cards, refresh} = useSharedCanvases();
  return <SharedStatusButton shares={cards.filter(card => card.is_self)} refresh={refresh} />;
}

export function SharedCanvasList({cards, error, loading, refresh, onOpen}: {
  cards: CollabCard[]; error: string; loading: boolean; refresh: () => void; onOpen: (card: CollabCard) => void;
}) {
  const [query, setQuery] = useState('');
  const [owner, setOwner] = useState('');
  const [connectOpen, setConnectOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [connectError, setConnectError] = useState('');
  const [busy, setBusy] = useState(false);
  const hosts = new Map(cards.map(card => [card.peer_key, card.display_name]));
  const filtered = cards.filter(card =>
    (!owner || card.peer_key === owner) && card.name.toLowerCase().includes(query.trim().toLowerCase()));
  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setConnectError('');
    try { await connectCollabPeer(address.trim()); refresh(); setConnectOpen(false); }
    catch (reason) { setConnectError(errorText(reason)); }
    finally { setBusy(false); }
  }

  return <div className="space-y-5">
    <div className="flex flex-wrap gap-2">
      <Input className="w-52" aria-label="搜索共享画布" placeholder="搜索共享画布" value={query} onChange={e => setQuery(e.target.value)} />
      <Select value={owner || 'all'} onValueChange={value => setOwner(value === 'all' ? '' : value)}>
        <SelectTrigger className="w-40" aria-label="按分享人筛选"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部分享人</SelectItem>
          {[...hosts].map(([key, name]) => <SelectItem key={key} value={key}>{name}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button variant="outline" onClick={() => { setConnectError(''); setConnectOpen(true); }}>手动连接</Button>
    </div>
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    {!loading && !error && filtered.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">
      {query || owner ? '没有匹配的共享画布' : '局域网中暂无共享画布'}
    </p>}
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-busy={loading}>
      {filtered.map(card => {
        const compatible = card.protocol_version === COLLAB_PROTOCOL_VERSION;
        const cover = card.cover_version_id && (card.is_self
          ? canvasMediaUrl(card.project_id, card.cover_version_id, 360)
          : !card.requires_passcode && remoteProjectPath(card.peer_key, card.project_id) + '/cover');
        return <Button key={card.peer_key + '/' + card.project_id} variant="outline"
          className="block h-auto w-full overflow-hidden whitespace-normal rounded-xl p-0 text-left"
          disabled={!compatible} onClick={() => onOpen(card)}>
          <div className="grid aspect-[16/10] place-items-center overflow-hidden border-b border-border bg-secondary/30">
            {cover ? <RevealImage src={cover} alt="" loading="lazy" className="size-full object-cover" />
              : <span className="line-clamp-2 px-4 text-center font-display text-display text-muted-foreground">{card.name}</span>}
          </div>
          <div className="space-y-1 p-4">
            <p className="flex items-center gap-2"><span className="truncate">{card.name}</span>{card.requires_passcode && <LockIcon aria-label="需要口令" />}</p>
            <p className="truncate text-xs font-normal text-muted-foreground">{compatible
              ? [card.is_self ? '我的共享' : card.display_name, card.mode === 'view' ? '仅查看' : '可协作', `${card.online_count} 人在线`].join(' · ')
              : '对方版本不兼容，请更新'}</p>
          </div>
        </Button>;
      })}
    </div>
    <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>手动连接</DialogTitle></DialogHeader>
        <form className="grid gap-3" autoComplete="off" onSubmit={connect}>
          <Label htmlFor="collab-address">房主的局域网地址</Label>
          <Input id="collab-address" placeholder="192.168.1.20:5181" value={address} required onChange={e => setAddress(e.target.value)} />
          {connectError && <p role="alert" className="text-sm text-destructive">{connectError}</p>}
          <DialogFooter><Button type="submit" disabled={busy || !address.trim()}>{busy ? '连接中…' : '连接'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
