import { useCallback, useEffect, useRef, useState } from 'react';

import { listCanvasAgentSessions } from '@/api/canvas';
import type { CanvasAgentEventPayload } from '@/hooks/useSSE';

/** 画布右上 Agent 按钮的状态点：运行中 / 待确认。读的是会话列表，不依赖 Agent 面板是否挂载。 */
export type CanvasAgentIndicator = 'idle' | 'running' | 'awaiting';

/** SSE 可能被本机代理憋住：有会话在跑时按这个间隔兜底拉一次列表。 */
const RUNNING_POLL_MS = 5000;
/** 一轮里 session 事件会连着来几条，合并成一次读取。 */
const REFRESH_DEBOUNCE_MS = 300;

export function useCanvasAgentIndicator(projectId: string): {
  indicator: CanvasAgentIndicator;
  onAgentEvent: (event: CanvasAgentEventPayload) => void;
} {
  const [indicator, setIndicator] = useState<CanvasAgentIndicator>('idle');
  const timer = useRef<number | null>(null);
  const refresh = useCallback(() => {
    void Promise.resolve().then(() => listCanvasAgentSessions(projectId)).then(list => {
      const statuses = (list?.sessions ?? []).map(session => session.status);
      setIndicator(statuses.includes('awaiting_approval') ? 'awaiting'
        : statuses.includes('running') ? 'running' : 'idle');
    }).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    setIndicator('idle');
    refresh();
    return () => { if (timer.current !== null) window.clearTimeout(timer.current); };
  }, [refresh]);
  useEffect(() => {
    if (indicator === 'idle') return;
    const interval = window.setInterval(refresh, RUNNING_POLL_MS);
    return () => window.clearInterval(interval);
  }, [indicator, refresh]);
  const onAgentEvent = useCallback((event: CanvasAgentEventPayload) => {
    if (event.kind !== 'session') return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; refresh(); }, REFRESH_DEBOUNCE_MS);
  }, [refresh]);
  return { indicator, onAgentEvent };
}
