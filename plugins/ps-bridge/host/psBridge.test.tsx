import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { HostPluginApi } from '@/plugin-host/hostPlugins';
import type { CanvasContentNode, CanvasDocument, CanvasNode } from '@/schema/canvas';

import manifest from '../manifest.json';
import { PsAgentScripts, PsBridgeSettings } from './PsBridgeSettings';
import { importImage, placeImage, plugin, psBridgeBusy } from './psBridge';

afterEach(() => { vi.unstubAllGlobals(); });

function respond(routes: Record<string, () => Response>) {
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    const route = /^\/api\/plugins\/ps-bridge\/routes(\/[a-z]+)$/.exec(url)?.[1];
    const reply = route ? routes[route] : undefined;
    if (!reply) throw new Error(`unexpected ${url}`);
    expect(init?.method).toBe('POST');
    return reply();
  });
  vi.stubGlobal('fetch', network);
  return network;
}

const ok = (result: unknown) => () => new Response(JSON.stringify({ result }));
const fail = (status: number, message: string) => () =>
  new Response(JSON.stringify({ detail: { message, code: 'PS_X' } }), { status });

type TestApi = HostPluginApi & { nodes: CanvasNode[] };

function hostApi(): TestApi {
  const api: TestApi = {
    nodes: [],
    projectId: 'canvas-ps',
    findNode: id => api.nodes.find(node => node.id === id),
    listNodes: () => api.nodes,
    resolveVersion: () => undefined,
    updateNode: vi.fn((id: string, updater: (node: CanvasNode) => CanvasNode) => {
      api.nodes = api.nodes.map(node => node.id === id ? updater(node) : node);
    }),
    recordHistory: vi.fn(), selectNode: vi.fn(), reportError: vi.fn(), clearError: vi.fn(), announce: vi.fn(),
    savePendingEdits: vi.fn(async () => undefined), lastRunFailed: () => false,
    currentDocument: () => ({ nodes: api.nodes }) as unknown as CanvasDocument,
    commitDocument: vi.fn(), submitRun: vi.fn(async () => ({ status: 'error' as const })),
    waitForDocument: vi.fn(async (ready: (document: CanvasDocument) => boolean) => {
      // 模拟服务端写盘后页面重载：新节点出现在文档里。
      api.nodes = [...api.nodes, { id: 'image-ps', type: 'image', title: '海报 · 选区', position: { x: 0, y: 0 } } as unknown as CanvasNode];
      return ready({ nodes: api.nodes } as unknown as CanvasDocument);
    }),
    providers: () => [], generationDefault: () => undefined, newId: prefix => `${prefix}-1`,
  };
  return api;
}

it('registers its entries under the ids declared in the manifest', () => {
  expect(Object.keys(plugin.imageActions ?? {})).toEqual(manifest.contributes.image_actions.map(action => action.id));
  expect(Object.keys(plugin.canvasActions ?? {}).sort())
    .toEqual(manifest.contributes.canvas_actions.map(action => action.id).sort());
});

it('imports from Photoshop, moves the new image to the drop point and selects it', async () => {
  const network = respond({ '/import': ok({ node_id: 'image-ps', title: '海报 · 选区' }) });
  const api = hostApi();
  await importImage(api, { x: 320, y: 140 }, 'layer');
  expect(api.savePendingEdits).toHaveBeenCalled();
  expect(JSON.parse(String(network.mock.calls[0][1]?.body))).toEqual({ project_id: 'canvas-ps', params: { scope: 'layer' } });
  expect(api.nodes.find(node => node.id === 'image-ps')?.position).toEqual({ x: 320, y: 140 });
  expect(api.selectNode).toHaveBeenCalledWith('image-ps');
  expect(api.announce).toHaveBeenCalledWith('已从 Photoshop 取回：海报 · 选区');
  expect(api.reportError).not.toHaveBeenCalled();
});

it('shows the server sentence as is when Photoshop refuses', async () => {
  respond({ '/import': fail(409, 'Photoshop 未启动') });
  const api = hostApi();
  await importImage(api, { x: 0, y: 0 }, 'merged');
  expect(api.reportError).toHaveBeenCalledWith('Photoshop 未启动');
  expect(api.announce).not.toHaveBeenCalled();
  expect(psBridgeBusy.get()).toBe(false);
});

