import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { LeftSidebar } from './LeftSidebar';

beforeEach(() => {
  window.localStorage.clear();
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
      return {
        ok: true,
        json: async () => ({
          projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '' }],
          assignments: { shadow: 'p1', blaze: 'p1' },
        }),
      };
    }
    if (url === '/api/active-character') {
      return { ok: true, json: async () => ({ active_id: 'shadow', updated_at: '' }) };
    }
    if (url === '/api/projects/p1/ui-schemes?visible_only=true') {
      return {
        ok: true,
        json: async () => ({
          default_scheme_id: 'v1',
          schemes: [{ id: 'v1', name: 'V1', created_at: '' }],
        }),
      };
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
  it('一百个角色时只显示五个最近角色，UI 和视频入口保持可见', async () => {
    const characters = Array.from({ length: 100 }, (_, index) => ({
      id: `char-${index}`,
      name: `角色 ${index}`,
      status: 'idle',
      latest_job_id: null,
      derivative: null,
    }));
    window.localStorage.setItem(
      'workshop:recent-characters:p1',
      JSON.stringify(characters.slice(0, 20).map(character => character.id)),
    );
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/characters') return { ok: true, json: async () => characters };
      if (url === '/api/projects') return {
        ok: true,
        json: async () => ({
          projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '' }],
          assignments: Object.fromEntries(characters.map(character => [character.id, 'p1'])),
        }),
      };
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    render(<LeftSidebar sseSignal={0} activeProjectId="p1" workspace="art" onSelect={vi.fn()} />);

    const nav = await screen.findByRole('navigation', { name: '项目一 项目导航' });
    expect(within(nav).getAllByRole('button', { name: /^角色 \d+$/ })).toHaveLength(5);
    expect(within(nav).getByRole('link', { name: 'UI' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: '视频' })).toBeInTheDocument();
  });

  it('角色整行点击切换展开状态，不再显示独立展开按钮', async () => {
    render(<LeftSidebar sseSignal={0} activeProjectId="p1" workspace="overview" onSelect={vi.fn()} />);

    const roleToggle = await screen.findByRole('link', { name: '角色' });
    expect(roleToggle).toHaveAttribute('href', '/workshop/p1/art');
    expect(roleToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '展开角色' })).not.toBeInTheDocument();

    fireEvent.click(roleToggle);
    expect(roleToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('搜索侧栏角色')).toBeInTheDocument();

    fireEvent.click(roleToggle);
    expect(roleToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('搜索侧栏角色')).not.toBeInTheDocument();
  });

  it('UI 整行点击展开各版本方案，再次点击收起', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/characters') return { ok: true, json: async () => [] };
      if (url === '/api/projects') return {
        ok: true,
        json: async () => ({
          projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '' }],
          assignments: {},
        }),
      };
      if (url === '/api/projects/p1/ui-schemes?visible_only=true') return {
        ok: true,
        json: async () => ({
          default_scheme_id: 'v1',
          schemes: [
            { id: 'v1', name: 'V1', created_at: '' },
            { id: 'v2', name: '寒锋 V2', created_at: '' },
          ],
        }),
      };
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    render(<LeftSidebar sseSignal={0} activeProjectId="p1" workspace="overview" onSelect={vi.fn()} />);

    const uiToggle = await screen.findByRole('link', { name: 'UI' });
    await waitFor(() => expect(uiToggle).toHaveAttribute('href', '/workshop/p1/ui/v1'));
    expect(uiToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(uiToggle);
    expect(uiToggle).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('link', { name: /V1.*默认/ })).toHaveAttribute(
      'href', '/workshop/p1/ui/v1',
    );
    expect(screen.getByRole('link', { name: '寒锋 V2' })).toHaveAttribute(
      'href', '/workshop/p1/ui/v2',
    );

    fireEvent.click(uiToggle);
    expect(screen.queryByRole('link', { name: '寒锋 V2' })).not.toBeInTheDocument();
  });

  it('没有实际 UI 内容时不展示 V1 子方案', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/characters') return { ok: true, json: async () => [] };
      if (url === '/api/projects') return {
        ok: true,
        json: async () => ({
          projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '' }],
          assignments: {},
        }),
      };
      if (url === '/api/projects/p1/ui-schemes?visible_only=true') return {
        ok: true,
        json: async () => ({ default_scheme_id: 'v1', schemes: [] }),
      };
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    render(<LeftSidebar sseSignal={0} activeProjectId="p1" workspace="overview" onSelect={vi.fn()} />);

    const uiToggle = await screen.findByRole('link', { name: 'UI' });
    await waitFor(() => expect(uiToggle).toHaveAttribute('href', '/workshop/p1/ui'));
    fireEvent.click(uiToggle);

    expect(uiToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('暂无 UI 方案')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /V1/ })).not.toBeInTheDocument();
  });

  it('deletes a character from the right edge of its row after confirmation', async () => {
    const onDelete = vi.fn();
    render(<LeftSidebar sseSignal={0} selectedId="shadow" activeProjectId="p1" workspace="art" onSelect={vi.fn()} onDelete={onDelete} />);

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
    expect(screen.queryByText('烈拳猴')).not.toBeInTheDocument();
    expect(onDelete).toHaveBeenCalledWith('shadow');
  });

  it('renders roster thumbnails with serif-initial fallback', async () => {
    render(<LeftSidebar sseSignal={0} selectedId="shadow" activeProjectId="p1" workspace="art" onSelect={vi.fn()} />);

    const shadowRow = (await screen.findByText('暗影')).closest('li')!;
    const img = shadowRow.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(
      `/api/gallery/image?path=${encodeURIComponent('characters/shadow/portrait/v2.png')}`,
    );

    // 无立绘 → serif 首字母占位块
    fireEvent.change(screen.getByLabelText('搜索侧栏角色'), { target: { value: '烈拳猴' } });
    const blazeRow = screen.getByText('烈拳猴').closest('li')!;
    expect(blazeRow.querySelector('img')).toBeNull();
    expect(blazeRow.textContent).toContain('烈');
    expect(screen.queryByText('名册 · Roster')).not.toBeInTheDocument();
    expect(screen.queryByText('2 角色 · 1 项目')).not.toBeInTheDocument();
    expect(screen.queryByText('未归档角色')).not.toBeInTheDocument();
  });

  it('在当前项目内一次创建并归属角色', async () => {
    const created = {
      id: 'char-summer', name: '夏日角色', status: 'idle', latest_job_id: null, derivative: null,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/characters' && !init) return { ok: true, json: async () => [] };
      if (url === '/api/projects' && !init) {
        return {
          ok: true,
          json: async () => ({
            projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '' }],
            assignments: {},
          }),
        };
      }
      if (url === '/api/characters' && init?.method === 'POST') {
        return { ok: true, json: async () => created };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSelect = vi.fn();
    render(
      <LeftSidebar
        sseSignal={0}
        activeProjectId="p1"
        workspace="art"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '新建角色' }));
    fireEvent.change(screen.getByLabelText('新角色名称'), { target: { value: '夏日角色' } });
    fireEvent.keyDown(screen.getByLabelText('新角色名称'), { key: 'Enter' });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/characters',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: '夏日角色', project_id: 'p1' }),
      }),
    ));
    fireEvent.change(screen.getByLabelText('搜索侧栏角色'), { target: { value: '夏日角色' } });
    expect(await screen.findByRole('button', { name: '夏日角色' })).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith('char-summer', '夏日角色', 'p1');
  });

  it('项目内通过顶部切换器切项目，不展开其他项目的角色树', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/characters' && !init) {
        return { ok: true, json: async () => [] };
      }
      if (url === '/api/projects' && !init) {
        return {
          ok: true,
          json: async () => ({
            projects: [
              { id: 'p1', slug: 's1', name: '魔幻', created_at: '2026-06-24T00:00:00+00:00' },
              { id: 'p2', slug: 's2', name: '科幻', created_at: '2026-06-25T00:00:00+00:00' },
            ],
            assignments: {},
          }),
        };
      }
      if (url === '/api/active-character') {
        return { ok: true, json: async () => ({ active_id: null, updated_at: '' }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    render(
      <LeftSidebar
        sseSignal={0}
        activeProjectId="p1"
        onSelect={vi.fn()}
      />,
    );
    fireEvent.keyDown(
      await screen.findByRole('button', { name: '切换项目，当前为 魔幻' }),
      { key: 'Enter' },
    );
    expect(await screen.findByRole('menuitem', { name: /科幻/ })).toHaveAttribute(
      'href',
      '/workshop/p2/overview',
    );
    expect(screen.queryByRole('button', { name: '暗影' })).not.toBeInTheDocument();
  });

  it('项目内稳定显示首页和资产库，角色列表只在角色视图出现', async () => {
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
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', projectFetch);

    const overview = render(
      <LeftSidebar sseSignal={0} activeProjectId="p1" workspace="overview" onSelect={vi.fn()} />,
    );
    const nav = await screen.findByRole('navigation', { name: '魔幻 项目导航' });
    expect(within(nav).getByRole('link', { name: '项目首页' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByText('文件夹')).not.toBeInTheDocument();
    expect(within(nav).queryByRole('button', { name: '新建文件夹' })).not.toBeInTheDocument();
    expect(within(nav).getByText('资产库')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '暗影' })).not.toBeInTheDocument();
    overview.unmount();

    render(<LeftSidebar sseSignal={0} activeProjectId="p1" workspace="art" onSelect={vi.fn()} />);
    expect(await screen.findByRole('button', { name: '新建角色' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索侧栏角色'), { target: { value: '暗影' } });
    expect(screen.getByRole('button', { name: '暗影' })).toBeInTheDocument();
  });

  it('从角色创建平级衍生后进入同项目角色路径', async () => {
    const project = { id: 'p1', slug: 's1', name: '魔幻', created_at: '' };
    const parent = {
      id: 'shadow', name: '暗影', status: 'idle', latest_job_id: null, derivative: null,
    };
    const created = {
      id: 'char-derivative', name: '暗影·夏日', status: 'idle', latest_job_id: null,
      derivative: {
        source_character_id: 'shadow', source_character_name: '暗影', source_paths: [],
        created_at: '2026-08-20T00:00:00Z',
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/characters' && !init) {
        return { ok: true, json: async () => [parent] };
      }
      if (url === '/api/projects' && !init) {
        return {
          ok: true,
          json: async () => ({ projects: [project], assignments: { shadow: 'p1' } }),
        };
      }
      if (url === '/api/projects/p1/gallery?category=all&limit=40' && !init) {
        return { ok: true, json: async () => ({ items: [], next_cursor: null }) };
      }
      if (url === '/api/characters/shadow/derivatives' && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => created };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    }));
    const onSelect = vi.fn();
    render(
      <LeftSidebar
        sseSignal={0}
        activeProjectId="p1"
        workspace="art"
        selectedId="shadow"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '为 暗影 创建衍生' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('衍生名称'), {
      target: { value: '暗影·夏日' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建衍生' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/characters/shadow/derivatives',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: '暗影·夏日', source_paths: [] }),
      }),
    ));
    expect(onSelect).toHaveBeenCalledWith('char-derivative', '暗影·夏日', 'p1');
    fireEvent.change(screen.getByLabelText('搜索侧栏角色'), { target: { value: '暗影·夏日' } });
    expect(await screen.findByRole('button', { name: '暗影·夏日' })).toBeInTheDocument();
  });
});
