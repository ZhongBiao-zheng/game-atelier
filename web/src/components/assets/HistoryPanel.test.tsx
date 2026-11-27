import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { deleteHistoryJob, downloadHistory, listHistory, type HistoryItem, type HistoryReference } from '@/api/history';
import { HistoryPanel, dayLabel } from './HistoryPanel';
import { readTeamMedia } from './teamAssetUse';

vi.mock('@/api/history', async original => ({
  ...await original<typeof import('@/api/history')>(), listHistory: vi.fn(), downloadHistory: vi.fn(), deleteHistoryJob: vi.fn(),
}));
vi.mock('@/lib/uiPrefs', () => ({ loadUiPrefs: async () => ({}), saveUiPref: vi.fn() }));
vi.mock('./teamAssetUse', () => ({ readTeamMedia: vi.fn() }));
const row = (id: string): HistoryItem => ({
  job_id: id, output_index: 0, kind: 'image', filename: id + '.png', prompt: id, url: '/' + id,
  width: 120, height: 90, duration: null, text_preview: null, thumbnail_url: '/thumb/' + id,
  submitted_at: '2026-11-26T10:00:00',
});
const rows = ['a', 'b', 'c'].map(row);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listHistory).mockImplementation(async (_kind, q, cursor) => q ? { items: [], next_cursor: null }
    : cursor ? { items: [row('d')], next_cursor: null } : { items: rows, next_cursor: 'page-2' });
});

it('groups by local calendar dates across a year boundary', () => {
  const now = new Date(2026, 0, 1, 10);
  expect(dayLabel('2026-01-01T00:01:00', now)).toBe('今天');
  expect(dayLabel('2025-12-31T23:50:00', now)).toBe('昨天');
  expect(dayLabel('2025-12-30T09:00:00', now)).toBe('2025年12月30日');
});

it('selects a range in output order, downloads it, and selects later pages only from list focus', async () => {
  render(<HistoryPanel onReference={vi.fn()} />);
  fireEvent.click(await screen.findByRole('checkbox', { name: '选择 a.png' }));
  fireEvent.click(screen.getByRole('button', { name: 'c' }), { shiftKey: true });
  fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: '下载' }));
  await waitFor(() => expect(downloadHistory).toHaveBeenCalledWith(rows));
  const list = screen.getByRole('region', { name: '生成历史' });
  fireEvent.keyDown(document.body, { key: 'a', ctrlKey: true });
  expect(listHistory).toHaveBeenCalledTimes(1);
  list.focus();
  fireEvent.keyDown(list, { key: 'a', metaKey: true });
  await waitFor(() => expect(screen.getByRole('toolbar')).toHaveTextContent('已选 4 项'));
  fireEvent.keyDown(list, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull());
});

it('clears selection on search and routes the selected files in history order', async () => {
  const files: File[] = [];
  const onReference = vi.fn(async (items: HistoryReference[]) => {
    for (const item of items) files.push(await item.read());
  });
  vi.mocked(readTeamMedia).mockImplementation(async (_url, entry) => new File(['img'], entry.title));
  render(<HistoryPanel onReference={onReference} />);
  fireEvent.click(await screen.findByRole('checkbox', { name: '选择 a.png' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '选择 b.png' }));
  fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: '用作参考' }));
  await waitFor(() => expect(onReference).toHaveBeenCalledOnce());
  await waitFor(() => expect(files.map(file => file.name)).toEqual(['a.png', 'b.png']));
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  fireEvent.change(screen.getByRole('textbox', { name: '按提示词搜索' }), { target: { value: '海边' } });
  expect(await screen.findByText('还没有生成记录')).toBeVisible();
});

it('removes the whole selected job once after confirmation', async () => {
  vi.mocked(listHistory).mockResolvedValue({ items: [rows[0], { ...rows[0], output_index: 1 }, rows[1]], next_cursor: null });
  render(<HistoryPanel onReference={vi.fn()} />);
  const checks = await screen.findAllByRole('checkbox', { name: '选择 a.png' });
  checks.forEach(check => fireEvent.click(check));
  fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: '删除' }));
  expect(deleteHistoryJob).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '删除' }));
  await waitFor(() => expect(screen.queryAllByRole('checkbox', { name: '选择 a.png' })).toHaveLength(0));
  expect(deleteHistoryJob).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('checkbox', { name: '选择 b.png' })).toBeInTheDocument();
});
