import { useState } from 'react';
import { Download, EyeOff } from 'lucide-react';
import { canvasDownloadUrl, canvasMediaUrl } from '@/api/canvas';
import { Button } from '@/components/ui/button';
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { CanvasContentVersion, CanvasLayerStackNode } from '@/schema/canvas';
import { cn } from '@/lib/utils';
import { orderedLayerStackParts } from './canvasLayerOrder';

interface LayerPreviewProps {
  node: CanvasLayerStackNode;
  projectId: string;
  resolveVersion: (id: string | null | undefined) => CanvasContentVersion | undefined;
}

/** 节点和详情共用同一合成逻辑，避免两处的遮挡顺序与素材位置分叉。 */
export function CanvasLayerStackComposite({ node, projectId, resolveVersion, hoveredLayerId }: LayerPreviewProps & {
  hoveredLayerId?: string | null;
}) {
  const [failedVersions, setFailedVersions] = useState<Set<string>>(() => new Set());
  const base = resolveVersion(node.data.base_version_id);
  const width = node.data.layout_size?.width ?? (base?.kind === 'image' ? base.width : undefined);
  const height = node.data.layout_size?.height ?? (base?.kind === 'image' ? base.height : undefined);
  if (!width || !height) return <p role="status" className="p-4 text-sm text-muted-foreground">图片不可用</p>;
  const parts = orderedLayerStackParts(node);
  const incomplete = parts.some(part => part.visible
    && (resolveVersion(part.versionId)?.kind !== 'image' || failedVersions.has(part.versionId)));
  return <div className="relative h-full w-full">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${node.title} 合成预览`}
    className="h-full w-full" preserveAspectRatio="xMidYMid meet">
    {parts.map(part => {
      if (!part.visible || resolveVersion(part.versionId)?.kind !== 'image') return null;
      const [left, top, right, bottom] = part.layer?.bounding_box.absolute ?? [0, 0, width, height];
      return <image key={part.key} data-layer-stack-part={part.layer?.id ?? 'base'}
        href={canvasMediaUrl(projectId, part.versionId)} x={left} y={top} width={right - left}
        height={bottom - top} preserveAspectRatio="xMidYMid meet"
        onError={() => setFailedVersions(current => current.has(part.versionId) ? current : new Set(current).add(part.versionId))}
        onLoad={() => setFailedVersions(current => {
          if (!current.has(part.versionId)) return current;
          const next = new Set(current); next.delete(part.versionId); return next;
        })} />;
    })}
    {parts.map(({ layer, visible }) => {
      if (!layer || !visible || layer.id !== hoveredLayerId) return null;
      const [left, top, right, bottom] = layer.bounding_box.absolute;
      return <rect key={layer.id} x={left} y={top} width={right - left} height={bottom - top}
        fill="none" stroke="var(--primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" pointerEvents="none" />;
    })}
    </svg>
    {incomplete && <p role="status" className="absolute inset-x-2 bottom-2 rounded-md bg-popover px-3 py-2 text-center text-sm text-muted-foreground">部分图层不可用</p>}
  </div>;
}

export function CanvasLayerStackPreview({ node, projectId, resolveVersion, onCloseAutoFocus }: LayerPreviewProps & {
  onCloseAutoFocus: (event: Event) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [failedVersion, setFailedVersion] = useState<string | null>(null);
  const parts = orderedLayerStackParts(node).reverse();
  const selected = parts.find(part => part.key === selectedKey);
  const base = resolveVersion(node.data.base_version_id);
  const hasComposite = Boolean(node.data.base_version_id);
  const version = resolveVersion(selected?.versionId ?? (hasComposite ? null : node.data.source_version_id));
  const image = version?.kind === 'image' ? version : null;
  const width = selected ? image?.width : node.data.layout_size?.width ?? (base?.kind === 'image' ? base.width : image?.width);
  const height = selected ? image?.height : node.data.layout_size?.height ?? (base?.kind === 'image' ? base.height : image?.height);
  const title = selected?.name ?? (hasComposite ? '合成预览' : '原图');
  return <DialogContent className="flex h-[88dvh] max-w-6xl flex-col overflow-hidden" onCloseAutoFocus={onCloseAutoFocus}>
    <DialogHeader>
      <DialogTitle className="break-words text-balance">{node.title}</DialogTitle>
      <DialogDescription>{parts.length ? `${parts.length} 个图层` : '尚未拆分'}</DialogDescription>
    </DialogHeader>
    <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-border">
          {!selected && hasComposite ? <CanvasLayerStackComposite node={node} projectId={projectId} resolveVersion={resolveVersion} />
            : image && failedVersion !== image.version_id ? <img key={image.version_id}
              src={canvasMediaUrl(projectId, image.version_id)} alt={selected?.name ?? '原图'}
              onError={() => setFailedVersion(image.version_id)} className="h-full w-full object-contain" />
              : <p role="status" className="p-4 text-sm text-muted-foreground">图片不可用</p>}
        </div>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="break-words text-sm font-medium">{title}</p>
            {width && height ? <p className="text-xs tabular-nums text-muted-foreground">{width} × {height}</p> : null}
            {selected?.layer?.description && <p className="max-h-20 overflow-y-auto break-words text-pretty text-sm text-muted-foreground">{selected.layer.description}</p>}
          </div>
          {image && <Button asChild variant="outline" size="sm">
            <a href={canvasDownloadUrl(projectId, image.version_id)} download><Download aria-hidden="true" />下载原图</a>
          </Button>}
        </div>
      </div>
      {parts.length > 0 && <div className="flex max-h-40 shrink-0 flex-col gap-1 overflow-y-auto md:max-h-none md:w-64" aria-label="详情图层列表">
        <Button variant="ghost" className="shrink-0 justify-start" aria-pressed={!selected}
          onClick={() => setSelectedKey(null)}>合成预览</Button>
        {parts.map(part => <button key={part.key} type="button" aria-label={`查看图层 ${part.name}`}
          aria-pressed={selected?.key === part.key} onClick={() => { setSelectedKey(part.key); setFailedVersion(null); }}
          className={cn('flex shrink-0 items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            selected?.key === part.key && 'bg-secondary')}>
          <img src={canvasMediaUrl(projectId, part.versionId, 128)} alt="" loading="lazy" className="size-12 shrink-0 object-contain" />
          <span className="min-w-0 flex-1 break-words">{part.name}</span>
          {!part.visible && <EyeOff aria-label="画布中已隐藏" className="size-4 shrink-0 text-muted-foreground" />}
        </button>)}
      </div>}
    </div>
  </DialogContent>;
}
