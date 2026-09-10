import { StrictMode, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, Router, useLocation } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
vi.unmock('@/api/connection');
import { localConnection, connectionFetch } from '@/api/connection';
import { LocalConnectionGate } from './LocalConnectionGate';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function server(options: { occupied?: boolean } = {}) {
  const network = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/status')) return response({ service: 'game-atelier', instance_id: 'i1', app_version: '1', protocol: 'atelier-local/2' });
    if (url.endsWith('/local-session')) return response({ session_id: 's1', instance_id: 'i1', expires_at: '2099-01-01T00:00:00Z' });
    if (url.endsWith('/editor-lease')) {
      if (options.occupied && !JSON.parse(String(init.body)).takeover) return response({ error: { code: 'EDITOR_IN_USE', message: '已有编辑页面' } }, 409);
      return response({ client_id: localConnection.clientId, expires_at: '2099-01-01T00:00:00Z' });
    }
    if (url === '/api/revoked') return response({ error: { code: 'SESSION_REVOKED', message: '授权已撤销' } }, 403);
    return response({});
  });
  vi.stubGlobal('fetch', network); return network;
}
function Draft({ onMount }: { onMount: () => void }) {
  const [text, setText] = useState(''); useEffect(onMount, [onMount]);
  return <textarea aria-label="编辑草稿" value={text} onChange={event => setText(event.target.value)} />;
}
function RouteReads({ path }: { path: string }) {
  const [result, setResult] = useState('读取中');
  useEffect(() => {
    connectionFetch(path).then(response => response.json()).then(() => setResult('读取成功')).catch(error => setResult(String(error)));
  }, [path]);
  return <p>{result}</p>;
}
function RoutedPages() {
  const [location] = useLocation();
  return location === '/connection'
    ? <><RouteReads key="management" path="/api/connection/agent-grants" /><Link href="/settings">返回设置</Link></>
    : <><RouteReads key="settings" path="/api/config" /><Link href="/connection">管理授权</Link></>;
}
afterEach(() => { act(() => localConnection.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('local connection gate', () => {
  it('blocks portal edits and global paste after disconnect but permits closing the dialog', async () => {
    server(); const edit = vi.fn(); const paste = vi.fn(); const shortcut = vi.fn();
    function PortalDraft() {
      const [open, setOpen] = useState(true);
      return <Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined}>
        <DialogTitle>测试草稿</DialogTitle><button onClick={edit}>修改草稿</button>
        <input aria-label="弹窗草稿" onChange={edit} />
      </DialogContent></Dialog>;
    }
    render(<LocalConnectionGate><PortalDraft /></LocalConnectionGate>);
    await screen.findByRole('dialog');
    act(() => localConnection.pause('测试断连'));
    window.addEventListener('paste', paste);
    window.addEventListener('keydown', shortcut);
    fireEvent.click(screen.getByRole('button', { name: '修改草稿' }));
    fireEvent.change(screen.getByLabelText('弹窗草稿'), { target: { value: '不应写入' } });
    fireEvent.paste(document.body);
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(shortcut).not.toHaveBeenCalled();
    window.removeEventListener('paste', paste);
    expect(edit).not.toHaveBeenCalled(); expect(paste).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新连接' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: '重新连接' }), { key: 'z', ctrlKey: true });
    expect(shortcut).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'c', metaKey: true });
    expect(shortcut).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', shortcut);
  });

  it('recovers the first business read without remounting its component', async () => {
    const network = server();
    const original = network.getMockImplementation()!;
    let failed = false;
    network.mockImplementation(async (url, init) => {
      if (url === '/api/config' && !failed) { failed = true; throw new TypeError('offline'); }
      return original(url, init);
    });
    vi.useFakeTimers();
    render(<LocalConnectionGate><RouteReads path="/api/config" /></LocalConnectionGate>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('读取成功')).toBeInTheDocument();
    expect(network.mock.calls.filter(([url]) => url === '/api/config')).toHaveLength(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('recovers an initial JSON read interrupted after its headers arrived', async () => {
    const network = server(); const original = network.getMockImplementation()!;
    let writer: ReadableStreamDefaultController<Uint8Array> | undefined;
    let failed = false;
    network.mockImplementation(async (url, init) => {
      if (url === '/api/config' && !failed) {
        failed = true;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } }), { headers: { 'Content-Type': 'application/json' } });
      }
      return original(url, init);
    });
    render(<LocalConnectionGate><RouteReads path="/api/config" /></LocalConnectionGate>);
    await waitFor(() => expect(writer).toBeDefined());
    vi.useFakeTimers();
    await act(async () => { writer!.error(new TypeError('body interrupted')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('读取成功')).toBeInTheDocument();
    expect(network.mock.calls.filter(([url]) => url === '/api/config')).toHaveLength(2);
  });

  it('shows an inline service error at first launch without an Agent link or modal', async () => {
    vi.useFakeTimers();
    const network = server(); network.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<LocalConnectionGate><Draft onMount={vi.fn()} /></LocalConnectionGate>);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByText('暂时无法连接工坊服务')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(network.mock.calls.every(([url]) => url === '/api/connection/status')).toBe(true);
  });

  it('does not mount business components until bootstrap and lease succeed, including StrictMode', async () => {
    const network = server(); const onMount = vi.fn();
    render(<StrictMode><LocalConnectionGate><Draft onMount={onMount} /></LocalConnectionGate></StrictMode>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('编辑草稿')).not.toBeInTheDocument(); await screen.findByLabelText('编辑草稿');
    expect(network.mock.calls.some(([url]) => url.endsWith('editor-lease'))).toBe(true); expect(localConnection.getSnapshot().phase).toBe('ready');
  });
  it('preserves mounted drafts when revoked and blocks editing without a modal', async () => {
    server(); const onMount = vi.fn(); render(<LocalConnectionGate><Draft onMount={onMount} /></LocalConnectionGate>);
    const editor = await screen.findByLabelText('编辑草稿'); fireEvent.change(editor, { target: { value: '尚未保存的手稿' } });
    await act(async () => { await connectionFetch('/api/revoked'); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('授权已撤销')).toBeInTheDocument();
    expect(editor).toHaveValue('尚未保存的手稿'); expect(onMount).toHaveBeenCalledTimes(1);
    expect(editor).toBeDisabled();
  });
  it('automatically recovers a brief outage without a modal or remounting the draft', async () => {
    const network = server(); render(<LocalConnectionGate><Draft onMount={vi.fn()} /></LocalConnectionGate>);
    const editor = await screen.findByLabelText('编辑草稿'); fireEvent.change(editor, { target: { value: '尚未保存的手稿' } });
    vi.useFakeTimers();
    network.mockRejectedValue(new TypeError('Failed to fetch'));
    await act(async () => { await connectionFetch('/api/config', { method: 'PUT' }).catch(() => {}); });
    expect(screen.getByText('正在恢复工坊连接…')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(editor).toHaveValue('尚未保存的手稿');
    server();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(localConnection.getSnapshot().phase).toBe('ready');
    expect(editor).not.toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByText('本机连接已暂停')).not.toBeInTheDocument();
  });
  it('warns about unsaved content before an explicit takeover', async () => {
    const network = server({ occupied: true }); const onMount = vi.fn(); render(<LocalConnectionGate><Draft onMount={onMount} /></LocalConnectionGate>);
    await screen.findByText('只读 · 另一页面正在编辑');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(network.mock.calls.some(([, init]) => init.body && JSON.parse(String(init.body)).takeover === true)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '接管编辑' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('可能仍有未保存的内容');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '接管编辑' }));
    await waitFor(() => expect(screen.getByLabelText('编辑草稿')).not.toBeDisabled());
    expect(network.mock.calls.some(([url, init]) => url.endsWith('editor-lease') && JSON.parse(String(init.body)).takeover === true)).toBe(true);
  });
  it('lets a second tab view without a lease and keeps mounted state when it later takes over', async () => {
    const network = server({ occupied: true }); const onMount = vi.fn(); render(<LocalConnectionGate><Draft onMount={onMount} /></LocalConnectionGate>);
    const editor = await screen.findByLabelText('编辑草稿');
    expect(localConnection.getSnapshot()).toMatchObject({ phase: 'ready', editing: false });
    expect(network.mock.calls.filter(([url]) => url.endsWith('editor-lease'))).toHaveLength(1);
    expect(screen.getByText('只读 · 另一页面正在编辑')).toBeInTheDocument();
    expect(editor).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '接管编辑' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '接管编辑' }));
    await waitFor(() => expect(localConnection.getSnapshot()).toMatchObject({ phase: 'ready', editing: true }));
    // 重新拿到编辑权不重挂载：草稿留着，业务组件只挂载过一次。
    expect(screen.getByLabelText('编辑草稿')).toHaveValue(''); expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('只读 · 另一页面正在编辑')).not.toBeInTheDocument();
  });
  it('opens authorization management without stealing the editor lease', async () => {
    const network = server(); const onMount = vi.fn(); const { hook } = memoryLocation({ path: '/connection' });
    render(<Router hook={hook}><LocalConnectionGate><Draft onMount={onMount} /></LocalConnectionGate></Router>);
    await waitFor(() => expect(onMount).toHaveBeenCalled()); expect(network.mock.calls.some(([url]) => url.endsWith('editor-lease'))).toBe(false);
  });

  it('does not replay retained drafts when restored from the browser history cache', async () => {
    server(); const onMount = vi.fn(); render(<LocalConnectionGate><Draft onMount={onMount} /></LocalConnectionGate>);
    const editor = await screen.findByLabelText('编辑草稿'); fireEvent.change(editor, { target: { value: '历史中的手稿' } });
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/页面已从历史恢复/)).toBeInTheDocument();
    expect(editor).toHaveValue('历史中的手稿'); expect(onMount).toHaveBeenCalledTimes(1);
  });

  it('waits for the mode transition before a newly mounted route reads data in either direction', async () => {
    const network = server();
    const { hook } = memoryLocation({ path: '/settings' });
    render(<Router hook={hook}><LocalConnectionGate><RoutedPages /></LocalConnectionGate></Router>);
    await screen.findByText('读取成功');
    fireEvent.click(screen.getByRole('link', { name: '管理授权' }));
    await screen.findByRole('link', { name: '返回设置' });
    await screen.findByText('读取成功');
    expect(localConnection.getSnapshot()).toMatchObject({ phase: 'ready', editing: false });
    expect(network.mock.calls.filter(([url]) => url === '/api/connection/agent-grants')).toHaveLength(1);
    fireEvent.click(screen.getByRole('link', { name: '返回设置' }));
    await screen.findByRole('link', { name: '管理授权' }); await screen.findByText('读取成功');
    expect(localConnection.getSnapshot()).toMatchObject({ phase: 'ready', editing: true });
  });
});