it('runs one request at a time and is busy while it runs', async () => {
  let release: () => void = () => undefined;
  const network = vi.fn(() => new Promise<Response>(resolve => {
    release = () => resolve(new Response(JSON.stringify({ result: { document: '海报.psd', layer: '图', returned_to_origin: true } })));
  }));
  vi.stubGlobal('fetch', network);
  const api = hostApi();
  const node = { id: 'image-1', type: 'image', title: '图' } as unknown as CanvasContentNode;
  const first = placeImage(api, node);
  await waitFor(() => expect(network).toHaveBeenCalledTimes(1));
  expect(psBridgeBusy.get()).toBe(true);
  await placeImage(api, node);
  expect(network).toHaveBeenCalledTimes(1);
  release();
  await first;
  expect(psBridgeBusy.get()).toBe(false);
  expect(api.announce).toHaveBeenCalledWith('已发到 Photoshop：海报.psd');
});

it('status area does not talk to Photoshop until asked, then shows the version', async () => {
  const bodies: unknown[] = [];
  const status = { supported: true, installed: true, running: true, responsible_app: 'Atelier', version: null, active_document: null };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: { probe: boolean } };
    bodies.push(body);
    return new Response(JSON.stringify({ result: body.params.probe
      ? { ...status, version: '26.0.0', active_document: '海报.psd' } : status }));
  }));
  render(<PsBridgeSettings />);
  expect(await screen.findByText('Photoshop 已启动')).toBeInTheDocument();
  expect(screen.getByText('授权应用 Atelier')).toBeInTheDocument();
  expect(bodies).toEqual([{ params: { probe: false } }]);
  fireEvent.click(screen.getByRole('button', { name: '检测' }));
  expect(await screen.findByText('Photoshop 26.0.0 · 海报.psd')).toBeInTheDocument();
  expect(bodies.at(-1)).toEqual({ params: { probe: true } });
});

it('status area says when Photoshop is missing or the system is unsupported', async () => {
  const base = { installed: false, running: false, responsible_app: null, version: null, active_document: null };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { ...base, supported: true } }))));
  const { unmount } = render(<PsBridgeSettings />);
  expect(await screen.findByText('未检测到 Photoshop')).toBeInTheDocument();
  unmount();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: { ...base, supported: false } }))));
  render(<PsBridgeSettings />);
  expect(await screen.findByText('当前系统暂不支持')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '检测' })).toBeDisabled();
});

it('status area shows a probe failure as one line', async () => {
  const status = { supported: true, installed: true, running: true, responsible_app: 'Atelier', version: null, active_document: null };
  const denied = '需要在「系统设置 → 隐私与安全性 → 自动化」里允许 Atelier 控制 Photoshop';
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const probe = (JSON.parse(String(init?.body)) as { params: { probe: boolean } }).params.probe;
    return probe
      ? new Response(JSON.stringify({ detail: { message: denied } }), { status: 403 })
      : new Response(JSON.stringify({ result: status }));
  }));
  render(<PsBridgeSettings />);
  await screen.findByText('Photoshop 已启动');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '检测' })); });
  expect(await screen.findByRole('alert')).toHaveTextContent(denied);
});

it('the agent script switch starts off and warns in one line once turned on', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let allowed = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: { allow_scripts?: boolean } };
    calls.push({ url, body });
    if (url.endsWith('/settings')) {
      if (typeof body.params.allow_scripts === 'boolean') allowed = body.params.allow_scripts;
      return new Response(JSON.stringify({ result: { allow_scripts: allowed } }));
    }
    return new Response(JSON.stringify({ result: { entries: [
      { at: '2026-11-19T12:00:00+00:00', caller: '外部 Agent', project_id: 'canvas-ps', document_id: 7,
        code: '\nvar d = app.activeDocument;\nreturn d.name;', ok: false, error: '找不到文档', duration_ms: 12 },
    ] } }));
  }));
  render(<PsAgentScripts />);
  const toggle = await screen.findByRole('switch', { name: '允许 Agent 执行脚本' });
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).not.toBeChecked();
  expect(screen.queryByText('脚本可以读写本机文件')).toBeNull();
  fireEvent.click(toggle);
  expect(await screen.findByText('脚本可以读写本机文件')).toBeInTheDocument();
  expect(calls.find(call => call.url.endsWith('/settings') && JSON.stringify(call.body).includes('true'))?.body)
    .toEqual({ params: { allow_scripts: true } });
  fireEvent.click(screen.getByRole('button', { name: '最近执行 1' }));
  const log = await screen.findByRole('list', { name: '最近执行' });
  expect(log).toHaveTextContent('外部 Agent');
  expect(log).toHaveTextContent('失败');
  expect(log).toHaveTextContent('var d = app.activeDocument;');
});
