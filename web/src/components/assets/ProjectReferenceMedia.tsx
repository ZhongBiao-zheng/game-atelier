import type { CreationMediaAssetContent } from '@/schema/creationAssets';
import { Button } from '@/components/ui/button';
import { RevealImage } from '@/components/ui/reveal-image';

export function assetMediaSrc(assetId: string, content: CreationMediaAssetContent): string {
  return `/api/creation-assets/${encodeURIComponent(assetId)}/content?v=${content.sha256.slice(0, 12)}`;
}

/** 已入库的媒体：图片直接显示（给了 onZoom 时点图进大图），视频/音频给原生播放器。 */
export function MediaPreview({ assetId, content, alt, className, onZoom }: {
  assetId: string;
  content: CreationMediaAssetContent;
  alt: string;
  className: string;
  onZoom?: () => void;
}) {
  const src = assetMediaSrc(assetId, content);
  if (content.mime_type.startsWith('image/') && onZoom) return <Button variant="ghost" aria-label={`查看大图 ${alt}`}
    className="block h-auto w-full cursor-zoom-in p-0" onClick={onZoom}><RevealImage src={src} alt={alt} loading="lazy" className={className} /></Button>;
  if (content.mime_type.startsWith('image/')) return <RevealImage src={src} alt={alt} loading="lazy" className={className} />;
  if (content.mime_type.startsWith('video/')) return <video src={src} controls playsInline preload="metadata" className={className} />;
  if (content.mime_type.startsWith('audio/')) return <audio src={src} controls preload="metadata" className="w-full" />;
  return null;
}
