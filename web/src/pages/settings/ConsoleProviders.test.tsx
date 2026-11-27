import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ProviderRow } from '@/components/keys/ProviderRow';
import { KeysPage } from './Keys';
import { ModelRoutesSection } from './ModelRoutesSection';
import * as keys from '@/api/keys';
import * as gateway from '@/api/gateway';
import * as comfyui from '@/api/comfyui';
vi.mock('@/api/comfyui', async original => ({
  ...await original<typeof import('@/api/comfyui')>(),
  checkComfyUI: vi.fn().mockResolvedValue({ devices: [] }),
}));
vi.mock('@/api/keys', async original => ({
  ...await original<typeof import('@/api/keys')>(),
  getChatGPTSubscription: vi.fn().mockResolvedValue({ available: false, email: null, plan: null }),
  patchKey: vi.fn().mockResolvedValue(undefined),
  listKeys: async () => ({ keys: [
    { alias: 'local', provider: 'custom', base_url: 'https://models.example.com/v1', access_key: '***', models: [] },
    { alias: 'lan', provider: 'atelier', access_key: '***', models: [] },
  ] }),
}));
vi.mock('@/api/usage', () => ({
  fetchKeyLastUsed: async () => ({ local: new Date().toISOString() }),
}));
vi.mock('@/api/models', () => ({
  listModelRoutes: async () => [{ id: 'gpt', name: 'GPT', modality: 'image', mode: 'order', candidate_alias: 'B', members: [
    { alias: 'A', provider: 'custom' }, { alias: 'B', provider: 'custom' },
  ] }], setModelRouteOrder: vi.fn(), setModelRouteMode: vi.fn(),
}));
vi.mock('@/api/gateway', () => ({
  fetchGatewayMembers: async () => ({
    members: [{ modality: 'image', alias: 'A', since: '2026-10-24T00:00:00Z', route_ids: ['gpt'] }],
    unavailable_routes: [{ id: 'gpt', name: 'GPT', modality: 'image' }],
  }),
  restoreGatewayMember: vi.fn().mockResolvedValue({ members: [], unavailable_routes: [] }),
}));
it('局域网排第一且不显示额度，下方同页展示未配置的供应商并隐藏已配置的团队网关', async () => {
  render(<KeysPage embedded />);
  await screen.findByText('lan');
  const rows = screen.getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('lan');
  expect(rows[1]).toHaveTextContent('local');
  expect(screen.queryByLabelText('中转额度')).not.toBeInTheDocument();
  expect(rows[1]).toHaveTextContent('正常');
  expect(rows[0]).toHaveTextContent('未用过');
  // 已配置的团队网关（atelier）从下方目录隐藏，自定义供应商位于添加供应商标题栏。
  const catalog = screen.getByRole('region', { name: '添加供应商' });
  expect(within(catalog).queryByRole('button', { name: /团队网关/ })).not.toBeInTheDocument();
  expect(within(catalog).getByRole('button', { name: /自定义供应商/ })).toBeInTheDocument();
});
it('同页添加区按分组平铺、支持查找与点击弹窗添加自定义供应商，无包裹框', async () => {
  vi.spyOn(keys, 'listKeys').mockResolvedValueOnce({ keys: [] });
  render(<KeysPage embedded />);
  const catalog = await screen.findByRole('region', { name: '添加供应商' });
  expect(within(catalog).getByRole('heading', { name: '供应商' })).toBeInTheDocument();
  expect(within(catalog).getByRole('heading', { name: '中转' })).toBeInTheDocument();
  expect(within(catalog).getByRole('heading', { name: '订阅' })).toBeInTheDocument();
  expect(within(catalog).getByRole('heading', { name: '本机' })).toBeInTheDocument();
  expect(within(catalog).getByRole('heading', { name: '团队网关' })).toBeInTheDocument();
  const tuziBtn = within(catalog).getByRole('button', { name: /Tuzi/ });
  expect(tuziBtn).not.toHaveClass('bg-card');
  expect(within(catalog).getByRole('button', { name: /OpenAI-HK/ })).toBeInTheDocument();
  fireEvent.change(within(catalog).getByRole('textbox', { name: '查找可添加的供应商' }), { target: { value: 'Tuzi' } });
  expect(within(catalog).getByRole('button', { name: /Tuzi/ })).toBeInTheDocument();
  expect(within(catalog).queryByRole('button', { name: /OpenAI-HK/ })).not.toBeInTheDocument();
  fireEvent.change(within(catalog).getByRole('textbox', { name: '查找可添加的供应商' }), { target: { value: '' } });
  fireEvent.click(within(catalog).getByRole('button', { name: /自定义供应商/ }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(screen.getByLabelText('请求地址')).toBeInTheDocument();
});
it('已启用和已关闭的预置供应商均从下方目录隐藏，按域名识别 custom 预设', async () => {
  vi.spyOn(keys, 'listKeys').mockResolvedValueOnce({ keys: [
    { alias: '我的兔子', provider: 'custom', enabled: true, base_url: 'https://api.tu-zi.com/v1', access_key: '***', secret_key: null, models: [], capabilities: [], notes: '', created_at: '' },
    { alias: 'OpenAI', provider: 'openai', enabled: false, base_url: 'https://api.openai.com/v1', access_key: '***', secret_key: null, models: [], capabilities: [], notes: '', created_at: '' },
  ] });
  render(<KeysPage embedded />);
  await screen.findByText('我的兔子');
  // 已关闭的供应商默认收起。
  expect(screen.getByRole('button', { name: /已关闭的供应商/ })).toHaveAttribute('aria-expanded', 'false');
  const catalog = screen.getByRole('region', { name: '添加供应商' });
  expect(within(catalog).queryByRole('button', { name: /Tuzi/ })).not.toBeInTheDocument();
  expect(within(catalog).queryByRole('button', { name: /^OpenAI$/ })).not.toBeInTheDocument();
  expect(within(catalog).getByRole('button', { name: /OpenAI-HK/ })).toBeInTheDocument();
});
it('未知自定义供应商不影响下方预置目录', async () => {
  vi.spyOn(keys, 'listKeys').mockResolvedValueOnce({ keys: [{ alias: '自己的服务', provider: 'custom',
    base_url: 'https://models.example.com/v1', access_key: '***', secret_key: null, models: [], capabilities: [], notes: '', created_at: '' }] });
  render(<KeysPage embedded />);
  await screen.findByText('自己的服务');
  const catalog = screen.getByRole('region', { name: '添加供应商' });
  expect(within(catalog).getByRole('button', { name: /Tuzi/ })).toBeInTheDocument();
  expect(within(catalog).getByRole('button', { name: /OpenAI-HK/ })).toBeInTheDocument();
  expect(within(catalog).getByRole('button', { name: /自定义供应商/ })).toBeInTheDocument();
});
describe('路由成员', () => {
  it('显示欠费时间与全部欠费，恢复后移除状态', async () => {
    render(<ModelRoutesSection reloadToken={0} />);
    expect(await screen.findByText('全部成员欠费')).toBeInTheDocument();
    expect(screen.getByText(/欠费已摘除/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(gateway.restoreGatewayMember).toHaveBeenCalledWith('image', 'A'));
    await waitFor(() => expect(screen.queryByText('全部成员欠费')).not.toBeInTheDocument());
  });
});

beforeEach(() => { vi.mocked(keys.patchKey).mockReset().mockResolvedValue(undefined); });
it('按名称、类型和域名过滤供应商', async () => {
  render(<KeysPage embedded />);
  await screen.findByText('local');
  const search = screen.getByRole('textbox', { name: '查找供应商' });
  for (const query of ['LOCAL', '自定义', 'models.example.com']) {
    fireEvent.change(search, { target: { value: query } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('listitem')).toHaveTextContent('local');
  }
  fireEvent.change(search, { target: { value: 'missing' } });
  expect(screen.getByText('没有匹配的供应商')).toBeInTheDocument();
});
it('停用立即变淡并提交，请求期间不禁用，失败回滚', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(keys.patchKey).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  render(<KeysPage embedded />);
  const toggle = await screen.findByRole('switch', { name: '启用 local' });
  fireEvent.click(toggle);
  expect(screen.getByText('已停用').closest('li')).toHaveClass('opacity-50');
  // 乐观切换：请求期间开关不禁用，只标保存中。
  expect(toggle).toBeEnabled();
  expect(screen.getByText('已停用').closest('li')).toHaveAttribute('aria-busy', 'true');
  expect(keys.patchKey).toHaveBeenCalledWith('local', { enabled: false });
  reject(new Error('保存失败'));
  await screen.findByText('保存失败');
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(toggle).toBeEnabled();
  expect(screen.queryByText('已停用')).not.toBeInTheDocument();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).toHaveAttribute('aria-checked', 'false');
});

it('状态优先级为停用、欠费、长期未用，30 天以内正常', () => {
  const row = { alias: 'old', provider: 'custom', masked_secret: '***',
    last_used_at: new Date(Date.now() - 31 * 86400000).toISOString() };
  const props = { pending: false, onEdit: vi.fn(), onToggle: vi.fn() };
  const view = render(<ProviderRow row={row} overdue={false} {...props} />);
  expect(screen.getByText('31 天未用')).toBeInTheDocument();
  view.rerender(<ProviderRow row={row} overdue {...props} />);
  expect(screen.getByText('欠费')).toBeInTheDocument();
  view.rerender(<ProviderRow row={{ ...row, enabled: false }} overdue {...props} />);
  expect(screen.getByText('已停用')).toBeInTheDocument();
  view.rerender(<ProviderRow row={{ ...row, last_used_at: new Date(Date.now() - 29 * 86400000).toISOString() }} overdue={false} {...props} />);
  expect(screen.getByText('正常')).toBeInTheDocument();
});


it('订阅卡片展示账号和套餐', async () => {
  vi.spyOn(keys, 'listKeys').mockResolvedValueOnce({ keys: [] });
  vi.mocked(keys.getChatGPTSubscription).mockResolvedValueOnce({ available: true, email: 'artist@example.test', plan: 'plus' });
  render(<KeysPage embedded />);
  const catalog = await screen.findByRole('region', { name: '添加供应商' });
  expect(within(catalog).getByRole('heading', { name: '订阅' })).toBeInTheDocument();
  const card = within(catalog).getByRole('button', { name: /ChatGPT/ });
  await waitFor(() => expect(card).toHaveTextContent('artist@example.test · plus'));
});

it('订阅状态加载失败不冒充未登录', async () => {
  vi.spyOn(keys, 'listKeys').mockResolvedValueOnce({ keys: [] });
  vi.mocked(keys.getChatGPTSubscription).mockRejectedValueOnce(new Error('读取登录状态失败'));
  render(<KeysPage embedded />);
  const catalog = await screen.findByRole('region', { name: '添加供应商' });
  expect(await within(catalog).findByText('读取登录状态失败')).toBeInTheDocument();
  expect(within(catalog).queryByText('请先在 Codex 里用 ChatGPT 登录')).not.toBeInTheDocument();
});


it('订阅供应商列表显示品牌名称', () => {
  render(<ProviderRow row={{ alias: 'chatgpt', provider: 'chatgpt', masked_secret: '', models: [{ id: 'gpt-image-2', name: 'GPT Image' }] }} overdue={false} pending={false} onEdit={vi.fn()} onToggle={vi.fn()} />);
  expect(screen.getByText('ChatGPT（Codex 登录）')).toBeInTheDocument();
});

it('ComfyUI 供应商行按实时探测结果展示运行中、未启动或检查中，停用优先', () => {
  const row = { alias: '本机 ComfyUI', provider: 'comfyui', base_url: 'http://127.0.0.1:8188', masked_secret: '',
    last_used_at: new Date().toISOString(), models: [] };
  const props = { overdue: false, pending: false, onEdit: vi.fn(), onToggle: vi.fn() };
  const view = render(<ProviderRow row={row} comfyStatus="checking" {...props} />);
  expect(screen.getByText('检查中…')).toBeInTheDocument();
  view.rerender(<ProviderRow row={row} comfyStatus="running" {...props} />);
  expect(screen.getByText('运行中')).toBeInTheDocument();
  view.rerender(<ProviderRow row={row} comfyStatus="stopped" {...props} />);
  expect(screen.getByText('未启动')).toBeInTheDocument();
  view.rerender(<ProviderRow row={{ ...row, enabled: false }} comfyStatus="stopped" {...props} />);
  expect(screen.getByText('已停用')).toBeInTheDocument();
});

it('供应商列表探测已启用的 ComfyUI 并在切回窗口时静默刷新状态', async () => {
  vi.mocked(comfyui.checkComfyUI).mockReset()
    .mockRejectedValueOnce(new Error('主机的 ComfyUI 未启动'))
    .mockResolvedValueOnce({ devices: [{ name: 'RTX 4090', vram_total: 24 * 1024 ** 3 }] });
  vi.spyOn(keys, 'listKeys').mockResolvedValueOnce({ keys: [
    { alias: 'ComfyUI', provider: 'comfyui', base_url: 'http://127.0.0.1:8188', access_key: '', secret_key: null, models: [], capabilities: [], notes: '', created_at: '', enabled: true },
    { alias: '停用的 ComfyUI', provider: 'comfyui', base_url: 'http://127.0.0.1:8199', access_key: '', secret_key: null, models: [], capabilities: [], notes: '', created_at: '', enabled: false },
  ] });
  render(<KeysPage embedded />);
  await screen.findByText('未启动');
  expect(comfyui.checkComfyUI).toHaveBeenCalledTimes(1);
  expect(comfyui.checkComfyUI).toHaveBeenCalledWith('http://127.0.0.1:8188');

  window.dispatchEvent(new Event('focus'));
  await screen.findByText('运行中');
  expect(comfyui.checkComfyUI).toHaveBeenCalledTimes(2);
});
