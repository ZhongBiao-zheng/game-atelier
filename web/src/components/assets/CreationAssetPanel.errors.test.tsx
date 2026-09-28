import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreationAsset } from '@/schema/creationAssets';
import { CreationAssetPanel } from './CreationAssetPanel';

// 走真实的 api 层（requestJson → apiError），只在网络出口造响应：钉住服务端 500 的 message 能一路显示到面板。
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/api/connection', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/connection')>()),
  connectionFetch: fetchMock,
}));

vi.mock('./TeamLibraryPanel', () => ({ TeamLibraryPanel: () => null }));

const BROKEN = { detail: { code: 'asset_state_broken', message: '本机资产文件缺失' } };

const adopted: CreationAsset = {
  asset_id: 'asset-stale',
  kind: 'media',
  title: '旧白犬',
  tags: [],
  created_at: '2026-09-20T00:00:00Z',
  updated_at: '2026-09-20T00:00:00Z',
  last_used_at: null,
  project_ids: [],
  content: {
    kind: 'media',
    path: 'creation-assets/blobs/dog.png',
    mime_type: 'image/png',
    bytes: 3,
    sha256: 'b'.repeat(64),
    filename: 'white-dog.png',
  },
  adopted_from: {
    library_id: 'lib_0123456789abcdef',
    asset_id: 'ta_stale',
    source_updated_at: '2026-09-20T00:00:00Z',
    raw_path: null,
  },
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function route(handlers: Record<string, () => Response>) {
  fetchMock.mockImplementation(async (input: string) => {
    const path = input.split('?')[0];
    const handler = handlers[path];
    if (!handler) throw new Error(`unexpected request ${input}`);
    return handler();
  });
}

describe('CreationAssetPanel server errors', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('shows the server message when readopt reports a broken local asset', async () => {
    route({
      '/api/creation-assets': () => json({ revision: 1, assets: [adopted] }, 200),
      '/api/creation-assets/staleness': () => json({ statuses: { 'asset-stale': 'stale' } }, 200),
      '/api/creation-assets/asset-stale/readopt': () => json(BROKEN, 500),
    });
    render(<CreationAssetPanel initialKind="media" onClose={vi.fn()} onUsePrompt={vi.fn()} onUseMedia={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: '重新采用' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '覆盖' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('本机资产文件缺失');
  });

  it('shows the server message when saving a generation asset from a job hits a broken local asset', async () => {
    route({
      '/api/creation-assets': () => json({ revision: 1, assets: [] }, 200),
      '/api/creation-assets/generation/from-job': () => json(BROKEN, 500),
    });
    render(
      <CreationAssetPanel
        saveRequest={{ requestId: 'r1', kind: 'media', title: '雪山白犬', previewUrl: '/api/raw/x.png', source: { kind: 'job_output', job_id: 'job-1', output_index: 0 } }}
        onClose={vi.fn()}
        onUsePrompt={vi.fn()}
        onUseMedia={vi.fn()}
      />,
    );

    await screen.findByDisplayValue('雪山白犬');
    fireEvent.click(screen.getByRole('button', { name: '保存生成资产' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('本机资产文件缺失');
  });

  it('shows the server message when saving a generation asset from a canvas result hits a broken local asset', async () => {
    route({
      '/api/creation-assets': () => json({ revision: 1, assets: [] }, 200),
      '/api/creation-assets/generation/from-canvas': () => json(BROKEN, 500),
    });
    render(
      <CreationAssetPanel
        saveRequest={{ requestId: 'r1', kind: 'media', title: '节点结果', previewUrl: '/api/raw/x.png', source: { kind: 'canvas_result', canvas_project_id: 'canvas-a', node_id: 'n1', version_id: 'v1' } }}
        onClose={vi.fn()}
        onUsePrompt={vi.fn()}
        onUseMedia={vi.fn()}
      />,
    );

    await screen.findByDisplayValue('节点结果');
    fireEvent.click(screen.getByRole('button', { name: '保存生成资产' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('本机资产文件缺失');
  });
});
