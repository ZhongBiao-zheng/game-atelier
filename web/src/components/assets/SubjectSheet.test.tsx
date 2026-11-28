import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { requestJson } from '@/api/http';
import { SubjectSheet } from './SubjectSheet';
import { subjectChip } from './SubjectMentions';
import { subjectToken } from '@/api/library';

vi.mock('@/api/http', async original => ({ ...await original<typeof import('@/api/http')>(), requestJson: vi.fn() }));

const subject = { id: 'sbj_' + 'a'.repeat(32), name: '阿橙', revision: 2, handle: 'a-cheng', description: '',
  item_ids: ['first', 'second'], cover_item_id: 'first' };

it('stages reference removal until save and reassigns the cover', async () => {
  vi.mocked(requestJson).mockResolvedValue(subject);
  const items = Object.fromEntries(subject.item_ids.map(id => [id, { id, title: id, kind: 'image' as const, revision: 1, file: 'v1.png', created_at: '' }]));
  render(<SubjectSheet open subject={subject} items={items} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '移除 first' }));
  expect(screen.getByText('1/20')).toBeVisible();
  expect(screen.getByRole('button', { name: '设为封面 1' })).toHaveAttribute('aria-pressed', 'true');
  expect(requestJson).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(requestJson).toHaveBeenCalled());
  const body = vi.mocked(requestJson).mock.calls[0][2]?.body as FormData;
  expect(JSON.parse(String(body.get('payload')))).toMatchObject({ removed: ['first'], cover_index: 0, revision: 2, additions: [] });
});

it('preserves the saved label of a missing subject in either editor', () => {
  for (const editor of ['studio', 'canvas'] as const) {
    const token = subjectToken(subject);
    const chip = subjectChip(token, [], editor);
    expect(chip).toHaveTextContent('@阿橙');
    expect(chip).toHaveClass('line-through');
    expect(subjectChip(token, [subject], editor)).not.toHaveClass('line-through');
  }
});
