import { fireEvent, render, screen } from '@testing-library/react';
import type { EdgeProps } from '@xyflow/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { canvasEdgeTypes } from './CanvasConnectionEdge';

const { deleteElements } = vi.hoisted(() => ({ deleteElements: vi.fn() }));
vi.mock('@xyflow/react', () => ({
  BaseEdge: () => null,
  EdgeToolbar: ({ isVisible, children }: { isVisible: boolean; children: ReactNode }) => isVisible ? children : null,
  getBezierPath: () => ['M0,0', 0, 0],
  useReactFlow: () => ({ deleteElements }),
}));

it('never offers a disconnect action for a read-only layer binding', () => {
  const Edge = canvasEdgeTypes.canvasConnection;
  render(<Edge {...{ id: 'layer-binding', selected: true, deletable: false } as EdgeProps} />);
  expect(screen.queryByRole('button', { name: '断开连接' })).not.toBeInTheDocument();
});

it('keeps stored material associations independently disconnectable', () => {
  const Edge = canvasEdgeTypes.canvasConnection;
  render(<Edge {...{ id: 'material-link', selected: true, deletable: true } as EdgeProps} />);
  fireEvent.click(screen.getByRole('button', { name: '断开连接' }));
  expect(deleteElements).toHaveBeenCalledWith({ edges: [{ id: 'material-link' }] });
});
