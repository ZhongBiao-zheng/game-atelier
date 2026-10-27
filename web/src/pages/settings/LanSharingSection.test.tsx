import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { requestJson } from '@/api/http';
import * as api from '@/api/gateway';
import { LanSharingSection } from './LanSharingSection';
vi.mock('@/api/http', () => ({ requestJson: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
vi.mock('@/hooks/useSSE', () => ({ useSSE: vi.fn() }));
vi.mock('@/api/gateway', () => ({ adminBase: (alias: string) => `/api/gateway/providers/${alias}/admin`, fetchGateway: vi.fn(), fetchGatewayOptions: vi.fn(), fetchGatewayService: vi.fn(),
  fetchGatewayTasks: vi.fn(), fetchGatewayMembers: vi.fn(), createGatewayKey: vi.fn(), updateGatewayKey: vi.fn(),
  revealGatewayKey: vi.fn(), revokeGatewayKey: vi.fn(), updateGateway: vi.fn(), gatewayOutputUrl: vi.fn() }));
const key: api.GatewayKey = { id: 'k1', name: '小王', limits: [], allowed_models: null, allowed_aliases: null,
  created_at: '', revoked_at: null, month_charged_cny: .5, month_calls: 1, last_used_at: null, limits_status: [] };
const state: api.GatewayState = { enabled: true, port: 5180, name: '', default_name: 'mac', keys: [key], status: { running: true, port: 5180, error: null, addresses: ['192.168.1.20'] } };
beforeEach(() => { vi.clearAllMocks();
  vi.mocked(api.fetchGateway).mockResolvedValue(state);
  vi.mocked(api.fetchGatewayOptions).mockResolvedValue({ models: [{ id: 'gpt', name: 'GPT', modality: 'image' }], aliases: [{ alias: 'HK', name: 'HK', provider: 'custom' }] });
  vi.mocked(api.fetchGatewayTasks).mockResolvedValue([]);
  vi.mocked(api.fetchGatewayMembers).mockResolvedValue({ members: [], unavailable_routes: [] });
  vi.mocked(api.fetchGatewayService).mockResolvedValue({ state: 'unsupported', install_command: null });
});
describe('LAN sharing', () => {
  it('shows the pending system credential step without installing from the page', async () => {
    vi.mocked(api.fetchGatewayService).mockResolvedValue(
      { state: 'needs_credentials', install_command: 'powershell -File scripts/windows-service.ps1 install' });
    render(<LanSharingSection />);
    expect(await screen.findByText('常驻服务：待设置系统凭据')).toBeInTheDocument();
    expect(screen.getByText('powershell -File scripts/windows-service.ps1 install')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '安装' })).not.toBeInTheDocument();
  });
  it('creates all three limits and scoped permissions; plaintext disappears when closed', async () => {
    vi.mocked(api.createGatewayKey).mockResolvedValue({ key, token: 'atg_once' });
    render(<LanSharingSection />);
    await screen.findByText('http://192.168.1.20:5180');
    fireEvent.click(screen.getByRole('button', { name: '新建成员密钥' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '小李' } });
    for (const [label, value] of [['今日', '10'], ['本周', '50'], ['本月', '100']]) fireEvent.change(screen.getByLabelText(`${label}限额`), { target: { value } });
    fireEvent.click(screen.getByRole('switch', { name: '全部模型' })); fireEvent.click(screen.getByLabelText('GPT'));
    fireEvent.click(screen.getByRole('switch', { name: '全部供应商' })); fireEvent.click(screen.getByLabelText('HK'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.createGatewayKey).toHaveBeenCalledWith({ role: 'member', name: '小李', limits: [{ period: 'day', cap_cny: 10 }, { period: 'week', cap_cny: 50 }, { period: 'month', cap_cny: 100 }], allowed_models: ['gpt'], allowed_aliases: ['HK'] }));
    await screen.findByText('atg_once'); fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByText('atg_once')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '新建成员密钥' })); expect(screen.queryByText('atg_once')).not.toBeInTheDocument();
  });
  it('edits existing keys and revokes through confirmation', async () => {
    vi.mocked(api.updateGatewayKey).mockResolvedValue(key); vi.mocked(api.revokeGatewayKey).mockResolvedValue(key);
    render(<LanSharingSection />); fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '改名' } }); fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.updateGatewayKey).toHaveBeenCalledWith('k1', expect.objectContaining({ name: '改名' })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(api.revokeGatewayKey).toHaveBeenCalledWith('k1'));
  });
});

