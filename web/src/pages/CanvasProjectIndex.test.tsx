import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CanvasProjectIndex } from './CanvasProjectIndex';


afterEach(() => vi.unstubAllGlobals());


describe('CanvasProjectIndex', () => {
  it('renders a create card and opens an existing canvas project', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        projects: [{
          project_id: 'canvas-one',
          name: '列车短片',
          created_at: '2026-08-23T00:00:00Z',
          updated_at: '2026-08-23T01:00:00Z',
          cover: { path: 'canvases/canvas-one/uploads/cover.png', job_id: null },
        }],
      }),
    })));
    const onOpen = vi.fn();
    render(<CanvasProjectIndex onOpenProject={onOpen} />);

    expect(await screen.findByRole('button', { name: '打开画布项目 列车短片' })).toBeVisible();
    expect(screen.getByRole('button', { name: /新建项目/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '打开画布项目 列车短片' }));
    expect(onOpen).toHaveBeenCalledWith('canvas-one');
  });

  it('creates a user-owned canvas project and enters it', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/canvas/projects' && !init) {
        return { ok: true, status: 200, json: async () => ({ projects: [] }) };
      }
      if (String(input) === '/api/canvas/projects' && init?.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            project_id: 'canvas-new',
            name: '未命名项目',
            created_at: '',
            updated_at: '',
          }),
        };
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onOpen = vi.fn();
    render(<CanvasProjectIndex onOpenProject={onOpen} />);

    fireEvent.click(await screen.findByRole('button', { name: '新建一个画布项目' }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('canvas-new'));
    expect(fetchMock).toHaveBeenCalledWith('/api/canvas/projects', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: '未命名项目' }),
    }));
  });

  it('toggles hiding a canvas project from the home gallery', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/canvas/projects') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{
              project_id: 'canvas-hide-me',
              name: '内部草图',
              created_at: '2026-08-23T00:00:00Z',
              updated_at: '2026-08-23T01:00:00Z',
              node_count: 2,
              connection_count: 1,
            }],
          }),
        };
      }
      if (url === '/api/gallery/hidden' && !init) {
        return { ok: true, status: 200, json: async () => ({ paths: [], canvas_project_ids: [] }) };
      }
      if (url === '/api/gallery/hidden' && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ paths: [], canvas_project_ids: ['canvas-hide-me'] }) };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CanvasProjectIndex onOpenProject={vi.fn()} />);

    const more = await screen.findByRole('button', { name: '管理画布项目 内部草图' });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.keyDown(more, { key: 'Enter' });
    const hideItem = await screen.findByRole('menuitem', { name: /在首页隐藏作品/ });
    fireEvent.click(hideItem);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/gallery/hidden',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ canvas_project_id: 'canvas-hide-me', hidden: true }),
      }),
    ));
    expect(await screen.findByText('首页隐藏')).toBeVisible();
  });
});
