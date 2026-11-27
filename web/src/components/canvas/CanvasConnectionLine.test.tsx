import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Position, ReactFlowProvider, useStoreApi, type ConnectionLineComponentProps } from '@xyflow/react';
import { useLayoutEffect } from 'react';
import { CanvasConnectionLine } from './CanvasConnectionLine';
import type { FlowNode } from './CanvasEditorViews';

it.each([
  ['image', 'source', null, .5], ['text', 'target', null, 1], ['group', 'source', null, 2],
  ['compare', 'target', 'before', 1], ['compare', 'target', 'after', 2],
] as const)('draws the endpoint for %s %s %s at zoom %d', (kind, type, id, zoom) => {
  function Fixture() {
    const store = useStoreApi();
    useLayoutEffect(() => store.setState({ transform: [0, 0, zoom] }), [store]);
    const props = { fromX: 20, fromY: 30, toX: 80, toY: 90, fromPosition: Position.Right, toPosition: Position.Left,
      fromNode: { id: 'node', data: { domain: { type: kind } } }, fromHandle: { id, type },
    } as ConnectionLineComponentProps<FlowNode>;
    return <svg><CanvasConnectionLine {...props} /></svg>;
  }
  const { container } = render(<ReactFlowProvider><Fixture /></ReactFlowProvider>);
  const circle = container.querySelector('circle')!;
  if (id) {
    expect(circle).toHaveAttribute('r', '4');
    expect(container.querySelector('.canvas-handle-add-ghost')).toBeNull();
  } else {
    expect(circle).toHaveAttribute('r', '13');
    expect(circle.parentElement).toHaveClass('canvas-handle-add-ghost');
    expect(circle.parentElement).toHaveAttribute('transform', `translate(80 90) scale(${1 / zoom})`);
  }
});
