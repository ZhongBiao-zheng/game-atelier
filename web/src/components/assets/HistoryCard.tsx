import { Fragment, useState } from 'react';
import { canvasThumbnailWidth } from '@/api/canvas';
import { historyKey, type HistoryItem } from '@/api/history';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RevealImage } from '@/components/ui/reveal-image';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AddImageIcon, DeleteIcon, DownloadIcon, MoreIcon, PlayIcon } from '@/components/ui/icons';
import { useWaveform } from '@/components/canvas/CanvasAudioPlayer';
import { prefersReducedMotion } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { mediaRatio } from './AssetMasonry';

export const historyActions = [
  { key: 'reference', label: '用作参考', Icon: AddImageIcon },
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

/** arrived：任务刚出结果、出现在顶部的新卡片，挂载时淡入。highlighted：撤销删除后回到原位的卡片，描边约 1.5 秒。 */
export function HistoryCard({ item, selecting, checked, removing, arrived = false, highlighted = false, busy, onToggle, onPreview, onAction }: {
  item: HistoryItem; selecting: boolean; checked: boolean; removing: boolean; arrived?: boolean; highlighted?: boolean; busy: boolean;
  onToggle: (range: boolean) => void; onPreview: (sourceRect: DOMRect) => void; onAction: (action: HistoryAction) => void;
}) {
  const [duration, setDuration] = useState(item.duration);
  const reduced = prefersReducedMotion();
  // 删除：grid-rows 1fr→0fr 收起并淡出，只动这一张的高度；减弱动态效果时只淡出。
  return <div data-history-key={historyKey(item)} className={cn('grid transition-[grid-template-rows,opacity] duration-300 ease-in-out', arrived && 'content-swap-in',
    removing ? 'opacity-0' : 'opacity-100', removing && !reduced ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]')}>
    <div className="min-h-0 overflow-hidden">
    <div className={cn('group relative isolate overflow-hidden rounded-sm bg-card media-edge outline -outline-offset-2 transition-[outline-color]',
      checked || highlighted ? 'outline-primary' : 'outline-transparent')}
      style={{ aspectRatio: historyRatio(item) }}>
      <Button variant="ghost" aria-label={item.prompt || item.filename}
        className="grid size-full place-items-center overflow-hidden whitespace-normal rounded-sm border-0 hover:bg-transparent hover:backdrop-blur-none p-0 text-left font-normal focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
        onClick={event => selecting || event.shiftKey ? onToggle(event.shiftKey) : onPreview(event.currentTarget.getBoundingClientRect())}>
        {item.kind === 'image' && <RevealImage alt="" loading="lazy" src={`${item.thumbnail_url}&width=${canvasThumbnailWidth(200)}`} className="size-full object-cover" />}
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
      <div className={cn('absolute inset-x-1.5 top-1.5 flex items-start justify-between pointer-events-none transition-opacity duration-150', !selecting && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100')}>
        <Checkbox aria-label={`选择 ${item.filename}`} checked={checked} disabled={busy}
          className="pointer-events-auto size-5 bg-popover border-muted-foreground history-checkbox"
          onClick={event => onToggle(event.shiftKey)} />
        {!selecting && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="更多操作"
          className="pointer-events-auto size-6 rounded-full border-0 bg-scrim text-white"><MoreIcon size="sm" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">{historyActions.map(({ key, label, Icon }) =>
            <Fragment key={key}>{key === 'delete' && <DropdownMenuSeparator />}
              <DropdownMenuItem destructive={key === 'delete'} disabled={busy} onSelect={() => onAction(key)}><Icon />{label}</DropdownMenuItem>
            </Fragment>
          )}</DropdownMenuContent></DropdownMenu>}
      </div>
    </div>
    </div>
  </div>;
}
