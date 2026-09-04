import { StrictMode, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, Router, useLocation } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
vi.unmock('@/api/connection');
import { localConnection, connectionFetch } from '@/api/connection';
import { LocalConnectionGate } from './LocalConnectionGate';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function server(options: { occupied?: boolean } = {}) {
  const network = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/status')) return response({ service: 'game-atelier', instance_id: 'i1', app_version: '1', protocol: 'atelier-local/1' });
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
afterEach(() => { act(() => localConnection.dispose()); vi.unstubAllGlobals(); });

describe('local connection gate', () => {
  it('does not mount business components until bootstrap and lease succeed, including StrictMode', async () => {
    const network = server(); const onMount = vi.fn();
    render(<StrictMode><LocalConnectionGate><Draft onMount={onMount} /></LocalConnectionGate></StrictMode>);
    expect(screen.queryByLabelText('编辑草稿')).not.toBeInTheDocument(); await screen.findByLabelText('编辑草稿');
    expect(network.mock.calls.some(([url]) => url.endsWith('editor-lease'))).toBe(true); expect(localConnection.getSnapshot().phase).toBe('ready');
  });
  it('preserves mounted drafts when revoked and blocks editing with a modal', async () => {
    server(); const onMount = vi.fn(); render(<LocalConnectionGate><Draft onMount={onMount} /></LocalConnectionGate>);
    const editor = await screen.findByLabelText('编辑草稿'); fireEvent.change(editor, { target: { value: '尚未保存的手稿' } });
    await act(async () => { await connectionFetch('/api/revoked'); });
    expect(screen.getByRole('dialog')).toHaveTextContent('授权已撤销'); expect(editor).toHaveValue('尚未保存的手稿'); expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });
  it('lets the user dismiss the pause dialog, keep the page and reconnect later', async () => {
    const network = server(); render(<LocalConnectionGate><Draft onMount={vi.fn()} /></LocalConnectionGate>);
    const editor = await screen.findByLabelText('编辑草稿'); fireEvent.change(editor, { target: { value: '尚未保存的手稿' } });
    network.mockRejectedValue(new TypeError('Failed to fetch'));
    await act(async () => { await connectionFetch('/api/config').catch(() => {}); });
    expect(screen.getByRole('dialog')).toHaveTextContent('本机连接已暂停');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(editor).toHaveValue('尚未保存的手稿');
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    await screen.findByRole('dialog'); expect(screen.getByRole('dialog')).toHaveTextContent('本机连接已暂停');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    server();
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }));
    await waitFor(() => expect(localConnection.getSnapshot().phase).toBe('ready'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByText('本机连接已暂停')).not.toBeInTheDocument();
  });
  it('warns about unsaved content before an explicit takeover', async () => {
    const network = server({ occupied: true }); const onMount = vi.fn(); render(<LocalConnectionGate><Draft onMount={onMount} /></LocalConnectionGate>);
    await screen.findByText('另一个页面正在编辑'); expect(onMount).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toHaveTextContent('可能仍有未保存的内容');
    fireEvent.click(screen.getByRole('button', { name: '接管并加载' })); await screen.findByLabelText('编辑草稿');
    expect(network.mock.calls.some(([url, init]) => url.endsWith('editor-lease') && JSON.parse(String(init.body)).takeover === true)).toBe(true);
  });
  it('lets a second tab view without a lease and keeps mounted state when it later takes over', async () => {
    const network = server({ occupied: true }); const onMount = vi.fn(); render(<LocalConnectionGate><Draft onMount={onMount} /></LocalConnectionGate>);
    await screen.findByText('另一个页面正在编辑');
    fireEvent.click(screen.getByRole('button', { name: '只查看' }));
    const editor = await screen.findByLabelText('编辑草稿');
    expect(localConnection.getSnapshot()).toMatchObject({ phase: 'ready', editing: false });
    expect(network.mock.calls.filter(([url]) => url.endsWith('editor-lease'))).toHaveLength(1);
    expect(screen.getByText('只读 · 另一页面正在编辑')).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: '只读时写下的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '接管编辑' }));
    await waitFor(() => expect(localConnection.getSnapshot()).toMatchObject({ phase: 'ready', editing: true }));
    // 重新拿到编辑权不重挂载：草稿留着，业务组件只挂载过一次。
    expect(screen.getByLabelText('编辑草稿')).toHaveValue('只读时写下的草稿'); expect(onMount).toHaveBeenCalledTimes(1);
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
    expect(screen.getByRole('dialog')).toHaveTextContent('页面已从历史恢复');
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
