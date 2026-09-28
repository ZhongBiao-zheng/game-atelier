import { Copy, FileAudio, FileVideo, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { mediaUrl } from '@/api/connection';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  assetMediaContent,
  type CreationAsset,
  type CreationAssetStaleness,
  type CreationMediaAssetContent,
  type CreationPromptSegment,
} from '@/schema/creationAssets';

export function AssetCard({ asset, busy, staleness, onOpen, onReproduce, onReadopt }: {
  asset: CreationAsset;
  busy: boolean;
  staleness?: CreationAssetStaleness;
  onOpen: () => void;
  onReproduce?: () => void;
  onReadopt?: () => void;
}) {
  const readopt = staleness === 'stale' ? onReadopt : undefined;
  const media = assetMediaContent(asset);
  // 「复刻」是卡片外的兄弟按钮：按钮不能嵌套在打开详情的按钮里。
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-border bg-card">
      <button type="button" className="w-full p-3 text-left outline-none hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary" onClick={onOpen}>
        {media && <MediaPreview assetId={asset.asset_id} content={media} alt="" className="mb-3 aspect-[4/3] w-full rounded-md bg-secondary object-cover" />}
        <p className="truncate text-sm font-medium">{asset.title}</p>
        {asset.content.kind === 'prompt' ? <PromptPreview segments={asset.content.segments} /> : <p className="mt-1 truncate text-xs text-muted-foreground">{media?.filename}</p>}
        <TagList tags={asset.tags} />
        <StalenessBadge staleness={staleness} className="mt-2" />
      </button>
      {(onReproduce || readopt) && (
        <div className="flex gap-2 px-3 pb-3">
          {readopt && <Button size="sm" variant="outline" disabled={busy} onClick={readopt}><RefreshCw />重新采用</Button>}
          {onReproduce && <Button size="sm" variant="outline" disabled={busy} onClick={onReproduce}><Copy />复刻</Button>}
        </div>
      )}
    </div>
  );
}

/** 媒体地址带内容版本：重新采用换了内容后 URL 跟着变，浏览器不会继续显示缓存的旧图。
 *  走 mediaUrl：托管网站的 `<img>` 带不了会话头，要拼上本机地址与媒体令牌。 */
export function assetMediaSrc(assetId: string, content: CreationMediaAssetContent): string {
  return mediaUrl(`/api/creation-assets/${encodeURIComponent(assetId)}/content?v=${content.sha256.slice(0, 12)}`);
}

/** 已入库的媒体：图片直接显示，视频/音频给原生播放器。 */
export function MediaPreview({ assetId, content, alt, className }: {
  assetId: string;
  content: CreationMediaAssetContent;
  alt: string;
  className: string;
}) {
  const src = assetMediaSrc(assetId, content);
  if (content.mime_type.startsWith('image/')) return <img src={src} alt={alt} loading="lazy" className={className} />;
  if (content.mime_type.startsWith('video/')) return <video src={src} muted playsInline preload="metadata" className={className} />;
  if (content.mime_type.startsWith('audio/')) return <audio src={src} controls preload="metadata" className="w-full" />;
  return null;
}

export function PromptPreview({ segments }: { segments: CreationPromptSegment[] }) {
  return <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{segments.map((segment, index) => segment.kind === 'text' ? segment.text : <span key={`${segment.name}-${index}`} className="mx-0.5 rounded border border-border bg-secondary px-1"><span className="text-muted-foreground">{segment.name}：</span><span className="text-foreground/80">{segment.default_value}</span></span>)}</p>;
}

export function DeleteAssetButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return <div className="border-t border-border pt-4"><Button variant="ghost" className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={disabled} onClick={onClick}><Trash2 />删除资产</Button></div>;
}

export function AssetDetail({ asset, busy, staleness, onUse, onReproduce, onReadopt, onEdit, onDelete }: {
  asset: CreationAsset;
  busy: boolean;
  staleness?: CreationAssetStaleness;
  onUse: () => void;
  onReproduce?: () => void;
  onReadopt?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const media = assetMediaContent(asset);
  const readopt = staleness === 'stale' ? onReadopt : undefined;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {media && <MediaPreview assetId={asset.asset_id} content={media} alt={asset.title} className="aspect-square w-full rounded-lg border border-border bg-secondary object-contain" />}
      <h2 className="mt-3 text-base font-medium">{asset.title}</h2>
      {asset.content.kind === 'prompt' && <PromptPreview segments={asset.content.segments} />}
      <TagList tags={asset.tags} />
      <StalenessBadge staleness={staleness} className="mt-2" />
      <div className="mt-4 flex gap-2">
        <Button className="flex-1" disabled={busy} onClick={onUse}>使用</Button>
        {readopt && <Button variant="outline" disabled={busy} onClick={readopt}><RefreshCw />重新采用</Button>}
        {onReproduce && <Button variant="outline" disabled={busy} onClick={onReproduce}><Copy />复刻</Button>}
        {onEdit && <Button variant="outline" disabled={busy} onClick={onEdit}>编辑</Button>}
      </div>
      {onDelete && <div className="mt-4"><DeleteAssetButton disabled={busy} onClick={onDelete} /></div>}
    </div>
  );
}

export function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5">{tags.map(tag => <span key={tag} className="rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">{tag}</span>)}</div>;
}

/** 采用副本相对团队库来源的状态：fresh / unknown 不打扰。 */
export function StalenessBadge({ staleness, className }: { staleness?: CreationAssetStaleness; className?: string }) {
  if (staleness === 'stale') return <p className={cn('text-xs text-[color:var(--status-running)]', className)}>来源已更新</p>;
  if (staleness === 'withdrawn') return <p className={cn('text-xs text-[color:var(--status-failed)]', className)}>来源已撤回</p>;
  return null;
}

/** 还没上传的本地文件：图片出缩略图，其余用图标占位。 */
export function PendingFilePreview({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  const isImage = file.type.startsWith('image/');
  useEffect(() => {
    if (!isImage) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file, isImage]);
  if (isImage) {
    return url ? <img src={url} alt="待保存媒体预览" className="aspect-square w-full rounded-lg border border-border object-contain" /> : null;
  }
  const Icon = file.type.startsWith('audio/') ? FileAudio : FileVideo;
  return (
    <div className="grid aspect-square w-full place-items-center gap-2 rounded-lg border border-border text-muted-foreground">
      <Icon className="size-8" />
      <p className="max-w-full truncate px-4 text-xs">{file.name}</p>
    </div>
  );
}

/** 已在磁盘上的待保存媒体（Studio / 画布结果）：视频给首帧，其余当图片。 */
export function PathPreview({ src, video }: { src: string; video: boolean }) {
  const className = 'aspect-square w-full rounded-lg border border-border object-contain';
  if (video) return <video src={src} muted playsInline preload="metadata" aria-label="媒体资产预览" className={className} />;
  return <img src={src} alt="媒体资产预览" className={className} />;
}

const VIDEO_SUFFIX = /\.(mp4|webm|mov)$/i;

/** 调用方没说媒体类型时的退路：只看 sourcePath 去掉查询串后的后缀，不从预览 URL 猜。 */
export function isVideoSourcePath(sourcePath: string | undefined): boolean {
  return VIDEO_SUFFIX.test((sourcePath ?? '').split(/[?#]/)[0]);
}