describe('hosted pairing form', () => {
  const BASE = 'http://127.0.0.1:5174';
  function hostedServer() {
    const network = vi.fn(async (url: string, init: RequestInit) => {
      if (url === `${BASE}/api/connection/status`) return response({ service: 'game-atelier', instance_id: 'i1', app_version: '1', protocol: 'atelier-local/2' });
      if (url === `${BASE}/api/connection/pair`) return response({ session_token: 'tok-1', session_id: 's1', instance_id: 'i1', expires_at: '2099-01-01T00:00:00Z', capabilities: ['edit', 'read'] });
      if (url === `${BASE}/api/connection/editor-lease`) return response({ client_id: JSON.parse(String(init.body)).client_id, expires_at: '2099-01-01T00:00:00Z' });
      if (url === `${BASE}/api/connection/media-token`) return response({ media_token: 'media-1', expires_at: '2099-01-01T00:00:00Z' });
      return response({});
    });
    vi.stubGlobal('fetch', network); return network;
  }
  afterEach(() => { Object.defineProperty(localConnection, 'hosted', { value: false, configurable: true }); sessionStorage.clear(); });

  it('asks for a port and code, links to the local pairing page and mounts the app after pairing', async () => {
    Object.defineProperty(localConnection, 'hosted', { value: true, configurable: true });
    const network = hostedServer(); const onMount = vi.fn();
    render(<LocalConnectionGate><Draft onMount={onMount} /></LocalConnectionGate>);
    await screen.findByRole('heading', { name: '连接本机工坊' });
    expect(network).not.toHaveBeenCalled(); expect(onMount).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '本机连接页' })).toHaveAttribute('href', `${BASE}/connection?site=${encodeURIComponent(window.location.origin)}`);
    const code = screen.getByLabelText('配对码');
    const typed = vi.fn(); code.addEventListener('keydown', typed);
    fireEvent.keyDown(code, { key: 'a' });
    expect(typed).toHaveBeenCalledTimes(1);
    fireEvent.change(code, { target: { value: 'code-1' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    await screen.findByLabelText('编辑草稿');
    expect(JSON.parse(String(network.mock.calls.find(([url]) => url.endsWith('/pair'))![1].body))).toEqual({ pairing_code: 'code-1', instance_id: 'i1' });
    expect(localConnection.getSnapshot()).toMatchObject({ phase: 'ready', target: BASE });
    expect(sessionStorage.getItem('atelier-site-port')).toBe('5174');
  });

  it('shows the pairing error inline and stays on the form', async () => {
    Object.defineProperty(localConnection, 'hosted', { value: true, configurable: true });
    const network = hostedServer();
    network.mockImplementation(async () => response({ error: { code: 'ORIGIN_DENIED', message: '此来源尚未获准连接本机' } }, 403));
    render(<LocalConnectionGate><Draft onMount={vi.fn()} /></LocalConnectionGate>);
    fireEvent.change(await screen.findByLabelText('配对码'), { target: { value: 'code-1' } });
    fireEvent.click(screen.getByRole('button', { name: '连接' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('本机尚未为这个网站生成配对码');
    expect(screen.getByLabelText('配对码')).toHaveValue('code-1');
    expect(localConnection.getSnapshot().phase).toBe('unpaired');
  });
});
