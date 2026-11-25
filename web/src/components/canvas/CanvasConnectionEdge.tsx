import { BaseEdge, EdgeLabelRenderer, EdgeToolbar, getBezierPath, useReactFlow, type EdgeProps } from '@xyflow/react';
import { CutIcon, PenIcon } from '@/components/ui/icons';

import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/tooltip';
import { animate, MOTION_DURATION, MOTION_EASE, motionAvailable } from '@/lib/motion';

import { CanvasEdgeFlash } from './canvasNodeAttention';

/** 断开前整条线先淡出（150ms），再真正删掉；jsdom 不播，直接删。 */
export function fadeOutCanvasEdge(edgeId: string): Promise<void> {
  const path = typeof document === 'undefined' ? null : document.getElementById(edgeId);
  const edge = path?.closest('.react-flow__edge');
  if (!edge || !motionAvailable()) return Promise.resolve();
  return animate(edge, { opacity: 0 }, { duration: MOTION_DURATION.fast, ease: MOTION_EASE.subtle }).finished.then(() => undefined);
}

function CanvasConnectionEdge(props: EdgeProps) {
  const { deleteElements } = useReactFlow();
  const [path, x, y] = getBezierPath(props);

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={props.data?.annotated ? { ...props.style, stroke: 'var(--primary)' } : props.style}
        markerStart={props.markerStart}
        markerEnd={props.markerEnd}
        interactionWidth={props.interactionWidth}
      />
      <CanvasEdgeFlash edgeId={props.id} path={path} />
      {props.data?.annotated === true && <EdgeLabelRenderer>
        <span role="img" aria-label="带标注" className="pointer-events-none absolute grid size-6 place-items-center rounded-full border border-primary bg-popover text-primary"
          style={{ transform: `translate(-50%, -50%) translate(${x}px,${y}px)` }}><PenIcon size="sm" /></span>
      </EdgeLabelRenderer>}
      <EdgeToolbar edgeId={props.id} x={x} y={props.data?.annotated ? y - 24 : y} isVisible={Boolean(props.selected) && props.deletable !== false}>
        <Hint label="断开连接"><Button
          type="button"
          variant="outline"
          size="icon"
          className="nodrag nopan size-8 rounded-full text-muted-foreground hover:text-foreground"
          aria-label="断开连接"
          disabled={props.deletable === false}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            const remove = () => void deleteElements({ edges: [{ id: props.id }] });
            if (motionAvailable()) void fadeOutCanvasEdge(props.id).then(remove);
            else remove();
          }}
        >
          <CutIcon aria-hidden="true" />
        </Button></Hint>
      </EdgeToolbar>
    </>
  );
}

export const canvasEdgeTypes = { canvasConnection: CanvasConnectionEdge };
