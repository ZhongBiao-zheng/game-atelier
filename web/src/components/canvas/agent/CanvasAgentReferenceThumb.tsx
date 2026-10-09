import { useState } from 'react';
import { X } from 'lucide-react';
import { canvasMediaUrl } from '@/api/canvas';
import {
  CanvasMaterialHoverDetail, type CanvasMaterialHoverState,
} from '@/components/canvas/CanvasMaterialHoverDetail';

/** 缩略图格子 40px，取 2 倍给高分屏；悬停大图与节点里的素材详情同款（w-64）。 */
const THUMB_WIDTH = 80;
const DETAIL_WIDTH = 512;
const DETAIL_HALF = 128;
const EDGE = 8;

/** 对话里的参考图：小方块缩略图，悬停放大，与生成节点里「已对接素材」一致。 */
export function CanvasAgentReferenceThumb({ projectId, nodeId, versionId, title, onRemove }: {
  projectId: string;
  nodeId: string;
  versionId: string;
  title: string;
  onRemove?: () => void;
}) {
  const [detail, setDetail] = useState<CanvasMaterialHoverState | null>(null);
  const show = (target: HTMLElement) => {
    const bounds = target.getBoundingClientRect();
    setDetail({
      reference: {
        nodeId, versionId, kind: 'image', title,
        previewUrl: canvasMediaUrl(projectId, versionId, DETAIL_WIDTH),
      },
      // 大图以 left 为中心（w-64 = 256px）；面板贴着窗口右边，夹住免得被裁。
      left: Math.min(Math.max(bounds.left + bounds.width / 2, DETAIL_HALF + EDGE),
        window.innerWidth - DETAIL_HALF - EDGE),
      top: bounds.top - 8,
    });
  };
  return (
    <span className="relative size-10 shrink-0">
      <span
        tabIndex={0}
        aria-label={`参考图 ${title}`}
        className="block size-10 overflow-hidden rounded-md border border-border bg-secondary/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onMouseEnter={event => show(event.currentTarget)}
        onMouseLeave={() => setDetail(null)}
        onFocus={event => show(event.currentTarget)}
        onBlur={() => setDetail(null)}
      >
        <img src={canvasMediaUrl(projectId, versionId, THUMB_WIDTH)} alt="" loading="lazy" className="size-full object-cover" />
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label={`不带入 ${title}`}
          onClick={onRemove}
          className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full border border-border bg-background text-muted-foreground hover:text-destructive"
        ><X className="size-2.5" /></button>
      )}
      {detail && <CanvasMaterialHoverDetail {...detail} />}
    </span>
  );
}
