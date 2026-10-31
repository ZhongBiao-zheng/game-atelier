import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { hoverHint } from '@/test/hint';
import { listKeys } from '@/api/keys';
import { fetchGatewayProviderMe, fetchGateway, type GatewayState } from '@/api/gateway';
import { publishGatewayConnected } from '@/api/gatewayEvents';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { CONSOLE_NAV, ConsoleLayout, rememberCreativeLocation } from './ConsoleLayout';

vi.mock('@/api/gateway', () => ({ fetchGateway: vi.fn(), fetchGatewayProviderMe: vi.fn() }));
const gateway: GatewayState = { enabled: true, port: 5180, name: '', default_name: 'mac', keys: [],
  status: { running: true, port: 5180, addresses: [], error: null } };
beforeEach(() => { vi.mocked(listKeys).mockResolvedValue({ keys: [] } as never); vi.mocked(fetchGatewayProviderMe).mockResolvedValue(null); vi.mocked(fetchGateway).mockReset().mockResolvedValue({ ...gateway, enabled: false }); });
afterEach(() => { window.history.replaceState({}, '', '/'); });

vi.mock('@/api/keys', () => ({ listKeys: vi.fn().mockResolvedValue({ keys: [] }) }));
vi.mock('./ProvidersPage', () => ({ ProvidersPage: () => <><h1>供应商</h1><p>providers-content</p></> }));
vi.mock('./ProviderAddPage', () => ({ ProviderAddPage: () => <><h1>添加</h1><p>provider-add-content</p></> }));
vi.mock('./RoutesPage', () => ({ RoutesPage: () => <><h1>智能路由</h1><p>routes-content</p></> }));
vi.mock('./GatewayPage', () => ({ GatewayPage: () => <p>gateway-content</p> }));
vi.mock('./usage/UsagePage', () => ({ UsagePage: () => <p>usage-content</p> }));
vi.mock('./LibrariesPage', () => ({ LibrariesPage: () => <p>libraries-content</p> }));
vi.mock('./AgentPage', () => ({ AgentPage: () => <p>agent-content</p> }));
vi.mock('./PreferencesPage', () => ({ PreferencesPage: () => <p>preferences-content</p> }));

