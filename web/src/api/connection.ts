import { useSyncExternalStore } from 'react';

export interface ConnectionSnapshot {
  phase: 'idle' | 'connecting' | 'ready' | 'interrupted' | 'editor_in_use';
  generation: number;
  editing: boolean;
  message: string | null;
  recovering?: boolean;
}

export class ConnectionInterrupted extends Error {
  constructor(message = '本机连接已暂停，请重新连接。') {
    super(message);
    this.name = 'ConnectionInterrupted';
  }
}

const CONNECTION_ERRORS = new Set([
  'CONNECTION_REQUIRED', 'SESSION_EXPIRED', 'SESSION_REVOKED', 'INSTANCE_CHANGED',
  'EDITOR_IN_USE', 'ORIGIN_DENIED', 'HOST_DENIED', 'PROTOCOL_MISMATCH',
]);

/** A page owns its client ID. Shared cookies never imply a shared editor lease. */
export class LocalConnection {
  readonly clientId = crypto.randomUUID();
  private snapshot: ConnectionSnapshot = { phase: 'idle', generation: 0, editing: false, message: null };
  private listeners = new Set<() => void>();
  private controllers = new Set<AbortController>();
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | null = null;
  private requestedEditing = false;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryAttempts = 0;
  private instanceId: string | null = null;

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<ConnectionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }

  private invalidate() {
    clearTimeout(this.heartbeat);
    clearTimeout(this.recoveryTimer);
    this.controllers.forEach(controller => controller.abort());
    this.controllers.clear();
    this.snapshot = { ...this.snapshot, generation: this.snapshot.generation + 1 };
  }

  private interrupt(message: string, code?: string, retryable = false, retryAfterMs = 0) {
    this.invalidate();
    const recovering = retryable && this.recoveryAttempts < 3;
    this.publish({ phase: code === 'EDITOR_IN_USE' ? 'editor_in_use' : 'interrupted', message, recovering });
    if (recovering) {
      const delay = Math.max(1000 * 2 ** this.recoveryAttempts++, retryAfterMs);
      this.recoveryTimer = setTimeout(() => {
        void this.start({ editing: this.requestedEditing, recoveryAttempt: true });
      }, delay);
    }
  }

  private async inspect(response: Response) {
    if (response.ok) return;
    let code: string | undefined;
    let message = '本机连接已暂停，请重新连接。';
    try {
      const body = await response.clone().json();
      code = body.error?.code;
      if (typeof body.error?.message === 'string') message = body.error.message;
    } catch { /* Non-JSON failures are handled by the ordinary API error formatter. */ }
    if (response.status === 401 || (code && CONNECTION_ERRORS.has(code))) {
      this.interrupt(message, code, code === 'SESSION_EXPIRED');
    }
  }

  private async send(input: string, init: RequestInit = {}, control = false): Promise<Response> {
    if (!input.startsWith('/') || input.startsWith('//')) throw new Error('只允许访问当前本机服务。');
    if (!control && this.snapshot.phase !== 'ready') throw new ConnectionInterrupted();
    if (!control && !this.snapshot.editing && !['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())
      && !input.startsWith('/api/connection/')) {
      throw new ConnectionInterrupted('当前页面只读，请先接管编辑。');
    }
    const generation = this.snapshot.generation;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = control ? setTimeout(() => { timedOut = true; controller.abort(); }, 8000) : undefined;
    this.controllers.add(controller);
    const abort = () => controller.abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) controller.abort();
    const release = () => {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      init.signal?.removeEventListener('abort', abort);
    };
    const headers = new Headers(init.headers);
    if (!['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())) {
      headers.set('X-Atelier-Client', this.clientId);
      // Empty mutating requests still have an explicit JSON content type for CSRF checks.
      if (!init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
    try {
      const response = await fetch(input, {
        ...init, headers, credentials: 'same-origin', redirect: 'error', signal: controller.signal,
      });
      if (generation !== this.snapshot.generation) throw new ConnectionInterrupted();
      await this.inspect(response);
      if (generation !== this.snapshot.generation) { release(); return response; }
      // Some browser response wrappers expose an empty stream for null-body statuses.
      // Reconstructing those responses with a stream is illegal even when it has no bytes.
      if (!response.body || ['HEAD'].includes((init.method ?? 'GET').toUpperCase()) || [204, 205, 304].includes(response.status)) {
        release(); return response;
      }
      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        pull: async output => {
          try {
            const chunk = await reader.read();
            if (generation !== this.snapshot.generation) throw new ConnectionInterrupted();
            if (chunk.done) { release(); output.close(); } else output.enqueue(chunk.value);
          } catch (error) {
            release();
            if (generation === this.snapshot.generation && (timedOut || !controller.signal.aborted)) {
              this.interrupt(timedOut ? '工坊服务响应超时。' : '工坊服务连接中断。', undefined, true);
            }
            output.error(error);
          }
        },
        cancel: async reason => { release(); await reader.cancel(reason); },
      });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      release();
      if (generation === this.snapshot.generation && (timedOut || !controller.signal.aborted)) {
        this.interrupt(timedOut ? '工坊服务响应超时。' : '无法连接工坊服务，请确认工坊已启动。', undefined, true);
      }
      throw error;
    }
  }

  fetch = async (input: string, init?: RequestInit) => {
    const reading = ['GET', 'HEAD'].includes((init?.method ?? 'GET').toUpperCase());
    // A route may mount its read effects during an explicit editor/management transition.
    // Reads wait for that transition; mutations never queue or replay across a connection change.
    while (this.snapshot.phase === 'connecting' && reading) {
      await Promise.resolve();
      const pending = this.pending;
      if (pending) await pending;
      else break;
      if (init?.signal?.aborted) throw new ConnectionInterrupted();
    }
    let response: Response | undefined;
    let failure: unknown;
    const read = async () => {
      const result = await this.send(input, init);
      // JSON 业务读取连同正文一起完成，才能在 headers 成功、正文断流时补读。
      // SSE 和媒体仍保持流式，绝不缓冲或重放流输出。
      if (reading && result.ok && result.body && result.headers.get('Content-Type')?.includes('application/json')) {
        return new Response(await result.arrayBuffer(), { status: result.status, statusText: result.statusText, headers: result.headers });
      }
      return result;
    };
    try { response = await read(); } catch (error) { failure = error; }
    // 只补读一次，避免启动资料请求失败后页面永远停在错误态；业务写入绝不重发。
    if (reading && this.snapshot.recovering && !init?.signal?.aborted) {
      await this.waitForRecovery(init?.signal);
      return read();
    }
    if (failure) throw failure;
    return response!;
  };

  private waitForRecovery(signal?: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        unsubscribe(); signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(new ConnectionInterrupted());
      const check = () => {
        if (signal?.aborted) aborted();
        else if (this.snapshot.phase === 'ready') finish();
        else if (!this.snapshot.recovering && this.snapshot.phase !== 'connecting') finish(new ConnectionInterrupted(this.snapshot.message ?? undefined));
      };
      unsubscribe = this.subscribe(check);
      signal?.addEventListener('abort', aborted, { once: true });
      check();
    });
  }

  pause = (message: string) => this.interrupt(message);

  private async control(path: string, body?: unknown, method = 'POST') {
    const response = await this.send(path, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, true);
    if (!response.ok) {
      // 业务写入从不重放；只有握手遇到暂时服务故障才安排下一次连接。
      if (this.snapshot.phase === 'connecting' || this.snapshot.phase === 'ready') {
        const retryable = response.status === 429 || response.status >= 500;
        const retryAfter = response.headers.get('Retry-After');
        const retryAfterMs = retryAfter === null ? 0 : /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
        this.interrupt(response.status === 404
          ? '工坊服务版本不匹配，请更新并重新启动工坊。'
          : `无法建立工坊连接（HTTP ${response.status}）。`, undefined, retryable, retryAfterMs);
      }
      throw new ConnectionInterrupted(this.snapshot.message ?? '无法建立工坊连接。');
    }
    if (response.status === 204) return null;
    return response.json();
  }

  start = (options: { editing?: boolean; takeover?: boolean; recoveryAttempt?: boolean } = {}): Promise<void> => {
    const editing = options.editing ?? true;
    this.requestedEditing = editing;
    if (this.pending) {
      if (this.snapshot.editing === editing) return this.pending;
      // Browser Back can change routes while a handshake is in flight. Serialize
      // that explicit mode change, but do not reconnect after a failed handshake.
      return this.pending.then(() => {
        if (this.requestedEditing === editing && this.snapshot.editing !== editing
          && (this.snapshot.phase === 'ready' || (this.snapshot.phase === 'editor_in_use' && !editing))) {
          return this.start(options);
        }
      });
    }
    if (this.snapshot.phase === 'ready' && this.snapshot.editing === editing) return Promise.resolve();
    if (!options.recoveryAttempt) this.recoveryAttempts = 0;
    const wasEditing = this.snapshot.phase === 'ready' && this.snapshot.editing;
    this.invalidate();
    this.publish({ phase: 'connecting', message: null, editing, recovering: Boolean(options.recoveryAttempt) });
    const generation = this.snapshot.generation;
    const task = async () => {
      try {
        if (wasEditing && !editing) await this.control('/api/connection/editor-lease', { client_id: this.clientId }, 'DELETE');
        const status = await this.control('/api/connection/status', undefined, 'GET');
        if (status.service !== 'game-atelier' || typeof status.instance_id !== 'string' || status.protocol !== 'atelier-local/1') {
          throw new Error('本机服务版本不匹配，请更新后重新连接。');
        }
        if (options.recoveryAttempt && this.instanceId && status.instance_id !== this.instanceId) {
          throw new Error('工坊服务已重启，请重新连接并核对最新内容。');
        }
        const session = await this.control('/api/connection/local-session', {});
        if (session.instance_id !== status.instance_id || typeof session.session_id !== 'string') {
          throw new Error('本机服务已更换，请重新连接。');
        }
        if (editing) await this.control('/api/connection/editor-lease', { client_id: this.clientId, takeover: options.takeover ?? false });
        if (generation !== this.snapshot.generation) return;
        this.instanceId = status.instance_id;
        this.recoveryAttempts = 0;
        this.publish({ phase: 'ready', message: null, recovering: false });
        if (editing) this.scheduleHeartbeat(generation);
      } catch (error) {
        if (generation === this.snapshot.generation) this.interrupt(error instanceof Error ? error.message : '无法建立本机连接。');
      }
    };
    this.pending = task().finally(() => { if (generation === this.snapshot.generation || this.pending === pending) this.pending = null; });
    const pending = this.pending;
    return pending;
  };

  private scheduleHeartbeat(generation: number) {
    this.heartbeat = setTimeout(async () => {
      if (generation !== this.snapshot.generation || this.snapshot.phase !== 'ready') return;
      try {
        await this.control('/api/connection/editor-lease', { client_id: this.clientId });
        if (generation === this.snapshot.generation) this.scheduleHeartbeat(generation);
      } catch (error) {
        if (generation === this.snapshot.generation) this.interrupt(error instanceof Error ? error.message : '编辑连接已暂停。');
      }
    }, 10_000);
  }

  dispose = () => {
    const release = this.snapshot.phase === 'ready' && this.snapshot.editing;
    this.invalidate();
    this.pending = null;
    this.recoveryAttempts = 0;
    this.publish({ phase: 'idle', editing: false, message: null, recovering: false });
    if (release) void fetch('/api/connection/editor-lease', {
      method: 'DELETE', credentials: 'same-origin', redirect: 'error', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Atelier-Client': this.clientId },
      body: JSON.stringify({ client_id: this.clientId }),
    }).catch(() => {});
  };
}

export const localConnection = new LocalConnection();
export const connectionFetch = localConnection.fetch;
export function useConnectionState() {
  return useSyncExternalStore(localConnection.subscribe, localConnection.getSnapshot);
}
