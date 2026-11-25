import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AudioFileIcon, ImageFileIcon, VideoFileIcon } from '@/components/ui/icons';

import { RevealImage } from '@/components/ui/reveal-image';
import { mentionKindLabel, type CanvasMaterialReference } from '@/lib/canvasMentions';
import { animate, clearOnFinish, MOTION_DURATION, MOTION_EASE, motionAvailable } from '@/lib/motion';

export interface CanvasMaterialHoverState {
  reference: CanvasMaterialReference;
  left: number;
  top: number;
}

export function CanvasMaterialHoverDetail({
  reference,
  left,
  top,
}: CanvasMaterialHoverState) {
  // 出现时 150ms 淡入（只动透明度，定位用的 transform 不碰）；在相邻素材间移动时同一张卡原地换内容，不重播。
  const figureRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = figureRef.current;
    if (!element || !motionAvailable()) return;
    clearOnFinish(
      animate(element, { opacity: [0, 1] }, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }),
      element,
      ['opacity'],
    );
  }, []);
  return createPortal(
    <figure
      ref={figureRef}
      id={`canvas-material-detail-${reference.nodeId}`}
      role="tooltip"
      aria-label={`素材详情 ${reference.title}`}
      data-canvas-material-hover={reference.nodeId}
      className="pointer-events-none fixed z-50 w-64 overflow-hidden rounded-lg border border-border bg-card shell-glow"
      style={{ left, top, transform: 'translate(-50%, -100%)' }}
    >
      {reference.kind === 'image' && reference.previewUrl ? (
        // 底色先占位，解码完再淡入：大图不再先空一下再整张弹出。
        <div className="h-40 w-full bg-background">
          <RevealImage
            src={reference.previewUrl}
            alt={reference.title}
            className="size-full object-contain"
          />
        </div>
      ) : reference.kind === 'video' && reference.previewUrl ? (
        <video
          src={reference.previewUrl}
          aria-label={reference.title}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          className="h-40 w-full bg-black object-contain"
        />
      ) : reference.kind === 'text' ? (
        <div className="flex h-40 items-center px-4 text-sm leading-relaxed text-foreground">
          <p className="line-clamp-5">{reference.text || '空文本素材'}</p>
        </div>
      ) : (
        <div className="grid h-40 place-items-center bg-secondary/30 text-muted-foreground">
          {reference.kind === 'audio'
            ? <AudioFileIcon size="xl" aria-hidden="true" />
            : reference.kind === 'video'
              ? <VideoFileIcon size="xl" aria-hidden="true" />
              : <ImageFileIcon size="xl" aria-hidden="true" />}
        </div>
      )}
      <figcaption className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{reference.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{mentionKindLabel(reference.kind)}</span>
      </figcaption>
    </figure>,
    document.body,
  );
}
