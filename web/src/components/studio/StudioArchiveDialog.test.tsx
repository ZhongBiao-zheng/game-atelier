import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StudioArchiveDialog } from './StudioArchiveDialog';

const projects = {
  projects: [{ id: 'p1', slug: 'sanguo', name: '三国', created_at: '2026-08-21T00:00:00Z' }],
  assignments: {},
};

const imageTargets = {
  targets: [
    {
      kind: 'character',
      label: '曹操 · 立绘',
      detail: '角色资产',
      character_id: 'cao-cao',
      asset_slot: 'portrait',
    },
    {
      kind: 'ui',
      label: 'V1 · 主界面',
      detail: 'UI 页面 · home',
      ui_scheme_id: 'v1',
      screen_id: 'home',
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('StudioArchiveDialog', () => {
  it('逐级选择项目与 UI 页面，并提交不含展示字段的明确目标', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects') {
        return { ok: true, status: 200, json: async () => projects };
      }
      if (url === '/api/projects/p1/studio-archive-targets?media_kind=image') {
        return { ok: true, status: 200, json: async () => imageTargets };
      }
      if (url === '/api/studio/jobs/studio-1/archive' && init?.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({ job: {}, path: '/data/projects/sanguo/ui/v1/screens/home/v1.png' }),
        };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();

    render(
      <StudioArchiveDialog
        request={{
          jobId: 'studio-1',
          path: '/data/studio/studio-1/v1.png',
          mediaKind: 'image',
        }}
        onClose={onClose}
      />,
    );

    await screen.findByRole('option', { name: '三国' });
    expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'p1' } });
    expect(await screen.findByRole('option', { name: '曹操 · 立绘' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('资产类型'), { target: { value: 'ui' } });
    expect(screen.getByRole('option', { name: 'V1 · 主界面' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('归档位置'), { target: { value: 'ui:v1:home' } });
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/studio/jobs/studio-1/archive',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            source_path: '/data/studio/studio-1/v1.png',
            project_id: 'p1',
            target: { kind: 'ui', ui_scheme_id: 'v1', screen_id: 'home' },
          }),
        }),
      );
    });
    expect(await screen.findByText('已归档到项目资产')).toBeInTheDocument();
    expect(screen.getByText('/data/projects/sanguo/ui/v1/screens/home/v1.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('归档失败时保留选择并展示服务端原因', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/projects') {
        return { ok: true, status: 200, json: async () => projects };
      }
      if (url.includes('/studio-archive-targets')) {
        return { ok: true, status: 200, json: async () => imageTargets };
      }
      if (url === '/api/studio/jobs/studio-1/archive' && init?.method === 'POST') {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => JSON.stringify({ detail: '目标与产物类型不匹配' }),
        };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <StudioArchiveDialog
        request={{
          jobId: 'studio-1',
          path: '/data/studio/studio-1/v1.png',
          mediaKind: 'image',
        }}
        onClose={vi.fn()}
      />,
    );

    await screen.findByRole('option', { name: '三国' });
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'p1' } });
    await screen.findByRole('option', { name: '曹操 · 立绘' });
    fireEvent.change(screen.getByLabelText('归档位置'), {
      target: { value: 'character:cao-cao:portrait' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('目标与产物类型不匹配');
    expect(screen.getByRole('button', { name: '确认归档' })).toBeEnabled();
    expect(screen.getByLabelText('归档位置')).toHaveValue('character:cao-cao:portrait');
  });
});
