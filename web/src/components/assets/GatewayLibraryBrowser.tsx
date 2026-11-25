import { useCallback, useEffect, useRef, useState } from 'react';
import { AddIcon, AudioIcon, CheckIcon, CopyIcon, HelpIcon, LoadingIcon, RetryIcon, SearchIcon, VideoIcon } from '@/components/ui/icons';
import { SwapIcon } from '@/components/ui/swap-icon';
import { useCopyFeedback } from '@/lib/useCopyFeedback';
import { gatewayContentUrl, gatewayThumbUrl, listGatewayAssets, listGatewayLibraries, type GatewayLibraryEntry,
  type GatewayLibrarySelection, type GatewayLibrarySource } from '@/api/gatewayLibraries';
import { Button } from '@/components/ui/button';
import { useRetained } from '@/components/ui/retained';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Hint } from '@/components/ui/tooltip';
import { RevealImage } from '@/components/ui/reveal-image';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { AssetFilterPill } from './AssetFilterPill';
import { AssetMasonry, mediaRatio, useMediaSizes } from './AssetMasonry';
import { mediaDuration } from './AssetMediaTile';
import { Lightbox } from '@/components/Lightbox';
import { readTeamMedia, type UseTeamMedia, type UseTeamPrompt } from './teamAssetUse';

export function GatewayLibraryHelp() {
  return <Hint label="添加团队网关供应商后，能看到主机上开启共享的团队库">
    <Button size="icon" variant="ghost" className="size-7" aria-label="网关共享库说明"><HelpIcon /></Button>
  </Hint>;
}

/** Tab 挂载、每 30 秒、窗口重新可见时刷新；后到的旧响应不能恢复已停止的库。 */
export function useGatewayLibrarySources() {
  const [sources, setSources] = useState<GatewayLibrarySource[]>([]);
  const [revision, setRevision] = useState(0);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++request.current;
    try {
      const next = await listGatewayLibraries();
      if (token === request.current) setSources(next);
    } catch {
      if (token === request.current) setSources(current => current.map(source => ({ ...source, libraries: [], unreachable: true })));
    } finally {
      if (token === request.current) setRevision(value => value + 1);
    }
  }, []);
  const invalidate = useCallback(() => { ++request.current; }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { invalidate(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh, invalidate]);
  const remove = useCallback((selection: GatewayLibrarySelection) => {
    ++request.current;
    setSources(current => current.map(source => source.gateway_alias === selection.alias
      ? { ...source, libraries: source.libraries.filter(lib => lib.id !== selection.id) } : source));
  }, []);
  return { sources, revision, refresh, remove };
}

