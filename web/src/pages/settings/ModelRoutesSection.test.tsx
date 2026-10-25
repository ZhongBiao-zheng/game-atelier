import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { listModelRoutes, setModelRouteMode, setModelRouteOrder, type ModelRoute } from '@/api/models';
import { fetchGatewayMembers, restoreGatewayMember } from '@/api/gateway';
import { ModelRoutesSection } from './ModelRoutesSection';

vi.mock('@/api/models', () => ({ listModelRoutes: vi.fn(), setModelRouteOrder: vi.fn(), setModelRouteMode: vi.fn() }));
vi.mock('@/api/gateway', () => ({ fetchGatewayMembers: vi.fn(), restoreGatewayMember: vi.fn() }));
const member = (alias: string) => ({
  alias, provider: 'custom', base_url: null, model_id: 'gpt-image-2', name: 'gpt-image-2', protocol: null,
});
const shared: ModelRoute = { id: 'gpt-image-2', name: 'gpt-image-2', modality: 'image', mode: 'order', candidate_alias: 'Tuzi', members: [member('Tuzi'), member('HK')] };
const single: ModelRoute = { ...shared, id: 'flux-3', name: 'flux-3', members: [member('Tuzi')] };
const emptyStatus = { members: [], unavailable_routes: [] };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchGatewayMembers).mockResolvedValue(emptyStatus);
});

describe('ModelRoutesSection', () => {
  it('读取失败显示错误，不误报为空库', async () => {
    vi.mocked(listModelRoutes).mockRejectedValue(new Error('读取模型失败'));
    render(<ModelRoutesSection reloadToken={0} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('读取模型失败');
    expect(screen.queryByText('暂无图片模型')).not.toBeInTheDocument();
    expect(screen.queryByText('加载中…')).not.toBeInTheDocument();
  });

  it('列出多家模型并折叠单家模型，提前一家保存新顺序', async () => {
    vi.mocked(listModelRoutes).mockResolvedValue([shared, single]);
    vi.mocked(setModelRouteOrder).mockResolvedValue({ ...shared, candidate_alias: 'HK', members: [member('HK'), member('Tuzi')] });
    render(<ModelRoutesSection reloadToken={0} />);
    const order = await screen.findByRole('list', { name: 'gpt-image-2 的供应商顺序' });
    expect(screen.getByText('flux-3').closest('details')).not.toHaveAttribute('open');
    expect(within(order).getAllByRole('listitem')[0]).toHaveTextContent('1Tuzi');
    expect(screen.getByText('当前走 Tuzi')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('把 HK 提前'));
    expect(setModelRouteOrder).toHaveBeenCalledWith('image', 'gpt-image-2', ['HK', 'Tuzi']);
    await screen.findByText('当前走 HK');
    expect(within(order).getAllByRole('listitem')[0]).toHaveTextContent('1HK');
  });

  it('只有单家模型仍可展开，模态标签切换列表与数量', async () => {
    vi.mocked(listModelRoutes).mockResolvedValue([single, { ...shared, id: 'veo', name: 'Veo', modality: 'video' }]);
    render(<ModelRoutesSection reloadToken={0} />);
    await screen.findByText('只有一家供应商的模型 · 1');
    expect(screen.getByRole('tab', { name: '图片 1' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: '视频 1' }));
    expect(screen.getByRole('list', { name: 'Veo 的供应商顺序' })).toBeInTheDocument();
    expect(screen.queryByText('flux-3')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '文本 0' }));
    expect(screen.getByText('暂无文本模型')).toBeInTheDocument();
  });

  it('方式保存后显示价格或下次候选，失败保留原方式', async () => {
    vi.mocked(listModelRoutes).mockResolvedValue([shared]);
    vi.mocked(setModelRouteMode).mockResolvedValueOnce({ ...shared, mode: 'cheap', members: [{ ...member('Tuzi'), estimate_cny: 0.21 }, member('HK')] })
      .mockResolvedValueOnce({ ...shared, mode: 'round_robin', candidate_alias: 'HK' })
      .mockRejectedValueOnce(new Error('保存失败'));
    render(<ModelRoutesSection reloadToken={0} />);
    const select = await screen.findByRole('combobox', { name: 'gpt-image-2 的路由方式' });
    fireEvent.change(select, { target: { value: 'cheap' } });
    expect(setModelRouteMode).toHaveBeenCalledWith('image', 'gpt-image-2', 'cheap');
    await screen.findByText('≈¥0.21');
    expect(screen.getByText('未计价')).toBeInTheDocument();
    expect(screen.queryByLabelText('把 HK 提前')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'round_robin' } });
    await screen.findByText('下一次走 HK');
    expect(screen.queryByText('≈¥0.21')).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'order' } });
    await screen.findByText('保存失败');
    expect(select).toHaveValue('round_robin');
  });

  it('全部恢复按成员依次提交，刷新可用候选；局部失败保留剩余欠费', async () => {
    const a = { modality: 'image', alias: 'Tuzi', since: '2026-10-24T00:00:00Z', next_probe_at: '2026-10-25T00:00:00Z', route_ids: ['gpt-image-2'] };
    const b = { ...a, alias: 'HK' };
    vi.mocked(fetchGatewayMembers).mockResolvedValue({ members: [a, b], unavailable_routes: [] });
    vi.mocked(listModelRoutes).mockResolvedValue([shared]);
    vi.mocked(restoreGatewayMember).mockResolvedValueOnce({ members: [b], unavailable_routes: [] }).mockRejectedValueOnce(new Error('HK 恢复失败'));
    render(<ModelRoutesSection reloadToken={0} />);
    fireEvent.click(await screen.findByRole('button', { name: '全部恢复' }));
    await screen.findByText('HK 恢复失败');
    expect(restoreGatewayMember).toHaveBeenNthCalledWith(1, 'image', 'Tuzi');
    expect(restoreGatewayMember).toHaveBeenNthCalledWith(2, 'image', 'HK');
    expect(screen.getByRole('status')).toHaveTextContent('HK 欠费，已从 1 条路由摘除');
    expect(screen.getAllByRole('button', { name: '恢复' })).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole('button', { name: '全部恢复' })).toBeEnabled());
    vi.mocked(restoreGatewayMember).mockResolvedValueOnce(emptyStatus);
    fireEvent.click(screen.getByRole('button', { name: '全部恢复' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '全部恢复' })).not.toBeInTheDocument());
    expect(listModelRoutes).toHaveBeenCalledTimes(3);
  });
});
