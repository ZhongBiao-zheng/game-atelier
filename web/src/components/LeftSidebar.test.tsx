import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { LeftSidebar } from './LeftSidebar';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/characters' && !init) {
      return {
        ok: true,
        json: async () => [
          { id: 'shadow', name: '暗影', status: 'idle', latest_job_id: null, thumbnail: 'characters/shadow/portrait/v2.png' },
          { id: 'blaze', name: '烈拳猴', status: 'idle', latest_job_id: null, thumbnail: null },
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

    // 对话框出现
    expect(await screen.findByText('删除角色「暗影」？')).toBeInTheDocument();

    // 点击确认
    fireEvent.click(screen.getByText('确认'));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/characters/shadow', { method: 'DELETE' });
    });
    expect(screen.queryByText('暗影')).not.toBeInTheDocument();
    expect(screen.getByText('烈拳猴')).toBeInTheDocument();
    expect(onDelete).toHaveBeenCalledWith('shadow');
  });

  it('renders roster thumbnails with serif-initial fallback', async () => {
    render(<LeftSidebar sseSignal={0} selectedId="shadow" onSelect={vi.fn()} />);

    const shadowRow = (await screen.findByText('暗影')).closest('li')!;
    const img = shadowRow.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(
      `/api/gallery/image?path=${encodeURIComponent('characters/shadow/portrait/v2.png')}`,
    );

    // 无立绘 → serif 首字母占位块
    const blazeRow = screen.getByText('烈拳猴').closest('li')!;
    expect(blazeRow.querySelector('img')).toBeNull();
    expect(blazeRow.textContent).toContain('烈');
  });

  it('单击项目名触发 onOpenProject、不折叠；点 chevron 仍折叠', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/characters' && !init) {
        return { ok: true, json: async () => [] };
      }
      if (url === '/api/projects' && !init) {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 's1', name: '魔幻', created_at: '2026-06-24T00:00:00+00:00' }],
            assignments: {},
          }),
        };
      }
      if (url === '/api/active-character') {
        return { ok: true, json: async () => ({ active_id: null, updated_at: '' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    const onOpenProject = vi.fn();
    render(<LeftSidebar sseSignal={0} onSelect={vi.fn()} onOpenProject={onOpenProject} />);
    const nameEl = await screen.findByText('魔幻');
    fireEvent.click(nameEl);
    expect(onOpenProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));

    // chevron（aria-label 收起项目）仍管折叠，不触发打开
    onOpenProject.mockClear();
    fireEvent.click(screen.getByLabelText('收起项目'));
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it('项目折叠状态持久化：重挂载后仍折叠，展开后清除', async () => {
    const projectFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/characters' && !init) {
        return { ok: true, json: async () => [] };
      }
      if (url === '/api/projects' && !init) {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 's1', name: '魔幻', created_at: '2026-06-24T00:00:00+00:00' }],
            assignments: {},
          }),
        };
      }
      if (url === '/api/active-character') {
        return { ok: true, json: async () => ({ active_id: null, updated_at: '' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', projectFetch);

    const first = render(<LeftSidebar sseSignal={0} onSelect={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText('收起项目'));
    expect(JSON.parse(localStorage.getItem('workshop:collapsed-projects')!)).toEqual(['p1']);
    first.unmount();

    // 重挂载（= 切页面再回来）：恢复折叠态
    const second = render(<LeftSidebar sseSignal={0} onSelect={vi.fn()} />);
    const expand = await screen.findByLabelText('展开项目');
    fireEvent.click(expand);
    expect(JSON.parse(localStorage.getItem('workshop:collapsed-projects')!)).toEqual([]);
    second.unmount();

    // 再重挂载：回到展开
    render(<LeftSidebar sseSignal={0} onSelect={vi.fn()} />);
    expect(await screen.findByLabelText('收起项目')).toBeInTheDocument();
  });
});
