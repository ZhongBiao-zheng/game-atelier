import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CharacterIndex } from './CharacterIndex';

afterEach(() => vi.unstubAllGlobals());

describe('CharacterIndex', () => {
  it('renders character cards, search, and a create tile', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/projects/p1/characters/index') return {
        ok: true,
        json: async () => ({
          items: [
            {
              character: { id: 'zhaoyun', name: '赵云', status: 'idle', latest_job_id: null, derivative: null },
              cover_path: 'characters/zhaoyun/portrait/v1.png',
              activity_at: '2026-08-22T00:00:00Z',
            },
            {
              character: { id: 'guanyu', name: '关羽', status: 'idle', latest_job_id: null, derivative: null },
              cover_path: null,
              activity_at: '2026-08-21T00:00:00Z',
            },
          ],
        }),
      };
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    render(<CharacterIndex projectId="p1" onOpenCharacter={vi.fn()} />);

    expect(await screen.findByRole('button', { name: '新建角色' })).toBeInTheDocument();
    const zhaoyun = screen.getByRole('button', { name: '打开角色 赵云' });
    expect(zhaoyun).toBeInTheDocument();
    expect(zhaoyun.querySelectorAll('img')).toHaveLength(1);
    expect(zhaoyun.querySelector('img')).toHaveAttribute(
      'src',
      `/api/gallery/image?path=${encodeURIComponent('characters/zhaoyun/portrait/v1.png')}`,
    );
    fireEvent.change(screen.getByLabelText('搜索角色'), { target: { value: '关' } });
    expect(screen.queryByRole('button', { name: '打开角色 赵云' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开角色 关羽' })).toBeInTheDocument();
  });

  it('creates a character from the first tile', async () => {
    const open = vi.fn();
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/projects/p1/characters/index') return {
        ok: true, json: async () => ({ items: [] }),
      };
      if (String(url) === '/api/characters' && init?.method === 'POST') return {
        ok: true,
        json: async () => ({ id: 'new-char', name: '新角色', status: 'idle', latest_job_id: null, derivative: null }),
      };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CharacterIndex projectId="p1" onOpenCharacter={open} />);

    fireEvent.click(await screen.findByRole('button', { name: '新建角色' }));
    fireEvent.change(screen.getByLabelText('新角色名称'), { target: { value: '新角色' } });
    fireEvent.keyDown(screen.getByLabelText('新角色名称'), { key: 'Enter' });

    await waitFor(() => expect(open).toHaveBeenCalledWith('new-char', '新角色'));
  });

  it('renames a character from its card menu', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/projects/p1/characters/index') return {
        ok: true,
        json: async () => ({
          items: [{
            character: { id: 'zhaoyun', name: '赵云', status: 'idle', latest_job_id: null, derivative: null },
            cover_path: null,
            activity_at: '2026-08-22T00:00:00Z',
          }],
        }),
      };
      if (String(url) === '/api/characters/zhaoyun/rename' && init?.method === 'POST') return {
        ok: true, json: async () => ({ ok: true }),
      };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CharacterIndex projectId="p1" onOpenCharacter={vi.fn()} />);

    fireEvent.keyDown(await screen.findByRole('button', { name: '管理角色 赵云' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /重命名/ }));
    fireEvent.change(screen.getByLabelText('角色新名称'), { target: { value: '赵云 · 白狼银枪' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/characters/zhaoyun/rename',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: '赵云 · 白狼银枪' }),
      }),
    ));
    expect(await screen.findByText('赵云 · 白狼银枪')).toBeInTheDocument();
  });
});
