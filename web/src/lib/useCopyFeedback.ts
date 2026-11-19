import { useCallback, useEffect, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';
const FEEDBACK_MS = 1500;

/** 复制到剪贴板并给出短暂反馈：浏览器拒绝剪贴板权限时显示失败，不静默。 */
export function useCopyFeedback(): [CopyState, (text: string) => void] {
  const [state, setState] = useState<CopyState>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => setState('idle'), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = useCallback((text: string) => {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(() => setState('copied'), () => setState('failed'));
  }, []);
  return [state, copy];
}