describe('控制台路由', () => {
  it('添加页仍选中供应商导航', () => {
    const { hook } = memoryLocation({ path: '/settings/providers/new' });
    render(<Router hook={hook}><ConsoleLayout /></Router>);
    expect(screen.getByRole('heading', { name: '添加' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '供应商' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('provider-add-content')).toBeInTheDocument();
  });
  it.each(CONSOLE_NAV.flatMap(group => group.items).filter(item => item.path !== '/settings/relay-admin'))('$path 渲染对应页和选中态', item => {
    const { hook } = memoryLocation({ path: item.path });
    render(<Router hook={hook}><ConsoleLayout /></Router>);
    expect(screen.getByRole('heading', { level: 1, name: item.label })).toBeInTheDocument();
    expect(screen.getByText(`${item.path.split('/').pop()}-content`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: item.label })).toHaveAttribute('aria-current', 'page');
  });
  it.each(['/settings', '/settings/unknown'])('%s 重定向到供应商', path => {
    const location = memoryLocation({ path });
    render(<Router hook={location.hook}><ConsoleLayout /></Router>);
    expect(screen.getByRole('heading', { name: '供应商' })).toBeInTheDocument();
  });
  it('返回最后创作地址并保留查询参数', () => {
    rememberCreativeLocation('/canvas/demo?view=detail');
    rememberCreativeLocation('/settings/routes');
    const { hook } = memoryLocation({ path: '/settings/providers' });
    render(<Router hook={hook}><ConsoleLayout /></Router>);
    expect(screen.getByRole('link', { name: '返回创作' })).toHaveAttribute('href', '/canvas/demo?view=detail');
    rememberCreativeLocation('/');
  });
  it('应用调用方没有旧地址或锚点', () => {
    const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });
    for (const [path, content] of Object.entries(sources)) {
      if (path.includes('.test.')) continue;
      expect(String(content), path).not.toMatch(/section=|["'`]\/settings\/keys|#settings-/);
    }
  });
});


it('设置展开三个原生锚点，并跟随hash选中', async () => {
  window.history.replaceState({}, '', '/settings/preferences#storage');
  const { hook } = memoryLocation({ path: '/settings/preferences' });
  render(<Router hook={hook}><ConsoleLayout /></Router>);
  expect(screen.getByRole('link', { name: '存储' })).toHaveAttribute('aria-current', 'location');
  expect(screen.getByRole('link', { name: '外观' })).toHaveAttribute('href', '#appearance');
  expect(screen.getByRole('link', { name: '个人' })).toHaveAttribute('href', '#profile');
  fireEvent.click(screen.getByRole('link', { name: '个人' }));
  expect(screen.getByRole('link', { name: '个人' })).toHaveAttribute('aria-current', 'location');
  act(() => { window.history.replaceState({}, '', '/settings/preferences#appearance'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
  expect(screen.getByRole('link', { name: '外观' })).toHaveAttribute('aria-current', 'location');
  await waitFor(() => expect(fetchGateway).toHaveBeenCalledTimes(1));
});

it('非设置页不展开分组，未开启不显示本机网关行', async () => {
  const { hook } = memoryLocation({ path: '/settings/providers' });
  render(<Router hook={hook}><ConsoleLayout /></Router>);
  await waitFor(() => expect(fetchGateway).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('link', { name: '外观' })).not.toBeInTheDocument();
  expect(screen.queryByText(/局域网共享 ·/)).not.toBeInTheDocument();
});

it('本机网关响应事件刷新且旧慢响应不能覆盖更新状态', async () => {
  let resolveOld!: (value: GatewayState) => void;
  vi.mocked(fetchGateway).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }));
  const { hook } = memoryLocation({ path: '/settings/providers' });
  render(<Router hook={hook}><ConsoleLayout /></Router>);
  vi.mocked(fetchGateway).mockResolvedValue(gateway);
  act(() => publishGatewayConnected());
  expect(await screen.findByRole('link', { name: '局域网共享 · 运行中' })).toHaveAttribute('href', '/settings/gateway');
  await act(async () => resolveOld({ ...gateway, enabled: false }));
  expect(screen.getByText('局域网共享 · 运行中')).toBeInTheDocument();
  vi.mocked(fetchGateway).mockResolvedValue({ ...gateway, status: { ...gateway.status, running: false, error: '端口占用' } });
  act(() => publishGatewayConnected());
  expect(await hoverHint(await screen.findByRole('link', { name: '局域网共享 · 启动失败' }))).toHaveTextContent('端口占用');
  expect(screen.queryByText('局域网共享 · 运行中')).not.toBeInTheDocument();
  vi.mocked(fetchGateway).mockRejectedValue(new Error('offline'));
  act(() => publishGatewayConnected());
  await waitFor(() => expect(screen.queryByText(/局域网共享 ·/)).not.toBeInTheDocument());
});


it('仅管理员连接显示中转管理，降级后隐藏', async () => {
  vi.mocked(listKeys).mockResolvedValue({ keys: [{ alias: 'relay', provider: 'atelier', enabled: true }] } as never);
  vi.mocked(fetchGatewayProviderMe).mockResolvedValue({ role: 'member', limits: [] } as never);
  const { hook } = memoryLocation({ path: '/settings/providers' });
  render(<Router hook={hook}><ConsoleLayout /></Router>);
  await waitFor(() => expect(fetchGatewayProviderMe).toHaveBeenCalledWith('relay'));
  expect(screen.queryByRole('link', { name: '中转管理' })).not.toBeInTheDocument();
  vi.mocked(fetchGatewayProviderMe).mockResolvedValue({ role: 'admin', limits: [] } as never);
  act(() => publishGatewayConnected());
  expect(await screen.findByRole('link', { name: '中转管理' })).toBeInTheDocument();
  vi.mocked(fetchGatewayProviderMe).mockResolvedValue({ role: 'member', limits: [] } as never);
  act(() => publishGatewayConnected());
  await waitFor(() => expect(screen.queryByRole('link', { name: '中转管理' })).not.toBeInTheDocument());
});
