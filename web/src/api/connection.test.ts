import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('@/api/connection');
import { ConnectionInterrupted, LocalConnection } from './connection';

const clients: LocalConnection[] = [];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function client() { const value = new LocalConnection(); clients.push(value); return value; }
function server(overrides?: (url: string, init: RequestInit) => Response | Promise<Response> | undefined) {
  const mocked = vi.fn(async (url: string, init: RequestInit) => {
    const response = overrides?.(url, init);
    if (response) return response;
    if (url === '/api/connection/status') return json({ service: 'game-atelier', instance_id: 'i1', app_version: '1', protocol: 'atelier-local/1' });
    if (url === '/api/connection/local-session') return json({ session_id: 's1', instance_id: 'i1', expires_at: '2099-01-01T00:00:00Z' });
    if (url === '/api/connection/editor-lease') return json({ client_id: JSON.parse(String(init.body)).client_id, expires_at: '2099-01-01T00:00:00Z' });
    return json({ ok: true });
  });
  vi.stubGlobal('fetch', mocked);
  return mocked;
}
afterEach(() => { clients.splice(0).forEach(item => item.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('local connection', () => {
  it('does not make business requests before the local session is ready', async () => {
    const network = server();
    await expect(client().fetch('/api/projects')).rejects.toBeInstanceOf(ConnectionInterrupted);
    expect(network).not.toHaveBeenCalled();
  });

  it('shares simultaneous bootstrap and establishes the editor lease before business reads', async () => {
    const network = server(); const connection = client();
    const first = connection.start(); expect(connection.start()).toBe(first); await first;
    await (await connection.fetch('/api/projects')).json();
    expect(network.mock.calls.map(([url]) => url)).toEqual(['/api/connection/status', '/api/connection/local-session', '/api/connection/editor-lease', '/api/projects']);
    expect(connection.getSnapshot().phase).toBe('ready');
    expect(network.mock.calls[1][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error', body: '{}' });
  });

  it('gives each page a distinct in-memory client ID and does not persist a credential', async () => {
    server(); const first = client(); const second = client();
    await first.start(); await second.start({ editing: false });
    expect(first.clientId).not.toBe(second.clientId);
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });

  it('does not acquire an editor lease for local authorization management', async () => {
    const network = server(); await client().start({ editing: false });
    expect(network.mock.calls.map(([url]) => url)).not.toContain('/api/connection/editor-lease');
  });

  it('releases an existing lease on entering management and accepts its empty 204 response', async () => {
    const network = server((url, init) => url.endsWith('editor-lease') && init.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined);
    const connection = client(); await connection.start(); await connection.start({ editing: false });
    expect(connection.getSnapshot()).toMatchObject({ phase: 'ready', editing: false });
    expect(network.mock.calls.filter(([url, init]) => url.endsWith('editor-lease') && init.method === 'DELETE')).toHaveLength(1);
  });

  it('does not reconstruct null-body statuses even if a browser wrapper exposes an empty stream', async () => {
    const wrapped = new Response('');
    Object.defineProperty(wrapped, 'status', { value: 204 });
    expect(wrapped.body).not.toBeNull();
    server((url, init) => url.endsWith('editor-lease') && init.method === 'DELETE' ? wrapped : undefined);
    const connection = client(); await connection.start(); await connection.start({ editing: false });
    expect(connection.getSnapshot()).toMatchObject({ phase: 'ready', editing: false });
  });

  it('serializes a route changing back to editing during a pending management handshake', async () => {
    let resume!: (response: Response) => void;
    let delay = false;
    const network = server(url => {
      if (url.endsWith('/status') && delay) {
        delay = false;
        return new Promise<Response>(resolve => { resume = resolve; });
      }
    });
    const connection = client(); await connection.start(); delay = true;
    const management = connection.start({ editing: false });
    await vi.waitFor(() => expect(resume).toBeDefined());
    const editing = connection.start({ editing: true });
    const read = connection.fetch('/api/config');
    resume(json({ service: 'game-atelier', instance_id: 'i1', protocol: 'atelier-local/1' }));
    await management; await editing; await (await read).json();
    expect(connection.getSnapshot()).toMatchObject({ phase: 'ready', editing: true });
    expect(network.mock.calls.filter(([url, init]) => url.endsWith('editor-lease') && init.method === 'POST')).toHaveLength(2);
    expect(network.mock.calls.at(-1)![0]).toBe('/api/config');
  });

  it('keeps only the latest explicit mode when navigation changes again during a handshake', async () => {
    let resume!: (response: Response) => void;
    const network = server(url => url.endsWith('/status') ? new Promise<Response>(resolve => { resume = resolve; }) : undefined);
    const connection = client();
    const first = connection.start({ editing: false });
    const second = connection.start({ editing: true });
    expect(connection.start({ editing: false })).toBe(first);
    resume(json({ service: 'game-atelier', instance_id: 'i1', protocol: 'atelier-local/1' }));
    await first; await second;
    expect(connection.getSnapshot()).toMatchObject({ phase: 'ready', editing: false });
    expect(network.mock.calls.some(([url]) => url.endsWith('editor-lease'))).toBe(false);
  });

  it('adds the page ID to mutations while preserving multipart and using cookies, not bearer URLs', async () => {
    const network = server(); const connection = client(); await connection.start();
    const body = new FormData(); body.set('file', new Blob(['test']), 'test.txt');
    await (await connection.fetch('/api/upload', { method: 'POST', body })).json();
    const init = network.mock.calls.at(-1)![1];
    expect(init.body).toBe(body);
    expect(new Headers(init.headers).get('Content-Type')).toBeNull();
    expect(new Headers(init.headers).get('X-Atelier-Client')).toBe(connection.clientId);
    await (await connection.fetch('/api/delete', { method: 'DELETE' })).json();
    expect(new Headers(network.mock.calls.at(-1)![1].headers).get('Content-Type')).toBe('application/json');
  });

  it('requires explicit takeover and does not silently retry a conflicting lease', async () => {
    const network = server((url, init) => url.endsWith('editor-lease') && !JSON.parse(String(init.body)).takeover ? json({ error: { code: 'EDITOR_IN_USE', message: '另一个页面正在编辑' } }, 409) : undefined);
    const connection = client(); await connection.start();
    expect(connection.getSnapshot().phase).toBe('editor_in_use');
    expect(network.mock.calls.filter(([url]) => url.endsWith('editor-lease'))).toHaveLength(1);
    await expect(connection.fetch('/api/projects')).rejects.toBeInstanceOf(ConnectionInterrupted);
    await connection.start({ takeover: true }); expect(connection.getSnapshot().phase).toBe('ready');
  });

  it('renews at ten seconds, stops on revoke and rejects further background reads', async () => {
    vi.useFakeTimers(); let revoke = false;
    const network = server(url => revoke && url.endsWith('editor-lease') ? json({ error: { code: 'SESSION_REVOKED', message: '会话已撤销' } }, 403) : undefined);
    const connection = client(); await connection.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(network.mock.calls.filter(([url]) => url.endsWith('editor-lease'))).toHaveLength(2);
    revoke = true; await vi.advanceTimersByTimeAsync(10_000);
    expect(connection.getSnapshot()).toMatchObject({ phase: 'interrupted', message: '会话已撤销' });
    const count = network.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(connection.fetch('/api/projects')).rejects.toBeInstanceOf(ConnectionInterrupted);
    expect(network).toHaveBeenCalledTimes(count);
  });

  it('aborts pending bodies and discards responses from the old connection generation', async () => {
    let complete!: (value: Response) => void;
    const network = server(url => url === '/api/slow' ? new Promise<Response>(resolve => { complete = resolve; }) : undefined);
    const connection = client(); await connection.start();
    const pending = connection.fetch('/api/slow');
    const signal = network.mock.calls.at(-1)![1].signal!;
    connection.dispose(); expect(signal.aborted).toBe(true);
    complete(json({ stale: true })); await expect(pending).rejects.toBeInstanceOf(ConnectionInterrupted);
  });

  it('fails closed for changed instances and refuses external credential destinations', async () => {
    server(url => url.endsWith('local-session') ? json({ session_id: 's1', instance_id: 'other' }) : undefined);
    const connection = client(); await connection.start();
    expect(connection.getSnapshot().phase).toBe('interrupted');
    await expect(connection.fetch('https://outside.example/api')).rejects.toThrow('只允许访问当前本机服务');
  });

  it('refuses an old discovery-only server without falling back to anonymous business APIs', async () => {
    const network = server(url => url.endsWith('/status') ? json({ service: 'game-atelier', instance_id: 'i1', protocol: null }) : undefined);
    const connection = client(); await connection.start();
    expect(connection.getSnapshot()).toMatchObject({ phase: 'interrupted', message: expect.stringContaining('版本不匹配') });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('rejects a body that finishes after the connection generation was paused', async () => {
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    server(url => url === '/api/body' ? new Response(new ReadableStream<Uint8Array>({
      start(output) { writer = output; output.enqueue(new TextEncoder().encode('{"stale":')); },
    })) : undefined);
    const connection = client(); await connection.start();
    const response = await connection.fetch('/api/body');
    const body = response.json();
    connection.pause('连接已更换');
    writer.enqueue(new TextEncoder().encode('true}')); writer.close();
    await expect(body).rejects.toBeInstanceOf(ConnectionInterrupted);
  });
});
