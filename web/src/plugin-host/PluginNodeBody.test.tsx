import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import lockFixture from '../../../plugins/sprite-sheet/package/manifest.lock.json';
import type { CanvasPluginNode } from '@/schema/canvas';
import type { PluginEntry, PluginPackageLock } from '@/schema/plugins';
import { PluginNodeBody } from './PluginNodeBody';
import { setPluginsSnapshot } from './registry';

vi.mock('./PluginSurface', () => ({
  PluginSurface: ({ host }: { host: { capabilities: ReadonlySet<string> } }) => (
    <p data-testid="surface">{[...host.capabilities].sort().join(',')}</p>
  ),
}));

const manifest = lockFixture as unknown as PluginPackageLock;
const entry = (patch: Partial<PluginEntry> = {}): PluginEntry => (
  { id: 'sprite-sheet', availability: 'ok', reason: null, enabled: true, manifest, ...patch }
);
const node = (patch: Partial<CanvasPluginNode['data']> = {}): CanvasPluginNode => ({
  id: 'sheet-1', type: 'plugin', title: '精灵表', position: { x: 0, y: 0 }, z_index: 0,
  data: { plugin_id: 'sprite-sheet', node_type: 'sheet', plugin_version: '0.1.0', data_schema_version: 1,
    payload: { frames: [1, 2] }, generation_draft: null, ...patch },
});

function server(initial: Record<string, { capabilities: string[] }>, failGrant = false) {
  let grants = initial;
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      if (failGrant) return new Response(JSON.stringify({ detail: { message: '插件未启用', code: 'PLUGIN_DISABLED' } }), { status: 409 });
      grants = { ...grants, 'sprite-sheet': { capabilities: manifest.capabilities } };
    }
    expect(url).toMatch(/^\/api\/canvas\/projects\/[^/]+\/plugin-grants/);
    return new Response(JSON.stringify({ grants }));
  });
  vi.stubGlobal('fetch', network);
  return network;
}
let projectCounter = 0;
function mount(target = node()) {
  const updateNode = vi.fn();
  const projectId = `project-${++projectCounter}`;
  render(<PluginNodeBody node={target} projectId={projectId} selected={false} inputs={[]}
    resolveVersion={() => undefined} updateNode={updateNode} recordHistory={vi.fn()} />);
  return { updateNode, projectId };
}
afterEach(() => { vi.unstubAllGlobals(); setPluginsSnapshot([]); });

describe('插件节点内容区', () => {
  it('没有这个插件时显示占位，不请求任何东西以外的数据', async () => {
    server({});
    setPluginsSnapshot([]);
    mount();
    expect(await screen.findByText('未安装此插件')).toBeInTheDocument();
    expect(screen.queryByTestId('surface')).not.toBeInTheDocument();
  });

  it('插件未启用时显示占位与去启用的入口', async () => {
    server({ 'sprite-sheet': { capabilities: manifest.capabilities } });
    setPluginsSnapshot([entry({ enabled: false })]);
    mount();
    expect(await screen.findByText('插件未启用')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '启用' })).toHaveAttribute('href', '/settings/plugins');
    expect(screen.queryByTestId('surface')).not.toBeInTheDocument();
  });

  it('版本不兼容时显示原因', async () => {
    server({});
    setPluginsSnapshot([entry({ enabled: false, availability: 'incompatible', reason: '需要 Atelier 9.0.0 以上' })]);
    mount();
    expect(await screen.findByText('需要 Atelier 9.0.0 以上')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '启用' })).not.toBeInTheDocument();
  });

  it('清单里没有这个节点类型时不运行插件', async () => {
    server({ 'sprite-sheet': { capabilities: manifest.capabilities } });
    setPluginsSnapshot([entry()]);
    mount(node({ node_type: 'ghost' }));
    expect(await screen.findByText('此版本的插件不支持这个节点')).toBeInTheDocument();
    expect(screen.queryByTestId('surface')).not.toBeInTheDocument();
  });

  it('本项目没批准时不运行插件；确认一次后才运行', async () => {
    const network = server({});
    setPluginsSnapshot([entry()]);
    mount();
    expect(await screen.findByText('本项目尚未允许此插件')).toBeInTheDocument();
    expect(screen.queryByTestId('surface')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '允许' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('在本项目使用「精灵表调整」？');
    expect(dialog).toHaveTextContent('它会读取连到它的素材、在画布上新建内容、保存它自己的节点数据。');
    expect(network.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '允许', hidden: false }));
    expect(await screen.findByTestId('surface')).toHaveTextContent('node.read_self');
    expect(network.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  });

  it('取消确认不会批准', async () => {
    const network = server({});
    setPluginsSnapshot([entry()]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '允许' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(network.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    expect(screen.queryByTestId('surface')).not.toBeInTheDocument();
  });

  it('批准失败时报错，仍不运行插件', async () => {
    server({}, true);
    setPluginsSnapshot([entry()]);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '允许' }));
    fireEvent.click(await screen.findByRole('button', { name: '允许' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('插件未启用');
    expect(screen.queryByTestId('surface')).not.toBeInTheDocument();
  });

  it('交给界面的能力只有本项目批准过的那些', async () => {
    server({ 'sprite-sheet': { capabilities: ['node.read_self'] } });
    setPluginsSnapshot([entry()]);
    mount();
    expect(await screen.findByTestId('surface')).toHaveTextContent(/^node\.read_self$/);
  });

  it('读取批准失败按没有批准处理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    setPluginsSnapshot([entry()]);
    mount();
    expect(await screen.findByText('本项目尚未允许此插件')).toBeInTheDocument();
  });
});
