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
    if (url === '/api/connection/status') return json({ service: 'game-atelier', instance_id: 'i1', app_version: '1', protocol: 'atelier-local/2' });
    if (url === '/api/connection/local-session') return json({ session_id: 's1', instance_id: 'i1', expires_at: '2099-01-01T00:00:00Z' });
    if (url === '/api/connection/editor-lease') return json({ client_id: JSON.parse(String(init.body)).client_id, expires_at: '2099-01-01T00:00:00Z' });
    return json({ ok: true });
  });
  vi.stubGlobal('fetch', mocked);
  return mocked;
}
afterEach(() => { clients.splice(0).forEach(item => item.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('local connection', () => {
  it.each(['60', new Date(Date.now() + 60_000).toUTCString()])('honors Retry-After %s before reconnecting', async retryAfter => {
    vi.useFakeTimers();
    const network = server(() => new Response('{}', { status: 429, headers: { 'Retry-After': retryAfter } }));
    const connection = client(); await connection.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(network).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('recovers a handshake whose body fails after successful headers', async () => {
    vi.useFakeTimers(); let broken = true;
    const network = server(url => url.endsWith('/status') && broken ? new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('network interrupted')); },
    })) : undefined);
    const connection = client(); await connection.start();
    expect(connection.getSnapshot().recovering).toBe(true);
    broken = false; await vi.advanceTimersByTimeAsync(1000);
    expect(connection.getSnapshot().phase).toBe('ready');
    expect(network.mock.calls.filter(([url]) => url.endsWith('/status'))).toHaveLength(2);
  });

  it('retries a failed initial read once after recovery, without replaying it indefinitely', async () => {
    vi.useFakeTimers(); let broken = true;
    const network = server(url => { if (url === '/api/projects' && broken) throw new TypeError('offline'); return undefined; });
    const connection = client(); await connection.start();
    const read = connection.fetch('/api/projects');
    await vi.advanceTimersByTimeAsync(1);
    broken = false; await vi.advanceTimersByTimeAsync(1000);
    expect(await (await read).json()).toEqual({ ok: true });
    expect(network.mock.calls.filter(([url]) => url === '/api/projects')).toHaveLength(2);
    broken = true;
    const failedRead = expect(connection.fetch('/api/projects')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1001); await failedRead;
    expect(network.mock.calls.filter(([url]) => url === '/api/projects')).toHaveLength(4);
  });

  it.each(['abort', 'dispose'])('cancels a pending recovery read on %s', async action => {
    vi.useFakeTimers();
    const network = server(url => { if (url === '/api/projects') throw new TypeError('offline'); return undefined; });
    const connection = client(); await connection.start();
    const controller = new AbortController();
    const read = expect(connection.fetch('/api/projects', { signal: controller.signal })).rejects.toBeInstanceOf(ConnectionInterrupted);
    await vi.advanceTimersByTimeAsync(1);
    if (action === 'abort') controller.abort(); else connection.dispose();
    await read; await vi.advanceTimersByTimeAsync(1000);
    expect(network.mock.calls.filter(([url]) => url === '/api/projects')).toHaveLength(1);
  });

  it('times out a stalled handshake and makes a bounded automatic retry', async () => {
    vi.useFakeTimers();
    const network = server((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const connection = client(); const pending = connection.start();
    await vi.advanceTimersByTimeAsync(8000); await pending;
    expect(connection.getSnapshot()).toMatchObject({ phase: 'interrupted', recovering: true, message: '工坊服务响应超时。' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it.each(['ORIGIN_DENIED', 'HOST_DENIED', 'SESSION_REVOKED', 'PROTOCOL_MISMATCH'])('does not automatically retry %s', async code => {
    vi.useFakeTimers();
    const network = server(() => json({ error: { code, message: '需要人工处理' } }, 403));
    const connection = client(); await connection.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(network).toHaveBeenCalledTimes(1);
    expect(connection.getSnapshot()).toMatchObject({ phase: 'interrupted', recovering: false });
  });

  it('requires an explicit reconnect if the server restarted during automatic recovery', async () => {
    vi.useFakeTimers(); let offline = false; let instance = 'i1';
    server(url => {
      if (offline) throw new TypeError('Failed to fetch');
      if (url.endsWith('/status')) return json({ service: 'game-atelier', instance_id: instance, protocol: 'atelier-local/2' });
      if (url.endsWith('/local-session')) return json({ session_id: 's1', instance_id: instance });
    });
    const connection = client(); await connection.start(); offline = true;
    await expect(connection.fetch('/api/save', { method: 'PUT' })).rejects.toThrow();
    offline = false; instance = 'i2'; await vi.advanceTimersByTimeAsync(1000);
    expect(connection.getSnapshot()).toMatchObject({ phase: 'interrupted', recovering: false, message: expect.stringContaining('已重启') });
    await connection.start(); expect(connection.getSnapshot().phase).toBe('ready');
  });

  it('renews an expired local session without replaying writes', async () => {
    vi.useFakeTimers();
    const network = server(url => url === '/api/save' ? json({ error: { code: 'SESSION_EXPIRED' } }, 401) : undefined);
    const connection = client(); await connection.start();
    await connection.fetch('/api/save', { method: 'PUT' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.getSnapshot().phase).toBe('ready');
    expect(network.mock.calls.filter(([url]) => url === '/api/save')).toHaveLength(1);
  });

  it('recovers a transient disconnect without replaying the failed mutation', async () => {
    vi.useFakeTimers();
    let offline = false;
    const network = server(() => { if (offline) throw new TypeError('Failed to fetch'); return undefined; });
    const connection = client(); await connection.start(); offline = true;
    await expect(connection.fetch('/api/generate', { method: 'POST' })).rejects.toThrow();
    offline = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(connection.getSnapshot().phase).toBe('ready');
    expect(network.mock.calls.filter(([url]) => url === '/api/generate')).toHaveLength(1);
  });

  it('stops after three automatic retries and cancels scheduled retries on disposal', async () => {
    vi.useFakeTimers();
    const network = server(() => { throw new TypeError('Failed to fetch'); });
    const connection = client(); await connection.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(network).toHaveBeenCalledTimes(4);
    expect(connection.getSnapshot().phase).toBe('interrupted');
    await connection.start();
    connection.dispose();
    const count = network.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(network).toHaveBeenCalledTimes(count);
  });

  it('refuses business writes while connected without an editor lease but allows authorization management', async () => {
    const network = server(); const connection = client(); await connection.start({ editing: false });
    await expect(connection.fetch('/api/generate', { method: 'POST' })).rejects.toBeInstanceOf(ConnectionInterrupted);
    await connection.fetch('/api/connection/agent-grants', { method: 'POST' });
    expect(network.mock.calls.some(([url]) => url === '/api/generate')).toBe(false);
  });

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
    resume(json({ service: 'game-atelier', instance_id: 'i1', protocol: 'atelier-local/2' }));
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
    resume(json({ service: 'game-atelier', instance_id: 'i1', protocol: 'atelier-local/2' }));
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

describe('hosted site connection', () => {
  const BASE = 'http://127.0.0.1:5174';
  const status = { service: 'game-atelier', instance_id: 'i1', app_version: '1', protocol: 'atelier-local/2' };
  const link = { base: BASE, token: 'tok-stored', sessionId: 's-stored', instanceId: 'i1', expiresAt: '2099-01-01T00:00:00Z' };
  function hostedServer(overrides?: (url: string, init: RequestInit) => Response | undefined) {
    const mocked = vi.fn(async (url: string, init: RequestInit) => {
      const response = overrides?.(url, init);
      if (response) return response;
      if (url === `${BASE}/api/connection/status`) return json(status);
      if (url === `${BASE}/api/connection/pair`) return json({ session_token: 'tok-1', session_id: 's1', instance_id: 'i1', expires_at: '2099-01-01T00:00:00Z', capabilities: ['edit', 'read'] });
      if (url === `${BASE}/api/connection/editor-lease`) return json({ client_id: JSON.parse(String(init.body)).client_id, expires_at: '2099-01-01T00:00:00Z' });
      if (url === `${BASE}/api/connection/media-token`) return json({ media_token: 'media-1', expires_at: '2099-01-01T00:00:00Z' });
      return json({ ok: true });
    });
    vi.stubGlobal('fetch', mocked);
    return mocked;
  }
  function hosted() { const value = new LocalConnection({ hosted: true }); clients.push(value); return value; }
  afterEach(() => { sessionStorage.clear(); });

  it('starts unpaired, pairs with a one-time code and then talks to the loopback base with a bearer token', async () => {
    const network = hostedServer();
    const connection = hosted();
    await connection.start();
    expect(connection.getSnapshot()).toMatchObject({ phase: 'unpaired', target: null });
    expect(network).not.toHaveBeenCalled();
    await connection.pair({ port: '5174', code: ' code-1 ' });
    expect(connection.getSnapshot()).toMatchObject({ phase: 'ready', editing: true, target: BASE });
    const pairCall = network.mock.calls.find(([url]) => url === `${BASE}/api/connection/pair`)!;
    expect(JSON.parse(String(pairCall[1].body))).toEqual({ pairing_code: 'code-1', instance_id: 'i1' });
    expect(pairCall[1].credentials).toBe('omit');
    expect(network.mock.calls.some(([url]) => url.endsWith('/local-session'))).toBe(false);
    await connection.fetch('/api/projects');
    const read = network.mock.calls.find(([url]) => url === `${BASE}/api/projects`)!;
    expect(new Headers(read[1].headers).get('Authorization')).toBe('Bearer tok-1');
    expect(read[1].credentials).toBe('omit');
    expect(connection.mediaUrl('/api/raw?path=a')).toBe(`${BASE}/api/raw?path=a&media_token=media-1`);
    expect(connection.mediaUrl('/api/canvas/projects/p/versions/v/media')).toBe(`${BASE}/api/canvas/projects/p/versions/v/media?media_token=media-1`);
    expect(JSON.parse(sessionStorage.getItem('atelier-site-link')!)).toMatchObject({ base: BASE, token: 'tok-1', sessionId: 's1', instanceId: 'i1' });
  });

  it('restores a stored link without pairing again and returns to pairing once the session is revoked', async () => {
    const network = hostedServer(url => url === `${BASE}/api/revoked` ? json({ error: { code: 'SESSION_REVOKED', message: '连接已被本机断开' } }, 403) : undefined);
    sessionStorage.setItem('atelier-site-link', JSON.stringify(link));
    const connection = hosted();
    await connection.start();
    expect(connection.getSnapshot()).toMatchObject({ phase: 'ready', target: BASE });
    expect(network.mock.calls.some(([url]) => url.endsWith('/pair'))).toBe(false);
    expect(new Headers(network.mock.calls.find(([url]) => url.endsWith('/editor-lease'))![1].headers).get('Authorization')).toBe('Bearer tok-stored');
    await connection.fetch('/api/revoked').catch(() => {});
    expect(connection.getSnapshot()).toMatchObject({ phase: 'unpaired', message: '连接已被本机断开', recovering: false, target: null });
    expect(sessionStorage.getItem('atelier-site-link')).toBeNull();
    expect(connection.mediaUrl('/api/raw?path=a')).toBe('/api/raw?path=a');
  });

  it('drops a stored link when the local server restarted under a new instance', async () => {
    hostedServer();
    sessionStorage.setItem('atelier-site-link', JSON.stringify({ ...link, instanceId: 'old-instance' }));
    const connection = hosted();
    await connection.start();
    expect(connection.getSnapshot()).toMatchObject({ phase: 'unpaired' });
    expect(connection.getSnapshot().message).toMatch(/重新生成配对码/);
    expect(sessionStorage.getItem('atelier-site-link')).toBeNull();
  });

  it('explains pairing failures without entering the recovery loop', async () => {
    let scenario: 'unregistered' | 'old' | 'wrong-code' = 'unregistered';
    hostedServer((url) => {
      if (url.endsWith('/status')) {
        if (scenario === 'unregistered') return json({ error: { code: 'ORIGIN_DENIED', message: '此来源尚未获准连接本机' } }, 403);
        if (scenario === 'old') return json({ ...status, protocol: 'atelier-local/1' });
      }
      if (url.endsWith('/pair') && scenario === 'wrong-code') return json({ error: { code: 'SESSION_REVOKED', message: '配对码无效或已过期，请在本机重新生成' } }, 403);
      return undefined;
    });
    const connection = hosted();
    await connection.start();
    await expect(connection.pair({ port: 5174, code: 'x' })).rejects.toThrow(/生成配对码/);
    scenario = 'old';
    await expect(connection.pair({ port: 5174, code: 'x' })).rejects.toThrow(/版本过旧/);
    scenario = 'wrong-code';
    await expect(connection.pair({ port: 5174, code: 'x' })).rejects.toThrow('配对码无效或已过期，请在本机重新生成');
    await expect(connection.pair({ port: 'abc', code: 'x' })).rejects.toThrow(/端口/);
    await expect(connection.pair({ port: 5174, code: '   ' })).rejects.toThrow(/配对码/);
    expect(connection.getSnapshot()).toMatchObject({ phase: 'unpaired', recovering: false });
    expect(sessionStorage.getItem('atelier-site-link')).toBeNull();
  });

  it('disconnect revokes its own session and clears the stored link', async () => {
    const network = hostedServer(url => url === `${BASE}/api/connection/sessions/s-stored` ? new Response(null, { status: 204 }) : undefined);
    sessionStorage.setItem('atelier-site-link', JSON.stringify(link));
    const connection = hosted();
    await connection.start();
    await connection.disconnect();
    const revoke = network.mock.calls.find(([url]) => url === `${BASE}/api/connection/sessions/s-stored`)!;
    expect(revoke[1].method).toBe('DELETE');
    expect(new Headers(revoke[1].headers).get('Authorization')).toBe('Bearer tok-stored');
    expect(connection.getSnapshot()).toMatchObject({ phase: 'unpaired', target: null });
    expect(sessionStorage.getItem('atelier-site-link')).toBeNull();
  });

  it('keeps relative media URLs and cookies on the local page', async () => {
    const network = server();
    const connection = client(); await connection.start();
    expect(connection.mediaUrl('/api/raw?path=a')).toBe('/api/raw?path=a');
    expect(network.mock.calls.every(([, init]) => init.credentials === 'same-origin')).toBe(true);
    expect(network.mock.calls.some(([url]) => url.endsWith('/media-token'))).toBe(false);
  });
});