it('网关只保留密钥和运行中任务，花费链接定位团队成员', async () => {
  render(<LanSharingSection />);
  const link = await screen.findByRole('link', { name: '0.5¥' });
  expect(link).toHaveAttribute('href', '/settings/usage?scope=team&member=k1');
  expect(screen.queryByRole('region', { name: '供应商状态' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '用量' })).not.toBeInTheDocument();
});
it('网关关闭时隐藏密钥和端口', async () => {
  vi.mocked(api.fetchGateway).mockResolvedValue({ ...state, enabled: false });
  render(<LanSharingSection />);
  await waitFor(() => expect(screen.getByRole('switch', { name: '开启局域网共享' })).not.toBeDisabled());
  expect(screen.queryByRole('button', { name: '新建成员密钥' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText('端口')).not.toBeInTheDocument();
});

it('状态卡内编辑端口，校验范围并在成功后收起', async () => {
  const updated = { ...state, port: 5190, status: { ...state.status, port: 5190 } };
  vi.mocked(api.updateGateway).mockResolvedValue(updated);
  render(<LanSharingSection />);
  const card = screen.getByRole('region', { name: '网关状态' });
  fireEvent.click(await within(card).findByRole('button', { name: '改端口' }));
  const input = within(card).getByLabelText('端口');
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: '1023' } });
  expect(within(card).getByRole('button', { name: '保存端口' })).toBeDisabled();
  fireEvent.change(input, { target: { value: '65536' } });
  expect(within(card).getByRole('button', { name: '保存端口' })).toBeDisabled();
  fireEvent.change(input, { target: { value: '5190' } });
  vi.mocked(api.fetchGateway).mockResolvedValue(updated);
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(api.updateGateway).toHaveBeenCalledWith({ port: 5190 }));
  await waitFor(() => expect(screen.queryByLabelText('端口')).not.toBeInTheDocument());
  expect(within(card).getByRole('button', { name: '改端口' })).toBeInTheDocument();
  expect(within(card).getByText('http://192.168.1.20:5190')).toBeInTheDocument();
});

it('端口保存失败保留输入，可取消后重开', async () => {
  vi.mocked(api.updateGateway).mockRejectedValue(new Error('端口被占用'));
  render(<LanSharingSection />);
  fireEvent.click(await screen.findByRole('button', { name: '改端口' }));
  fireEvent.change(screen.getByLabelText('端口'), { target: { value: '5190' } });
  fireEvent.click(screen.getByRole('button', { name: '保存端口' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('端口被占用');
  expect(screen.getByLabelText('端口')).toHaveValue('5190');
  expect(screen.getByRole('button', { name: '保存端口' })).not.toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.click(screen.getByRole('button', { name: '改端口' }));
  expect(screen.getByLabelText('端口')).toHaveValue('5180');
});

it('关闭后仅状态卡显示摘要，开启继续沿用原操作', async () => {
  const off = { ...state, enabled: false, status: { ...state.status, running: false } };
  vi.mocked(api.fetchGateway).mockResolvedValue(off);
  vi.mocked(api.updateGateway).mockResolvedValue(state);
  render(<LanSharingSection />);
  expect(await screen.findByText('开启后，同事可以用你的供应商出图，按成员限额记账')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '成员' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '复制地址' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '改端口' })).not.toBeInTheDocument();
  expect(api.fetchGatewayTasks).not.toHaveBeenCalled();
  vi.mocked(api.fetchGateway).mockResolvedValue(state);
  fireEvent.click(screen.getByRole('switch', { name: '开启局域网共享' }));
  await waitFor(() => expect(api.updateGateway).toHaveBeenCalledWith({ enabled: true }));
  expect(await screen.findByRole('region', { name: '成员' })).toBeInTheDocument();
});

it('成员额度超过85%才变橙，撤销行整体变淡且不可操作', async () => {
  const limited = { ...key, limits_status: [{ period: 'month' as const, cap_cny: 100, used_cny: 85, reserved_cny: 0, left_cny: 15, resets_at: '2026-11-01' }] };
  vi.mocked(api.fetchGateway).mockResolvedValue({ ...state, keys: [limited,
    { ...limited, id: 'k2', name: '小李', limits_status: [{ ...limited.limits_status[0], reserved_cny: 1 }] },
    { ...key, id: 'k3', name: '已离开', revoked_at: '2026-10-25' }] });
  render(<LanSharingSection />);
  const regular = await screen.findByRole('progressbar', { name: '小王本月额度' });
  expect(regular.parentElement).toHaveClass('text-primary');
  expect(screen.getByRole('progressbar', { name: '小李本月额度' }).parentElement).toHaveClass('text-status-running');
  const revoked = screen.getByText('已离开').closest('tr')!;
  expect(revoked).toHaveClass('opacity-50');
  expect(within(revoked).getByText('已撤销')).toBeInTheDocument();
  expect(within(revoked).queryByRole('button')).not.toBeInTheDocument();
  expect(within(regular.closest('tr')!).getByRole('button', { name: '编辑' })).toBeInTheDocument();
  expect(within(regular.closest('tr')!).getByText('·')).toBeInTheDocument();
});

it('复制运行中的地址', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<LanSharingSection />);
  fireEvent.click(await screen.findByRole('button', { name: '复制地址' }));
  expect(writeText).toHaveBeenCalledWith('http://192.168.1.20:5180');
  expect(await screen.findByText('已复制')).toBeInTheDocument();
});

