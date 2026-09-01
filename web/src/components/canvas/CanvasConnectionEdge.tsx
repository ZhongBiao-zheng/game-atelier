import { BaseEdge, EdgeToolbar, getBezierPath, useReactFlow, type EdgeProps } from '@xyflow/react';
import { Scissors } from 'lucide-react';

import { Button } from '@/components/ui/button';

function CanvasConnectionEdge(props: EdgeProps) {
  const { deleteElements } = useReactFlow();
  const [path, x, y] = getBezierPath(props);

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={props.style}
        markerStart={props.markerStart}
        markerEnd={props.markerEnd}
        interactionWidth={props.interactionWidth}
      />
      <EdgeToolbar edgeId={props.id} x={x} y={y} isVisible={Boolean(props.selected)}>
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
