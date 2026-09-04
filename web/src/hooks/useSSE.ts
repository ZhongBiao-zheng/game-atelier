import { useEffect, useRef, useState } from 'react';
import { connectionFetch, useConnectionState } from '@/api/connection';
import { readServerEvents } from '@/api/sse';

export interface JobChangedPayload {
  job_id?: string;
  status?: string;
}

interface UseSSEOptions {
  /** false 时整个 hook 不建连（compact 模式 / 不需要推送的页面）。 */
  enabled?: boolean;
  /** job-changed 事件携带 {job_id, status}（watcher 已在广播），定向更新用，不再扔掉 payload。 */
  onJobChanged?: (data: JobChangedPayload) => void;
  /** 连接（含重连）成功时回调 —— 全量刷新兜底，覆盖断连期间丢失的事件。 */
  onConnect?: () => void;
}

export function useSSE(options?: UseSSEOptions): number {
  const connection = useConnectionState();
  const [signal, setSignal] = useState(0);
  const enabled = options?.enabled ?? true;
  // 回调走 ref：每次 render 更新引用，effect 只建一次连接，不随回调变化重连。
  const onJobChangedRef = useRef(options?.onJobChanged);
  onJobChangedRef.current = options?.onJobChanged;
  const onConnectRef = useRef(options?.onConnect);
  onConnectRef.current = options?.onConnect;

  useEffect(() => {
    if (!enabled || connection.phase !== 'ready') return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function connect() {
      if (closed) return;
      const bump = () => setSignal(s => s + 1);
      try {
        const response = await connectionFetch('/events', {
          headers: { Accept: 'text/event-stream' }, signal: controller.signal,
        });
        if (!response.ok || !response.body || !response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
          throw new Error('事件连接不可用。');
        }
        if (closed) return;
        bump();
        onConnectRef.current?.();
        await readServerEvents(response.body, ({ event, data }) => {
          if (closed) return;
          if (['job-changed', 'image-added', 'spec-changed', 'active-character-changed', 'projects-changed', 'workshop-request-changed'].includes(event)) bump();
          if (event === 'job-changed') {
            try { onJobChangedRef.current?.(JSON.parse(data) as JobChangedPayload); } catch { /* Index invalidation already ran. */ }
          }
        }, controller.signal);
      } catch { /* Reconnect only while this connection generation remains mounted. */ }
      if (!closed) timer = setTimeout(() => { void connect(); }, 3000);
    }

    void connect();
    return () => { closed = true; clearTimeout(timer); controller.abort(); };
  }, [enabled, connection.phase, connection.generation]);

  return signal;
}
