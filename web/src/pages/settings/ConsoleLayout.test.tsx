import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { CONSOLE_NAV, ConsoleLayout, rememberCreativeLocation } from './ConsoleLayout';

vi.mock('@/api/keys', () => ({ listKeys: async () => ({ keys: [] }) }));
vi.mock('./ProvidersPage', () => ({ ProvidersPage: () => <><h1>供应商</h1><p>providers-content</p></> }));
vi.mock('./ProviderAddPage', () => ({ ProviderAddPage: () => <><h1>添加</h1><p>provider-add-content</p></> }));
vi.mock('./RoutesPage', () => ({ RoutesPage: () => <><h1>路由</h1><p>routes-content</p></> }));
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
  it.each(CONSOLE_NAV.flatMap(group => group.items))('$path 渲染对应页和选中态', item => {
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
