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

  it('项目目录只切项目，不在根层级展开角色树', async () => {
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
    expect(screen.queryByLabelText('收起项目')).not.toBeInTheDocument();
  });

  it('项目内稳定显示首页、文件夹和资产库，角色名册只在美术视图出现', async () => {
    const projectFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/characters' && !init) {
        return {
          ok: true,
          json: async () => [
            { id: 'shadow', name: '暗影', status: 'idle', latest_job_id: null },
          ],
        };
      }
      if (url === '/api/projects' && !init) {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 's1', name: '魔幻', created_at: '2026-06-24T00:00:00+00:00' }],
            assignments: { shadow: 'p1' },
          }),
        };
      }
      if (url === '/api/active-character') {
        return { ok: true, json: async () => ({ active_id: null, updated_at: '' }) };
      }
      if (url === '/api/projects/p1/folders' && !init) {
        return {
          ok: true,
          json: async () => ({ folders: [{ id: 'folder-summer', name: '夏日版本', note: '', created_at: '', items: [] }] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', projectFetch);

    const overview = render(
      <LeftSidebar sseSignal={0} activeProjectId="p1" workspace="overview" onSelect={vi.fn()} />,
    );
    const nav = await screen.findByRole('navigation', { name: '魔幻 项目导航' });
    expect(within(nav).getByRole('link', { name: '项目首页' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByText('文件夹')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: '夏日版本' })).toHaveAttribute(
      'href', '/workshop/p1/folders/folder-summer/overview',
    );
    expect(within(nav).getByRole('button', { name: '新建文件夹' })).toBeInTheDocument();
    expect(within(nav).getByText('资产库')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '暗影' })).not.toBeInTheDocument();
    overview.unmount();

    render(<LeftSidebar sseSignal={0} activeProjectId="p1" workspace="art" onSelect={vi.fn()} />);
    expect(await screen.findByText('角色名册')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '暗影' })).toBeInTheDocument();
  });

  it('可在项目册新建文件夹并调整顺序', async () => {
    const project = { id: 'p1', slug: 's1', name: '魔幻', created_at: '' };
    const initial = {
      folders: [
        { id: 'folder-a', name: '版本 A', note: '', created_at: '', items: [] },
        { id: 'folder-b', name: '版本 B', note: '', created_at: '', items: [] },
      ],
    };
    let current = initial;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/characters' && !init) return { ok: true, json: async () => [] };
      if (url === '/api/projects' && !init) {
        return { ok: true, json: async () => ({ projects: [project], assignments: {} }) };
      }
      if (url === '/api/projects/p1/folders' && !init) {
        return { ok: true, json: async () => current };
      }
      if (url === '/api/projects/p1/folders' && init?.method === 'POST') {
        current = { folders: [{ id: 'folder-new', name: '夏日版本', note: '', created_at: '', items: [] }, ...initial.folders] };
        return { ok: true, json: async () => current };
      }
      if (url === '/api/projects/p1/folders/reorder' && init?.method === 'POST') {
        const ids = JSON.parse(String(init.body)).ordered_ids as string[];
        current = {
          folders: ids.map(id => current.folders.find(folder => folder.id === id)!),
        };
        return { ok: true, json: async () => current };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    }));

    render(<LeftSidebar sseSignal={0} activeProjectId="p1" onSelect={vi.fn()} />);
    await screen.findByRole('link', { name: '版本 A' });
    fireEvent.click(screen.getByRole('button', { name: '新建文件夹' }));
    fireEvent.change(screen.getByLabelText('新文件夹名称'), { target: { value: '夏日版本' } });
    fireEvent.keyDown(screen.getByLabelText('新文件夹名称'), { key: 'Enter' });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/p1/folders',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: '夏日版本', note: '' }) }),
    ));

    fireEvent.click(screen.getByRole('button', { name: '上移文件夹 版本 B' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/p1/folders/reorder',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ordered_ids: ['folder-new', 'folder-b', 'folder-a'] }),
      }),
    ));
  });
});
