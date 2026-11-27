import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CanvasGroupRunDialog } from './CanvasGroupRunDialog';

const plan = {
  order: ['a', 'b'], steps: [
    {node_id: 'a', name: '背景', model: '模型 A', estimate_cny: 12.4},
    {node_id: 'b', name: '分镜', model: '模型 B', estimate_cny: null},
  ], total_cny: 12.4, unpriced: 1, cycle: false, blocked: [], needs_confirmation: true,
};

it('shows ordered prices, unpriced nodes and the confirmed amount', () => {
  const start = vi.fn();
  render(<CanvasGroupRunDialog plan={plan} busy={false} onStart={start} onClose={vi.fn()} />);
  expect(screen.getByRole('dialog')).toHaveAccessibleName('整体执行 2 个节点');
  expect(screen.getByText('未计价')).toBeVisible();
  fireEvent.click(screen.getByRole('button', {name: '确认花费 ¥12.40 并执行'}));
  expect(start).toHaveBeenCalledOnce();
});

it('blocks a cyclic plan', () => {
  render(<CanvasGroupRunDialog plan={{...plan, cycle: true}} busy={false} onStart={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent('组里的连线有循环');
  expect(screen.getByRole('button', {name: /并执行/})).toBeDisabled();
});
