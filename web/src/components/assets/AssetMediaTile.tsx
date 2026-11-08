import { AudioIcon, ImageFileIcon, PlayIcon } from '@/components/ui/icons';
import { useEffect, useRef, useState } from 'react';
import type { MediaSize } from './AssetMasonry';

export function mediaDuration(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}

/** 图片不铺底；视频/音频接近视区后只预载元数据，列表不放播放器控件。 */
export function AssetMediaTile({ src, mimeType, alt, size, onMeasure }: {
  src: string;
  mimeType: string;
  alt: string;
  size?: MediaSize | { width?: number | null; height?: number | null };
  onMeasure?: (size: MediaSize) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [bound, setBound] = useState(false);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState<MediaSize>();
  const image = mimeType.startsWith('image/');
  const video = mimeType.startsWith('video/');
  const audio = mimeType.startsWith('audio/');
  useEffect(() => { setBroken(false); setLoaded(undefined); }, [src]);
  useEffect(() => {
    if (image || !ref.current) return;
    if (!('IntersectionObserver' in window)) { setBound(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setBound(true); observer.disconnect(); }
    }, { rootMargin: '240px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [image, src]);
  const measured = size?.width && size?.height ? size : loaded;
  const aspectRatio = !audio && measured?.width && measured?.height ? `${measured.width} / ${measured.height}` : '1';
  const measure = (next: MediaSize) => { setLoaded(next); onMeasure?.(next); };
  const duration = mediaDuration(loaded?.duration ?? (size && 'duration' in size ? size.duration : undefined));
  return <span ref={ref} className="relative block w-full overflow-hidden rounded-md border border-border" style={{ aspectRatio }}>
    {image && !broken ? <img src={src} alt={alt} loading="lazy" draggable={false}
      className="block h-full w-full object-cover" style={{ aspectRatio }}
      onLoad={event => measure({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      onError={() => setBroken(true)} />
      : video && !broken ? <video src={bound ? src : undefined} muted playsInline preload="metadata"
        className="block h-full w-full object-cover" aria-label={alt}
        onError={() => setBroken(true)} onLoadedMetadata={event => measure({ width: event.currentTarget.videoWidth,
          height: event.currentTarget.videoHeight, duration: event.currentTarget.duration })} />
        : <span className="grid h-full w-full place-items-center bg-card text-muted-foreground">
          {audio ? <AudioIcon size="xl" /> : <ImageFileIcon size="xl" />}
        </span>}
    {audio && <audio src={bound ? src : undefined} preload="metadata" className="hidden" onLoadedMetadata={event => measure({ width: 1, height: 1, duration: event.currentTarget.duration })} />}
    {(video || (audio && duration)) && <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full border border-border bg-glass px-2 py-0.5 text-xs tabular-nums backdrop-blur-glass">
      {video && <PlayIcon size="sm" />}{duration}
    </span>}
  </span>;
}
