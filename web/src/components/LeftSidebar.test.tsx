import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { LeftSidebar } from './LeftSidebar';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/characters' && !init) {
      return {
        ok: true,
        json: async () => [
          { id: 'shadow', name: '暗影', status: 'idle', latest_job_id: null },
          { id: 'blaze', name: '烈拳猴', status: 'idle', latest_job_id: null },
        ],
      };
    }
    if (url === '/api/projects' && !init) {
      return { ok: true, json: async () => ({ projects: [], assignments: {} }) };
    }
    if (url === '/api/active-character') {
      return { ok: true, json: async () => ({ active_id: 'shadow', updated_at: '' }) };
    }
    if (url === '/api/characters/shadow' && init?.method === 'DELETE') {
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LeftSidebar', () => {
  it('deletes a character from the right edge of its row after confirmation', async () => {
    const onDelete = vi.fn();
    render(<LeftSidebar sseSignal={0} selectedId="shadow" onSelect={vi.fn()} onDelete={onDelete} />);

    const name = await screen.findByText('暗影');
    const row = name.closest('li');
    expect(row).not.toBeNull();

    fireEvent.click(within(row!).getByRole('button', { name: '删除角色 暗影' }));

    expect(window.confirm).toHaveBeenCalledWith(
      '删除角色「暗影」？\n角色目录和其中图片会从磁盘删除，不可恢复。',
    );
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/characters/shadow', { method: 'DELETE' });
    });
    expect(screen.queryByText('暗影')).not.toBeInTheDocument();
    expect(screen.getByText('烈拳猴')).toBeInTheDocument();
    expect(onDelete).toHaveBeenCalledWith('shadow');
  });
});
