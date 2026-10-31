import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { EditableText } from './editable-text';

it('keeps short and empty names editable without forcing a wide input', () => {
  render(<EditableText value="测试" triggerLabel="重命名" onSave={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '重命名' }));
  const input = screen.getByRole('textbox', { name: '重命名' });
  expect(input).toHaveClass('min-w-8');
  expect(input).not.toHaveClass('min-w-24');
  fireEvent.change(input, { target: { value: '' } });
  expect(input).toHaveValue('');
  expect(input).toHaveFocus();
});
