import { createPortal } from 'react-dom';
import { FileAudio, FileImage, FileVideo } from 'lucide-react';

import { mentionKindLabel, type CanvasMaterialReference } from '@/lib/canvasMentions';

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
  return createPortal(
    <figure
      id={`canvas-material-detail-${reference.nodeId}`}
      role="tooltip"
      aria-label={`素材详情 ${reference.title}`}
      data-canvas-material-hover={reference.nodeId}
      className="pointer-events-none fixed z-50 w-64 overflow-hidden rounded-lg border border-border bg-card shell-glow"
      style={{ left, top, transform: 'translate(-50%, -100%)' }}
    >
      {reference.kind === 'image' && reference.previewUrl ? (
        <img
          src={reference.previewUrl}
          alt={reference.title}
          className="h-40 w-full bg-background object-contain"
        />
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
            ? <FileAudio className="size-8" aria-hidden="true" />
            : reference.kind === 'video'
              ? <FileVideo className="size-8" aria-hidden="true" />
              : <FileImage className="size-8" aria-hidden="true" />}
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
