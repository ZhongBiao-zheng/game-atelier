import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkshopRequest } from '@/api/workshopRequests';
import { WorkshopRequestsPage } from './WorkshopRequests';
import { workshopTargetUrl } from '@/api/workshopRequests';

const prepared: WorkshopRequest = {
  request_id: 'r1', revision: 3, state: 'awaiting_approval', target: { type: 'character', project_id: 'p1', character_id: 'bird', asset_slot: 'portrait' }, target_name: '角色立绘',
  alias: 'test-provider', provider: 'fake', model: 'test-model', prompt: '一只站在树枝上的鸟', params: { n: 1 },
  references: [{ media_id: 'm1', title: '角色草图', kind: 'image', sha256: 'hash' }], estimated_cost_cny: null, price_basis: '供应商价格未核实',
  created_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', job_id: null, job: null, execution_state: 'not_dispatched', approval_url: '/workshop/requests?request_id=r1',
};
function server(request = prepared) {
  const network = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return new Response(JSON.stringify({ ...request, state: 'approved', job_id: 'j1', job: { status: 'pending', error: null, output_count: 0 } }));
    return new Response(JSON.stringify({ requests: [request], page: 1, page_size: 20, total: 1 }));
  });
  vi.stubGlobal('fetch', network); return network;
}
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

describe('workshop human approval', () => {
  it('shows frozen prompt, references, provider and unknown price without auto-approving', async () => {
    const network = server(); render(<WorkshopRequestsPage />);
    await screen.findByText(prepared.prompt);
    expect(screen.getByText('费用待确认')).toBeInTheDocument(); expect(screen.getByText(/将发送给 fake 的参考素材：角色草图/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '角色草图' })).toHaveAttribute('src', '/api/workshop/requests/r1/references/m1');
    expect(network.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '批准本次生成' }));
    await screen.findByText('已批准');
    const call = network.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(call?.[0]).toBe('/api/workshop/requests/r1/approve'); expect(JSON.parse(String(call?.[1]?.body))).toEqual({ expected_revision: 3 });
    expect(screen.queryByRole('button', { name: '批准本次生成' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '在工坊查看' })).toHaveAttribute('href', '/workshop/p1/art/characters/bird/portrait');
  });
  it('never offers approval for expired requests and never fabricates a zero cost', async () => {
    server({ ...prepared, expires_at: '2020-01-01T00:00:00Z' }); render(<WorkshopRequestsPage />);
    await screen.findByText('已过期'); expect(screen.queryByRole('button', { name: '批准本次生成' })).not.toBeInTheDocument();
    expect(screen.queryByText('预计费用 ¥0.00')).not.toBeInTheDocument();
  });
  it('shows a failed approval without claiming the job started', async () => {
    const network = server(); render(<WorkshopRequestsPage />); await screen.findByText(prepared.prompt);
    network.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'REQUEST_EXPIRED', message: '请求已过期' } }), { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: '批准本次生成' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('请求已过期'));
    expect(screen.queryByText('已批准')).not.toBeInTheDocument();
  });

  it('loads a deep-linked request directly even when it is outside the first result page', async () => {
    window.history.replaceState({}, '', '/workshop/requests?request_id=older-request');
    const older = { ...prepared, request_id: 'older-request', prompt: '更早的待确认请求' };
    const network = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/older-request') ? older : { requests: [], page: 1, page_size: 20, total: 100 })));
    vi.stubGlobal('fetch', network); render(<WorkshopRequestsPage />);
    await screen.findByText('更早的待确认请求');
    expect(network).toHaveBeenCalledWith('/api/workshop/requests/older-request');
    expect(screen.getByRole('button', { name: '批准本次生成' })).toBeInTheDocument();
  });

  it('links UI and video jobs to their exact existing workspace routes', () => {
    expect(workshopTargetUrl({ type: 'ui', project_id: 'p1', ui_scheme_id: 'v2', screen_id: 'home' })).toBe('/workshop/p1/ui/v2/screens/home');
    expect(workshopTargetUrl({ type: 'video', project_id: 'p1', production_id: 'intro' })).toBe('/workshop/p1/video/intro');
  });
});
