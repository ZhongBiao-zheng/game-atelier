import { useEffect, useState } from 'react';

export function useSSE(): number {
  const [signal, setSignal] = useState(0);

  useEffect(() => {
    let closed = false;
    let es: EventSource | null = null;

    function connect() {
      if (closed) return;
      es = new EventSource('/events');

      const bump = () => setSignal(s => s + 1);
      es.addEventListener('job-changed', bump);
      es.addEventListener('image-added', bump);
      es.addEventListener('spec-changed', bump);
      es.addEventListener('active-character-changed', bump);

      es.onopen = () => {
        // T6: 连接（含重连）后触发全量刷新，避免错过断连期间的事件
        bump();
      };

      es.onerror = () => {
        es?.close();
        if (!closed) setTimeout(connect, 3000);  // server retry header is 3000
      };
    }

    connect();
    return () => { closed = true; es?.close(); };
  }, []);

  return signal;
}