export function GatewayLibraryBrowser({ library, available, revision, onRefresh, onUnavailable, onUseMedia, onUsePrompt }: {
  library: GatewayLibrarySelection; available: boolean; revision: number;
  onRefresh: () => void; onUnavailable: () => void; onUseMedia?: UseTeamMedia; onUsePrompt?: UseTeamPrompt;
}) {
  const [using, setUsing] = useState<string | null>(null);
  const [useError, setUseError] = useState<string | null>(null);
  async function applyEntry(entry: GatewayLibraryEntry) {
    setUsing(entry.entry_id); setUseError(null);
    const local = { ...entry, id: entry.entry_id, mime_type: entry.mime_type ?? null };
    try {
      if (entry.kind === 'prompt') onUsePrompt?.(entry.prompt_text ?? '', local);
      else if (onUseMedia) await onUseMedia(await readTeamMedia(gatewayContentUrl(library, entry), local), local, `${library.alias}:${library.id}:${entry.entry_id}`);
    } catch { setUseError('读取失败'); } finally { setUsing(null); }
  }
  const actionButton = (entry: GatewayLibraryEntry) => <Button variant="solid" size="sm" className="rounded-full" disabled={using !== null || (entry.kind !== 'prompt' && !entry.has_content)} onClick={() => void applyEntry(entry)}>
    {using === entry.entry_id ? <LoadingIcon className="animate-spin" /> : <AddIcon />}使用</Button>;
  const [entries, setEntries] = useState<GatewayLibraryEntry[]>([]);
  const [viewing, setViewing] = useState<GatewayLibraryEntry | null>(null);
  // 关闭后沿用最后一条内容，弹窗带着它播完退场。
  const shownViewing = useRetained(viewing);
  const [preview, setPreview] = useState(0);
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [loading, setLoading] = useState(true);
  // 单张缩略图读不出（刚删掉、格式特殊）只把这一张换成占位；「已停止共享」只按列表接口失败判。
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const markBroken = (entryId: string) => setBroken(current => current.has(entryId) ? current : new Set(current).add(entryId));
  // 复制提示词：勾 1.5 秒后退回复制图标；浏览器拒绝剪贴板时提示失败。
  const [copyState, copyPrompt] = useCopyFeedback();
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const { sizes, measure } = useMediaSizes();
  useEffect(() => {
    if (!available) { setViewing(null); setEntries([]); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    void listGatewayAssets(library).then(next => {
      if (!alive) return;
      setEntries(next);
      setViewing(current => current ? next.find(entry => entry.entry_id === current.entry_id) ?? null : null);
    })
      .catch(() => { if (alive) unavailable.current(); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [library, available, revision]);
  const thumb = (entry: GatewayLibraryEntry, n = 0) => broken.has(entry.entry_id) ? null : entry.kind === 'prompt'
    ? (entry.preview_count > 0 ? gatewayThumbUrl(library, entry, Math.min(n, entry.preview_count - 1)) : null)
    : (entry.mime_type?.startsWith('image/') ? gatewayThumbUrl(library, entry) : null);
  const isImage = (entry: GatewayLibraryEntry) => entry.kind !== 'prompt' && Boolean(entry.mime_type?.startsWith('image/'));
  const placeholder = (entry: GatewayLibraryEntry) => <span className="grid aspect-square w-full place-content-center gap-2 rounded-md border border-border bg-card text-muted-foreground">
    {entry.mime_type?.startsWith('audio/') ? <AudioIcon size="xl" className="mx-auto" /> : <VideoIcon size="xl" className="mx-auto" />}
    <span className="text-center text-xs tabular-nums">{mediaDuration(entry.duration_s ?? undefined)}</span>
  </span>;
  const visible = entries.filter(entry => (type === 'all' || (type === 'prompt' ? entry.kind === 'prompt' : entry.mime_type?.startsWith(type + '/')))
    && [entry.title, entry.prompt_text, ...entry.tags].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <>
    <div className="flex items-center gap-2">
      <InputGroup className="min-w-0 flex-1"><InputGroupAddon><SearchIcon /></InputGroupAddon>
        <InputGroupInput aria-label="搜索网关共享库" placeholder="搜索" value={query} onChange={event => setQuery(event.target.value)} />
      </InputGroup>
      <Button size="icon" variant="outline" aria-label="刷新" onClick={onRefresh}><RetryIcon /></Button>
    </div>
    {useError && <p role="alert" className="text-sm text-destructive">{useError}</p>}
    {!available ? <p role="status" className="py-8 text-center text-sm text-muted-foreground">已停止共享</p> : <>
      <div role="group" aria-label="类型" className="flex flex-wrap gap-2">
        {([['all', '全部'], ['image', '图片'], ['video', '视频'], ['prompt', '提示词'],
          ...(entries.some(e => e.mime_type?.startsWith('audio/')) ? [['audio', '音频']] : [])]).map(([value, label]) =>
          <AssetFilterPill key={value} selected={type === value} onClick={() => setType(value)}>{label}</AssetFilterPill>)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{loading ? '加载中…' : '库里还没有内容'}</p>}
        <AssetMasonry items={visible} itemKey={entry => entry.entry_id} ratio={entry => mediaRatio(sizes[entry.entry_id] ?? entry)}>
          {entry => <div className="group min-w-0" draggable={false}>
            <div className="relative">
              <Button variant="ghost" aria-label={`查看 ${entry.title}`} className="block h-auto w-full p-0 text-left font-normal" onClick={() => { setViewing(entry); setPreview(0); }}>
                {thumb(entry) ? <RevealImage src={thumb(entry)!} draggable={false} alt={entry.title} className="w-full rounded-md border border-border object-contain"
                  onError={() => markBroken(entry.entry_id)} onLoad={event => measure(entry.entry_id, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
                  : entry.kind !== 'prompt' ? placeholder(entry) : null}
                {entry.kind === 'prompt' && <span className="block rounded-md border border-border bg-card p-3">
                  <span className="mb-2 block truncate text-sm font-medium">{entry.title}</span>
                  <span className="line-clamp-2 whitespace-normal text-xs text-muted-foreground">{entry.prompt_text}</span>
                </span>}
              </Button>
              <div className="absolute bottom-1 right-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">{actionButton(entry)}</div>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {entry.author && <span className="grid size-4 shrink-0 place-items-center rounded-full bg-secondary">{Array.from(entry.author)[0]}</span>}
              <span className="truncate">{entry.kind === 'prompt' ? entry.author : entry.title}</span>
            </div>
          </div>}
        </AssetMasonry>
      </div>
    </>}
    {/* 图片走全站 Lightbox：主机给了原文件就看原图、可下载，否则看缩略图；提示词与其他媒体仍用详情弹窗。 */}
    {viewing && available && isImage(viewing) && thumb(viewing) && <Lightbox
      src={viewing.has_content ? gatewayContentUrl(library, viewing) : thumb(viewing)!}
      downloadName={viewing.has_content ? viewing.title : undefined} onClose={() => setViewing(null)}
      details={<div className="flex flex-wrap items-center gap-3 text-xs text-white/80">
        <span className="font-medium text-white">{viewing.title}</span>
        {viewing.author && <span>{viewing.author}</span>}
        {actionButton(viewing)}
      </div>} />}
    {shownViewing && !(isImage(shownViewing) && thumb(shownViewing)) && <Dialog open={Boolean(available && viewing)} onOpenChange={open => { if (!open) setViewing(null); }}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{shownViewing.title}</DialogTitle></DialogHeader>
        <div className="min-h-0 space-y-3 overflow-y-auto">
          {thumb(shownViewing, preview) ? <img src={thumb(shownViewing, preview)!} alt={shownViewing.title} draggable={false} onError={() => markBroken(shownViewing.entry_id)}
            className="max-h-120 w-full rounded-lg object-contain" /> : shownViewing.kind !== 'prompt' ? placeholder(shownViewing) : null}
          {shownViewing.kind === 'prompt' && shownViewing.preview_count > 1 && <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: shownViewing.preview_count }, (_, n) => <Button key={n} variant="outline" className="h-auto p-1" aria-label={`效果图 ${n + 1}`} aria-pressed={n === preview} onClick={() => setPreview(n)}>
              <img src={thumb(shownViewing, n) ?? ''} draggable={false} alt="" className="aspect-square w-full rounded-md object-cover" />
            </Button>)}
          </div>}
          {shownViewing.kind === 'prompt' && <>
            <div className="flex items-center justify-between"><span className="text-xs text-muted-foreground">提示词</span>
              <Button variant="ghost" size="sm" onClick={() => copyPrompt(shownViewing.prompt_text ?? '')}>
                <SwapIcon swapKey={copyState === 'copied'} variant={copyState === 'copied' ? 'pop' : 'subtle'}>{copyState === 'copied' ? <CheckIcon /> : <CopyIcon />}</SwapIcon>复制
              </Button>
            </div><p className="whitespace-pre-wrap rounded-lg bg-card p-3 text-sm">{shownViewing.prompt_text}</p>
            {copyState === 'failed' && <p role="alert" className="text-xs text-destructive">复制失败</p>}
          </>}
        </div>
        <div className="flex justify-end">{actionButton(shownViewing)}</div>
      </DialogContent>
    </Dialog>}
  </>;
}
