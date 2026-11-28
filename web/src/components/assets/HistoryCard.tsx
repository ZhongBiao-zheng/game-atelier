import { Fragment, useState } from 'react';
import { motion } from 'motion/react';
import { canvasThumbnailWidth } from '@/api/canvas';
import type { HistoryItem } from '@/api/history';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AddImageIcon, DeleteIcon, DownloadIcon, FavoriteIcon, FolderIcon, MoreIcon, PlayIcon } from '@/components/ui/icons';
import { useWaveform } from '@/components/canvas/CanvasAudioPlayer';
import { MOTION_DURATION, MOTION_EASE, prefersReducedMotion } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { mediaRatio } from './AssetMasonry';

export const historyActions = [
  { key: 'reference', label: '用作参考', Icon: AddImageIcon },
  { key: 'folder', label: '加入文件夹', Icon: FolderIcon },
  { key: 'favorite', label: '收藏', Icon: FavoriteIcon },
  { key: 'download', label: '下载', Icon: DownloadIcon },
  { key: 'delete', label: '删除', Icon: DeleteIcon },
] as const;
export type HistoryAction = typeof historyActions[number]['key'];

export function historyRatio(item: HistoryItem) {
  return item.kind === 'text' || item.kind === 'audio' ? 1.8 : mediaRatio(item);
}

function Waveform({ url }: { url: string }) {
  const wave = useWaveform(url);
  return <span aria-hidden className="flex h-10 w-full items-center justify-center gap-0.5 px-2">
    {Array.from({ length: 30 }, (_, i) => {
      const peak = wave?.peaks[Math.floor(i * wave.peaks.length / 30)] ?? 0;
      return <span key={i} className="min-h-px w-1 rounded-full bg-muted-foreground" style={{ height: `${peak * 100}%` }} />;
    })}
  </span>;
}

export function HistoryCard({ item, selecting, checked, removing, busy, onToggle, onPreview, onAction, extraMenu }:  {
  extraMenu?: React.ReactNode;
  item: HistoryItem; selecting: boolean; checked: boolean; removing: boolean; busy: boolean;
  onToggle: (range: boolean) => void; onPreview: () => void; onAction: (action: HistoryAction) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [duration, setDuration] = useState(item.duration);
  const reduced = prefersReducedMotion();
  return <motion.div className="overflow-hidden" initial={false}
    animate={removing ? { height: reduced ? 'auto' : 0, opacity: 0 } : { height: 'auto', opacity: 1 }}
    transition={{ duration: MOTION_DURATION.slow, ease: MOTION_EASE.inOut }}>
    <div className={cn('group relative isolate overflow-hidden rounded-sm bg-card media-edge', checked && 'outline -outline-offset-2 outline-primary')}
      onContextMenu={e => { e.preventDefault(); if (!selecting) setMenu(true); }} style={{ aspectRatio: historyRatio(item) }}>
      <Button variant="ghost" aria-label={item.prompt || item.filename}
        className="grid size-full place-items-center overflow-hidden whitespace-normal rounded-sm border-0 hover:bg-transparent hover:backdrop-blur-none p-0 text-left font-normal focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        onClick={event => selecting || event.shiftKey ? onToggle(event.shiftKey) : onPreview()}>
        {item.kind === 'image' && <img alt="" loading="lazy" src={`${item.thumbnail_url}&width=${canvasThumbnailWidth(200)}`} className="size-full object-cover" />}
        {item.kind === 'video' && <>
          <video src={item.thumbnail_url} muted playsInline preload="metadata" className="size-full object-cover"
            onLoadedMetadata={event => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }} />
          <span className="absolute grid size-7 place-items-center rounded-full bg-scrim text-white"><PlayIcon className="fill-current" /></span>
        </>}
        {item.kind === 'text' && <span className="mx-3 mt-8 line-clamp-3 self-start justify-self-start whitespace-pre-line break-words text-sm">{item.text_preview}</span>}
        {item.kind === 'audio' && <Waveform url={item.url} />}
        {(item.kind === 'audio' || item.kind === 'video') && duration != null && <span className="absolute bottom-1.5 right-1.5 rounded-sm bg-scrim px-1 text-xs tabular-nums text-white">
            {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, '0')}
          </span>}
      </Button>
      <div className={cn('absolute inset-x-1.5 top-1.5 flex items-start justify-between pointer-events-none', !selecting && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100')}>
        <Checkbox aria-label={`选择 ${item.filename}`} checked={checked} disabled={busy}
          className="pointer-events-auto size-5 bg-popover border-muted-foreground history-checkbox"
          onClick={event => onToggle(event.shiftKey)} />
        {!selecting && <DropdownMenu open={menu} onOpenChange={setMenu}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="更多操作"
          className="pointer-events-auto size-6 rounded-full border-0 bg-scrim text-white"><MoreIcon size="sm" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">{extraMenu}{historyActions.map(({ key, label, Icon }) =>
            <Fragment key={key}>{key === 'delete' && <DropdownMenuSeparator />}
              <DropdownMenuItem destructive={key === 'delete'} disabled={busy} onSelect={() => onAction(key)}><Icon />{label}</DropdownMenuItem>
            </Fragment>
          )}</DropdownMenuContent></DropdownMenu>}
      </div>
    </div>
  </motion.div>;
}
