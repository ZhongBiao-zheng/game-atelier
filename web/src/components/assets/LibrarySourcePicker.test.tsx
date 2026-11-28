import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { LibrarySourcePicker } from './LibrarySourcePicker';

vi.mock('./useHistoryPages', () => ({
  useHistoryPages: () => ({ items: ['海边', '山顶'].map((title, index) => ({ job_id: 'job', output_index: index,
    kind: 'image', title, filename: 'v1.png', thumbnail_url: '/thumb/' + index })), hasMore: false }),
}));

it('toggles selection and enforces the remaining subject capacity before confirming', () => {
  const choose = vi.fn();
  const close = vi.fn();
  render(<LibrarySourcePicker open initial="history" limit={1} onChoose={choose} onClose={close} />);
  fireEvent.click(screen.getByRole('button', { name: '海边' }));
  fireEvent.click(screen.getByRole('button', { name: '山顶' }));
  expect(screen.getByRole('button', { name: '添加 2 项' })).toBeDisabled();
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '海边' }));
  fireEvent.click(screen.getByRole('button', { name: '添加 1 项' }));
  expect(choose.mock.calls[0][0]).toMatchObject([{ type: 'history', row: { output_index: 1 } }]);
  expect(close).toHaveBeenCalledOnce();
});
