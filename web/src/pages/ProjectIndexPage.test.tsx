import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProjectIndexPage } from './ProjectIndexPage';

const item = {
  project: {
    id: 'p1',
    slug: 'peach',
    name: '皮克桃·桃芯夏日版本',
    created_at: '2026-08-20T00:00:00Z',
  },
  cover_paths: ['a.png', 'b.png', 'c.png', 'd.png'],
  activity_at: '2026-08-21T08:00:00Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('ProjectIndexPage', () => {
  it('renders the create tile and project cards without counters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [item] }),
    })));

    const onOpen = vi.fn();
    const { container } = render(<ProjectIndexPage onOpenProject={onOpen} />);

    expect(await screen.findByRole('button', { name: '打开项目 皮克桃·桃芯夏日版本' })).toBeVisible();
    expect(screen.getByRole('button', { name: /新建项目/ })).toBeVisible();
    expect(screen.queryByText(/\d+\s*角色|文件夹数/)).not.toBeInTheDocument();
    expect(container.querySelectorAll('img')).toHaveLength(4);

    fireEvent.click(screen.getByRole('button', { name: '打开项目 皮克桃·桃芯夏日版本' }));
    expect(onOpen).toHaveBeenCalledWith('p1');
  });

  it('creates a project and opens its project home', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/projects/index') {
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      }
      if (String(input) === '/api/projects' && init?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: 'p-new', slug: 'new', name: '新游戏', created_at: '' }],
            assignments: {},
          }),
        };
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onOpen = vi.fn();
    render(<ProjectIndexPage onOpenProject={onOpen} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/index'));
    fireEvent.click(screen.getByRole('button', { name: /新建项目/ }));
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '新游戏' } });
    fireEvent.click(screen.getByRole('button', { name: '创建并进入' }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('p-new'));
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: '新游戏' }),
    }));
  });

  it('shows a retry action when the project index fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => JSON.stringify({ detail: '读取失败' }),
    })));

    render(<ProjectIndexPage onOpenProject={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('读取项目目录失败：读取失败');
    expect(screen.getByRole('button', { name: '重试' })).toBeVisible();
  });
});
