import { BaseEdge, EdgeLabelRenderer, EdgeToolbar, getBezierPath, useReactFlow, type EdgeProps } from '@xyflow/react';
import { PenLine, Scissors } from 'lucide-react';

import { Button } from '@/components/ui/button';

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
      {props.data?.annotated === true && <EdgeLabelRenderer>
        <span title="带标注" className="pointer-events-none absolute grid size-6 place-items-center rounded-full border border-primary bg-popover text-primary"
          style={{ transform: `translate(-50%, -50%) translate(${x}px,${y}px)` }}><PenLine size={12} /></span>
      </EdgeLabelRenderer>}
      <EdgeToolbar edgeId={props.id} x={x} y={props.data?.annotated ? y - 24 : y} isVisible={Boolean(props.selected) && props.deletable !== false}>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="nodrag nopan size-8 rounded-full text-muted-foreground hover:text-foreground"
          aria-label="断开连接"
          title="断开连接"
          disabled={props.deletable === false}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            void deleteElements({ edges: [{ id: props.id }] });
          }}
        >
          <Scissors aria-hidden="true" />
        </Button>
      </EdgeToolbar>
    </>
  );
}

export const canvasEdgeTypes = { canvasConnection: CanvasConnectionEdge };