it('复制失败显示错误且允许重试', async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<LanSharingSection />);
  fireEvent.click(await screen.findByRole('button', { name: '复制地址' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('复制失败，请手动复制地址');
  expect(screen.getByRole('button', { name: '复制地址' })).toHaveTextContent('复制');
  fireEvent.click(screen.getByRole('button', { name: '复制地址' }));
  expect(await screen.findByText('已复制')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});


it('远程复用成员编辑且不显示本机开关，角色通过代理保存', async () => {
  vi.stubGlobal('EventSource', class { onopen = null; addEventListener() {} close() {} });
  vi.mocked(api.updateGatewayKey).mockResolvedValue({ ...key, role: 'admin' });
  render(<LanSharingSection gatewayAlias="relay" />);
  fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
  expect(api.fetchGateway).toHaveBeenCalledWith('relay');
  expect(screen.queryByRole('switch', { name: '开启局域网共享' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('角色'), { target: { value: 'admin' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(api.updateGatewayKey).toHaveBeenCalledWith('k1', expect.objectContaining({ role: 'admin' }), 'relay'));
});

it('本机操作日志页签显示操作者与变更', async () => {
  vi.mocked(requestJson).mockResolvedValue({ entries: [{ time: '2026-10-26T03:00:00+00:00', actor_name: '负责人', action: 'member.update', target_id: 'k1', summary: { before: { role: 'member' }, after: { role: 'admin' } } }] });
  render(<LanSharingSection />);
  await screen.findByRole('button', { name: '编辑' });
  fireEvent.click(screen.getByRole('button', { name: '操作日志' }));
  expect(await screen.findByText('负责人')).toBeInTheDocument();
  expect(screen.getByText('修改成员')).toBeInTheDocument();
  expect(requestJson).toHaveBeenCalledWith('/api/gateway/audit', '读取操作日志');
});


describe('member token controls', () => {
  it('reveals only on demand, hides inline, and copies without revealing', async () => {
    vi.mocked(api.revealGatewayKey).mockResolvedValue({ token: 'atg_test_only' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<LanSharingSection />);
    const reveal = await screen.findByRole('button', { name: '查看 小王 的密钥' });
    expect(api.revealGatewayKey).not.toHaveBeenCalled();
    fireEvent.click(reveal);
    expect(await screen.findByText('atg_test_only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '隐藏 小王 的密钥' }));
    expect(screen.queryByText('atg_test_only')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '复制 小王 的密钥' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('atg_test_only'));
    expect(screen.queryByText('atg_test_only')).not.toBeInTheDocument();
    expect(api.revealGatewayKey).toHaveBeenCalledTimes(2);
  });
  it('does not expose controls to remote admins or revoked members', async () => {
    vi.stubGlobal('EventSource', class { addEventListener() {} close() {} });
    const view = render(<LanSharingSection gatewayAlias="remote" />);
    await screen.findByText('小王');
    expect(screen.queryByRole('button', { name: /小王 的密钥/ })).not.toBeInTheDocument();
    view.unmount();
    vi.mocked(api.fetchGateway).mockResolvedValue({ ...state, keys: [{ ...key, revoked_at: '2026-10-27' }] });
    render(<LanSharingSection />);
    await screen.findByText('已撤销');
    expect(screen.queryByRole('button', { name: /小王 的密钥/ })).not.toBeInTheDocument();
    expect(api.revealGatewayKey).not.toHaveBeenCalled();
  });
  it('reports reveal errors without showing plaintext', async () => {
    vi.mocked(api.revealGatewayKey).mockRejectedValue(new Error('密钥已撤销'));
    render(<LanSharingSection />);
    fireEvent.click(await screen.findByRole('button', { name: '查看 小王 的密钥' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('密钥已撤销');
    expect(screen.queryByRole('button', { name: '隐藏 小王 的密钥' })).not.toBeInTheDocument();
  });
  it('renames inline with only a name patch', async () => {
    vi.mocked(api.updateGatewayKey).mockResolvedValue({ ...key, name: '新名字' });
    render(<LanSharingSection />);
    fireEvent.click(await screen.findByRole('button', { name: '重命名 小王' }));
    fireEvent.change(screen.getByRole('textbox', { name: '修改 小王 的名称' }), { target: { value: '新名字' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: '修改 小王 的名称' }), { key: 'Enter' });
    await waitFor(() => expect(api.updateGatewayKey).toHaveBeenCalledWith('k1', { name: '新名字' }));
  });
});
