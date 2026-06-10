import { useEffect, useRef, useState } from 'react';

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
  const [signal, setSignal] = useState(0);
  const enabled = options?.enabled ?? true;
  // 回调走 ref：每次 render 更新引用，effect 只建一次连接，不随回调变化重连。
  const onJobChangedRef = useRef(options?.onJobChanged);
  onJobChangedRef.current = options?.onJobChanged;
  const onConnectRef = useRef(options?.onConnect);
  onConnectRef.current = options?.onConnect;

  useEffect(() => {
    // jsdom 等非浏览器环境没有 EventSource —— 静默跳过，组件照常渲染。
    if (!enabled || typeof EventSource === 'undefined') return;
    let closed = false;
    let es: EventSource | null = null;

    function connect() {
      if (closed) return;
      es = new EventSource('/events');

      const bump = () => setSignal(s => s + 1);
      es.addEventListener('job-changed', (ev) => {
        bump();
        const cb = onJobChangedRef.current;
        if (!cb) return;
        try {
          cb(JSON.parse((ev as MessageEvent).data) as JobChangedPayload);
        } catch {
          // 坏 payload 丢弃；bump 已触发，靠消费方的全量刷新兜底。
        }
      });
      es.addEventListener('image-added', bump);
      es.addEventListener('spec-changed', bump);
      es.addEventListener('active-character-changed', bump);
      es.addEventListener('projects-changed', bump);

      es.onopen = () => {
        // T6: 连接（含重连）后触发全量刷新，避免错过断连期间的事件
        bump();
        onConnectRef.current?.();
      };

      es.onerror = () => {
        es?.close();
        if (!closed) setTimeout(connect, 3000);  // server retry header is 3000
      };
    }

    connect();
    return () => { closed = true; es?.close(); };
  }, [enabled]);

  return signal;
}
