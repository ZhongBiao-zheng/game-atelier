import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { connectCollabPeer, listCollabPeers, remoteProjectPath, stopCollabShare } from '@/api/collab';
import { canvasMediaUrl } from '@/api/canvas';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LockIcon, ShareIcon } from '@/components/ui/icons';
import { RevealImage } from '@/components/ui/reveal-image';
import { useRetainedSession } from '@/components/ui/retained';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorText } from '@/lib/errorText';
import { MOTION_DURATION, MOTION_EASE, MOTION_SPRING } from '@/lib/motion';
import { COLLAB_PROTOCOL_VERSION, type CollabCard } from '@/schema/collab';
import { SharedCanvasSettingsDialog } from './SharedCanvasSettingsDialog';

export function useSharedCanvases() {
  const [cards, setCards] = useState<CollabCard[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  // 卡片位置按第一次出现的顺序固定：有人在编辑也不往前跳，新上线的接在末尾。
  const order = useRef(new Map<string, number>());
  const refresh = useCallback(async () => {
    const call = ++generation.current;
    try {
      const peers = await listCollabPeers();
      if (call !== generation.current) return;
      const seen = order.current;
      [...peers].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).forEach(card => {
        const key = card.peer_key + '/' + card.project_id;
        if (!seen.has(key)) seen.set(key, seen.size);
      });
      const rank = (card: CollabCard) => seen.get(card.peer_key + '/' + card.project_id) ?? 0;
      setCards([...peers].sort((a, b) => rank(a) - rank(b)));
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
  const [confirmAll, setConfirmAll] = useState(false);
  const shownConfig = useRetainedSession(config);
  async function stop(projectId?: string) {
    setBusy(true);
    setConfirmAll(false);
    try {
      await stopCollabShare(projectId);
      refresh();
      if (!projectId || shares.length <= 1) setOpen(false);
    }
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
          <div key={card.project_id} className="flex items-center gap-1">
            <Button variant="ghost" className="min-w-0 flex-1 justify-between" onClick={() => { setOpen(false); setConfig(card); }}>
              <span className="truncate">{card.name}</span><span className="text-xs text-muted-foreground">共享设置</span>
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void stop(card.project_id)}>停止共享</Button>
          </div>)}</div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {shares.length > 1 && <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setConfirmAll(true)}>全部停止共享</Button>
        </DialogFooter>}
      </DialogContent>
    </Dialog>
    <ConfirmDialog open={confirmAll} title={`停止全部 ${shares.length} 个共享？`} message="正在协作的成员会断开连接。"
      confirmText="全部停止" variant="destructive" onConfirm={() => void stop()} onCancel={() => setConfirmAll(false)} />
    {shownConfig && <SharedCanvasSettingsDialog key={shownConfig.session} open={Boolean(config)} projectId={shownConfig.value.project_id}
      name={shownConfig.value.name} share={shownConfig.value}
      onClose={() => setConfig(null)} onSaved={() => { setConfig(null); refresh(); }} />}
  </>;
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
      <Button variant="outline" onClick={() => { setConnectError(''); setConnectOpen(true); }}>通过地址查找</Button>
    </div>
    {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    {!loading && !error && filtered.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">
      {query || owner ? '没有匹配的共享画布' : '尚未发现局域网内的共享画布'}
    </p>}
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-busy={loading}>
      <AnimatePresence initial={false}>{filtered.map(card => {
        const compatible = card.protocol_version === COLLAB_PROTOCOL_VERSION;
        const cover = card.cover_version_id && (card.is_self
          ? canvasMediaUrl(card.project_id, card.cover_version_id, 360)
          : !card.requires_passcode && remoteProjectPath(card.peer_key, card.project_id) + '/cover');
        return <motion.div key={card.peer_key + '/' + card.project_id} layout
          initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0, transition:{duration:MOTION_DURATION.fast, ease:MOTION_EASE.subtle}}}
          transition={{layout:MOTION_SPRING.snappy, opacity:{duration:MOTION_DURATION.base, ease:MOTION_EASE.subtle}}}>
        <Button variant="outline"
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
        </Button></motion.div>;
      })}</AnimatePresence>
    </div>
    <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>通过地址查找画布</DialogTitle>
          <DialogDescription>同一局域网内没看到对方的画布时，请房主发来「共享设置」里的连接地址。</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" autoComplete="off" onSubmit={connect}>
          <Label htmlFor="collab-address">房主的局域网地址</Label>
          <Input id="collab-address" placeholder="192.168.1.20:5181" value={address} required onChange={e => setAddress(e.target.value)} />
          {connectError && <p role="alert" className="text-sm text-destructive">{connectError}</p>}
          <DialogFooter><Button type="submit" disabled={busy || !address.trim()}>{busy ? '查找中…' : '查找画布'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
